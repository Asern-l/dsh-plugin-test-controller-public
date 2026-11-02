import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { json, readJson, runDirectory, cleanSandbox, exists, inside } from './storage.mjs';
import { resolveRuntime, DSH_VERSION, fingerprint } from './plan.mjs';
import { sandboxEnvironment, redact } from './environment.mjs';
import { capture, stopTree } from './process.mjs';
import { imageKey, imageReady, restoreImage, saveImage } from './image.mjs';

export async function executeRun(root, id) {
  const dir = await runDirectory(root, id), plan = await readJson(join(dir, 'plan.json'));
  let status = { ...await readJson(join(dir, 'status.json')), state: 'preparing', workerPid: process.pid, startedAt: new Date().toISOString() };
  const update = async fields => { status = { ...status, ...fields }; await json(join(dir, 'status.json'), status); };
  await update({});
  process.send?.({ id, ready: true });
  const sandbox = join(dir, 'sandbox'), evidence = join(dir, 'evidence'), workspace = join(sandbox, 'workspace');
  const secrets = plan.credentialEnv.map(k => process.env[k]).filter(Boolean);
  const scrub = text => redact(text, secrets);
  let terminal = 'failed';
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  try {
    await mkdir(sandbox, { mode: 0o700 });
    await json(join(sandbox, '.owner.json'), { id });
    const env = sandboxEnvironment(sandbox, process.env);
    for (const p of [workspace, env.DSH_HOME, env.DSH_AGENTS_HOME, env.HOME, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TEMP]) await mkdir(p, { recursive: true, mode: 0o700 });
    const runtime = resolveRuntime();
    const runtimePackage = await readJson(runtime.packagePath);
    if (runtimePackage.version !== DSH_VERSION) throw new Error(`Expected DSH ${DSH_VERSION}; found ${runtimePackage.version}`);
    const require = createRequire(runtime.packagePath);
    const modules = [];
    for (const plugin of plan.plugins) {
      const entry = isAbsolute(plugin.module) ? plugin.module : require.resolve(plugin.module);
      modules.push({ module: entry, sha256: await fingerprint(entry), config: plugin.config });
    }
    // JSON is a YAML subset: no string interpolation, YAML tags, or shell quoting.
    const patch = [
      ...modules.length ? [{ insert: modules.map((p, i) => ({ id: `test-subject-${i}`, name: p.module, config: p.config })) }] : [],
      ...plan.mode === 'headless' ? [
        { id: 'session-log-deepseek', disabled: true }, { id: 'session-telemetry-otel', disabled: true },
        { id: 'session-title-llm', disabled: true },
        { id: 'agent-instructions', disabled: true }, { id: 'skill-filesystem', disabled: true },
        { id: 'approval', config: { policy: 'never' } },
        { id: 'permission', config: { presets: {
          'read-only': { sandbox: 'read-only', approval: 'never' },
          'workspace-write': { sandbox: 'workspace-write', approval: 'never' },
          'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' }
        } } }
      ] : []
    ];
    const patchPath = join(sandbox, 'test.patch.yml');
    await json(patchPath, patch);
    const profileName = plan.mode === 'inspect' ? 'plugin-inspect' : plan.mode === 'open' ? 'web' : 'headless';
    if (plan.mode === 'inspect') {
      const profile = join(env.DSH_HOME, 'profiles', profileName);
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await json(join(profile, 'package.json'), { name: 'disposable-plugin-inspect', private: true, dsh: { profile: { bundles: [] } } });
      await json(join(profile, 'cordis.patch.yml'), []);
    }
    // Installing into the disposable profile is what makes this a blank board:
    // the packages land in DSH_HOME, never in the host profile.
    const installInfo = plan.install.length > 0
      ? await installPackages({ root, runtime, dshVersion: runtimePackage.version, env, profileName, plan, cancelPath: join(dir, 'cancel'), evidence, scrub })
      : null;
    const args = ['--profile', profileName, '--patch', patchPath];
    if (plan.mode === 'inspect') args.push('--dump-config-schema');
    else args.push('--json', plan.prompt);
    const metadata = {
      format: 1, id, plan: plan.name, mode: plan.mode,
      dshVersion: runtimePackage.version, nodeVersion: process.version,
      platform: process.platform, arch: process.arch,
      planSha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
      plugins: modules.map(({ module, sha256 }) => ({ module, sha256 })),
      install: installInfo,
      credentialNames: plan.credentialEnv,
      isolation: 'disposable-directories-and-process-tree',
      limitations: ['Trusted plugin code can access host resources.', 'Remote device state requires a device-specific restore implementation.', 'No provider-side history erasure is performed.']
    };
    await writeFile(join(evidence, 'environment.json'), scrub(JSON.stringify(metadata, null, 2)), { mode: 0o600 });
    if (await exists(join(dir, 'cancel'))) { terminal = 'cancelled'; return; }
    if (plan.mode === 'open') {
      terminal = await openSession({
        runtime, plan, env, workspace, dir, evidence, scrub, update,
        cancelPath: join(dir, 'cancel'), destroyPath: join(dir, 'destroy')
      });
      return;
    }
    await update({ state: 'running' });
    const result = await capture(runtime.entry, args, {
      cwd: workspace, env, timeoutMs: plan.timeoutSeconds * 1000,
      maxOutputBytes: plan.maxOutputBytes, cancelPath: join(dir, 'cancel'),
      onSpawn: pid => update({ childPid: pid })
    });
    await writeFile(join(evidence, 'stdout.log'), scrub(result.stdout), { mode: 0o600 });
    await writeFile(join(evidence, 'stderr.log'), scrub(result.stderr), { mode: 0o600 });
    let check = { kind: plan.mode, passed: false };
    if (result.code === 0 && !result.reason) {
      if (plan.mode === 'inspect') {
        try {
          const schema = JSON.parse(result.stdout);
          check.passed = schema['x-cordis']?.complete === true;
          check.entries = schema['x-cordis']?.entries?.filter(e => e.id?.startsWith('test-subject-')).map(e => ({ id: e.id, status: e.status })) ?? [];
          if (check.entries.length !== modules.length || check.entries.some(e => ['error', 'unsupported'].includes(e.status))) check.passed = false;
        } catch { check.error = 'DSH did not return a valid complete config schema'; }
      } else {
        const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
        const final = events.findLast(e => e?.type === 'final');
        // rc.5 stores the terminal reason on status/turn_end; later runtimes may
        // repeat it on final. Both a final record and a completed turn are needed.
        const reason = final?.reason ?? events.findLast(e => e?.type === 'status' && e.phase === 'turn_end')?.reason;
        check.passed = Boolean(final) && events.every(Boolean) && reason?.kind === 'completed';
        check.finalReason = reason ?? null;
      }
    }
    terminal = result.reason ?? (result.code === 0 && check.passed ? 'completed' : 'failed');
    await update({ state: 'collecting', exitCode: result.code, exitSignal: result.signal, check });
    // Explicit workspace files only; no automatic copying of memories, credentials or sessions.
    const files = [];
    for (const name of plan.evidence) {
      const source = join(workspace, name), target = join(evidence, 'files', name);
      try {
        const st = await lstat(source);
        if (!st.isFile() || st.isSymbolicLink() || !inside(await realpath(workspace), await realpath(source))) throw new Error('Evidence must be a regular workspace file');
        if (st.size > 16 * 1024 * 1024) throw new Error('Evidence file exceeds 16 MiB');
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const bytes = await readFile(source);
        // Exact injected secrets are removed; binary output may be altered if it contains one.
        let safe = bytes;
        for (const secret of secrets) {
          const needle = Buffer.from(secret), replacement = Buffer.from('[REDACTED]'), parts = [];
          let offset = 0, at;
          while ((at = safe.indexOf(needle, offset)) !== -1) { parts.push(safe.subarray(offset, at), replacement); offset = at + needle.length; }
          parts.push(safe.subarray(offset)); safe = Buffer.concat(parts);
        }
        await writeFile(target, safe, { mode: 0o600 });
        files.push({ name, bytes: safe.length, sha256: createHash('sha256').update(safe).digest('hex') });
      } catch (error) { files.push({ name, error: scrub(error.message) }); terminal = terminal === 'completed' ? 'failed' : terminal; }
    }
    await json(join(evidence, 'files.json'), files);
    if (plan.expect.length > 0) {
      const assertions = await evaluateExpectations(evidence, plan.expect);
      const passed = assertions.every(item => item.ok);
      check = { ...check, passed: check.passed && passed, assertions };
      await update({ check });
      if (!passed) terminal = 'failed';
    }
  } catch (error) {
    if (error?.code === 'cancelled') terminal = 'cancelled';
    await update({ error: scrub(error.message) });
  } finally {
    await update({ state: 'cleaning' });
    try {
      await cleanSandbox(dir, id);
      status = { ...status, state: terminal, cleanup: 'succeeded', endedAt: new Date().toISOString() };
    } catch (error) {
      status = { ...status, state: terminal, cleanup: 'failed', cleanupError: scrub(error.message), endedAt: new Date().toISOString() };
    }
    await json(join(evidence, 'result.json'), status);
    await update({});
  }
}

/**
 * Install the plan's packages into the disposable profile.
 *
 * The profile lives inside the sandbox, so nothing reaches the host profile.
 * The install itself reuses the host's pnpm store and registry configuration —
 * a warm content-addressed cache, not host state that affects results.
 */
async function installPackages({ root, runtime, dshVersion, env, profileName, plan, cancelPath, evidence, scrub }) {
  const profile = join(env.DSH_HOME, 'profiles', profileName);
  const key = await imageKey({ dshVersion, install: plan.install });
  // Reuse a prepared profile image: same install inputs → same bytes, no pnpm.
  if (plan.installMode !== 'fresh' && await imageReady(root, key)) {
    const startedAt = Date.now();
    const image = await restoreImage(root, key, profile);
    await writeFile(join(evidence, 'install.log'), scrub(`restored image ${key} (${(image.packages ?? []).length} package(s))\n`), { mode: 0o600 });
    return { packages: image.packages ?? [], lockfileSha256: image.lockfileSha256 ?? null, durationMs: Date.now() - startedAt, cached: true, imageKey: key };
  }
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const manifestPath = join(profile, 'package.json');
  // Interactive runs let `dsh plugin` create the profile itself so it composes
  // the web bundle set; pre-creating it here would omit @deepseek-ai/dsh-web-app.
  if (plan.mode !== 'open' && !await exists(manifestPath)) {
    await json(manifestPath, { name: `disposable-${profileName}`, private: true, dsh: { profile: { bundles: [] } } });
  }
  const startedAt = Date.now();
  const result = await capture(runtime.entry, [
    'plugin', '--profile', profileName, 'add', ...plan.install.map(item => item.source), '--ignore-scripts'
  ], {
    cwd: profile,
    env: { ...process.env, DSH_HOME: env.DSH_HOME, DSH_AGENTS_HOME: env.DSH_AGENTS_HOME },
    timeoutMs: plan.installTimeoutSeconds * 1000,
    maxOutputBytes: plan.maxOutputBytes,
    cancelPath
  });
  await writeFile(join(evidence, 'install.log'), scrub(`${result.stdout}${result.stderr}`), { mode: 0o600 });
  if (result.reason === 'cancelled') throw Object.assign(new Error('Install cancelled'), { code: 'cancelled' });
  if (result.reason) throw new Error(`Install ${result.reason}; see install.log`);
  if (result.code !== 0) throw new Error(`Install failed with exit code ${result.code}; see install.log`);
  const manifest = await readJson(manifestPath);
  const dependencies = manifest.dependencies ?? {};
  if (Object.keys(dependencies).length < plan.install.length) throw new Error('Install did not record every requested package; see install.log');
  const packages = [];
  for (const [name, spec] of Object.entries(dependencies)) {
    let version = null;
    try { version = (await readJson(join(profile, 'node_modules', name, 'package.json'))).version ?? null; } catch { /* linked or pruned */ }
    packages.push({ name, spec, version });
  }
  const lockPath = join(profile, 'pnpm-lock.yaml');
  const lockfileSha256 = await exists(lockPath) ? createHash('sha256').update(await readFile(lockPath)).digest('hex') : null;
  const info = { packages, lockfileSha256, durationMs: Date.now() - startedAt, cached: false, imageKey: key };
  // Snapshot for the next run. Best-effort: a failed snapshot only costs time,
  // but the reason is recorded so a bad image is diagnosable.
  try {
    await saveImage(root, key, profile, {
      dshVersion,
      install: plan.install.map(item => item.source),
      packages,
      lockfileSha256
    });
  } catch (error) {
    info.imageError = scrub(error?.message ?? String(error));
  }
  return info;
}

/**
 * Park an interactive DSH and wait for the operator to destroy it.
 *
 * The web server prints `dsh web: <url>` with its one-time token; that URL is
 * the whole interface the operator uses. Nothing is automated here: the run
 * stays `open` until `destroy` appears, the idle cap passes, or the child dies.
 */
async function openSession({ runtime, plan, env, workspace, dir, evidence, scrub, update, cancelPath, destroyPath }) {
  // `dsh web` only accepts --patch before its own options.
  const args = ['web'];
  const patchPath = join(dir, 'sandbox', 'test.patch.yml');
  if (await exists(patchPath)) args.push('--patch', patchPath);
  args.push('--port', '0', '--no-open');
  const child = spawn(process.execPath, [runtime.entry, ...args], {
    cwd: workspace, env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (!child.pid) throw new Error('DSH web did not start');
  await update({ state: 'open', childPid: child.pid, openedAt: new Date().toISOString() });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 262144) stdout = stdout.slice(-131072); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (stderr.length > 262144) stderr = stderr.slice(-131072); });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let closed = null;
  exited.then(value => { closed = value; });

  const deadline = Date.now() + plan.openTimeoutSeconds * 1000;
  let url = null, terminal = 'failed';
  for (;;) {
    if (closed) { terminal = 'failed'; break; }
    const match = stdout.match(/dsh web:\s*(https?:\/\/\S+)/);
    if (match && !url) {
      url = match[1];
      await update({ url, state: 'open' });
    }
    if (url && (await exists(destroyPath) || await exists(cancelPath))) { terminal = 'destroyed'; break; }
    if (Date.now() > deadline) { terminal = 'timed_out'; break; }
    if (closed) { terminal = 'failed'; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await stopTree(child);
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 15000))]);
  await writeFile(join(evidence, 'stdout.log'), scrub(stdout), { mode: 0o600 });
  await writeFile(join(evidence, 'stderr.log'), scrub(stderr), { mode: 0o600 });
  if (terminal === 'failed' && !url) await update({ error: scrub(stderr.trim().split('\n').slice(-3).join('\n') || 'DSH web exited before printing a URL') });
  return terminal;
}

/** Read a dot path (`a.b.0.c`) out of parsed JSON. */
function readPath(value, path) {
  let current = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Check the assertions in `plan.expect` against the collected evidence.
 *
 * Assertions never run the subject again and never interpret model text: they
 * only read files the operator explicitly asked to keep.
 */
export async function evaluateExpectations(evidenceDir, expectations) {
  const results = [];
  for (const [index, item] of expectations.entries()) {
    const target = join(evidenceDir, item.file);
    if (!inside(evidenceDir, target)) {
      results.push({ index, file: item.file, ok: false, error: 'evidence path escapes the directory' });
      continue;
    }
    let text;
    try {
      text = await readFile(target, 'utf8');
    } catch {
      results.push({ index, file: item.file, ok: false, error: 'file was not collected' });
      continue;
    }
    try {
      if (item.contains !== undefined) {
        const ok = text.includes(item.contains);
        results.push({ index, file: item.file, ok, ...(ok ? {} : { expected: item.contains, error: 'text not found' }) });
        continue;
      }
      if (item.matches !== undefined) {
        const ok = new RegExp(item.matches).test(text);
        results.push({ index, file: item.file, ok, ...(ok ? {} : { expected: item.matches, error: 'pattern did not match' }) });
        continue;
      }
      const parsed = JSON.parse(text);
      const actual = item.path === undefined ? parsed : readPath(parsed, item.path);
      const ok = JSON.stringify(actual) === JSON.stringify(item.equals);
      results.push({ index, file: item.file, ...(item.path === undefined ? {} : { path: item.path }), ok, ...(ok ? {} : { expected: item.equals, actual }) });
    } catch (error) {
      results.push({ index, file: item.file, ok: false, error: typeof error.message === 'string' ? error.message.slice(0, 500) : 'assertion failed' });
    }
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  executeRun(process.argv[2], process.argv[3]).catch(async error => {
    if (process.connected) process.send({ error: error.message });
    process.exitCode = 1;
  }).finally(() => { if (process.connected) process.disconnect(); });
}
