// agents/bob.js — IBM Bob provider (the default, fully implemented provider).
//
// One Bob Shell call per role:
//   investigate() = Bob call #1 (localize + write regression tests)
//   repair()      = Bob call #2 (write the candidate fix)
// Nothing else in BugRep calls Bob. Health checks only run `bob --version`, cached 30 s.
//
// Call style (single-pass): the whole task goes into the prompt and Bob replies with JSON
// only, without tools. On Windows the npm `bob.cmd` shim is bypassed by running Bob's Node
// script directly, so long prompts never pass through cmd.exe. Falls back to a task file
// (__bugrep__/TASK.md → __bugrep__/answer.json) when that is not possible.

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { AgentProvider } = require('./provider');
const { parseAgentResponse } = require('./parse');
const { runProcess } = require('../workflow/proc');
const { RunError } = require('../workflow/errors');
const { redact } = require('../workflow/redact');
const prompts = require('../workflow/prompts');
const ws = require('../workflow/workspace');

const BOB_HEALTH_TTL = 30000;
const INLINE_MAX = 24000; // stay well under the Windows 32K command-line limit

function callTimeout() {
  return Number(process.env.BOB_CALL_TIMEOUT_MS || process.env.BOB_TIMEOUT_MS || 180000);
}

function resolveBobBin() {
  if (process.env.BOB_CLI_PATH) return process.env.BOB_CLI_PATH;
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const r = spawnSync(finder, ['bob'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) {
      const lines = r.stdout.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return lines.find(l => /\.(cmd|exe)$/i.test(l)) || lines[0];
    }
  } catch { /* not found */ }
  return null;
}

function needsShell(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

/** Extract the Node script path from an npm-generated .cmd shim. */
function shimScript(shim, dir) {
  const m = shim.match(/"%(?:~dp0|dp0%)\\?([^"]+?\.(?:c|m)?js)"/i);
  return m ? path.join(dir, ...m[1].split(/[\\/]/).filter(Boolean)) : null;
}

/** How to launch Bob: { cmd, pre, shell }. */
function resolveLauncher(bin) {
  if (!needsShell(bin)) return { cmd: bin, pre: [], shell: false };
  try {
    const script = shimScript(fs.readFileSync(bin, 'utf8'), path.dirname(bin));
    if (script && fs.existsSync(script)) {
      const localNode = path.join(path.dirname(bin), 'node.exe');
      return { cmd: fs.existsSync(localNode) ? localNode : process.execPath, pre: [script], shell: false };
    }
  } catch { /* fall through */ }
  return { cmd: `"${bin}"`, pre: [], shell: true };
}

function bobArgs(workspaceDir, prompt) {
  const extra = (process.env.BOB_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
  const mode = process.env.BOB_MODE || 'agent';
  return ['run', '--format', 'json', '--workspace', workspaceDir, '--mode', mode, '--trust', ...extra, prompt];
}

class BobProvider extends AgentProvider {
  constructor() {
    super({ id: 'bob', name: 'IBM Bob', vendor: 'IBM' });
    this._health = null;
    this._healthAt = 0;
    this._healthPending = null;
    this.versionChecks = 0; // visible to tests: proves health polling is cached
  }

  /** Cached for 30 s. Only ever runs `bob --version` — never a Bob call. */
  async getStatus() {
    if (this._health && Date.now() - this._healthAt < BOB_HEALTH_TTL) return this._health;
    if (this._healthPending) return this._healthPending;
    this._healthPending = this._checkHealth().then(h => {
      this._health = h; this._healthAt = Date.now(); this._healthPending = null; return h;
    });
    return this._healthPending;
  }

  /** Last known status without spawning anything (for synchronous callers). */
  cachedStatus() {
    return this._health;
  }

  async _checkHealth() {
    const base = { id: this.id, name: this.name, implemented: true, experimental: false };
    const bin = resolveBobBin();
    if (!bin) return { ...base, configured: false, operational: false, detail: 'Bob Shell not found on PATH (or set BOB_CLI_PATH)' };
    if (!process.env.BOBSHELL_API_KEY) return { ...base, configured: false, operational: false, detail: 'BOBSHELL_API_KEY missing in .env' };
    const l = resolveLauncher(bin);
    this.versionChecks++;
    const r = await runProcess(l.cmd, [...l.pre, '--version'], { shell: l.shell, timeoutMs: 10000 });
    if (r.error || r.timedOut || r.code !== 0) {
      return { ...base, configured: true, operational: false, detail: 'Bob Shell could not be launched' };
    }
    const version = (r.stdout || '').trim().split('\n')[0].slice(0, 60);
    return { ...base, configured: true, operational: true, detail: 'Connected', version };
  }

  invalidateStatus() { this._health = null; this._healthAt = 0; }

  async investigate(input) {
    const prompt = prompts.investigatorPrompt({
      bugReport: input.bugReport, rules: input.rules, context: input.context, project: input.project,
      testPath: input.testPath, previousError: null,
    });
    return this._call('investigator', prompt, input);
  }

  async repair(input) {
    const prompt = prompts.repairerPrompt({
      bugReport: input.bugReport, rules: input.rules, context: input.context, project: input.project,
      localization: input.localization, testCode: input.lockedTest, failures: input.redEvidence,
      previousAttempt: input.previousAttempt || null,
    });
    return this._call('repairer', prompt, input);
  }

  async _call(role, prompt, { workspace, files, runDir, signal, log }) {
    const status = await this.getStatus();
    if (!status.operational) throw new RunError('ai-unavailable', `IBM Bob is unavailable: ${status.detail}`);
    const bin = resolveBobBin();
    const launcher = resolveLauncher(bin);
    const scratch = path.join(runDir, 'bob', `${role}-${Date.now().toString(36)}`);
    ws.ensureDir(path.join(scratch, '__bugrep__'));
    const answerFile = path.join(scratch, '__bugrep__', 'answer.json');
    fs.writeFileSync(path.join(runDir, `prompt-${role}.md`), prompt);

    const want = (process.env.BOB_INPUT || 'auto').toLowerCase();
    const inline = want === 'inline' || (want === 'auto' && !launcher.shell && prompt.length < INLINE_MAX);
    let userPrompt;
    if (inline) {
      userPrompt = prompt + '\n\n## Output rules\nAll the code you need is included above. Do NOT use any tools: do not read, ' +
        'search or write files and do not run commands. Reply immediately with ONLY the JSON object.';
    } else {
      for (const rel of files || []) {
        const from = ws.safeJoin(workspace, rel);
        if (!from || !fs.existsSync(from)) continue;
        const to = path.join(scratch, rel);
        ws.ensureDir(path.dirname(to));
        fs.copyFileSync(from, to);
      }
      fs.writeFileSync(path.join(scratch, '__bugrep__', 'TASK.md'), prompt +
        '\n\n## Output\nEverything you need is already in this file. Do NOT search, list or open other files and do NOT run any commands.\n' +
        'Write ONLY the JSON object to __bugrep__/answer.json, then reply with the same JSON. Do not modify any other file.\n');
      userPrompt = 'Read __bugrep__/TASK.md and answer immediately. All the code you need is inside that file, ' +
        'so do not explore the workspace or run commands. Save your JSON answer to __bugrep__/answer.json and also print it.';
    }

    const args = bobArgs(scratch, userPrompt);
    const finalArgs = launcher.shell ? args.map(a => (/[\s&|<>^,]/.test(a) ? `"${a}"` : a)) : [...launcher.pre, ...args];
    const label = role === 'investigator' ? 'IBM Bob Investigator' : 'IBM Bob Repairer';
    log(`${label} started (${inline ? 'single-pass' : 'task-file'} mode)…`);

    const timeoutMs = callTimeout();
    const started = Date.now();
    const beat = setInterval(() => log(`${label} is still working… (${Math.round((Date.now() - started) / 1000)}s)`), 15000);
    let r;
    try {
      r = await runProcess(launcher.cmd, finalArgs, { cwd: scratch, shell: launcher.shell, timeoutMs, signal });
    } finally {
      clearInterval(beat);
    }
    const secs = Math.round(r.ms / 1000);
    fs.writeFileSync(path.join(runDir, `bob-${role}.log`), redact(
      `$ ${launcher.cmd} ${[...launcher.pre, ...args.slice(0, -1)].join(' ')} "<prompt>"\nmode: ${inline ? 'single-pass' : 'task-file'}\n` +
      `exit: ${r.code} · ${secs}s · timedOut: ${r.timedOut} · aborted: ${r.aborted}\n\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`));

    if (r.aborted) throw new RunError('cancelled', `${label} was stopped.`);
    if (r.timedOut) throw new RunError('timeout', `${label} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    if (r.error) throw new RunError('ai-unavailable', `Could not launch Bob Shell: ${r.error}`);
    log(`${label} answered in ${secs}s.`);

    const fileText = fs.existsSync(answerFile) ? fs.readFileSync(answerFile, 'utf8') : '';
    const parsed = parseAgentResponse({ stdout: r.stdout, stderr: r.stderr, file: fileText }, role);
    if (!parsed.ok) {
      const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ');
      if (r.code !== 0 && /license/i.test(msg)) {
        throw new RunError('ai-unavailable', 'Bob Shell needs its license accepted. Run `bob` once interactively (or set BOB_EXTRA_ARGS=--accept-license after accepting it).', { bobDebug: parsed.debug });
      }
      throw new RunError('ai-response', r.code !== 0
        ? `Bob Shell exited with code ${r.code} without a usable answer.`
        : parsed.error, { bobDebug: parsed.debug });
    }
    return { payload: parsed.payload, ms: r.ms };
  }
}

module.exports = new BobProvider();
module.exports.shimScript = shimScript;
module.exports.resolveLauncher = resolveLauncher;
module.exports.BOB_HEALTH_TTL = BOB_HEALTH_TTL;
