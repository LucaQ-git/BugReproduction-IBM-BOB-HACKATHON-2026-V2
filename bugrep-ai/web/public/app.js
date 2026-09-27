// web/public/app.js — BugRep AI front-end (no framework, no build step)
'use strict';

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;

const ENGINE_LABEL = { bob: 'IBM Bob Shell', watsonx: 'IBM watsonx.ai', replay: 'Demo replay' };
const STAGE_META = {
  acquire:   { label: 'Fetch code',      icon: 'download' },
  index:     { label: 'Map codebase',    icon: 'map' },
  test:      { label: 'Test Agent',      icon: 'flask',   ai: true },
  reproduce: { label: 'Reproduce bug',   icon: 'terminal' },
  fix:       { label: 'Fix Agent',       icon: 'wrench',  ai: true },
  verify:    { label: 'Verify fix',      icon: 'shield' },
  review:    { label: 'Your approval',   icon: 'user' },
  deliver:   { label: 'Deliver code',    icon: 'package' },
  report:    { label: 'Report',          icon: 'file' },
};

const app = {
  health: null,
  source: 'local',
  upload: null,
  runId: null,
  es: null,
  state: null,
  cards: new Map(),
  timer: null,
  consoleCollapsed: false,
};

// ─── boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadHealth();
  bindHome();
  bindRunView();
  const m = location.hash.match(/^#run\/([\w-]+)/);
  if (m) openRun(m[1]);
});

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#run\/([\w-]+)/);
  if (m && m[1] !== app.runId) openRun(m[1]);
  if (!m && location.hash !== '#new-run' && $('#view-run').classList.contains('active')) showView('home');
});

function initTheme() {
  let t = 'dark';
  try { t = localStorage.getItem('bugrep-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); } catch { /* ignore */ }
  setTheme(t);
  $('#btn-theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#btn-theme').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
  try { localStorage.setItem('bugrep-theme', t); } catch { /* ignore */ }
}

async function loadHealth() {
  try {
    const h = await (await fetch('/api/health')).json();
    app.health = h;
    const e = h.engines;
    $('#engine-chips').innerHTML = [
      chip('Bob Shell', e.bob), chip('watsonx', e.watsonx),
    ].join('');
    const lp = $('#local-path');
    if (!lp.value) lp.value = h.defaultLocalPath || '';
    const sel = $('#opt-engine');
    for (const opt of sel.options) {
      if (opt.value === 'bob' && !e.bob.ready) opt.textContent = 'IBM Bob Shell (not configured)';
      if (opt.value === 'watsonx' && !e.watsonx.ready) opt.textContent = 'IBM watsonx.ai (not configured)';
    }
    if (!e.bob.ready && !e.watsonx.ready) {
      showFormNote('No AI engine is configured yet. Add BOBSHELL_API_KEY or watsonx keys to .env. The live demo works without them.');
    }
  } catch {
    $('#engine-chips').innerHTML = '<span class="chip off"><span class="dot"></span>Server offline</span>';
  }
}

function chip(name, s) {
  return `<span class="chip ${s.ready ? 'on' : 'off'}" title="${esc(s.detail || '')}"><span class="dot"></span>${name}</span>`;
}

function showFormNote(msg) {
  const el = $('#form-error');
  el.classList.remove('hidden');
  el.style.color = 'var(--muted)';
  el.innerHTML = icon('info') + esc(msg);
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
  $('#btn-demo').addEventListener('click', runDemo);
  $$('[data-nav="home"]').forEach(el => el.addEventListener('click', e => { e.preventDefault(); goHome(); }));

  $('#btn-runs').addEventListener('click', openDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#report-close').addEventListener('click', () => $('#report-modal').classList.add('hidden'));
  $('#report-modal').addEventListener('click', e => { if (e.target.id === 'report-modal') $('#report-modal').classList.add('hidden'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#report-modal').classList.add('hidden'); closeDrawer(); } });
}

async function uploadZip(file) {
  if (!/\.zip$/i.test(file.name)) return toast('Please choose a .zip file', true);
  const dz = $('#dropzone');
  dz.querySelector('.dz-text').innerHTML = '<b>Uploading…</b>';
  try {
    const r = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    app.upload = d;
    $('#zip-name').textContent = d.name;
    $('#zip-size').textContent = fmtBytes(d.bytes);
    dz.classList.add('hidden');
    $('#zip-pill').classList.remove('hidden');
  } catch (err) {
    toast(err.message, true);
  } finally {
    dz.querySelector('.dz-text').innerHTML = '<b>Drop a .zip here</b> or click to browse';
  }
}

function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

function formError(msg) {
  const el = $('#form-error');
  el.style.color = '';
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

  await startRun({
    source, bugReport: bug, rules: $('#rules-input').value.trim(),
    options: {
      engine: $('#opt-engine').value,
      autoApprove: $('#opt-auto').checked,
      includeTests: $('#opt-tests').checked,
      writeBack: app.source === 'local' && $('#opt-writeback').checked,
    },
  });
}

async function runDemo() {
  const btn = $('#btn-demo');
  btn.disabled = true;
  try {
    const d = await (await fetch('/api/demo')).json();
    await startRun({
      source: { type: 'demo' }, bugReport: d.bugReport, rules: d.rules,
      options: { engine: $('#opt-engine').value, autoApprove: false, includeTests: true },
    });
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function startRun(payload) {
  const btn = $('#btn-start');
  btn.disabled = true;
  try {
    const r = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    location.hash = `run/${d.id}`;
    openRun(d.id);
  } catch (err) {
    formError(err.message);
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  window.scrollTo({ top: 0 });
}

function goHome() {
  if (app.es) { app.es.close(); app.es = null; }
  clearInterval(app.timer);
  app.runId = null;
  $('#approve-bar').classList.add('hidden');
  history.pushState('', document.title, location.pathname);
  showView('home');
}

// ─── run view ────────────────────────────────────────────────────────────────
function bindRunView() {
  $('#console-toggle').addEventListener('click', () => setConsole(!app.consoleCollapsed));
  $('#btn-approve').addEventListener('click', () => decide('approved'));
  $('#btn-reject').addEventListener('click', () => decide('rejected'));
}

function setConsole(collapsed) {
  app.consoleCollapsed = collapsed;
  $('#console').classList.toggle('collapsed', collapsed);
  $('#console-toggle').textContent = collapsed ? 'Expand' : 'Collapse';
}

function openRun(id) {
  if (app.es) app.es.close();
  app.runId = id;
  app.state = null;
  app.cards.clear();
  $('#cards').innerHTML = '';
  $('#console').innerHTML = '';
  $('#timeline').innerHTML = '';
  $('#approve-bar').classList.add('hidden');
  setConsole(false);
  showView('run');

  const es = new EventSource(`/api/runs/${id}/events`);
  app.es = es;
  es.addEventListener('state', e => render(JSON.parse(e.data)));
  es.addEventListener('log', e => addLog(JSON.parse(e.data)));
  es.addEventListener('end', () => { es.close(); app.es = null; });
  es.onerror = () => { /* the browser reconnects automatically while the run is live */ };

  clearInterval(app.timer);
  app.timer = setInterval(updateElapsed, 1000);
}

function addLog(l) {
  const box = $('#console');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const cls = { 'Test Agent': 'test', 'Fix Agent': 'fix', Runner: 'runner' }[l.agent] || 'system';
  const time = new Date(l.t).toLocaleTimeString([], { hour12: false });
  box.insertAdjacentHTML('beforeend',
    `<div class="log-line ${l.level}"><span class="log-time">${time}</span><span class="log-agent ${cls}">${esc(l.agent === 'system' ? 'BugRep' : l.agent)}</span><span class="log-text">${esc(l.text)}</span></div>`);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function updateElapsed() {
  const s = app.state;
  if (!s) return;
  const end = s.finishedAt ? new Date(s.finishedAt) : new Date();
  const sec = Math.max(0, Math.round((end - new Date(s.createdAt)) / 1000));
  $('#run-elapsed').textContent = sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
  if (s.finishedAt) clearInterval(app.timer);
}

const STATUS_PILL = {
  running: ['running', 'Running'], 'awaiting-approval': ['waiting', 'Needs your approval'],
  done: ['done', 'Fixed & verified'], 'not-reproduced': ['waiting', 'Not reproduced'],
  rejected: ['', 'Rejected'], failed: ['failed', 'Failed'], interrupted: ['failed', 'Interrupted'],
};

function render(s) {
  app.state = s;
  const [cls, label] = STATUS_PILL[s.status] || ['', s.status];
  const pill = $('#run-status');
  pill.className = `status-pill ${cls}`;
  pill.textContent = label;
  $('#run-source-label').textContent = s.source.label;
  $('#run-id').textContent = `run ${s.id}`;
  $('#run-engine').textContent = s.engine ? ENGINE_LABEL[s.engine] : 'choosing engine…';
  $('#demo-badge').classList.toggle('hidden', s.source.type !== 'demo');
  $('#run-bug').textContent = s.bugReport;
  $('#live-dot').classList.toggle('off', !['running', 'awaiting-approval'].includes(s.status));
  updateElapsed();

  renderTimeline(s);
  renderCards(s);

  const bar = $('#approve-bar');
  if (s.status === 'awaiting-approval') {
    const wasHidden = bar.classList.contains('hidden');
    bar.classList.remove('hidden');
    $('#approve-title').textContent = `Fix verified: ${s.green.passed}/${s.green.total} tests pass`;
    $('#approve-sub').textContent = `${s.fix.files.length} file${s.fix.files.length > 1 ? 's' : ''} changed · the same locked tests failed ${s.red.failed}× before the fix`;
    $('#approve-wb-wrap').classList.toggle('hidden', s.source.type !== 'local');
    $('#approve-writeback').checked = !!s.options.writeBack;
    $('#approve-tests').checked = s.options.includeTests !== false;
    $('#btn-approve').disabled = false;
    $('#btn-reject').disabled = false;
    if (wasHidden) setTimeout(() => app.cards.get('fix')?.el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  } else {
    bar.classList.add('hidden');
  }
}

function renderTimeline(s) {
  const html = Object.entries(STAGE_META).map(([key, m]) => {
    const st = s.stages[key] || { status: 'pending' };
    const ico = st.status === 'done' ? 'check' : st.status === 'failed' ? 'x' : (key === 'acquire' ? sourceIcon(s.source.type) : m.icon);
    const dur = st.startedAt && st.endedAt ? fmtDur(st.endedAt - st.startedAt) : '';
    let note = st.note || (st.status === 'active' ? (m.ai ? 'thinking…' : 'working…') : st.status === 'pending' ? '' : st.status);
    if (key === 'review' && st.status === 'active' && s.status === 'awaiting-approval') note = 'waiting for you';
    return `<div class="tl-item ${st.status}">
      <div class="tl-ico">${icon(ico)}</div>
      <div style="min-width:0">
        <div class="tl-name">${m.label}${m.ai ? '<span class="tl-tag">AI</span>' : ''}<span class="tl-time">${dur}</span></div>
        <div class="tl-note" title="${esc(note)}">${esc(note) || '&nbsp;'}</div>
      </div></div>`;
  }).join('');
  $('#timeline').innerHTML = html;
}

function sourceIcon(t) { return { local: 'folder', github: 'github', zip: 'archive', demo: 'play' }[t] || 'download'; }
function fmtDur(ms) { return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round(ms % 60000 / 1000)}s`; }

// Cards are created once (animated in) and then updated in place.
function upsertCard(key, html, { scroll = true } = {}) {
  let c = app.cards.get(key);
  if (!c) {
    const el = document.createElement('section');
    el.className = 'card rcard';
    el.dataset.key = key;
    $('#cards').appendChild(el);
    c = { el, html: '' };
    app.cards.set(key, c);
    if (scroll && app.state && app.state.status === 'running') {
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
    }
  }
  if (c.html !== html) {
    c.el.innerHTML = html;
    c.html = html;
    bindCard(key, c.el);
  }
  return c.el;
}

function removeCard(key) {
  const c = app.cards.get(key);
  if (c) { c.el.remove(); app.cards.delete(key); }
}

function renderCards(s) {
  // Working indicators for AI stages
  for (const [key, who, what] of [['test', 'Test Agent', 'is reading the code and writing regression tests'], ['fix', 'Fix Agent', 'is writing a patch for the failing tests']]) {
    if (s.stages[key].status === 'active') {
      const el = upsertCard(`working-${key}`, `<div class="rcard-head" style="margin:0"><div class="rcard-ico ai">${icon(key === 'test' ? 'flask' : 'wrench')}</div>
        <div><div class="rcard-title">${who} ${what}<span class="typing"><i></i><i></i><i></i></span></div>
        <div class="rcard-sub">${ENGINE_LABEL[s.engine] || 'AI'} · attempt ${s.attempts[key] || 1}</div></div></div>`);
      el.classList.add('working');
    } else {
      removeCard(`working-${key}`);
    }
  }

  if (s.localization) upsertCard('locate', locateCard(s));
  if (s.red) upsertCard('repro', reproCard(s));
  if (s.fix && s.diff) upsertCard('fix', fixCard(s));

  if (['done', 'not-reproduced', 'rejected', 'failed', 'interrupted'].includes(s.status)) {
    upsertCard('result', resultCard(s));
    const el = app.cards.get('result').el;
    el.classList.add('result-hero');
    el.classList.toggle('bad', ['failed', 'interrupted'].includes(s.status));
    el.classList.toggle('warn', ['not-reproduced', 'rejected'].includes(s.status));
    if (!el.dataset.scrolled) { el.dataset.scrolled = '1'; setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200); }
    if (s.status === 'done' && !app.consoleCollapsed) setConsole(true);
  }
}

function locateCard(s) {
  const l = s.localization;
  const conf = (l.confidence || 'medium').toLowerCase();
  return `<div class="rcard-head"><div class="rcard-ico ai">${icon('search')}</div>
    <div><div class="rcard-title">Bug located</div><div class="rcard-sub">Test Agent · ${esc(ENGINE_LABEL[s.engine] || '')}</div></div></div>
    <div class="loc-row">
      <span class="tag">${icon('file')}${esc(l.file)}</span>
      <span class="tag">${icon('terminal')}${esc(l.function)}()</span>
      <span class="tag conf-${esc(conf)}">${esc(conf)} confidence</span>
    </div>
    <p>${esc(l.analysis)}</p>`;
}

function reproCard(s) {
  const red = s.red, green = s.green;
  const why = new Map((s.tests?.list || []).map(t => [t.name, t.why]));
  const greenBy = new Map((green?.tests || []).map(t => [t.name, t]));
  const rows = red.tests.map(t => {
    const g = greenBy.get(t.name);
    const after = g ? res(g.status) : (s.stages.verify.status === 'active' ? '<span class="res pending">…</span>' : '<span class="res none">—</span>');
    const msg = t.status === 'failed' && !g ? `<span class="msg">${esc(firstLine(t.message))}</span>` : '';
    return `<div class="test-row"><div class="test-name">${esc(t.name)}${why.get(t.name) ? `<span class="why">${esc(why.get(t.name))}</span>` : ''}${msg}</div>${res(t.status)}${after}</div>`;
  }).join('');
  const reproduced = red.outcome === 'fail';
  return `<div class="rcard-head"><div class="rcard-ico ${reproduced ? 'red' : 'amber'}">${icon(reproduced ? 'bug' : 'info')}</div>
    <div><div class="rcard-title">${reproduced ? 'Bug reproduced' : red.outcome === 'pass' ? 'Tests pass on the original code' : 'Tests could not run'}</div>
    <div class="rcard-sub">${esc(s.tests.path)} · executed by ${red.runner === 'pytest' ? 'pytest' : 'Jest'}, not the AI</div></div>
    ${s.artifacts.tests ? `<div class="right"><a class="btn btn-ghost btn-sm" href="/api/runs/${s.id}/files/${encodeURIComponent(s.tests.path.split('/').pop())}">${icon('download')} Test file</a></div>` : ''}</div>
    <div class="stat-row">
      <div class="stat red"><div class="num">${red.failed}</div><div class="lbl">failing on original code</div></div>
      <div class="stat"><div class="num">${red.total}</div><div class="lbl">regression tests written</div></div>
      <div class="stat ${green ? (green.outcome === 'pass' ? 'green' : 'red') : ''}"><div class="num">${green ? `${green.passed}/${green.total}` : '—'}</div><div class="lbl">passing after fix</div></div>
    </div>
    <div class="tests"><div class="tests-head"><span>Test</span><span>Before</span><span>After</span></div>${rows}</div>`;
}

function res(status) {
  if (status === 'passed') return `<span class="res pass">${icon('check')}PASS</span>`;
  if (status === 'failed') return `<span class="res fail">${icon('x')}FAIL</span>`;
  return '<span class="res none">skip</span>';
}

function firstLine(m) {
  const lines = String(m || '').split('\n').map(x => x.trim()).filter(Boolean);
  const exp = lines.find(l => /^Expected/.test(l));
  const rec = lines.find(l => /^Received/.test(l));
  return exp && rec ? `${exp}  ·  ${rec}` : (lines[0] || '').slice(0, 160);
}

function fixCard(s) {
  const files = parseDiff(s.diff);
  const add = s.fix.files.reduce((a, f) => a + f.additions, 0);
  const del = s.fix.files.reduce((a, f) => a + f.deletions, 0);
  const tabs = files.map((f, i) => {
    const meta = s.fix.files.find(x => x.path === f.name) || { additions: 0, deletions: 0 };
    return `<button class="diff-tab ${i === 0 ? 'active' : ''}" data-i="${i}">${esc(f.name)} <span class="add">+${meta.additions}</span><span class="del">−${meta.deletions}</span></button>`;
  }).join('');
  const bodies = files.map((f, i) => `<div class="diff-body" data-i="${i}" ${i ? 'hidden' : ''}><table>${f.rows}</table></div>`).join('');
  return `<div class="rcard-head"><div class="rcard-ico ai">${icon('wrench')}</div>
    <div><div class="rcard-title">Proposed fix</div><div class="rcard-sub">Fix Agent · ${s.fix.files.length} file${s.fix.files.length > 1 ? 's' : ''} · <span style="color:var(--green)">+${add}</span> <span style="color:var(--red)">−${del}</span></div></div>
    <div class="right"><button class="btn btn-ghost btn-sm" data-copy>${icon('copy')} Copy patch</button></div></div>
    <div class="rootcause"><b>Root cause</b><p>${esc(s.fix.rootCause)}</p><b>What changed</b><p>${esc(s.fix.summary)}</p></div>
    <div class="diff"><div class="diff-tabs">${tabs}</div>${bodies}</div>`;
}

function bindCard(key, el) {
  if (key === 'fix') {
    $$('.diff-tab', el).forEach(t => t.addEventListener('click', () => {
      $$('.diff-tab', el).forEach(x => x.classList.toggle('active', x === t));
      $$('.diff-body', el).forEach(b => { b.hidden = b.dataset.i !== t.dataset.i; });
    }));
    $('[data-copy]', el)?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(app.state.diff); toast('Patch copied to clipboard'); } catch { toast('Could not copy', true); }
    });
  }
  if (key === 'result') {
    $('[data-report]', el)?.addEventListener('click', openReport);
  }
}

function parseDiff(text) {
  const files = [];
  let cur = null, oldN = 0, newN = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('===')) continue;
    if (line.startsWith('--- ')) { cur = { name: '', rows: '' }; files.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('+++ ')) { cur.name = line.slice(4).replace(/^b\//, '').split('\t')[0].trim(); continue; }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (h) { oldN = +h[1]; newN = +h[2]; cur.rows += `<tr class="hunk"><td colspan="4">${esc(line)}</td></tr>`; continue; }
    if (line.startsWith('\\')) continue;
    const sign = line[0], code = esc(line.slice(1));
    if (sign === '+') cur.rows += `<tr class="add"><td class="ln"></td><td class="ln">${newN++}</td><td class="sign">+</td><td class="code">${code}</td></tr>`;
    else if (sign === '-') cur.rows += `<tr class="del"><td class="ln">${oldN++}</td><td class="ln"></td><td class="sign">−</td><td class="code">${code}</td></tr>`;
    else if (sign === ' ') cur.rows += `<tr><td class="ln">${oldN++}</td><td class="ln">${newN++}</td><td class="sign"></td><td class="code">${code}</td></tr>`;
  }
  return files.filter(f => f.name);
}

function resultCard(s) {
  const dl = (name, title, sub, ico, primary) =>
    `<a class="dl ${primary ? 'primary' : ''}" href="/api/runs/${s.id}/files/${name}"><span class="dl-ico">${icon(ico)}</span><div><div class="dl-t">${title}</div><div class="dl-s">${sub}</div></div></a>`;
  const reportBtn = s.artifacts.reportMd
    ? `<button class="dl" data-report><span class="dl-ico">${icon('file')}</span><div><div class="dl-t">View report</div><div class="dl-s">Markdown · JSON</div></div></button>` : '';

  if (s.status === 'done') {
    const wb = s.writeBack ? `<span class="proof">${icon('folder')} Written to ${esc(s.writeBack.folder)}</span>` : '';
    return `<div class="rh-top"><div class="rh-badge">${icon('check')}</div>
      <div><div class="rh-title">Bug fixed &amp; verified</div><div class="rh-sub">${esc(s.localization.function)}() in ${esc(s.localization.file)} · ${ENGINE_LABEL[s.engine]}${s.engine === 'replay' ? ' (pre-recorded answers, live test runs)' : ''}</div></div></div>
      <div class="red-green">
        <div class="rg-box red"><div class="rg-label">BEFORE · RED</div><div class="rg-num">${s.red.failed} failing</div><div class="rg-cap">of ${s.red.total} tests on the original code</div></div>
        <div class="rg-arrow">${icon('arrow')}</div>
        <div class="rg-box green"><div class="rg-label">AFTER · GREEN</div><div class="rg-num">${s.green.passed}/${s.green.total} pass</div><div class="rg-cap">same locked tests on the fixed code</div></div>
      </div>
      <div class="proofs">
        <span class="proof">${icon('lock')} Suite fingerprint ${esc(s.tests.hash.slice(0, 10))}… unchanged</span>
        <span class="proof">${icon('terminal')} Tests executed by ${s.green.runner === 'pytest' ? 'pytest' : 'Jest'}</span>
        <span class="proof">${icon('user')} Approved by ${esc(s.approval.by)}</span>${wb}
      </div>
      <div class="downloads">
        ${dl('fixed-code.zip', 'Download fixed code', 'Complete project · .zip', 'package', true)}
        ${dl('fix.patch', 'Patch file', 'git apply fix.patch', 'branch')}
        ${reportBtn}
        ${dl('report.json', 'Report JSON', 'Machine-readable', 'download')}
      </div>`;
  }
  const map = {
    'not-reproduced': ['info', 'Bug not reproduced', 'Every generated test passes on your current code, so no fix was attempted. Try adding more detail (inputs, expected vs actual output) to the bug report.'],
    rejected: ['x', 'Fix rejected', 'Nothing was changed. The report still records the evidence and the proposed diff.'],
    failed: ['alert', 'Run stopped', s.error || 'Something went wrong.'],
    interrupted: ['alert', 'Run interrupted', 'The server restarted before this run finished.'],
  };
  const [ico, title, text] = map[s.status];
  return `<div class="rh-top"><div class="rh-badge">${icon(ico)}</div><div><div class="rh-title">${title}</div><div class="rh-sub">${esc(text)}</div></div></div>
    <div class="downloads" style="margin-top:18px">${reportBtn}${s.artifacts.reportJson ? dl('report.json', 'Report JSON', 'Machine-readable', 'download') : ''}</div>`;
}

async function decide(decision) {
  $('#btn-approve').disabled = true;
  $('#btn-reject').disabled = true;
  try {
    const r = await fetch(`/api/runs/${app.runId}/decision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, writeBack: $('#approve-writeback').checked, includeTests: $('#approve-tests').checked }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    $('#approve-bar').classList.add('hidden');
    toast(decision === 'approved' ? 'Approved — delivering the fix…' : 'Fix rejected');
  } catch (err) {
    toast(err.message, true);
    $('#btn-approve').disabled = false;
    $('#btn-reject').disabled = false;
  }
}

// ─── report modal ────────────────────────────────────────────────────────────
async function openReport() {
  try {
    const r = await fetch(`/api/runs/${app.runId}/files/report.md?inline=1`);
    if (!r.ok) throw new Error('Report not ready yet');
    $('#report-body').innerHTML = renderMarkdown(await r.text());
    $('#report-dl').href = `/api/runs/${app.runId}/files/report.md`;
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
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      const body = buf.map(l => {
        const e = esc(l);
        if (lang !== 'diff') return e;
        if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="d-add">${e}</span>`;
        if (l.startsWith('-') && !l.startsWith('---')) return `<span class="d-del">${e}</span>`;
        if (l.startsWith('@@')) return `<span class="d-hunk">${e}</span>`;
        return e;
      }).join('\n');
      out.push(`<pre class="${lang === 'diff' ? '' : 'wrap'}"><code>${body}</code></pre>`);
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const head = cells(rows[0]);
      const body = rows.slice(2).map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  return out.join('\n');
}

// ─── recent runs drawer ──────────────────────────────────────────────────────
async function openDrawer() {
  $('#drawer').classList.add('open');
  $('#drawer-backdrop').classList.remove('hidden');
  try {
    const runs = await (await fetch('/api/runs')).json();
    $('#runs-list').innerHTML = runs.length ? runs.map(r => {
      const [cls, label] = STATUS_PILL[r.status] || ['', r.status];
      return `<button class="run-item" data-id="${esc(r.id)}"><div class="run-item-top"><span class="run-item-src">${esc(r.source.label)}</span><span class="status-pill ${cls}">${esc(label)}</span></div>
        <div class="run-item-bug">${esc(r.bug)}</div><div class="muted small mono" style="margin-top:6px">${esc(r.id)} · ${esc(ENGINE_LABEL[r.engine] || '')}</div></button>`;
    }).join('') : '<p class="muted" style="padding:8px">No runs yet. Try the live demo!</p>';
    $$('.run-item').forEach(b => b.addEventListener('click', () => { closeDrawer(); location.hash = `run/${b.dataset.id}`; openRun(b.dataset.id); }));
  } catch {
    $('#runs-list').innerHTML = '<p class="muted">Could not load runs.</p>';
  }
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer-backdrop').classList.add('hidden');
}
