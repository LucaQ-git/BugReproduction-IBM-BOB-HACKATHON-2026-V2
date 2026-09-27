// agents/watsonx.js — IBM watsonx.ai provider (EXPERIMENTAL).
// Implemented with the official SDK but not verified end-to-end in this build.
// Only operational when WATSONX_API_KEY and WATSONX_PROJECT_ID are set.
'use strict';

const { AgentProvider } = require('./provider');
const { parseAgentResponse } = require('./parse');
const { RunError } = require('../workflow/errors');
const prompts = require('../workflow/prompts');

function withTimeout(promise, ms, signal, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new RunError('timeout', `${label} did not answer within ${Math.round(ms / 1000)} seconds.`)), ms);
    const onAbort = () => { clearTimeout(t); reject(new RunError('cancelled', `${label} was stopped.`)); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

class WatsonxProvider extends AgentProvider {
  constructor() { super({ id: 'watsonx', name: 'IBM watsonx.ai', vendor: 'IBM' }); this._client = null; }

  configured() { return !!(process.env.WATSONX_API_KEY && process.env.WATSONX_PROJECT_ID); }

  async getStatus() {
    const ok = this.configured();
    return { id: this.id, name: this.name, implemented: true, experimental: true, configured: ok, operational: ok,
      detail: ok ? `Experimental · ${process.env.WATSONX_MODEL_ID || 'ibm/granite-3-8b-instruct'}` : 'Experimental · not configured' };
  }

  client() {
    if (this._client) return this._client;
    const { WatsonXAI } = require('@ibm-cloud/watsonx-ai');
    const { IamAuthenticator } = require('ibm-cloud-sdk-core');
    this._client = WatsonXAI.newInstance({
      version: '2024-05-31',
      serviceUrl: process.env.WATSONX_SERVICE_URL || 'https://us-south.ml.cloud.ibm.com',
      authenticator: new IamAuthenticator({ apikey: process.env.WATSONX_API_KEY }),
    });
    return this._client;
  }

  async investigate(input) {
    return this._ask('investigator', prompts.investigatorPrompt({ bugReport: input.bugReport, rules: input.rules,
      context: input.context, project: input.project, testPath: input.testPath }), input);
  }

  async repair(input) {
    return this._ask('repairer', prompts.repairerPrompt({ bugReport: input.bugReport, rules: input.rules, context: input.context,
      project: input.project, localization: input.localization, testCode: input.lockedTest, failures: input.redEvidence,
      previousAttempt: input.previousAttempt }), input);
  }

  async _ask(role, prompt, { signal, log }) {
    if (!this.configured()) throw new RunError('ai-unavailable', 'IBM watsonx.ai is not configured.');
    const label = `watsonx ${role === 'investigator' ? 'Investigator' : 'Repairer'}`;
    const modelId = process.env.WATSONX_MODEL_ID || 'ibm/granite-3-8b-instruct';
    log(`${label} started (${modelId})…`);
    const t0 = Date.now();
    const timeout = Number(process.env.BOB_CALL_TIMEOUT_MS || 180000);
    let text;
    try {
      const res = await withTimeout(this.client().textChat({
        modelId, projectId: process.env.WATSONX_PROJECT_ID,
        messages: [{ role: 'system', content: 'Answer with a single valid JSON object and nothing else.' }, { role: 'user', content: prompt }],
        maxTokens: 6000, temperature: 0,
      }), timeout, signal, label);
      text = res.result.choices[0].message.content;
    } catch (err) {
      if (err instanceof RunError) throw err;
      throw new RunError('ai-unavailable', `watsonx.ai request failed: ${String(err.message || err).slice(0, 200)}`);
    }
    const parsed = parseAgentResponse({ stdout: text }, role);
    if (!parsed.ok) throw new RunError('ai-response', parsed.error, { bobDebug: parsed.debug });
    log(`${label} answered in ${Math.round((Date.now() - t0) / 1000)}s.`);
    return { payload: parsed.payload, ms: Date.now() - t0 };
  }
}

module.exports = new WatsonxProvider();
