// integrations/http.js — small fetch wrapper with a hard timeout. Errors never include URLs or secrets.
'use strict';
const { redact } = require('../workflow/redact');

async function postJson(url, body, { headers = {}, timeoutMs } = {}) {
  const ms = Number(timeoutMs || process.env.INTEGRATION_TIMEOUT_MS || 15000);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    if (!res.ok) {
      const detail = json && (json.errorMessages || json.errors) ? JSON.stringify(json.errorMessages || json.errors).slice(0, 200) : text.slice(0, 120);
      const err = new Error(redact(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`));
      err.status = res.status;
      throw err;
    }
    return json || { text };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(ms / 1000)}s`);
    if (err.status) throw err;
    throw new Error(redact(`Request failed: ${err.cause ? err.cause.code || err.cause.message : err.message}`));
  } finally {
    clearTimeout(t);
  }
}

module.exports = { postJson };
