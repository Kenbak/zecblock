import { createHash } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export const GLOBAL_SOURCE_SCHEMA = 'zecblock-private-global-source-v1';
export const GLOBAL_CAPTURE_LIMITS = Object.freeze({ ranges: 8, blocksPerRange: 16, blocks: 128,
  records: 2048, sourceBytes: 128 * 1024 ** 2, rawResponseBytes: 32 * 1024 ** 2,
  rawTimeoutMs: 20_000, rawPacingMs: 200, deadlineMs: 10 * 60_000 });
const MAINNET_GENESIS = '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08';
const HASH = /^[a-f0-9]{64}$/;
const HELPERS = ['capturePrimary', 'decodePrimarySnapshot', 'primaryFactsFingerprint',
  'createPrimarySnapshotReader', 'exportLive', 'canonicalHeaders'];
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const height = value => Number.isSafeInteger(value) && value >= 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonFile = value => `${JSON.stringify(value)}\n`;
const dated = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// This standalone helper can be copied into owned scratch; it imports the
// explicitly selected existing runtime and never installs into that release.
export async function loadGlobalCaptureRuntime(runtimeDir) {
  assert(typeof runtimeDir === 'string' && isAbsolute(runtimeDir)
    && /\/prototype\/private-tx\/?$/.test(runtimeDir), 'An explicit absolute prototype/private-tx runtime directory is required.');
  const info = await lstat(runtimeDir);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Runtime must be an existing ordinary directory.');
  const load = path => import(pathToFileURL(resolve(runtimeDir, path)).href);
  const [capture, primary, exporter, headers] = await Promise.all([
    load('pilot/source-watch.mjs'), load('primary-source.mjs'), load('export-live.mjs'), load('pilot/archive-source.mjs'),
  ]);
  const runtime = { capturePrimary: capture.capturePrimary, decodePrimarySnapshot: primary.decodePrimarySnapshot,
    primaryFactsFingerprint: primary.primaryFactsFingerprint, createPrimarySnapshotReader: primary.createPrimarySnapshotReader,
    exportLive: exporter.exportLive, canonicalHeaders: headers.canonicalHeaders };
  assert(HELPERS.every(key => typeof runtime[key] === 'function'), 'Required global capture runtime helper unavailable.');
  return runtime;
}

function boundedOptions({ ranges, maxRecords = GLOBAL_CAPTURE_LIMITS.records,
  maxSourceBytes = GLOBAL_CAPTURE_LIMITS.sourceBytes, deadlineMs = GLOBAL_CAPTURE_LIMITS.deadlineMs,
  runtimeDir, signal } = {}) {
  assert(Array.isArray(ranges) && ranges.length >= 1 && ranges.length <= GLOBAL_CAPTURE_LIMITS.ranges,
    'An explicit array of 1–8 capture ranges is required.');
  const selected = ranges.map(range => {
    assert(range && typeof range === 'object' && !Array.isArray(range)
      && Object.keys(range).every(key => ['startHeight', 'endHeight'].includes(key))
      && height(range.startHeight) && height(range.endHeight) && range.endHeight >= range.startHeight
      && range.endHeight - range.startHeight + 1 <= GLOBAL_CAPTURE_LIMITS.blocksPerRange,
    'Every capture range requires explicit integer heights and at most 16 blocks.');
    return { startHeight: range.startHeight, endHeight: range.endHeight };
  });
  assert(selected.reduce((sum, range) => sum + range.endHeight - range.startHeight + 1, 0) <= GLOBAL_CAPTURE_LIMITS.blocks,
    'Global capture exceeds the 128-block bound.');
  assert(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= GLOBAL_CAPTURE_LIMITS.records,
    'Global capture record bound must be 1–2048.');
  assert(Number.isSafeInteger(maxSourceBytes) && maxSourceBytes >= 1 && maxSourceBytes <= GLOBAL_CAPTURE_LIMITS.sourceBytes,
    'Global source JSON bound must be at most 128 MiB.');
  assert(Number.isSafeInteger(deadlineMs) && deadlineMs >= 1 && deadlineMs <= GLOBAL_CAPTURE_LIMITS.deadlineMs,
    'Global capture deadline must be at most ten minutes.');
  assert(signal === undefined || signal instanceof AbortSignal, 'Invalid caller abort signal.');
  return { ranges: selected, maxRecords, maxSourceBytes, deadlineMs, runtimeDir, signal };
}

async function abortable(work, signal) {
  signal.throwIfAborted();
  let listener;
  const stopped = new Promise((_, reject) => {
    listener = () => reject(signal.reason ?? new Error('Global capture aborted.'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(work), stopped]); }
  finally { signal.removeEventListener('abort', listener); }
}

function rateObservation(headers) {
  const integer = name => {
    const value = headers?.get(name);
    return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  };
  return { remaining: integer('ratelimit-remaining'), resetSeconds: integer('ratelimit-reset') };
}

// A new lab-only 32-MiB reader. The installed pilot's 8-MiB reader is unchanged.
// No endpoint override, credentials, RPC configuration or fallback is accepted.
export async function rawGlobalFromLoopback(txid, { signal, fetchFn = fetch, onResponse = () => {} } = {}) {
  assert(typeof txid === 'string' && HASH.test(txid), 'Invalid raw observation identifier.');
  const timeout = AbortSignal.timeout(GLOBAL_CAPTURE_LIMITS.rawTimeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return abortable(async () => {
    const response = await fetchFn(`http://127.0.0.1:3001/v1/transactions/${txid}/verbose`, {
      method: 'GET', credentials: 'omit', redirect: 'error', referrer: '', referrerPolicy: 'no-referrer', signal: abort,
      headers: { Accept: 'application/json' },
    });
    try {
      assert(response.ok && response.body, 'Raw transaction observation unavailable.');
      const advertised = response.headers?.get('content-length');
      assert(advertised === null || advertised === undefined || /^\d+$/.test(advertised)
        && Number(advertised) <= GLOBAL_CAPTURE_LIMITS.rawResponseBytes, 'Raw response capacity exceeded.');
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        abort.throwIfAborted(); bytes += chunk.length;
        assert(bytes <= GLOBAL_CAPTURE_LIMITS.rawResponseBytes, 'Raw response capacity exceeded.');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      assert(body.meta?.network === 'mainnet' && body.data?.txid === txid
        && body.data.decoded?.txid === txid && typeof body.data.hex === 'string'
        && /^(?:[a-f0-9]{2})+$/.test(body.data.hex), 'Raw network/identity/bytes mismatch.');
      onResponse({ bytes, ...rateObservation(response.headers) });
      return body;
    } finally {
      // Cancel an unread/rejected body; no rejected oversized stream continues.
      if (response.body && !response.body.locked) await response.body.cancel?.().catch(() => {});
    }
  }, abort);
}

function addAnchor(anchors, candidate) {
  assert(height(candidate?.height) && HASH.test(candidate.hash), 'Invalid captured canonical anchor.');
  assert(!anchors.has(candidate.height) || anchors.get(candidate.height) === candidate.hash,
    'Mismatched canonical anchors at the same height.');
  anchors.set(candidate.height, candidate.hash);
}

function verifyHeaders(value, anchors, snapshots, completedAt) {
  assert(value?.schema === 'zecblock-private-header-guard-v1' && value.network === 'mainnet'
    && value.database === 'zcash_explorer_mainnet' && value.isPrimary === true && value.readOnly === true
    && value.genesisHash === MAINNET_GENESIS && height(value.tip?.height) && HASH.test(value.tip.hash)
    && dated(value.observedAt) && Array.isArray(value.blocks), 'Fresh primary mainnet read-only canonical headers required.');
  assert(Date.parse(value.observedAt) >= Date.parse(completedAt)
    && snapshots.every(snapshot => Date.parse(value.observedAt) >= Date.parse(snapshot.observedAt)),
  'Canonical headers predate global raw capture completion.');
  assert(value.blocks.length === anchors.size && new Set(value.blocks.map(block => block.height)).size === anchors.size
    && value.blocks.every(block => anchors.get(block.height) === block.hash),
  'Canonical block or observation anchor changed after raw capture.');
  assert(snapshots.every(snapshot => value.tip.height >= snapshot.tip.height
    && (value.tip.height !== snapshot.tip.height || value.tip.hash === snapshot.tip.hash)),
  'Fresh canonical tip no longer contains a captured observation anchor.');
}

// Read-only, all-or-nothing capture. This returns a native input, not a prepared
// or admitted publication. Each record keeps its original range context.
export async function captureGlobalSource(options = {}, dependencies = {}) {
  const bounded = boundedOptions(options);
  const runtime = HELPERS.every(key => typeof dependencies[key] === 'function') ? dependencies
    : { ...await loadGlobalCaptureRuntime(bounded.runtimeDir), ...dependencies };
  assert(HELPERS.every(key => typeof runtime[key] === 'function'), 'Required global capture runtime helper unavailable.');
  const now = dependencies.now ?? (() => new Date().toISOString());
  const clock = dependencies.clock ?? (() => performance.now());
  const pause = dependencies.pause ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const readRaw = dependencies.rawFromLoopback ?? rawGlobalFromLoopback;
  const startedAt = now(), started = clock();
  assert(dated(startedAt), 'Invalid capture clock.');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Global capture deadline exceeded.')), bounded.deadlineMs);
  const signal = bounded.signal ? AbortSignal.any([bounded.signal, deadline.signal]) : deadline.signal;
  const source = { schema: GLOBAL_SOURCE_SCHEMA, network: 'mainnet', records: [] };
  const anchors = new Map(), snapshots = [], seenTransactions = new Set(), seenRaw = new Set(), ranges = [];
  let rawCalls = 0, rawResponseBytes = 0, recordJsonBytes = 0, ratePauseMs = 0, ratePauses = 0;
  let nextRatePauseMs = 0, rawActive = false, minRateRemaining = null;
  try {
    signal.throwIfAborted();
    for (const [index, range] of bounded.ranges.entries()) {
      const remaining = bounded.maxRecords - source.records.length;
      assert(remaining > 0, 'Global capture record bound exhausted before the next complete range.');
      const request = { ...range, maxBlocks: range.endHeight - range.startHeight + 1, maxRecords: remaining };
      const mark = clock();
      const captured = await abortable(() => runtime.capturePrimary(request, { signal }), signal);
      const captureText = jsonFile(captured);
      const snapshot = runtime.decodePrimarySnapshot(captureText);
      assert(snapshot.coverage.startHeight === range.startHeight && snapshot.coverage.endHeight === range.endHeight
        && snapshot.blocks.length === request.maxBlocks && snapshot.transactions.length <= remaining
        && snapshot.limits.maxBlocks <= request.maxBlocks && snapshot.limits.maxRecords <= remaining,
      'Capture does not match the explicit global range bounds.');
      const captureMs = clock() - mark;
      for (const block of snapshot.blocks) addAnchor(anchors, { height: Number(block.height), hash: block.hash });
      addAnchor(anchors, snapshot.tip);
      for (const tx of snapshot.transactions) {
        assert(!seenTransactions.has(tx.txid), 'Duplicate transaction identifier across capture ranges.');
        seenTransactions.add(tx.txid);
      }
      snapshots.push(snapshot);
      const allowed = new Map(snapshot.transactions.map(tx => [tx.txid, tx.block_hash]));
      const beforeCalls = rawCalls, beforeBytes = rawResponseBytes;
      let scope;
      try {
        scope = await abortable(() => runtime.createPrimarySnapshotReader({ capture: snapshot,
          readPrice: async () => { throw new Error('Historical price is unavailable in indexed-only global capture.'); },
          readRaw: async txid => {
            signal.throwIfAborted();
            assert(allowed.has(txid) && !seenRaw.has(txid) && !rawActive && rawCalls < bounded.maxRecords,
              'Raw read is duplicate, concurrent, outside captured coverage or exceeds the total bound.');
            rawActive = true; seenRaw.add(txid);
            try {
              if (rawCalls > 0) {
                const waitMs = Math.max(GLOBAL_CAPTURE_LIMITS.rawPacingMs, nextRatePauseMs);
                if (nextRatePauseMs > 0) { ratePauseMs += waitMs; ratePauses++; }
                await abortable(() => pause(waitMs, signal), signal);
              }
              nextRatePauseMs = 0; rawCalls++;
              let transport;
              const rawSignal = AbortSignal.any([signal, AbortSignal.timeout(GLOBAL_CAPTURE_LIMITS.rawTimeoutMs)]);
              const response = await abortable(() => readRaw(txid, { signal: rawSignal, onResponse: info => { transport = info; } }), rawSignal);
              const bytes = transport?.bytes ?? Buffer.byteLength(JSON.stringify(response));
              assert(Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= GLOBAL_CAPTURE_LIMITS.rawResponseBytes,
                'Raw response capacity exceeded.');
              assert(response?.meta?.network === 'mainnet' && response.data?.txid === txid
                && response.data.decoded?.txid === txid && typeof response.data.hex === 'string'
                && /^(?:[a-f0-9]{2})+$/.test(response.data.hex)
                && (response.data.decoded.blockhash === undefined || response.data.decoded.blockhash === allowed.get(txid)),
              'Raw network/identity/bytes or canonical block mismatch.');
              rawResponseBytes += bytes;
              if (transport?.remaining !== null && transport?.remaining !== undefined) {
                assert(Number.isSafeInteger(transport.remaining) && transport.remaining >= 0, 'Invalid raw rate budget.');
                minRateRemaining = Math.min(minRateRemaining ?? transport.remaining, transport.remaining);
                if (transport.remaining < 120) {
                  assert(Number.isSafeInteger(transport.resetSeconds) && transport.resetSeconds >= 0 && transport.resetSeconds <= 60,
                    'Raw rate budget reset exceeds the bounded sixty-second pause.');
                  nextRatePauseMs = transport.resetSeconds * 1000;
                }
              }
              return response;
            } finally { rawActive = false; }
          } }), signal);
        const exportMark = clock();
        const exported = await abortable(() => runtime.exportLive({ read: scope.read, ...request, now,
          sourceOrigin: 'mainnet-primary-read-only-snapshot', sourceAuthority: scope.authority }), signal);
        assert(exported?.schema === 'zecblock-private-tx-source-v1' && exported.network === 'mainnet'
          && exported.coverage?.complete === true && exported.coverage.startHeight === range.startHeight
          && exported.coverage.endHeight === range.endHeight && dated(exported.coverage.captureCompletedAt)
          && exported.snapshot?.height === snapshot.tip.height && exported.snapshot.hash === snapshot.tip.hash
          && Array.isArray(exported.records) && exported.records.length === snapshot.transactions.length
          && rawCalls - beforeCalls === snapshot.transactions.length
          && JSON.stringify(exported.coverage.blocks?.map(block => [block.height, block.hash, block.transactionCount]))
            === JSON.stringify(snapshot.blocks.map(block => [Number(block.height), block.hash, Number(block.transaction_count)])),
        'Export does not match the complete captured global range.');
        addAnchor(anchors, exported.snapshot);
        const exportedIds = new Set();
        for (const record of exported.records) {
          assert(allowed.has(record.txid) && !exportedIds.has(record.txid)
            && !['schema', 'network', 'snapshot', 'coverage'].some(key => Object.hasOwn(record, key)),
          'Exported record identity/context mismatch.');
          exportedIds.add(record.txid);
          const full = { schema: 'zecblock-private-tx-record-v1', network: exported.network,
            snapshot: exported.snapshot, coverage: exported.coverage, ...record };
          recordJsonBytes += Buffer.byteLength(JSON.stringify(full));
          assert(recordJsonBytes <= bounded.maxSourceBytes, 'Global source JSON exceeds its bounded capacity.');
          source.records.push(full);
        }
        const exportedText = jsonFile(exported);
        ranges.push({ index, ...range, blocks: snapshot.blocks.length, records: exported.records.length,
          indexedInputs: snapshot.inputs.length, indexedOutputs: snapshot.outputs.length,
          rawCalls: rawCalls - beforeCalls, rawResponseBytes: rawResponseBytes - beforeBytes,
          snapshot: exported.snapshot, sourceObservedAt: snapshot.observedAt, snapshotId: snapshot.snapshotId,
          captureStartedAt: exported.coverage.captureStartedAt, captureCompletedAt: exported.coverage.captureCompletedAt,
          primaryFactsFingerprint: runtime.primaryFactsFingerprint(snapshot), captureJsonSha256: sha(captureText),
          exportedJsonSha256: sha(exportedText), captureJsonBytes: Buffer.byteLength(captureText),
          exportedJsonBytes: Buffer.byteLength(exportedText), captureMs, exportMs: clock() - exportMark });
      } finally { await scope?.close(); }
    }
    const completedAt = now();
    assert(dated(completedAt) && Date.parse(completedAt) >= Date.parse(startedAt)
      && ranges.every(range => Date.parse(completedAt) >= Date.parse(range.captureCompletedAt)), 'Invalid global capture completion clock.');
    const anchorList = [...anchors].sort(([a], [b]) => a - b).map(([anchorHeight, hash]) => ({ height: anchorHeight, hash }));
    const verifyStarted = clock();
    const headers = await abortable(() => runtime.canonicalHeaders(anchorList.map(anchor => anchor.height), { signal }), signal);
    verifyHeaders(headers, anchors, snapshots, completedAt);
    const sourceText = jsonFile(source), sourceBytes = Buffer.byteLength(sourceText);
    assert(sourceBytes <= bounded.maxSourceBytes, 'Global source JSON exceeds its bounded capacity.');
    signal.throwIfAborted();
    return { source, anchors: anchorList, receipt: {
      schema: 'zecblock-private-global-capture-receipt-v1', readOnly: true, isPrimary: true, network: 'mainnet',
      database: 'zcash_explorer_mainnet', genesisHash: MAINNET_GENESIS,
      authority: 'Per-range bounded primary PostgreSQL repeatable-read READ ONLY snapshots plus separately observed fixed loopback raw data; independent canonical headers after all raw captures.',
      wireHashVerification: 'deferred-to-native-plan', preparedOrPublished: false,
      limits: { ...GLOBAL_CAPTURE_LIMITS, records: bounded.maxRecords, sourceBytes: bounded.maxSourceBytes, deadlineMs: bounded.deadlineMs },
      ranges, counts: { ranges: ranges.length, blocks: ranges.reduce((sum, range) => sum + range.blocks, 0),
        records: source.records.length, anchors: anchorList.length, rawCalls },
      bytes: { sourceJson: sourceBytes, rawResponses: rawResponseBytes },
      hashes: { sourceRawFileSha256: sha(sourceText), canonicalHeadersRawJsonSha256: sha(jsonFile(headers)),
        nativeCanonicalSourceSha256: null,
        sourceHashMeaning: 'SHA-256 of exact UTF-8 JSON.stringify(source) plus one LF; not the native canonical JSON digest.',
        rangeHashMeaning: 'Per-range hashes cover JSON.stringify(object) plus one LF; SQL transport bytes are not retained.' },
      observations: { startedAt, captureCompletedAt: completedAt, canonicalVerifiedAt: headers.observedAt, verifiedTip: headers.tip },
      pacing: { rawPacingMs: GLOBAL_CAPTURE_LIMITS.rawPacingMs, minRateRemaining, ratePauses, ratePauseMs },
      timings: { canonicalVerifyMs: clock() - verifyStarted, totalMs: clock() - started },
    } };
  } finally { clearTimeout(timer); }
}

export function parseGlobalCaptureArgs(args) {
  const result = { ranges: [] };
  const fields = new Map([['--runtime', 'runtimeDir'], ['--output', 'output'], ['--receipt', 'receipt'], ['--anchors', 'anchors']]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    assert(typeof value === 'string' && !value.startsWith('--'), 'Missing global capture argument.');
    if (name === '--range') {
      const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value);
      assert(match, 'Range must be explicit START:END unsigned decimal heights.');
      result.ranges.push({ startHeight: Number(match[1]), endHeight: Number(match[2]) });
    } else {
      const field = fields.get(name);
      assert(field && !(field in result), 'Unknown or duplicate global capture argument.');
      result[field] = value;
    }
  }
  assert(typeof result.runtimeDir === 'string' && isAbsolute(result.runtimeDir)
    && /\/prototype\/private-tx\/?$/.test(result.runtimeDir), 'An explicit absolute prototype/private-tx runtime directory is required.');
  assert(typeof result.output === 'string', 'An explicit absolute output file is required.');
  for (const field of ['output', 'receipt', 'anchors']) if (result[field] !== undefined) {
    assert(isAbsolute(result[field]), 'Every output path must be absolute.'); result[field] = resolve(result[field]);
  }
  assert(new Set(['output', 'receipt', 'anchors'].map(field => result[field]).filter(Boolean)).size
    === ['output', 'receipt', 'anchors'].filter(field => result[field] !== undefined).length, 'Output paths must be distinct.');
  boundedOptions(result);
  return result;
}

async function outputPreflight(paths) {
  for (const path of paths) {
    const parent = await lstat(dirname(path));
    assert(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0
      && (process.getuid === undefined || parent.uid === process.getuid()), 'Output parent must be an owned private ordinary directory.');
    try { await lstat(path); throw new Error('Output already exists; refusing capture before source reads.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function runGlobalCaptureCli(args, dependencies = {}) {
  const parsed = parseGlobalCaptureArgs(args);
  const paths = ['output', 'receipt', 'anchors'].filter(field => parsed[field]).map(field => parsed[field]);
  await outputPreflight(paths); // Existing output refusal precedes runtime/SQL.
  const result = await captureGlobalSource({ ...parsed, signal: dependencies.signal }, dependencies);
  const files = [[parsed.output, result.source], ...(parsed.receipt ? [[parsed.receipt, result.receipt]] : []),
    ...(parsed.anchors ? [[parsed.anchors, result.anchors]] : [])];
  const created = [];
  try {
    for (const [path, value] of files) {
      dependencies.signal?.throwIfAborted();
      const handle = await open(path, 'wx', 0o600);
      created.push(path);
      try { await handle.writeFile(jsonFile(value), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
    }
  } catch (error) {
    await Promise.allSettled(created.map(path => unlink(path)));
    throw error;
  }
  return { schema: result.receipt.schema, readOnly: true, preparedOrPublished: false,
    counts: result.receipt.counts, bytes: result.receipt.bytes, timings: result.receipt.timings,
    sourceRawFileSha256: result.receipt.hashes.sourceRawFileSha256,
    wireHashVerification: result.receipt.wireHashVerification };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error('Global capture interrupted.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupt);
  try { process.stdout.write(`${JSON.stringify(await runGlobalCaptureCli(process.argv.slice(2), { signal: abort.signal }))}\n`); }
  catch {
    // Runtime errors can contain source payloads; never print them in CLI logs.
    process.stderr.write('Bounded read-only global capture failed; no source admitted or publication prepared.\n');
    process.exitCode = 1;
  } finally { for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt); }
}
