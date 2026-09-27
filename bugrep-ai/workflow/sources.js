// workflow/sources.js
// Brings code into an isolated run workspace from one of four places:
//   local  — a folder on this machine (the project open in your IDE)
//   github — a public (or token-accessible) GitHub repository
//   zip    — a ZIP file uploaded through the web UI or passed to the CLI
//   demo   — the bundled demo project (demo/shop-cart)
// The original code is never modified here; everything is copied.

'use strict';

const fs   = require('fs');
const path = require('path');
const ws   = require('./workspace');

const ROOT      = path.resolve(__dirname, '..');
const DEMO_DIR  = path.join(ROOT, 'demo', 'shop-cart');
const UPLOADS   = path.join(ROOT, 'runs', '_uploads');

/** Default folder suggestion for the "Local / IDE" source: the repository root. */
function defaultLocalPath() {
  const repoRoot = path.resolve(ROOT, '..');
  return fs.existsSync(path.join(repoRoot, '.git')) || fs.existsSync(path.join(repoRoot, 'AGENTS.md'))
    ? repoRoot : ROOT;
}

function parseGithubUrl(input) {
  const raw = String(input || '').trim().replace(/\.git$/, '');
  let m = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/i);
  if (!m) m = raw.match(/^([\w.-]+)\/([\w.-]+)$/); // owner/repo shorthand
  if (!m) throw new Error('Enter a GitHub URL like https://github.com/owner/repo');
  return { owner: m[1], repo: m[2], ref: m[3] || null, subdir: m[4] || null };
}

async function fetchGithub({ url, ref }, dest, log) {
  const gh = parseGithubUrl(url);
  const useRef = ref || gh.ref || '';
  log(`Downloading ${gh.owner}/${gh.repo}${useRef ? '@' + useRef : ''} from GitHub…`);

  // 1) Public archive link (no API rate limit). 2) API zipball (works for private repos with GITHUB_TOKEN).
  const attempts = [];
  if (!process.env.GITHUB_TOKEN) {
    attempts.push({ url: `https://github.com/${gh.owner}/${gh.repo}/archive/${useRef ? encodeURIComponent(useRef) : 'HEAD'}.zip`, headers: { 'User-Agent': 'bugrep-ai' } });
  }
  const apiHeaders = { 'User-Agent': 'bugrep-ai', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  attempts.push({ url: `https://api.github.com/repos/${gh.owner}/${gh.repo}/zipball${useRef ? '/' + encodeURIComponent(useRef) : ''}`, headers: apiHeaders });

  let res, lastErr;
  for (const a of attempts) {
    try {
      res = await fetch(a.url, { headers: a.headers, redirect: 'follow' });
      if (res.ok) break;
    } catch (err) {
      lastErr = err;
      res = null;
    }
  }
  if (!res) throw new Error(`Could not reach GitHub: ${lastErr ? lastErr.message : 'network error'}`);
  if (res.status === 404) throw new Error('Repository or branch not found. Check the URL, or set GITHUB_TOKEN in .env for private repos.');
  if (res.status === 401) throw new Error('GitHub rejected the token in GITHUB_TOKEN. Check or remove it.');
  if (res.status === 403) throw new Error('GitHub refused the download (rate limit or permissions). Set GITHUB_TOKEN in .env.');
  if (!res.ok) throw new Error(`GitHub download failed (${res.status}).`);

  const len = Number(res.headers.get('content-length') || 0);
  if (len > 80 * 1024 * 1024) throw new Error('Repository archive is larger than 80 MB.');
  const buf = Buffer.from(await res.arrayBuffer());
  log(`Downloaded ${(buf.length / 1024).toFixed(0)} KB — unpacking…`);

  if (!gh.subdir) {
    ws.extractZip(buf, dest);
  } else {
    const tmp = dest + '_full';
    ws.extractZip(buf, tmp);
    const sub = ws.safeJoin(tmp, gh.subdir);
    if (!sub || !fs.existsSync(sub)) throw new Error(`Folder "${gh.subdir}" not found in repository.`);
    ws.copyProject(sub, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { label: `github.com/${gh.owner}/${gh.repo}${gh.subdir ? '/' + gh.subdir : ''}`, ref: useRef || 'default branch' };
}

/** Save an uploaded ZIP and return an id the run can reference. */
function saveUpload(buffer, originalName) {
  if (!buffer || buffer.length === 0) throw new Error('Empty upload.');
  if (buffer.length > 60 * 1024 * 1024) throw new Error('ZIP is larger than 60 MB.');
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('That file is not a ZIP archive.');
  ws.ensureDir(UPLOADS);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(path.join(UPLOADS, id + '.zip'), buffer);
  fs.writeFileSync(path.join(UPLOADS, id + '.json'), JSON.stringify({ name: originalName || 'upload.zip' }));
  return id;
}

/**
 * Acquire code into `dest`. Returns { label, detail, localPath? }.
 * @param {{type:string, path?:string, url?:string, ref?:string, uploadId?:string, zipFile?:string}} source
 */
async function acquire(source, dest, log = () => {}) {
  const type = source && source.type;
  if (type === 'demo') {
    log('Loading the bundled demo project (shop-cart)…');
    ws.copyProject(DEMO_DIR, dest);
    return { label: 'Demo · shop-cart', detail: 'Bundled sample project with a known pricing bug' };
  }

  if (type === 'local') {
    const p = path.resolve(String(source.path || '').trim() || defaultLocalPath());
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`Folder not found: ${p}`);
    log(`Copying ${p} into an isolated workspace…`);
    ws.copyProject(p, dest);
    // Reuse the project's installed dependencies without copying them.
    ws.linkNodeModules(p, dest);
    return { label: path.basename(p), detail: p, localPath: p };
  }

  if (type === 'github') {
    const info = await fetchGithub(source, dest, log);
    return { label: info.label, detail: `ref: ${info.ref}` };
  }

  if (type === 'zip') {
    let buf, name;
    if (source.uploadId) {
      const id = String(source.uploadId).replace(/[^a-z0-9]/gi, '');
      const file = path.join(UPLOADS, id + '.zip');
      if (!fs.existsSync(file)) throw new Error('Upload expired — please upload the ZIP again.');
      buf = fs.readFileSync(file);
      try { name = JSON.parse(fs.readFileSync(path.join(UPLOADS, id + '.json'), 'utf8')).name; } catch { name = 'upload.zip'; }
    } else if (source.zipFile) {
      buf = fs.readFileSync(path.resolve(source.zipFile));
      name = path.basename(source.zipFile);
    } else {
      throw new Error('No ZIP provided.');
    }
    log(`Unpacking ${name} (${(buf.length / 1024).toFixed(0)} KB)…`);
    ws.extractZip(buf, dest);
    return { label: name, detail: 'Uploaded ZIP archive' };
  }

  throw new Error(`Unknown source type "${type}". Use local, github, zip or demo.`);
}

module.exports = { acquire, saveUpload, parseGithubUrl, defaultLocalPath, DEMO_DIR };
