import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const HASH = /^[a-f0-9]{64}$/;
const MAINNET_GENESIS = '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const safeHeight = value => Number.isSafeInteger(value) && value >= 0;
const PLAN_FIELDS = ['schema', 'recordCodec', 'packing', 'rows', 'rowBytes', 'payloadBytes', 'records',
  'payloadRows', 'coverRows', 'totalRows', 'chunkCount', 'maxRecordBytes', 'maxDecodedRecordBytes',
  'recordBytesTotal', 'decodedBytesTotal', 'legacyRecordBytesTotal', 'decodedAggregateLimit', 'fits', 'capacityReason'];
const DEPENDENCIES = ['capturePrimary', 'createPrimarySnapshotReader', 'decodePrimarySnapshot', 'primaryFactsFingerprint',
  'exportLive', 'canonicalHeaders', 'planFullSource', 'partitionSource', 'rawFromLoopback'];

// This file can run from a separate scratch directory. It never needs to be
// installed into, or change, the serving release whose helpers it measures.
export async function loadHistoricalRuntime(runtimeDir) {
  assert(typeof runtimeDir === 'string' && isAbsolute(runtimeDir), 'An explicit absolute runtime directory is required.');
  const load = path => import(pathToFileURL(resolve(runtimeDir, path)).href);
  const [capture, primary, exporter, headers, planner, raw] = await Promise.all([
    load('pilot/source-watch.mjs'), load('primary-source.mjs'), load('export-live.mjs'),
    load('pilot/archive-source.mjs'), load('pilot/publish-archive.mjs'), load('pilot/publish-live.mjs'),
  ]);
  return { capturePrimary: capture.capturePrimary, createPrimarySnapshotReader: primary.createPrimarySnapshotReader,
    decodePrimarySnapshot: primary.decodePrimarySnapshot, primaryFactsFingerprint: primary.primaryFactsFingerprint,
    exportLive: exporter.exportLive, canonicalHeaders: headers.canonicalHeaders,
    planFullSource: planner.planFullSource, partitionSource: planner.partitionSource, rawFromLoopback: raw.rawFromLoopback };
}

function optionsBound({ startHeight, endHeight, maxBlocks = 128, maxRecords = 2048, maxSegments = 8,
  rawPacingMs = 200, scratchDir, binary, runtimeDir, signal } = {}) {
  assert(safeHeight(startHeight) && safeHeight(endHeight) && endHeight >= startHeight,
    'An explicit nonnegative startHeight and endHeight are required.');
  assert(Number.isSafeInteger(maxBlocks) && maxBlocks >= 1 && maxBlocks <= 128
    && endHeight - startHeight + 1 <= maxBlocks, 'Historical range exceeds the 128-block bound.');
  assert(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= 2048, 'Historical record bound must be 1–2048.');
  assert(Number.isSafeInteger(maxSegments) && maxSegments >= 1 && maxSegments <= 8, 'Historical segment bound must be 1–8.');
  assert(Number.isSafeInteger(rawPacingMs) && rawPacingMs >= 0 && rawPacingMs <= 1000, 'Invalid raw-read pacing.');
  assert(typeof scratchDir === 'string' && isAbsolute(scratchDir), 'An explicit absolute owned scratch directory is required.');
  assert(typeof binary === 'string' && isAbsolute(binary), 'An explicit absolute evaluator binary is required.');
  return { startHeight, endHeight, maxBlocks, maxRecords, maxSegments, rawPacingMs, scratchDir, binary, runtimeDir, signal };
}

async function ownedScratch(directory) {
  const info = await lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
    && (process.getuid === undefined || info.uid === process.getuid()), 'Scratch must be an owned private ordinary directory.');
}

function checkedPlan(value, source) {
  assert(value?.schema === 'zecblock-private-tx-plan-v1' && value.recordCodec === 'json-context-zlib-v1'
    && value.packing === 'compact-v1' && value.rows === 2048 && value.rowBytes === 8192 && value.payloadBytes === 8064
    && value.coverRows === 1 && value.records === source.records.length && typeof value.fits === 'boolean',
  'Incompatible native historical capacity plan.');
  for (const key of ['records', 'payloadRows', 'totalRows', 'chunkCount', 'maxRecordBytes', 'maxDecodedRecordBytes',
    'recordBytesTotal', 'decodedBytesTotal', 'legacyRecordBytesTotal', 'decodedAggregateLimit']) {
    assert(Number.isSafeInteger(value[key]) && value[key] > 0, 'Invalid native historical plan measurement.');
  }
  assert(value.decodedAggregateLimit === 64 * 1024 ** 2 && value.totalRows === value.payloadRows + 1
    && value.payloadRows >= value.records, 'Inconsistent native historical plan geometry.');
  const reason = value.legacyRecordBytesTotal > value.decodedAggregateLimit ? 'decoded-aggregate'
    : value.chunkCount > 64 ? 'chunk-budget' : value.totalRows > value.rows ? 'table-rows' : null;
  assert(value.fits === (reason === null) && value.capacityReason === reason, 'Inconsistent native historical capacity result.');
  // Native output is an allowlist of aggregate fields, never a source record.
  return Object.fromEntries(PLAN_FIELDS.map(key => [key, value[key]]));
}

function planBytes(plan) {
  return { encodedRecordBytes: plan.recordBytesTotal, decodedRecordBytes: plan.decodedBytesTotal,
    legacyRecordBytes: plan.legacyRecordBytesTotal, payloadRowBytes: plan.payloadRows * plan.payloadBytes,
    allocatedRowBytes: plan.totalRows * plan.rowBytes, fixedTableBytes: plan.rows * plan.rowBytes };
}

function counts(source) {
  const byVersion = {}, pools = { sprout: 0, sapling: 0, orchard: 0, ironwood: 0 };
  let coinbase = 0, transparentOnly = 0, unknownPoolFlags = 0, multipleShieldedPools = 0;
  for (const { detail } of source.records) {
    const version = Number.isSafeInteger(detail.version) ? String(detail.version) : 'unavailable';
    byVersion[version] = (byVersion[version] ?? 0) + 1;
    if (detail.isCoinbase === true) coinbase++;
    const flags = Object.keys(pools).map(pool => {
      const flag = detail[`has${pool[0].toUpperCase()}${pool.slice(1)}`];
      if (flag === true) pools[pool]++;
      return flag;
    });
    if (flags.every(flag => flag === false)) transparentOnly++;
    if (flags.some(flag => flag !== true && flag !== false)) unknownPoolFlags++;
    if (flags.filter(flag => flag === true).length > 1) multipleShieldedPools++;
  }
  return { byVersion, coinbase, nonCoinbase: source.records.length - coinbase, withShieldedPool: pools,
    transparentOnly, unknownPoolFlags, multipleShieldedPools };
}

function verifyFreshHeaders(value, snapshot, source) {
  assert(value?.schema === 'zecblock-private-header-guard-v1' && value.network === 'mainnet'
    && value.database === 'zcash_explorer_mainnet' && value.isPrimary === true && value.readOnly === true
    && value.genesisHash === MAINNET_GENESIS && safeHeight(value.tip?.height) && HASH.test(value.tip.hash)
    && Number.isFinite(Date.parse(value.observedAt)) && Array.isArray(value.blocks), 'Fresh primary mainnet read-only canonical headers required.');
  assert(Date.parse(value.observedAt) >= Date.parse(snapshot.observedAt)
    && Date.parse(value.observedAt) >= Date.parse(source.coverage.captureCompletedAt), 'Canonical headers predate raw capture completion.');
  const expected = new Map(source.coverage.blocks.map(block => [block.height, block.hash]));
  for (const anchor of [snapshot.tip, source.snapshot]) {
    assert(!expected.has(anchor.height) || expected.get(anchor.height) === anchor.hash, 'Captured observation anchor mismatch.');
    expected.set(anchor.height, anchor.hash);
  }
  assert(value.blocks.length === expected.size && new Set(value.blocks.map(block => block.height)).size === expected.size
    && value.blocks.every(block => expected.get(block.height) === block.hash), 'Canonical block or observation anchor changed after raw capture.');
  assert(value.tip.height >= snapshot.tip.height && (value.tip.height !== snapshot.tip.height || value.tip.hash === snapshot.tip.hash),
    'Fresh canonical tip no longer contains the captured observation anchor.');
}

// A diagnostic only: no prepare, writer lock, pointer, service, publication or
// source-request mutation is reachable here. SQL and raw HTTP reads stay inside
// existing bounded runtime helpers. The caller owns the scratch directory.
export async function measureHistoricalRange(options = {}, dependencies = {}) {
  const bounded = optionsBound(options);
  const { startHeight, endHeight, maxBlocks, maxRecords, maxSegments, rawPacingMs, scratchDir, binary, signal } = bounded;
  await ownedScratch(scratchDir);
  const runtime = DEPENDENCIES.every(key => typeof dependencies[key] === 'function') ? dependencies
    : { ...await loadHistoricalRuntime(bounded.runtimeDir), ...dependencies };
  assert(DEPENDENCIES.every(key => typeof runtime[key] === 'function'), 'Required historical runtime helper unavailable.');
  const clock = dependencies.clock ?? (() => performance.now());
  const now = dependencies.now ?? (() => new Date().toISOString());
  const pause = dependencies.pause ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const timings = {}, totalStarted = clock();
  let mark = clock();
  signal?.throwIfAborted();
  const captured = await runtime.capturePrimary({ startHeight, endHeight, maxBlocks, maxRecords });
  const snapshot = runtime.decodePrimarySnapshot(JSON.stringify(captured));
  assert(snapshot.coverage.startHeight === startHeight && snapshot.coverage.endHeight === endHeight
    && snapshot.blocks.length <= maxBlocks && snapshot.transactions.length <= maxRecords
    && snapshot.limits.maxBlocks <= maxBlocks && snapshot.limits.maxRecords <= maxRecords, 'Capture does not match the explicit historical bounds.');
  timings.captureMs = clock() - mark;
  const fingerprint = runtime.primaryFactsFingerprint(snapshot);
  const captureBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const captureSha256 = sha(snapshot);
  const allowedRaw = new Set(snapshot.transactions.map(tx => tx.txid));
  const seenRaw = new Set();
  let rawCalls = 0, rawResponseBytes = 0, scope;
  try {
    scope = await runtime.createPrimarySnapshotReader({ capture: snapshot, readRaw: async txid => {
      signal?.throwIfAborted();
      assert(allowedRaw.has(txid) && !seenRaw.has(txid) && rawCalls < maxRecords && rawCalls < 2048,
        'Raw read is duplicate, outside captured coverage or exceeds its bound.');
      seenRaw.add(txid);
      if (rawCalls > 0 && rawPacingMs > 0) await pause(rawPacingMs, signal);
      rawCalls++;
      const response = await runtime.rawFromLoopback(txid);
      rawResponseBytes += Buffer.byteLength(JSON.stringify(response));
      return response;
    }, readPrice: async () => { throw new Error('Historical price is outside the indexed-only measurement.'); } });
    mark = clock();
    const source = await runtime.exportLive({ read: scope.read, startHeight, endHeight, maxBlocks, maxRecords, now,
      sourceOrigin: 'mainnet-primary-read-only-snapshot', sourceAuthority: scope.authority });
    timings.exportMs = clock() - mark;
    assert(source?.schema === 'zecblock-private-tx-source-v1' && source.network === 'mainnet'
      && source.coverage?.complete === true && source.coverage.startHeight === startHeight && source.coverage.endHeight === endHeight
      && source.records.length === snapshot.transactions.length && rawCalls === snapshot.transactions.length
      && source.snapshot.height === snapshot.tip.height && source.snapshot.hash === snapshot.tip.hash
      && JSON.stringify(source.coverage.blocks.map(block => [block.height, block.hash, block.transactionCount]))
        === JSON.stringify(snapshot.blocks.map(block => [Number(block.height), block.hash, Number(block.transaction_count)])),
    'Export does not match the complete captured historical range.');
    source.coverage.primaryFingerprint = fingerprint;
    source.coverage.sourceObservedAt = snapshot.observedAt;
    mark = clock();
    const heights = [...new Set([...source.coverage.blocks.map(block => block.height), snapshot.tip.height, source.snapshot.height])];
    const headers = await runtime.canonicalHeaders(heights);
    verifyFreshHeaders(headers, snapshot, source);
    timings.canonicalVerifyMs = clock() - mark;
    const sourceBytes = Buffer.byteLength(JSON.stringify(source));
    let planCalls = 0;
    const planner = async candidate => {
      signal?.throwIfAborted();
      planCalls++;
      return checkedPlan(await runtime.planFullSource(candidate, scratchDir, { binary, signal }), candidate);
    };
    mark = clock();
    const fullPlan = await planner(source);
    timings.fullPlanMs = clock() - mark;
    mark = clock();
    let partition;
    try {
      const parts = await runtime.partitionSource(source, { planSource: planner, maxSegments });
      const segments = parts.map(({ source: segment, plan }, index) => ({ index,
        startHeight: segment.coverage.startHeight, endHeight: segment.coverage.endHeight,
        blocks: segment.coverage.blocks.length, records: segment.records.length,
        sourceBytes: Buffer.byteLength(JSON.stringify(segment)), sourceSha256: sha(segment),
        plan: checkedPlan(plan, segment), bytes: planBytes(plan) }));
      const chunkCount = segments.reduce((sum, segment) => sum + segment.plan.chunkCount, 0);
      partition = { state: 'complete', completeBlockCoverage: true, segments, segmentCount: segments.length,
        aggregateChunkCount: chunkCount, collectionChunkLimit: 64, fitsCollectionQueryBudget: chunkCount <= 64,
        fixedTableBytes: segments.reduce((sum, segment) => sum + segment.bytes.fixedTableBytes, 0) };
    } catch (error) {
      if (error.message === 'A complete source block exceeds archive capacity; coverage is unavailable.') {
        partition = { state: 'capacity-blocked', completeBlockCoverage: false, reason: 'complete-block-exceeds-capacity', segments: [] };
      } else if (error.message === 'Archive segment capacity exceeded.') {
        partition = { state: 'capacity-blocked', completeBlockCoverage: false, reason: 'segment-limit', segments: [] };
      } else throw error;
    }
    timings.partitionMs = clock() - mark;
    timings.totalMs = clock() - totalStarted;
    return { schema: 'zecblock-private-historical-measurement-v1', measurementOnly: true, network: 'mainnet',
      database: snapshot.database, isPrimary: true, readOnly: true,
      request: { startHeight, endHeight, maxBlocks, maxRecords, maxSegments, rawPacingMs },
      observations: { sourceObservedAt: snapshot.observedAt, snapshotId: snapshot.snapshotId,
        captureStartedAt: source.coverage.captureStartedAt, captureCompletedAt: source.coverage.captureCompletedAt,
        canonicalVerifiedAt: headers.observedAt, capturedTip: snapshot.tip, verifiedTip: headers.tip },
      blocks: source.coverage.blocks,
      inputHashes: { captureSha256, primaryFactsFingerprint: fingerprint, sourceSha256: sha(source), canonicalHeadersSha256: sha(headers) },
      counts: { blocks: snapshot.blocks.length, records: source.records.length, indexedInputs: snapshot.inputs.length,
        indexedOutputs: snapshot.outputs.length, rawCalls, planCalls, types: counts(source) },
      bytes: { captureBytes, sourceBytes, rawResponseBytes, ...planBytes(fullPlan) }, fullPlan, partition, timings,
      projection: { available: false, reason: 'One bounded range is not a representative full-history sample.' } };
  } finally { await scope?.close(); }
}

export function parseHistoricalArgs(args) {
  const names = new Map([['--runtime', 'runtimeDir'], ['--binary', 'binary'], ['--start', 'startHeight'],
    ['--end', 'endHeight'], ['--scratch', 'scratchDir'], ['--max-blocks', 'maxBlocks'],
    ['--max-records', 'maxRecords'], ['--max-segments', 'maxSegments'], ['--raw-pacing-ms', 'rawPacingMs']]);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]), value = args[index + 1];
    assert(key && value !== undefined && !value.startsWith('--') && !(key in result), 'Unknown, missing or duplicate historical measurement argument.');
    if (['runtimeDir', 'binary', 'scratchDir'].includes(key)) result[key] = value;
    else { assert(/^(0|[1-9]\d*)$/.test(value), 'Historical numeric arguments must be unsigned decimal integers.'); result[key] = Number(value); }
  }
  assert(typeof result.runtimeDir === 'string' && isAbsolute(result.runtimeDir), 'An explicit absolute runtime directory is required.');
  return optionsBound(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await measureHistoricalRange(parseHistoricalArgs(process.argv.slice(2))))}\n`); }
  catch {
    // Source/helper errors can contain source data. CLI failure is deliberately
    // aggregate-only; injected callers may inspect the thrown error locally.
    process.stderr.write('Bounded historical measurement failed; no publication was prepared or activated.\n');
    process.exitCode = 1;
  }
}
