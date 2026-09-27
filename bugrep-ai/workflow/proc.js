// workflow/proc.js — the ONLY way BugRep starts external processes.
// Every process is async, has a hard timeout, and can be cancelled through an
// AbortSignal. On timeout/cancel the whole process tree is killed.

'use strict';

const { spawn, spawnSync } = require('child_process');

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* already gone */ }
}

/**
 * Run a command. Never rejects: resolves with
 *   { code, stdout, stderr, timedOut, aborted, error, ms }
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, shell?:boolean, timeoutMs:number, signal?:AbortSignal,
 *          onStdout?:(chunk:string)=>void, maxBuffer?:number}} opts
 */
function runProcess(cmd, args, opts) {
  const t0 = Date.now();
  const max = opts.maxBuffer || 8 * 1024 * 1024;
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false, timedOut = false, aborted = false;
    if (opts.signal && opts.signal.aborted) {
      return resolve({ code: null, stdout, stderr, timedOut, aborted: true, error: null, ms: 0 });
    }
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd, env: opts.env || process.env, shell: !!opts.shell, windowsHide: true,
        detached: process.platform !== 'win32', // own process group so we can kill the tree
      });
    } catch (err) {
      return resolve({ code: null, stdout, stderr, timedOut, aborted, error: err.message, ms: Date.now() - t0 });
    }
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, error: error || null, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort);
    child.stdout.on('data', d => {
      const s = d.toString();
      if (stdout.length < max) stdout += s;
      if (opts.onStdout) opts.onStdout(s);
    });
    child.stderr.on('data', d => { if (stderr.length < max) stderr += d.toString(); });
    child.on('error', err => finish(null, err.message));
    child.on('close', code => finish(code));
    if (opts.input != null) { child.stdin.end(opts.input); } else { child.stdin.end(); }
  });
}

module.exports = { runProcess, killTree };
