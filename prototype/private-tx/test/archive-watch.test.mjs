import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { archiveTick, archiveHead, nextCapture } from '../pilot/archive-watch.mjs';
import { captureRequest } from '../pilot/archive-source.mjs';
import { collectionManifest } from '../collection.mjs';
import { MAINNET_GENESIS_HASH, PRIMARY_SNAPSHOT_SCHEMA, primaryFactsFingerprint } from '../primary-source.mjs';

const hash = n => n.toString(16).padStart(64, '0');
const config = { bootstrapHeight: 100, liveWindow: 16 };
function snapshot(start = 100, end = 100, changed = false) {
  const blocks = [], transactions = [], outputs = [];
  for (let height = start; height <= end; height++) {
    const txid = hash(height + (changed ? 3000 : 2000));
    const blockHash = hash(height + (changed ? 4000 : 1000));
    blocks.push({ height: `${height}`, hash: blockHash, previous_block_hash: hash(height - 1 + (changed ? 4000 : 1000)), timestamp: '1793275200', transaction_count: '1', coinbase_hex: '004142' });
    transactions.push({ txid, block_height: `${height}`, block_hash: blockHash, block_time: '1793275200', tx_index: '0',
      version: '5', size: '100', vin_count: '1', vout_count: '1', is_coinbase: 'true', has_ironwood: 'false',
      fee: null, total_input: '0', total_output: '9007199254740993', value_balance: '0' });
    outputs.push({ txid, vout_index: '0', value: '9007199254740993', address: null, spent: 'false' });
  }
  return { schema: PRIMARY_SNAPSHOT_SCHEMA, network: 'mainnet', database: 'zcash_explorer_mainnet', isPrimary: true, readOnly: true,
    genesisHash: MAINNET_GENESIS_HASH, observedAt: new Date().toISOString(), snapshotId: '1:1:',
    limits: { maxBlocks: 128, maxRecords: 2048, maxIoRows: 200000 }, tip: { height: end, hash: blocks.at(-1).hash },
    coverage: { startHeight: start, endHeight: end }, blocks, transactions, inputs: [], outputs };
}
async function workspace(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'zecblock-archive-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localDir = resolve(root, 'archive'), sourceDir = resolve(root, 'source');
  await mkdir(localDir); await mkdir(sourceDir);
  return { localDir, sourceDir };
}
async function input(paths, source, request = { schema: 'zecblock-private-capture-request-v1', startHeight: Number(source.coverage.startHeight) }) {
  const req = captureRequest(request);
  source.fingerprint = primaryFactsFingerprint(source); source.requestId = req.requestId;
  const guard = { schema: 'zecblock-private-source-guard-v1', state: 'ready', captureState: 'ready',
    // Bounded clock skew makes the injected no-build callback fresh; real native
    // preparation + independent post-build guard is covered in integration.
    observedAt: new Date(Date.now() + 500).toISOString(), requestId: req.requestId, fingerprint: source.fingerprint,
    tip: source.tip, blocks: source.blocks.map(block => ({ height: Number(block.height), hash: block.hash })) };
  const previous = await archiveHead(paths.localDir);
  const seen = new Set(guard.blocks.map(block => block.height));
  for (const segment of previous?.segments ?? []) {
    for (const block of [...segment.manifest.coverage.blocks, segment.manifest.snapshot]) {
      if (!seen.has(block.height)) { guard.blocks.push({ height: block.height, hash: block.hash }); seen.add(block.height); }
    }
  }
  await writeFile(resolve(paths.localDir, 'capture-request.json'), JSON.stringify(request));
  await writeFile(resolve(paths.sourceDir, 'latest.json'), JSON.stringify(source));
  await writeFile(resolve(paths.sourceDir, 'guard.json'), JSON.stringify(guard));
  return guard;
}
let counter = 9000;
function publishing(paths, hooks = {}) {
  return async options => {
    hooks.observed?.(options);
    const prepared = options.sources.map(source => {
      const publicationId = hash(counter++);
      return { publicationId, manifest: { schema: 'zecblock-private-tx-full-v1', publicationId, network: 'mainnet',
        packing: 'compact-v1', coverRow: 2047, geometry: 'full-2k-8k', rows: 2048, rowBytes: 8192, chunkCount: 1,
        scheme: { request_bytes: 20992, response_bytes: 10240, public_bytes: 45056 }, snapshot: source.snapshot, coverage: source.coverage,
        catalogue: source.records.map((record, index) => ({ txid: record.txid, height: Number(record.detail.blockHeight), rows: [index], recordBytes: 1, recordSha256: hash(5000) })) } };
    });
    const collection = collectionManifest({ segments: [...options.retainedSegments, ...prepared] });
    await hooks.before?.(options, collection);
    await options.beforeActivate(collection);
    await writeFile(resolve(paths.localDir, 'collection.json'), JSON.stringify(collection));
    return { collection, collectionId: collection.collectionId, cleanupWarning: false };
  };
}
const raw = async txid => ({ meta: { network: 'mainnet', generatedAt: new Date().toISOString() }, data: { txid, hex: '00', decoded: { txid } } });

test('archive/live scheduler catches the tip, declares gaps, backfills explicitly and repairs observed canonical replacements', async t => {
  const paths = await workspace(t); await input(paths, snapshot());
  await archiveTick({ ...paths, config, readRaw: raw, publish: publishing(paths) });
  const head = await archiveHead(paths.localDir);
  assert.equal(nextCapture({ collection: head, tip: { height: 101 }, ...config }).startHeight, 100);
  assert.equal(nextCapture({ collection: head, tip: { height: 1000 }, ...config }).startHeight, 985);
  assert.deepEqual(nextCapture({ collection: head, tip: { height: 100 }, ...config, backfillFrom: 0 }), {
    schema: 'zecblock-private-capture-request-v1', startHeight: 0, endHeight: 99,
  });
  const request = nextCapture({ collection: head, tip: { height: 101 }, blocks: [{ height: 100, hash: hash(999) }], ...config });
  assert.equal(request.startHeight, 100); assert.equal(request.endHeight, 100);
});

test('connected source export publishes exact data once, then derives restart progress from committed head', async t => {
  const paths = await workspace(t); await input(paths, snapshot());
  let reads = 0, published = 0;
  const publish = publishing(paths, { observed: options => {
    published++;
    assert.equal(options.sources[0].records[0].detail.totalOutputZat, '9007199254740993');
    assert.equal(options.sources[0].records[0].detail.feeZat, null);
  } });
  const result = await archiveTick({ ...paths, config, publish, readRaw: async txid => { reads++; return raw(txid); } });
  assert.equal(result.collection.coverage.transactionCount, 1);
  assert.equal((await archiveHead(paths.localDir)).collectionId, result.collectionId);
  const restarted = await archiveTick({ ...paths, config, publish, readRaw: async () => { throw new Error('Restart must not reread raw for already committed facts'); } });
  assert.equal(restarted.unchanged, true); assert.equal(reads, 1); assert.equal(published, 1);
});

test('live extension replaces the whole tail and retains every previously published transaction', async t => {
  const paths = await workspace(t); const publish = publishing(paths);
  await input(paths, snapshot()); await archiveTick({ ...paths, config, readRaw: raw, publish });
  const previous = await archiveHead(paths.localDir);
  await input(paths, snapshot(100, 101));
  const next = await archiveTick({ ...paths, config, readRaw: raw, publish });
  assert.equal(next.collection.segments.length, 1);
  assert.equal(next.collection.coverage.transactionCount, 2);
  assert.ok(next.collection.segments[0].manifest.catalogue.some(entry => entry.txid === previous.segments[0].manifest.catalogue[0].txid));
});

test('post-build fact correction rejects candidate without changing authoritative published head', async t => {
  const paths = await workspace(t); const publish = publishing(paths);
  await input(paths, snapshot()); await archiveTick({ ...paths, config, readRaw: raw, publish });
  const before = await readFile(resolve(paths.localDir, 'collection.json'));
  await input(paths, snapshot(100, 101));
  const failed = publishing(paths, { before: async () => {
    const guard = JSON.parse(await readFile(resolve(paths.sourceDir, 'guard.json'), 'utf8'));
    guard.fingerprint = hash(7000); await writeFile(resolve(paths.sourceDir, 'guard.json'), JSON.stringify(guard));
  } });
  await assert.rejects(archiveTick({ ...paths, config, readRaw: raw, publish: failed }), /facts changed/);
  assert.deepEqual(await readFile(resolve(paths.localDir, 'collection.json')), before);
});

test('independently observed reorg explicitly retires affected segment and publishes canonical replacement', async t => {
  const paths = await workspace(t); const publish = publishing(paths);
  await input(paths, snapshot()); await archiveTick({ ...paths, config, readRaw: raw, publish });
  const before = await archiveHead(paths.localDir);
  await input(paths, snapshot(100, 100, true));
  const next = await archiveTick({ ...paths, config, readRaw: raw, publish: publishing(paths, { observed: options => {
    assert.deepEqual(options.retirePublicationIds, [before.segments[0].publicationId]);
    assert.equal(options.retainedSegments.length, 0);
  } }) });
  assert.notEqual(next.collection.segments[0].manifest.catalogue[0].txid, before.segments[0].manifest.catalogue[0].txid);
});

test('stale/mismatched captures cannot trigger raw lookup or publication; payload outage keeps committed head', async t => {
  const paths = await workspace(t); const guard = await input(paths, snapshot());
  guard.fingerprint = hash(1); await writeFile(resolve(paths.sourceDir, 'guard.json'), JSON.stringify(guard));
  await assert.rejects(archiveTick({ ...paths, config, readRaw: async () => { throw new Error('Raw must not be called'); } }), /fingerprint/);
  guard.captureState = 'capacity-blocked'; guard.fingerprint = null;
  await writeFile(resolve(paths.sourceDir, 'guard.json'), JSON.stringify(guard));
  const result = await archiveTick({ ...paths, config });
  assert.equal(result.waiting, true); assert.equal(await archiveHead(paths.localDir), null);
  const status = JSON.parse(await readFile(resolve(paths.localDir, 'publisher-status.json'), 'utf8'));
  assert.equal(status.state, 'capacity-blocked');
});

test('multiple invalid archives retire together rather than deadlocking the first canonical repair', async t => {
  const paths = await workspace(t); const publish = publishing(paths);
  await input(paths, snapshot()); await archiveTick({ ...paths, config, readRaw: raw, publish });
  await input(paths, snapshot(200, 200)); await archiveTick({ ...paths, config, readRaw: raw, publish });
  const prior = await archiveHead(paths.localDir);
  assert.equal(prior.segments.length, 2);
  const changed = snapshot(100, 100, true);
  changed.tip = { height: 200, hash: hash(4200) };
  const guard = await input(paths, changed);
  guard.blocks = guard.blocks.map(block => block.height === 200 ? { height: 200, hash: hash(4200) } : block);
  await writeFile(resolve(paths.sourceDir, 'guard.json'), JSON.stringify(guard));
  const result = await archiveTick({ ...paths, config, readRaw: raw, publish: publishing(paths, { observed: options => {
    assert.deepEqual(options.retirePublicationIds, prior.segments.map(segment => segment.publicationId));
  } }) });
  assert.equal(result.collection.segments.length, 1);
  assert.equal(result.collection.snapshot.height, 200);
});

test('tip rollback below all retained data can activate a newly canonical lower range', async t => {
  const paths = await workspace(t); const publish = publishing(paths);
  await input(paths, snapshot()); await archiveTick({ ...paths, config, readRaw: raw, publish });
  const prior = await archiveHead(paths.localDir);
  assert.equal(nextCapture({ collection: prior, tip: { height: 90 }, blocks: [], ...config }).startHeight, 75);
  const source = snapshot(75, 90, true);
  const guard = await input(paths, source);
  guard.blocks = guard.blocks.filter(block => block.height <= 90);
  await writeFile(resolve(paths.sourceDir, 'guard.json'), JSON.stringify(guard));
  const result = await archiveTick({ ...paths, config, readRaw: raw, publish: publishing(paths, { observed: options => {
    assert.deepEqual(options.retirePublicationIds, [prior.segments[0].publicationId]);
  } }) });
  assert.equal(result.collection.coverage.endHeight, 90);
  assert.equal(result.collection.coverage.transactionCount, 16);
});

test('pending request acknowledgements are never overwritten by the previous source heartbeat', async t => {
  const paths = await workspace(t); await input(paths, snapshot());
  const request = { schema: 'zecblock-private-capture-request-v1', startHeight: 0, endHeight: 99 };
  await writeFile(resolve(paths.localDir, 'capture-request.json'), JSON.stringify(request));
  const result = await archiveTick({ ...paths, config });
  assert.equal(result.sourceState, 'request-pending');
  assert.deepEqual(JSON.parse(await readFile(resolve(paths.localDir, 'capture-request.json'), 'utf8')), request);
});

test('a waiting capture above a retreated tip reschedules below tip even with an older valid archive', async t => {
  const paths = await workspace(t); const publish = publishing(paths);
  await input(paths, snapshot()); await archiveTick({ ...paths, config, readRaw: raw, publish });
  await input(paths, snapshot(200, 200)); await archiveTick({ ...paths, config, readRaw: raw, publish });
  const source = snapshot(200, 200);
  const request = { schema: 'zecblock-private-capture-request-v1', startHeight: 201 };
  const guard = await input(paths, source, request);
  guard.captureState = 'waiting'; guard.fingerprint = null;
  guard.tip = { height: 190, hash: hash(1190) };
  guard.blocks = guard.blocks.filter(block => block.height <= 190);
  await writeFile(resolve(paths.sourceDir, 'guard.json'), JSON.stringify(guard));
  await archiveTick({ ...paths, config });
  const next = JSON.parse(await readFile(resolve(paths.localDir, 'capture-request.json'), 'utf8'));
  assert.equal(next.startHeight, 175);
});

test('recovery to identical published facts clears transient failure status without rebuilding', async t => {
  const paths = await workspace(t); const publish = publishing(paths);
  await input(paths, snapshot()); await archiveTick({ ...paths, config, readRaw: raw, publish });
  const before = await readFile(resolve(paths.localDir, 'collection.json'));
  await writeFile(resolve(paths.localDir, 'publisher-status.json'), JSON.stringify({ state: 'unavailable' }));
  const result = await archiveTick({ ...paths, config, publish: async () => { throw new Error('No rebuild expected'); } });
  assert.equal(result.unchanged, true);
  assert.equal(JSON.parse(await readFile(resolve(paths.localDir, 'publisher-status.json'), 'utf8')).state, 'ready');
  assert.deepEqual(await readFile(resolve(paths.localDir, 'collection.json')), before);
});

test('aggregate raw budget stops a verbose range before native work or head activation', async t => {
  const paths = await workspace(t); await input(paths, snapshot(100, 108));
  const rawCache = new Map(), padding = 'a'.repeat(7.5 * 1024 * 1024);
  await assert.rejects(archiveTick({ ...paths, config, rawCache,
    readRaw: async txid => ({ meta: { network: 'mainnet' }, data: { txid, hex: '00', decoded: { txid, padding } } }),
    publish: async () => { throw new Error('Capacity must reject before native publication'); },
  }), error => error.code === 'SOURCE_CAPACITY');
  assert.equal(await archiveHead(paths.localDir), null);
  assert.ok(rawCache.size <= 8);
  assert.ok([...rawCache.values()].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0) <= 64 * 1024 * 1024);
});
