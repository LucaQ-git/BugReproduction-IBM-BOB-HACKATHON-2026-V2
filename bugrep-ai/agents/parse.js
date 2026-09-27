// agents/parse.js — ONE shared, tolerant parser for agent (Bob) responses.
// Used for both the Investigator and the Repairer answer.
//
// Handles: direct JSON · ```json fences · JSON inside an envelope object ·
// JSON encoded as a string · JSONL event streams · text around the JSON ·
// raw newlines inside JSON strings · trailing commas. Looks at stdout AND stderr.

'use strict';

const { bounded } = require('../workflow/redact');

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
  if (typeof whole === 'string' && whole !== text) {           // JSON encoded as a string
    const found = extractJson(whole, keys, depth + 1);
    if (found) return found;
  }
  if (whole !== undefined && whole !== null && typeof whole === 'object') {
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


const SHAPES = {
  // Investigator: must give test code. localizedFile/Function/analysis/testFile are optional extras.
  investigator: [['testCode']],
  // Repairer: either one fixed file (fixedCode) or a list of files.
  repairer: [['fixedCode'], ['files']],
};

/**
 * Parse an agent response.
 * @param {{stdout?:string, stderr?:string, file?:string}} raw   file = content of an answer file, if any
 * @param {'investigator'|'repairer'} role
 * @returns {{ok:true, payload:object} | {ok:false, error:string, debug:{stdout:string, stderr:string}}}
 */
function parseAgentResponse(raw, role) {
  const shapes = SHAPES[role];
  if (!shapes) throw new Error(`Unknown role ${role}`);
  const sources = [raw.file, raw.stdout, raw.stderr].filter(s => typeof s === 'string' && s.trim());
  for (const src of sources) {
    for (const keys of shapes) {
      const found = extractJson(src, keys);
      if (found) return { ok: true, payload: found };
    }
  }
  return {
    ok: false,
    error: `The agent's ${role} answer did not contain the expected JSON (${shapes.map(k => k.join('+')).join(' or ')}).`,
    debug: { stdout: bounded(raw.stdout || ''), stderr: bounded(raw.stderr || '') },
  };
}

module.exports = { parseAgentResponse, extractJson, repairJson };
