// workflow/redact.js — removes secrets from any text before it is stored, logged or returned.
'use strict';

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|WEBHOOK|CREDENTIAL)/i;

function secretValues() {
  return Object.entries(process.env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 6)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
}

function redact(text) {
  let s = String(text ?? '');
  for (const v of secretValues()) s = s.split(v).join('[REDACTED]');
  // Webhook-looking URLs and bearer tokens, even if not in env
  s = s.replace(/https:\/\/hooks\.slack\.com\/[^\s"']+/g, '[REDACTED_WEBHOOK]')
       .replace(/https:\/\/[^\s"']*(webhook\.office\.com|logic\.azure\.com|powerautomate)[^\s"']*/gi, '[REDACTED_WEBHOOK]')
       .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [REDACTED]');
  return s;
}

/** Keep the last `max` characters (the end of output usually holds the answer or error). */
function bounded(text, max = 4000) {
  const s = redact(text);
  return s.length > max ? '…[truncated]…\n' + s.slice(-max) : s;
}

module.exports = { redact, bounded };
