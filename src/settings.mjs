import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Operator-editable settings shared by the tools, the panel and the CLI.
 *
 * The state root normally comes from plugin config or DSH_TEST_ROOT, but the
 * panel can override it at runtime; that override lives next to the default
 * root inside DSH_HOME so every entry point agrees on one directory.
 */
export function dshHome() {
  const configured = process.env.DSH_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), '.dsh');
}

export function settingsDirectory() {
  return join(dshHome(), 'plugin-test-controller');
}

export function settingsFile() {
  return join(settingsDirectory(), 'ui-settings.json');
}

let cached = null;
let cachedHome = null;

/** Current UI settings (`{ root }` possibly empty). Cached per DSH_HOME. */
export function readSettings() {
  const home = dshHome();
  if (cached !== null && cachedHome === home) return cached;
  cachedHome = home;
  try {
    const value = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    cached = value && typeof value === 'object' ? value : {};
  } catch {
    cached = {};
  }
  return cached;
}

/** Replace the settings file and the in-process cache. */
export function writeSettings(next) {
  const value = { ...next };
  mkdirSync(settingsDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(settingsFile(), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  cached = value;
  return value;
}

/**
 * The state root every entry point should use:
 * panel override → plugin config → DSH_TEST_ROOT → DSH_HOME default.
 */
export function resolveRoot(configRoot) {
  const saved = readSettings();
  if (typeof saved.root === 'string' && saved.root.length > 0) return saved.root;
  return configRoot || process.env.DSH_TEST_ROOT || join(dshHome(), 'plugin-test-controller');
}

/** Where the effective root came from, for display in the panel. */
export function rootSource(configRoot) {
  const saved = readSettings();
  if (typeof saved.root === 'string' && saved.root.length > 0) return 'ui';
  if (configRoot) return 'config';
  if (process.env.DSH_TEST_ROOT) return 'env';
  return 'default';
}
