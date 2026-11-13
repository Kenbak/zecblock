import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, mkdir, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { measureHistoricalRange, parseHistoricalArgs, loadHistoricalRuntime } from '../pilot/measure-history.mjs';
import { createPrimarySnapshotReader, decodePrimarySnapshot, primaryFactsFingerprint,
  MAINNET_GENESIS_HASH, PRIMARY_SNAPSHOT_SCHEMA } from '../primary-source.mjs';
import { exportLive } from '../export-live.mjs';
import { partitionSource, planFullSource } from '../pilot/publish-archive.mjs';

const id = value => value.toString(16).padStart(64, '0');
const NOW = '2026-11-03T12:00:00.000Z';
function fixture(start = 100, blockCounts = [1, 2, 1]) {
  const end = start + blockCounts.length - 1;
  const blocks = blockCounts.map((count, index) => ({ height: String(start + index), hash: id(10_000 + start + index),
    previous_block_hash: id(10_000 + start + index - 1), timestamp: '1793707200', transaction_count: String(count) }));
  return { schema: PRIMARY_SNAPSHOT_SCHEMA, network: 'mainnet', database: 'zcash_explorer_mainnet', isPrimary: true, readOnly: true,
    genesisHash: MAINNET_GENESIS_HASH, observedAt: '2026-11-03T11:59:59.000Z', snapshotId: '123:123:',
    limits: { maxBlocks: blockCounts.length, maxRecords: 2048, maxIoRows: 200_000 },
    coverage: { startHeight: String(start), endHeight: String(end) }, tip: { height: String(end + 10), hash: id(90_000) },
    blocks, transactions: blocks.flatMap((block, blockIndex) => Array.from({ length: blockCounts[blockIndex] }, (_, index) => ({
      txid: id(Number(block.height) * 100 + index), block_height: block.height, block_hash: block.hash,
      block_time: block.timestamp, tx_index: String(index), version: index === 0 ? '4' : '5', locktime: '0', expiry_height: '0', size: '100',
      vin_count: index === 0 ? '1' : '0', vout_count: '0', is_coinbase: String(index === 0),
      has_sprout: 'false', has_sapling: String(index > 0), has_orchard: 'false', has_ironwood: 'false',
      fee: '0', total_input: '0', total_output: '0', value_balance: '0',
    }))), inputs: [], outputs: [] };
}

function plan(value, { maxRecords = 2047, chunks = 1, perRecordRows = 1 } = {}) {
  const payloadRows = value.records.length <= maxRecords ? value.records.length * perRecordRows : 2048;
  const legacyRecordBytesTotal = value.records.length * 3000;
  const reason = chunks > 64 ? 'chunk-budget' : payloadRows + 1 > 2048 ? 'table-rows' : null;
  return { schema: 'zecblock-private-tx-plan-v1', recordCodec: 'json-context-zlib-v1', packing: 'compact-v1',
    rows: 2048, rowBytes: 8192, payloadBytes: 8064, records: value.records.length, payloadRows,
    coverRows: 1, totalRows: payloadRows + 1, chunkCount: chunks,
    maxRecordBytes: 1000, maxDecodedRecordBytes: 2000, recordBytesTotal: value.records.length * 1000,
    decodedBytesTotal: value.records.length * 2000, legacyRecordBytesTotal, decodedAggregateLimit: 64 * 1024 ** 2,
    fits: reason === null, capacityReason: reason };
}

async function box(t, capture = fixture()) {
  const directory = await mkdtemp(resolve(tmpdir(), 'pir-history-test-'));
  const scratchDir = resolve(directory, 'scratch');
  await mkdir(scratchDir, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = { capture: 0, raw: [], pause: [], headers: [], plans: [], close: 0, activeRaw: 0, maxActiveRaw: 0 };
  const dependencies = {
    capturePrimary: async options => { calls.capture++; calls.captureOptions = options; return structuredClone(capture); },
    createPrimarySnapshotReader: async options => {
      const reader = await createPrimarySnapshotReader(options);
      return { ...reader, close: async () => { calls.close++; await reader.close(); } };
    },
    decodePrimarySnapshot, primaryFactsFingerprint, exportLive, partitionSource,
    canonicalHeaders: async heights => {
      calls.headers.push([...heights]);
      return { schema: 'zecblock-private-header-guard-v1', network: 'mainnet', database: 'zcash_explorer_mainnet', isPrimary: true,
        readOnly: true, genesisHash: MAINNET_GENESIS_HASH, observedAt: '2026-11-03T12:00:01.000Z',
        tip: { height: Number(capture.tip.height) + 1, hash: id(90_001) },
        blocks: heights.map(height => ({ height, hash: height === Number(capture.tip.height) ? capture.tip.hash
          : capture.blocks.find(block => Number(block.height) === height).hash })) };
    },
    rawFromLoopback: async txid => {
      calls.raw.push(txid); calls.activeRaw++; calls.maxActiveRaw = Math.max(calls.activeRaw, calls.maxActiveRaw);
      await Promise.resolve(); calls.activeRaw--;
      const tx = capture.transactions.find(value => value.txid === txid);
      return { meta: { network: 'mainnet', generatedAt: NOW }, data: { txid, hex: '00', decoded: { txid, blockhash: tx.block_hash } } };
    },
    planFullSource: async (source, directory, options) => {
      calls.plans.push(source.coverage.blocks.map(block => block.height));
      assert.equal(directory, scratchDir); assert.equal(options.binary, '/unused/native');
      return plan(source);
    },
    now: () => NOW, pause: async ms => { calls.pause.push(ms); },
    prepareFullSource: () => assert.fail('Measurement must never prepare an artifact.'),
    publishCollection: () => assert.fail('Measurement must never activate a publication.'),
  };
  const options = { startHeight: Number(capture.coverage.startHeight), endHeight: Number(capture.coverage.endHeight),
    maxBlocks: capture.blocks.length, maxRecords: 2048, scratchDir, binary: '/unused/native' };
  return { directory, scratchDir, calls, options, dependencies, capture, run: overrides => measureHistoricalRange({ ...options, ...overrides }, dependencies) };
}

test('measures the complete range through existing readers and emits only aggregate facts', async t => {
  const sample = await box(t);
  const result = await sample.run();
  assert.deepEqual(sample.calls.captureOptions, { startHeight: 100, endHeight: 102, maxBlocks: 3, maxRecords: 2048 });
  assert.equal(sample.calls.capture, 1); assert.equal(sample.calls.close, 1);
  assert.equal(sample.calls.maxActiveRaw, 1); assert.equal(sample.calls.raw.length, 4);
  assert.deepEqual(sample.calls.pause, [200, 200, 200]);
  assert.deepEqual(sample.calls.headers, [[100, 101, 102, 112]]);
  assert.equal(result.observations.capturedTip.height, 112);
  assert.equal(result.observations.verifiedTip.height, 113);
  assert.equal(result.counts.records, 4); assert.equal(result.counts.types.coinbase, 3);
  assert.deepEqual(result.counts.types.byVersion, { 4: 3, 5: 1 });
  assert.equal(result.counts.types.withShieldedPool.sapling, 1);
  assert.equal(result.counts.types.transparentOnly, 3);
  assert.equal(result.bytes.encodedRecordBytes, 4000);
  assert.equal(result.bytes.payloadRowBytes, 4 * 8064);
  assert.equal(result.bytes.allocatedRowBytes, 5 * 8192);
  assert.equal(result.bytes.fixedTableBytes, 2048 * 8192);
  assert.equal(result.partition.completeBlockCoverage, true);
  assert.equal(result.partition.segmentCount, 1);
  assert.equal(result.partition.aggregateChunkCount, 1);
  assert.equal(result.projection.available, false);
  for (const hash of Object.values(result.inputHashes)) assert.match(hash, /^[a-f0-9]{64}$/);
  for (const duration of Object.values(result.timings)) assert.ok(Number.isFinite(duration) && duration >= 0);
  const text = JSON.stringify(result);
  assert.equal(text.includes(sample.capture.transactions[0].txid), false);
  assert.doesNotMatch(text, /"hex"|"decoded"|"detail"|"query"/);
  assert.deepEqual(await readdir(sample.scratchDir), []);
});

test('requires explicit bounded integers before any source access', async t => {
  const sample = await box(t);
  for (const options of [{ startHeight: undefined }, { endHeight: undefined }, { startHeight: '100' },
    { endHeight: 99 }, { maxBlocks: 129 }, { endHeight: 228 }, { maxRecords: 2049 }, { maxRecords: 0 },
    { maxSegments: 9 }, { maxSegments: 0 }, { rawPacingMs: -1 }, { scratchDir: 'relative' }, { binary: 'relative' }]) {
    await assert.rejects(sample.run(options));
  }
  assert.equal(sample.calls.capture, 0);
});

test('accepts at most 128 complete blocks and 2048 records without moving the requested bounds', async t => {
  const sample = await box(t, fixture(0, Array(128).fill(1)));
  const result = await sample.run({ rawPacingMs: 0 });
  assert.equal(result.counts.blocks, 128); assert.equal(result.counts.rawCalls, 128);
  const maximumRecords = await box(t, fixture(100, [2048]));
  const maximum = await maximumRecords.run({ rawPacingMs: 0 });
  assert.equal(maximum.counts.rawCalls, 2048);
  assert.equal(maximum.counts.records, 2048);
  assert.equal(maximum.partition.reason, 'complete-block-exceeds-capacity');
  const oversized = await box(t, fixture(100, [2049]));
  await assert.rejects(oversized.run(), /oversized transactions/);
  assert.equal(oversized.calls.raw.length, 0);
});

test('runtime helpers can be imported by explicit absolute directory without starting a service', async () => {
  const runtime = await loadHistoricalRuntime(resolve(import.meta.dirname, '..'));
  assert.equal(runtime.createPrimarySnapshotReader, createPrimarySnapshotReader);
  assert.equal(runtime.exportLive, exportLive);
  assert.equal(runtime.planFullSource, planFullSource);
  assert.equal(runtime.partitionSource, partitionSource);
  await assert.rejects(loadHistoricalRuntime('relative'), /absolute runtime/);
});

test('rejects unsafe scratch directories without reading the primary', async t => {
  const sample = await box(t);
  await chmod(sample.scratchDir, 0o755);
  await assert.rejects(sample.run(), /owned private ordinary/);
  await chmod(sample.scratchDir, 0o700);
  const link = resolve(sample.directory, 'link'); await symlink(sample.scratchDir, link);
  await assert.rejects(sample.run({ scratchDir: link }), /owned private ordinary/);
  assert.equal(sample.calls.capture, 0);
});

test('read-only mainnet capture identity and exact requested coverage are mandatory', async t => {
  for (const mutate of [value => { value.readOnly = false; }, value => { value.isPrimary = false; },
    value => { value.network = 'testnet'; }, value => { value.genesisHash = id(0); }]) {
    const capture = fixture(); mutate(capture);
    const sample = await box(t, capture); await assert.rejects(sample.run()); assert.equal(sample.calls.raw.length, 0);
  }
  const sample = await box(t);
  await assert.rejects(sample.run({ endHeight: 101 }), /explicit historical bounds/);
  assert.equal(sample.calls.raw.length, 0);
});

test('fresh canonical verification follows raw capture and rejects changed blocks, anchors and stale observations', async t => {
  for (const mutate of [headers => { headers.blocks[0].hash = id(555); }, headers => { headers.blocks.at(-1).hash = id(555); },
    headers => { headers.blocks.pop(); }, headers => { headers.observedAt = '2026-11-03T11:59:59.500Z'; },
    headers => { headers.readOnly = false; }, headers => { headers.tip.height = 111; }]) {
    const sample = await box(t);
    const original = sample.dependencies.canonicalHeaders;
    sample.dependencies.canonicalHeaders = async heights => {
      assert.equal(sample.calls.raw.length, 4);
      const headers = await original(heights); mutate(headers); return headers;
    };
    await assert.rejects(sample.run(), /Canonical|canonical|primary mainnet/);
    assert.equal(sample.calls.plans.length, 0); assert.equal(sample.calls.close, 1);
  }
});

test('full nonfitting plans are retained, and partitions only contain complete blocks', async t => {
  const sample = await box(t);
  sample.dependencies.planFullSource = async source => plan(source, { maxRecords: 2 });
  const result = await sample.run();
  assert.equal(result.fullPlan.fits, false);
  assert.equal(result.fullPlan.capacityReason, 'table-rows');
  assert.deepEqual(result.partition.segments.map(segment => [segment.startHeight, segment.endHeight, segment.records]),
    [[100, 100, 1], [101, 101, 2], [102, 102, 1]]);
  assert.equal(result.partition.segments.reduce((sum, segment) => sum + segment.records, 0), 4);
  assert.ok(result.partition.segments.every(segment => segment.plan.fits));
});

test('whole-block and segment-limit failures report unavailable complete coverage without partial segments', async t => {
  const sample = await box(t);
  sample.dependencies.planFullSource = async source => plan(source, { maxRecords: 1 });
  const result = await sample.run();
  assert.deepEqual(result.partition, { state: 'capacity-blocked', completeBlockCoverage: false,
    reason: 'complete-block-exceeds-capacity', segments: [] });
  const segmentLimited = await box(t, fixture(100, Array(9).fill(1)));
  segmentLimited.dependencies.planFullSource = async source => plan(source, { maxRecords: 1 });
  const limited = await segmentLimited.run();
  assert.equal(limited.partition.reason, 'segment-limit');
  assert.deepEqual(limited.partition.segments, []);
});

test('complete segments expose aggregate query-budget failure separately from individual fitting plans', async t => {
  const sample = await box(t);
  sample.dependencies.planFullSource = async source => plan(source, { maxRecords: 2, chunks: 33 });
  const result = await sample.run();
  assert.equal(result.partition.completeBlockCoverage, true);
  assert.equal(result.partition.aggregateChunkCount, 99);
  assert.equal(result.partition.fitsCollectionQueryBudget, false);
});

test('rejects inconsistent native plans and does not disguise noncapacity helper errors', async t => {
  const sample = await box(t);
  sample.dependencies.planFullSource = async source => ({ ...plan(source), fits: false });
  await assert.rejects(sample.run(), /Inconsistent native historical capacity/);
  sample.dependencies.planFullSource = async source => plan(source);
  sample.dependencies.partitionSource = async () => { throw new Error('Unexpected planner failure.'); };
  await assert.rejects(sample.run(), /Unexpected planner failure/);
  assert.equal(sample.calls.close, 2);
});

test('duplicate and uncaptured raw requests fail before any extra raw source call', async t => {
  const sample = await box(t);
  sample.dependencies.exportLive = async ({ read }) => {
    const txid = sample.capture.transactions[0].txid;
    await read(`/v1/transactions/${txid}/verbose`);
    await read(`/v1/transactions/${txid}/verbose`);
  };
  await assert.rejects(sample.run(), /duplicate, outside captured coverage or exceeds/);
  assert.equal(sample.calls.raw.length, 1); assert.equal(sample.calls.close, 1);
  sample.dependencies.exportLive = async ({ read }) => read(`/v1/transactions/${id(9999)}/verbose`);
  await assert.rejects(sample.run(), /outside captured coverage/);
  assert.equal(sample.calls.raw.length, 1);
});

test('actual planning helper deletes its temporary source files and uses only plan-full', async t => {
  const sample = await box(t, fixture(100, [1]));
  const native = resolve(sample.directory, 'native');
  const body = `#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv[2]!=='plan-full'||process.argv.length!==4)process.exit(2);
const source=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
process.stdout.write(JSON.stringify((${plan.toString()})(source)));\n`;
  await writeFile(native, body, { mode: 0o700 });
  sample.dependencies.planFullSource = planFullSource;
  const result = await sample.run({ binary: native });
  assert.equal(result.fullPlan.fits, true);
  assert.deepEqual(await readdir(sample.scratchDir), []);
  await writeFile(native, `#!${process.execPath}\nprocess.exit(2);\n`, { mode: 0o700 });
  await assert.rejects(sample.run({ binary: native }), /Bounded archive helper failed/);
  assert.deepEqual(await readdir(sample.scratchDir), []);
});

test('strict CLI requires absolute runtime, explicit range and unique decimal options', () => {
  const args = ['--runtime', '/runtime', '--binary', '/native', '--start', '0', '--end', '127', '--scratch', '/scratch'];
  assert.equal(parseHistoricalArgs(args).maxBlocks, 128);
  for (const extra of [['--start', '1'], ['--unknown', '1'], ['--max-segments', '9'], ['--raw-pacing-ms', '1e2'], ['--max-records']]) {
    assert.throws(() => parseHistoricalArgs([...args, ...extra]));
  }
  assert.throws(() => parseHistoricalArgs(args.slice(2)), /runtime/);
  assert.throws(() => parseHistoricalArgs(args.map(value => value === '127' ? '128' : value)), /128-block/);
});
