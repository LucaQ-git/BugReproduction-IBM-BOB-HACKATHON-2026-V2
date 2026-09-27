// web/server.js — BugRep-AI web backend.
//
//   npm start / npm run web  → http://localhost:3000
//
// Binds to 127.0.0.1 by default: the "IDE workspace" source can read folders on this
// machine. No endpoint ever returns API keys, tokens or webhook URLs.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs       = require('fs');
const express  = require('express');
const pipeline = require('../workflow/pipeline');
const sources  = require('../workflow/sources');
const demo     = require('../workflow/demo');
const agents   = require('../agents');
const bob      = require('../agents/bob');
const integrations = require('../integrations');
const { ACTIVE } = require('../workflow/errors');
const { redact } = require('../workflow/redact');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  const fail = (res, status, err) => res.status(status).json({
    error: redact(typeof err === 'string' ? err : err.message), errorType: err && err.type ? err.type : undefined,
  });
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => fail(res, err.http || 400, err));

  // ── health / agents / integrations ─────────────────────────────────────────
  app.get('/api/health', wrap(async (req, res) => {
    const b = await bob.getStatus(); // cached 30 s: repeated polling never spawns Bob each time
    const wx = await agents.getProvider('watsonx').getStatus();
    res.json({
      ok: true,
      bob: b.operational ? 'ready' : 'unavailable',
      engines: {
        bob: { ready: b.operational, detail: b.operational ? (b.version || 'Connected') : b.detail },
        watsonx: { ready: wx.operational, detail: wx.detail },
      },
      integrations: integrations.status(),
      defaultLocalPath: sources.defaultLocalPath(),
    });
  }));

  app.get('/api/agents', wrap(async (req, res) => res.json(await agents.listAgents())));
  app.get('/api/integrations/status', (req, res) => res.json(integrations.status()));

  // ── demo ───────────────────────────────────────────────────────────────────
  app.get(['/api/demo', '/api/demo-bug'], (req, res) => res.json({ bugReport: demo.bugReport(), rules: '' }));
  app.get('/api/demo/preflight', wrap(async (req, res) => res.json(await demo.preflight())));
  app.post('/api/demo/reset', wrap(async (req, res) => {
    const cancelled = [];
    for (const r of pipeline.listRuns({ includeDismissed: true })) {
      if (r.source && r.source.type === 'demo' && ACTIVE.has(r.status)) {
        const live = pipeline.getRun(r.id);
        if (live) { live.cancel('demo reset'); cancelled.push(r.id); }
      }
    }
    demo.resetWorkspace();
    res.json({ ok: true, cancelled, message: 'Demo workspace restored to the known buggy baseline. Historical reports were kept.' });
  }));

  // ── uploads ────────────────────────────────────────────────────────────────
  app.post('/api/uploads', express.raw({ type: () => true, limit: '60mb' }), (req, res) => {
    try {
      const name = decodeURIComponent(String(req.headers['x-file-name'] || 'upload.zip')).slice(0, 200);
      const id = sources.saveUpload(req.body, name);
      res.json({ uploadId: id, name, bytes: req.body.length });
    } catch (err) {
      fail(res, 400, err);
    }
  });

  // ── runs ───────────────────────────────────────────────────────────────────
  app.post('/api/runs', wrap(async (req, res) => {
    const { source, bugReport, rules, options } = req.body || {};
    const run = await pipeline.createRun({ source, bugReport, rules, options });
    res.status(202).json({ id: run.id, runId: run.id, stage: run.state.stage, status: run.state.status });
    run.start();
  }));

  app.get('/api/runs', (req, res) => res.json(pipeline.listRuns({ includeDismissed: req.query.all === '1' })));

  app.get('/api/runs/:id', (req, res) => {
    const s = pipeline.loadState(req.params.id);
    if (!s) return fail(res, 404, 'Run not found');
    res.json(s);
  });

  app.delete('/api/runs/:id', wrap(async (req, res) => {
    pipeline.deleteRun(req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/runs/:id/dismiss', wrap(async (req, res) => {
    pipeline.dismissRun(req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/runs/:id/cancel', wrap(async (req, res) => {
    const run = pipeline.getRun(req.params.id);
    const s = pipeline.loadState(req.params.id);
    if (!s) return fail(res, 404, 'Run not found');
    if (!run || !ACTIVE.has(run.state.status)) return fail(res, 409, 'This run is not active.');
    run.cancel('web user');
    res.json({ ok: true, status: 'cancelling' });
  }));

  // Server-Sent Events: live stage updates + activity log
  app.get('/api/runs/:id/events', (req, res) => {
    const run = pipeline.getRun(req.params.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const logs = run ? run.logs : pipeline.loadLogs(req.params.id);
    const state = run ? run.state : pipeline.loadState(req.params.id);
    if (state) send('state', state);
    for (const l of logs) send('log', l);
    if (!run || !ACTIVE.has(run.state.status)) {
      // Finished runs: stream once. If revived later (Retry Fix) the client reconnects.
      send('end', state || {});
      if (!run) return res.end();
    }
    const onLog = l => send('log', l);
    const onState = s => send('state', s);
    const onEnd = s => { send('state', s); send('end', s); };
    run.on('log', onLog); run.on('state', onState); run.on('end', onEnd);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); run.off('log', onLog); run.off('state', onState); run.off('end', onEnd); });
  });

  // Approval (new style + legacy endpoints)
  const decide = (decision) => wrap(async (req, res) => {
    const run = pipeline.getRun(req.params.id);
    if (!run) return fail(res, 404, 'Run is no longer active.');
    const d = decision || (req.body && req.body.decision === 'approved' ? 'approved' : 'rejected');
    try {
      run.decide(d, 'web reviewer', { writeBack: req.body && req.body.writeBack, includeTests: req.body && req.body.includeTests });
    } catch (err) {
      return fail(res, 409, err);
    }
    res.json({ ok: true, decision: d });
  });
  app.post('/api/runs/:id/decision', decide(null));
  app.post('/api/runs/:id/approve', decide('approved'));
  app.post('/api/runs/:id/reject', decide('rejected'));

  // Explicit user action: one more Repairer call on the same locked tests.
  app.post('/api/runs/:id/retry-fix', wrap(async (req, res) => {
    const run = pipeline.reviveRun(req.params.id);
    if (!run) return fail(res, 404, 'Run not found');
    if (ACTIVE.has(run.state.status)) return fail(res, 409, 'This run is still active.');
    const s = run.state;
    if (!(s.status === 'repair-not-verified' || (['failed', 'timed-out', 'cancelled'].includes(s.status) && s.red && s.red.outcome === 'fail' && s.tests))) {
      return fail(res, 409, 'Retry Fix is only available after the bug was reproduced and the repair did not succeed.');
    }
    run.retryFix();
    res.status(202).json({ id: run.id, status: 'running' });
  }));

  // Explicit user action: start a NEW run with the same inputs.
  app.post('/api/runs/:id/retry', wrap(async (req, res) => {
    const s = pipeline.loadState(req.params.id);
    if (!s) return fail(res, 404, 'Run not found');
    const run = await pipeline.createRun({ source: { ...s.sourceSpec }, bugReport: s.bugReport, rules: s.rules,
      options: { ...s.options, agents: s.options.agents } });
    res.status(202).json({ id: run.id });
    run.start();
  }));

  app.get('/api/runs/:id/diff', (req, res) => {
    const s = pipeline.loadState(req.params.id);
    if (!s) return fail(res, 404, 'Run not found');
    if (!s.diff) return fail(res, 404, 'Diff not available yet');
    const diffLines = s.diff.split('\n').filter(l => !/^(===|---|\+\+\+|@@|\\)/.test(l)).map(l =>
      ({ type: l[0] === '+' ? 'add' : l[0] === '-' ? 'remove' : 'context', content: l.slice(1) }));
    res.json({ diff: s.diff, diffMeta: s.diffMeta, diffLines });
  });

  app.get('/api/runs/:id/report', (req, res) => {
    const s = pipeline.loadState(req.params.id);
    if (!s || !s.artifacts || !s.artifacts.reportMd) return fail(res, 404, 'Report not generated yet');
    const file = path.join(pipeline.runDir(s.id), 'report.md');
    res.json({ markdown: fs.readFileSync(file, 'utf8'), jsonPath: s.artifacts.reportJson });
  });

  const DOWNLOADS = {
    'fixed-code.zip': 'application/zip', 'fix.patch': 'text/x-diff', 'report.md': 'text/markdown', 'report.json': 'application/json',
  };
  app.get('/api/runs/:id/files/:name', (req, res) => {
    const name = req.params.name;
    let type = DOWNLOADS[name];
    if (!type && /^bugrep\.repro\.test\.m?js$|^test_bugrep_repro\.py$/.test(name)) type = 'text/plain';
    if (!type) return fail(res, 404, 'Unknown file');
    const file = path.join(pipeline.runDir(req.params.id), name);
    if (!fs.existsSync(file)) return fail(res, 404, 'File not ready');
    res.setHeader('Content-Type', type + '; charset=utf-8');
    if (req.query.inline !== '1') res.setHeader('Content-Disposition', `attachment; filename="bugrep-${req.params.id}-${name}"`);
    fs.createReadStream(file).pipe(res);
  });

  // ── integrations (explicit user action; never changes the repair status) ────
  app.post('/api/runs/:id/integrations/:target', wrap(async (req, res) => {
    const run = pipeline.reviveRun(req.params.id);
    if (!run) return fail(res, 404, 'Run not found');
    let result;
    try {
      result = await integrations.deliver(req.params.target, run.state);
    } catch (err) {
      return fail(res, err.http || 400, err);
    }
    run.state.integrations = { ...(run.state.integrations || {}), [req.params.target]: result };
    run.log('system', `${req.params.target}: ${result.status === 'failed' ? 'delivery FAILED: ' + result.error : result.status}${result.issueKey ? ' ' + result.issueKey : ''}`,
      result.status === 'failed' ? 'warn' : 'info');
    if (!ACTIVE.has(run.state.status)) run.refreshReport(); else run._save();
    res.status(result.status === 'failed' ? 502 : 200).json({ target: req.params.target, ...result, runStatus: run.state.status });
  }));

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  return app;
}

async function main() {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '127.0.0.1';
  const recovered = pipeline.recoverStaleRuns();
  const app = createApp();
  app.listen(PORT, HOST, async () => {
    console.log(`\n🐞 BugRep-AI running at http://localhost:${PORT}`);
    if (recovered.length) console.log(`   Marked ${recovered.length} stale run(s) as interrupted: ${recovered.join(', ')}`);
    const s = await bob.getStatus();
    console.log(`   IBM Bob      : ${s.operational ? '✅ ' + (s.version || 'ready') : '⚪ ' + s.detail}`);
    const i = integrations.status();
    console.log(`   Integrations : Jira ${i.jira.configured ? '✅' : '⚪'}  Slack ${i.slack.configured ? '✅' : '⚪'}  Teams ${i.teams.configured ? '✅' : '⚪'}\n`);
  });
}

if (require.main === module) main();

module.exports = { createApp };
