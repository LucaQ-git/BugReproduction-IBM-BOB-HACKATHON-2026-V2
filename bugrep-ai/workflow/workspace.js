// workflow/workspace.js
// File-system helpers: copy projects, scan and rank source files for the AI,
// detect language/test runner, and package results as ZIP files.

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

// Folders we never copy, scan, or send to the AI.
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.venv', 'venv', 'env',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.idea', '.vscode', '.bugrep',
  'runs', '.bob', 'bob_sessions', '.DS_Store', '__bugrep__',
]);

const IGNORED_FILES = new Set([
  '.env', '.env.local', '.env.production', 'package-lock.json', 'yarn.lock',
  'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock',
]);

const SOURCE_EXT = {
  '.js': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript', '.jsx': 'javascript',
  '.py': 'python',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.java': 'java', '.go': 'go', '.rb': 'ruby', '.cs': 'csharp', '.php': 'php',
};

const DOC_EXT = new Set(['.md', '.txt', '.rst']);

const LIMITS = {
  maxFiles:      5000,
  maxFileBytes:  1024 * 1024,       // skip single files over 1 MB
  maxTotalBytes: 150 * 1024 * 1024, // refuse projects over 150 MB (unpacked)
};

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isIgnoredName(name) {
  return IGNORED_DIRS.has(name) || IGNORED_FILES.has(name);
}

/** Recursively list files (relative POSIX paths), skipping ignored folders. */
function listFiles(root, opts = {}) {
  const out = [];
  const includeTests = opts.includeBugrep === true;
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '__bugrep__' && includeTests) {
        walk(path.join(dir, e.name));
        continue;
      }
      if (isIgnoredName(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(toPosix(path.relative(root, abs)));
      if (out.length > LIMITS.maxFiles) {
        throw new Error(`Project has more than ${LIMITS.maxFiles} files — point BugRep at a smaller folder.`);
      }
    }
  })(root);
  return out.sort();
}

/** Copy a project folder, skipping ignored folders and oversized files. */
function copyProject(src, dest) {
  ensureDir(dest);
  let total = 0;
  for (const rel of listFiles(src)) {
    const from = path.join(src, rel);
    const stat = fs.statSync(from);
    if (stat.size > LIMITS.maxFileBytes) continue;
    total += stat.size;
    if (total > LIMITS.maxTotalBytes) throw new Error('Project is too large (over 150 MB).');
    const to = path.join(dest, rel);
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  }
  return dest;
}

/** Copy a whole directory tree verbatim (used for candidate workspaces). */
function copyTree(src, dest) {
  ensureDir(dest);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue; // linked separately
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
  return dest;
}

/** Link node_modules from one workspace into another (junction on Windows). */
function linkNodeModules(fromDir, toDir) {
  const src = path.join(fromDir, 'node_modules');
  const dest = path.join(toDir, 'node_modules');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
  try {
    fs.symlinkSync(fs.realpathSync(src), dest, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

/** Resolve a user/AI supplied relative path safely inside root. Returns null if unsafe. */
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const cleaned = rel.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  const abs = path.resolve(root, cleaned);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

/** Extract a ZIP buffer into dest, defending against zip-slip and zip bombs. */
function extractZip(buffer, dest) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw new Error('That file is not a valid ZIP archive.'); }
  const entries = zip.getEntries();
  if (entries.length > LIMITS.maxFiles * 4) throw new Error('ZIP has too many entries.');

  // Strip a single shared top-level folder (GitHub zipballs, "Download ZIP", etc.)
  const names = entries.filter(e => !e.isDirectory).map(e => e.entryName.replace(/\\/g, '/'));
  const tops = new Set(names.map(n => n.split('/')[0]));
  const strip = tops.size === 1 && names.every(n => n.includes('/')) ? [...tops][0] + '/' : '';

  ensureDir(dest);
  let total = 0, count = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    let name = e.entryName.replace(/\\/g, '/');
    if (strip && name.startsWith(strip)) name = name.slice(strip.length);
    if (!name) continue;
    const parts = name.split('/');
    if (parts.some(p => isIgnoredName(p) || p === '__MACOSX')) continue;
    const abs = safeJoin(dest, name);
    if (!abs) continue; // zip-slip attempt — skip silently
    const size = e.header.size;
    if (size > LIMITS.maxFileBytes) continue;
    total += size;
    if (total > LIMITS.maxTotalBytes) throw new Error('ZIP unpacks to more than 150 MB.');
    if (++count > LIMITS.maxFiles) throw new Error(`ZIP has more than ${LIMITS.maxFiles} files.`);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, e.getData());
  }
  if (count === 0) throw new Error('The ZIP archive contained no usable files.');
  return dest;
}

/** Build a ZIP of a workspace (without node_modules / __bugrep__ unless asked). */
function zipWorkspace(root, outFile, opts = {}) {
  const zip = new AdmZip();
  for (const rel of listFiles(root, { includeBugrep: opts.includeTests })) {
    const dir = path.posix.dirname(rel);
    zip.addLocalFile(path.join(root, rel), dir === '.' ? '' : dir);
  }
  zip.writeZip(outFile);
  return outFile;
}

function readText(file, max = Infinity) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    const s = buf.toString('utf8');
    return s.length > max ? s.slice(0, max) + '\n/* …truncated… */' : s;
  } catch {
    return null;
  }
}

function isTestPath(rel) {
  return /(^|\/)(__tests__|tests?|spec)\//i.test(rel) ||
         /\.(test|spec)\.[cm]?[jt]sx?$/i.test(rel) ||
         /(^|\/)test_[^/]+\.py$/i.test(rel) || /_test\.py$/i.test(rel);
}

/** Detect project language and module style. */
function detectProject(root) {
  const files = listFiles(root);
  const counts = {};
  for (const f of files) {
    const lang = SOURCE_EXT[path.extname(f).toLowerCase()];
    if (lang && !isTestPath(f)) counts[lang] = (counts[lang] || 0) + 1;
  }
  let pkg = null;
  if (fs.existsSync(path.join(root, 'package.json'))) {
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { pkg = {}; }
  }
  let language = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (pkg && (counts.javascript || 0) >= (counts.python || 0)) language = 'javascript';

  const deps = pkg ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }) : [];
  return {
    language,
    counts,
    fileCount: files.length,
    moduleType: pkg && pkg.type === 'module' ? 'esm' : 'commonjs',
    hasPackageJson: !!pkg,
    dependencies: deps,
    needsInstall: !!pkg && deps.filter(d => d !== 'jest').length > 0 &&
                  !fs.existsSync(path.join(root, 'node_modules')),
    files,
  };
}

const STOP = new Set(('the a an and or but if then when while with without of to in on at by for from is are was ' +
  'were be been being it its this that these those as not no yes can cannot should would could will ' +
  'into onto than there their them they we you your our i me my he she his her bug report issue error ' +
  'problem wrong incorrect value values returns return get gets got does do did have has had some any ' +
  'all also just only very more most less least after before').split(' '));

function keywords(text) {
  const words = (text || '').toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [];
  const out = new Map();
  for (const w of words) if (!STOP.has(w)) out.set(w, (out.get(w) || 0) + 1);
  // Also split camelCase words the user may type ("calculateTotal")
  for (const m of (text || '').match(/[A-Za-z]+[A-Z][a-z]+\w*/g) || []) out.set(m.toLowerCase(), 3);
  return out;
}

/**
 * Pick the files most likely to contain the bug, within a character budget.
 * Returns { tree, candidates:[{path, content, score}], docs:[{path, content}] }.
 */
function buildContext(root, bugReport, opts = {}) {
  const budget = opts.budget || 36000; // smaller prompt = faster AI answers
  const project = opts.project || detectProject(root);
  const kw = keywords(bugReport);
  const lang = project.language;

  const scored = [];
  for (const rel of project.files) {
    const ext = path.extname(rel).toLowerCase();
    const fileLang = SOURCE_EXT[ext];
    if (!fileLang || isTestPath(rel)) continue;
    if (/\.min\.js$/.test(rel)) continue;
    const content = readText(path.join(root, rel), 40000);
    if (content == null) continue;
    const lower = content.toLowerCase();
    const relLower = rel.toLowerCase();
    let score = fileLang === lang ? 2 : 0;
    for (const [w, weight] of kw) {
      if (relLower.includes(w)) score += 6 * weight;
      const hits = lower.split(w).length - 1;
      if (hits) score += Math.min(hits, 8) * weight;
    }
    if (/^(src|lib|app)\//.test(relLower)) score += 2;
    if (/(fixture|mock|example|sample)/.test(relLower)) score -= 4;
    scored.push({ path: rel, content, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);

  const candidates = [];
  let used = 0;
  for (const f of scored) {
    if (candidates.length >= 5) break;
    if (used + f.content.length > budget && candidates.length > 0) continue;
    candidates.push(f);
    used += f.content.length;
  }

  // Business rules / specs / README give the agents the expected behaviour.
  const docs = [];
  const docFiles = project.files.filter(f =>
    DOC_EXT.has(path.extname(f).toLowerCase()) &&
    /(rule|spec|requirement|expected|readme|behaviou?r|contract)/i.test(f));
  let docBudget = 12000;
  for (const d of docFiles.slice(0, 6)) {
    const c = readText(path.join(root, d), 6000);
    if (!c || docBudget <= 0) continue;
    docs.push({ path: d, content: c.slice(0, docBudget) });
    docBudget -= c.length;
  }

  const tree = project.files.slice(0, 400).join('\n') +
    (project.files.length > 400 ? `\n… and ${project.files.length - 400} more files` : '');

  return { tree, candidates, docs, project };
}

/** Third-party packages imported by the given files (ignores relative paths and Node built-ins). */
function externalImports(files) {
  const builtins = new Set(require('module').builtinModules);
  const found = new Set();
  const re = /(?:require\(\s*|from\s+|import\s+)['"]([^'"]+)['"]/g;
  for (const f of files) {
    for (const m of String(f.content || '').matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!builtins.has(name)) found.add(name);
    }
  }
  return [...found];
}

module.exports = {
  externalImports,
  IGNORED_DIRS, LIMITS, sha256, sha256File, ensureDir, toPosix, listFiles, copyProject, copyTree,
  linkNodeModules, safeJoin, extractZip, zipWorkspace, readText, isTestPath, detectProject,
  buildContext,
};
