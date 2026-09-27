// integrations/jira.js — OPTIONAL: create a Jira issue from a BugRep-AI run.
// Config (server-side only): JIRA_BASE_URL, JIRA_EMAIL (or JIRA_USER_EMAIL), JIRA_API_TOKEN,
// JIRA_PROJECT_KEY, optional JIRA_ISSUE_TYPE (default "Bug"). Uses Jira REST v2 + built-in fetch.
'use strict';
const { postJson } = require('./http');
const { summarize } = require('./summary');

function cfg() {
  return {
    base: (process.env.JIRA_BASE_URL || '').replace(/\/$/, ''),
    email: process.env.JIRA_EMAIL || process.env.JIRA_USER_EMAIL || '',
    token: process.env.JIRA_API_TOKEN || '',
    project: process.env.JIRA_PROJECT_KEY || '',
    type: process.env.JIRA_ISSUE_TYPE || 'Bug',
  };
}

function configured() {
  const c = cfg();
  return !!(c.base && c.email && c.token && c.project);
}

function description(s) {
  const m = summarize(s);
  return [
    'h3. Bug report', '{noformat}', m.bugReport, '{noformat}',
    `*Source/project:* ${m.source}`,
    `*Detected file:* {{${m.file}}}`, `*Detected function:* {{${m.fn}}}`,
    'h3. Root cause', m.rootCause,
    'h3. Evidence', `*RED:* ${m.red}`, `*Repair:* ${m.repair}. ${m.fixSummary}`, `*GREEN:* ${m.green}`, `*Status:* ${m.status}`,
    m.diff ? 'h3. Proposed / approved repair' : '', m.diff ? '{code:diff}\n' + m.diff + '\n{code}' : '',
    `*BugRep-AI run ID:* ${m.id}`, `*Run:* ${m.link}`,
  ].filter(Boolean).join('\n');
}

async function createIssue(state) {
  if (!configured()) throw new Error('Jira is not configured.');
  const c = cfg();
  const m = summarize(state);
  const body = { fields: {
    project: { key: c.project }, issuetype: { name: c.type },
    summary: `[BugRep-AI] ${m.shortBug}`.slice(0, 250),
    description: description(state),
    labels: ['bugrep-ai', 'ai-repair'],
  } };
  const auth = Buffer.from(`${c.email}:${c.token}`).toString('base64');
  const res = await postJson(`${c.base}/rest/api/2/issue`, body, { headers: { Authorization: `Basic ${auth}` } });
  if (!res || !res.key) throw new Error('Jira did not return an issue key.');
  return { issueKey: res.key, issueUrl: `${c.base}/browse/${res.key}`, createdAt: new Date().toISOString() };
}

module.exports = { configured, createIssue, description };
