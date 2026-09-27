// workflow/report.js
// Builds the Markdown + JSON run report from recorded facts only.

'use strict';

const fs   = require('fs');
const path = require('path');

const ENGINE_NAMES = { bob: 'IBM Bob Shell', watsonx: 'IBM watsonx.ai', replay: 'Demo replay (pre-recorded agent answers)' };

function testMatrix(state) {
  const names = new Map();
  for (const t of state.red?.tests || []) names.set(t.name, { name: t.name, before: t.status });
  for (const t of state.green?.tests || []) {
    const row = names.get(t.name) || { name: t.name, before: '—' };
    row.after = t.status;
    names.set(t.name, row);
  }
  return [...names.values()];
}

function icon(s) {
  return s === 'passed' ? '✅ pass' : s === 'failed' ? '❌ fail' : s || '—';
}

function buildMarkdown(state) {
  const s = state;
  const lines = [];
  const outcome = {
    done: '✅ Bug reproduced, fixed and verified',
    'not-reproduced': 'ℹ️ Bug could not be reproduced',
    rejected: '✋ Fix rejected by reviewer — no changes applied',
    failed: '❌ Run failed',
  }[s.status] || s.status;

  lines.push(`# BugRep-AI Report — run ${s.id}`, '');
  lines.push(`**Outcome:** ${outcome}  `);
  lines.push(`**Source:** ${s.source.label} (${s.source.type})  `);
  lines.push(`**AI engine:** ${ENGINE_NAMES[s.engine] || s.engine}  `);
  lines.push(`**Started:** ${s.createdAt}  `);
  lines.push(`**Finished:** ${s.finishedAt || new Date().toISOString()}`, '');

  lines.push('## 1. Bug report', '', '```text', s.bugReport.trim(), '```', '');
  if (s.rules) lines.push('**Expected behaviour supplied:**', '', '```text', s.rules.trim(), '```', '');

  lines.push('## 2. Where the bug is', '');
  if (s.localization) {
    lines.push(`- **File:** \`${s.localization.file}\``);
    lines.push(`- **Function:** \`${s.localization.function}\``);
    lines.push(`- **Confidence:** ${s.localization.confidence || 'n/a'}`, '');
    lines.push(s.localization.analysis || '', '');
  } else lines.push('_Not reached._', '');

  lines.push('## 3. Reproduction (RED)', '');
  if (s.red) {
    lines.push(`Regression suite \`${s.tests.path}\` — ${s.red.passed} passed, **${s.red.failed} failed** on the original code.`, '');
    lines.push(`Suite fingerprint (SHA-256): \`${s.tests.hash}\``, '');
  } else lines.push('_Not reached._', '');

  lines.push('## 4. Root cause & fix', '');
  if (s.fix) {
    lines.push(s.fix.rootCause || '', '', `**Change:** ${s.fix.summary || ''}`, '');
    lines.push('```diff', (s.diff || '').trim(), '```', '');
  } else lines.push('_Not reached._', '');

  lines.push('## 5. Verification (GREEN)', '');
  if (s.green) {
    lines.push(`Same suite (identical fingerprint) on the fixed code: **${s.green.passed} passed**, ${s.green.failed} failed.`, '');
    lines.push('| Test | Before fix | After fix |', '|---|---|---|');
    for (const r of testMatrix(s)) lines.push(`| ${r.name.replace(/\|/g, '\\|')} | ${icon(r.before)} | ${icon(r.after)} |`);
    lines.push('');
  } else lines.push('_Not reached._', '');

  lines.push('## 6. Delivery', '');
  if (s.approval) {
    lines.push(`- Decision: **${s.approval.decision}** by ${s.approval.by} at ${s.approval.at}`);
    if (s.writeBack) lines.push(`- Written back to \`${s.writeBack.folder}\`: ${s.writeBack.files.join(', ')} (originals backed up in \`runs/${s.id}/backup\`)`);
    if (s.fix) lines.push(`- Changed files: ${s.fix.files.map(f => `\`${f.path}\` (+${f.additions} / −${f.deletions})`).join(', ')}`);
    lines.push('');
  } else lines.push('_No decision recorded._', '');

  lines.push('## 7. Agent activity', '');
  lines.push('| Agent | Engine | Attempt | Duration | Result |', '|---|---|---|---|---|');
  for (const c of s.aiCalls || []) lines.push(`| ${c.agent} | ${c.engine} | ${c.attempt} | ${(c.ms / 1000).toFixed(1)}s | ${c.ok ? 'ok' : 'error: ' + (c.error || '').slice(0, 80)} |`);
  lines.push('');

  lines.push('## 8. Integrity & limitations', '');
  lines.push('- Tests were executed by BugRep (Jest/pytest), never reported by the AI.');
  lines.push('- The regression suite was fingerprinted after the RED run and re-checked before verification — it was not modified by the Fix Agent.');
  lines.push('- The Fix Agent could only change source files; test files and paths outside the project were rejected.');
  if (s.engine === 'replay') lines.push('- **Demo replay:** agent answers were pre-recorded for this bundled demo. Test runs, diff and verification were executed live.');
  if (s.error) lines.push(`- Error: ${s.error}`);
  lines.push('- Only the behaviour covered by the generated tests is verified; review the diff before shipping.', '');

  return lines.join('\n');
}

function writeReport(state, runDir) {
  const md = buildMarkdown(state);
  const mdPath = path.join(runDir, 'report.md');
  const jsonPath = path.join(runDir, 'report.json');
  fs.writeFileSync(mdPath, md, 'utf8');
  const json = { ...state, testMatrix: testMatrix(state) };
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  return { mdPath, jsonPath };
}

module.exports = { writeReport, buildMarkdown, testMatrix };
