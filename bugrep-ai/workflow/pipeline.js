// workflow/pipeline.js
// The BugRep-AI pipeline, shared by the web UI and the CLI.
//
//   acquire → index → Test Agent (AI) → reproduce (RED) → Fix Agent (AI)
//   → verify (GREEN, same locked tests) → your approval → deliver → report
//
// AI agents only produce text (tests, fixes, analysis). Everything that decides
// whether a bug is real or fixed — running tests, hashing the suite, computing
// the diff, applying files — is done here in plain Node, so results are honest.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const EventEmitter = require('events');
const Diff    = require('diff');

const ws       = require('./workspace');
const sources  = require('./sources');
const engines  = require('./engines');
const prompts  = require('./prompts');
const runner   = require('./testrunner');
const report   = require('./report');

const ROOT     = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(ROOT, 'runs');

const STAGES = [
  { key: 'acquire',   label: 'Fetch code',        actor: 'system' },
  { key: 'index',     label: 'Map codebase',      actor: 'system' },
  { key: 'test',      label: 'Test Agent',        actor: 'ai'     },
  { key: 'reproduce', label: 'Reproduce bug',     actor: 'runner' },
  { key: 'fix',       label: 'Fix Agent',         actor: 'ai'     },
  { key: 'verify',    label: 'Verify fix',        actor: 'runner' },
  { key: 'review',    label: 'Your approval',     actor: 'human'  },
  { key: 'deliver',   label: 'Deliver fixed code', actor: 'system' },
  { key: 'report',    label: 'Report',            actor: 'system' },
];

const WEAK_JS = /\.(toBeTruthy|toBeFalsy|toBeDefined)\s*\(|expect\.anything\s*\(|\b(test|it|describe)\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(/;
const WEAK_PY = /\bassert\s+True\b|pytest\.skip\s*\(|@pytest\.mark\.skip/;

class Run extends EventEmitter {
  constructor(opts) {
    super();
    this.setMaxListeners(50);
    const id = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12) + '-' + crypto.randomBytes(2).toString('hex');
    this.id = id;
    this.dir = ws.ensureDir(path.join(RUNS_DIR, id));
    this.baseDir = path.join(this.dir, 'workspace');       // original code + tests (RED)
    this.candDir = path.join(this.dir, 'candidate');       // fixed code + same tests (GREEN)
    this.logs = [];
    this._decision = null;

    const o = opts.options || {};
    this.state = {
      id,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running', // running | awaiting-approval | done | not-reproduced | rejected | failed
      source: { type: opts.source.type, label: '…', detail: '' },
      bugReport: String(opts.bugReport || '').trim(),
      rules: String(opts.rules || '').trim(),
      options: {
        engine: o.engine || 'auto',
        autoApprove: !!o.autoApprove,
        includeTests: o.includeTests !== false,
        writeBack: !!o.writeBack,
        installDeps: o.installDeps !== false,
      },
      engine: null,
      stages: Object.fromEntries(STAGES.map(s => [s.key, { status: 'pending', startedAt: null, endedAt: null, note: '' }])),
      project: null,
      candidates: [],
      localization: null,
      tests: null,
      red: null,
      fix: null,
      diff: null,
      green: null,
      approval: null,
      writeBack: null,
      aiCalls: [],
      attempts: { test: 0, fix: 0 },
      artifacts: {},
      error: null,
    };
    this._source = opts.source;
    this._save();
  }

  // ── events & persistence ──────────────────────────────────────────────────
  log(agent, text, level = 'info') {
    const entry = { t: Date.now(), agent, text: String(text), level };
    this.logs.push(entry);
    if (this.logs.length > 800) this.logs.shift();
    this.emit('log', entry);
    try { fs.appendFileSync(path.join(this.dir, 'log.jsonl'), JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
  }

  _save() {
    fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2));
    this.emit('state', this.state);
  }

  _stage(key, status, note) {
    const st = this.state.stages[key];
    if (status === 'active') st.startedAt = Date.now();
    if (['done', 'failed', 'skipped'].includes(status)) st.endedAt = Date.now();
    st.status = status;
    if (note !== undefined) st.note = note;
    this._save();
  }

  _finish(status, error) {
    this.state.status = status;
    if (error) this.state.error = error;
    this.state.finishedAt = new Date().toISOString();
    for (const s of Object.values(this.state.stages)) if (s.status === 'active') { s.status = 'failed'; s.endedAt = Date.now(); }
    this._writeReport();
    this._save();
    this.emit('end', this.state);
  }

  _writeReport() {
    try {
      this._stage('report', 'active');
      const { mdPath, jsonPath } = report.writeReport(this.state, this.dir);
      this.state.artifacts.reportMd = path.relative(ROOT, mdPath);
      this.state.artifacts.reportJson = path.relative(ROOT, jsonPath);
      this._stage('report', 'done', 'Markdown + JSON');
    } catch (err) {
      this._stage('report', 'failed', err.message);
    }
  }

  // ── human decision ─────────────────────────────────────────────────────────
  decide(decision, by = 'web reviewer', extra = {}) {
    if (this.state.status !== 'awaiting-approval' || !this._decision) {
      throw new Error('This run is not waiting for approval.');
    }
    const resolve = this._decision;
    this._decision = null;
    resolve({ decision, by, ...extra });
  }

  // ── main flow ──────────────────────────────────────────────────────────────
  async start() {
    try {
      await this._acquire();
      await this._index();
      const reproduced = await this._testAndReproduce();
      if (!reproduced) return;
      const verified = await this._fixAndVerify();
      if (!verified) return;
      await this._review();
    } catch (err) {
      this.log('system', err.message, 'error');
      this._finish('failed', err.message);
    }
  }

  async _acquire() {
    this._stage('acquire', 'active');
    const info = await sources.acquire(this._source, this.baseDir, t => this.log('system', t));
    this.state.source = { type: this._source.type, label: info.label, detail: info.detail || '' };
    this._localPath = info.localPath || null;
    const count = ws.listFiles(this.baseDir).length;
    this._stage('acquire', 'done', `${count} files`);
    this.log('system', `Workspace ready — ${count} files copied. Your original code is untouched.`);
  }

  async _index() {
    this._stage('index', 'active');
    const project = ws.detectProject(this.baseDir);
    if (!project.language) throw new Error('No source files found. BugRep supports JavaScript and Python projects.');
    if (!['javascript', 'python'].includes(project.language)) {
      throw new Error(`Detected a ${project.language} project. BugRep can currently run tests for JavaScript and Python projects.`);
    }
    if (project.language === 'javascript' && project.needsInstall && this.state.options.installDeps) {
      await runner.installDeps(this.baseDir, t => this.log('system', t));
    }
    this.project = project;
    this.context = ws.buildContext(this.baseDir, this.state.bugReport + '\n' + this.state.rules, { project });
    this.state.project = { language: project.language, moduleType: project.moduleType, files: project.fileCount };
    this.state.candidates = this.context.candidates.map(c => ({ path: c.path, score: c.score }));
    this.state.engine = engines.pickEngine(this.state.options.engine, this._source.type === 'demo');
    this._stage('index', 'done', `${project.language} · ${this.context.candidates.length} key files`);
    this.log('system', `Detected ${project.language}${project.language === 'javascript' ? ' (' + project.moduleType + ')' : ''}. ` +
      `Most relevant: ${this.context.candidates.slice(0, 3).map(c => c.path).join(', ') || 'n/a'}.`);
    this.log('system', `AI engine: ${this.state.engine === 'bob' ? 'IBM Bob Shell' : this.state.engine === 'watsonx' ? 'IBM watsonx.ai' : 'Demo replay'}`);
  }

  async _callAgent(agent, prompt, keys, scratchFrom) {
    const attempt = ++this.state.attempts[agent === 'Test Agent' ? 'test' : 'fix'];
    const call = { agent, engine: this.state.engine, attempt, ms: 0, ok: false, error: null };
    this.state.aiCalls.push(call);
    fs.writeFileSync(path.join(this.dir, `prompt-${agent.split(' ')[0].toLowerCase()}-${attempt}.md`), prompt);
    try {
      const { answer, ms } = await engines.ask(this.state.engine, {
        agent: agent.split(' ')[0].toLowerCase(), prompt, keys, scratchFrom, runDir: this.dir, attempt,
        log: t => this.log(agent, t),
      });
      call.ms = ms; call.ok = true;
      this._save();
      return answer;
    } catch (err) {
      call.error = err.message;
      this._save();
      throw err;
    }
  }

  async _testAndReproduce() {
    const testPath = runner.testFileFor(this.project.language, this.project.moduleType);
    let previousError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      this._stage('test', 'active', attempt > 1 ? 'retrying' : '');
      this.log('Test Agent', attempt === 1 ? 'Reading the bug report and scanning the code…' : 'Previous tests could not run — rewriting them…');
      const ans = await this._callAgent('Test Agent', prompts.testAgentPrompt({
        bugReport: this.state.bugReport, rules: this.state.rules, context: this.context,
        project: this.project, testPath, previousError,
      }), ['testCode'], this.baseDir);

      const testCode = String(ans.testCode || '').replace(/^```\w*\n|```\s*$/g, '');
      const weak = (this.project.language === 'python' ? WEAK_PY : WEAK_JS).exec(testCode);
      if (!testCode.trim()) { previousError = 'You returned an empty testCode.'; this._stage('test', 'failed'); continue; }
      if (weak) {
        previousError = `Weak or skipped assertion is not allowed: "${weak[0]}". Use strict assertions only.`;
        this.log('Test Agent', `Rejected tests: ${previousError}`, 'warn');
        this._stage('test', 'failed', 'weak assertion');
        continue;
      }

      this.state.localization = {
        file: ans.localizedFile || 'unknown', function: ans.localizedFunction || 'unknown',
        confidence: ans.confidence || 'medium', analysis: ans.analysis || '',
      };
      this._writeTests(testPath, testCode);
      this.state.tests = {
        path: testPath, code: testCode, hash: ws.sha256File(path.join(this.baseDir, testPath)),
        list: Array.isArray(ans.tests) ? ans.tests.slice(0, 20) : [],
      };
      this._stage('test', 'done', `${this.state.localization.function} in ${this.state.localization.file}`);
      this.log('Test Agent', `Suspect: ${this.state.localization.function}() in ${this.state.localization.file}. ${this.state.localization.analysis}`);

      // RED run — the orchestrator runs the tests, not the AI
      this._stage('reproduce', 'active');
      this.log('Runner', `Running ${testPath} against the ORIGINAL code…`);
      const red = await runner.runTests(this.baseDir, testPath, this.project);
      this.state.red = red;
      this._save();

      if (red.outcome === 'error') {
        previousError = red.output || red.tests.filter(t => t.status === 'failed').map(t => `${t.name}: ${t.message}`).join('\n');
        this.log('Runner', `Tests could not run properly (${red.total} executed). ${previousError.split('\n')[0]}`, 'warn');
        this._stage('reproduce', 'failed', 'test error');
        if (attempt === 2) throw new Error('The Test Agent could not produce a runnable test suite after 2 attempts. See the run log for details.');
        continue;
      }
      if (red.outcome === 'pass') {
        this._stage('reproduce', 'done', `0 of ${red.total} failed`);
        this.log('Runner', `All ${red.total} tests pass on the original code — the bug could not be reproduced.`, 'warn');
        for (const k of ['fix', 'verify', 'review', 'deliver']) this.state.stages[k].status = 'skipped';
        this._finish('not-reproduced');
        return false;
      }
      this._stage('reproduce', 'done', `${red.failed} of ${red.total} failed`);
      this.log('Runner', `🔴 Bug reproduced — ${red.failed} of ${red.total} tests fail on the original code. Suite locked (${this.state.tests.hash.slice(0, 12)}…).`);
      return true;
    }
    throw new Error('The Test Agent did not produce usable tests.');
  }

  _writeTests(testPath, code) {
    const abs = path.join(this.baseDir, testPath);
    ws.ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, code, 'utf8');
    if (this.project.language === 'python') {
      fs.writeFileSync(path.join(this.baseDir, '__bugrep__', 'conftest.py'),
        'import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\n');
    }
  }

  async _fixAndVerify() {
    let previousAttempt = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      this._stage('fix', 'active', attempt > 1 ? 'retrying' : '');
      this.log('Fix Agent', attempt === 1 ? 'Studying the failing tests and the suspect code…' : 'First fix was not enough — trying a different approach…');
      const failures = this.state.red.tests.filter(t => t.status === 'failed').map(t => `✗ ${t.name}\n  ${t.message.split('\n').slice(0, 4).join('\n  ')}`).join('\n');
      const ans = await this._callAgent('Fix Agent', prompts.fixAgentPrompt({
        bugReport: this.state.bugReport, rules: this.state.rules, context: this.context, project: this.project,
        localization: this.state.localization, testCode: this.state.tests.code, failures, previousAttempt,
      }), ['files'], this.baseDir);

      // Build the candidate workspace: original code + same tests + AI changes
      fs.rmSync(this.candDir, { recursive: true, force: true });
      ws.copyTree(this.baseDir, this.candDir);
      ws.linkNodeModules(this.baseDir, this.candDir);
      const changed = this._applyFixFiles(ans.files);
      if (!changed.length) {
        previousAttempt = 'You did not return any valid changed source file.';
        this._stage('fix', 'failed', 'no valid files');
        continue;
      }

      // Integrity: the suite must be byte-identical to the locked RED suite
      const candHash = ws.sha256File(path.join(this.candDir, this.state.tests.path));
      if (candHash !== this.state.tests.hash) throw new Error('INTEGRITY: the regression suite changed during the fix stage. Run aborted.');

      this.state.fix = { rootCause: ans.rootCause || '', summary: ans.fixSummary || '', files: changed };
      this.state.diff = this._diff(changed.map(c => c.path));
      this._stage('fix', 'done', changed.map(c => c.path).join(', '));
      this.log('Fix Agent', `${ans.rootCause || 'Fix drafted.'}`);

      this._stage('verify', 'active');
      this.log('Runner', 'Running the SAME locked tests against the fixed code…');
      const green = await runner.runTests(this.candDir, this.state.tests.path, this.project);
      this.state.green = green;
      this._save();
      if (green.outcome === 'pass') {
        this._stage('verify', 'done', `${green.passed} of ${green.total} pass`);
        this.log('Runner', `🟢 Verified — all ${green.total} tests pass on the fixed code.`);
        return true;
      }
      previousAttempt = green.output || green.tests.filter(t => t.status === 'failed').map(t => `✗ ${t.name}: ${t.message}`).join('\n');
      this._stage('verify', 'failed', `${green.failed} still failing`);
      this.log('Runner', `Fix incomplete — ${green.failed} test(s) still fail.`, 'warn');
    }
    this.state.stages.review.status = 'skipped';
    this.state.stages.deliver.status = 'skipped';
    this._finish('failed', 'The Fix Agent could not make every test pass after 2 attempts. No changes were applied.');
    return false;
  }

  _applyFixFiles(files) {
    const changed = [];
    for (const f of Array.isArray(files) ? files.slice(0, 8) : []) {
      const rel = String(f.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
      const abs = ws.safeJoin(this.candDir, rel);
      if (!abs) { this.log('Fix Agent', `Ignored unsafe path "${f.path}"`, 'warn'); continue; }
      if (rel.startsWith('__bugrep__') || ws.isTestPath(rel) || /(^|\/)node_modules\//.test(rel)) {
        this.log('Fix Agent', `Blocked attempt to modify protected file ${rel}`, 'warn');
        continue;
      }
      if (typeof f.content !== 'string' || !f.content.trim()) continue;
      const content = f.content.replace(/^```\w*\n|```\s*$/g, '');
      const before = fs.existsSync(path.join(this.baseDir, rel)) ? fs.readFileSync(path.join(this.baseDir, rel), 'utf8') : '';
      if (before === content) continue;
      ws.ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, content, 'utf8');
      const stats = Diff.diffLines(before, content).reduce((a, p) => {
        if (p.added) a.additions += p.count; else if (p.removed) a.deletions += p.count; return a;
      }, { additions: 0, deletions: 0 });
      changed.push({ path: rel, isNew: !before, ...stats });
    }
    return changed;
  }

  _diff(paths) {
    return paths.map(rel => {
      const a = path.join(this.baseDir, rel);
      const before = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : '';
      const after = fs.readFileSync(path.join(this.candDir, rel), 'utf8');
      return Diff.createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, '', '', { context: 3 });
    }).join('\n');
  }

  async _review() {
    this._stage('review', 'active', this.state.options.autoApprove ? 'auto-approve' : 'waiting for you');
    let decision;
    if (this.state.options.autoApprove) {
      decision = { decision: 'approved', by: 'auto-approve setting' };
      this.log('system', 'Auto-approve is on — applying the verified fix.');
    } else {
      this.state.status = 'awaiting-approval';
      this._save();
      this.log('system', 'Fix verified. Review the diff and approve or reject it.');
      decision = await new Promise(resolve => { this._decision = resolve; });
      this.state.status = 'running';
    }
    this.state.approval = { decision: decision.decision, by: decision.by, at: new Date().toISOString() };
    if (typeof decision.writeBack === 'boolean') this.state.options.writeBack = decision.writeBack;
    if (typeof decision.includeTests === 'boolean') this.state.options.includeTests = decision.includeTests;

    if (decision.decision !== 'approved') {
      this._stage('review', 'done', 'rejected');
      this.state.stages.deliver.status = 'skipped';
      this.log('system', 'Fix rejected — nothing was changed.');
      this._finish('rejected');
      return;
    }
    this._stage('review', 'done', 'approved');
    await this._deliver();
    this._finish('done');
  }

  async _deliver() {
    this._stage('deliver', 'active');
    // Re-check integrity one last time before anything leaves the sandbox
    if (ws.sha256File(path.join(this.candDir, this.state.tests.path)) !== this.state.tests.hash) {
      throw new Error('INTEGRITY: regression suite changed after verification.');
    }
    const zipPath = path.join(this.dir, 'fixed-code.zip');
    ws.zipWorkspace(this.candDir, zipPath, { includeTests: this.state.options.includeTests });
    fs.writeFileSync(path.join(this.dir, 'fix.patch'), this.state.diff || '');
    const testsOut = path.join(this.dir, path.basename(this.state.tests.path));
    fs.copyFileSync(path.join(this.candDir, this.state.tests.path), testsOut);
    this.state.artifacts = {
      ...this.state.artifacts,
      fixedZip: path.relative(ROOT, zipPath),
      patch: path.relative(ROOT, path.join(this.dir, 'fix.patch')),
      tests: path.relative(ROOT, testsOut),
    };

    if (this.state.options.writeBack && this._localPath) {
      const written = [];
      const backup = path.join(this.dir, 'backup');
      for (const f of this.state.fix.files) {
        const dest = ws.safeJoin(this._localPath, f.path);
        if (!dest) continue;
        if (fs.existsSync(dest)) {
          ws.ensureDir(path.dirname(path.join(backup, f.path)));
          fs.copyFileSync(dest, path.join(backup, f.path));
        }
        ws.ensureDir(path.dirname(dest));
        fs.copyFileSync(path.join(this.candDir, f.path), dest);
        written.push(f.path);
      }
      if (this.state.options.includeTests) {
        const dest = path.join(this._localPath, this.state.tests.path);
        ws.ensureDir(path.dirname(dest));
        fs.copyFileSync(path.join(this.candDir, this.state.tests.path), dest);
        written.push(this.state.tests.path);
      }
      this.state.writeBack = { folder: this._localPath, files: written };
      this.log('system', `Wrote ${written.length} file(s) back to ${this._localPath}. Originals backed up in runs/${this.id}/backup.`);
    }
    this._stage('deliver', 'done', this.state.writeBack ? 'written to folder + ZIP' : 'ZIP + patch ready');
    this.log('system', '✅ Fixed code packaged — download the ZIP, patch or report.');
  }
}

// ── registry ─────────────────────────────────────────────────────────────────
const active = new Map();

function createRun(opts) {
  if (!opts || !opts.source || !opts.source.type) throw new Error('A code source is required.');
  if (!String(opts.bugReport || '').trim()) throw new Error('Please describe the bug.');
  const src = opts.source;
  if (src.type === 'github') sources.parseGithubUrl(src.url); // throws a friendly error
  if (src.type === 'local') {
    const p = path.resolve(String(src.path || '').trim() || sources.defaultLocalPath());
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`Folder not found: ${p}`);
  }
  if (!['local', 'github', 'zip', 'demo'].includes(src.type)) throw new Error(`Unknown source "${src.type}".`);
  if (src.type !== 'demo') engines.pickEngine(opts.options && opts.options.engine, false); // fail fast if no AI engine
  const run = new Run(opts);
  active.set(run.id, run);
  run.on('end', () => setTimeout(() => active.delete(run.id), 30 * 60 * 1000));
  return run;
}

function getRun(id) {
  return active.get(id) || null;
}

function loadState(id) {
  const safe = String(id).replace(/[^a-z0-9-]/gi, '');
  const live = active.get(safe);
  if (live) return live.state;
  const file = path.join(RUNS_DIR, safe, 'state.json');
  if (!fs.existsSync(file)) return null;
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (s.status === 'running' || s.status === 'awaiting-approval') s.status = 'interrupted';
  return s;
}

function listRuns(limit = 12) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR).filter(d => !d.startsWith('_')).sort().reverse().slice(0, limit)
    .map(loadState).filter(Boolean)
    .map(s => ({ id: s.id, createdAt: s.createdAt, status: s.status, source: s.source, engine: s.engine,
      bug: s.bugReport.slice(0, 120), red: s.red && s.red.failed, green: s.green && s.green.passed }));
}

function loadLogs(id) {
  try {
    return fs.readFileSync(path.join(runDir(id), 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

function runDir(id) {
  return path.join(RUNS_DIR, String(id).replace(/[^a-z0-9-]/gi, ''));
}

module.exports = { createRun, getRun, loadState, loadLogs, listRuns, runDir, STAGES, ROOT };
