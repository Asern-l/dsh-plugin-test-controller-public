import test from 'node:test';
import assert from 'node:assert/strict';

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (spec) => loaded.push(spec) } };

await import('../src/client.js');

const react = {
  createElement: () => null,
  Fragment: {},
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn()
};

test('client bundle registers one factory under the package id', () => {
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'dsh-plugin-test-controller');
  assert.equal(typeof loaded[0].factory, 'function');
});

test('client bundle exports the cordis plugin shape and owns one sidebar panel', () => {
  const plugin = loaded[0].factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require: ${name}`);
  });
  assert.equal(plugin.name, 'plugin-test-controller');
  assert.deepEqual(plugin.inject, ['slots']);

  const registered = [];
  const ctx = {
    slots: {
      inject(name, register) {
        registered.push(name);
        register();
      },
      register(options) {
        registered.push(options);
        return () => {};
      }
    }
  };
  plugin.apply(ctx);
  assert.deepEqual(registered[0], 'main');
  assert.deepEqual(registered[2], 'sidebar.panellist');
  assert.equal(registered[1].name, 'main');
  assert.equal(registered[1].key, 'plugin-test');
  assert.equal(registered[3].name, 'sidebar.panellist');
  assert.equal(registered[3].id, 'plugin-test');
  assert.equal(registered[3].label(), '插件测试');
});
