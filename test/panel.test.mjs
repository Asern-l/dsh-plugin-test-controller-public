import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as panel from '../src/panel.mjs';

/** Compare paths the way the runtime reports them: symlinks and 8.3 short names resolved. */
const canonical = (path) => {
  try {
    const real = realpathSync.native(path);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return path;
  }
};

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-panel-'));
  const routes = new Map();
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    webServer: {
      register(route) {
        routes.set(`${route.kind} ${route.path}`, route);
        return () => routes.delete(`${route.kind} ${route.path}`);
      }
    }
  };
  panel.apply(ctx, { root });
  return { root, routes, close: () => rm(root, { recursive: true, force: true }) };
}

/** Resolve one route handler into { status, body } with a synthetic request. */
function call(route, { url, method = 'GET', body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      url,
      method,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(body);
      }
    };
    const chunks = [];
    let status = 0;
    let responseHeaders = {};
    const res = {
      writeHead(code, value) {
        status = code;
        responseHeaders = value ?? {};
      },
      end(payload) {
        if (payload) chunks.push(Buffer.from(payload));
        resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') });
      }
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
  });
}

test('panel exposes every route under the plugin prefix and requires a web server', () => {
  assert.deepEqual(panel.inject, ['webServer']);
  return harness().then(async ({ routes, close }) => {
    try {
      assert.deepEqual([...routes.keys()].sort(), [
        'exact /plugin-test/cancel',
        'exact /plugin-test/config',
        'exact /plugin-test/credentials',
        'exact /plugin-test/destroy',
        'exact /plugin-test/export',
        'exact /plugin-test/images',
        'exact /plugin-test/open',
        'exact /plugin-test/plan',
        'exact /plugin-test/run',
        'exact /plugin-test/start',
        'exact /plugin-test/state',
        'exact /plugin-test/status'
      ]);
    } finally {
      await close();
    }
  });
});

test('panel state reports plans and runs as JSON', async () => {
  const { routes, close } = await harness();
  try {
    const response = await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    const value = JSON.parse(response.body);
    assert.deepEqual(value.plans, []);
    assert.deepEqual(value.runs, []);
    assert.deepEqual(value.credentials, []);
    assert.equal(typeof value.root, 'string');
  } finally {
    await close();
  }
});

test('panel stores credentials in memory and never returns their values', async () => {
  const { routes, close } = await harness();
  try {
    const saved = await call(routes.get('exact /plugin-test/credentials'), {
      url: '/plugin-test/credentials',
      method: 'POST',
      body: JSON.stringify({ name: 'DEEPSEEK_API_KEY', value: 'sk-secret-value' })
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.body).configured, ['DEEPSEEK_API_KEY']);

    const state = await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' });
    assert.equal(state.body.includes('sk-secret-value'), false);
    assert.deepEqual(JSON.parse(state.body).credentials, ['DEEPSEEK_API_KEY']);

    const reserved = await call(routes.get('exact /plugin-test/credentials'), {
      url: '/plugin-test/credentials',
      method: 'POST',
      body: JSON.stringify({ name: 'DSH_HOME', value: 'x' })
    });
    assert.equal(reserved.status, 400);

    const cleared = await call(routes.get('exact /plugin-test/credentials'), {
      url: '/plugin-test/credentials',
      method: 'DELETE',
      body: JSON.stringify({})
    });
    assert.deepEqual(JSON.parse(cleared.body).configured, []);
  } finally {
    await close();
  }
});

test('panel returns a plan with its file path and reports a missing one', async () => {
  const { routes, root, close } = await harness();
  try {
    // Initialise the owned root first: initRoot refuses a non-empty directory
    // that carries no ownership marker.
    assert.equal((await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' })).status, 200);
    await mkdir(join(root, 'plans'), { recursive: true });
    await writeFile(join(root, 'plans', 'demo.json'), JSON.stringify({ name: 'demo', mode: 'open', plugins: [{ module: 'x', config: {} }] }));
    const response = await call(routes.get('exact /plugin-test/plan'), { url: '/plugin-test/plan?name=demo' });
    assert.equal(response.status, 200);
    const value = JSON.parse(response.body);
    assert.equal(value.name, 'demo');
    assert.equal(value.plan.mode, 'open');
    assert.match(value.path, /demo\.json$/);

    const missing = await call(routes.get('exact /plugin-test/plan'), { url: '/plugin-test/plan?name=nope' });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test('panel creates and deletes plans and removes a settled run', async () => {
  const { routes, root, close } = await harness();
  try {
    assert.equal((await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' })).status, 200);
    const created = await call(routes.get('exact /plugin-test/plan'), {
      url: '/plugin-test/plan',
      method: 'POST',
      body: JSON.stringify({ plan: { name: 'made-in-ui', mode: 'inspect', plugins: [{ module: './x.mjs' }] } })
    });
    assert.equal(created.status, 200);
    assert.equal(JSON.parse(created.body).name, 'made-in-ui');
    assert.deepEqual(JSON.parse((await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' })).body).plans, ['made-in-ui']);

    const invalid = await call(routes.get('exact /plugin-test/plan'), {
      url: '/plugin-test/plan',
      method: 'POST',
      body: JSON.stringify({ plan: { name: 'bad name!' } })
    });
    assert.equal(invalid.status, 400);

    const removedPlan = await call(routes.get('exact /plugin-test/plan'), { url: '/plugin-test/plan?name=made-in-ui', method: 'DELETE', body: '{}' });
    assert.equal(removedPlan.status, 200);
    assert.deepEqual(JSON.parse((await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' })).body).plans, []);

    const id = `run-${randomUUID()}`;
    const dir = join(root, 'runs', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ owner: 'dsh-test-controller', id }));
    await writeFile(join(dir, 'status.json'), JSON.stringify({ format: 1, id, plan: 'demo', state: 'completed', cleanup: 'succeeded', verdict: 'not_evaluated', createdAt: new Date().toISOString() }));
    const removedRun = await call(routes.get('exact /plugin-test/run'), { url: `/plugin-test/run?id=${id}`, method: 'DELETE', body: '{}' });
    assert.equal(removedRun.status, 200);
    assert.equal(JSON.parse(removedRun.body).removed, true);
    assert.deepEqual(JSON.parse((await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' })).body).runs, []);
  } finally {
    await close();
  }
});

test('panel returns run detail with evidence inventory and images list', async () => {
  const { routes, root, close } = await harness();
  try {
    assert.equal((await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' })).status, 200);
    const id = `run-${randomUUID()}`;
    const dir = join(root, 'runs', id);
    await mkdir(join(dir, 'evidence', 'files'), { recursive: true });
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ owner: 'dsh-test-controller', id }));
    await writeFile(join(dir, 'status.json'), JSON.stringify({ format: 1, id, plan: 'demo', state: 'completed', cleanup: 'succeeded', verdict: 'not_evaluated', createdAt: new Date().toISOString(), check: { kind: 'inspect', passed: true, assertions: [{ index: 0, file: 'stdout.log', ok: true }] } }));
    await writeFile(join(dir, 'evidence', 'stdout.log'), 'hello');
    await writeFile(join(dir, 'evidence', 'environment.json'), JSON.stringify({ dshVersion: '0.2.1-rc.5', nodeVersion: 'v24', platform: 'win32', arch: 'x64', install: { cached: true, packages: [] } }));
    await writeFile(join(dir, 'evidence', 'files', 'report.json'), '{"ok":true}');

    const response = await call(routes.get('exact /plugin-test/run'), { url: `/plugin-test/run?id=${id}` });
    assert.equal(response.status, 200);
    const value = JSON.parse(response.body);
    assert.equal(value.status.state, 'completed');
    assert.equal(value.stdoutTail, 'hello');
    assert.deepEqual(value.files.map((file) => file.name), ['environment.json', 'files/report.json', 'stdout.log']);
    assert.equal(value.environment.dshVersion, '0.2.1-rc.5');

    const images = await call(routes.get('exact /plugin-test/images'), { url: '/plugin-test/images' });
    assert.equal(images.status, 200);
    assert.deepEqual(JSON.parse(images.body), []);
  } finally {
    await close();
  }
});

test('panel switches the state root through /config and restores the default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-config-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const { routes, close } = await harness();
  try {
    const target = join(home, 'switched-root');
    const saved = await call(routes.get('exact /plugin-test/config'), {
      url: '/plugin-test/config',
      method: 'POST',
      body: JSON.stringify({ root: target })
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(saved.body).source, 'ui');

    const state = await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' });
    assert.equal(JSON.parse(state.body).rootSource, 'ui');
    assert.equal(canonical(JSON.parse(state.body).root), canonical(target));
    assert.equal((await call(routes.get('exact /plugin-test/state'), { url: '/plugin-test/state' })).status, 200);

    const bad = await call(routes.get('exact /plugin-test/config'), {
      url: '/plugin-test/config',
      method: 'POST',
      body: JSON.stringify({ root: 'relative/path' })
    });
    assert.equal(bad.status, 400);

    const reset = await call(routes.get('exact /plugin-test/config'), { url: '/plugin-test/config', method: 'DELETE', body: '{}' });
    assert.equal(reset.status, 200);
    assert.deepEqual(JSON.parse(reset.body).source, 'config');
  } finally {
    await close();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('panel rejects bad input with 400 and unknown runs with 404', async () => {
  const { routes, close } = await harness();
  try {
    const badPlan = await call(routes.get('exact /plugin-test/start'), {
      url: '/plugin-test/start',
      method: 'POST',
      body: JSON.stringify({ plan: 42 })
    });
    assert.equal(badPlan.status, 400);
    assert.match(JSON.parse(badPlan.body).error, /plan must be a string/);

    const unknown = await call(routes.get('exact /plugin-test/status'), { url: '/plugin-test/status?id=run-00000000-0000-0000-0000-000000000000' });
    assert.equal(unknown.status, 404);

    const missing = await call(routes.get('exact /plugin-test/export'), { url: '/plugin-test/export' });
    assert.equal(missing.status, 400);
  } finally {
    await close();
  }
});

test('panel rejects cross-origin callers but accepts the page origin', async () => {
  const { routes, close } = await harness();
  try {
    const foreign = await call(routes.get('exact /plugin-test/state'), {
      url: '/plugin-test/state',
      headers: { host: '127.0.0.1:39735', origin: 'https://evil.example' }
    });
    assert.equal(foreign.status, 403);
    assert.match(JSON.parse(foreign.body).error, /Cross-origin/);

    const same = await call(routes.get('exact /plugin-test/state'), {
      url: '/plugin-test/state',
      headers: { host: '127.0.0.1:39735', origin: 'http://127.0.0.1:39735' }
    });
    assert.equal(same.status, 200);
  } finally {
    await close();
  }
});
