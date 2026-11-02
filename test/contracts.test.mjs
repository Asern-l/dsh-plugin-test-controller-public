import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validatePlan } from '../src/plan.mjs';
import { workerEnvironment, sandboxEnvironment, redact, nodeEnvironment } from '../src/environment.mjs';
import { initRoot, cleanSandbox, json, exists, runDirectory, inside } from '../src/storage.mjs';
import { Controller } from '../src/controller.mjs';
import { randomUUID } from 'node:crypto';

test('Electron Node mode survives worker filtering and sandbox handoff without inheriting arbitrary runtime flags', () => {
  const source = { ELECTRON_RUN_AS_NODE: '0', NODE_OPTIONS: '--inspect', GITHUB_TOKEN: 'private' };
  const clean = workerEnvironment({ credentialEnv: [] }, source);
  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.GITHUB_TOKEN, undefined);
  const desktop = nodeEnvironment(clean, { electron: 'desktop-test' });
  assert.equal(desktop.ELECTRON_RUN_AS_NODE, '1');
  const sandbox = sandboxEnvironment(resolve('sandbox'), desktop);
  assert.equal(nodeEnvironment(sandbox, { electron: 'desktop-test' }).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(nodeEnvironment(source, {}).ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(source.ELECTRON_RUN_AS_NODE, '0');
});

test('plan rejects runtime overrides, traversal, invalid limits and missing tasks', () => {
  for (const extra of [{ mode: 'other' }, { timeoutSeconds: 0 }, { timeoutSeconds: 1.5 }, { mode: 'headless' }, { evidence: ['../secret'] }, { evidence: ['C:\\secret'] }, { credentialEnv: ['DSH_HOME'] }, { credentialEnv: ['NODE_OPTIONS'] }, { command: 'rm' }]) assert.throws(() => validatePlan({ name: 'case', ...extra }));
  const plan = validatePlan({ name: 'case', plugins: [{ module: './plugin.mjs' }] }, '/fixtures');
  assert.equal(plan.plugins[0].module, resolve('/fixtures/plugin.mjs'));
});

test('default state root lives under DSH_HOME so it travels with the environment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const controller = new Controller();
    assert.equal(await controller.root(), resolve(join(home, 'plugin-test-controller')));
    assert.deepEqual(await controller.plans(), []);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('open plans need no prompt and carry an idle cap; destroy only touches parked runs', async () => {
  const open = validatePlan({ name: 'interactive', mode: 'open' });
  assert.equal(open.mode, 'open');
  assert.equal(open.openTimeoutSeconds, 7200);
  assert.throws(() => validatePlan({ name: 'interactive', mode: 'open', openTimeoutSeconds: 10 }));

  const root = await mkdtemp(join(tmpdir(), 'dsh-destroy-'));
  try {
    const controller = new Controller({ root });
    await controller.root();
    const id = `run-${randomUUID()}`;
    const dir = join(root, 'runs', id);
    await mkdir(dir, { recursive: true });
    await json(join(dir, 'owner.json'), { owner: 'dsh-test-controller', id });
    await json(join(dir, 'status.json'), { format: 1, id, plan: 'interactive', state: 'open', cleanup: 'pending', verdict: 'not_evaluated', createdAt: new Date().toISOString() });
    assert.deepEqual(await controller.destroy(id), { id, requested: true, state: 'open' });
    assert.equal(await exists(join(dir, 'destroy')), true);

    await json(join(dir, 'status.json'), { format: 1, id, plan: 'interactive', state: 'completed', cleanup: 'succeeded', verdict: 'not_evaluated', createdAt: new Date().toISOString() });
    assert.deepEqual(await controller.destroy(id), { id, requested: false, state: 'completed' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install accepts pinned npm versions and local paths, and rejects everything unpinned', () => {
  const plan = validatePlan({
    name: 'installable',
    install: [{ source: 'npm:dsh-plugin-x@1.2.3' }, { source: 'file:./pkg' }]
  }, '/fixtures');
  assert.deepEqual(plan.install, [
    { source: 'npm:dsh-plugin-x@1.2.3' },
    { source: `file:${resolve('/fixtures/pkg')}` }
  ]);
  assert.equal(plan.installTimeoutSeconds, 300);

  for (const source of ['npm:dsh-plugin-x', 'npm:dsh-plugin-x@^1.2.3', 'npm:dsh-plugin-x@latest', 'git:https://example.invalid/x', 'https://example.invalid/x.tgz', 'file:', 42]) {
    assert.throws(() => validatePlan({ name: 'case', install: [{ source }] }), /install/i, `source: ${source}`);
  }
  assert.throws(() => validatePlan({ name: 'case', install: [{ source: 'file:./pkg', extra: 1 }] }));
  assert.throws(() => validatePlan({ name: 'case', install: Array.from({ length: 17 }, () => ({ source: 'file:./pkg' })) }));
  assert.throws(() => validatePlan({ name: 'case', installTimeoutSeconds: 0 }));
});

test('only explicit credentials enter workers; test home and agent roots are isolated', () => {
  const plan = validatePlan({ name: 'case', credentialEnv: ['DEEPSEEK_API_KEY'] });
  const env = workerEnvironment(plan, { PATH: '/bin', DSH_HOME: '/private', NODE_OPTIONS: '--inspect', DEEPSEEK_API_KEY: 'test-secret', GITHUB_TOKEN: 'private' });
  assert.equal(env.DSH_HOME, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, 'test-secret');
  const isolated = sandboxEnvironment(resolve('sandbox'), env);
  assert.equal(isolated.DSH_HOME, resolve('sandbox/dsh-home'));
  assert.equal(isolated.DSH_AGENTS_HOME, resolve('sandbox/agents-home'));
  assert.equal(isolated.USERPROFILE, isolated.HOME);
  assert.throws(() => workerEnvironment(plan, {}), /missing/);
  assert.equal(redact('value=test-secret', ['test-secret']), 'value=[REDACTED]');
});

test('state roots require ownership; cleanup cannot delete unowned directories', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-contract-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const foreign = join(temp, 'foreign'); await mkdir(foreign); await writeFile(join(foreign, 'keep'), 'keep');
  await assert.rejects(initRoot(foreign), /empty or owned/);
  const root = await initRoot(join(temp, 'state'));
  assert.equal(await initRoot(root), root);
  const dir = join(root, 'runs', 'run-00000000-0000-0000-0000-000000000000'); await mkdir(dir);
  await assert.rejects(runDirectory(root, '../foreign'), /Invalid run ID/);
  await mkdir(join(dir, 'sandbox'));
  await assert.rejects(cleanSandbox(dir, 'wrong'));
  assert.equal(await exists(join(foreign, 'keep')), true);
  assert.equal(inside(root, root), false);
  assert.equal(inside(root, join(root, '..', 'other')), false);
});

test('cleanup removes nested links without following them', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-links-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const sandbox = join(temp, 'run', 'sandbox'), target = join(temp, 'keep');
  await mkdir(sandbox, { recursive: true }); await mkdir(target); await writeFile(join(target, 'file'), 'keep');
  await json(join(sandbox, '.owner.json'), { id: 'test-id' });
  await symlink(target, join(sandbox, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await cleanSandbox(join(temp, 'run'), 'test-id');
  assert.equal(await readFile(join(target, 'file'), 'utf8'), 'keep');
});

test('controller accepts approved names only and does not accept paths from the agent', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-controller-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const c = new Controller({ root: join(temp, 'state') });
  const planPath = join(temp, 'plan.json'); await json(planPath, { name: 'inspect', plugins: [] });
  await c.addPlan(planPath);
  assert.deepEqual(await c.plans(), ['inspect']);
  await assert.rejects(c.start('../other'), /Invalid plan/);
  await assert.rejects(c.start('missing'));
  await assert.rejects(c.status('../other'), /Invalid run/);
});

test('interrupted-run recovery rejects a live worker and exports its final cleanup record', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-recover-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = await initRoot(join(temp, 'state'));
  const id = `run-${randomUUID()}`, dir = join(root, 'runs', id), sandbox = join(dir, 'sandbox');
  await mkdir(sandbox, { recursive: true });
  await json(join(dir, 'owner.json'), { owner: 'dsh-test-controller', id });
  await json(join(sandbox, '.owner.json'), { id });
  await writeFile(join(sandbox, 'memory'), 'stale');
  const c = new Controller({ root });
  await json(join(dir, 'status.json'), { id, state: 'running', workerPid: process.pid, cleanup: 'pending' });
  await assert.rejects(c.recover(id), /Worker is alive/);
  await json(join(dir, 'status.json'), { id, state: 'running', cleanup: 'pending' });
  const result = await c.recover(id);
  assert.equal(result.state, 'interrupted'); assert.equal(result.cleanup, 'succeeded');
  assert.equal(await exists(sandbox), false);
  const exported = await c.export(id);
  assert.equal(JSON.parse(await readFile(join(exported.directory, 'result.json'), 'utf8')).cleanup, 'succeeded');
  assert.deepEqual(await c.recover(id), result);
});
