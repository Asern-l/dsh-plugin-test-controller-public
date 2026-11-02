import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as plugin from '../src/plugin.mjs';
import { Controller } from '../src/controller.mjs';
import { json, exists } from '../src/storage.mjs';

test('real Cordis registry mounts and unloads all controller tools', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-mount-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    const mounted = ctx.plugin(plugin, { root: join(temp, 'state') }); await mounted;
    assert.equal(ctx.tools.schemas().length, 7);
    const definition = ctx.tools.get('plugin_test_plans');
    const result = await definition.execute({}, { signal: new AbortController().signal });
    assert.deepEqual(result, []);
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, result), []);
    await mounted.dispose();
    assert.equal(ctx.tools.schemas().length, 0);
  } finally { await ctx.fiber.dispose(); }
});

test('two real DSH CLI runs use fresh homes, archive evidence, and delete all temporary state', { timeout: 120000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-cli-integration-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 3 }));
  const subject = join(temp, 'subject.mjs');
  // Top-level imports run during schema inspection. Seed memory on purpose and
  // fail the next run if any previous DSH/user/agent home is reused.
  await writeFile(subject, `import{existsSync,writeFileSync}from'node:fs';import{join}from'node:path';for(const key of ['DSH_HOME','DSH_AGENTS_HOME','HOME']){const p=join(process.env[key],'memory-sentinel');if(existsSync(p))throw Error('LEAKED_MEMORY');writeFileSync(p,'previous-run');}writeFileSync('proof.json',JSON.stringify({home:process.env.DSH_HOME,key:process.env.TEST_INJECTED_SECRET}));export const name='state-probe';export function apply(){};`);
  const plan = join(temp, 'plan.json');
  await json(plan, { name: 'isolation', mode: 'inspect', plugins: [{ module: subject }], credentialEnv: ['TEST_INJECTED_SECRET'], evidence: ['proof.json'], timeoutSeconds: 45 });
  const controller = new Controller({ root: join(temp, 'state') });
  await controller.addPlan(plan);
  const old = process.env.TEST_INJECTED_SECRET; process.env.TEST_INJECTED_SECRET = 'secret-for-test-only-78423';
  t.after(() => { if (old === undefined) delete process.env.TEST_INJECTED_SECRET; else process.env.TEST_INJECTED_SECRET = old; });
  const homes = [];
  for (let n = 0; n < 2; n++) {
    const started = await controller.start('isolation');
    const result = await controller.wait(started.id, { timeoutMs: 60000 });
    const exported = await controller.export(started.id);
    const stderr = await readFile(join(exported.directory, 'stderr.log'), 'utf8');
    assert.equal(result.state, 'completed', JSON.stringify(result) + stderr);
    assert.equal(result.cleanup, 'succeeded');
    assert.equal(result.verdict, 'not_evaluated');
    assert.equal(await exists(join(temp, 'state', 'runs', started.id, 'sandbox')), false);
    const proof = JSON.parse(await readFile(join(exported.directory, 'files', 'proof.json'), 'utf8'));
    assert.equal(proof.key, '[REDACTED]');
    assert.equal(await exists(proof.home), false);
    homes.push(proof.home);
  }
  assert.notEqual(homes[0], homes[1]);
});

test('failed DSH import is reported separately from successful cleanup', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-failure-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 3 }));
  const subject = join(temp, 'broken.mjs'); await writeFile(subject, 'throw new Error("intentional-plugin-failure");');
  const file = join(temp, 'plan.json'); await json(file, { name: 'failure', plugins: [{ module: subject }], timeoutSeconds: 30 });
  const controller = new Controller({ root: join(temp, 'state') }); await controller.addPlan(file);
  const run = await controller.start('failure'), result = await controller.wait(run.id);
  assert.equal(result.state, 'failed'); assert.equal(result.cleanup, 'succeeded');
  const exported = await controller.export(run.id);
  assert.match(await readFile(join(exported.directory, 'stderr.log'), 'utf8'), /intentional-plugin-failure/);
});

test('real headless DSH calls a subject tool through a local deterministic Messages server', { timeout: 180000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-headless-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 3 }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body || '{}') });
    const call = requests.length <= 2;
    const toolName = requests.length === 1 ? 'plugin_test_plans' : 'test_probe';
    const events = [
      { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: `call_probe_${requests.length}`, name: toolName, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: requests.length === 1 ? '{}' : '{"text":"ROUNDTRIP"}' } : { type: 'text_delta', text: 'READY' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' }
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const saved = { key: process.env.TEST_MODEL_KEY, url: process.env.DEEPSEEK_BASE_URL, api: process.env.DEEPSEEK_API_KEY };
  process.env.TEST_MODEL_KEY = 'local-fixture-key';
  process.env.DEEPSEEK_API_KEY = 'local-fixture-key';
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    for (const [name, value] of Object.entries({ TEST_MODEL_KEY: saved.key, DEEPSEEK_BASE_URL: saved.url, DEEPSEEK_API_KEY: saved.api })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const toolsUrl = pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools')).href;
  const subject = join(temp, 'subject.mjs');
  await writeFile(subject, `import{defineTool}from ${JSON.stringify(toolsUrl)};import{writeFile}from'node:fs/promises';export const name='headless-probe';export const inject=['tools'];export function apply(ctx){ctx.tools.register(defineTool({name:'test_probe',description:'Write deterministic test evidence.',parameters:{text:{type:'string',required:true}},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},async execute(args){await writeFile('plugin-result.json',JSON.stringify({text:args.text}));return args.text;}}));}`);
  const file = join(temp, 'plan.json');
  await json(file, { name: 'headless', mode: 'headless', prompt: 'List test plans, call test_probe with text ROUNDTRIP, then answer READY.', plugins: [{ module: fileURLToPath(new URL('../src/plugin.mjs', import.meta.url)), config: { root: join(temp, 'control-state') } }, { module: subject }], credentialEnv: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'], evidence: ['plugin-result.json'], timeoutSeconds: 120 });
  const controller = new Controller({ root: join(temp, 'state') }); await controller.addPlan(file);
  const run = await controller.start('headless'), result = await controller.wait(run.id, { timeoutMs: 150000 });
  const exported = await controller.export(run.id);
  const stderr = await readFile(join(exported.directory, 'stderr.log'), 'utf8');
  const stdout = await readFile(join(exported.directory, 'stdout.log'), 'utf8');
  assert.equal(result.state, 'completed', JSON.stringify(result) + '\n' + stderr + '\n' + stdout);
  assert.equal(result.cleanup, 'succeeded');
  assert.equal(requests.length, 3);
  assert.equal(JSON.parse(await readFile(join(exported.directory, 'files/plugin-result.json'), 'utf8')).text, 'ROUNDTRIP');
  assert.match(stdout, /READY/);
  assert.match(stdout, /plugin_test_plans/);
});

test('unloading the real controller cancels its active run; the runner finishes cleanup', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-unload-'));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 3 }));
  const subject = join(temp, 'slow.mjs');
  await writeFile(subject, 'await new Promise(r=>setTimeout(r,30000)); export const name="slow"; export function apply(){};');
  const file = join(temp, 'plan.json'); await json(file, { name: 'slow', plugins: [{ module: subject }], timeoutSeconds: 40 });
  const root = join(temp, 'state'), c = new Controller({ root }); await c.addPlan(file);
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
    const mounted = ctx.plugin(plugin, { root }); await mounted;
    const started = await ctx.tools.get('plugin_test_start').execute({ plan: 'slow' }, { signal: new AbortController().signal });
    await mounted.dispose();
    const result = await c.wait(started.id);
    assert.equal(result.state, 'cancelled');
    assert.equal(result.cleanup, 'succeeded');
    assert.equal(await exists(join(root, 'runs', started.id, 'sandbox')), false);
  } finally { await ctx.fiber.dispose(); }
});
