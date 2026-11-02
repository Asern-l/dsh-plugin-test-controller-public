import { mkdir, readFile, writeFile, rename, lstat, readdir, realpath, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const FORMAT = 1;
export const runIdPattern = /^run-[0-9a-f-]{36}$/;
export function inside(root, path) {
  const r = relative(resolve(root), resolve(path));
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}
export async function json(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, path); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
        await new Promise(r => setTimeout(r, 10 + attempt * 5));
      }
    }
  } finally { await rm(tmp, { force: true }); }
}
export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function exists(path) {
  try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function noLinks(path) {
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error(`Links are not allowed: ${path}`);
  if (st.isDirectory()) for (const child of await readdir(path)) await noLinks(join(path, child));
  else if (!st.isFile()) throw new Error(`Only regular files are allowed: ${path}`);
}
export async function initRoot(input) {
  const root = resolve(input);
  if (root === resolve(root, '..')) throw new Error('State root cannot be a filesystem root');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('State root cannot be a link');
  const canonical = await realpath(root);
  const marker = join(canonical, '.dsh-test-controller.json');
  if (!await exists(marker)) {
    const children = await readdir(canonical);
    if (children.length) throw new Error('State root must be empty or owned by dsh-test-controller');
    try { await writeFile(marker, JSON.stringify({ format: FORMAT, owner: 'dsh-test-controller' }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const data = await readJson(marker);
  if (data.owner !== 'dsh-test-controller' || data.format !== FORMAT) throw new Error('Invalid state-root marker');
  for (const name of ['runs', 'plans']) {
    await mkdir(join(canonical, name), { recursive: true, mode: 0o700 });
    if ((await lstat(join(canonical, name))).isSymbolicLink()) throw new Error('State subdirectories cannot be links');
  }
  return canonical;
}
export async function runDirectory(root, id) {
  if (!runIdPattern.test(id)) throw new Error('Invalid run ID');
  const dir = join(root, 'runs', id);
  if ((await lstat(dir)).isSymbolicLink() || !inside(root, await realpath(dir))) throw new Error('Unsafe run directory');
  const marker = await readJson(join(dir, 'owner.json'));
  if (marker.id !== id || marker.owner !== 'dsh-test-controller') throw new Error('Invalid run ownership');
  return dir;
}
export async function cleanSandbox(dir, id) {
  const sandbox = join(dir, 'sandbox');
  if (!await exists(sandbox)) return;
  if ((await lstat(sandbox)).isSymbolicLink()) throw new Error('Refusing linked sandbox cleanup');
  const marker = await readJson(join(sandbox, '.owner.json'));
  if (marker.id !== id) throw new Error('Invalid sandbox ownership');
  if (!inside(await realpath(dir), await realpath(sandbox))) throw new Error('Sandbox escaped run directory');
  // One verified subtree only. Node removes nested symlinks themselves, not their targets.
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
