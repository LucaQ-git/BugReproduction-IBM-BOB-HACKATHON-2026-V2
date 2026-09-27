// integrations/index.js — status + delivery. Delivery results are stored on the run under
// state.integrations and NEVER change the repair status.
'use strict';
const jira = require('./jira');
const slack = require('./slack');
const teams = require('./teams');
const { redact } = require('../workflow/redact');

/** Safe for the browser: booleans only, never URLs, tokens or keys. */
function status() {
  return {
    jira: { configured: jira.configured() },
    slack: { configured: slack.configured() },
    teams: { configured: teams.configured() },
  };
}

const TARGETS = {
  jira: { name: 'Jira', configured: jira.configured, run: async s => ({ status: 'created', ...(await jira.createIssue(s)) }) },
  slack: { name: 'Slack', configured: slack.configured, run: async s => { await slack.send(s); return { status: 'sent' }; } },
  teams: { name: 'Microsoft Teams', configured: teams.configured, run: async s => { await teams.send(s); return { status: 'sent' }; } },
};

/** Deliver a run to one integration. Returns the stored result object; never throws for delivery errors. */
async function deliver(target, state) {
  const t = TARGETS[target];
  if (!t) throw Object.assign(new Error(`Unknown integration "${target}".`), { http: 404 });
  if (!t.configured()) throw Object.assign(new Error(`${t.name} is not configured on this server.`), { http: 400 });
  if (!state.red && !['completed', 'rejected', 'repair-not-verified', 'not-reproduced'].includes(state.status)) {
    throw Object.assign(new Error('Nothing to share yet: wait until the bug has been reproduced.'), { http: 409 });
  }
  const at = new Date().toISOString();
  try {
    const r = await t.run(state);
    return { ...r, at };
  } catch (err) {
    return { status: 'failed', at, error: redact(err.message).slice(0, 240) };
  }
}

module.exports = { status, deliver };
