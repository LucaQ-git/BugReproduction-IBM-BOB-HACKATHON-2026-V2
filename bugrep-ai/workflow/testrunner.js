// workflow/testrunner.js
// Runs the generated regression tests and returns a structured, honest result.
// JavaScript → Jest (bundled with BugRep, no project config needed)
// Python     → pytest (must be installed: pip install pytest)

'use strict';

const fs    = require('fs');
const path  = require('path');

const JEST_BIN = require.resolve('jest/bin/jest');

const { runProcess } = require('./proc');
const { RunError } = require('./errors');

function testTimeout() { return Number(process.env.TEST_TIMEOUT_MS || 120000); }

/**
 * Run a test command with a hard timeout. Timeouts and cancellation are thrown as
 * RunErrors: they are NEVER reported as a RED (failing-test) result.
 */
async function run(cmd, args, opts) {
  const timeoutMs = opts.timeout || testTimeout();
  const r = await runProcess(cmd, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell, timeoutMs, signal: opts.signal });
  if (r.aborted) throw new RunError('cancelled', 'Test run stopped by user.', { failedStage: opts.stage });
  if (r.timedOut) {
    throw new RunError('timeout', `${opts.what || 'Test execution'} exceeded ${Math.round(timeoutMs / 1000)} seconds.`, { failedStage: opts.stage });
  }
  return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr, error: r.error };
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

async function runJest(dir, testRel, project, ctl = {}) {
  const outFile = path.join(dir, '__bugrep__', `.jest-result-${Date.now()}.json`);
  const config = {
    rootDir: dir,
    roots: ['<rootDir>/__bugrep__'], // only crawl the test folder: much faster on big projects
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
  const r = await run(process.execPath, args, { cwd: dir, env: { ...process.env, NODE_ENV: 'test', FORCE_COLOR: '0' }, signal: ctl.signal, stage: ctl.stage });

  let json = null;
  try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* handled below */ }
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }

  if (!json) {
    // Jest itself did not run → environment failure, never "bug not reproduced".
    return finalize({ runner: 'jest', total: 0, passed: 0, failed: 0, suiteErrors: 1, tests: [], launchError: true,
      output: tidy(r.error ? `Could not launch Jest: ${r.error}` : (r.stderr || r.stdout || 'Jest produced no result')).slice(-4000) });
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

async function runPytest(dir, testRel, ctl = {}) {
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const xml = path.join(dir, '__bugrep__', `.pytest-${Date.now()}.xml`);
  const r = await run(py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${xml}`, testRel],
    { cwd: dir, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, signal: ctl.signal, stage: ctl.stage });

  if (/No module named pytest/.test(r.stderr + r.stdout) || r.error) {
    return finalize({ runner: 'pytest', total: 0, passed: 0, failed: 0, suiteErrors: 1, tests: [], launchError: true,
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

/** ctl = { signal, stage } */
async function runTests(dir, testRel, project, ctl = {}) {
  if (project.language === 'python') return runPytest(dir, testRel, ctl);
  return runJest(dir, testRel, project, ctl);
}

/** Install JS dependencies into a workspace (scripts disabled for safety). */
async function installDeps(dir, log, ctl = {}) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  log('Installing project dependencies (npm install --ignore-scripts)…');
  const r = await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: dir, shell: process.platform === 'win32', timeout: Number(process.env.INSTALL_TIMEOUT_MS || 300000), signal: ctl.signal, stage: 'index', what: 'npm install' });
  if (r.code !== 0) log(`npm install finished with warnings: ${tidy(r.stderr).split('\n').slice(-3).join(' ')}`);
  return r.code === 0;
}

module.exports = { runTests, testFileFor, installDeps, classify };
