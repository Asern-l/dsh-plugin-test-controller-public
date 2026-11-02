import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, writeSettings, resolveRoot, rootSource, settingsFile } from '../src/settings.mjs';

test('settings resolve the root in a fixed precedence order', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-settings-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // A fresh process cache is not available here, so exercise the file path.
    assert.equal(resolveRoot('/from/config'), '/from/config');
    assert.equal(rootSource('/from/config'), 'config');

    writeSettings({ root: '/from/ui' });
    assert.equal(readSettings().root, '/from/ui');
    assert.equal(resolveRoot('/from/config'), '/from/ui');
    assert.equal(rootSource('/from/config'), 'ui');
    assert.match(settingsFile(), /plugin-test-controller[\\/]ui-settings\.json$/);

    writeSettings({});
    assert.equal(resolveRoot('/from/config'), '/from/config');
    assert.equal(rootSource('/from/config'), 'config');
  } finally {
    writeSettings({});
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
