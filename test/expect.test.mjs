import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validatePlan } from '../src/plan.mjs';
import { evaluateExpectations } from '../src/worker.mjs';

test('expect accepts path/contains/matches forms and rejects malformed entries', () => {
  const plan = validatePlan({
    name: 'asserted',
    expect: [
      { file: 'report.json', path: 'verdict', equals: 'supported' },
      { file: 'stdout.log', contains: 'ok' },
      { file: 'result.json', matches: '"state": "completed"' }
    ]
  });
  assert.equal(plan.expect.length, 3);

  const bad = [
    [{ file: '../x.json', equals: 1 }],
    [{ file: 'a.json' }],
    [{ file: 'a.json', equals: 1, contains: 'x' }],
    [{ file: 'a.json', matches: '(' }],
    [{ file: 'a.json', equals: 1, extra: true }],
    [{ file: resolve('x.json'), equals: 1 }]
  ];
  for (const expect of bad) assert.throws(() => validatePlan({ name: 'case', expect }), /expect/i, JSON.stringify(expect));
});

test('evaluations compare JSON paths, text and patterns against evidence files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-expect-'));
  try {
    await writeFile(join(dir, 'report.json'), JSON.stringify({ verdict: 'supported', checks: { control: { ok: true } } }));
    await writeFile(join(dir, 'stdout.log'), 'prefix ok suffix');
    const results = await evaluateExpectations(dir, [
      { file: 'report.json', path: 'verdict', equals: 'supported' },
      { file: 'report.json', path: 'checks.control.ok', equals: true },
      { file: 'report.json', path: 'verdict', equals: 'not_observed' },
      { file: 'stdout.log', contains: 'ok' },
      { file: 'stdout.log', contains: 'missing' },
      { file: 'stdout.log', matches: '^prefix' },
      { file: 'nope.json', equals: 1 },
      { file: '../escape.json', equals: 1 }
    ]);
    assert.deepEqual(results.map(r => r.ok), [true, true, false, true, false, true, false, false]);
    assert.equal(results[2].actual, 'supported');
    assert.equal(results[6].error, 'file was not collected');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
