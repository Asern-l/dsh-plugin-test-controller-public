import { resolve, dirname, isAbsolute } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
export const DSH_VERSION = '0.2.1-rc.5';
const allowed = new Set(['name', 'mode', 'prompt', 'plugins', 'timeoutSeconds', 'maxOutputBytes', 'credentialEnv', 'evidence', 'install', 'installTimeoutSeconds', 'installMode', 'openTimeoutSeconds', 'expect']);
const credentialName = /^[A-Z][A-Z0-9_]*$/;
const reservedCredential = /^(DSH_|NODE_|ELECTRON_|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|TEMP$|TMP$|PATH$|XDG_|SYSTEMROOT$|COMSPEC$|WINDIR$)/;

/**
 * Whether one name may travel into a worker environment as a credential.
 * Shared by plan validation and by the panel's in-memory credential store, so
 * a browser-entered value cannot name a variable the runtime owns.
 * @param name - candidate environment variable name.
 */
export function isValidCredentialName(name) {
  return typeof name === 'string' && credentialName.test(name) && !reservedCredential.test(name);
}

export function validatePlan(input, base = process.cwd()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Plan must be an object');
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown plan field: ${key}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.name ?? '')) throw new Error('Invalid plan name');
  const mode = input.mode ?? 'inspect';
  if (!['inspect', 'headless', 'open'].includes(mode)) throw new Error('mode must be inspect, headless or open');
  if (mode === 'headless' && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100000)) throw new Error('headless requires a non-empty prompt (maximum 100000 characters)');
  const timeoutSeconds = input.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw new Error('Invalid timeoutSeconds');
  const maxOutputBytes = input.maxOutputBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 64 * 1024 * 1024) throw new Error('Invalid maxOutputBytes');
  const plugins = input.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.length > 32) throw new Error('Invalid plugins');
  const normalized = plugins.map((p, i) => {
    if (!p || typeof p.module !== 'string' || !p.module.trim() || Object.keys(p).some(k => !['module', 'config'].includes(k))) throw new Error(`Invalid plugin ${i}`);
    // Local source paths are resolved once by the operator, not relative to a disposable cwd.
    const module = p.module.startsWith('.') || isAbsolute(p.module) ? resolve(base, p.module) : p.module;
    if (p.config !== undefined && (!p.config || typeof p.config !== 'object' || Array.isArray(p.config))) throw new Error('Plugin config must be an object');
    return { module, config: p.config ?? {} };
  });
  const credentialEnv = input.credentialEnv ?? [];
  if (!Array.isArray(credentialEnv) || credentialEnv.length > 32 || credentialEnv.some(k => !isValidCredentialName(k))) throw new Error('Invalid credentialEnv; runtime control variables cannot be inherited');
  const evidence = input.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 64 || evidence.some(p => typeof p !== 'string' || !p || isAbsolute(p) || p.split(/[\\/]/).some(x => x === '..' || x === '') || /[:*?]/.test(p))) throw new Error('Evidence must name explicit relative files inside the workspace');
  const install = input.install ?? [];
  if (!Array.isArray(install) || install.length > 16) throw new Error('Invalid install; at most 16 packages');
  const normalizedInstall = install.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => k !== 'source')) throw new Error(`Invalid install entry ${i}`);
    const source = item.source;
    if (typeof source !== 'string' || source.length === 0) throw new Error(`Install entry ${i} needs a source`);
    if (source.startsWith('file:')) {
      const path = source.slice('file:'.length).trim();
      if (!path) throw new Error(`Install entry ${i} has an empty path`);
      return { source: `file:${isAbsolute(path) ? path : resolve(base, path)}` };
    }
    // Only exact npm versions: a range would make the same plan install different code.
    if (/^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/i.test(source)) return { source };
    throw new Error(`Install entry ${i} must be file:<path> or npm:<name>@<exact version>`);
  });
  const installTimeoutSeconds = input.installTimeoutSeconds ?? 300;
  if (!Number.isInteger(installTimeoutSeconds) || installTimeoutSeconds < 1 || installTimeoutSeconds > 3600) throw new Error('Invalid installTimeoutSeconds');
  // `cached` reuses a prepared profile image when the install inputs are unchanged.
  const installMode = input.installMode ?? 'cached';
  if (!['cached', 'fresh'].includes(installMode)) throw new Error('installMode must be cached or fresh');
  // Interactive sessions park a whole DSH; they end on demand or after this idle cap.
  const openTimeoutSeconds = input.openTimeoutSeconds ?? 7200;
  if (!Number.isInteger(openTimeoutSeconds) || openTimeoutSeconds < 60 || openTimeoutSeconds > 86400) throw new Error('Invalid openTimeoutSeconds');
  // Assertions read the evidence after collection; a failed one turns the run
  // into `failed` instead of "the process exited 0".
  const expect = input.expect ?? [];
  if (!Array.isArray(expect) || expect.length > 64) throw new Error('Invalid expect; at most 64 assertions');
  const normalizedExpect = expect.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid expect entry ${i}`);
    if (Object.keys(item).some(k => !['file', 'path', 'equals', 'contains', 'matches'].includes(k))) throw new Error(`Invalid expect entry ${i}`);
    const file = item.file;
    if (typeof file !== 'string' || !file || isAbsolute(file) || file.split(/[\\/]/).some(x => x === '..' || x === '')) throw new Error(`Expect entry ${i} needs a relative evidence path`);
    const modes = ['equals', 'contains', 'matches'].filter(k => k in item);
    if (modes.length !== 1) throw new Error(`Expect entry ${i} needs exactly one of equals/contains/matches`);
    if (item.path !== undefined && (typeof item.path !== 'string' || item.path.length === 0)) throw new Error(`Invalid path in expect entry ${i}`);
    if (modes[0] === 'contains' && typeof item.contains !== 'string') throw new Error(`Expect entry ${i} contains must be a string`);
    if (modes[0] === 'matches') {
      if (typeof item.matches !== 'string') throw new Error(`Expect entry ${i} matches must be a string`);
      try { new RegExp(item.matches); } catch { throw new Error(`Expect entry ${i} has an invalid regular expression`); }
    }
    return { file, ...(item.path === undefined ? {} : { path: item.path }), [modes[0]]: item[modes[0]] };
  });
  return { name: input.name, mode, prompt: input.prompt ?? '', plugins: normalized, timeoutSeconds, maxOutputBytes, credentialEnv: [...new Set(credentialEnv)], evidence: [...new Set(evidence)], install: normalizedInstall, installTimeoutSeconds, installMode, openTimeoutSeconds, expect: normalizedExpect };
}
export async function loadPlan(path) {
  // Windows editors may save a BOM; JSON.parse rejects it.
  return validatePlan(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')), dirname(resolve(path)));
}
export function resolveRuntime() {
  const packagePath = require.resolve('@deepseek-ai/dsh/package.json');
  const dir = dirname(packagePath);
  return { packagePath, dir, entry: resolve(dir, 'lib/bin.js') };
}
export async function fingerprint(path) {
  const st = await stat(path);
  if (!st.isFile() || st.size > 64 * 1024 * 1024) throw new Error(`Invalid module file: ${path}`);
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
