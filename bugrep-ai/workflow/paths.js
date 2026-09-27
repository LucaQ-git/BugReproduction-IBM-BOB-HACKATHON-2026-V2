// workflow/paths.js — shared locations. BUGREP_RUNS_DIR lets tests use a temp folder.
// On Vercel the deployment is read-only, so runs default to the writable /tmp.
'use strict';
const os   = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_RUNS = process.env.VERCEL ? path.join(os.tmpdir(), 'bugrep-runs') : path.join(ROOT, 'runs');
const RUNS_DIR = path.resolve(process.env.BUGREP_RUNS_DIR || DEFAULT_RUNS);

module.exports = {
  ROOT,
  RUNS_DIR,
  UPLOADS_DIR: path.join(RUNS_DIR, '_uploads'),
  DEMO_WORKSPACE: path.join(RUNS_DIR, '_demo-workspace'),
  DEMO_DIR: path.join(ROOT, 'demo'),
};
