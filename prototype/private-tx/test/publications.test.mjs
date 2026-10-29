import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPublications, startPrototype } from '../server.mjs';
import { publishRecent } from '../publish-recent.mjs';

const id = n => String(n).repeat(64);
test('publication routing retains in-flight generations and rejects retired/unknown generation without fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'private-tx-generations-'));
  const calls = [], closed = [];
  const publications = localPublications({ localDir: dir, createEvaluator: (_binary, path) => ({ evaluate: async bytes => { calls.push(path); return bytes; }, close: () => closed.push(path) }) });
  async function advance(n) {
    const path = join(dir, 'publications', id(n));
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'manifest.json'), JSON.stringify({ schema: 'zecblock-private-tx-full-v1', publicationId: id(n), chunkCount: 1, scheme: { request_bytes: 1 } }));
    await writeFile(join(path, 'public.bin'), Buffer.from([n]));
    await writeFile(join(dir, 'current.json'), JSON.stringify({ publicationId: id(n), directory: id(n) }));
  }
  await advance(1);
  const app = await startPrototype({ port: 0, publications });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  await advance(2);
  assert.equal((await (await fetch(`${app.url}/publication/manifest.json`)).json()).publicationId, id(2));
  const query = generation => fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': id(generation) }, body: Buffer.from([9]) });
  const wrongLength = await fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': id(1) }, body: Buffer.alloc(2) });
  assert.equal(wrongLength.status, 400);
  assert.equal(calls.length, 0, 'Wrong-sized ciphertext must not reach native IPC.');
  assert.equal((await query(1)).status, 200);
  assert.ok(calls.at(-1).endsWith(id(1)), 'Old query must use its original setup/data.');
  assert.equal((await query(2)).status, 200);
  assert.equal((await query(9)).status, 409);
  assert.equal((await fetch(`${app.url}/publication/${id(1)}/public.bin`)).status, 200);
  await advance(3); await publications.current();
  await advance(4); await publications.current();
  assert.equal(closed.length, 1);
  assert.equal((await query(1)).status, 409);
  assert.equal((await fetch(`${app.url}/publication/${id(1)}/public.bin`)).status, 409);
  assert.equal((await fetch(`${app.url}/publication/${id(4)}/source.json`)).status, 404);
  assert.equal((await fetch(`${app.url}/publication/${id(4)}/database.bin`)).status, 404);
});

test('oversized fixed batch cannot replace the last usable publication', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'private-tx-batch-admission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pointer = { publicationId: id(1), directory: id(1) };
  await writeFile(join(dir, 'current.json'), JSON.stringify(pointer));
  const binary = join(dir, 'prepare-fixture.mjs');
  await writeFile(binary, `#!${process.execPath}\nimport { writeFile } from 'node:fs/promises';\nawait writeFile(process.argv[4] + '/manifest.json', JSON.stringify({publicationId:'${id(2)}',chunkCount:65}));\n`);
  await chmod(binary, 0o755);
  await assert.rejects(publishRecent({ source: { snapshot: { publishedAt: new Date().toISOString() }, records: [] }, localDir: dir, binary }), /fixed-batch budget/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'current.json'), 'utf8')), pointer);
  assert.equal(JSON.parse(await readFile(join(dir, 'publisher-status.json'), 'utf8')).state, 'unavailable');
});

test('failed native preparation retains the previous pointer and reports unavailable source status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'private-tx-publisher-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pointer = { publicationId: id(1), directory: id(1) };
  await writeFile(join(dir, 'current.json'), JSON.stringify(pointer));
  // Node exits on the unsupported CLI filename; this tests the publication
  // transition without requiring a Rust build or any external source reads.
  await assert.rejects(publishRecent({ source: { snapshot: { height: 1 }, records: [] }, localDir: dir, binary: process.execPath }), /preparation failed/);
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'current.json'), 'utf8')), pointer);
  assert.equal(JSON.parse(await readFile(join(dir, 'publisher-status.json'), 'utf8')).state, 'unavailable');
});
