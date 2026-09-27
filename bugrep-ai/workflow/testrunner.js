// workflow/testrunner.js
// Runs the generated regression tests and returns a structured, honest result.
// JavaScript → Jest (bundled with BugRep, no project config needed)
// Python     → pytest (must be installed: pip install pytest)

'use strict';

const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

const JEST_BIN = require.resolve('jest/bin/jest');

function run(cmd, args, opts) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false;
    let child;
    try {
      child = spawn(cmd, args, { ...opts, windowsHide: true });
    } catch (err) {
      return resolve({ code: 1, stdout, stderr, error: err.message });
    }
    const timer = setTimeout(() => {
      if (!done) { child.kill(); stderr += '\n[BugRep] Test run timed out.'; }
    }, opts.timeout || 120000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { done = true; clearTimeout(timer); resolve({ code: 1, stdout, stderr, error: err.message }); });
    child.on('close', code => { done = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, error: null }); });
  });
}

// A test that fails only because the test itself is broken (bad import, typo)
// must never count as "bug reproduced".
const BROKEN_TEST = /(Cannot find module|is not a function|is not defined|is not a constructor|ReferenceError|ModuleNotFoundError|ImportError|NameError|AttributeError: module|SyntaxError)/;

function classify(result) {
  if (result.total === 0 || result.suiteErrors > 0) return 'error';
  if (result.failed === 0) return 'pass';
  const failures = result.tests.filter(t => t.status === 'failed');
  if (failures.length && failures.every(t => BROKEN_TEST.test(t.message))) return 'error';
  return 'fail';
}

async function runJest(dir, testRel, project) {
  const outFile = path.join(dir, '__bugrep__', `.jest-result-${Date.now()}.json`);
  const config = {
    rootDir: dir,
    testEnvironment: 'node',
    testMatch: ['**/__bugrep__/**/*.test.[cm]js', '**/__bugrep__/**/*.test.js'],
    transform: {},
    modulePathIgnorePatterns: ['<rootDir>/node_modules/.cache'],
  };
  const nodeArgs = [];
  if (project && project.moduleType === 'esm') nodeArgs.push('--experimental-vm-modules');
  const args = [
    ...nodeArgs, JEST_BIN,
    '--config', JSON.stringify(config),
    '--runTestsByPath', path.join(dir, testRel),
    '--json', '--outputFile', outFile,
    '--no-coverage', '--ci', '--watchman=false', '--forceExit', '--testTimeout=15000',
  ];
  const r = await run(process.execPath, args, { cwd: dir, env: { ...process.env, NODE_ENV: 'test', FORCE_COLOR: '0' } });

  let json = null;
  try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* handled below */ }
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }

  if (!json) {
    return finalize({ runner: 'jest', total: 0, passed: 0, failed: 0, suiteErrors: 1, tests: [],
      output: tidy(r.stderr || r.stdout || r.error || 'Jest produced no result') });
  }
  const tests = (json.testResults || []).flatMap(s => (s.assertionResults || []).map(t => ({
    name: t.title,
    fullName: t.fullName,
    status: t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped',
    message: tidy((t.failureMessages || []).join('\n')).slice(0, 1500),
  })));
  const suiteMsgs = (json.testResults || []).filter(s => s.status === 'failed' && (!s.assertionResults || !s.assertionResults.length))
    .map(s => tidy(s.message || ''));
  return finalize({
    runner: 'jest',
    total: json.numTotalTests || 0,
    passed: json.numPassedTests || 0,
    failed: json.numFailedTests || 0,
    suiteErrors: (json.numRuntimeErrorTestSuites || 0) + suiteMsgs.length,
    tests,
    output: suiteMsgs.join('\n').slice(0, 4000) || tidy(r.stderr).slice(-4000),
  });
}

async function runPytest(dir, testRel) {
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const xml = path.join(dir, '__bugrep__', `.pytest-${Date.now()}.xml`);
  const r = await run(py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${xml}`, testRel],
    { cwd: dir, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });

  if (/No module named pytest/.test(r.stderr + r.stdout) || r.error) {
    return finalize({ runner: 'pytest', total: 0, passed: 0, failed: 0, suiteErrors: 1, tests: [],
      output: r.error ? `Could not launch ${py}: ${r.error}` : 'pytest is not installed. Run: pip install pytest' });
  }
  let text = '';
  try { text = fs.readFileSync(xml, 'utf8'); fs.unlinkSync(xml); } catch { /* handled */ }
  const tests = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1];
    const body = m[3] || '';
    const name = (attrs.match(/\bname="([^"]*)"/) || [])[1] || 'test';
    const failed = /<(failure|error)\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    const msg = (body.match(/message="([^"]*)"/) || [])[1] || body.replace(/<[^>]+>/g, '');
    tests.push({ name, fullName: name, status: failed ? 'failed' : skipped ? 'skipped' : 'passed',
      message: failed ? decode(msg).slice(0, 1500) : '' });
  }
  const suiteErrors = Number((text.match(/<testsuite\b[^>]*\berrors="(\d+)"/) || [])[1] || 0) -
    tests.filter(t => t.status === 'failed').length;
  return finalize({
    runner: 'pytest',
    total: tests.length,
    passed: tests.filter(t => t.status === 'passed').length,
    failed: tests.filter(t => t.status === 'failed').length,
    suiteErrors: Math.max(0, suiteErrors) + (tests.length === 0 ? 1 : 0),
    tests,
    output: tidy(r.stdout + '\n' + r.stderr).slice(-4000),
  });
}

function finalize(res) {
  res.outcome = classify(res); // 'pass' | 'fail' | 'error'
  return res;
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
}

function tidy(s) {
  // strip ANSI colour codes
  return String(s || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

function testFileFor(language, moduleType) {
  if (language === 'python') return '__bugrep__/test_bugrep_repro.py';
  return moduleType === 'esm' ? '__bugrep__/bugrep.repro.test.mjs' : '__bugrep__/bugrep.repro.test.js';
}

async function runTests(dir, testRel, project) {
  if (project.language === 'python') return runPytest(dir, testRel);
  return runJest(dir, testRel, project);
}

/** Install JS dependencies into a workspace (scripts disabled for safety). */
async function installDeps(dir, log) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  log('Installing project dependencies (npm install --ignore-scripts)…');
  const r = await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: dir, shell: process.platform === 'win32', timeout: 300000 });
  if (r.code !== 0) log(`npm install finished with warnings: ${tidy(r.stderr).split('\n').slice(-3).join(' ')}`);
  return r.code === 0;
}

module.exports = { runTests, testFileFor, installDeps, classify };
