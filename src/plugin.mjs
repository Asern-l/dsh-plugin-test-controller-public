import { defineTool } from '@deepseek-ai/dsh-tools';
import { Controller } from './controller.mjs';
import { resolveRoot } from './settings.mjs';

export const name = 'plugin-test-controller';
export const inject = ['tools'];

const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
export function apply(ctx, config = {}) {
  // Built per call: the panel can change the state root at runtime, and every
  // entry point must agree on one directory without a restart.
  const controllerFor = () => new Controller({ root: resolveRoot(config.root) });
  const owned = [];
  let disposing = false;
  ctx.effect(() => async () => {
    disposing = true;
    // A detached runner completes cleanup even after this plugin has unloaded.
    await Promise.allSettled(owned.map(({ controller, id }) => controller.cancel(id)));
  });
  const register = (toolName, description, parameters, execute) => ctx.tools.register(defineTool({
    name: toolName, description, parameters, output,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return execute(args, exec);
    }
  }));
  const id = { type: 'string', required: true, description: 'Run ID returned by plugin_test_start.' };
  register('plugin_test_plans', 'List operator-approved test plans. Plans are registered outside the agent.', {}, () => controllerFor().plans());
  register('plugin_test_start', 'Start an approved plan in a fresh disposable DSH. Returns a run ID; poll plugin_test_status until settled. Trusted host plugin code executes outside a security sandbox.', {
    plan: { type: 'string', required: true, description: 'An approved plan name, not a file path.' }
  }, async ({ plan }, exec) => {
    if (disposing) throw new Error('Controller is unloading');
    const controller = controllerFor();
    const result = await controller.start(plan, { signal: exec.signal });
    owned.push({ controller, id: result.id });
    if (disposing) await controller.cancel(result.id);
    return result;
  });
  register('plugin_test_status', 'Read run state, execution checks and cleanup state.', { id }, ({ id }) => controllerFor().status(id));
  register('plugin_test_open', 'Open an interactive plan: starts a parked disposable DSH and returns its web URL. The operator chats there until plugin_test_destroy.', {
    plan: { type: 'string', required: true, description: 'An approved plan name whose mode is open.' }
  }, async ({ plan }, exec) => {
    if (disposing) throw new Error('Controller is unloading');
    const controller = controllerFor();
    const result = await controller.start(plan, { signal: exec.signal });
    owned.push({ controller, id: result.id });
    if (disposing) await controller.destroy(result.id);
    return result;
  });
  register('plugin_test_destroy', 'Destroy a parked interactive run: kills its DSH, collects evidence and removes the sandbox.', { id }, ({ id }) => controllerFor().destroy(id));
  register('plugin_test_cancel', 'Request cancellation. Poll status until cleanup settles.', { id }, ({ id }) => controllerFor().cancel(id));
  register('plugin_test_export', 'Return the settled evidence directory and result. Does not upload anything.', { id }, ({ id }) => controllerFor().export(id));
}
