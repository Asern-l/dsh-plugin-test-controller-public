import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeDigest, imageKey, cloneTree, imageReady, saveImage, restoreImage, listImages } from '../src/image.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-image-'));
  await mkdir(join(dir, 'profile', 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(dir, 'profile', 'package.json'), JSON.stringify({ name: 'demo' }));
  await writeFile(join(dir, 'profile', 'node_modules', 'pkg', 'index.js'), 'export const x = 1;\n');
  return dir;
}

test('tree digest is stable and changes with content', async () => {
  const dir = await fixture();
  try {
    const first = await treeDigest(join(dir, 'profile'));
    assert.equal(await treeDigest(join(dir, 'profile')), first);
    await writeFile(join(dir, 'profile', 'node_modules', 'pkg', 'index.js'), 'export const x = 2;\n');
    assert.notEqual(await treeDigest(join(dir, 'profile')), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('image key follows the source content and the DSH version', async () => {
  const dir = await fixture();
  try {
    const install = [{ source: `file:${join(dir, 'profile')}` }];
    const a = await imageKey({ dshVersion: '1.0.0', install });
    const b = await imageKey({ dshVersion: '1.0.0', install });
    const c = await imageKey({ dshVersion: '1.0.1', install });
    assert.equal(a, b);
    assert.notEqual(a, c);
    await writeFile(join(dir, 'profile', 'node_modules', 'pkg', 'index.js'), 'export const x = 3;\n');
    assert.notEqual(await imageKey({ dshVersion: '1.0.0', install }), a);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('images restore as an independent tree that survives source deletion', async () => {
  const dir = await fixture();
  try {
    const root = join(dir, 'state');
    await mkdir(root, { recursive: true });
    const key = await imageKey({ dshVersion: '1.0.0', install: [{ source: `file:${join(dir, 'profile')}` }] });
    await saveImage(root, key, join(dir, 'profile'), { dshVersion: '1.0.0', packages: [{ name: 'pkg', spec: 'x', version: '1.0.0' }] });
    assert.equal(await imageReady(root, key), true);

    // Deleting the original must not affect the image.
    await rm(join(dir, 'profile'), { recursive: true, force: true });
    const target = join(dir, 'restored');
    const manifest = await restoreImage(root, key, target);
    assert.equal(manifest.packages[0].name, 'pkg');
    assert.equal(await readFile(join(target, 'package.json'), 'utf8'), JSON.stringify({ name: 'demo' }));
    assert.equal((await stat(join(target, 'node_modules', 'pkg', 'index.js'))).isFile(), true);

    const images = await listImages(root);
    assert.equal(images.length, 1);
    assert.equal(images[0].key, key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clone tree keeps directory shape', async () => {
  const dir = await fixture();
  try {
    const target = join(dir, 'copy');
    await cloneTree(join(dir, 'profile'), target);
    assert.equal(await readFile(join(target, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'export const x = 1;\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
