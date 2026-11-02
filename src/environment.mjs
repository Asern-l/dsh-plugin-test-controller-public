import { join, parse } from 'node:path';

const systemNames = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL', 'TZ']);
// Electron's execPath is the desktop executable. Reusing it for scripts must
// explicitly select Node mode, including after environment sanitization.
export function nodeEnvironment(source, versions = process.versions) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  if (versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
export function workerEnvironment(plan, source = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(source)) if (systemNames.has(k.toUpperCase()) && v !== undefined) env[k] = v;
  for (const k of plan.credentialEnv) {
    if (!source[k]) throw new Error(`Required environment variable is missing: ${k}`);
    env[k] = source[k];
  }
  return nodeEnvironment(env);
}
export function sandboxEnvironment(sandbox, inherited) {
  const home = join(sandbox, 'os-home');
  return {
    ...inherited,
    HOME: home, USERPROFILE: home,
    HOMEDRIVE: parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(parse(home).root.length - 1),
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local', 'state'),
    TEMP: join(sandbox, 'tmp'), TMP: join(sandbox, 'tmp'), TMPDIR: join(sandbox, 'tmp'),
    DSH_HOME: join(sandbox, 'dsh-home'), DSH_AGENTS_HOME: join(sandbox, 'agents-home'),
    DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'workspace-write',
    NO_COLOR: '1', FORCE_COLOR: '0'
  };
}
export function redact(text, secrets) {
  let result = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
  return result;
}
