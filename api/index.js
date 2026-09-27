// api/index.js — Vercel entry point when the project is deployed from the repo root.
// The app lives in bugrep-ai/ (see vercel.json); bugrep-ai/api/index.js is used when
// Vercel's Root Directory is set to bugrep-ai instead.

'use strict';

module.exports = require('../bugrep-ai/web/server').createApp();
