import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareState, stateBytes } from '../pilot/state-budget.mjs';

test('serialized publisher cleans killed candidates while preserving immutable publications and outside paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pir-pilot-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'), pubs = join(state, 'publications');
  await mkdir(join(pubs, '.candidate-ABC123'), { recursive: true });
  await writeFile(join(pubs, '.candidate-ABC123', 'partial.bin'), 'abandoned');
  const current = join(pubs, 'a'.repeat(64));
  await mkdir(current);
  await writeFile(join(current, 'database.bin'), 'immutable');
  await prepareState(state);
  await assert.rejects(readFile(join(pubs, '.candidate-ABC123', 'partial.bin')), { code: 'ENOENT' });
  assert.equal(await readFile(join(current, 'database.bin'), 'utf8'), 'immutable');
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'outside');
  await symlink(outside, join(pubs, '.candidate-XYZ123'));
  await assert.rejects(prepareState(state), /symbolic links/);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'outside');
});

test('publisher refuses a new candidate when disk budget cannot reserve the bounded preparation space', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pir-pilot-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await prepareState(dir);
  const used = await stateBytes(dir);
  await assert.rejects(prepareState(dir, { budgetBytes: used + 9, reserveBytes: 10 }), /disk budget exceeded/);
});

test('publisher rejects symlinked state or publications parents before any abandoned-candidate cleanup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pir-pilot-parent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const kind of ['state', 'publications']) {
    const outside = join(dir, `outside-${kind}`);
    await mkdir(join(outside, '.candidate-ABC123'), { recursive: true });
    const keep = join(outside, '.candidate-ABC123', 'keep');
    await writeFile(keep, 'outside');
    const state = join(dir, `state-${kind}`);
    if (kind === 'state') await symlink(outside, state);
    else { await mkdir(state); await symlink(outside, join(state, 'publications')); }
    await assert.rejects(prepareState(state), /symbolic links/);
    assert.equal(await readFile(keep, 'utf8'), 'outside');
  }
});
