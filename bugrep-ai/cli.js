#!/usr/bin/env node
// cli.js — run the BugRep-AI pipeline from a terminal (e.g. inside IBM Bob IDE)
//
//   node cli.js run --demo                        bundled demo (works without API keys)
//   node cli.js run --path . --bug "text"          your local project / IDE workspace
//   node cli.js run --github <url> --bug-file f    a GitHub repository
//   node cli.js run --zip project.zip --bug "…"    a ZIP archive
//   node cli.js runs                               list recent runs
//
// Options: --rules "<expected behaviour>" | --rules-file f
//          --engine auto|bob|watsonx|replay   --yes (auto-approve)
//          --write-back (local only: write the fix into your folder)
//          --no-tests (don't include the regression test in the output)

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const pipeline = require('./workflow/pipeline');
const sources  = require('./workflow/sources');

const C = process.stdout.isTTY
  ? { red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
      bold: s => `\x1b[1m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m` }
  : { red: s => s, green: s => s, dim: s => s, bold: s => s, cyan: s => s, yellow: s => s };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function usage() {
  console.log(`
${C.bold('BugRep-AI')} — AI agents that reproduce, fix and report bugs

  node cli.js run --demo [--yes]
  node cli.js run --path <folder> --bug "<bug report>" [--write-back]
  node cli.js run --github <url> --bug-file bug.txt
  node cli.js run --zip project.zip --bug "<bug report>"
  node cli.js runs

  --rules "<text>" | --rules-file <file>   expected behaviour / business rules
  --engine auto|bob|watsonx|replay         AI engine (default auto)
  --yes                                    approve the verified fix automatically
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

async function cmdRun(args) {
  let source;
  if (args.demo) source = { type: 'demo' };
  else if (args.github) source = { type: 'github', url: args.github, ref: args.ref };
  else if (args.zip) source = { type: 'zip', zipFile: args.zip };
  else source = { type: 'local', path: typeof args.path === 'string' ? args.path : sources.defaultLocalPath() };

  let bug = typeof args.bug === 'string' ? args.bug : '';
  if (args['bug-file']) bug = fs.readFileSync(args['bug-file'], 'utf8');
  if (!bug && source.type === 'demo') bug = fs.readFileSync(path.join(__dirname, 'demo', 'bug_report.txt'), 'utf8');
  if (!bug) { console.error(C.red('Please give a bug report with --bug "…" or --bug-file <file>.')); process.exit(3); }

  let rules = typeof args.rules === 'string' ? args.rules : '';
  if (args['rules-file']) rules = fs.readFileSync(args['rules-file'], 'utf8');

  const run = pipeline.createRun({
    source, bugReport: bug, rules,
    options: {
      engine: typeof args.engine === 'string' ? args.engine : 'auto',
      autoApprove: !!args.yes,
      writeBack: !!args['write-back'],
      includeTests: !args['no-tests'],
    },
  });

  console.log(`\n${C.bold('🐞 BugRep-AI')}  run ${C.cyan(run.id)}\n`);
  const icons = { 'Test Agent': '🧪', 'Fix Agent': '🛠 ', Runner: '▶ ', system: '• ' };
  run.on('log', e => {
    const line = `${icons[e.agent] || '• '} ${C.dim(e.agent.padEnd(10))} ${e.text}`;
    console.log(e.level === 'error' ? C.red(line) : e.level === 'warn' ? C.yellow(line) : line);
  });

  run.on('state', async s => {
    if (s.status === 'awaiting-approval' && !run._asked) {
      run._asked = true;
      console.log(`\n${C.bold('Proposed fix')} ${C.dim('(verified: ' + s.green.passed + '/' + s.green.total + ' tests pass)')}\n`);
      console.log(colorDiff(s.diff));
      const a = await ask(`\n${C.bold('Apply this fix?')} [y/N] `);
      run.decide(a === 'y' || a === 'yes' ? 'approved' : 'rejected', 'CLI reviewer');
    }
  });

  const done = new Promise(res => run.on('end', res));
  run.start();
  const s = await done;

  console.log('');
  if (s.status === 'done') {
    console.log(C.green(C.bold(`✅ Fixed & verified — RED ${s.red.failed} failing → GREEN ${s.green.passed}/${s.green.total} passing`)));
    console.log(`   Fixed code : ${s.artifacts.fixedZip}`);
    console.log(`   Patch      : ${s.artifacts.patch}`);
  } else if (s.status === 'not-reproduced') {
    console.log(C.yellow('ℹ️  Bug not reproduced — the generated tests all pass on the current code.'));
  } else if (s.status === 'rejected') {
    console.log(C.yellow('✋ Fix rejected — nothing was changed.'));
  } else {
    console.log(C.red(`❌ ${s.error || 'Run failed'}`));
  }
  if (s.artifacts.reportMd) console.log(`   Report     : ${s.artifacts.reportMd}`);
  console.log('');
  process.exit({ done: 0, rejected: 2, 'not-reproduced': 4 }[s.status] ?? 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'runs') {
    for (const r of pipeline.listRuns(20)) console.log(`${r.id}  ${r.status.padEnd(15)} ${r.source.label}  ${C.dim(r.bug.slice(0, 60))}`);
    return;
  }
  usage();
  process.exit(cmd ? 3 : 0);
}

main().catch(err => { console.error(C.red(err.stack || err.message)); process.exit(3); });
