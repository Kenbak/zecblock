import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { collectionManifest, validateCollection, canonicalJson } from '../collection.mjs';
import { evaluatorPool, collectionPublications } from '../collection-server.mjs';
import { startPrototype } from '../server.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { atomicJson } from '../pilot/source-guard.mjs';

const hash = n => n.toString(16).padStart(64, '0');
function segment(start, chunks = 2, seed = start) {
  const manifest = { schema: 'zecblock-private-tx-full-v1', publicationId: hash(seed), network: 'mainnet',
    packing: 'compact-v1', coverRow: 2047, geometry: 'full-2k-8k', rows: 2048, rowBytes: 8192,
    scheme: { request_bytes: 20992, response_bytes: 10240, public_bytes: 45056 }, chunkCount: chunks,
    publicSha256: createHash('sha256').update(Buffer.alloc(45056)).digest('hex'),
    snapshot: { height: start, hash: hash(start + 100), publishedAt: '2026-11-02T12:00:00Z' },
    coverage: { startHeight: start, endHeight: start, blocks: [{ height: start, hash: hash(start + 100), transactionCount: 1 }] },
    catalogue: [{ txid: hash(start + 200), height: start, rows: [0], recordBytes: 3, recordSha256: hash(999) }] };
  return { publicationId: manifest.publicationId, manifest };
}

test('collection commitment binds complete immutable manifests, snapshot and ranges', () => {
  const manifest = collectionManifest({ segments: [segment(11), segment(10)] });
  assert.equal(manifest.coverage.complete, true);
  assert.equal(manifest.coverage.transactionCount, 2);
  assert.equal(manifest.segments[0].manifest.coverage.startHeight, 10);
  assert.equal(validateCollection(manifest), manifest);
  for (const mutate of [m => { m.snapshot.hash = hash(800); }, m => { m.segments[0].manifest.catalogue[0].recordSha256 = hash(801); }, m => { m.coverage.complete = false; }]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.throws(() => validateCollection(changed));
  }
  assert.equal(canonicalJson({ z: [2, { b: 3, a: 1 }], a: 'x' }), '{"a":"x","z":[2,{"a":1,"b":3}]}');
});

test('archive and live ranges expose gaps rather than falsely claiming complete history', () => {
  const manifest = collectionManifest({ segments: [segment(10), segment(20)] });
  assert.equal(manifest.coverage.complete, false);
  assert.deepEqual(manifest.coverage.ranges.map(r => [r.startHeight, r.endHeight]), [[10, 10], [20, 20]]);
  validateCollection(manifest);
});

test('aggregate query/segment bounds, duplicate txids, overlapping blocks and wrong geometry reject', () => {
  const repeated = segment(11); repeated.manifest.catalogue[0].txid = segment(10).manifest.catalogue[0].txid;
  assert.throws(() => collectionManifest({ segments: [segment(10), repeated] }), /Duplicate/);
  assert.throws(() => collectionManifest({ segments: [segment(10), segment(10, 2, 99)] }), /Overlapping/);
  assert.throws(() => collectionManifest({ segments: [segment(10, 33), segment(11, 32)] }), /fixed-query/);
  assert.throws(() => collectionManifest({ segments: Array.from({ length: 9 }, (_, n) => segment(n)) }), /segment capacity/);
  const bad = segment(10); bad.manifest.rows *= 2;
  assert.throws(() => collectionManifest({ segments: [bad] }), /geometry/);
  const incomplete = segment(10); incomplete.manifest.coverage.blocks[0].transactionCount = 2;
  assert.throws(() => collectionManifest({ segments: [incomplete] }), /count mismatch/);
});

test('evaluator pool keeps one heavy process, bounds admitted work and recovers after a table failure', async () => {
  let alive = 0, peak = 0;
  const ids = [], gates = [];
  const pool = evaluatorPool({ maximum: 3, createEvaluator: (_binary, directory) => {
    alive++; peak = Math.max(alive, peak); ids.push(directory);
    return { evaluate: query => new Promise((resolveReply, reject) => gates.push(() => query[0] === 9 ? reject(new Error('secret diagnostic')) : resolveReply(query))),
      close: async () => { alive--; } };
  } });
  const a = pool.evaluate(hash(1), 'first', Buffer.from([1]));
  const b = pool.evaluate(hash(2), 'second', Buffer.from([9]));
  const c = pool.evaluate(hash(2), 'second', Buffer.from([3]));
  // Attach rejection handling before the deliberate failure can settle.
  const failed = assert.rejects(b, /Private evaluator unavailable/);
  await assert.rejects(pool.evaluate(hash(3), 'third', Buffer.alloc(1)), /queue full/);
  while (!gates.length) await new Promise(resolveTick => setImmediate(resolveTick));
  gates.shift()(); assert.deepEqual(await a, Buffer.from([1]));
  while (!gates.length) await new Promise(resolveTick => setImmediate(resolveTick));
  gates.shift()(); await failed;
  while (!gates.length) await new Promise(resolveTick => setImmediate(resolveTick));
  gates.shift()(); assert.deepEqual(await c, Buffer.from([3]));
  assert.equal(peak, 1); assert.deepEqual(ids, ['first', 'second', 'second']);
  await pool.close(); assert.equal(alive, 0);
});

test('collection HTTP serves all immutable setup files, checks canonical guards and never exposes private artifacts', async t => {
  const localDir = await mkdtemp(resolve(tmpdir(), 'zecblock-collection-'));
  t.after(() => rm(localDir, { recursive: true, force: true }));
  const manifest = collectionManifest({ segments: [segment(10), segment(11)] });
  await writeFile(resolve(localDir, 'collection.json'), JSON.stringify(manifest));
  for (const entry of manifest.segments) {
    const dir = resolve(localDir, 'segments', entry.publicationId);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(entry.manifest));
    await writeFile(resolve(dir, 'public.bin'), Buffer.alloc(45056));
  }
  let valid = true;
  const publications = collectionPublications({ localDir, verifyCanonical: async () => { if (!valid) throw new Error('replacement chain'); },
    createEvaluator: () => ({ evaluate: async () => Buffer.alloc(10240), close: async () => {} }) });
  const app = await startPrototype({ port: 0, publications });
  t.after(() => app.close());
  const returned = await (await fetch(`${app.url}/publication/manifest.json`)).json();
  assert.equal(returned.collectionId, manifest.collectionId);
  for (const entry of manifest.segments) {
    assert.equal((await fetch(`${app.url}/publication/${entry.publicationId}/public.bin`)).status, 200);
    assert.equal((await fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': entry.publicationId }, body: Buffer.alloc(20992) })).status, 200);
  }
  for (const path of ['/segments/x/database.bin', '/collection.json', '/source.json', `/publication/${hash(99)}/public.bin`]) {
    assert.ok([404, 409].includes((await fetch(`${app.url}${path}`)).status));
  }
  valid = false;
  assert.equal((await fetch(`${app.url}/publication/manifest.json`)).status, 503);
  assert.equal((await fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': manifest.segments[0].publicationId }, body: Buffer.alloc(20992) })).status, 503);
});

test('cached publication IDs cannot substitute a different complete manifest in a later collection', async t => {
  const localDir = await mkdtemp(resolve(tmpdir(), 'zecblock-cache-drift-'));
  t.after(() => rm(localDir, { recursive: true, force: true }));
  const entry = segment(10);
  const dir = resolve(localDir, 'segments', entry.publicationId);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(entry.manifest));
  await writeFile(resolve(dir, 'public.bin'), Buffer.alloc(45056));
  await writeFile(resolve(localDir, 'collection.json'), JSON.stringify(collectionManifest({ segments: [entry] })));
  const publications = collectionPublications({ localDir }); t.after(() => publications.close());
  await publications.current();
  entry.manifest.scope = 'Changed metadata under an already cached publication ID';
  await writeFile(resolve(localDir, 'collection.json'), JSON.stringify(collectionManifest({ segments: [entry] })));
  await assert.rejects(publications.current(), /Cached immutable segment manifest changed/);
});

test('FIFO admission prevents newer requests to the current table overtaking an older different table', async () => {
  const order = []; let release;
  const pool = evaluatorPool({ createEvaluator: (_binary, directory) => ({
    evaluate: query => {
      order.push(directory);
      return query[0] === 1 ? new Promise(resolveReply => { release = () => resolveReply(query); }) : Promise.resolve(query);
    }, close: async () => {},
  }) });
  const first = pool.evaluate(hash(1), 'first', Buffer.from([1]));
  const older = pool.evaluate(hash(2), 'second', Buffer.from([2]));
  const newer = pool.evaluate(hash(1), 'first', Buffer.from([3]));
  while (!release) await new Promise(resolveTick => setImmediate(resolveTick));
  release(); await Promise.all([first, older, newer]);
  assert.deepEqual(order, ['first', 'second', 'first']);
  await pool.close();
});

test('uncertain evaluator shutdown rejects queued work and prevents a second native process', { timeout: 2000 }, async () => {
  let created = 0;
  const pool = evaluatorPool({ createEvaluator: () => { created++; return {
    evaluate: async () => { throw new Error('native failure'); }, close: async () => { throw new Error('uncertain exit'); },
  }; } });
  const answers = await Promise.allSettled([pool.evaluate(hash(1), 'first', Buffer.alloc(1)), pool.evaluate(hash(2), 'second', Buffer.alloc(1))]);
  assert.ok(answers.every(answer => answer.status === 'rejected'));
  assert.equal(created, 1);
  await assert.rejects(pool.evaluate(hash(3), 'third', Buffer.alloc(1)), /unavailable/);
  await pool.close();
});

test('group-readable source controls survive restrictive publisher umask and failed serialization leaves no temporary file', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'zecblock-control-modes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = resolve(dir, 'control.json');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {atomicJson} from ${JSON.stringify(new URL('../pilot/source-guard.mjs', import.meta.url).href)};process.umask(0o077);await atomicJson(${JSON.stringify(path)},{ready:true},0o640);`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  await assert.rejects(atomicJson(resolve(dir, 'invalid.json'), { unsupported: 1n }));
  assert.deepEqual(await readdir(dir), ['control.json']);
});
