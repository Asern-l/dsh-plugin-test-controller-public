import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, copyFile, link, readlink, symlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { exists, json, readJson } from './storage.mjs';

/**
 * Content digest of a directory tree: paths, symlink targets and file bytes.
 * Sorted traversal keeps it stable across filesystems.
 */
export async function treeDigest(path) {
  const hash = createHash('sha256');
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name), name = relative(path, full);
      if (entry.isDirectory()) {
        hash.update(`d:${name}\n`);
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l:${name}:${await readlink(full)}\n`);
      } else {
        hash.update(`f:${name}\n`);
        hash.update(await readFile(full));
      }
    }
  }
  await walk(path);
  return hash.digest('hex');
}

/**
 * Identity of a prepared profile: DSH version, install sources, and the
 * content of every `file:` source. Same inputs, same image.
 */
export async function imageKey({ dshVersion, install }) {
  const parts = [`dsh:${dshVersion}`];
  for (const item of install) {
    if (item.source.startsWith('file:')) parts.push(`${item.source}#${await treeDigest(item.source.slice('file:'.length))}`);
    else parts.push(item.source);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
}

/**
 * Clone a directory tree with hard links, falling back to real copies.
 *
 * Links that point inside the tree are rewritten to the cloned location, so an
 * image stays self-contained after the original sandbox is deleted. Links that
 * point outside (a global store) keep their absolute target.
 */
export async function cloneTree(source, target, context) {
  const ctx = context ?? { source, target };
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) {
      await cloneTree(from, to, ctx);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(from);
      const absolute = resolve(dirname(from), linkTarget);
      const inside = relative(ctx.source, absolute);
      const mapped = inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
        ? join(ctx.target, inside)
        : absolute;
      try {
        if (process.platform === 'win32') await symlink(mapped, to, 'junction');
        else await symlink(relative(dirname(to), mapped), to);
      } catch {
        // No privilege for links: materialise the target instead.
        const info = await stat(from);
        if (info.isDirectory()) await cloneTree(from, to, ctx);
        else await copyFile(from, to);
      }
      continue;
    }
    try { await link(from, to); } catch { await copyFile(from, to); }
  }
}

export function imageDirectory(root, key) {
  return join(root, 'images', key);
}

/** Whether a stored image can be cloned (manifest plus profile present). */
export async function imageReady(root, key) {
  const dir = imageDirectory(root, key);
  return await exists(join(dir, 'manifest.json')) && await exists(join(dir, 'profile'));
}

export async function readImageManifest(root, key) {
  return readJson(join(imageDirectory(root, key), 'manifest.json'));
}

/**
 * Store a prepared profile as an image. Best-effort: a failed snapshot only
 * costs the next run's install time.
 */
export async function saveImage(root, key, profile, meta) {
  const dir = imageDirectory(root, key);
  await mkdir(join(root, 'images'), { recursive: true, mode: 0o700 });
  await cloneTree(profile, join(dir, 'profile'));
  await json(join(dir, 'manifest.json'), {
    format: 1,
    key,
    createdAt: new Date().toISOString(),
    ...meta
  });
  return dir;
}

/** Restore an image into a run's profile directory. */
export async function restoreImage(root, key, profile) {
  await cloneTree(join(imageDirectory(root, key), 'profile'), profile);
  return readImageManifest(root, key);
}

/** List stored images, newest first. */
export async function listImages(root) {
  let names = [];
  try { names = await readdir(join(root, 'images')); } catch { return []; }
  const images = [];
  for (const key of names) {
    try { images.push({ key, ...(await readImageManifest(root, key)) }); } catch { images.push({ key, unreadable: true }); }
  }
  return images.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}
