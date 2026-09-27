// api/index.js — Vercel entry point. Every /api/* request is routed here (see vercel.json).
// Static UI files are served by Vercel from web/public.

'use strict';

module.exports = require('../web/server').createApp();
