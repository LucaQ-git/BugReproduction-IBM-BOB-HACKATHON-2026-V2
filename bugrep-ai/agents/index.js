// agents/index.js — provider registry + orchestration helpers.
//
// Single-agent mode: one provider investigates and repairs.
// Multi-agent mode (architecture ready): several OPERATIONAL providers investigate / repair
// independently. Findings are compared; every repair candidate is tested by the
// deterministic test runner, and the runner, never an AI vote, decides which candidate
// fixes the regression. Skeleton providers are never called, and nothing is faked.

'use strict';

const { RunError } = require('../workflow/errors');

const PROVIDERS = [
  require('./bob'),
  require('./watsonx'),
  require('./claude'),
  require('./openai'),
  require('./gemini'),
  require('./grok'),
];
const BY_ID = new Map(PROVIDERS.map(p => [p.id, p]));
BY_ID.set('chatgpt', BY_ID.get('openai'));

function getProvider(id) {
  const p = BY_ID.get(String(id || '').toLowerCase());
  if (!p) throw new RunError('ai-unavailable', `Unknown AI agent "${id}".`);
  return p;
}

async function listAgents() {
  return Promise.all(PROVIDERS.map(p => p.getStatus()));
}

/**
 * Validate the user's agent selection. Returns the provider objects to use.
 * @param {string[]|string|undefined} ids  default ['bob']
 * @param {'single'|'multi'} mode
 */
async function resolveAgents(ids, mode = 'single') {
  let list = Array.isArray(ids) ? ids : ids ? [ids] : ['bob'];
  if (list.includes('auto')) list = ['bob'];
  list = [...new Set(list.map(s => String(s).toLowerCase()))];
  if (!list.length) list = ['bob'];
  if (mode !== 'multi' && list.length > 1) list = [list[0]];
  const providers = list.map(getProvider);
  for (const p of providers) {
    const s = await p.getStatus();
    if (!s.implemented) throw new RunError('ai-unavailable', `${p.name} provider is not configured in this build.`);
    if (!s.operational) throw new RunError('ai-unavailable', `${p.name} is unavailable: ${s.detail}`);
  }
  if (mode === 'multi' && providers.length < 2) {
    throw new RunError('ai-unavailable', 'Multi-Agent Review needs at least two operational agents. Only one is available in this build.');
  }
  return providers;
}

module.exports = { PROVIDERS, getProvider, listAgents, resolveAgents };
