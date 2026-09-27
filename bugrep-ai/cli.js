#!/usr/bin/env node
// cli.js — run the BugRep-AI pipeline from a terminal (e.g. inside IBM Bob IDE).
//
//   node cli.js run --demo                         controlled live demo (needs IBM Bob)
//   node cli.js run --path . --bug "text"           your local project / IDE workspace
//   node cli.js run --github <url> --bug-file f     a GitHub repository
//   node cli.js run --zip project.zip --bug "…"     a ZIP archive
//   node cli.js preflight                           demo preflight checks (no Bob calls)
//   node cli.js runs                                list recent runs
//
// Options: --rules "<expected behaviour>" | --rules-file f   --agent bob   --yes (auto-approve)
//          --write-back (local only)   --no-tests
// Ctrl+C stops the run (kills the running process, nothing is applied).

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const pipeline = require('./workflow/pipeline');
const sources  = require('./workflow/sources');
const demo     = require('./workflow/demo');

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = { red: s => c(31, s), green: s => c(32, s), yellow: s => c(33, s), cyan: s => c(36, s), dim: s => c(2, s), bold: s => c(1, s) };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function usage() {
  console.log(`
${C.bold('BugRep-AI')}: AI agents that reproduce, repair and verify bugs

  node cli.js run --demo [--yes]
  node cli.js run --path <folder> --bug "<bug report>" [--write-back]
  node cli.js run --github <url> --bug-file bug.txt
  node cli.js run --zip project.zip --bug "<bug report>"
  node cli.js preflight
  node cli.js runs

  --rules "<text>" | --rules-file <file>   expected behaviour / business rules
  --agent bob                              AI agent (default: IBM Bob)
  --yes                                    approve the verified repair automatically
  --no-tests                               leave the regression test out of the output
`);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim().toLowerCase()); }));
}

function colorDiff(diff) {
  return diff.split('\n').map(l =>
    l.startsWith('+') && !l.startsWith('+++') ? C.green(l) :
    l.startsWith('-') && !l.startsWith('---') ? C.red(l) :
    l.startsWith('@@') ? C.cyan(l) : C.dim(l)).join('\n');
}

const EXIT = { completed: 0, rejected: 2, 'not-reproduced': 4, 'repair-not-verified': 5, cancelled: 6, 'timed-out': 7 };

async function cmdRun(args) {
  let source;
  if (args.demo) source = { type: 'demo' };
  else if (args.github) source = { type: 'github', url: args.github, ref: args.ref };
  else if (args.zip) source = { type: 'zip', zipFile: args.zip };
  else source = { type: 'local', path: typeof args.path === 'string' ? args.path : sources.defaultLocalPath() };

  let bug = typeof args.bug === 'string' ? args.bug : '';
  if (args['bug-file']) bug = fs.readFileSync(args['bug-file'], 'utf8');
  if (!bug && source.type !== 'demo') { console.error(C.red('Please give a bug report with --bug "…" or --bug-file <file>.')); process.exit(3); }
  let rules = typeof args.rules === 'string' ? args.rules : '';
  if (args['rules-file']) rules = fs.readFileSync(args['rules-file'], 'utf8');

  if (source.type === 'demo') {
    const pf = await demo.preflight();
    for (const ch of pf.checks) console.log(`  ${ch.ok ? C.green('✓') : C.red('✗')} ${ch.label} ${C.dim(ch.detail)}`);
    if (!pf.ok) { console.error(C.red(`\nDEMO CANNOT START: ${pf.reason}`)); process.exit(3); }
  }

  let run;
  try {
    run = await pipeline.createRun({
      source, bugReport: bug, rules,
      options: { agents: [typeof args.agent === 'string' ? args.agent : 'bob'], autoApprove: !!args.yes,
        writeBack: !!args['write-back'], includeTests: !args['no-tests'] },
    });
  } catch (err) {
    console.error(C.red(err.message));
    process.exit(3);
  }

  console.log(`\n${C.bold('🐞 BugRep-AI')}  run ${C.cyan(run.id)}  ${C.dim('(Ctrl+C to stop)')}\n`);
  const icon = { investigator: '🔎', repairer: '🛠 ', runner: '▶ ', system: '• ' };
  run.on('log', e => {
    const line = `${icon[e.role] || '• '} ${C.dim(String(e.agent === 'system' ? 'BugRep' : e.agent).padEnd(22))} ${e.text}`;
    console.log(e.level === 'error' ? C.red(line) : e.level === 'warn' ? C.yellow(line) : line);
  });
  run.on('state', async s => {
    if (s.status === 'awaiting-approval' && !run._asked) {
      run._asked = true;
      console.log(`\n${C.bold('Proposed repair')} ${C.dim(`(verified: ${s.green.passed}/${s.green.total} locked tests pass)`)}\n`);
      console.log(colorDiff(s.diff));
      if (s.diffMeta && s.diffMeta.truncated) console.log(C.yellow(`\n(diff truncated for display: full patch in runs/${s.id}/fix.patch)`));
      const a = await ask(`\n${C.bold('Apply this repair?')} [y/N] `);
      try { run.decide(a === 'y' || a === 'yes' ? 'approved' : 'rejected', 'CLI reviewer'); } catch { /* already ended */ }
    }
  });
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(C.yellow('\nStopping run…'));
    try { run.cancel('CLI user'); } catch { process.exit(130); }
  });

  const done = new Promise(res => run.on('end', res));
  run.start();
  const s = await done;

  console.log('');
  const msg = {
    completed: C.green(C.bold(`✅ VERIFIED REPAIR: RED ${s.red?.failed} failing → GREEN ${s.green?.passed}/${s.green?.total} passing (final GREEN ${s.finalGreen?.passed}/${s.finalGreen?.total})`)),
    rejected: C.yellow('✋ Repair rejected: nothing was changed.'),
    'not-reproduced': C.yellow('ℹ️  Bug NOT reproduced: the tests ran and all passed on the original code.'),
    'repair-not-verified': C.yellow(`⚠️  Repair NOT verified: ${s.green?.failed ?? '?'} locked test(s) still fail. Nothing applied. Retry Fix from the web UI.`),
    'timed-out': C.red(`⏱️  RUN TIMED OUT at stage "${s.failedStage}": ${s.error}`),
    cancelled: C.yellow('⏹️  RUN CANCELLED: nothing was applied.'),
  }[s.status] || C.red(`❌ RUN FAILED (${s.errorType}) at "${s.failedStage}": ${s.error}`);
  console.log(msg);
  if (s.artifacts.fixedZip) console.log(`   Fixed code : ${path.join(pipeline.runDir(s.id), 'fixed-code.zip')}\n   Patch      : ${path.join(pipeline.runDir(s.id), 'fix.patch')}`);
  if (s.artifacts.reportMd) console.log(`   Report     : ${path.join(pipeline.runDir(s.id), 'report.md')}`);
  console.log(C.dim(`   IBM Bob calls: ${s.bobCallCount}`));
  console.log('');
  process.exit(EXIT[s.status] ?? 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'preflight') {
    const pf = await demo.preflight();
    for (const ch of pf.checks) console.log(`${ch.ok ? C.green('✓') : C.red('✗')} ${ch.label} ${C.dim(ch.detail)}`);
    console.log(pf.ok ? C.green('\nDemo ready.') : C.red(`\nDEMO CANNOT START: ${pf.reason}`));
    process.exit(pf.ok ? 0 : 3);
  }
  if (cmd === 'runs') {
    pipeline.recoverStaleRuns();
    for (const r of pipeline.listRuns({ limit: 30 })) {
      console.log(`${r.id}  ${r.status.padEnd(20)} ${String(r.agent?.name || '').padEnd(10)} ${r.source.label}  ${C.dim(r.bug.slice(0, 50))}`);
    }
    return;
  }
  usage();
  process.exit(cmd ? 3 : 0);
}

main().catch(err => { console.error(C.red(err.stack || err.message)); process.exit(1); });
