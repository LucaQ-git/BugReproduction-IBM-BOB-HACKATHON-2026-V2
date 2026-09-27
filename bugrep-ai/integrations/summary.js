// integrations/summary.js — the run facts shared by Jira, Slack and Teams messages.
'use strict';

const STATUS_LABEL = {
  completed: 'Approved & delivered', 'awaiting-approval': 'Awaiting approval', rejected: 'Rejected',
  'not-reproduced': 'Not reproduced', 'repair-not-verified': 'Repair not verified', failed: 'Failed',
  'timed-out': 'Timed out', cancelled: 'Cancelled', interrupted: 'Interrupted', running: 'Running',
};

function runLink(s) {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${base}/#run/${s.id}`;
}

function summarize(s) {
  const firstLine = String(s.bugReport || '').split(/\r?\n/)[0].trim();
  const shortBug = firstLine.length > 90 ? firstLine.slice(0, 87) + '…' : firstLine;
  const verified = s.green && s.green.outcome === 'pass';
  return {
    id: s.id,
    shortBug,
    bugReport: s.bugReport,
    source: `${s.source?.label || ''} (${s.source?.type || ''})`,
    file: s.localization?.file || 'n/a',
    fn: s.localization?.function || 'n/a',
    rootCause: s.fix?.rootCause || s.localization?.analysis || 'n/a',
    fixSummary: s.fix?.summary || 'n/a',
    red: s.red ? `${s.red.failed} failing of ${s.red.total} regression tests` : 'not run',
    repair: s.fix ? (verified ? 'Verified' : 'Not verified') : 'Not generated',
    green: s.green ? `${s.green.passed} / ${s.green.total} passed` : 'not run',
    status: STATUS_LABEL[s.status] || s.status,
    agent: s.agent?.name || 'IBM Bob',
    link: runLink(s),
    diff: s.diff ? s.diff.slice(0, 6000) : '',
  };
}

module.exports = { summarize };
