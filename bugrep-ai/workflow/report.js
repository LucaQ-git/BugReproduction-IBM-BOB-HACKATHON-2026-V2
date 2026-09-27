// workflow/report.js — Markdown + JSON evidence report, built from recorded facts only.
// Secrets are never included (all text passes through redact()).

'use strict';

const fs   = require('fs');
const path = require('path');
const { redact } = require('./redact');

const OUTCOME = {
  completed: '✅ Bug reproduced, repaired, verified and delivered',
  'awaiting-approval': '⏳ Verified repair awaiting human approval',
  rejected: '✋ Repair rejected by reviewer: no changes applied',
  'not-reproduced': 'ℹ️ Bug not reproduced: every generated test passed on the original code',
  'repair-not-verified': '⚠️ Repair NOT verified: locked tests still fail on the candidate; nothing applied',
  failed: '❌ Run failed',
  'timed-out': '⏱️ Run timed out',
  cancelled: '⏹️ Run cancelled by user',
  interrupted: '⚠️ Run interrupted before completion',
  running: '… Run in progress',
};

function testMatrix(state) {
  const rows = new Map();
  for (const t of state.red?.tests || []) rows.set(t.name, { name: t.name, before: t.status });
  for (const t of state.green?.tests || []) {
    const row = rows.get(t.name) || { name: t.name, before: '—' };
    row.after = t.status;
    rows.set(t.name, row);
  }
  return [...rows.values()];
}

function icon(s) { return s === 'passed' ? '✅ pass' : s === 'failed' ? '❌ fail' : s || '—'; }
function dur(ms) { return ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }

function integrationLine(name, v) {
  if (!v) return `- **${name}:** not sent`;
  if (v.status === 'created') return `- **${name}:** CREATED ${v.issueKey}${v.issueUrl ? ` (${v.issueUrl})` : ''} at ${v.at}`;
  if (v.status === 'sent') return `- **${name}:** SENT at ${v.at}`;
  return `- **${name}:** FAILED at ${v.at}: ${v.error || 'unknown error'}`;
}

function buildMarkdown(state) {
  const s = state;
  const L = [];
  L.push(`# BugRep-AI Report: run ${s.id}`, '');
  L.push(`**Final status:** ${OUTCOME[s.status] || s.status}  `);
  L.push(`**Source:** ${s.source?.label} (${s.source?.type})  `);
  L.push(`**AI provider(s):** ${(s.options?.agents || []).join(', ') || s.agent?.name || 'n/a'} · mode: ${s.options?.mode || 'single'}  `);
  L.push(`**IBM Bob calls:** ${s.bobCallCount ?? 0}  `);
  L.push(`**Started:** ${s.createdAt}  `);
  L.push(`**Finished:** ${s.finishedAt || '—'}`, '');

  if (['failed', 'timed-out', 'cancelled', 'interrupted', 'repair-not-verified'].includes(s.status)) {
    L.push('## Run outcome details', '');
    L.push(`- Error type: \`${s.errorType || 'n/a'}\``);
    L.push(`- Failed stage: \`${s.failedStage || 'n/a'}\``);
    if (s.error) L.push(`- Message: ${s.error}`);
    if (s.timedOutAt) L.push(`- Timed out at: ${s.timedOutAt}`);
    if (s.cancelledAt) L.push(`- Cancelled at: ${s.cancelledAt}`);
    if (s.interruptedAt) L.push(`- Interrupted at: ${s.interruptedAt}`);
    if (s.bobDebug) L.push('- Agent output could not be parsed; bounded diagnostics are stored in report.json → `bobDebug`.');
    L.push('');
  }

  L.push('## 1. Bug report', '', '```text', (s.bugReport || '').trim(), '```', '');
  if (s.rules) L.push('**Expected behaviour supplied:**', '', '```text', s.rules.trim(), '```', '');

  L.push('## 2. Investigation', '');
  if (s.localization) {
    L.push(`- **File:** \`${s.localization.file}\``, `- **Function:** \`${s.localization.function}\``, `- **Confidence:** ${s.localization.confidence || 'n/a'}`, '');
    L.push(s.localization.analysis || '', '');
    if ((s.investigations || []).length > 1) {
      L.push('Independent investigations:', '');
      for (const i of s.investigations) L.push(`- ${i.provider}: ${i.ok ? `${i.function} in ${i.file}` : `failed (${i.error})`}`);
      L.push('');
    }
  } else L.push('_Not reached._', '');

  L.push('## 3. Reproduction (RED)', '');
  if (s.red && s.tests) {
    L.push(`Regression suite \`${s.tests.path}\`: ${s.red.passed} passed, **${s.red.failed} failed** on the original code (${s.red.runner}).`, '');
    L.push(`Locked test fingerprint (SHA-256): \`${s.tests.hash}\``, '');
  } else L.push('_Not reached._', '');

  L.push('## 4. Root cause & repair', '');
  if (s.fix) {
    L.push(s.fix.rootCause || '', '', `**Fix summary:** ${s.fix.summary || ''}`, '');
    if (s.diffMeta && s.diffMeta.truncated) {
      L.push(`> ⚠️ Diff truncated for display: showing ${s.diffMeta.shownLines} of ${s.diffMeta.totalLines} lines. The complete diff is in \`fix.patch\`.`, '');
    }
    L.push('```diff', (s.diff || '').trim(), '```', '');
  } else L.push('_Not reached._', '');

  L.push('## 5. Candidate verification (GREEN)', '');
  if (s.green) {
    L.push(`Same locked suite on the candidate: **${s.green.passed} passed**, ${s.green.failed} failed.`, '');
    L.push('| Test | Before (RED) | After (GREEN) |', '|---|---|---|');
    for (const r of testMatrix(s)) L.push(`| ${r.name.replace(/\|/g, '\\|')} | ${icon(r.before)} | ${icon(r.after)} |`);
    L.push('');
  } else L.push('_Not reached._', '');

  L.push('## 6. Human approval', '');
  if (s.approval) L.push(`- Decision: **${s.approval.decision}** by ${s.approval.by} at ${s.approval.at}`, '');
  else L.push('_No decision recorded._', '');

  L.push('## 7. Final GREEN & delivery', '');
  if (s.finalGreen) {
    L.push(`- Final GREEN on the exact approved candidate: ${s.finalGreen.passed}/${s.finalGreen.total} passed`);
    if (s.fix) L.push(`- Changed files: ${s.fix.files.map(f => `\`${f.path}\` (+${f.additions} / −${f.deletions})`).join(', ')}`);
    if (s.writeBack) L.push(`- Written back to \`${s.writeBack.folder}\`: ${s.writeBack.files.join(', ')} (originals in \`runs/${s.id}/backup\`)`);
    L.push('');
  } else L.push('_Not delivered._', '');

  L.push('## 8. Team integrations', '');
  L.push(integrationLine('Jira', s.integrations?.jira), integrationLine('Slack', s.integrations?.slack), integrationLine('Microsoft Teams', s.integrations?.teams), '');
  L.push('_Integration delivery is recorded separately and never changes the repair status._', '');

  L.push('## 9. Agent activity', '');
  L.push('| Agent | Role | Attempt | Started | Duration | Result |', '|---|---|---|---|---|---|');
  for (const c of s.aiCalls || []) L.push(`| ${c.agent} | ${c.role} | ${c.attempt} | ${c.startedAt || ''} | ${dur(c.ms)} | ${c.ok ? 'ok' : 'error: ' + (c.error || '').slice(0, 80).replace(/\|/g, '/')} |`);
  L.push('');

  L.push('## 10. Integrity notes', '');
  L.push('- Tests were executed by BugRep (Jest/pytest), never reported by the AI.');
  L.push('- The regression suite was fingerprinted after RED and re-checked before verification and before delivery.');
  L.push('- The candidate was fingerprinted when verified; approval applied exactly that candidate.');
  L.push('- Agents could only change source files; tests, `__bugrep__/`, `node_modules/`, `.env` and paths outside the project were rejected.');
  L.push('- Only behaviour covered by the generated tests is verified. Review the diff before shipping.', '');
  return redact(L.join('\n'));
}

function writeReport(state, runDir) {
  const md = buildMarkdown(state);
  const mdPath = path.join(runDir, 'report.md');
  const jsonPath = path.join(runDir, 'report.json');
  fs.writeFileSync(mdPath, md, 'utf8');
  const json = JSON.parse(redact(JSON.stringify({ ...state, testMatrix: testMatrix(state) })));
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  return { mdPath, jsonPath };
}

module.exports = { writeReport, buildMarkdown, testMatrix };
