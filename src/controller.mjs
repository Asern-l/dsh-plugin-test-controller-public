import { mkdir, writeFile, readdir, readFile, stat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initRoot, json, readJson, runDirectory, exists, alive, cleanSandbox } from './storage.mjs';
import { validatePlan, loadPlan, isValidCredentialName } from './plan.mjs';
import { workerEnvironment } from './environment.mjs';

/**
 * The DSH home this process belongs to. Test state is a child of it, so the
 * controller's data travels with the DSH environment it was produced in:
 * back up `.dsh`, and every plan, run and evidence file comes along.
 */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), '.dsh');
}

/** States where the run still owns live resources and the worker is expected to be alive. */
const LIVE_STATES = ['queued', 'preparing', 'running', 'collecting', 'cleaning', 'open'];

export class Controller {
  constructor({ root = process.env.DSH_TEST_ROOT || join(dshHome(), 'plugin-test-controller') } = {}) {
    this.rootInput = resolve(root);
    // Operator-entered credentials live in memory only: never written to the
    // plan, the run directory, or argv. Names only are ever reported back.
    this.credentialsStore = new Map();
  }
  root() {
    // Memoized: concurrent first calls (plans + runs + root in one request)
    // would otherwise race the empty-directory ownership check.
    this.rootPromise ??= initRoot(this.rootInput).catch((error) => {
      this.rootPromise = undefined;
      throw error;
    });
    return this.rootPromise;
  }
  setCredential(name, value) {
    if (!isValidCredentialName(name)) throw new Error(`Invalid credential name: ${String(name)}`);
    if (typeof value !== 'string' || value.length === 0) throw new Error('Credential value must be a non-empty string');
    if (value.length > 32768) throw new Error('Credential value is too long');
    this.credentialsStore.set(name, value);
    return { configured: this.credentialNames() };
  }
  clearCredential(name) {
    if (name === undefined) this.credentialsStore.clear();
    else this.credentialsStore.delete(name);
    return { configured: this.credentialNames() };
  }
  credentialNames() { return [...this.credentialsStore.keys()]; }
  async addPlan(path) {
    const plan = await loadPlan(path);
    const root = await this.root();
    await json(join(root, 'plans', `${plan.name}.json`), plan);
    return { name: plan.name, mode: plan.mode };
  }
  async plans() {
    const root = await this.root();
    return (await readdir(join(root, 'plans'))).filter(n => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(n)).map(n => n.slice(0, -5)).sort();
  }
  /** Register a plan object coming from the panel; relative paths resolve against the state root. */
  async addPlanObject(input) {
    const root = await this.root();
    const plan = validatePlan(input, root);
    await json(join(root, 'plans', `${plan.name}.json`), plan);
    return { name: plan.name, mode: plan.mode };
  }
  async removePlan(name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid plan name');
    const root = await this.root();
    await rm(join(root, 'plans', `${name}.json`));
    return { name, removed: true };
  }
  /** Remove a settled run directory (status, evidence). Live runs must be stopped first. */
  async removeRun(id) {
    const root = await this.root(), dir = await runDirectory(root, id), status = await this.status(id);
    if (LIVE_STATES.includes(status.state)) throw new Error('Run is still live; cancel or destroy it first');
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return { id, removed: true };
  }
  /** Full plan plus its file path, for an operator-facing read-only view. */
  async planDetail(name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid plan name');
    const root = await this.root();
    const path = join(root, 'plans', `${name}.json`);
    return { name, path, plan: await readJson(path) };
  }
  /** Names plus their mode, for a UI that must offer "run" or "open" accordingly. */
  async planDetails() {
    const root = await this.root(), result = [];
    for (const name of await this.plans()) {
      try { result.push({ name, mode: (await readJson(join(root, 'plans', `${name}.json`))).mode ?? 'inspect' }); }
      catch { result.push({ name, mode: 'unreadable' }); }
    }
    return result;
  }
  async start(name, { signal, credentials } = {}) {
    signal?.throwIfAborted();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid plan name');
    const root = await this.root();
    const stored = Object.fromEntries(this.credentialsStore);
    const injected = credentials === undefined ? stored : { ...stored, ...credentials };
    for (const [key, value] of Object.entries(injected)) {
      if (!isValidCredentialName(key)) throw new Error(`Invalid credential name: ${key}`);
      if (typeof value !== 'string' || value.length === 0) throw new Error(`Credential value is missing for ${key}`);
    }
    const base = validatePlan(await readJson(join(root, 'plans', `${name}.json`)));
    // Names (never values) join the plan record so evidence redaction and the
    // environment audit cover panel-entered credentials too.
    const plan = Object.keys(injected).length === 0
      ? base
      : { ...base, credentialEnv: [...new Set([...base.credentialEnv, ...Object.keys(injected)])] };
    const env = workerEnvironment(plan, { ...process.env, ...injected });
    const id = `run-${randomUUID()}`, dir = join(root, 'runs', id);
    await mkdir(dir, { mode: 0o700 });
    await json(join(dir, 'owner.json'), { owner: 'dsh-test-controller', id });
    await json(join(dir, 'plan.json'), plan);
    await json(join(dir, 'status.json'), { format: 1, id, plan: name, state: 'queued', cleanup: 'pending', verdict: 'not_evaluated', createdAt: new Date().toISOString() });
    // Credentials travel in the child environment only; never in job files or argv.
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), root, id], { env, cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker startup timed out')), 15000);
        const finish = callback => value => { clearTimeout(timer); callback(value); };
        worker.once('message', finish(message => message?.ready ? resolveReady(message) : reject(new Error(message?.error ?? 'Invalid worker startup response'))));
        worker.once('error', finish(reject));
        worker.once('exit', finish(code => reject(new Error(`Worker exited before readiness (${code}); inspect status.json`))));
      });
    } catch (e) {
      await writeFile(join(dir, 'cancel'), '', { mode: 0o600 });
      e.message += `; run ID: ${id}`;
      throw e;
    } finally {
      if (worker.connected) worker.disconnect();
      worker.unref();
    }
    if (signal?.aborted) { await this.cancel(id); signal.throwIfAborted(); }
    return this.status(id);
  }
  async status(id) { return readJson(join(await runDirectory(await this.root(), id), 'status.json')); }
  async list() {
    const root = await this.root(), result = [];
    for (const id of await readdir(join(root, 'runs'))) {
      if (!/^run-[0-9a-f-]{36}$/.test(id)) continue;
      try { result.push(await this.status(id)); } catch (error) { result.push({ id, state: 'unreadable', error: error.message }); }
    }
    return result.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }
  async cancel(id) {
    const dir = await runDirectory(await this.root(), id), status = await this.status(id);
    if (LIVE_STATES.includes(status.state)) await writeFile(join(dir, 'cancel'), '', { mode: 0o600 });
    return { id, requested: true, state: status.state };
  }
  /** End an interactive run on demand; the worker kills the parked DSH and cleans up. */
  async destroy(id) {
    const dir = await runDirectory(await this.root(), id), status = await this.status(id);
    if (status.state !== 'open') return { id, requested: false, state: status.state };
    await writeFile(join(dir, 'destroy'), '', { mode: 0o600 });
    return { id, requested: true, state: status.state };
  }
  /** Status, evidence inventory, environment record and log tails for one run. */
  async runDetail(id) {
    const dir = await runDirectory(await this.root(), id), status = await this.status(id);
    const evidence = join(dir, 'evidence');
    const files = [];
    async function walk(current, prefix, depth) {
      let entries = [];
      try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = join(current, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory() && depth < 2) await walk(full, name, depth + 1);
        else if (entry.isFile()) {
          const info = await stat(full).catch(() => null);
          files.push({ name, bytes: info?.size ?? null });
        }
      }
    }
    await walk(evidence, '', 0);
    const tail = async (name) => {
      try { return (await readFile(join(evidence, name), 'utf8')).slice(-4000); } catch { return null; }
    };
    let environment = null;
    try { environment = await readJson(join(evidence, 'environment.json')); } catch { /* not written yet */ }
    return {
      id,
      status,
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
      environment,
      stdoutTail: await tail('stdout.log'),
      stderrTail: await tail('stderr.log'),
      installTail: await tail('install.log')
    };
  }
  async wait(id, { signal, timeoutMs = 24 * 60 * 60 * 1000 } = {}) {    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const status = await this.status(id);
      if (!LIVE_STATES.includes(status.state)) return status;
      if (status.workerPid && !alive(status.workerPid)) throw new Error(`Worker is absent; run recover ${id}`);
      if (Date.now() > deadline) throw new Error('Wait timed out; task may still be running');
      await new Promise(r => setTimeout(r, 100));
    }
  }
  async export(id) {
    const root = await this.root(), dir = await runDirectory(root, id), status = await this.status(id);
    if (['queued', 'preparing', 'running', 'collecting', 'cleaning'].includes(status.state)) throw new Error('Run is not settled');
    return { id, directory: join(dir, 'evidence'), status };
  }
  async recover(id) {
    const dir = await runDirectory(await this.root(), id), status = await this.status(id);
    if (alive(status.workerPid)) throw new Error('Worker is alive; cancel the task and await cleanup');
    if (alive(status.childPid)) throw new Error('A recorded child PID is still alive; verify and stop it before recovery (PID reuse is possible)');
    if (status.cleanup === 'succeeded' && !await exists(join(dir, 'sandbox'))) return status;
    await cleanSandbox(dir, id);
    const result = { ...status, state: 'interrupted', cleanup: 'succeeded', endedAt: new Date().toISOString(), recovery: 'Local files removed after worker/child absence check; remote state was not restored.' };
    await mkdir(join(dir, 'evidence'), { recursive: true, mode: 0o700 });
    await json(join(dir, 'evidence', 'result.json'), result);
    await json(join(dir, 'status.json'), result);
    return result;
  }
}
