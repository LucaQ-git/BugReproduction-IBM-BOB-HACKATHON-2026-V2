// agents/claude.js — Claude (Anthropic) provider SKELETON.
// Visible in the UI as "Coming soon". Makes no network calls and needs no API key.
// To implement: extend AgentProvider, build prompts with workflow/prompts.js,
// call the vendor API, and return the parsed payload via agents/parse.js.
'use strict';
const { SkeletonProvider } = require('./provider');
module.exports = new SkeletonProvider({ id: 'claude', name: 'Claude', vendor: 'Anthropic' });
