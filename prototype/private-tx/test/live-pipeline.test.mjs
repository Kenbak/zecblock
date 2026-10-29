import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceTick } from '../pilot/source-watch.mjs';
import { atomicJson, verifyGuard } from '../pilot/source-guard.mjs';
import { admitSource, liveTick } from '../pilot/publish-live.mjs';
import { decodePrimarySnapshot, MAINNET_GENESIS_HASH, PRIMARY_SNAPSHOT_SCHEMA, primaryFactsFingerprint } from '../primary-source.mjs';
import { publishRecent } from '../publish-recent.mjs';
import { localPublications, startPrototype } from '../server.mjs';

const hash = value => BigInt(value).toString(16).padStart(64, '0');
const config = { startHeight: 100, maxBlocks: 16, maxRecords: 2048 };
const generousDisk = async () => ({ bavail: 10_000_000, bsize: 4096 });

// These synthetic source-shape fixtures exercise pipeline state transitions.
// Raw parsing and PIR cryptography remain covered by the native/browser suites.
function primaryFixture({ end = 100, tip = end, spent = false, blockHashes = {}, observedAt = new Date().toISOString(), snapshotId = '123:123:' } = {}) {
  const blocks = [], transactions = [], inputs = [], outputs = [];
  for (let height = 100; height <= end; height++) {
    const blockHash = blockHashes[height] ?? hash(height);
    const txid = hash(height + 10_000);
    const timestamp = String(1793275200 + height);
    blocks.push({ height: String(height), hash: blockHash, previous_block_hash: blockHashes[height - 1] ?? hash(height - 1), timestamp, transaction_count: '1', coinbase_hex: '004142' });
    transactions.push({ txid, block_height: String(height), block_hash: blockHash, block_time: timestamp, tx_index: '0', version: '5', locktime: '0', expiry_height: '0', size: '100', vin_count: '1', vout_count: '1', is_coinbase: 'true', has_sapling: 'false', has_orchard: 'false', has_ironwood: 'false', has_sprout: 'false', fee: '0', total_input: '0', total_output: '9007199254740993', value_balance: '0', value_balance_sapling: '0', value_balance_orchard: '0', value_balance_ironwood: '0' });
    // The production indexer omits the serialized coinbase vin from its input table.
    outputs.push({ txid, vout_index: '0', value: '9007199254740993', address: 'public-address-fixture', spent: spent ? 'true' : 'false' });
  }
  return decodePrimarySnapshot(JSON.stringify({
    schema: PRIMARY_SNAPSHOT_SCHEMA, network: 'mainnet', database: 'zcash_explorer_mainnet', isPrimary: true, readOnly: true, genesisHash: MAINNET_GENESIS_HASH,
    observedAt, snapshotId, limits: { ...config, maxIoRows: 200_000 },
    tip: { height: String(tip), hash: blockHashes[tip] ?? hash(tip) }, coverage: { startHeight: '100', endHeight: String(end) },
    blocks, transactions, inputs, outputs,
  }));
}

function guardFor(snapshot, overrides = {}) {
  return {
    schema: 'zecblock-private-source-guard-v1', state: 'ready', observedAt: new Date().toISOString(), sourceObservedAt: snapshot.observedAt,
    fingerprint: primaryFactsFingerprint(snapshot), tip: snapshot.tip, startHeight: snapshot.coverage.startHeight, endHeight: snapshot.coverage.endHeight,
    captureState: 'ready', blocks: snapshot.blocks.map(block => ({ height: Number(block.height), hash: block.hash })), ...overrides,
  };
}

function manifestFor(snapshot, publicationId = hash(1), extra = {}) {
  return {
    schema: 'zecblock-private-tx-full-v1', publicationId, chunkCount: 1, scheme: { request_bytes: 1 },
    snapshot: { height: snapshot.tip.height, hash: snapshot.tip.hash, publishedAt: snapshot.observedAt },
    coverage: { ...snapshot.coverage, blocks: snapshot.blocks.map(block => ({ height: Number(block.height), hash: block.hash })), ...extra },
  };
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zecblock-live-pipeline-'));
  const localDir = join(directory, 'state'), sourceDir = join(directory, 'source');
  await mkdir(localDir); await mkdir(sourceDir);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, localDir, sourceDir };
}

async function writePublication(localDir, manifest) {
  const directory = join(localDir, 'publications', manifest.publicationId);
  await mkdir(directory, { recursive: true });
  await atomicJson(join(directory, 'manifest.json'), manifest);
  await writeFile(join(directory, 'public.bin'), Buffer.from([1]));
  await atomicJson(join(localDir, 'current.json'), { publicationId: manifest.publicationId, directory: manifest.publicationId });
}

async function writeSource(sourceDir, snapshot, guardOverrides = {}) {
  await atomicJson(join(sourceDir, 'latest.json'), { ...snapshot, fingerprint: primaryFactsFingerprint(snapshot) });
  await atomicJson(join(sourceDir, 'guard.json'), guardFor(snapshot, guardOverrides));
}

function rawReader(snapshot, { padding = '', calls = [] } = {}) {
  return async txid => {
    calls.push(txid);
    const tx = snapshot.transactions.find(row => row.txid === txid);
    assert.ok(tx, 'Only source-cohort identifiers may reach the separately observed raw source.');
    return { meta: { network: 'mainnet', generatedAt: snapshot.observedAt }, data: { txid, hex: '00', decoded: { txid, blockhash: tx.block_hash, padding } } };
  };
}

async function activationHeartbeat(sourceDir, snapshot, callback, overrides = {}) {
  let heartbeatError;
  const heartbeat = new Promise(resolveHeartbeat => setTimeout(async () => {
    try { await atomicJson(join(sourceDir, 'guard.json'), guardFor(snapshot, overrides)); }
    catch (error) { heartbeatError = error; }
    resolveHeartbeat();
  }, 20));
  try { return await callback(); }
  finally { await heartbeat; if (heartbeatError) throw heartbeatError; }
}

test('unchanged committed facts update only the source heartbeat, not the captured artifact', async t => {
  const { sourceDir } = await workspace(t);
  const first = primaryFixture({ observedAt: '2026-10-29T00:00:00.000Z' });
  let diskChecks = 0;
  const statfsFn = async () => { diskChecks++; return generousDisk(); };
  const fingerprint = await sourceTick({ config, sourceDir, capture: async () => first, statfsFn });
  const previousBytes = await readFile(join(sourceDir, 'latest.json'));
  const previousStat = await stat(join(sourceDir, 'latest.json'));
  const next = primaryFixture({ observedAt: '2026-10-29T00:00:01.000Z', snapshotId: '124:124:' });
  const result = await sourceTick({ config, sourceDir, capture: async () => next, previousFingerprint: fingerprint, statfsFn });
  assert.equal(result, fingerprint);
  assert.deepEqual(await readFile(join(sourceDir, 'latest.json')), previousBytes);
  assert.equal((await stat(join(sourceDir, 'latest.json'))).ino, previousStat.ino, 'Unchanged facts must not rename/rewrite the source artifact.');
  const guard = JSON.parse(await readFile(join(sourceDir, 'guard.json')));
  assert.equal(guard.sourceObservedAt, next.observedAt);
  assert.equal(guard.fingerprint, fingerprint);
  assert.equal(guard.captureState, 'ready');
  assert.equal(diskChecks, 2);
});

test('source capacity fallback refreshes canonical checks of the admitted cohort without moving its floor', async t => {
  const { sourceDir } = await workspace(t);
  const previous = primaryFixture();
  await writeSource(sourceDir, previous);
  const calls = [], fallback = primaryFixture({ end: 100, tip: 101 });
  await sourceTick({ config, sourceDir, statfsFn: generousDisk, capture: async options => {
    calls.push(options);
    if (options.endHeight === undefined) throw Object.assign(new Error('Source capacity'), { code: 'CAPACITY' });
    return fallback;
  } });
  assert.deepEqual(calls, [config, { ...config, endHeight: 100 }]);
  const guard = JSON.parse(await readFile(join(sourceDir, 'guard.json')));
  assert.equal(guard.captureState, 'capacity-blocked');
  assert.equal(guard.startHeight, 100);
  assert.equal(guard.endHeight, 100);
  assert.equal(guard.tip.height, 101);
  assert.equal(verifyGuard(guard, manifestFor(previous)).state, 'ready');
});

test('same-height canonical replacement changes the source artifact and invalidates the prior hash', async t => {
  const { sourceDir } = await workspace(t);
  const old = primaryFixture();
  const previousFingerprint = await sourceTick({ config, sourceDir, capture: async () => old, statfsFn: generousDisk });
  const replacement = primaryFixture({ blockHashes: { 100: hash(900) } });
  const fingerprint = await sourceTick({ config, sourceDir, capture: async () => replacement, previousFingerprint, statfsFn: generousDisk });
  assert.notEqual(fingerprint, previousFingerprint);
  const guard = JSON.parse(await readFile(join(sourceDir, 'guard.json')));
  assert.throws(() => verifyGuard(guard, manifestFor(old)), /membership changed/);
  assert.equal(verifyGuard(guard, manifestFor(replacement)).fingerprint, fingerprint);
});

test('unavailable, stale, future and pre-activation guards fail closed', () => {
  const snapshot = primaryFixture(), manifest = manifestFor(snapshot), now = Date.now();
  for (const overrides of [
    { state: 'unavailable' }, { observedAt: new Date(now - 10_001).toISOString() },
    { observedAt: new Date(now + 1001).toISOString() }, { blocks: [] },
  ]) assert.throws(() => verifyGuard(guardFor(snapshot, overrides), manifest, { now }));
  assert.throws(() => verifyGuard(guardFor(snapshot, { observedAt: new Date(now - 1).toISOString() }), manifest, { now, notBefore: now }), /unavailable or stale/);
});

test('live publication includes the tip immediately and retains older identifiers with fresh details', async t => {
  const { localDir, sourceDir } = await workspace(t);
  const first = primaryFixture();
  await writePublication(localDir, manifestFor(first)); await writeSource(sourceDir, first);
  const cache = new Map(), rawCalls = [], captured = [];
  async function publish({ source, beforeActivate }) {
    const snapshot = captured.length ? second : first;
    captured.push(source);
    const manifest = { ...manifestFor(snapshot, hash(10 + captured.length)), snapshot: source.snapshot, coverage: source.coverage };
    await activationHeartbeat(sourceDir, snapshot, () => beforeActivate(manifest));
    await writePublication(localDir, manifest);
    return { publicationId: manifest.publicationId };
  }
  await liveTick({ config, localDir, sourceDir, rawCache: cache, readRaw: rawReader(first, { calls: rawCalls }), publish });
  const second = primaryFixture({ end: 101, spent: true });
  await writeSource(sourceDir, second);
  await liveTick({ config, localDir, sourceDir, rawCache: cache, readRaw: rawReader(second, { calls: rawCalls }), publish });
  assert.deepEqual(captured.map(source => [source.coverage.startHeight, source.coverage.endHeight]), [[100, 100], [100, 101]]);
  assert.equal(captured[0].records[0].detail.confirmations, 1);
  assert.equal(captured[1].records[0].txid, captured[0].records[0].txid);
  assert.equal(captured[1].records[0].detail.outputs[0].spent, true);
  assert.equal(captured[1].records[0].detail.confirmations, 2);
  assert.equal(captured[1].records.at(-1).detail.confirmations, 1);
  assert.equal(rawCalls.length, 2, 'Unchanged canonical raw bytes are cached while SQL facts are recaptured.');
  const status = JSON.parse(await readFile(join(localDir, 'publisher-status.json')));
  assert.equal(status.source.height, 101);
  assert.equal(status.served.height, 101);
});

test('unchanged live facts do not rebuild, refetch raw data or rewrite the serving pointer', async t => {
  const { localDir, sourceDir } = await workspace(t);
  const snapshot = primaryFixture();
  const manifest = manifestFor(snapshot, hash(1), { primaryFingerprint: primaryFactsFingerprint(snapshot) });
  await writePublication(localDir, manifest); await writeSource(sourceDir, snapshot);
  const pointerBefore = await readFile(join(localDir, 'current.json'));
  const inode = (await stat(join(localDir, 'current.json'))).ino;
  const forbidden = async () => assert.fail('Unchanged facts must not fetch raw bytes or prepare artifacts.');
  const result = await liveTick({ config, localDir, sourceDir, readRaw: forbidden, publish: forbidden });
  assert.equal(result.unchanged, true);
  assert.deepEqual(await readFile(join(localDir, 'current.json')), pointerBefore);
  assert.equal((await stat(join(localDir, 'current.json'))).ino, inode);
});

test('capture-capacity blockage retains the serving pointer and performs no raw or native work', async t => {
  const { localDir, sourceDir } = await workspace(t);
  const old = primaryFixture();
  await writePublication(localDir, manifestFor(old));
  await writeSource(sourceDir, primaryFixture({ end: 100, tip: 101 }), { captureState: 'capacity-blocked' });
  const before = await readFile(join(localDir, 'current.json'));
  const forbidden = async () => assert.fail('Blocked capture must not extend or roll the admitted cohort.');
  await assert.rejects(liveTick({ config, localDir, sourceDir, readRaw: forbidden, publish: forbidden }), /capacity/i);
  assert.deepEqual(await readFile(join(localDir, 'current.json')), before);
});

test('oversized padded record is rejected before native publication without changing the pointer', async t => {
  const { localDir, sourceDir } = await workspace(t);
  const snapshot = primaryFixture();
  await writePublication(localDir, manifestFor(snapshot)); await writeSource(sourceDir, snapshot);
  const before = await readFile(join(localDir, 'current.json'));
  let published = false;
  await assert.rejects(liveTick({ config, localDir, sourceDir,
    readRaw: rawReader(snapshot, { padding: 'x'.repeat(64 * 8064) }),
    publish: async () => { published = true; assert.fail('Oversized native geometry must not be prepared.'); },
  }), /capacity/i);
  assert.equal(published, false);
  assert.deepEqual(await readFile(join(localDir, 'current.json')), before);
});

async function fakeNative(directory) {
  const binary = join(directory, 'prepare-fixture.mjs');
  await writeFile(binary, `#!${process.execPath}\nimport {readFile,writeFile} from 'node:fs/promises';\nconst source=JSON.parse(await readFile(process.argv[3],'utf8'));\nawait writeFile(process.argv[4]+'/manifest.json',JSON.stringify({schema:'zecblock-private-tx-full-v1',publicationId:'${hash(99)}',chunkCount:1,snapshot:source.snapshot,coverage:source.coverage}));\n`);
  await chmod(binary, 0o755);
  return binary;
}

for (const correction of ['spent-correction', 'same-height-reorg']) {
  test(`post-build ${correction} rejects activation and leaves the prior pointer`, async t => {
    const { directory, localDir, sourceDir } = await workspace(t);
    const snapshot = primaryFixture();
    await writePublication(localDir, manifestFor(snapshot)); await writeSource(sourceDir, snapshot);
    const before = await readFile(join(localDir, 'current.json'));
    const changed = correction === 'spent-correction' ? primaryFixture({ spent: true }) : primaryFixture({ blockHashes: { 100: hash(900) } });
    const binary = await fakeNative(directory);
    const publish = async options => publishRecent({ ...options, binary, beforeActivate: async manifest =>
      activationHeartbeat(sourceDir, changed, () => options.beforeActivate(manifest)) });
    await assert.rejects(liveTick({ config, localDir, sourceDir, readRaw: rawReader(snapshot), publish }), /facts changed|membership changed|unavailable or stale/);
    assert.deepEqual(await readFile(join(localDir, 'current.json')), before);
    assert.equal(JSON.parse(await readFile(join(localDir, 'publisher-status.json'))).state, 'unavailable');
  });
}

test('arbitrary activation callback failure cannot advance a prepared publication pointer', async t => {
  const { directory, localDir } = await workspace(t);
  const snapshot = primaryFixture(), manifest = manifestFor(snapshot);
  await writePublication(localDir, manifest);
  const before = await readFile(join(localDir, 'current.json'));
  await assert.rejects(publishRecent({ localDir, binary: await fakeNative(directory), source: { snapshot: manifest.snapshot, coverage: manifest.coverage, records: [] }, beforeActivate: async () => { throw new Error('Activation callback failed'); } }), /Activation callback failed/);
  assert.deepEqual(await readFile(join(localDir, 'current.json')), before);
});

test('canonical source guard rejects every retained pre-reorg publication while allowing the new one', async t => {
  const { localDir, sourceDir } = await workspace(t);
  const old = primaryFixture();
  await writeSource(sourceDir, old); await writePublication(localDir, manifestFor(old, hash(1)));
  const evaluations = [];
  const publications = localPublications({ localDir, sourceDir, createEvaluator: (_binary, directory) => ({ evaluate: async bytes => { evaluations.push(directory); return bytes; }, close() {} }) });
  const app = await startPrototype({ port: 0, publications });
  t.after(() => app.close());
  await writePublication(localDir, manifestFor(old, hash(2))); await publications.current();
  const replacement = primaryFixture({ blockHashes: { 100: hash(900) } });
  await writeSource(sourceDir, replacement); await writePublication(localDir, manifestFor(replacement, hash(3)));
  assert.equal((await fetch(`${app.url}/publication/manifest.json`)).status, 200);
  const query = id => fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': hash(id) }, body: Buffer.from([9]) });
  for (const id of [1, 2]) {
    assert.equal((await query(id)).status, 503);
    assert.equal((await fetch(`${app.url}/publication/${hash(id)}/public.bin`)).status, 503);
  }
  assert.equal(evaluations.length, 0);
  assert.equal((await query(3)).status, 200);
  assert.equal(evaluations.length, 1);
});

test('unavailable and stale source guards stop serving all retained data without evaluator calls', async t => {
  const { localDir, sourceDir } = await workspace(t);
  const snapshot = primaryFixture();
  await writeSource(sourceDir, snapshot); await writePublication(localDir, manifestFor(snapshot));
  let evaluations = 0;
  const publications = localPublications({ localDir, sourceDir, createEvaluator: () => ({ evaluate: async bytes => { evaluations++; return bytes; }, close() {} }) });
  const app = await startPrototype({ port: 0, publications });
  t.after(() => app.close());
  for (const overrides of [{ state: 'unavailable' }, { observedAt: new Date(Date.now() - 30_000).toISOString() }]) {
    await atomicJson(join(sourceDir, 'guard.json'), guardFor(snapshot, overrides));
    for (const path of ['/health', '/publication/manifest.json', `/publication/${hash(1)}/public.bin`]) assert.equal((await fetch(`${app.url}${path}`)).status, 503);
    assert.equal((await fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': hash(1) }, body: Buffer.from([9]) })).status, 503);
  }
  assert.equal(evaluations, 0);
});

test('compact geometry reserves one cover row and rejects whole-set overflow', () => {
  const make = count => ({ network: 'mainnet', snapshot: {}, coverage: {}, records: Array.from({ length: count }, () => ({ txid: hash(1), detail: {}, raw: { padding: 'x'.repeat(63 * 8064) } })) });
  assert.deepEqual(admitSource(make(31)), { chunks: 64, records: 31, payloadRows: 1984, coverRows: 1 });
  assert.throws(() => admitSource(make(32)), /capacity/i);
  const uneven = make(1);
  uneven.records.push(...Array.from({ length: 200 }, () => ({ txid: hash(2), detail: {}, raw: {} })));
  assert.equal(admitSource(uneven).payloadRows, 264, 'Smaller records must not consume the largest record count.');
});
