import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { publishCollection, partitionSource, withWriterLock, planFullSource } from '../pilot/publish-archive.mjs';
import { validateCollection } from '../collection.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = number => number.toString(16).padStart(64, '0');
const database = Buffer.alloc(2048 * 8192, 7), publicSetup = Buffer.alloc(45056, 9);
const databaseSha256 = hash(database), publicSha256 = hash(publicSetup);

function source(start, end, revision = 0) {
  const blocks = Array.from({ length: end - start + 1 }, (_, i) => ({ height: start + i, hash: id(1000 + start + i), transactionCount: 1 }));
  return {
    schema: 'zecblock-private-tx-source-v1', network: 'mainnet',
    snapshot: { height: end, hash: blocks.at(-1).hash, publishedAt: new Date(Date.UTC(2026, 10, 2, 0, 0, revision)).toISOString() },
    coverage: { startHeight: start, endHeight: end, transactionCount: blocks.length, complete: true, blocks },
    records: blocks.map(block => ({ txid: id(block.height), detail: { blockHeight: String(block.height), blockHash: block.hash, status: 'confirmed', isCanonical: true }, raw: { hex: '00' } })),
  };
}

function planner(maxRecords = 2047, chunks = 1) {
  return async value => ({ schema: 'zecblock-private-tx-plan-v1', recordCodec: 'json-context-zlib-v1', packing: 'compact-v1',
    rows: 2048, rowBytes: 8192, payloadBytes: 8064, records: value.records.length,
    payloadRows: value.records.length, coverRows: 1, totalRows: value.records.length + 1,
    chunkCount: chunks, legacyRecordBytesTotal: value.records.length <= maxRecords ? value.records.length * 1000 : 64 * 1024 ** 2 + 1,
    fits: value.records.length <= maxRecords && value.records.length + 1 <= 2048 && chunks <= 64 });
}

async function preparer(value, directory) {
  const publicationId = hash(JSON.stringify(value));
  const manifest = {
    schema: 'zecblock-private-tx-full-v1', publicationId, network: 'mainnet', packing: 'compact-v1', recordCodec: 'json-context-zlib-v1',
    geometry: 'full-2k-8k', rows: 2048, rowBytes: 8192, payloadBytes: 8064, coverRow: 2047, chunkCount: 1,
    scheme: { request_bytes: 20992, response_bytes: 10240, public_bytes: 45056 },
    snapshot: value.snapshot, coverage: value.coverage, databaseSha256, publicSha256,
    catalogue: value.records.map((record, index) => ({ txid: record.txid, height: Number(record.detail.blockHeight), rows: [index], recordBytes: 10, recordSha256: id(700 + index) })),
  };
  await Promise.all([
    writeFile(resolve(directory, 'source.json'), JSON.stringify(value)),
    writeFile(resolve(directory, 'database.bin'), database),
    writeFile(resolve(directory, 'public.bin'), publicSetup),
    writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest)),
  ]);
  return manifest;
}

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'pir-archive-publisher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { localDir: directory, planSource: planner(), prepareSource: preparer,
    withLock: async (_path, operation) => await operation(), beforeActivate: async () => {} };
  return { directory, options, publish: args => publishCollection({ ...options, ...args }) };
}

test('partitions fitting complete blocks without omitting records or advancing the floor', async () => {
  const input = source(10, 14);
  const parts = await partitionSource(input, { planSource: planner(2) });
  assert.deepEqual(parts.map(part => [part.source.coverage.startHeight, part.source.coverage.endHeight]), [[10, 11], [12, 13], [14, 14]]);
  assert.deepEqual(parts.flatMap(part => part.source.records.map(record => record.txid)), input.records.map(record => record.txid));
  await assert.rejects(partitionSource(source(10, 10), { planSource: planner(0) }), /complete source block exceeds/);
});

test('committed collection is the resumable coverage authority and retains earlier segments', async t => {
  const box = await fixture(t);
  const first = await box.publish({ sources: [source(10, 11)] });
  const second = await box.publish({ sources: [source(12, 13)] });
  const disk = validateCollection(JSON.parse(await readFile(resolve(box.directory, 'collection.json'), 'utf8')));
  assert.equal(second.previousCollectionId, first.collectionId);
  assert.equal(disk.collectionId, second.collectionId);
  assert.equal(disk.coverage.transactionCount, 4);
  assert.deepEqual(disk.coverage.ranges, [{ startHeight: 10, endHeight: 11, transactionCount: 2 }, { startHeight: 12, endHeight: 13, transactionCount: 2 }]);
  assert.equal(disk.coverage.complete, true);
  assert.equal((await readdir(box.directory)).includes('checkpoint.json'), false);
});

test('canonical admission failure leaves the exact previous head and can retry prepared immutable work', async t => {
  const box = await fixture(t);
  await box.publish({ sources: [source(10, 10)] });
  const head = await readFile(resolve(box.directory, 'collection.json'));
  await assert.rejects(box.publish({ sources: [source(11, 11)], beforeActivate: async () => { throw new Error('Canonical replacement'); } }), /Canonical replacement/);
  assert.deepEqual(await readFile(resolve(box.directory, 'collection.json')), head);
  const result = await box.publish({ sources: [source(11, 11)] });
  assert.equal(result.collection.coverage.transactionCount, 2);
  assert.equal((await readdir(box.directory)).some(name => name.startsWith('.archive-staging-')), false);
});

test('aggregate transport capacity rejects before expensive preparation or pointer change', async t => {
  const box = await fixture(t);
  let prepared = 0;
  await assert.rejects(box.publish({ sources: [source(10, 10), source(11, 11)], planSource: planner(1, 33),
    prepareSource: async () => { prepared++; throw new Error('Must not prepare'); } }), /fixed-query budget/);
  assert.equal(prepared, 0);
  await assert.rejects(readFile(resolve(box.directory, 'collection.json')), { code: 'ENOENT' });
});

test('silent retirement is forbidden and canonical reorg retirement must be explicit', async t => {
  const box = await fixture(t);
  const first = await box.publish({ sources: [source(10, 10)] });
  await assert.rejects(box.publish({ retainedSegments: [], sources: [source(11, 11)] }), /silently drop/);
  const replacement = source(10, 10, 1);
  replacement.records[0].txid = id(999);
  replacement.coverage.blocks[0].hash = id(9999);
  replacement.snapshot.hash = id(9999);
  replacement.records[0].detail.blockHash = id(9999);
  const result = await box.publish({ retainedSegments: [], sources: [replacement], retirePublicationIds: [first.collection.segments[0].publicationId] });
  assert.equal(result.collection.segments[0].manifest.catalogue[0].txid, id(999));
});

test('reference-aware GC pins current and two historical views and never touches legacy state', async t => {
  const box = await fixture(t);
  await mkdir(resolve(box.directory, 'publications'));
  await writeFile(resolve(box.directory, 'publications', 'legacy-sentinel'), 'preserve');
  const views = [];
  for (let revision = 0; revision < 5; revision++) views.push(await box.publish({ retainedSegments: [], sources: [source(10, 11, revision)] }));
  const history = await readdir(resolve(box.directory, 'collections'));
  assert.equal(history.length, 3);
  const segmentIds = await readdir(resolve(box.directory, 'segments'));
  assert.equal(segmentIds.length, 3);
  assert.ok(segmentIds.includes(views.at(-1).collection.segments[0].publicationId));
  assert.ok(segmentIds.includes(views.at(-2).collection.segments[0].publicationId));
  assert.equal(await readFile(resolve(box.directory, 'publications', 'legacy-sentinel'), 'utf8'), 'preserve');
});

test('a migration-seeded head without history still pins its previous immutable segment', async t => {
  const box = await fixture(t);
  const first = await box.publish({ sources: [source(10, 10)] });
  await rm(resolve(box.directory, 'collections', `${first.collectionId}.json`));
  const next = await box.publish({ sources: [source(11, 11)] });
  assert.equal(next.previousCollectionId, first.collectionId);
  assert.equal(JSON.parse(await readFile(resolve(box.directory, 'collections', `${first.collectionId}.json`), 'utf8')).collectionId, first.collectionId);
  assert.ok((await readdir(resolve(box.directory, 'segments'))).includes(first.collection.segments[0].publicationId));
});

test('disk budget and per-plan mismatch reject before activating any partial collection', async t => {
  const box = await fixture(t);
  await assert.rejects(box.publish({ sources: [source(10, 10)], budgetBytes: 1024, reserveBytes: 1024 }), /disk budget/);
  await assert.rejects(box.publish({ sources: [source(10, 10)], prepareSource: async (value, path) => {
    const manifest = await preparer(value, path); manifest.chunkCount = 2; return manifest;
  } }), /differs from its native plan/);
  await assert.rejects(readFile(resolve(box.directory, 'collection.json')), { code: 'ENOENT' });
});

test('unknown staging is preserved and a symlinked retained artifact cannot alter outside files', async t => {
  const box = await fixture(t);
  const unrelated = resolve(box.directory, '.archive-staging-unrelated');
  await mkdir(unrelated);
  await writeFile(resolve(unrelated, 'sentinel'), 'preserve');
  const first = await box.publish({ sources: [source(10, 10)] });
  const outside = resolve(box.directory, 'outside');
  await writeFile(outside, 'outside untouched');
  const path = resolve(box.directory, 'segments', first.collection.segments[0].publicationId, 'public.bin');
  await rm(path); await symlink(outside, path);
  await assert.rejects(box.publish({ sources: [] }), /Unsafe|symbolic links/);
  assert.equal(await readFile(outside, 'utf8'), 'outside untouched');
  assert.equal(await readFile(resolve(unrelated, 'sentinel'), 'utf8'), 'preserve');
});

test('restart reclaims only marked owned staging under the writer lock', async t => {
  const box = await fixture(t);
  const stale = resolve(box.directory, '.archive-staging-Ab3dE7');
  const unmarked = resolve(box.directory, '.archive-staging-Zy6wV5');
  await mkdir(stale); await mkdir(unmarked);
  await writeFile(resolve(stale, 'owner.json'), JSON.stringify({ schema: 'zecblock-private-archive-staging-v1', root: resolve(box.directory) }));
  await writeFile(resolve(stale, 'unfinished'), 'old private candidate');
  await writeFile(resolve(unmarked, 'sentinel'), 'preserve');
  await box.publish({ sources: [source(10, 10)] });
  await assert.rejects(readdir(stale), { code: 'ENOENT' });
  assert.equal(await readFile(resolve(unmarked, 'sentinel'), 'utf8'), 'preserve');
});

test('aborted planner waits for actual child exit before returning control', { timeout: 5000 }, async t => {
  const box = await fixture(t);
  const binary = resolve(box.directory, 'delayed-native'), pidFile = resolve(box.directory, 'native.pid');
  await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');process.once('SIGTERM',()=>setTimeout(()=>process.exit(1),150));fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)},${JSON.stringify(pidFile)});setInterval(()=>{},1000);\n`);
  await chmod(binary, 0o700);
  const controller = new AbortController();
  const job = planFullSource(source(10, 10), box.directory, { binary, signal: controller.signal });
  const rejected = assert.rejects(job, { name: 'AbortError' });
  let pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const candidate = Number(await readFile(pidFile, 'utf8'));
      if (Number.isSafeInteger(candidate) && candidate > 0) { pid = candidate; break; }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Disposable native helper did not start.');
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } });
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Linux inherited-FD writer lock excludes another writer and releases on exit', { skip: process.platform !== 'linux' }, async t => {
  const box = await fixture(t);
  let entered = false;
  await withWriterLock(box.directory, async () => {
    await assert.rejects(withWriterLock(box.directory, async () => { entered = true; }), /already locked/);
  });
  assert.equal(entered, false);
  await withWriterLock(box.directory, async () => { entered = true; });
  assert.equal(entered, true);
});
