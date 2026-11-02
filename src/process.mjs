import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nodeEnvironment } from './environment.mjs';

export async function stopTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', reject);
      // A finished process may already be absent. The caller still awaits close.
      killer.once('close', () => resolve());
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}
export async function capture(entry, args, options) {
  const { cwd, env, timeoutMs, maxOutputBytes, cancelPath, onSpawn } = options;
  const { exists } = await import('./storage.mjs');
  const command = process.platform === 'win32' ? 'powershell.exe' : process.execPath;
  const argv = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-job.ps1', import.meta.url)), '-NodePath', process.execPath, '-Entry', entry, '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64')]
    : [entry, ...args];
  const child = spawn(command, argv, { cwd, env: nodeEnvironment(env), shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let reason = null, size = 0, stopping, stdout = [], stderr = [];
  const stop = why => {
    if (reason) return;
    reason = why;
    stopping = stopTree(child);
    stopping.catch(() => {});
  };
  const consume = sink => chunk => {
    size += chunk.length;
    if (size <= maxOutputBytes) sink.push(chunk);
    else stop('output_limit');
  };
  child.stdout.on('data', consume(stdout));
  child.stderr.on('data', consume(stderr));
  if (process.platform !== 'win32') child.once('exit', () => { stopTree(child).catch(() => {}); });
  const timer = setTimeout(() => stop('timed_out'), timeoutMs);
  const poll = setInterval(() => { exists(cancelPath).then(v => { if (v) stop('cancelled'); }).catch(() => stop('control_error')); }, 100);
  try {
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    exit.catch(() => {});
    try { if (child.pid) await onSpawn?.(child.pid); }
    catch (error) { stop('control_error'); await exit; await stopping; throw error; }
    const result = await exit;
    await stopping;
    // Kill any surviving members of the original POSIX group even after leader exit.
    if (process.platform !== 'win32') await stopTree(child);
    return { ...result, reason, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  } finally {
    clearTimeout(timer); clearInterval(poll);
  }
}
