import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from '../src/controller.mjs';

// Installing writes a real profile and touches the pnpm store, so it is opt-in:
// run `DSH_TEST_INSTALL=1 npm run test:integration` locally or in a nightly job.
const enabled = process.env.DSH_TEST_INSTALL === '1';

test('install phase puts the bundle in the disposable profile and records it', { skip: !enabled && 'set DSH_TEST_INSTALL=1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-install-'));
  try {
    const controller = new Controller({ root });
    await controller.addPlan(fileURLToPath(new URL('../examples/install-fixture.json', import.meta.url)));
    const started = await controller.start('install-fixture');
    const result = await controller.wait(started.id, { timeoutMs: 300000 });
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.cleanup, 'succeeded');

    const exported = await controller.export(started.id);
    const environment = JSON.parse(await readFile(join(exported.directory, 'environment.json'), 'utf8'));
    assert.ok(environment.install, 'environment.json records the install phase');
    assert.deepEqual(environment.install.packages.map(p => p.name), ['dsh-fixture-bundle']);
    assert.equal(environment.install.packages[0].version, '0.0.1');
    assert.match(environment.install.lockfileSha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
