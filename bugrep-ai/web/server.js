// web/server.js — BugRep-AI web app backend
//
//   npm start            → http://localhost:3000
//
// Binds to 127.0.0.1 by default: the "Local / IDE" source can read folders on
// this machine, so the app must not be exposed to the network. Set HOST=0.0.0.0
// only if you understand that.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs       = require('fs');
const express  = require('express');
const pipeline = require('../workflow/pipeline');
const sources  = require('../workflow/sources');
const engines  = require('../workflow/engines');

const app  = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const fail = (res, status, message) => res.status(status).json({ error: message });

// ── Health & config ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const s = engines.status();
  res.json({
    ok: true,
    engines: {
      bob:     { ready: s.bob.ready, detail: s.bob.ready ? s.bob.version : s.bob.reason },
      watsonx: { ready: s.watsonx.ready, detail: s.watsonx.ready ? s.watsonx.model : s.watsonx.reason },
      replay:  { ready: true, detail: 'Demo only' },
    },
    defaultLocalPath: sources.defaultLocalPath(),
    githubToken: !!process.env.GITHUB_TOKEN,
  });
});

app.get('/api/demo', (req, res) => {
  res.json({
    bugReport: fs.readFileSync(path.join(ROOT, 'demo', 'bug_report.txt'), 'utf8').trim(),
    rules: '',
  });
});

// ── Uploads (raw ZIP body) ───────────────────────────────────────────────────
app.post('/api/uploads', express.raw({ type: () => true, limit: '60mb' }), (req, res) => {
  try {
    const name = String(req.headers['x-file-name'] || 'upload.zip').slice(0, 200);
    const id = sources.saveUpload(req.body, decodeURIComponent(name));
    res.json({ uploadId: id, name: decodeURIComponent(name), bytes: req.body.length });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

// ── Runs ─────────────────────────────────────────────────────────────────────
app.post('/api/runs', (req, res) => {
  try {
    const { source, bugReport, rules, options } = req.body || {};
    const run = pipeline.createRun({ source, bugReport, rules, options });
    res.status(202).json({ id: run.id });
    run.start();
  } catch (err) {
    fail(res, 400, err.message);
  }
});

app.get('/api/runs', (req, res) => res.json(pipeline.listRuns(12)));

app.get('/api/runs/:id', (req, res) => {
  const s = pipeline.loadState(req.params.id);
  if (!s) return fail(res, 404, 'Run not found');
  res.json(s);
});

// Server-Sent Events: live stage updates + agent log lines
app.get('/api/runs/:id/events', (req, res) => {
  const run = pipeline.getRun(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!run) {
    const s = pipeline.loadState(req.params.id);
    if (s) send('state', s);
    for (const l of pipeline.loadLogs(req.params.id)) send('log', l);
    send('end', s || {});
    return res.end();
  }
  send('state', run.state);
  for (const l of run.logs) send('log', l);

  const onLog = l => send('log', l);
  const onState = s => send('state', s);
  const onEnd = s => { send('state', s); send('end', s); };
  run.on('log', onLog);
  run.on('state', onState);
  run.on('end', onEnd);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    run.off('log', onLog); run.off('state', onState); run.off('end', onEnd);
  });
});

app.post('/api/runs/:id/decision', (req, res) => {
  const run = pipeline.getRun(req.params.id);
  if (!run) return fail(res, 404, 'Run is no longer active.');
  const { decision, writeBack, includeTests } = req.body || {};
  try {
    run.decide(decision === 'approved' ? 'approved' : 'rejected', 'web reviewer', { writeBack, includeTests });
    res.json({ ok: true });
  } catch (err) {
    fail(res, 409, err.message);
  }
});

// ── Downloads ────────────────────────────────────────────────────────────────
const DOWNLOADS = {
  'fixed-code.zip': { file: 'fixed-code.zip', type: 'application/zip' },
  'fix.patch':      { file: 'fix.patch', type: 'text/x-diff' },
  'report.md':      { file: 'report.md', type: 'text/markdown' },
  'report.json':    { file: 'report.json', type: 'application/json' },
};

app.get('/api/runs/:id/files/:name', (req, res) => {
  const dir = pipeline.runDir(req.params.id);
  let spec = DOWNLOADS[req.params.name];
  if (!spec && /^bugrep\.repro\.test\.m?js$|^test_bugrep_repro\.py$/.test(req.params.name)) {
    spec = { file: req.params.name, type: 'text/plain' };
  }
  if (!spec) return fail(res, 404, 'Unknown file');
  const file = path.join(dir, spec.file);
  if (!fs.existsSync(file)) return fail(res, 404, 'File not ready');
  res.setHeader('Content-Type', spec.type + '; charset=utf-8');
  if (req.query.inline !== '1') res.setHeader('Content-Disposition', `attachment; filename="bugrep-${req.params.id}-${spec.file}"`);
  fs.createReadStream(file).pipe(res);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, HOST, () => {
  const s = engines.status();
  console.log(`\n🐞 BugRep-AI running at http://localhost:${PORT}`);
  console.log(`   Bob Shell : ${s.bob.ready ? '✅ ' + (s.bob.version || 'ready') : '⚪ ' + s.bob.reason}`);
  console.log(`   watsonx   : ${s.watsonx.ready ? '✅ ' + s.watsonx.model : '⚪ ' + s.watsonx.reason}`);
  console.log(`   Demo      : ✅ always available\n`);
});
