// workflow/errors.js — typed run errors and the terminal statuses they map to.
'use strict';

/**
 * errorType values:
 *   timeout        — a process or the whole pipeline exceeded its time limit
 *   cancelled      — the user pressed Stop Run
 *   environment    — tests / node / npm could not start (NOT "bug not reproduced")
 *   ai-unavailable — the selected agent is not installed / configured / reachable
 *   ai-response    — the agent answered, but not with usable JSON
 *   invalid-tests  — the agent's tests could not run (bad import, syntax, weak asserts)
 *   integrity      — the locked tests or the verified candidate changed
 *   source         — the code could not be fetched (bad path, GitHub, ZIP)
 *   internal       — anything unexpected
 */
class RunError extends Error {
  constructor(type, message, extra = {}) {
    super(message);
    this.name = 'RunError';
    this.type = type;
    Object.assign(this, extra);
  }
}

const TERMINAL = new Set([
  'completed', 'rejected', 'failed', 'timed-out', 'cancelled', 'interrupted',
  'not-reproduced', 'repair-not-verified',
]);
const ACTIVE = new Set(['running', 'awaiting-approval']);

function statusForError(type) {
  if (type === 'timeout') return 'timed-out';
  if (type === 'cancelled') return 'cancelled';
  return 'failed';
}

module.exports = { RunError, TERMINAL, ACTIVE, statusForError };
