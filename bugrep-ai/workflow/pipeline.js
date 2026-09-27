// workflow/pipeline.js — the BugRep-AI pipeline, shared by the web UI and the CLI.
//
//   acquire → index → INVESTIGATE (AI call #1) → REPRODUCE (RED) → REPAIR (AI call #2)
//   → VERIFY (GREEN, same locked tests) → human APPROVAL → DELIVER (final GREEN) → REPORT
//
// Guarantees
//   • Exactly one Investigator call and one Repairer call per normal run. No hidden retries:
//     another repair call only happens when the user clicks "Retry Fix".
//   • Every external process has a hard timeout and can be cancelled (Stop Run).
//   • The whole run has an active-time budget (PIPELINE_TIMEOUT_MS); waiting for approval
//     does not count against it.
//   • Every run ends in an explicit status: completed · awaiting-approval · rejected · failed ·
//     timed-out · cancelled · interrupted · not-reproduced · repair-not-verified.
//   • Infrastructure failures are never reported as "bug not reproduced".
//   • Pass/fail comes from Jest/pytest, never from the AI. Tests are locked by SHA-256 and the
//     exact verified candidate (also hashed) is what gets applied.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const EventEmitter = require('events');
const Diff    = require('diff');

const ws       = require('./workspace');
const sources  = require('./sources');
const runner   = require('./testrunner');
const report   = require('./report');
const demo     = require('./demo');
const agents   = require('../agents');
const { RunError, ACTIVE, TERMINAL, statusForError } = require('./errors');
const { redact } = require('./redact');
const { RUNS_DIR, ROOT } = require('./paths');

const STAGES = [
  { key: 'acquire',     label: 'Fetch code',        group: 'analyze' },
  { key: 'index',       label: 'Map codebase',      group: 'analyze' },
  { key: 'investigate', label: 'Investigator',      group: 'analyze', ai: true },
  { key: 'reproduce',   label: 'Reproduce (RED)',   group: 'reproduce' },
  { key: 'repair',      label: 'Repairer',          group: 'repair', ai: true },
  { key: 'verify',      label: 'Verify (GREEN)',    group: 'verify' },
  { key: 'review',      label: 'Your approval',     group: 'approval' },
  { key: 'deliver',     label: 'Final GREEN & deliver', group: 'report' },
  { key: 'report',      label: 'Report',            group: 'report' },
];

const MAX_DIFF_LINES = 3000; // display limit; fix.patch on disk is always complete
const WEAK_JS = /\.(toBeTruthy|toBeFalsy|toBeDefined)\s*\(|expect\.anything\s*\(|\b(test|it|describe)\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(/;
const WEAK_PY = /\bassert\s+True\b|pytest\.skip\s*\(|@pytest\.mark\.skip/;

const pipelineTimeout = () => Number(process.env.PIPELINE_TIMEOUT_MS || 600000);
const now = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

class Run extends EventEmitter {
  constructor(opts, existingState) {
    super();
    this.setMaxListeners(50);
    this.logs = [];
    this._decision = null;
    this.providers = opts.providers || [];
    if (existingState) {
      this.state = existingState;
      this.id = existingState.id;
    } else {
      this.id = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12) + '-' + crypto.randomBytes(2).toString('hex');
      const o = opts.options || {};
      this.state = {
        id: this.id,
        createdAt: now(), updatedAt: now(), finishedAt: null,
        status: 'running', stage: 'acquire',
        source: { type: opts.source.type, label: '…', detail: '' },
        sourceSpec: safeSourceSpec(opts.source),
        bugReport: String(opts.bugReport || '').trim(),
        rules: String(opts.rules || '').trim(),
        options: {
          agents: this.providers.map(p => p.id), mode: o.mode === 'multi' ? 'multi' : 'single',
          autoApprove: !!o.autoApprove, includeTests: o.includeTests !== false,
          writeBack: !!o.writeBack, installDeps: o.installDeps !== false,
        },
        agent: this.providers[0] ? { id: this.providers[0].id, name: this.providers[0].name } : null,
        stages: Object.fromEntries(STAGES.map(s => [s.key, { status: 'pending', startedAt: null, endedAt: null, note: '' }])),
        working: null, lastActivity: '',
        project: null, candidates: [], localization: null, investigations: [],
        tests: null, red: null, fix: null, diff: null, diffMeta: null, candidateHash: null,
        green: null, finalGreen: null, approval: null, writeBack: null,
        aiCalls: [], bobCallCount: 0, attempts: { investigate: 0, repair: 0 },
        integrations: { jira: null, slack: null, teams: null },
        artifacts: {}, error: null, errorType: null, failedStage: null, bobDebug: null,
        timedOutAt: null, cancelledAt: null, interruptedAt: null, dismissed: false,
      };
    }
    this.dir = ws.ensureDir(path.join(RUNS_DIR, this.id));
    this.baseDir = path.join(this.dir, 'workspace');   // original code + locked tests (RED)
    this.candDir = path.join(this.dir, 'candidate');   // candidate fix + same tests (GREEN)
    this._save();
  }

  // ── events, persistence, logging ──────────────────────────────────────────
  log(agent, text, level = 'info', role = 'system') {
    const entry = { t: Date.now(), agent, role, text: redact(String(text)), level };
    this.logs.push(entry);
    if (this.logs.length > 800) this.logs.shift();
    this.state.lastActivity = entry.text.slice(0, 200);
    try { fs.appendFileSync(path.join(this.dir, 'log.jsonl'), JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
    this.emit('log', entry);
    this._save();
  }

  _save() {
    this.state.updatedAt = now();
    try { fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2)); } catch { /* disk issue */ }
    this.emit('state', this.state);
  }

  _stage(key, status, note) {
    const st = this.state.stages[key];
    if (status === 'active') { st.startedAt = Date.now(); st.endedAt = null; this.state.stage = key; }
    if (['done', 'failed', 'skipped'].includes(status)) st.endedAt = Date.now();
    st.status = status;
    if (note !== undefined) st.note = note;
    this._save();
  }

  _working(label, role) {
    this.state.working = label ? { label, role, since: Date.now() } : null;
    this._save();
  }

  // ── cancellation & timeouts ───────────────────────────────────────────────
  _newController() {
    this.controller = new AbortController();
    this._abortReason = null;
    this._budgetLeft = pipelineTimeout();
    this._resumeBudget();
  }

  _resumeBudget() {
    clearTimeout(this._budgetTimer);
    this._budgetStart = Date.now();
    this._budgetTimer = setTimeout(() => {
      this._abortReason = 'timeout';
      this.controller.abort();
    }, Math.max(1, this._budgetLeft));
    if (this._budgetTimer.unref) this._budgetTimer.unref();
  }

  _pauseBudget() {
    clearTimeout(this._budgetTimer);
    this._budgetLeft -= Date.now() - this._budgetStart;
  }

  get signal() { return this.controller.signal; }

  /** Throws if the run was cancelled or ran out of time. Called between stages. */
  _check() {
    if (!this.controller.signal.aborted) return;
    if (this._abortReason === 'timeout') {
      throw new RunError('timeout', `Run exceeded the ${Math.round(pipelineTimeout() / 1000)}-second time limit.`, { failedStage: this.state.stage });
    }
    throw new RunError('cancelled', 'Run cancelled by user.', { failedStage: this.state.stage });
  }

  /** Stop Run. Kills the current child process; later stages never start. */
  cancel(by = 'user') {
    if (!ACTIVE.has(this.state.status)) throw new Error('This run is not active.');
    this.state.cancelRequested = true;
    this.log('system', `Stop requested by ${by}.`, 'warn');
    this._abortReason = 'cancelled';
    if (this._decision) { const r = this._decision; this._decision = null; r({ decision: 'cancelled', by }); }
    if (this.controller) this.controller.abort();
  }

  // ── terminal handling ─────────────────────────────────────────────────────
  _finish(status, err) {
    clearTimeout(this._budgetTimer);
    const s = this.state;
    s.status = status;
    s.working = null;
    s.finishedAt = now();
    if (err) {
      s.error = redact(err.message || String(err));
      s.errorType = err.type || 'internal';
      s.failedStage = err.failedStage || s.stage;
      if (err.bobDebug) s.bobDebug = err.bobDebug;
      if (status === 'timed-out') s.timedOutAt = s.finishedAt;
      if (status === 'cancelled') s.cancelledAt = s.finishedAt;
    }
    for (const st of Object.values(s.stages)) {
      if (st.status === 'active') { st.status = 'failed'; st.note = status === 'cancelled' ? 'cancelled' : status === 'timed-out' ? 'timed out' : (st.note || 'failed'); st.endedAt = Date.now(); }
    }
    this._writeReport();
    this._save();
    this.emit('end', s);
  }

  _fail(err) {
    // Map abort-caused errors to the real reason (timeout vs cancel)
    if (this.controller && this.controller.signal.aborted && !(err instanceof RunError && ['timeout', 'cancelled'].includes(err.type))) {
      err = this._abortReason === 'timeout'
        ? new RunError('timeout', `Run exceeded the ${Math.round(pipelineTimeout() / 1000)}-second time limit.`, { failedStage: this.state.stage })
        : new RunError('cancelled', 'Run cancelled by user.', { failedStage: this.state.stage });
    }
    if (err instanceof RunError && err.type === 'cancelled' && this._abortReason === 'timeout') {
      err = new RunError('timeout', `Run exceeded the ${Math.round(pipelineTimeout() / 1000)}-second time limit.`, { failedStage: this.state.stage });
    }
    if (!(err instanceof RunError)) err = new RunError('internal', err.message || String(err), { failedStage: this.state.stage });
    if (!err.failedStage) err.failedStage = this.state.stage;
    const status = statusForError(err.type);
    this.log('system', status === 'cancelled' ? 'Run cancelled.' : status === 'timed-out' ? `Run timed out: ${err.message}` : err.message, 'error');
    this._finish(status, err);
  }

  _writeReport() {
    try {
      const st = this.state.stages.report;
      st.status = 'active'; st.startedAt = Date.now();
      const { mdPath, jsonPath } = report.writeReport(this.state, this.dir);
      this.state.artifacts.reportMd = path.relative(ROOT, mdPath);
      this.state.artifacts.reportJson = path.relative(ROOT, jsonPath);
      st.status = 'done'; st.endedAt = Date.now(); st.note = 'Markdown + JSON';
    } catch (err) {
      this.state.stages.report.status = 'failed';
      this.state.stages.report.note = err.message;
    }
  }

  /** Re-write the report (e.g. after an integration delivery). */
  refreshReport() {
    this._writeReport();
    this._save();
  }

  // ── human decision ────────────────────────────────────────────────────────
  decide(decision, by = 'web reviewer', extra = {}) {
    if (this.state.status !== 'awaiting-approval' || !this._decision) {
      throw new Error('This run is not waiting for approval.');
    }
    const resolve = this._decision;
    this._decision = null;
    resolve({ decision, by, ...extra });
  }

  // ── main flow ─────────────────────────────────────────────────────────────
  async start() {
    this._newController();
    try {
      await this._acquire();       this._check();
      await this._index();         this._check();
      await this._investigate();   this._check();
      const reproduced = await this._reproduce();
      if (!reproduced) return;
      this._check();
      const verified = await this._repairAndVerify();
      if (!verified) return;
      this._check();
      await this._review();
    } catch (err) {
      this._fail(err);
    }
  }

  /** Explicit user action only: one more Repairer call on the same locked tests. */
  async retryFix() {
    const s = this.state;
    if (!(s.status === 'repair-not-verified' || (['failed', 'timed-out', 'cancelled'].includes(s.status) && s.tests && s.red && s.red.outcome === 'fail'))) {
      throw new Error('Retry Fix is only available after the bug was reproduced and the repair did not succeed.');
    }
    Object.assign(s, { status: 'running', error: null, errorType: null, failedStage: null, bobDebug: null, finishedAt: null,
      timedOutAt: null, cancelledAt: null, cancelRequested: false, fix: null, diff: null, diffMeta: null, green: null, candidateHash: null });
    for (const k of ['repair', 'verify', 'review', 'deliver', 'report']) Object.assign(s.stages[k], { status: 'pending', startedAt: null, endedAt: null, note: '' });
    this.log('system', 'Retry Fix requested by user: one more Repairer call on the same locked tests.');
    this._newController();
    try {
      if (!this.project) this._rebuildContext();
      const verified = await this._repairAndVerify();
      if (!verified) return;
      this._check();
      await this._review();
    } catch (err) {
      this._fail(err);
    }
  }

  async _acquire() {
    this._stage('acquire', 'active');
    if (this.state.source.type === 'demo') {
      demo.resetWorkspace();
      this.log('system', 'Controlled demo workspace reset to the known buggy baseline.');
    }
    const info = await sources.acquire(this.state.sourceSpec.type === 'zip'
      ? { type: 'zip', uploadId: this.state.sourceSpec.uploadId }
      : this.state.sourceSpec, this.baseDir, t => this.log('system', t), this.signal).catch(err => {
      if (err instanceof RunError) throw err;
      throw new RunError('source', err.message, { failedStage: 'acquire' });
    });
    this.state.source = { type: this.state.sourceSpec.type, label: info.label, detail: info.detail || '' };
    this._localPath = info.localPath || null;
    const count = ws.listFiles(this.baseDir).length;
    this._stage('acquire', 'done', `${count} files`);
    this.log('system', `Workspace ready: ${count} files copied. Your original code is untouched.`);
  }

  _rebuildContext() {
    const project = ws.detectProject(this.baseDir);
    this.project = project;
    this.context = ws.buildContext(this.baseDir, this.state.bugReport + '\n' + this.state.rules, { project });
    if (this.state.source.type === 'local') this._localPath = this.state.sourceSpec.path ? path.resolve(this.state.sourceSpec.path) : null;
  }

  async _index() {
    this._stage('index', 'active');
    const project = ws.detectProject(this.baseDir);
    if (!project.language) throw new RunError('source', 'No source files found. BugRep supports JavaScript and Python projects.', { failedStage: 'index' });
    if (!['javascript', 'python'].includes(project.language)) {
      throw new RunError('source', `Detected a ${project.language} project. BugRep can currently run tests for JavaScript and Python projects.`, { failedStage: 'index' });
    }
    this.project = project;
    this.context = ws.buildContext(this.baseDir, this.state.bugReport + '\n' + this.state.rules, { project });
    if (project.language === 'javascript' && project.needsInstall && this.state.options.installDeps) {
      const ext = ws.externalImports(this.context.candidates);
      if (ext.length) {
        this.log('system', `Relevant code uses ${ext.slice(0, 4).join(', ')}${ext.length > 4 ? '…' : ''}. Installing dependencies…`);
        await runner.installDeps(this.baseDir, t => this.log('system', t), { signal: this.signal });
      } else {
        this.log('system', 'Skipping npm install: the relevant files only use local code.');
      }
    }
    this.state.project = { language: project.language, moduleType: project.moduleType, files: project.fileCount };
    this.state.candidates = this.context.candidates.map(c => ({ path: c.path, score: c.score }));
    this._stage('index', 'done', `${project.language} · ${this.context.candidates.length} key files`);
    this.log('system', `Detected ${project.language}${project.language === 'javascript' ? ' (' + project.moduleType + ')' : ''}. ` +
      `Most relevant: ${this.context.candidates.slice(0, 3).map(c => c.path).join(', ') || 'n/a'}.`);
  }

  _contextFiles() {
    return [...this.context.candidates.map(c => c.path), ...this.context.docs.map(d => d.path)];
  }

  async _agentCall(provider, role, fn) {
    const label = `${provider.name} ${role === 'investigate' ? 'Investigator' : 'Repairer'}`;
    this.state.attempts[role]++;
    const call = { agent: label, provider: provider.id, role, attempt: this.state.attempts[role], startedAt: now(), ms: 0, ok: false, error: null };
    this.state.aiCalls.push(call);
    if (provider.id === 'bob') this.state.bobCallCount++;
    this._working(label, role === 'investigate' ? 'investigator' : 'repairer');
    const t0 = Date.now();
    try {
      const res = await fn(t => this.log(label, t, 'info', role === 'investigate' ? 'investigator' : 'repairer'));
      call.ms = Date.now() - t0; call.ok = true;
      return res.payload;
    } catch (err) {
      call.ms = Date.now() - t0; call.error = redact(err.message).slice(0, 300);
      throw err;
    } finally {
      this._working(null);
    }
  }

  async _investigate() {
    const testPath = runner.testFileFor(this.project.language, this.project.moduleType);
    this._stage('investigate', 'active');
    const input = {
      workspace: this.baseDir, bugReport: this.state.bugReport, rules: this.state.rules, targetHint: this.context.candidates[0]?.path,
      context: this.context, project: this.project, testPath, files: this._contextFiles(), runDir: this.dir, signal: this.signal,
    };
    // Single-agent: one call. Multi-agent (future): every selected operational provider investigates
    // independently; findings are recorded for comparison and the primary provider's tests are used.
    const settled = await Promise.allSettled(this.providers.map(p =>
      this._agentCall(p, 'investigate', log => p.investigate({ ...input, log })).then(payload => ({ provider: p, payload }))));
    const primary = settled[0];
    if (primary.status === 'rejected') throw primary.reason;
    this.state.investigations = settled.map((r, i) => r.status === 'fulfilled'
      ? { provider: this.providers[i].id, file: r.value.payload.localizedFile, function: r.value.payload.localizedFunction, ok: true }
      : { provider: this.providers[i].id, ok: false, error: redact(r.reason.message).slice(0, 200) });

    const ans = primary.value.payload;
    const testCode = String(ans.testCode || '').replace(/^```\w*\n|```\s*$/g, '');
    if (!testCode.trim()) throw new RunError('ai-response', 'The Investigator returned empty test code.', { failedStage: 'investigate' });
    const weak = (this.project.language === 'python' ? WEAK_PY : WEAK_JS).exec(testCode);
    if (weak) {
      throw new RunError('invalid-tests', `The Investigator used a weak or skipped assertion ("${weak[0]}"). Strict assertions are required, so the tests were rejected.`, { failedStage: 'investigate' });
    }
    this.state.localization = {
      file: ans.localizedFile || 'unknown', function: ans.localizedFunction || 'unknown',
      confidence: ans.confidence || 'medium', analysis: ans.analysis || '',
    };
    this._writeTests(testPath, testCode);
    this.state.tests = { path: testPath, code: testCode, hash: ws.sha256File(path.join(this.baseDir, testPath)),
      list: Array.isArray(ans.tests) ? ans.tests.slice(0, 20) : [] };
    this._stage('investigate', 'done', `${this.state.localization.function} in ${this.state.localization.file}`);
    this.log('system', `Suspect: ${this.state.localization.function}() in ${this.state.localization.file}.`);
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

  async _reproduce() {
    this._stage('reproduce', 'active');
    this._working('Test runner (RED)', 'runner');
    this.log('Runner', `Running ${this.state.tests.path} against the ORIGINAL code…`, 'info', 'runner');
    const red = await runner.runTests(this.baseDir, this.state.tests.path, this.project, { signal: this.signal, stage: 'reproduce' });
    this._working(null);
    this.state.red = red;
    this._save();

    if (red.outcome === 'error') {
      const detail = (red.output || red.tests.filter(t => t.status === 'failed').map(t => `${t.name}: ${t.message}`).join('\n')).split('\n')[0];
      if (red.launchError) throw new RunError('environment', `Test environment could not start: ${detail}`, { failedStage: 'reproduce' });
      throw new RunError('invalid-tests', `The Investigator's tests could not run (${red.total} executed): ${detail}`, { failedStage: 'reproduce' });
    }
    if (red.outcome === 'pass') {
      this._stage('reproduce', 'done', `0 of ${red.total} failed`);
      this.log('Runner', `All ${red.total} tests ran and passed on the original code, so the bug was NOT reproduced.`, 'warn', 'runner');
      for (const k of ['repair', 'verify', 'review', 'deliver']) this.state.stages[k].status = 'skipped';
      this._finish('not-reproduced');
      return false;
    }
    this._stage('reproduce', 'done', `${red.failed} of ${red.total} failed`);
    this.log('Runner', `🔴 Bug reproduced: ${red.failed} of ${red.total} tests fail on the original code. Suite locked (${this.state.tests.hash.slice(0, 12)}…).`, 'info', 'runner');
    return true;
  }

  async _repairAndVerify() {
    const s = this.state;
    const failures = s.red.tests.filter(t => t.status === 'failed').map(t => `✗ ${t.name}\n  ${t.message.split('\n').slice(0, 4).join('\n  ')}`).join('\n');
    this._stage('repair', 'active');
    const input = {
      workspace: this.baseDir, localizedFile: s.localization.file, localization: s.localization, bugReport: s.bugReport,
      rules: s.rules, redEvidence: failures, lockedTest: s.tests.code, context: this.context, project: this.project,
      files: [...this._contextFiles(), s.tests.path], runDir: this.dir, signal: this.signal,
    };
    // Every selected provider proposes a candidate independently (single mode = one call).
    const settled = await Promise.allSettled(this.providers.map(p =>
      this._agentCall(p, 'repair', log => p.repair({ ...input, log })).then(payload => ({ provider: p, payload }))));
    if (settled.every(r => r.status === 'rejected')) throw settled[0].reason;
    this._check();

    // The deterministic test runner decides which candidate (if any) fixes the regression.
    let last = null;
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      const { provider, payload } = r.value;
      fs.rmSync(this.candDir, { recursive: true, force: true });
      ws.copyTree(this.baseDir, this.candDir);
      ws.linkNodeModules(this.baseDir, this.candDir);
      const changed = this._applyCandidate(payload);
      if (!changed.length) { last = { provider, payload, changed, noFiles: true }; continue; }
      if (ws.sha256File(path.join(this.candDir, s.tests.path)) !== s.tests.hash) {
        throw new RunError('integrity', 'The regression suite changed while staging the candidate. Run aborted.', { failedStage: 'repair' });
      }
      s.fix = { provider: provider.id, rootCause: payload.rootCause || '', summary: payload.fixSummary || payload.summary || '', files: changed };
      this._setDiff(changed.map(c => c.path));
      s.candidateHash = this._candidateHash(changed.map(c => c.path));
      this._stage('repair', 'done', changed.map(c => c.path).join(', '));
      this.log('system', `Candidate from ${provider.name} staged: ${changed.map(c => c.path).join(', ')}.`);

      this._stage('verify', 'active');
      this._working('Test runner (GREEN)', 'runner');
      this.log('Runner', 'Running the SAME locked tests against the candidate…', 'info', 'runner');
      const green = await runner.runTests(this.candDir, s.tests.path, this.project, { signal: this.signal, stage: 'verify' });
      this._working(null);
      s.green = green;
      this._save();
      if (green.outcome === 'pass') {
        this._stage('verify', 'done', `${green.passed} of ${green.total} pass`);
        this.log('Runner', `🟢 Verified: all ${green.total} locked tests pass on the candidate.`, 'info', 'runner');
        return true;
      }
      last = { provider, payload, changed, green };
    }

    if (last && last.noFiles) {
      throw new RunError('ai-response', 'The Repairer did not return any valid source-file change.', { failedStage: 'repair' });
    }
    const g = s.green;
    this._stage('verify', 'failed', g ? `${g.failed} still failing` : 'not verified');
    this.log('Runner', `Repair NOT verified: ${g ? `${g.failed} of ${g.total} locked tests still fail` : 'the candidate could not be tested'}. Nothing was applied.`, 'warn', 'runner');
    for (const k of ['review', 'deliver']) s.stages[k].status = 'skipped';
    this._finish('repair-not-verified', new RunError('repair-not-verified',
      'The candidate repair did not make every locked regression test pass. No changes were applied. You can Retry Fix.', { failedStage: 'verify' }));
    return false;
  }

  /** Stage the AI's candidate inside the sandbox copy. Paths are validated; tests are protected. */
  _applyCandidate(payload) {
    const files = [];
    if (typeof payload.fixedCode === 'string') files.push({ path: this.state.localization.file, content: payload.fixedCode });
    if (Array.isArray(payload.files)) files.push(...payload.files.slice(0, 8));
    const changed = [];
    const seen = new Set();
    for (const f of files) {
      const rel = String(f.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (seen.has(rel)) continue;
      seen.add(rel);
      const abs = ws.safeJoin(this.candDir, rel);
      if (!abs) { this.log('system', `Rejected unsafe path from the Repairer: "${redact(f.path)}"`, 'warn'); continue; }
      if (rel.startsWith('__bugrep__') || ws.isTestPath(rel) || /(^|\/)node_modules\//.test(rel) || /(^|\/)\.env/.test(rel)) {
        this.log('system', `Blocked the Repairer from modifying protected file ${rel}`, 'warn');
        continue;
      }
      if (typeof f.content !== 'string' || !f.content.trim()) continue;
      const content = f.content.replace(/^```\w*\n|```\s*$/g, '');
      const beforeAbs = path.join(this.baseDir, rel);
      const before = fs.existsSync(beforeAbs) ? fs.readFileSync(beforeAbs, 'utf8') : '';
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

  _candidateHash(paths) {
    return sha(paths.sort().map(p => p + '\0' + fs.readFileSync(path.join(this.candDir, p), 'utf8')).join('\0'));
  }

  _setDiff(paths) {
    const full = paths.map(rel => {
      const a = path.join(this.baseDir, rel);
      const before = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : '';
      const after = fs.readFileSync(path.join(this.candDir, rel), 'utf8');
      return Diff.createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, '', '', { context: 3 });
    }).join('\n');
    fs.writeFileSync(path.join(this.dir, 'fix.patch'), full);
    const lines = full.split('\n');
    if (lines.length > MAX_DIFF_LINES) {
      console.warn(`[bugrep] run ${this.id}: diff has ${lines.length} lines; showing the first ${MAX_DIFF_LINES}. Full patch: runs/${this.id}/fix.patch`);
      this.state.diff = lines.slice(0, MAX_DIFF_LINES).join('\n');
      this.state.diffMeta = { truncated: true, totalLines: lines.length, shownLines: MAX_DIFF_LINES, note: 'Displayed diff is truncated. fix.patch contains the complete diff.' };
    } else {
      this.state.diff = full;
      this.state.diffMeta = { truncated: false, totalLines: lines.length, shownLines: lines.length };
    }
  }

  async _review() {
    const s = this.state;
    this._stage('review', 'active', s.options.autoApprove ? 'auto-approve' : 'waiting for you');
    let decision;
    if (s.options.autoApprove) {
      decision = { decision: 'approved', by: 'auto-approve setting' };
      this.log('system', 'Auto-approve is on: applying the verified candidate.');
    } else {
      s.status = 'awaiting-approval';
      this._pauseBudget();
      this._save();
      this.log('system', 'Repair verified. Review the diff, then approve or reject.');
      decision = await new Promise(resolve => { this._decision = resolve; });
      if (decision.decision === 'cancelled') this._check();
      s.status = 'running';
      this._resumeBudget();
    }
    s.approval = { decision: decision.decision, by: decision.by, at: now() };
    if (typeof decision.writeBack === 'boolean') s.options.writeBack = decision.writeBack;
    if (typeof decision.includeTests === 'boolean') s.options.includeTests = decision.includeTests;

    if (decision.decision !== 'approved') {
      this._stage('review', 'done', 'rejected');
      s.stages.deliver.status = 'skipped';
      this.log('system', 'Repair rejected: nothing was changed.');
      this._finish('rejected');
      return;
    }
    this._stage('review', 'done', 'approved');
    this._check();
    await this._deliver();
    this._finish('completed');
  }

  async _deliver() {
    const s = this.state;
    this._stage('deliver', 'active');
    // Approval applies EXACTLY the verified candidate: re-check both fingerprints.
    if (ws.sha256File(path.join(this.candDir, s.tests.path)) !== s.tests.hash) {
      throw new RunError('integrity', 'The locked regression suite changed after verification.', { failedStage: 'deliver' });
    }
    if (this._candidateHash(s.fix.files.map(f => f.path)) !== s.candidateHash) {
      throw new RunError('integrity', 'The candidate changed after verification. Nothing was applied.', { failedStage: 'deliver' });
    }
    // Final GREEN on the exact candidate that will be delivered.
    this._working('Test runner (final GREEN)', 'runner');
    const finalGreen = await runner.runTests(this.candDir, s.tests.path, this.project, { signal: this.signal, stage: 'deliver' });
    this._working(null);
    s.finalGreen = finalGreen;
    if (finalGreen.outcome !== 'pass') {
      throw new RunError('integrity', `Final GREEN failed (${finalGreen.failed} failing). Nothing was applied.`, { failedStage: 'deliver' });
    }
    this.log('Runner', `Final GREEN: ${finalGreen.passed}/${finalGreen.total} pass on the exact approved candidate.`, 'info', 'runner');
    this._check();

    const zipPath = path.join(this.dir, 'fixed-code.zip');
    ws.zipWorkspace(this.candDir, zipPath, { includeTests: s.options.includeTests });
    const testsOut = path.join(this.dir, path.basename(s.tests.path));
    fs.copyFileSync(path.join(this.candDir, s.tests.path), testsOut);
    s.artifacts = { ...s.artifacts, fixedZip: path.relative(ROOT, zipPath), patch: path.relative(ROOT, path.join(this.dir, 'fix.patch')), tests: path.relative(ROOT, testsOut) };

    if (s.options.writeBack && s.source.type === 'local' && this._localPath) {
      const written = [];
      const backup = path.join(this.dir, 'backup');
      for (const f of s.fix.files) {
        const dest = ws.safeJoin(this._localPath, f.path);
        if (!dest) continue;
        if (fs.existsSync(dest)) { ws.ensureDir(path.dirname(path.join(backup, f.path))); fs.copyFileSync(dest, path.join(backup, f.path)); }
        ws.ensureDir(path.dirname(dest));
        fs.copyFileSync(path.join(this.candDir, f.path), dest);
        written.push(f.path);
      }
      if (s.options.includeTests) {
        const dest = path.join(this._localPath, s.tests.path);
        ws.ensureDir(path.dirname(dest));
        fs.copyFileSync(path.join(this.candDir, s.tests.path), dest);
        written.push(s.tests.path);
      }
      s.writeBack = { folder: this._localPath, files: written };
      this.log('system', `Wrote ${written.length} file(s) back to ${this._localPath}. Originals backed up in runs/${this.id}/backup.`);
    }
    this._stage('deliver', 'done', s.writeBack ? 'written to folder + ZIP' : 'ZIP + patch ready');
    this.log('system', '✅ Verified repair delivered: download the fixed code, patch or report.');
  }
}

function safeSourceSpec(src) {
  const t = src.type;
  if (t === 'local') return { type: t, path: String(src.path || '') };
  if (t === 'github') return { type: t, url: String(src.url || ''), ref: src.ref ? String(src.ref) : undefined };
  if (t === 'zip') return { type: t, uploadId: src.uploadId ? String(src.uploadId) : undefined, zipFile: src.zipFile };
  return { type: t };
}

// ── registry ─────────────────────────────────────────────────────────────────
const active = new Map();

function track(run) {
  active.set(run.id, run);
  run.on('end', () => {
    const t = setTimeout(() => { if (active.get(run.id) === run && !ACTIVE.has(run.state.status)) active.delete(run.id); }, 30 * 60 * 1000);
    if (t.unref) t.unref();
  });
}

/** Validate inputs and agents, then create (but do not start) a run. */
async function createRun(opts) {
  if (!opts || !opts.source || !opts.source.type) throw new RunError('source', 'A code source is required.');
  if (!['local', 'github', 'zip', 'demo'].includes(opts.source.type)) throw new RunError('source', `Unknown source "${opts.source.type}".`);
  let bugReport = String(opts.bugReport || '').trim();
  if (opts.source.type === 'demo' && !bugReport) bugReport = demo.bugReport();
  if (!bugReport) throw new RunError('source', 'Please describe the bug.');
  const src = opts.source;
  if (src.type === 'github') sources.parseGithubUrl(src.url);
  if (src.type === 'local') {
    const p = path.resolve(String(src.path || '').trim() || sources.defaultLocalPath());
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new RunError('source', `Folder not found: ${p}`);
    src.path = p;
  }
  const o = opts.options || {};
  // The live demo always uses IBM Bob.
  const agentIds = src.type === 'demo' ? ['bob'] : (o.agents || (o.engine && o.engine !== 'auto' ? [o.engine] : ['bob']));
  const providers = await agents.resolveAgents(agentIds, o.mode === 'multi' ? 'multi' : 'single');
  const run = new Run({ ...opts, bugReport, source: src, providers });
  track(run);
  return run;
}

function getRun(id) {
  return active.get(String(id)) || null;
}

/** Bring a finished run back into memory (e.g. for Retry Fix after a server restart). */
function reviveRun(id) {
  const live = getRun(id);
  if (live) return live;
  const s = loadState(id);
  if (!s) return null;
  const providers = (s.options.agents || ['bob']).map(a => { try { return agents.getProvider(a); } catch { return null; } }).filter(Boolean);
  const run = new Run({ providers }, s);
  track(run);
  return run;
}

function loadState(id) {
  const safe = String(id).replace(/[^a-z0-9-]/gi, '');
  const live = active.get(safe);
  if (live) return live.state;
  const file = path.join(RUNS_DIR, safe, 'state.json');
  if (!fs.existsSync(file)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s.status === 'done') s.status = 'completed'; // runs saved by v3
    return s;
  } catch {
    return null;
  }
}

/**
 * At startup: any run still marked active but not owned by this process is marked interrupted.
 * Never retries anything automatically.
 */
function recoverStaleRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const fixed = [];
  for (const d of fs.readdirSync(RUNS_DIR)) {
    if (d.startsWith('_') || active.has(d)) continue;
    const file = path.join(RUNS_DIR, d, 'state.json');
    if (!fs.existsSync(file)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!ACTIVE.has(s.status)) continue;
    const at = now();
    s.failedStage = s.stage || null;
    s.status = 'interrupted';
    s.errorType = 'interrupted';
    s.error = 'Run was interrupted before completion.';
    s.interruptedAt = at;
    s.finishedAt = at;
    s.working = null;
    for (const st of Object.values(s.stages || {})) if (st.status === 'active') { st.status = 'failed'; st.endedAt = Date.now(); }
    try {
      report.writeReport(s, path.join(RUNS_DIR, d));
    } catch { /* report is best effort */ }
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
    fixed.push(d);
  }
  return fixed;
}

function loadLogs(id) {
  try {
    return fs.readFileSync(path.join(runDir(id), 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

function summarize(s) {
  const end = s.finishedAt ? new Date(s.finishedAt) : new Date();
  return {
    id: s.id, createdAt: s.createdAt, finishedAt: s.finishedAt, status: s.status, stage: s.stage,
    source: s.source, agent: s.agent, bug: String(s.bugReport || '').slice(0, 140),
    elapsedMs: Math.max(0, end - new Date(s.createdAt)), red: s.red ? s.red.failed : null,
    green: s.green ? `${s.green.passed}/${s.green.total}` : null, error: s.error, errorType: s.errorType,
    dismissed: !!s.dismissed, hasReport: !!(s.artifacts && s.artifacts.reportMd),
    canRetryFix: s.status === 'repair-not-verified' || (['failed', 'timed-out', 'cancelled'].includes(s.status) && !!(s.red && s.red.outcome === 'fail' && s.tests)),
  };
}

function listRuns({ limit = 50, includeDismissed = false } = {}) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR).filter(d => !d.startsWith('_')).sort().reverse()
    .map(loadState).filter(Boolean)
    .filter(s => includeDismissed || !s.dismissed)
    .slice(0, limit).map(summarize);
}

function runDir(id) {
  return path.join(RUNS_DIR, String(id).replace(/[^a-z0-9-]/gi, ''));
}

function deleteRun(id) {
  const s = loadState(id);
  if (!s) throw new RunError('source', 'Run not found');
  if (ACTIVE.has(s.status)) throw new RunError('source', 'Stop the run before deleting it.');
  active.delete(s.id);
  fs.rmSync(runDir(s.id), { recursive: true, force: true });
}

function dismissRun(id) {
  const run = reviveRun(id);
  if (!run) throw new RunError('source', 'Run not found');
  run.state.dismissed = true;
  run._save();
}

module.exports = {
  createRun, getRun, reviveRun, loadState, loadLogs, listRuns, runDir, deleteRun, dismissRun,
  recoverStaleRuns, STAGES, TERMINAL, ACTIVE, MAX_DIFF_LINES,
};
