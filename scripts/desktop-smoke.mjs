// Run this script with the installed desktop executable in ELECTRON_RUN_AS_NODE mode.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as plugin from '../src/plugin.mjs';
import { Controller } from '../src/controller.mjs';
import { exists } from '../src/storage.mjs';

assert.ok(process.versions.electron, 'Use the Electron executable in Node mode');
const temp = await mkdtemp(join(tmpdir(), 'dsh-desktop-smoke-'));
const root = join(temp, 'state'), c = new Controller({ root }), ctx = new Context();
let run;
try {
  await c.addPlan(fileURLToPath(new URL('../examples/inspect.json', import.meta.url)));
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
  await ctx.plugin(plugin, { root });
  run = await ctx.tools.get('plugin_test_start').execute({ plan: 'inspect-fixture' }, { signal: new AbortController().signal });
  const result = await c.wait(run.id, { timeoutMs: 150000 });
  const exported = await ctx.tools.get('plugin_test_export').execute({ id: run.id }, { signal: new AbortController().signal });
  if (result.state !== 'completed') console.error(await readFile(join(exported.directory, 'stderr.log'), 'utf8'));
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.cleanup, 'succeeded');
  assert.equal(await exists(join(root, 'runs', run.id, 'sandbox')), false);
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.version, execPath: process.execPath, state: result.state, cleanup: result.cleanup }));
} finally {
  await ctx.fiber.dispose();
  // Avoid deleting a live worker's state if the smoke check itself was interrupted.
  if (run) { await c.cancel(run.id); await c.wait(run.id); }
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
