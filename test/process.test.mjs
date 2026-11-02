import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capture } from '../src/process.mjs';
import { alive } from '../src/storage.mjs';

async function fixture(t, code) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-process-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const entry = join(dir, 'child.mjs'); await writeFile(entry, code);
  return { dir, entry, options: { cwd: dir, env: process.env, timeoutMs: 15000, maxOutputBytes: 8192, cancelPath: join(dir, 'cancel') } };
}

test('argument forwarding preserves Chinese, spaces, quotes, empty values and trailing slashes', async t => {
  const f = await fixture(t, 'console.log(JSON.stringify(process.argv.slice(2))); console.error("stderr-evidence");');
  const args = ['--profile', 'hello world', '中文路径', 'a"b', 'C:\\tail\\', '', 'x\\"y'];
  const result = await capture(f.entry, args, f.options);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.match(result.stderr, /stderr-evidence/);
});

test('timeout terminates a child and its descendants', async t => {
  const f = await fixture(t, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`);
  const result = await capture(f.entry, [], { ...f.options, timeoutMs: 5000 });
  assert.equal(result.reason, 'timed_out');
  const pids = JSON.parse(await readFile(join(f.dir, 'pids.json'), 'utf8'));
  for (const pid of pids) {
    for (let n = 0; n < 30 && alive(pid); n++) await new Promise(r => setTimeout(r, 100));
    assert.equal(alive(pid), false, `Process ${pid} survived timeout`);
  }
});

test('cancellation is observed and bounded output stops a noisy child', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)');
  const task = capture(f.entry, [], f.options);
  await writeFile(f.options.cancelPath, '');
  assert.equal((await task).reason, 'cancelled');
  await rm(f.options.cancelPath);
  await writeFile(f.entry, 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)');
  const noisy = await capture(f.entry, [], f.options);
  assert.equal(noisy.reason, 'output_limit');
  assert.ok(noisy.stdout.length <= f.options.maxOutputBytes);
});

test('normal exit cleans descendants holding output pipes', async t => {
  const f = await fixture(t, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';let c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync('pid',String(c.pid));c.unref();console.log('finished');`);
  const result = await capture(f.entry, [], f.options);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /finished/);
  const pid = Number(await readFile(join(f.dir, 'pid'), 'utf8'));
  for (let n = 0; n < 30 && alive(pid); n++) await new Promise(r => setTimeout(r, 100));
  assert.equal(alive(pid), false);
});
