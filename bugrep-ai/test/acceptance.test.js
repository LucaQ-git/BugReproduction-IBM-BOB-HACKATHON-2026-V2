// Acceptance tests A–J. Uses a temporary runs folder, the fake Bob test double
// (scripts/fake-bob.js) and local mock HTTP servers. IBM Bob itself is NOT invoked.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bugrep-acc-'));
const SECRET = 'super-secret-token-value-987';
process.env.BUGREP_RUNS_DIR = path.join(TMP, 'runs');
process.env.BOB_CLI_PATH = path.join(__dirname, '..', 'scripts', 'fake-bob.js');
process.env.BOBSHELL_API_KEY = SECRET;
process.env.BOB_CALL_TIMEOUT_MS = '60000';
for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'SLACK_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL', 'WATSONX_API_KEY']) delete process.env[k];

const pipeline = require('../workflow/pipeline');
const bob = require('../agents/bob');
const demo = require('../workflow/demo');
const { createApp } = require('../web/server');
const { parseAgentResponse } = require('../agents/parse');

jest.setTimeout(90000);

let server, base;
beforeAll(done => { server = createApp().listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); }); });
afterAll(done => { server.close(done); });
beforeEach(() => { process.env.FAKE_BOB_MODE = 'ok'; delete process.env.TEST_TIMEOUT_MS; process.env.BOB_CALL_TIMEOUT_MS = '60000'; });

const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
};
const ended = run => new Promise(r => { if (pipeline.TERMINAL.has(run.state.status)) r(run.state); else run.once('end', r); });
const approveWhenAsked = run => run.on('state', s => { if (s.status === 'awaiting-approval' && !run._t) { run._t = 1; setTimeout(() => run.decide('approved', 'test'), 20); } });

test('A: server starts and serves the UI + health', async () => {
  const home = await fetch(base + '/');
  expect(home.status).toBe(200);
  expect(await home.text()).toMatch(/BugRep/);
  const h = await api('GET', '/api/health');
  expect(h.status).toBe(200);
  expect(h.json.ok).toBe(true);
});

test('B: repeated /api/health does not spawn Bob each time (30 s cache)', async () => {
  const log = path.join(TMP, 'bob-calls.log');
  process.env.FAKE_BOB_LOG = log;
  bob.invalidateStatus();
  for (let i = 0; i < 10; i++) await api('GET', '/api/health');
  delete process.env.FAKE_BOB_LOG;
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  expect(lines.filter(l => l === '--version')).toHaveLength(1);
  expect(lines.filter(l => l === 'run')).toHaveLength(0); // health never makes a Bob call
});

test('C1: a Bob call that never answers ends as TIMED OUT', async () => {
  process.env.FAKE_BOB_MODE = 'sleep';
  process.env.BOB_CALL_TIMEOUT_MS = '1500';
  const run = await pipeline.createRun({ source: { type: 'demo' } });
  run.start();
  const s = await ended(run);
  expect(s.status).toBe('timed-out');
  expect(s.errorType).toBe('timeout');
  expect(s.failedStage).toBe('investigate');
  expect(s.timedOutAt).toBeTruthy();
});

test('C2: a hanging test run is a timeout, never RED', async () => {
  process.env.FAKE_BOB_MODE = 'hang-test';
  process.env.TEST_TIMEOUT_MS = '3000';
  const run = await pipeline.createRun({ source: { type: 'demo' } });
  run.start();
  const s = await ended(run);
  expect(s.status).toBe('timed-out');
  expect(s.failedStage).toBe('reproduce');
  expect(s.error).toMatch(/exceeded 3 seconds/);
  expect(s.red).toBe(null);
});

test('D: Stop Run kills the Bob process and ends as CANCELLED', async () => {
  process.env.FAKE_BOB_MODE = 'sleep';
  const r = await api('POST', '/api/runs', { source: { type: 'demo' } });
  expect(r.status).toBe(202);
  const run = pipeline.getRun(r.json.id);
  await new Promise(res => setTimeout(res, 1200));
  const t0 = Date.now();
  const c = await api('POST', `/api/runs/${r.json.id}/cancel`);
  expect(c.status).toBe(200);
  const s = await ended(run);
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(s.status).toBe('cancelled');
  expect(s.cancelledAt).toBeTruthy();
  expect(s.fix).toBe(null); // nothing applied
});

test('E: a persisted "running" run becomes INTERRUPTED at startup', () => {
  const id = '260101000000-dead';
  const dir = path.join(process.env.BUGREP_RUNS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    id, status: 'running', stage: 'investigate', createdAt: new Date().toISOString(), bugReport: 'x',
    source: { type: 'demo', label: 'Demo' }, options: { agents: ['bob'] }, stages: { investigate: { status: 'active' } }, artifacts: {},
  }));
  const fixed = pipeline.recoverStaleRuns();
  expect(fixed).toContain(id);
  const s = pipeline.loadState(id);
  expect(s.status).toBe('interrupted');
  expect(s.errorType).toBe('interrupted');
  expect(s.error).toBe('Run was interrupted before completion.');
  expect(s.interruptedAt).toBeTruthy();
});

describe('F: Bob response parser', () => {
  const inv = { localizedFile: 'a.js', localizedFunction: 'f', analysis: 'x', testFile: 't', testCode: 'test()' };
  test('raw JSON', () => expect(parseAgentResponse({ stdout: JSON.stringify(inv) }, 'investigator').ok).toBe(true));
  test('fenced JSON', () => expect(parseAgentResponse({ stdout: 'Here:\n```json\n' + JSON.stringify(inv) + '\n```\nbye' }, 'investigator').ok).toBe(true));
  test('JSON inside an envelope', () => expect(parseAgentResponse({ stdout: JSON.stringify({ type: 'result', data: { message: inv } }) }, 'investigator').payload.testCode).toBe('test()'));
  test('JSON encoded as a string', () => expect(parseAgentResponse({ stdout: JSON.stringify(JSON.stringify(inv)) }, 'investigator').ok).toBe(true));
  test('JSONL + stderr', () => expect(parseAgentResponse({ stdout: '{"type":"start"}\n', stderr: JSON.stringify({ rootCause: 'r', fixSummary: 's', fixedCode: 'c' }) }, 'repairer').ok).toBe(true));
  test('malformed output → not ok with bounded, redacted debug', () => {
    const r = parseAgentResponse({ stdout: 'no json ' + SECRET, stderr: 'boom' }, 'investigator');
    expect(r.ok).toBe(false);
    expect(r.debug.stdout).not.toContain(SECRET);
  });
  test('malformed Bob output makes the run FAILED with bobDebug', async () => {
    process.env.FAKE_BOB_MODE = 'garbage';
    const run = await pipeline.createRun({ source: { type: 'demo' } });
    run.start();
    const s = await ended(run);
    expect(s.status).toBe('failed');
    expect(s.errorType).toBe('ai-response');
    expect(s.bobDebug.stdout).toMatch(/No JSON here/);
    expect(s.bobDebug.stderr).toMatch(/warning/);
  });
});

test('G: /api/agents shows Bob implemented and the others as skeletons; skeletons never fake a run', async () => {
  const r = await api('GET', '/api/agents');
  const by = Object.fromEntries(r.json.map(a => [a.id, a]));
  expect(by.bob.implemented).toBe(true);
  for (const id of ['claude', 'openai', 'gemini', 'grok']) {
    expect(by[id].implemented).toBe(false);
    expect(by[id].operational).toBe(false);
  }
  const bad = await api('POST', '/api/runs', { source: { type: 'local', path: TMP }, bugReport: 'x', options: { agents: ['claude'] } });
  expect(bad.status).toBe(400);
  expect(bad.json.error).toBe('Claude provider is not configured in this build.');
});

describe('H: integrations', () => {
  test('unconfigured → Not configured, nothing leaks', async () => {
    const st = await api('GET', '/api/integrations/status');
    expect(st.json).toEqual({ jira: { configured: false }, slack: { configured: false }, teams: { configured: false } });
    const run = await pipeline.createRun({ source: { type: 'demo' }, options: { autoApprove: true } });
    run.start();
    await ended(run);
    const j = await api('POST', `/api/runs/${run.id}/integrations/jira`);
    expect(j.status).toBe(400);
    expect(j.json.error).toMatch(/not configured/);
    for (const u of ['/api/health', '/api/agents', '/api/integrations/status', `/api/runs/${run.id}`]) {
      expect((await api('GET', u)).text).not.toContain(SECRET);
    }
  });

  test('configured → Jira created + Slack sent + Teams failure does not change the verified repair', async () => {
    const hits = [];
    const mock = http.createServer((req, res) => {
      let b = ''; req.on('data', d => { b += d; });
      req.on('end', () => {
        hits.push({ url: req.url, body: JSON.parse(b || '{}'), auth: req.headers.authorization });
        if (req.url === '/rest/api/2/issue') { res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('{"key":"BUG-123"}'); }
        if (req.url === '/slack') { res.writeHead(200); return res.end('ok'); }
        res.writeHead(403); res.end('Forbidden');
      });
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    const m = `http://127.0.0.1:${mock.address().port}`;
    Object.assign(process.env, { JIRA_BASE_URL: m, JIRA_EMAIL: 'bot@example.com', JIRA_API_TOKEN: SECRET, JIRA_PROJECT_KEY: 'BUG',
      SLACK_WEBHOOK_URL: m + '/slack', TEAMS_WEBHOOK_URL: m + '/teams' });
    try {
      const st = await api('GET', '/api/integrations/status');
      expect(st.text).not.toContain(m);
      const run = await pipeline.createRun({ source: { type: 'demo' }, options: { autoApprove: true } });
      run.start();
      expect((await ended(run)).status).toBe('completed');

      const j = await api('POST', `/api/runs/${run.id}/integrations/jira`);
      expect(j.json.status).toBe('created');
      expect(j.json.issueKey).toBe('BUG-123');
      const issue = hits.find(h => h.url === '/rest/api/2/issue').body.fields;
      expect(issue.summary).toMatch(/^\[BugRep-AI\] /);
      expect(issue.labels).toEqual(['bugrep-ai', 'ai-repair']);
      expect(issue.description).toMatch(new RegExp(run.id));

      const s = await api('POST', `/api/runs/${run.id}/integrations/slack`);
      expect(s.json.status).toBe('sent');
      const t = await api('POST', `/api/runs/${run.id}/integrations/teams`);
      expect(t.status).toBe(502);
      expect(t.json.status).toBe('failed');
      expect(t.json.error).toMatch(/403/);
      expect(t.text).not.toContain(m);

      const state = pipeline.loadState(run.id);
      expect(state.status).toBe('completed'); // repair stays verified
      expect(state.integrations.jira.issueKey).toBe('BUG-123');
      expect(state.integrations.teams.status).toBe('failed');
      const md = fs.readFileSync(path.join(pipeline.runDir(run.id), 'report.md'), 'utf8');
      expect(md).toMatch(/Jira:\*\* CREATED BUG-123/);
      expect(md).toMatch(/Microsoft Teams:\*\* FAILED/);
      expect(md).not.toContain(SECRET);
    } finally {
      for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'SLACK_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL']) delete process.env[k];
      mock.close();
    }
  });
});

describe('I: demo', () => {
  test('preflight succeeds when Bob and Jest are available (no Bob run calls)', async () => {
    const log = path.join(TMP, 'bob-preflight.log');
    process.env.FAKE_BOB_LOG = log;
    bob.invalidateStatus();
    const r = await api('GET', '/api/demo/preflight');
    delete process.env.FAKE_BOB_LOG;
    expect(r.json.ok).toBe(true);
    expect(fs.readFileSync(log, 'utf8')).not.toMatch(/^run$/m);
  });

  test('preflight fails honestly when Bob is unavailable', async () => {
    const saved = process.env.BOB_CLI_PATH;
    process.env.BOB_CLI_PATH = path.join(TMP, 'no-such-bob');
    bob.invalidateStatus();
    try {
      const r = await api('GET', '/api/demo/preflight');
      expect(r.json.ok).toBe(false);
      expect(r.json.reason).toBe('IBM Bob is unavailable.');
      const run = await api('POST', '/api/runs', { source: { type: 'demo' } });
      expect(run.status).toBe(400);
      expect(run.json.errorType).toBe('ai-unavailable');
    } finally {
      process.env.BOB_CLI_PATH = saved;
      bob.invalidateStatus();
    }
  });

  test('reset restores only the demo workspace with the corrected header', async () => {
    const r = await api('POST', '/api/demo/reset');
    expect(r.json.ok).toBe(true);
    const cart = fs.readFileSync(path.join(process.env.BUGREP_RUNS_DIR, '_demo-workspace', 'src', 'cart.js'), 'utf8');
    expect(cart.startsWith(demo.RESET_HEADER)).toBe(true);
    expect(fs.readFileSync(path.join(__dirname, '..', 'demo', 'cart.fixture.js'), 'utf8')).toMatch(/^\/\/ src\/cart\.fixture\.js/);
  });

  test('normal user files are untouched unless approved with write-back', async () => {
    const user = path.join(TMP, 'user-project');
    fs.cpSync(path.join(__dirname, '..', 'demo', 'template'), user, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'demo', 'cart.fixture.js'), path.join(user, 'src', 'cart.js'));
    const before = fs.readFileSync(path.join(user, 'src', 'cart.js'), 'utf8');
    const run = await pipeline.createRun({ source: { type: 'local', path: user }, bugReport: 'negative totals with big coupons' });
    run.on('state', s => { if (s.status === 'awaiting-approval' && !run._t) { run._t = 1; setTimeout(() => run.decide('rejected', 'test'), 20); } });
    run.start();
    const s = await ended(run);
    expect(s.status).toBe('rejected');
    expect(fs.readFileSync(path.join(user, 'src', 'cart.js'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(user, '__bugrep__'))).toBe(false);
  });
});

test('repair-not-verified, then an explicit Retry Fix makes exactly one more Bob call', async () => {
  process.env.FAKE_BOB_MODE = 'bad-fix';
  const run = await pipeline.createRun({ source: { type: 'demo' } });
  run.start();
  let s = await ended(run);
  expect(s.status).toBe('repair-not-verified');
  expect(s.bobCallCount).toBe(2);
  expect(s.approval).toBe(null);

  process.env.FAKE_BOB_MODE = 'ok';
  approveWhenAsked(run);
  const r = await api('POST', `/api/runs/${run.id}/retry-fix`);
  expect(r.status).toBe(202);
  s = await new Promise(res => run.once('end', res));
  expect(s.status).toBe('completed');
  expect(s.bobCallCount).toBe(3);
});

test('J: report has RED/GREEN, agent, timestamps, approval, integrations, and no secrets', async () => {
  const run = await pipeline.createRun({ source: { type: 'demo' } });
  approveWhenAsked(run);
  run.start();
  const s = await ended(run);
  expect(s.status).toBe('completed');
  expect(s.bobCallCount).toBe(2);
  const r = await api('GET', `/api/runs/${run.id}/report`);
  const md = r.json.markdown;
  for (const re of [/Reproduction \(RED\)/, /6 failed/, /8 passed/, /IBM Bob calls:\*\* 2/, /bob/, /Started:\*\* \d{4}-/, /Decision: \*\*approved\*\*/,
    /Jira:\*\* not sent/, /Slack:\*\* not sent/, /Microsoft Teams:\*\* not sent/, /Final GREEN on the exact approved candidate: 8\/8/]) {
    expect(md).toMatch(re);
  }
  expect(md).not.toContain(SECRET);
  const json = fs.readFileSync(path.join(pipeline.runDir(run.id), 'report.json'), 'utf8');
  expect(json).not.toContain(SECRET);
});

test('runs can be listed and deleted; active runs cannot be deleted', async () => {
  const list = await api('GET', '/api/runs');
  expect(Array.isArray(list.json)).toBe(true);
  const done = list.json.find(r => r.status === 'completed');
  const del = await api('DELETE', `/api/runs/${done.id}`);
  expect(del.status).toBe(200);
  expect((await api('GET', `/api/runs/${done.id}`)).status).toBe(404);
});
