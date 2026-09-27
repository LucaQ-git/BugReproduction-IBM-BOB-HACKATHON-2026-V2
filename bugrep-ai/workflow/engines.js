// workflow/engines.js
// The AI "brains" behind the agents.
//
//   bob     — IBM Bob Shell (`bob run …`). Runs in an isolated scratch copy of the
//             project, reads its task from a file and writes its answer to
//             __bugrep__/answer.json. Nothing it edits there reaches your code.
//   watsonx — IBM watsonx.ai text generation (Granite models) via the SDK.
//   replay  — Pre-recorded agent answers for the bundled demo only. Clearly
//             labelled in the UI and report; tests still run for real.
//
// Engine selection "auto": bob → watsonx. (replay is only used for the demo.)

'use strict';

const fs    = require('fs');
const path  = require('path');
const { spawn, spawnSync } = require('child_process');
const ws    = require('./workspace');

const ROOT = path.resolve(__dirname, '..');

// ─── Status / discovery ──────────────────────────────────────────────────────

let bobCache = null;

function resolveBobBin() {
  if (process.env.BOB_CLI_PATH) return process.env.BOB_CLI_PATH;
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const r = spawnSync(finder, ['bob'], { encoding: 'utf8', shell: false, windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) {
      const lines = r.stdout.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return lines.find(l => /\.(cmd|exe)$/i.test(l)) || lines[0];
    }
  } catch { /* not found */ }
  return null;
}

function bobStatus(force = false) {
  if (bobCache && !force && Date.now() - bobCache.at < 60000) return bobCache.value;
  let value;
  const bin = resolveBobBin();
  if (!bin) {
    value = { ready: false, reason: 'Bob Shell not found on PATH (or set BOB_CLI_PATH)' };
  } else if (!process.env.BOBSHELL_API_KEY) {
    value = { ready: false, reason: 'BOBSHELL_API_KEY missing in .env', bin };
  } else {
    const r = spawnSync(quoteForShell(bin), ['--version'], {
      encoding: 'utf8', shell: needsShell(bin), timeout: 10000, windowsHide: true,
    });
    value = r.error || r.status !== 0
      ? { ready: false, reason: 'Bob Shell could not be launched', bin }
      : { ready: true, bin, version: (r.stdout || '').trim().split('\n')[0] };
  }
  bobCache = { at: Date.now(), value };
  return value;
}

function watsonxStatus() {
  return process.env.WATSONX_API_KEY && process.env.WATSONX_PROJECT_ID
    ? { ready: true, model: process.env.WATSONX_MODEL_ID || 'ibm/granite-3-8b-instruct' }
    : { ready: false, reason: 'WATSONX_API_KEY / WATSONX_PROJECT_ID missing in .env' };
}

function status() {
  return { bob: bobStatus(), watsonx: watsonxStatus(), replay: { ready: true, demoOnly: true } };
}

/** Decide which engine to use for a run. */
function pickEngine(requested, isDemo) {
  const s = status();
  const want = requested || 'auto';
  if (want === 'replay') {
    if (!isDemo) throw new Error('Replay engine only works with the bundled demo.');
    return 'replay';
  }
  if (want === 'bob') {
    if (!s.bob.ready) throw new Error(`Bob Shell is not ready: ${s.bob.reason}`);
    return 'bob';
  }
  if (want === 'watsonx') {
    if (!s.watsonx.ready) throw new Error(`watsonx.ai is not ready: ${s.watsonx.reason}`);
    return 'watsonx';
  }
  if (s.bob.ready) return 'bob';
  if (s.watsonx.ready) return 'watsonx';
  if (isDemo) return 'replay';
  throw new Error('No AI engine configured. Add BOBSHELL_API_KEY (Bob Shell) or WATSONX_API_KEY + WATSONX_PROJECT_ID to .env — or try the demo.');
}

// ─── JSON extraction (tolerant of chatty / wrapped model output) ─────────────

/** Escape raw control characters that models often leave inside JSON strings. */
function repairJson(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out.replace(/,\s*([}\]])/g, '$1'); // trailing commas
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { /* try repaired */ }
  try { return JSON.parse(repairJson(s)); } catch { return undefined; }
}

/** Yield every balanced {...} block in text (string-aware). */
function* objectBlocks(text) {
  for (let start = text.indexOf('{'); start !== -1 && start < text.length; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { yield text.slice(start, i + 1); break; }
    }
  }
}

function hasKeys(obj, keys) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && keys.every(k => k in obj);
}

/** Find a JSON object containing all `keys` anywhere inside `input`. */
function extractJson(input, keys, depth = 0) {
  if (depth > 6 || input == null) return null;
  if (typeof input === 'object') {
    if (hasKeys(input, keys)) return input;
    for (const v of Object.values(input)) {
      const found = extractJson(v, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const whole = tryParse(text);
  if (whole !== undefined && typeof whole === 'object') {
    const found = extractJson(whole, keys, depth + 1);
    if (found) return found;
  }
  // Fenced ```json blocks first
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const obj = tryParse(m[1]);
    const found = obj && extractJson(obj, keys, depth + 1);
    if (found) return found;
  }
  // NDJSON event streams (one JSON object per line)
  if (text.includes('\n')) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      const obj = tryParse(t);
      const found = obj && extractJson(obj, keys, depth + 1);
      if (found) return found;
    }
  }
  // Any balanced object in free text (largest first is usually the answer)
  let tries = 0;
  const blocks = [];
  for (const b of objectBlocks(text)) { blocks.push(b); if (++tries > 200) break; }
  blocks.sort((a, b) => b.length - a.length);
  for (const b of blocks) {
    const obj = tryParse(b);
    const found = obj && extractJson(obj, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

// ─── Bob Shell ───────────────────────────────────────────────────────────────

function needsShell(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

function quoteForShell(bin) {
  return needsShell(bin) ? `"${bin}"` : bin;
}

function bobArgs(workspaceDir, prompt) {
  // Same flags that ran successfully in your earlier runs: bob run --format json --workspace <dir> --mode agent --trust "<prompt>"
  // Extra flags can be appended with BOB_EXTRA_ARGS (e.g. "--accept-license").
  const extra = (process.env.BOB_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
  const mode = process.env.BOB_MODE || 'agent';
  return ['run', '--format', 'json', '--workspace', workspaceDir, '--mode', mode, '--trust', ...extra, prompt];
}

async function askBob({ agent, prompt, keys, scratchFrom, runDir, log }) {
  const bin = bobStatus().bin;
  const scratch = path.join(runDir, 'bob', `${agent}-${Date.now().toString(36)}`);
  ws.copyTree(scratchFrom, scratch);
  ws.ensureDir(path.join(scratch, '__bugrep__'));
  const taskFile = path.join(scratch, '__bugrep__', 'TASK.md');
  const answerFile = path.join(scratch, '__bugrep__', 'answer.json');
  fs.writeFileSync(taskFile, prompt + `\n\n## Output\nWrite ONLY the JSON object to the file __bugrep__/answer.json in the workspace, then reply with the same JSON. Do not modify any other file.\n`, 'utf8');

  // Short, quote-free instruction: safe to pass through cmd.exe on Windows.
  const shortPrompt = 'Read the file __bugrep__/TASK.md in this workspace and complete the task exactly as written. ' +
    'Save your JSON answer to __bugrep__/answer.json and also print it.';
  const args = bobArgs(scratch, shortPrompt);
  const shell = needsShell(bin);
  const finalArgs = shell ? args.map(a => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)) : args;

  log(`Launching Bob Shell (${agent})…`);
  const timeoutMs = Number(process.env.BOB_TIMEOUT_MS || 300000);
  const out = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '', lastBeat = Date.now();
    const child = spawn(quoteForShell(bin), finalArgs, {
      cwd: scratch, shell, windowsHide: true, env: { ...process.env },
    });
    const beat = setInterval(() => {
      if (Date.now() - lastBeat > 15000) { log('Bob is still working…'); lastBeat = Date.now(); }
    }, 5000);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Bob Shell timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; lastBeat = Date.now(); });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearInterval(beat); clearTimeout(timer); reject(new Error(`Could not launch Bob Shell: ${err.message}`)); });
    child.on('close', code => {
      clearInterval(beat); clearTimeout(timer);
      fs.writeFileSync(path.join(runDir, `bob-${agent}.log`), `$ bob ${args.slice(0, -1).join(' ')} "<prompt>"\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
      if (code !== 0 && !fs.existsSync(answerFile)) {
        const msg = (stderr || stdout).trim().split('\n').slice(-4).join(' ');
        if (/license/i.test(msg)) return reject(new Error('Bob Shell needs its license accepted. Run `bob` once interactively, or set BOB_EXTRA_ARGS=--accept-license in .env.'));
        return reject(new Error(`Bob Shell exited with code ${code}: ${msg || 'no output'}`));
      }
      resolve(stdout);
    });
  });

  let answer = null;
  if (fs.existsSync(answerFile)) answer = extractJson(fs.readFileSync(answerFile, 'utf8'), keys);
  if (!answer) answer = extractJson(out, keys);
  if (!answer) throw new Error('Bob finished but did not return the expected JSON answer (see runs/<id>/bob-*.log).');
  return answer;
}

// ─── watsonx.ai ──────────────────────────────────────────────────────────────

let wxClient = null;
function watsonxClient() {
  if (wxClient) return wxClient;
  const { WatsonXAI } = require('@ibm-cloud/watsonx-ai');
  const { IamAuthenticator } = require('ibm-cloud-sdk-core');
  wxClient = WatsonXAI.newInstance({
    version: '2024-05-31',
    serviceUrl: process.env.WATSONX_SERVICE_URL || 'https://us-south.ml.cloud.ibm.com',
    authenticator: new IamAuthenticator({ apikey: process.env.WATSONX_API_KEY }),
  });
  return wxClient;
}

async function askWatsonx({ agent, prompt, keys, log }) {
  const client = watsonxClient();
  const modelId = process.env.WATSONX_MODEL_ID || 'ibm/granite-3-8b-instruct';
  const system = 'You are a senior software engineer agent. You answer with a single valid JSON object and nothing else.';
  log(`Asking watsonx.ai (${modelId})…`);
  let text;
  try {
    const res = await client.textChat({
      modelId,
      projectId: process.env.WATSONX_PROJECT_ID,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      maxTokens: 6000,
      temperature: 0,
    });
    text = res.result.choices[0].message.content;
  } catch (err) {
    // Some models/projects only support plain generation.
    log('Chat endpoint unavailable — falling back to text generation.');
    const res = await client.generateText({
      modelId,
      projectId: process.env.WATSONX_PROJECT_ID,
      input: `${system}\n\n${prompt}\n\nJSON:`,
      parameters: { max_new_tokens: 6000, temperature: 0, decoding_method: 'greedy' },
    });
    text = res.result.results[0].generated_text;
  }
  const answer = extractJson(text, keys);
  if (!answer) throw new Error(`watsonx.ai (${agent}) did not return valid JSON.`);
  return answer;
}

// ─── Replay (demo only) ──────────────────────────────────────────────────────

async function askReplay({ agent, keys, log, attempt }) {
  const file = path.join(ROOT, 'demo', 'replay.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const script = data[agent];
  if (!script) throw new Error(`No replay recorded for ${agent}.`);
  for (const line of script.thinking || []) {
    await new Promise(r => setTimeout(r, 650));
    log(line);
  }
  await new Promise(r => setTimeout(r, 500));
  const answer = { ...script.answer };
  if (!hasKeys(answer, keys)) throw new Error('Replay data is incomplete.');
  return answer;
}

/**
 * Ask an agent. Returns { answer, ms }.
 * @param {'bob'|'watsonx'|'replay'} engine
 */
async function ask(engine, opts) {
  const t0 = Date.now();
  let answer;
  if (engine === 'bob') answer = await askBob(opts);
  else if (engine === 'watsonx') answer = await askWatsonx(opts);
  else if (engine === 'replay') answer = await askReplay(opts);
  else throw new Error(`Unknown engine ${engine}`);
  return { answer, ms: Date.now() - t0 };
}

module.exports = { status, pickEngine, ask, extractJson, repairJson, resolveBobBin };
