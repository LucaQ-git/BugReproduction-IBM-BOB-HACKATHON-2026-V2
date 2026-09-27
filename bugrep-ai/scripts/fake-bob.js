#!/usr/bin/env node
// scripts/fake-bob.js — a stand-in for Bob Shell used to test BugRep's Bob adapter
// without spending Bobcoins. It reads __bugrep__/TASK.md like Bob would and answers
// with the recorded demo answers. Usage (macOS/Linux):
//   BOB_CLI_PATH=./scripts/fake-bob.js BOBSHELL_API_KEY=dummy node cli.js run --demo --engine bob --yes
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-bob 0.0.0 (test double)'); process.exit(0); }
const ws = args[args.indexOf('--workspace') + 1];
const task = fs.readFileSync(path.join(ws, '__bugrep__', 'TASK.md'), 'utf8');
const replay = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'replay.json'), 'utf8'));
const answer = /^# Role: BugRep Test Agent/m.test(task) ? replay.test.answer : replay.fix.answer;
fs.writeFileSync(path.join(ws, '__bugrep__', 'answer.json'), JSON.stringify(answer));
// Mimic a wrapped JSON result on stdout.
console.log(JSON.stringify({ type: 'result', result: 'Done. ```json\n' + JSON.stringify(answer) + '\n```' }));
