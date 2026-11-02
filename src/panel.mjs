import { isAbsolute } from 'node:path';
import { Controller } from './controller.mjs';
import { listImages } from './image.mjs';
import { resolveRoot, rootSource, writeSettings } from './settings.mjs';

/**
 * Host half of the test-controller panel: a small JSON API on the DSH web
 * server. The browser half (`src/client.js`) is the only consumer; the agent
 * tools stay in `src/plugin.mjs` so a CLI-only profile keeps working without a
 * web server.
 */
export const name = 'plugin-test-panel';
export const inject = ['webServer'];

const PREFIX = '/plugin-test';
const MAX_BODY_BYTES = 64 * 1024;
const LIST_LIMIT = 50;

function reply(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be JSON');
  }
}

export function apply(ctx, config = {}) {
  // Mutable: the panel can switch the state root at runtime, and the setting is
  // persisted so the tools, the CLI and the next start all use the same one.
  let controller = new Controller({ root: resolveRoot(config.root) });

  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}${path}`,
    handler
  }));

  const guarded = handler => async (req, res) => {
    try {
      const origin = req.headers?.origin;
      const host = req.headers?.host;
      if (origin && host && origin !== `http://${host}` && origin !== `https://${host}`) {
        reply(res, 403, { error: 'Cross-origin requests are rejected' });
        return;
      }
      await handler(req, res);
    } catch (error) {
      const missing = error?.code === 'ENOENT';
      reply(res, missing ? 404 : 400, { error: error?.message ?? String(error) });
    }
  };

  route('/state', guarded(async (req, res) => {
    const [plans, planDetails, runs, root] = await Promise.all([controller.plans(), controller.planDetails(), controller.list(), controller.root()]);
    reply(res, 200, { plans, planDetails, runs: runs.slice(0, LIST_LIMIT), root, rootSource: rootSource(config.root), credentials: controller.credentialNames() });
  }));

  route('/config', guarded(async (req, res) => {
    if (req.method === 'POST') {
      const { root } = await readBody(req);
      if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('root must be an absolute path');
      const next = new Controller({ root });
      await next.root(); // validates ownership and creates the directory
      writeSettings({ root });
      controller = next;
      reply(res, 200, { root, source: 'ui' });
      return;
    }
    if (req.method === 'DELETE') {
      writeSettings({});
      controller = new Controller({ root: resolveRoot(config.root) });
      reply(res, 200, { root: await controller.root(), source: rootSource(config.root) });
      return;
    }
    reply(res, 200, { root: await controller.root(), source: rootSource(config.root) });
  }));

  route('/plan', guarded(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST') {
      const { plan } = await readBody(req);
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan must be an object');
      reply(res, 200, await controller.addPlanObject(plan));
      return;
    }
    if (req.method === 'DELETE') {
      const name = url.searchParams.get('name');
      if (!name) throw new Error('name is required');
      reply(res, 200, await controller.removePlan(name));
      return;
    }
    const name = url.searchParams.get('name');
    if (!name) throw new Error('name is required');
    reply(res, 200, await controller.planDetail(name));
  }));

  route('/run', guarded(async (req, res) => {
    const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id');
    if (!id) throw new Error('id is required');
    if (req.method === 'DELETE') {
      reply(res, 200, await controller.removeRun(id));
      return;
    }
    reply(res, 200, await controller.runDetail(id));
  }));

  route('/images', guarded(async (req, res) => {
    reply(res, 200, await listImages(await controller.root()));
  }));

  route('/credentials', guarded(async (req, res) => {
    if (req.method === 'DELETE') {
      const { name } = await readBody(req);
      reply(res, 200, controller.clearCredential(name === undefined ? undefined : String(name)));
      return;
    }
    const { name, value } = await readBody(req);
    if (typeof value !== 'string') throw new Error('value must be a string');
    reply(res, 200, controller.setCredential(String(name), value));
  }));

  route('/start', guarded(async (req, res) => {
    const { plan } = await readBody(req);
    if (typeof plan !== 'string') throw new Error('plan must be a string');
    reply(res, 200, await controller.start(plan));
  }));

  route('/open', guarded(async (req, res) => {
    const { plan } = await readBody(req);
    if (typeof plan !== 'string') throw new Error('plan must be a string');
    reply(res, 200, await controller.start(plan));
  }));

  route('/destroy', guarded(async (req, res) => {
    const { id } = await readBody(req);
    if (typeof id !== 'string') throw new Error('id must be a string');
    reply(res, 200, await controller.destroy(id));
  }));

  route('/cancel', guarded(async (req, res) => {
    const { id } = await readBody(req);
    if (typeof id !== 'string') throw new Error('id must be a string');
    reply(res, 200, await controller.cancel(id));
  }));

  route('/status', guarded(async (req, res) => {
    const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id');
    if (!id) throw new Error('id is required');
    reply(res, 200, await controller.status(id));
  }));

  route('/export', guarded(async (req, res) => {
    const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id');
    if (!id) throw new Error('id is required');
    reply(res, 200, await controller.export(id));
  }));
}
