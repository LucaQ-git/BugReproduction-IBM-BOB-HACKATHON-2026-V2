// integrations/teams.js — OPTIONAL Microsoft Teams notification.
// TEAMS_WEBHOOK_URL: a Teams Workflows ("Post to a channel when a webhook request is received")
// or incoming-webhook URL. Sends an Adaptive Card, the format Teams Workflows expect.
'use strict';
const { postJson } = require('./http');
const { summarize } = require('./summary');

function configured() { return !!process.env.TEAMS_WEBHOOK_URL; }

function card(state) {
  const m = summarize(state);
  const title = state.status === 'completed' ? 'BugRep-AI: Verified Repair' : `BugRep-AI: ${m.status}`;
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: title, wrap: true },
          { type: 'TextBlock', text: m.shortBug, wrap: true },
          { type: 'FactSet', facts: [
            { title: 'Run', value: m.id }, { title: 'File', value: m.file }, { title: 'Function', value: m.fn },
            { title: 'RED', value: m.red }, { title: 'Repair', value: m.repair }, { title: 'GREEN', value: m.green },
            { title: 'Status', value: m.status },
          ] },
        ],
        actions: [{ type: 'Action.OpenUrl', title: 'Open run & report', url: m.link }],
      },
    }],
  };
}

async function send(state) {
  if (!configured()) throw new Error('Microsoft Teams is not configured.');
  await postJson(process.env.TEAMS_WEBHOOK_URL, card(state));
  return { sentAt: new Date().toISOString() };
}

module.exports = { configured, send, card };
