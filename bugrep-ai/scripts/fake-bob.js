#!/usr/bin/env node
// scripts/fake-bob.js — TEST DOUBLE for Bob Shell. Used only by the automated tests
// (point BOB_CLI_PATH at it). Never used by the app itself and never shown as a real result.
//
// FAKE_BOB_MODE: ok (default) | garbage | sleep | hang-test | bad-fix | exit-error
// FAKE_BOB_LOG:  optional file; one line is appended per invocation (to count calls)
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const mode = process.env.FAKE_BOB_MODE || 'ok';
if (process.env.FAKE_BOB_LOG) fs.appendFileSync(process.env.FAKE_BOB_LOG, (args[0] || '') + '\n');
if (args.includes('--version')) { console.log('fake-bob 0.0.0 (test double)'); process.exit(0); }

const ws = args[args.indexOf('--workspace') + 1];
const taskFile = path.join(ws, '__bugrep__', 'TASK.md');
const task = fs.existsSync(taskFile) ? fs.readFileSync(taskFile, 'utf8') : args[args.length - 1];
const role = /^# Role: BugRep Investigator/m.test(task) ? 'investigator' : 'repairer';
const answers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'fake-bob-answers.json'), 'utf8'));
let answer = { ...answers[role] };

if (mode === 'sleep') { setTimeout(() => {}, 10 * 60 * 1000); return; }
if (mode === 'garbage') { console.log('I looked at the code and I think it is fine. No JSON here.'); console.error('warning: something odd'); process.exit(0); }
if (mode === 'exit-error') { console.error('Error: internal failure in fake bob'); process.exit(3); }
if (mode === 'hang-test' && role === 'investigator') {
  answer.testCode = "test('hangs forever', () => { while (true) {} });\n";
}
if (mode === 'bad-fix' && role === 'repairer') {
  answer.fixedCode = answer.fixedCode.replace('Math.max(0, subtotal - discount)', '(subtotal - discount)');
}
fs.writeFileSync(path.join(ws, '__bugrep__', 'answer.json'), JSON.stringify(answer));
// Mimic a wrapped JSON envelope on stdout.
console.log(JSON.stringify({ type: 'result', result: 'Done. ```json\n' + JSON.stringify(answer) + '\n```' }));
