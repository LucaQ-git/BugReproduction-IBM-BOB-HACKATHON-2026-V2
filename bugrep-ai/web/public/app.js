// web/public/app.js — BugRep-AI front-end (no framework, no build step)
'use strict';

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

const STAGES = {
  acquire:     { label: 'Fetch code',         icon: 'download', group: 'analyze' },
  index:       { label: 'Map codebase',       icon: 'map',      group: 'analyze' },
  investigate: { label: 'Investigator',       icon: 'search',   group: 'analyze', ai: true },
  reproduce:   { label: 'Reproduce (RED)',    icon: 'terminal', group: 'reproduce' },
  repair:      { label: 'Repairer',           icon: 'wrench',   group: 'repair', ai: true },
  verify:      { label: 'Verify (GREEN)',     icon: 'shield',   group: 'verify' },
  review:      { label: 'Your approval',      icon: 'user',     group: 'approval' },
  deliver:     { label: 'Final GREEN & deliver', icon: 'package', group: 'report' },
  report:      { label: 'Report',             icon: 'file',     group: 'report' },
};
const GROUPS = [['analyze', 'Analyze'], ['reproduce', 'Reproduce'], ['repair', 'Repair'], ['verify', 'Verify'], ['approval', 'Approval'], ['report', 'Report']];

const STATUS = {
  running:               ['running', 'Running'],
  'awaiting-approval':   ['waiting', 'Needs your approval'],
  completed:             ['done', 'Completed'],
  rejected:              ['neutral', 'Rejected'],
  'not-reproduced':      ['waiting', 'Not reproduced'],
  'repair-not-verified': ['waiting', 'Repair not verified'],
  failed:                ['failed', 'Failed'],
  'timed-out':           ['failed', 'Timed out'],
  cancelled:             ['neutral', 'Cancelled'],
  interrupted:           ['failed', 'Interrupted'],
};
const ACTIVE = new Set(['running', 'awaiting-approval']);

const ERROR_EXPLAIN = {
  environment: ['Test environment failure', 'The tests could not be started, so nothing was proven either way. This is NOT "bug not reproduced". Check Node/Jest (npm install) or pytest.'],
  'ai-response': ['AI response failure', 'The agent answered, but not with the expected JSON. Bounded diagnostics are shown below and saved in the report.'],
  'ai-unavailable': ['AI agent unavailable', 'The selected agent could not be reached or is not configured.'],
  'invalid-tests': ['Generated tests were not usable', 'The Investigator\'s tests could not run correctly (or used weak assertions), so the bug could not be reproduced honestly. No repair was attempted.'],
  integrity: ['Integrity check failed', 'A locked test or the verified candidate changed unexpectedly. Nothing was applied.'],
  source: ['Could not load the code', 'The project could not be fetched or is not a supported language.'],
  internal: ['Unexpected error', 'Something went wrong inside BugRep. The report contains the details.'],
};

const app = {
  health: null, agents: [], integ: { jira: {}, slack: {}, teams: {} },
  source: 'local', upload: null, runId: null, es: null, state: null, logs: [],
  cards: new Map(), timer: null, consoleCollapsed: false,
};

// ─── boot & routing ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  bindHome();
  bindRun();
  refreshMeta();
  setInterval(refreshMeta, 30000);
  route();
});
window.addEventListener('hashchange', route);

function route() {
  const h = location.hash || '#/';
  const m = h.match(/^#run\/([\w-]+)/);
  if (m) return openRun(m[1]);
  closeStream();
  const view = { '#runs': 'runs', '#agents': 'agents', '#integrations': 'integrations', '#reports': 'reports' }[h] || 'home';
  showView(view);
  if (view === 'runs') loadRuns();
  if (view === 'reports') loadReports();
  if (view === 'agents') renderAgents();
  if (view === 'integrations') renderIntegrations();
  if (h === '#new-run') setTimeout(() => $('#new-run').scrollIntoView({ behavior: 'smooth' }), 50);
}

function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.mainnav a').forEach(a => a.classList.toggle('active', a.dataset.view === (name === 'run' ? 'runs' : name)));
  if (name !== 'run') window.scrollTo({ top: 0 });
}

function initTheme() {
  let t = 'dark';
  try { t = localStorage.getItem('bugrep-theme') || t; } catch { /* ignore */ }
  setTheme(t);
  $('#btn-theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#btn-theme').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
  try { localStorage.setItem('bugrep-theme', t); } catch { /* ignore */ }
}

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  let d = null;
  try { d = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error((d && d.error) || `HTTP ${r.status}`), { data: d, status: r.status });
  return d;
}
const post = (url, body) => getJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

async function refreshMeta() {
  try {
    const [h, agents, integ] = await Promise.all([getJSON('/api/health'), getJSON('/api/agents'), getJSON('/api/integrations/status')]);
    app.health = h; app.agents = agents; app.integ = integ;
    const bob = agents.find(a => a.id === 'bob');
    const chip = $('#bob-chip');
    chip.className = `chip ${bob && bob.operational ? 'on' : 'off'}`;
    chip.title = bob ? bob.detail : '';
    chip.innerHTML = `<span class="dot"></span>IBM Bob ${bob && bob.operational ? esc(bob.version || '') : '· unavailable'}`;
    const lp = $('#local-path');
    if (!lp.value) lp.value = h.defaultLocalPath || '';
    // Hosted (Vercel) build: no local folders, so switch to GitHub.
    const localTab = $('#source-tabs .seg-btn[data-source="local"]');
    if (h.localSource === false && localTab && !localTab.classList.contains('hidden')) {
      localTab.classList.add('hidden');
      if (app.source === 'local') $('#source-tabs .seg-btn[data-source="github"]').click();
    }
    const sel = $('#opt-agent');
    const cur = sel.value || 'bob';
    sel.innerHTML = agents.map(a => `<option value="${a.id}" ${a.operational ? '' : 'disabled'}>${esc(a.name)}${a.operational ? (a.experimental ? ' (experimental)' : '') : a.implemented ? ' (not configured)' : ' (coming soon)'}</option>`).join('');
    sel.value = agents.find(a => a.id === cur && a.operational) ? cur : 'bob';
    if ($('#view-agents').classList.contains('active')) renderAgents();
    if ($('#view-integrations').classList.contains('active')) renderIntegrations();
    if (app.state) renderShare(app.state);
  } catch {
    $('#bob-chip').className = 'chip off';
    $('#bob-chip').innerHTML = '<span class="dot"></span>Server offline';
  }
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.className = 'toast' + (err ? ' err' : '');
  t.innerHTML = icon(err ? 'alert' : 'check') + esc(msg);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 4200);
}

// ─── home ────────────────────────────────────────────────────────────────────
function bindHome() {
  $$('#source-tabs .seg-btn').forEach(b => b.addEventListener('click', () => {
    app.source = b.dataset.source;
    $$('#source-tabs .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    $$('.source-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === app.source));
  }));
  const dz = $('#dropzone'), input = $('#zip-input');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) uploadZip(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => input.files[0] && uploadZip(input.files[0]));
  $('#zip-clear').addEventListener('click', () => { app.upload = null; input.value = ''; $('#zip-pill').classList.add('hidden'); dz.classList.remove('hidden'); });
  $('#run-form').addEventListener('submit', onSubmit);

  $('#btn-demo').addEventListener('click', openDemo);
  $('#btn-demo-start').addEventListener('click', startDemo);
  $('#btn-demo-reset').addEventListener('click', resetDemo);
  $$('[data-close]').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden')));
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal').forEach(m => m.classList.add('hidden')); });
  $('#runs-show-dismissed').addEventListener('change', loadRuns);
}

async function uploadZip(file) {
  if (!/\.zip$/i.test(file.name)) return toast('Please choose a .zip file', true);
  const dz = $('#dropzone');
  dz.querySelector('.dz-text').innerHTML = '<b>Uploading…</b>';
  try {
    const d = await getJSON('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
    app.upload = d;
    $('#zip-name').textContent = d.name;
    $('#zip-size').textContent = d.bytes > 1048576 ? (d.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(d.bytes / 1024)) + ' KB';
    dz.classList.add('hidden');
    $('#zip-pill').classList.remove('hidden');
  } catch (err) {
    toast(err.message, true);
  } finally {
    dz.querySelector('.dz-text').innerHTML = '<b>Drop a .zip here</b> or click to browse';
  }
}

function formError(msg) {
  const el = $('#form-error');
  el.innerHTML = icon('alert') + esc(msg);
  el.classList.remove('hidden');
}

async function onSubmit(e) {
  e.preventDefault();
  const bug = $('#bug-input').value.trim();
  let source;
  if (app.source === 'local') {
    const p = $('#local-path').value.trim();
    if (!p) return formError('Enter the folder path of your project.');
    source = { type: 'local', path: p };
  } else if (app.source === 'github') {
    const url = $('#gh-url').value.trim();
    if (!url) return formError('Enter a GitHub repository URL.');
    source = { type: 'github', url, ref: $('#gh-ref').value.trim() || undefined };
  } else {
    if (!app.upload) return formError('Upload a ZIP of your project first.');
    source = { type: 'zip', uploadId: app.upload.uploadId };
  }
  if (!bug) return formError('Describe the bug so the agents know what to look for.');
  $('#form-error').classList.add('hidden');
  const btn = $('#btn-start');
  btn.disabled = true;
  try {
    const d = await post('/api/runs', {
      source, bugReport: bug, rules: $('#rules-input').value.trim(),
      options: { agents: [$('#opt-agent').value], mode: $('input[name=mode]:checked').value,
        autoApprove: $('#opt-auto').checked, includeTests: $('#opt-tests').checked,
        writeBack: app.source === 'local' && $('#opt-writeback').checked },
    });
    location.hash = `run/${d.id}`;
  } catch (err) {
    formError(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ─── demo ────────────────────────────────────────────────────────────────────
async function openDemo() {
  $('#demo-modal').classList.remove('hidden');
  await runPreflight();
}

async function runPreflight() {
  const list = $('#demo-checks'), verdict = $('#demo-verdict'), start = $('#btn-demo-start');
  list.innerHTML = '<li class="muted"><span class="spin"></span> Running preflight checks…</li>';
  verdict.classList.add('hidden');
  start.disabled = true;
  try {
    const pf = await getJSON('/api/demo/preflight');
    list.innerHTML = pf.checks.map(c => `<li class="${c.ok ? 'ok' : 'bad'}">${icon(c.ok ? 'check' : 'x')}<span>${esc(c.label)}</span><em>${esc(c.detail)}</em></li>`).join('');
    verdict.classList.remove('hidden');
    if (pf.ok) {
      verdict.className = 'demo-verdict ok';
      verdict.innerHTML = `${icon('check')}<div><b>Ready.</b> All checks passed. The demo will make exactly two IBM Bob calls.</div>`;
      start.disabled = false;
    } else {
      verdict.className = 'demo-verdict bad';
      verdict.innerHTML = `${icon('alert')}<div><b>DEMO CANNOT START</b><br>${esc(pf.reason)}</div>`;
    }
  } catch (err) {
    list.innerHTML = `<li class="bad">${icon('x')}<span>Preflight failed</span><em>${esc(err.message)}</em></li>`;
  }
}

async function startDemo() {
  const btn = $('#btn-demo-start');
  btn.disabled = true;
  try {
    const d = await post('/api/runs', { source: { type: 'demo' } });
    $('#demo-modal').classList.add('hidden');
    location.hash = `run/${d.id}`;
  } catch (err) {
    const v = $('#demo-verdict');
    v.className = 'demo-verdict bad';
    v.innerHTML = `${icon('alert')}<div><b>DEMO CANNOT START</b><br>${esc(err.message)}</div>`;
    v.classList.remove('hidden');
  }
}

async function resetDemo() {
  try {
    const d = await post('/api/demo/reset');
    toast(d.cancelled && d.cancelled.length ? `Demo reset (${d.cancelled.length} active demo run cancelled)` : 'Demo reset to the known buggy baseline');
    await runPreflight();
  } catch (err) {
    toast(err.message, true);
  }
}

// ─── run view ────────────────────────────────────────────────────────────────
function bindRun() {
  $('#console-toggle').addEventListener('click', () => setConsole(!app.consoleCollapsed));
  $('#btn-approve').addEventListener('click', () => decide('approved'));
  $('#btn-reject').addEventListener('click', () => decide('rejected'));
  $('#btn-stop').addEventListener('click', stopRun);
  $('#btn-view-diff').addEventListener('click', () => app.cards.get('fix')?.el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function setConsole(collapsed) {
  app.consoleCollapsed = collapsed;
  $('#console').classList.toggle('collapsed', collapsed);
  $('#console-toggle').textContent = collapsed ? 'Expand' : 'Collapse';
}

function closeStream() {
  if (app.es) { app.es.close(); app.es = null; }
  clearInterval(app.timer);
  $('#approve-bar').classList.add('hidden');
}

function openRun(id, force) {
  if (app.runId === id && app.es && !force) { showView('run'); return; }
  closeStream();
  app.runId = id; app.state = null; app.logs = [];
  app.cards.clear();
  $('#cards').innerHTML = '';
  $('#console').innerHTML = '';
  $('#timeline').innerHTML = '';
  $('#share-card').classList.add('hidden');
  setConsole(false);
  showView('run');
  const es = new EventSource(`/api/runs/${id}/events`);
  app.es = es;
  es.addEventListener('state', e => render(JSON.parse(e.data)));
  es.addEventListener('log', e => addLog(JSON.parse(e.data)));
  es.addEventListener('end', () => { es.close(); if (app.es === es) app.es = null; });
  es.onerror = () => { if (es.readyState === 2 && app.es === es) app.es = null; };
  app.timer = setInterval(tick, 1000);
}

function addLog(l) {
  app.logs.push(l);
  const box = $('#console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const time = new Date(l.t).toLocaleTimeString([], { hour12: false });
  box.insertAdjacentHTML('beforeend', `<div class="log-line ${l.level}"><span class="log-time">${time}</span><span class="log-agent ${esc(l.role || 'system')}">${esc(l.agent === 'system' ? 'BugRep' : l.agent)}</span><span class="log-text">${esc(l.text)}</span></div>`);
  if (atBottom) box.scrollTop = box.scrollHeight;
  if (app.state && ACTIVE.has(app.state.status)) renderNow(app.state);
}

function tick() {
  const s = app.state;
  if (!s) return;
  const end = s.finishedAt ? new Date(s.finishedAt) : new Date();
  $('#run-elapsed').textContent = fmtDur(end - new Date(s.createdAt));
  if (ACTIVE.has(s.status)) { renderTimeline(s); renderNow(s); }
}

function render(s) {
  const prev = app.state;
  app.state = s;
  const [cls, label] = STATUS[s.status] || ['', s.status];
  const pill = $('#run-status');
  pill.className = `status-pill ${cls}`;
  pill.textContent = label;
  $('#run-source-label').textContent = s.source.label;
  $('#run-id').textContent = `run ${s.id}`;
  $('#run-agent').textContent = s.agent ? s.agent.name : '…';
  $('#demo-badge').classList.toggle('hidden', s.source.type !== 'demo');
  $('#run-bug').textContent = s.bugReport;
  $('#live-dot').classList.toggle('off', !ACTIVE.has(s.status));
  $('#btn-stop').classList.toggle('hidden', !ACTIVE.has(s.status));
  $('#btn-stop').disabled = !!s.cancelRequested;
  tick();
  renderStepper(s);
  renderTimeline(s);
  renderNow(s);
  renderCards(s);
  renderShare(s);
  renderApproval(s);
  // A finished run that the user revives (Retry Fix) needs a new stream.
  if (prev && !ACTIVE.has(prev.status) && ACTIVE.has(s.status) && !app.es) openRun(s.id, true);
}

function groupStatus(s, g) {
  const keys = Object.keys(STAGES).filter(k => STAGES[k].group === g);
  const st = keys.map(k => (s.stages[k] || {}).status || 'pending');
  if (st.includes('failed')) return 'failed';
  if (st.includes('active')) return 'active';
  if (st.every(x => x === 'done' || x === 'skipped') && st.includes('done')) return 'done';
  if (st.every(x => x === 'skipped')) return 'skipped';
  return 'pending';
}

function renderStepper(s) {
  $('#stepper').innerHTML = GROUPS.map(([g, label], i) => {
    const st = groupStatus(s, g);
    return `<li class="step-g ${st}"><span class="step-dot">${st === 'done' ? icon('check') : st === 'failed' ? icon('x') : i + 1}</span><span class="step-l">${label}</span></li>`;
  }).join('<li class="step-line" aria-hidden="true"></li>');
}

function renderTimeline(s) {
  $('#timeline').innerHTML = Object.entries(STAGES).map(([key, m]) => {
    const st = s.stages[key] || { status: 'pending' };
    const ico = st.status === 'done' ? 'check' : st.status === 'failed' ? 'x' : key === 'acquire' ? ({ local: 'folder', github: 'github', zip: 'archive', demo: 'play' }[s.source.type] || m.icon) : m.icon;
    const dur = st.startedAt && st.endedAt ? fmtDur(st.endedAt - st.startedAt)
      : st.status === 'active' && st.startedAt ? clock(Date.now() - st.startedAt) : '';
    let note = st.note || (st.status === 'active' ? (m.ai ? 'working…' : 'running…') : st.status === 'pending' ? '' : st.status);
    if (key === 'review' && st.status === 'active' && s.status === 'awaiting-approval') note = 'waiting for you';
    const name = m.ai && s.agent ? `${s.agent.name} ${m.label}` : m.label;
    return `<div class="tl-item ${st.status}"><div class="tl-ico">${icon(ico)}</div><div style="min-width:0">
      <div class="tl-name">${esc(name)}${m.ai ? '<span class="tl-tag">AI</span>' : ''}<span class="tl-time">${dur}</span></div>
      <div class="tl-note" title="${esc(note)}">${esc(note) || '&nbsp;'}</div></div></div>`;
  }).join('');
}

function renderNow(s) {
  const card = $('#now-card');
  if (!ACTIVE.has(s.status)) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const st = s.stages[s.stage] || {};
  const waiting = s.status === 'awaiting-approval';
  const who = waiting ? 'Waiting for your approval' : s.working ? s.working.label : (STAGES[s.stage] || {}).label || 'Working';
  const role = waiting ? 'human' : s.working ? s.working.role : 'system';
  const stageMs = s.working ? Date.now() - s.working.since : st.startedAt ? Date.now() - st.startedAt : 0;
  const recent = app.logs.slice(-4).reverse();
  const ico = { investigator: 'search', repairer: 'wrench', runner: 'terminal', human: 'user' }[role] || 'cpu';
  card.innerHTML = `<div class="now-top">
      <div class="now-ico ${esc(role)}${waiting ? '' : ' spinning'}">${icon(ico)}</div>
      <div class="now-main">
        <div class="now-who">${esc(who)}</div>
        <div class="now-what">${waiting ? 'Review the diff below, then Approve or Reject.' : s.cancelRequested ? 'Stopping…' : esc((STAGES[s.stage] || {}).label || '') + ' · working…'}</div>
      </div>
      <div class="now-times"><div><span>Stage</span><b>${clock(stageMs)}</b></div><div><span>Run</span><b>${clock(Date.now() - new Date(s.createdAt))}</b></div></div>
      <button class="btn btn-stop" data-stop ${s.cancelRequested ? 'disabled' : ''}>${icon('stop')} Stop Run</button>
    </div>
    <div class="now-feed"><span class="section-label">Latest activity</span>${recent.length ? recent.map(l => `<div class="feed-line ${esc(l.level)}">${esc(l.text)}</div>`).join('') : '<div class="feed-line muted">Starting…</div>'}</div>`;
  $('[data-stop]', card).addEventListener('click', stopRun);
}

async function stopRun() {
  if (!app.runId) return;
  $('#btn-stop').disabled = true;
  try {
    await post(`/api/runs/${app.runId}/cancel`);
    toast('Stopping run…');
  } catch (err) {
    toast(err.message, true);
  }
}

function upsertCard(key, html, cls = '') {
  let c = app.cards.get(key);
  if (!c) {
    const el = document.createElement('section');
    el.className = 'card rcard ' + cls;
    $('#cards').appendChild(el);
    c = { el, html: '' };
    app.cards.set(key, c);
    if (app.state && ACTIVE.has(app.state.status)) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
  }
  if (cls) c.el.className = 'card rcard ' + cls;
  if (c.html !== html) { c.el.innerHTML = html; c.html = html; bindCard(key, c.el); }
  return c.el;
}
function removeCard(key) { const c = app.cards.get(key); if (c) { c.el.remove(); app.cards.delete(key); } }

function renderCards(s) {
  if (s.localization) upsertCard('locate', locateCard(s)); else removeCard('locate');
  if (s.red && s.tests) upsertCard('repro', reproCard(s)); else removeCard('repro');
  if (s.fix && s.diff) upsertCard('fix', fixCard(s)); else removeCard('fix');
  if (!ACTIVE.has(s.status)) {
    const [html, tone] = resultCard(s);
    const el = upsertCard('result', html, 'result-hero ' + tone);
    if (!el.dataset.scrolled) { el.dataset.scrolled = '1'; setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200); }
    if (s.status === 'completed' && !app.consoleCollapsed) setConsole(true);
  } else removeCard('result');
}

function locateCard(s) {
  const l = s.localization;
  const conf = String(l.confidence || 'medium').toLowerCase();
  return `<div class="rcard-head"><div class="rcard-ico ai">${icon('search')}</div>
    <div><div class="rcard-title">Bug located</div><div class="rcard-sub">${esc(s.agent ? s.agent.name : '')} Investigator</div></div></div>
    <div class="loc-row"><span class="tag">${icon('file')}${esc(l.file)}</span><span class="tag">${icon('terminal')}${esc(l.function)}()</span><span class="tag conf-${esc(conf)}">${esc(conf)} confidence</span></div>
    <p>${esc(l.analysis)}</p>`;
}

function res(status) {
  if (status === 'passed') return `<span class="res pass">${icon('check')}PASS</span>`;
  if (status === 'failed') return `<span class="res fail">${icon('x')}FAIL</span>`;
  return '<span class="res none">—</span>';
}
function firstLine(m) {
  const lines = String(m || '').split('\n').map(x => x.trim()).filter(Boolean);
  const exp = lines.find(l => /^Expected/.test(l)), rec = lines.find(l => /^Received/.test(l));
  return exp && rec ? `${exp}  ·  ${rec}` : (lines[0] || '').slice(0, 160);
}

function reproCard(s) {
  const red = s.red, green = s.green;
  const why = new Map((s.tests.list || []).map(t => [t.name, t.why]));
  const greenBy = new Map((green?.tests || []).map(t => [t.name, t]));
  const rows = red.tests.map(t => {
    const g = greenBy.get(t.name);
    const after = g ? res(g.status) : s.stages.verify.status === 'active' ? '<span class="res pending">…</span>' : '<span class="res none">—</span>';
    const msg = t.status === 'failed' && !g ? `<span class="msg">${esc(firstLine(t.message))}</span>` : '';
    return `<div class="test-row"><div class="test-name">${esc(t.name)}${why.get(t.name) ? `<span class="why">${esc(why.get(t.name))}</span>` : ''}${msg}</div>${res(t.status)}${after}</div>`;
  }).join('');
  const ok = red.outcome === 'fail';
  return `<div class="rcard-head"><div class="rcard-ico ${ok ? 'red' : 'amber'}">${icon(ok ? 'bug' : 'info')}</div>
    <div><div class="rcard-title">${ok ? 'Bug reproduced (RED)' : 'Tests passed on the original code'}</div>
    <div class="rcard-sub">${esc(s.tests.path)} · run by ${red.runner === 'pytest' ? 'pytest' : 'Jest'}, not the AI · locked ${esc(s.tests.hash.slice(0, 12))}…</div></div>
    ${s.artifacts.tests ? `<div class="right"><a class="btn btn-ghost btn-sm" href="/api/runs/${s.id}/files/${encodeURIComponent(s.tests.path.split('/').pop())}">${icon('download')} Test file</a></div>` : ''}</div>
    <div class="stat-row">
      <div class="stat red"><div class="num">${red.failed}</div><div class="lbl">failing on original code</div></div>
      <div class="stat"><div class="num">${red.total}</div><div class="lbl">regression tests</div></div>
      <div class="stat ${green ? (green.outcome === 'pass' ? 'green' : 'red') : ''}"><div class="num">${green ? `${green.passed}/${green.total}` : '—'}</div><div class="lbl">passing on candidate</div></div>
    </div>
    <div class="tests"><div class="tests-head"><span>Test</span><span>RED</span><span>GREEN</span></div>${rows}</div>`;
}

function parseDiff(text) {
  const files = [];
  let cur = null, oldN = 0, newN = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('===')) continue;
    if (line.startsWith('--- ')) { cur = { name: '', rows: '' }; files.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('+++ ')) { cur.name = line.slice(4).replace(/^b\//, '').split('\t')[0].trim(); continue; }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { oldN = +h[1]; newN = +h[2]; cur.rows += `<tr class="hunk"><td colspan="4">${esc(line)}</td></tr>`; continue; }
    if (line.startsWith('\\')) continue;
    const sign = line[0], code = esc(line.slice(1));
    if (sign === '+') cur.rows += `<tr class="add"><td class="ln"></td><td class="ln">${newN++}</td><td class="sign">+</td><td class="code">${code}</td></tr>`;
    else if (sign === '-') cur.rows += `<tr class="del"><td class="ln">${oldN++}</td><td class="ln"></td><td class="sign">−</td><td class="code">${code}</td></tr>`;
    else if (sign === ' ') cur.rows += `<tr><td class="ln">${oldN++}</td><td class="ln">${newN++}</td><td class="sign"></td><td class="code">${code}</td></tr>`;
  }
  return files.filter(f => f.name);
}

function fixCard(s) {
  const files = parseDiff(s.diff);
  const add = s.fix.files.reduce((a, f) => a + f.additions, 0), del = s.fix.files.reduce((a, f) => a + f.deletions, 0);
  const verified = s.green && s.green.outcome === 'pass';
  const tabs = files.map((f, i) => { const m = s.fix.files.find(x => x.path === f.name) || { additions: 0, deletions: 0 };
    return `<button class="diff-tab ${i ? '' : 'active'}" data-i="${i}">${esc(f.name)} <span class="add">+${m.additions}</span><span class="del">−${m.deletions}</span></button>`; }).join('');
  const bodies = files.map((f, i) => `<div class="diff-body" data-i="${i}" ${i ? 'hidden' : ''}><table>${f.rows}</table></div>`).join('');
  const trunc = s.diffMeta && s.diffMeta.truncated
    ? `<div class="notice warn">${icon('alert')} Diff truncated for display: showing ${s.diffMeta.shownLines} of ${s.diffMeta.totalLines} lines. <a href="/api/runs/${s.id}/files/fix.patch">Download the complete patch</a>.</div>` : '';
  return `<div class="rcard-head"><div class="rcard-ico ${verified ? 'green' : 'ai'}">${icon('wrench')}</div>
    <div><div class="rcard-title">${verified ? 'Verified candidate repair' : s.green ? 'Candidate repair (NOT verified)' : 'Candidate repair'}</div>
    <div class="rcard-sub">${esc(s.agent ? s.agent.name : '')} Repairer · ${s.fix.files.length} file${s.fix.files.length > 1 ? 's' : ''} · <span class="t-green">+${add}</span> <span class="t-red">−${del}</span></div></div>
    <div class="right"><button class="btn btn-ghost btn-sm" data-copy>${icon('copy')} Copy patch</button></div></div>
    <div class="rootcause"><b>Root cause</b><p>${esc(s.fix.rootCause)}</p><b>Fix summary</b><p>${esc(s.fix.summary)}</p></div>
    ${trunc}<div class="diff"><div class="diff-tabs">${tabs}</div>${bodies}</div>`;
}

function resultCard(s) {
  const dl = (name, title, sub, ico, primary) => `<a class="dl ${primary ? 'primary' : ''}" href="/api/runs/${s.id}/files/${name}"><span class="dl-ico">${icon(ico)}</span><div><div class="dl-t">${title}</div><div class="dl-s">${sub}</div></div></a>`;
  const reportBtn = s.artifacts.reportMd ? `<button class="dl" data-report><span class="dl-ico">${icon('file')}</span><div><div class="dl-t">View report</div><div class="dl-s">Markdown · JSON</div></div></button>` : '';
  const actions = runActions(s, true);

  if (s.status === 'completed') {
    return [`<div class="rh-top"><div class="rh-badge">${icon('check')}</div>
      <div><div class="rh-title">VERIFIED REPAIR</div><div class="rh-sub">${esc(s.localization.function)}() in ${esc(s.localization.file)} · ${esc(s.agent ? s.agent.name : '')} · ${s.bobCallCount} Bob call${s.bobCallCount === 1 ? '' : 's'}</div></div></div>
      <div class="red-green">
        <div class="rg-box red"><div class="rg-label">RED</div><div class="rg-num">${s.red.failed} failed</div><div class="rg-cap">of ${s.red.total} tests on the original code</div></div>
        <div class="rg-arrow">${icon('arrow')}</div>
        <div class="rg-box green"><div class="rg-label">GREEN</div><div class="rg-num">${s.finalGreen ? s.finalGreen.passed : s.green.passed} passed</div><div class="rg-cap">same locked tests · final GREEN on the approved code</div></div>
      </div>
      <div class="proofs">
        <span class="proof">${icon('lock')} Test fingerprint ${esc(s.tests.hash.slice(0, 10))}… unchanged</span>
        <span class="proof">${icon('shield')} Exact verified candidate applied</span>
        <span class="proof">${icon('user')} Approved by ${esc(s.approval.by)}</span>
        ${s.writeBack ? `<span class="proof">${icon('folder')} Written to ${esc(s.writeBack.folder)}</span>` : ''}
      </div>
      <div class="downloads">${dl('fixed-code.zip', 'Download fixed code', 'Complete project · .zip', 'package', true)}${dl('fix.patch', 'Patch file', 'git apply fix.patch', 'branch')}${reportBtn}${dl('report.json', 'Report JSON', 'Machine-readable', 'download')}</div>
      ${actions}`, 'good'];
  }

  let title, text, ico = 'alert', tone = 'bad';
  const demoRun = s.source.type === 'demo';
  if (s.status === 'not-reproduced') { title = 'BUG NOT REPRODUCED'; text = 'The tests ran successfully and zero assertions failed on the original code, so no repair was attempted. Add more detail (inputs, expected vs actual) and retry.'; ico = 'info'; tone = 'warn'; }
  else if (s.status === 'repair-not-verified') { title = 'REPAIR NOT VERIFIED'; text = `The candidate still fails ${s.green ? s.green.failed : 'some'} of the locked regression tests. Nothing was applied. "Retry Fix" makes exactly one more Repairer call.`; tone = 'warn'; }
  else if (s.status === 'rejected') { title = 'REPAIR REJECTED'; text = 'Nothing was changed. The report keeps the evidence and the proposed diff.'; ico = 'x'; tone = 'warn'; }
  else if (s.status === 'cancelled') { title = 'RUN CANCELLED'; text = `Stopped during "${(STAGES[s.failedStage] || {}).label || s.failedStage}". Evidence collected so far is kept. No source code was applied.`; ico = 'stop'; tone = 'warn'; }
  else if (s.status === 'timed-out') { title = 'RUN TIMED OUT'; text = `${s.error} (stage: ${(STAGES[s.failedStage] || {}).label || s.failedStage}). Nothing was applied.`; ico = 'hourglass'; }
  else if (s.status === 'interrupted') { title = 'RUN INTERRUPTED'; text = `${s.error} The server stopped while this run was at "${(STAGES[s.failedStage] || {}).label || s.failedStage || 'unknown'}". Nothing retries automatically.`; }
  else {
    const [t, x] = ERROR_EXPLAIN[s.errorType] || ERROR_EXPLAIN.internal;
    title = demoRun && s.errorType === 'environment' ? 'DEMO FAILED' : demoRun && s.errorType === 'ai-unavailable' ? 'DEMO CANNOT START' : 'RUN FAILED';
    text = `${t}. ${x}`;
  }
  const detail = s.error && !['not-reproduced', 'rejected'].includes(s.status)
    ? `<details class="err-detail"><summary>View error</summary><pre>${esc(`${s.errorType || ''} · stage: ${s.failedStage || ''}\n${s.error}`)}${s.bobDebug ? esc(`\n\n--- agent stdout (bounded) ---\n${s.bobDebug.stdout}\n--- agent stderr (bounded) ---\n${s.bobDebug.stderr}`) : ''}</pre></details>` : '';
  return [`<div class="rh-top"><div class="rh-badge">${icon(ico)}</div><div><div class="rh-title">${esc(title)}</div><div class="rh-sub">${esc(text)}</div></div></div>
    ${detail}<div class="downloads" style="margin-top:16px">${reportBtn}${s.artifacts.reportJson ? dl('report.json', 'Report JSON', 'Machine-readable', 'download') : ''}</div>${actions}`, tone];
}

function runActions(s, inRun) {
  const b = [];
  if (s.canRetryFix || s.status === 'repair-not-verified' || (['failed', 'timed-out', 'cancelled'].includes(s.status) && s.red && s.red.outcome === 'fail' && s.tests)) {
    b.push(`<button class="btn btn-primary btn-sm" data-act="retry-fix" data-id="${s.id}">${icon('wrench')} Retry Fix</button>`);
  }
  if (['failed', 'timed-out', 'cancelled', 'interrupted', 'not-reproduced'].includes(s.status)) {
    b.push(`<button class="btn btn-ghost btn-sm" data-act="retry" data-id="${s.id}">${icon('refresh')} Retry run</button>`);
  }
  if (s.status === 'interrupted' && !s.dismissed) b.push(`<button class="btn btn-ghost btn-sm" data-act="dismiss" data-id="${s.id}">${icon('eye')} Dismiss</button>`);
  if (!ACTIVE.has(s.status)) b.push(`<button class="btn btn-danger-ghost btn-sm" data-act="delete" data-id="${s.id}">${icon('trash')} Delete run</button>`);
  if (!b.length) return '';
  return `<div class="run-actions">${inRun ? '<span class="muted small">Actions never call an AI agent automatically.</span>' : ''}${b.join('')}</div>`;
}

async function runAction(act, id) {
  try {
    if (act === 'retry-fix') {
      if (!confirm('Retry Fix makes ONE more IBM Bob Repairer call on the same locked tests. Continue?')) return;
      await post(`/api/runs/${id}/retry-fix`);
      toast('Retry Fix started');
      location.hash = `run/${id}`;
      openRun(id, true);
    } else if (act === 'retry') {
      if (!confirm('Start a NEW run with the same code, bug report and agent? (This will make new AI calls.)')) return;
      const d = await post(`/api/runs/${id}/retry`);
      location.hash = `run/${d.id}`;
    } else if (act === 'dismiss') {
      await post(`/api/runs/${id}/dismiss`);
      toast('Run dismissed');
      if (location.hash === '#runs') loadRuns(); else location.hash = '#runs';
    } else if (act === 'delete') {
      if (!confirm('Delete this run and its files? Reports for it will be removed.')) return;
      await getJSON(`/api/runs/${id}`, { method: 'DELETE' });
      toast('Run deleted');
      if (location.hash === '#runs') loadRuns(); else if (location.hash === '#reports') loadReports(); else location.hash = '#runs';
    } else if (act === 'stop') {
      await post(`/api/runs/${id}/cancel`);
      toast('Stopping run…');
      setTimeout(loadRuns, 800);
    } else if (act === 'view') {
      location.hash = `run/${id}`;
    }
  } catch (err) {
    toast(err.message, true);
  }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b) { e.preventDefault(); runAction(b.dataset.act, b.dataset.id); }
  const r = e.target.closest('[data-report-id]');
  if (r) { e.preventDefault(); openReport(r.dataset.reportId); }
});

function bindCard(key, el) {
  if (key === 'fix') {
    $$('.diff-tab', el).forEach(t => t.addEventListener('click', () => {
      $$('.diff-tab', el).forEach(x => x.classList.toggle('active', x === t));
      $$('.diff-body', el).forEach(b => { b.hidden = b.dataset.i !== t.dataset.i; });
    }));
    $('[data-copy]', el)?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(app.state.diff); toast('Patch copied'); } catch { toast('Could not copy', true); }
    });
  }
  if (key === 'result') $('[data-report]', el)?.addEventListener('click', () => openReport(app.runId));
}

function renderApproval(s) {
  const bar = $('#approve-bar');
  if (s.status !== 'awaiting-approval') { bar.classList.add('hidden'); return; }
  const wasHidden = bar.classList.contains('hidden');
  bar.classList.remove('hidden');
  $('#approve-title').textContent = `Repair verified: ${s.green.passed}/${s.green.total} locked tests pass`;
  $('#approve-sub').textContent = `RED ${s.red.failed} failed → GREEN ${s.green.passed} passed · ${s.fix.files.length} file(s) changed`;
  $('#approve-wb-wrap').classList.toggle('hidden', s.source.type !== 'local');
  if (wasHidden) {
    $('#approve-writeback').checked = !!s.options.writeBack;
    $('#approve-tests').checked = s.options.includeTests !== false;
    $('#btn-approve').disabled = false; $('#btn-reject').disabled = false;
    setTimeout(() => app.cards.get('fix')?.el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }
}

async function decide(decision) {
  $('#btn-approve').disabled = true; $('#btn-reject').disabled = true;
  try {
    await post(`/api/runs/${app.runId}/decision`, { decision, writeBack: $('#approve-writeback').checked, includeTests: $('#approve-tests').checked });
    $('#approve-bar').classList.add('hidden');
    toast(decision === 'approved' ? 'Approved: running final GREEN and delivering…' : 'Repair rejected');
  } catch (err) {
    toast(err.message, true);
    $('#btn-approve').disabled = false; $('#btn-reject').disabled = false;
  }
}

// ─── share (Jira / Slack / Teams) ────────────────────────────────────────────
const TARGETS = [
  ['jira', 'Jira', 'Create Jira Issue', 'bug'],
  ['slack', 'Slack', 'Send to Slack', 'message'],
  ['teams', 'Microsoft Teams', 'Send to Teams', 'message'],
];

function renderShare(s) {
  const card = $('#share-card');
  if (!s || !(s.red || ['completed', 'rejected', 'repair-not-verified', 'not-reproduced'].includes(s.status))) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const cell = ([id, name, action, ico]) => {
    const conf = app.integ[id] && app.integ[id].configured;
    const r = (s.integrations || {})[id];
    let st = conf ? '<span class="i-state on">● Connected</span>' : '<span class="i-state off">○ Not configured</span>';
    if (r) st = r.status === 'failed' ? `<span class="i-state bad" title="${esc(r.error)}">FAILED: ${esc(String(r.error || '').slice(0, 60))}</span>`
      : r.status === 'created' ? `<span class="i-state good">CREATED: ${r.issueUrl ? `<a href="${esc(r.issueUrl)}" target="_blank" rel="noopener">${esc(r.issueKey)}</a>` : esc(r.issueKey)}</span>`
      : '<span class="i-state good">SENT</span>';
    return `<div class="share-item"><div class="share-name">${icon(ico)}<b>${name}</b></div>${st}
      <button class="btn btn-ghost btn-sm" data-share="${id}" ${conf ? '' : 'disabled'}>${action}</button></div>`;
  };
  const repair = s.status === 'completed' ? 'VERIFIED' : s.green && s.green.outcome === 'pass' ? 'VERIFIED (awaiting approval)' : s.status === 'repair-not-verified' ? 'NOT VERIFIED' : s.red ? 'REPRODUCED' : '—';
  const html = `<div class="rcard-head"><div class="rcard-ico ai">${icon('share')}</div><div><div class="rcard-title">Share</div>
    <div class="rcard-sub">Repair status: <b>${repair}</b>. Integration delivery is tracked separately and never changes it.</div></div>
    ${s.artifacts.reportMd ? `<div class="right"><a class="btn btn-ghost btn-sm" href="/api/runs/${s.id}/files/report.md">${icon('download')} Download Report</a></div>` : ''}</div>
    <div class="share-grid">${TARGETS.map(cell).join('')}</div>`;
  if (card.dataset.html !== html) {
    card.innerHTML = html;
    card.dataset.html = html;
    $$('[data-share]', card).forEach(b => b.addEventListener('click', () => share(b.dataset.share, b)));
  }
}

async function share(target, btn) {
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span> Sending…';
  try {
    const r = await fetch(`/api/runs/${app.runId}/integrations/${target}`, { method: 'POST' });
    const d = await r.json();
    if (r.status === 502) toast(`${target}: delivery failed: ${d.error}`, true);
    else if (!r.ok) toast(d.error, true);
    else toast(target === 'jira' ? `Jira issue ${d.issueKey} created` : `Sent to ${target === 'teams' ? 'Microsoft Teams' : 'Slack'}`);
    const s = await getJSON(`/api/runs/${app.runId}`);
    render(s);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.innerHTML = old;
    btn.disabled = false;
  }
}

// ─── runs / reports / agents / integrations pages ────────────────────────────
function statusPill(st) { const [c, l] = STATUS[st] || ['', st]; return `<span class="status-pill ${c}">${esc(l)}</span>`; }

async function loadRuns() {
  const box = $('#runs-table');
  try {
    const runs = await getJSON('/api/runs' + ($('#runs-show-dismissed').checked ? '?all=1' : ''));
    const active = runs.filter(r => ACTIVE.has(r.status)).length;
    const badge = $('#nav-active');
    badge.textContent = active; badge.classList.toggle('hidden', !active);
    box.innerHTML = runs.length ? `<div class="rt-head"><span>Run</span><span>Bug</span><span>Agent</span><span>Started</span><span>Elapsed</span><span>Status</span><span></span></div>` +
      runs.map(r => {
        const acts = [];
        if (ACTIVE.has(r.status)) acts.push(`<button class="btn btn-stop btn-sm" data-act="stop" data-id="${r.id}">${icon('stop')} Stop</button>`);
        acts.push(`<button class="btn btn-ghost btn-sm" data-act="view" data-id="${r.id}">${icon('eye')} ${['failed', 'timed-out', 'interrupted'].includes(r.status) ? 'View Error' : 'View'}</button>`);
        if (r.canRetryFix) acts.push(`<button class="btn btn-ghost btn-sm" data-act="retry-fix" data-id="${r.id}">${icon('wrench')} Retry Fix</button>`);
        else if (['failed', 'timed-out', 'interrupted', 'cancelled'].includes(r.status)) acts.push(`<button class="btn btn-ghost btn-sm" data-act="retry" data-id="${r.id}">${icon('refresh')} Retry</button>`);
        if (r.status === 'interrupted' && !r.dismissed) acts.push(`<button class="btn btn-ghost btn-sm" data-act="dismiss" data-id="${r.id}">Dismiss</button>`);
        if (!ACTIVE.has(r.status)) acts.push(`<button class="icon-btn sm" title="Delete" aria-label="Delete run" data-act="delete" data-id="${r.id}">${icon('trash')}</button>`);
        return `<div class="rt-row"><span class="mono small">${esc(r.id)}<br><span class="muted">${esc(r.source.label)}</span></span>
          <span class="rt-bug">${esc(r.bug)}</span><span>${esc(r.agent ? r.agent.name : '—')}</span>
          <span class="small">${new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          <span class="mono small">${fmtDur(r.elapsedMs)}</span><span>${statusPill(r.status)}</span><span class="rt-acts">${acts.join('')}</span></div>`;
      }).join('') : '<p class="empty">No runs yet. Try the <a href="#/">live demo</a>.</p>';
  } catch (err) {
    box.innerHTML = `<p class="empty">Could not load runs: ${esc(err.message)}</p>`;
  }
}

async function loadReports() {
  const box = $('#reports-table');
  try {
    const runs = (await getJSON('/api/runs?all=1')).filter(r => r.hasReport);
    box.innerHTML = runs.length ? `<div class="rt-head rep"><span>Run</span><span>Bug</span><span>Status</span><span>Finished</span><span></span></div>` +
      runs.map(r => `<div class="rt-row rep"><span class="mono small">${esc(r.id)}<br><span class="muted">${esc(r.source.label)}</span></span>
        <span class="rt-bug">${esc(r.bug)}</span><span>${statusPill(r.status)}</span>
        <span class="small">${r.finishedAt ? new Date(r.finishedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
        <span class="rt-acts"><button class="btn btn-ghost btn-sm" data-report-id="${r.id}">${icon('eye')} View</button>
        <a class="btn btn-ghost btn-sm" href="/api/runs/${r.id}/files/report.md">.md</a><a class="btn btn-ghost btn-sm" href="/api/runs/${r.id}/files/report.json">.json</a></span></div>`).join('')
      : '<p class="empty">No reports yet.</p>';
  } catch (err) {
    box.innerHTML = `<p class="empty">Could not load reports: ${esc(err.message)}</p>`;
  }
}

function renderAgents() {
  const names = { bob: 'IBM', watsonx: 'IBM', claude: 'Anthropic', openai: 'OpenAI', gemini: 'Google', grok: 'xAI' };
  $('#agent-grid').innerHTML = app.agents.map(a => {
    const state = a.operational ? ['on', 'Connected'] : a.implemented ? ['off', 'Not configured'] : ['later', 'Coming soon'];
    const selected = a.id === 'bob' && a.operational;
    return `<div class="agent-card ${a.operational ? 'live' : ''}">
      <div class="agent-top"><span class="agent-radio ${selected ? 'sel' : ''}"></span><div><b>${esc(a.name === 'ChatGPT' ? 'ChatGPT (OpenAI)' : a.name)}</b><div class="muted small">${esc(names[a.id] || '')}${a.version ? ' · ' + esc(a.version) : ''}</div></div>
        ${selected ? '<span class="sel-tag">Selected</span>' : ''}</div>
      <div class="agent-state ${state[0]}"><span class="dot"></span>${state[1]}${a.experimental ? ' · experimental' : ''}</div>
      ${a.detail && a.detail !== 'Connected' ? `<p class="muted small">${esc(a.detail)}</p>` : ''}
      <div class="agent-flags"><span class="${a.implemented ? 'yes' : 'no'}">${a.implemented ? 'Implemented' : 'Skeleton'}</span><span class="${a.operational ? 'yes' : 'no'}">${a.operational ? 'Operational' : 'Not operational'}</span></div>
    </div>`;
  }).join('');
}

function renderIntegrations() {
  const info = {
    jira: ['Jira', 'bug', 'Creates a Bug issue with the report, RED/GREEN evidence, root cause and diff. Labels: bugrep-ai, ai-repair.', ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'], 'Create Issue'],
    slack: ['Slack', 'message', 'Posts a run summary (bug, file, function, RED, repair, GREEN, status, link) through an Incoming Webhook.', ['SLACK_WEBHOOK_URL'], 'Send Report'],
    teams: ['Microsoft Teams', 'message', 'Posts an Adaptive Card with the same summary through a Teams Workflows / webhook URL.', ['TEAMS_WEBHOOK_URL'], 'Send Report'],
  };
  $('#integ-grid').innerHTML = Object.entries(info).map(([id, [name, ico, text, vars, act]]) => {
    const on = app.integ[id] && app.integ[id].configured;
    return `<div class="integ-card"><div class="integ-top"><div class="integ-ico">${icon(ico)}</div><b>${name}</b>
      <span class="i-state ${on ? 'on' : 'off'}">${on ? '● Connected' : '○ Not configured'}</span></div>
      <p class="muted small">${text}</p>
      <div class="env-list">${vars.map(v => `<code>${v}</code>`).join('')}</div>
      <p class="small">${on ? `Use <b>${act}</b> from any run's Share panel.` : 'Add the variables above to <code>bugrep-ai/.env</code> and restart the server.'}</p></div>`;
  }).join('');
}

// ─── report modal ────────────────────────────────────────────────────────────
async function openReport(id) {
  try {
    const r = await fetch(`/api/runs/${id}/files/report.md?inline=1`);
    if (!r.ok) throw new Error('Report not ready yet');
    $('#report-body').innerHTML = renderMarkdown(await r.text());
    $('#report-dl').href = `/api/runs/${id}/files/report.md`;
    $('#report-modal').classList.remove('hidden');
  } catch (err) {
    toast(err.message, true);
  }
}

function renderMarkdown(md) {
  const out = [];
  const lines = md.split('\n');
  let i = 0;
  const inline = t => {
    const codes = [];
    const s = esc(t).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,])/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[n]}</code>`);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim(); const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      const body = buf.map(l => { const e = esc(l); if (lang !== 'diff') return e;
        if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="d-add">${e}</span>`;
        if (l.startsWith('-') && !l.startsWith('---')) return `<span class="d-del">${e}</span>`;
        if (l.startsWith('@@')) return `<span class="d-hunk">${e}</span>`; return e; }).join('\n');
      out.push(`<pre class="${lang === 'diff' ? '' : 'wrap'}"><code>${body}</code></pre>`);
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      out.push(`<table><thead><tr>${cells(rows[0]).map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (line.startsWith('> ')) { out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); i++; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^- /.test(line)) { const items = []; while (i < lines.length && /^- /.test(lines[i])) items.push(`<li>${inline(lines[i++].slice(2))}</li>`); out.push(`<ul>${items.join('')}</ul>`); continue; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  return out.join('\n');
}
