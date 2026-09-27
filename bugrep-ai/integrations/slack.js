// integrations/slack.js — OPTIONAL Slack notification via an Incoming Webhook (SLACK_WEBHOOK_URL).
'use strict';
const { postJson } = require('./http');
const { summarize } = require('./summary');

function configured() { return !!process.env.SLACK_WEBHOOK_URL; }

function message(state) {
  const m = summarize(state);
  const title = state.status === 'completed' ? 'BugRep-AI: Verified Repair' : `BugRep-AI: ${m.status}`;
  const text = [
    `*${title}*`, '',
    `*Run:* ${m.id}`, `*Bug:* ${m.shortBug}`, `*File:* \`${m.file}\``, `*Function:* \`${m.fn}\``, '',
    `*RED:* ${m.red}`, `*Repair:* ${m.repair}`, `*GREEN:* ${m.green}`, `*Status:* ${m.status}`, '',
    `<${m.link}|Open run & report>`,
  ].join('\n');
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

async function send(state) {
  if (!configured()) throw new Error('Slack is not configured.');
  await postJson(process.env.SLACK_WEBHOOK_URL, message(state));
  return { sentAt: new Date().toISOString() };
}

module.exports = { configured, send, message };
