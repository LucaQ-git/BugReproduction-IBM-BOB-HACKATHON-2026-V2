// workflow/paths.js — shared locations. BUGREP_RUNS_DIR lets tests use a temp folder.
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.resolve(process.env.BUGREP_RUNS_DIR || path.join(ROOT, 'runs'));

module.exports = {
  ROOT,
  RUNS_DIR,
  UPLOADS_DIR: path.join(RUNS_DIR, '_uploads'),
  DEMO_WORKSPACE: path.join(RUNS_DIR, '_demo-workspace'),
  DEMO_DIR: path.join(ROOT, 'demo'),
};
