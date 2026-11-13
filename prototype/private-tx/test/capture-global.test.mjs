import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureGlobalSource, loadGlobalCaptureRuntime, rawGlobalFromLoopback, parseGlobalCaptureArgs,
  runGlobalCaptureCli, GLOBAL_CAPTURE_LIMITS } from '../pilot/capture-global.mjs';
import { createPrimarySnapshotReader, decodePrimarySnapshot, primaryFactsFingerprint,
  MAINNET_GENESIS_HASH, PRIMARY_SNAPSHOT_SCHEMA } from '../primary-source.mjs';
import { exportLive } from '../export-live.mjs';

const id = value => value.toString(16).padStart(64, '0');
const NOW = '2026-11-03T12:00:00.000Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const range = (startHeight, endHeight = startHeight) => ({ startHeight, endHeight });
const hashAt = height => height === 0 ? MAINNET_GENESIS_HASH : id(10_000_000 + height);

// Structurally valid synthetic v1 coinbase wire fixture, never a source fetch.
function wire(index) {
  const tag = Buffer.alloc(4); tag.writeUInt32LE(index);
  const bytes = Buffer.concat([Buffer.from('0100000001', 'hex'), Buffer.alloc(32), Buffer.from('ffffffff04', 'hex'),
    tag, Buffer.from('ffffffff010100000000000000015100000000', 'hex')]);
  return { hex: bytes.toString('hex'), txid: Buffer.from(createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest()).reverse().toString('hex') };
}

function fixture(request, index = 0, count = 1) {
  const blocks = Array.from({ length: request.endHeight - request.startHeight + 1 }, (_, offset) => {
    const h = request.startHeight + offset;
    return { height: String(h), hash: hashAt(h), previous_block_hash: h === 0 ? id(0) : hashAt(h - 1),
      timestamp: '1793707190', transaction_count: String(count), coinbase_hex: '004142' };
  });
  const transactions = blocks.flatMap(block => Array.from({ length: count }, (_, position) => ({
    txid: wire(Number(block.height) * 100 + position).txid, block_height: block.height, block_hash: block.hash,
    block_time: block.timestamp, tx_index: String(position), version: '1', locktime: '0', expiry_height: '0', size: '65',
    vin_count: position === 0 ? '1' : '0', vout_count: '1', is_coinbase: String(position === 0),
    has_sprout: 'false', has_sapling: 'false', has_orchard: 'false', has_ironwood: 'false',
    fee: position === 0 ? null : '0', total_input: '0', total_output: '1', value_balance: '0',
  })));
  return { schema: PRIMARY_SNAPSHOT_SCHEMA, network: 'mainnet', database: 'zcash_explorer_mainnet', isPrimary: true,
    readOnly: true, genesisHash: MAINNET_GENESIS_HASH, observedAt: `2026-11-03T11:59:${String(50 + index).padStart(2, '0')}.000Z`,
    snapshotId: `${123 + index}:${123 + index}:`, limits: { maxBlocks: request.maxBlocks, maxRecords: request.maxRecords, maxIoRows: 200_000 },
    coverage: { startHeight: String(request.startHeight), endHeight: String(request.endHeight) },
    tip: { height: String(3_000_000 + index), hash: hashAt(3_000_000 + index) }, blocks, transactions, inputs: [],
    outputs: transactions.map(tx => ({ txid: tx.txid, vout_index: '0', value: '1', address: 'synthetic-public-address', spent: 'false' })) };
}

function sample(ranges = [range(0), range(1_800_003), range(2_000_007)]) {
  const calls = { capture: [], raw: [], headers: [], pauses: [], exported: [], snapshots: [], close: 0 };
  const dependencies = {
    capturePrimary: async request => {
      calls.capture.push({ ...request });
      const value = fixture(request, calls.capture.length - 1); calls.snapshots.push(value); return value;
    }, decodePrimarySnapshot, primaryFactsFingerprint,
    createPrimarySnapshotReader: async options => {
      const reader = await createPrimarySnapshotReader(options);
      return { ...reader, close: async () => { calls.close++; await reader.close(); } };
    },
    exportLive: async options => { const value = await exportLive(options); calls.exported.push(structuredClone(value)); return value; },
    canonicalHeaders: async heights => {
      calls.headers.push([...heights]);
      assert.equal(calls.raw.length, calls.snapshots.reduce((sum, capture) => sum + capture.transactions.length, 0));
      return { schema: 'zecblock-private-header-guard-v1', network: 'mainnet', database: 'zcash_explorer_mainnet',
        isPrimary: true, readOnly: true, genesisHash: MAINNET_GENESIS_HASH, observedAt: '2026-11-03T12:00:01.000Z',
        tip: { height: 3_000_100, hash: hashAt(3_000_100) }, blocks: heights.map(height => ({ height, hash: hashAt(height) })) };
    },
    rawFromLoopback: async (txid, { signal, onResponse }) => {
      assert.ok(signal instanceof AbortSignal); signal.throwIfAborted(); calls.raw.push(txid);
      const tx = calls.snapshots.flatMap(capture => capture.transactions).find(tx => tx.txid === txid);
      const bytes = wire(Number(tx.block_height) * 100 + Number(tx.tx_index));
      const value = { meta: { network: 'mainnet', generatedAt: NOW }, data: { txid, hex: bytes.hex,
        decoded: { txid, hex: bytes.hex, blockhash: tx.block_hash, unavailable: null } } };
      onResponse({ bytes: Buffer.byteLength(JSON.stringify(value)), remaining: 400, resetSeconds: 45 });
      return value;
    },
    now: () => NOW, pause: async (ms, signal) => { signal.throwIfAborted(); calls.pauses.push(ms); },
    prepare: () => assert.fail('Capture never prepares a native artifact.'),
    publish: () => assert.fail('Capture never publishes.'),
  };
  return { calls, dependencies, options: { ranges }, run: options => captureGlobalSource({ ranges, ...options }, dependencies) };
}

async function directory(t) {
  const path = await mkdtemp(resolve(tmpdir(), 'pir-global-capture-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('separate SQL snapshots become full native envelopes with exact original context and DTO parity', async () => {
  const value = sample(); const { source, anchors, receipt } = await value.run();
  assert.equal(source.schema, 'zecblock-private-global-source-v1'); assert.equal(source.network, 'mainnet');
  assert.deepEqual(Object.keys(source), ['schema', 'network', 'records']);
  assert.equal(source.records.length, 3); assert.equal(value.calls.close, 3);
  assert.deepEqual(value.calls.capture.map(request => request.maxRecords), [2048, 2047, 2046]);
  assert.deepEqual(value.calls.pauses, [200, 200]);
  for (const [index, record] of source.records.entries()) {
    const exported = value.calls.exported[index];
    assert.deepEqual(record, { schema: 'zecblock-private-tx-record-v1', network: 'mainnet',
      snapshot: exported.snapshot, coverage: exported.coverage, ...exported.records[0] });
    assert.equal(record.snapshot.height, 3_000_000 + index);
    assert.equal(record.detail.feeZat, null); assert.equal(record.detail.totalOutputZat, '1');
    assert.equal(record.price.available, false); assert.equal(record.detail.outputs[0].value, '1');
    assert.equal(record.raw.hex, record.raw.decoded.hex);
  }
  assert.deepEqual(value.calls.headers, [anchors.map(anchor => anchor.height)]);
  assert.deepEqual(anchors.map(anchor => anchor.height), [0, 1_800_003, 2_000_007, 3_000_000, 3_000_001, 3_000_002]);
  assert.equal(receipt.readOnly, true); assert.equal(receipt.preparedOrPublished, false);
  assert.equal(receipt.wireHashVerification, 'deferred-to-native-plan');
  assert.equal(receipt.hashes.nativeCanonicalSourceSha256, null);
  assert.equal(receipt.hashes.sourceRawFileSha256, sha(`${JSON.stringify(source)}\n`));
  assert.equal(receipt.bytes.sourceJson, Buffer.byteLength(`${JSON.stringify(source)}\n`));
  assert.equal(receipt.counts.rawCalls, 3); assert.equal(receipt.counts.blocks, 3);
  assert.equal(receipt.pacing.minRateRemaining, 400);
  const text = JSON.stringify(receipt);
  for (const record of source.records) assert.equal(text.includes(record.txid), false);
  assert.equal(text.includes('synthetic-public-address'), false);
});

test('validates explicit range, record, byte and deadline bounds before any source read', async () => {
  const value = sample();
  for (const options of [{ ranges: undefined }, { ranges: [] }, { ranges: Array(9).fill(range(1)) },
    { ranges: [range(-1)] }, { ranges: [range('0', 0)] }, { ranges: [range(0, 16)] }, { ranges: [range(2, 1)] },
    { ranges: [{ startHeight: 0 }] }, { ranges: [{ ...range(1), sql: 'SELECT' }] },
    { maxRecords: 0 }, { maxRecords: 2049 }, { maxSourceBytes: 128 * 1024 ** 2 + 1 },
    { deadlineMs: 600_001 }, { deadlineMs: 0 }]) await assert.rejects(value.run(options));
  assert.equal(value.calls.capture.length, 0);
});

test('accepts all 128 explicitly selected blocks with a single final independent guard', async () => {
  const value = sample(Array.from({ length: 8 }, (_, index) => range(index * 16, index * 16 + 15)));
  const result = await value.run();
  assert.equal(result.receipt.counts.blocks, 128); assert.equal(result.receipt.counts.records, 128);
  assert.equal(result.receipt.counts.rawCalls, 128); assert.equal(value.calls.headers.length, 1);
  assert.ok(value.calls.capture.every(request => request.maxBlocks === 16));
});

test('record bound applies to all ranges and rejects the next complete range before its raw reads', async () => {
  const value = sample();
  await assert.rejects(value.run({ maxRecords: 2 }), /record bound exhausted/);
  assert.equal(value.calls.capture.length, 2); assert.equal(value.calls.raw.length, 2);
  assert.equal(value.calls.headers.length, 0);
});

test('requires primary read-only mainnet/genesis authority and exact range before any raw read', async () => {
  for (const mutate of [capture => { capture.readOnly = false; }, capture => { capture.isPrimary = false; },
    capture => { capture.network = 'testnet'; }, capture => { capture.genesisHash = id(0); },
    capture => { capture.coverage.endHeight = String(Number(capture.coverage.endHeight) + 1); }]) {
    const value = sample([range(100)]), original = value.dependencies.capturePrimary;
    value.dependencies.capturePrimary = async request => { const capture = await original(request); mutate(capture); return capture; };
    await assert.rejects(value.run()); assert.equal(value.calls.raw.length, 0);
  }
});

test('same-height conflicting anchors fail closed before second-range raw data', async () => {
  const value = sample([range(100), range(200)]), original = value.dependencies.capturePrimary;
  value.dependencies.capturePrimary = async request => {
    const capture = await original(request);
    capture.tip.height = '3000000';
    if (value.calls.capture.length === 2) capture.tip.hash = id(777);
    return capture;
  };
  await assert.rejects(value.run(), /Mismatched canonical anchors/);
  assert.equal(value.calls.raw.length, 1);
});

test('duplicate txids across ranges reject without silently deduplicating or making another raw call', async () => {
  const value = sample([range(100), range(100)]);
  await assert.rejects(value.run(), /Duplicate transaction identifier across/);
  assert.equal(value.calls.raw.length, 1); assert.equal(value.calls.headers.length, 0);
});

test('source JSON bound includes every complete self-contained record context', async () => {
  const value = sample([range(100)]);
  await assert.rejects(value.run({ maxSourceBytes: 1024 }), /Global source JSON/);
  assert.equal(value.calls.headers.length, 0); assert.equal(value.calls.close, 1);
});

test('post-capture guard rejects replacements, missing/duplicate anchors, rollback and stale headers', async () => {
  for (const mutate of [headers => { headers.blocks[0].hash = id(1); }, headers => { headers.blocks.at(-1).hash = id(1); },
    headers => { headers.blocks.pop(); }, headers => { headers.blocks[1] = headers.blocks[0]; },
    headers => { headers.observedAt = '2026-11-03T11:59:59.999Z'; }, headers => { headers.tip.height = 2_999_999; },
    headers => { headers.readOnly = false; }, headers => { headers.genesisHash = id(0); }]) {
    const value = sample(), original = value.dependencies.canonicalHeaders;
    value.dependencies.canonicalHeaders = async heights => { const headers = await original(heights); mutate(headers); return headers; };
    await assert.rejects(value.run(), /canonical|Canonical|primary/);
    assert.equal(value.calls.raw.length, 3); assert.equal(value.calls.close, 3);
  }
});

test('final guard must also follow the global completion clock after the last raw capture', async () => {
  const value = sample([range(100)]); let clocks = 0;
  value.dependencies.now = () => ++clocks >= 4 ? '2026-11-03T12:00:02.000Z' : NOW;
  await assert.rejects(value.run(), /predate global raw capture completion/);
});

test('raw requests are bound to captured identities, canonical block hash and one call per tx', async () => {
  for (const mutate of [response => { response.meta.network = 'testnet'; }, response => { response.data.txid = id(2); },
    response => { response.data.decoded.txid = id(2); }, response => { response.data.decoded.blockhash = id(2); },
    response => { response.data.hex = 'zz'; }]) {
    const value = sample([range(100)]), original = value.dependencies.rawFromLoopback;
    value.dependencies.rawFromLoopback = async (...args) => { const response = await original(...args); mutate(response); return response; };
    await assert.rejects(value.run(), /Raw network\/identity/); assert.equal(value.calls.raw.length, 1);
  }
  const duplicate = sample([range(100)]);
  duplicate.dependencies.exportLive = async ({ read }) => {
    const txid = duplicate.calls.snapshots[0].transactions[0].txid;
    await read(`/v1/transactions/${txid}/verbose`); await read(`/v1/transactions/${txid}/verbose`);
  };
  await assert.rejects(duplicate.run(), /Raw read is duplicate/); assert.equal(duplicate.calls.raw.length, 1);
  const outside = sample([range(100)]);
  outside.dependencies.exportLive = ({ read }) => read(`/v1/transactions/${id(999)}/verbose`);
  await assert.rejects(outside.run(), /outside captured coverage/); assert.equal(outside.calls.raw.length, 0);
});

test('paces raw requests across ranges and respects low remaining rate allowance', async () => {
  const value = sample(), original = value.dependencies.rawFromLoopback;
  value.dependencies.rawFromLoopback = (txid, options) => original(txid, { ...options,
    onResponse: info => options.onResponse({ ...info, remaining: 119, resetSeconds: 2 }) });
  const result = await value.run();
  assert.deepEqual(value.calls.pauses, [2000, 2000]); assert.equal(result.receipt.pacing.ratePauses, 2);
  assert.equal(result.receipt.pacing.ratePauseMs, 4000); assert.equal(result.receipt.pacing.minRateRemaining, 119);
  const unbounded = sample([range(100)]), raw = unbounded.dependencies.rawFromLoopback;
  unbounded.dependencies.rawFromLoopback = (txid, options) => raw(txid, { ...options,
    onResponse: info => options.onResponse({ ...info, remaining: 0, resetSeconds: 61 }) });
  await assert.rejects(unbounded.run(), /sixty-second pause/);
});

test('caller abort and overall deadline stop all further work without a final source', async () => {
  const aborted = sample(); const abort = new AbortController(); abort.abort(new Error('caller stopped'));
  await assert.rejects(aborted.run({ signal: abort.signal }), /caller stopped/); assert.equal(aborted.calls.capture.length, 0);
  const active = sample();
  active.dependencies.rawFromLoopback = async () => new Promise(() => {});
  await assert.rejects(active.run({ deadlineMs: 15 }), /deadline exceeded/);
  assert.equal(active.calls.capture.length, 1); assert.equal(active.calls.close, 1); assert.equal(active.calls.headers.length, 0);
});

test('new raw reader is a fixed unauthenticated loopback GET and accepts a response above old 8-MiB cap', async () => {
  const fixture = wire(123), value = { meta: { network: 'mainnet' }, data: { txid: fixture.txid, hex: fixture.hex,
    decoded: { txid: fixture.txid, blob: 'a'.repeat(8 * 1024 ** 2) } } };
  const text = JSON.stringify(value); let observed;
  const response = await rawGlobalFromLoopback(fixture.txid, { onResponse: info => { observed = info; },
    fetchFn: async (url, options) => {
      assert.equal(url, `http://127.0.0.1:3001/v1/transactions/${fixture.txid}/verbose`);
      assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      assert.equal(options.referrer, ''); assert.equal(options.referrerPolicy, 'no-referrer');
      assert.deepEqual(options.headers, { Accept: 'application/json' }); assert.ok(options.signal instanceof AbortSignal);
      return new Response(text, { headers: { 'content-length': String(Buffer.byteLength(text)),
        'ratelimit-remaining': '119', 'ratelimit-reset': '10' } });
    } });
  assert.deepEqual(response, value); assert.ok(observed.bytes > 8 * 1024 ** 2);
  assert.equal(observed.remaining, 119); assert.equal(observed.resetSeconds, 10);
  assert.equal(GLOBAL_CAPTURE_LIMITS.rawResponseBytes, 32 * 1024 ** 2);
});

test('raw reader rejects oversized advertised or streamed data, identity mismatch and HTTP errors', async () => {
  const { txid } = wire(123);
  await assert.rejects(rawGlobalFromLoopback(txid, { fetchFn: async () => new Response('{}',
    { headers: { 'content-length': String(32 * 1024 ** 2 + 1) } }) }), /capacity exceeded/);
  await assert.rejects(rawGlobalFromLoopback(txid, { fetchFn: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(16 * 1024 ** 2)); controller.enqueue(Buffer.alloc(16 * 1024 ** 2 + 1)); controller.close(); },
  })) }), /capacity exceeded/);
  await assert.rejects(rawGlobalFromLoopback(txid, { fetchFn: async () => new Response('{}') }), /network\/identity/);
  await assert.rejects(rawGlobalFromLoopback(txid, { fetchFn: async () => new Response('{}', { status: 429 }) }), /unavailable/);
  await assert.rejects(rawGlobalFromLoopback('bad', { fetchFn: () => assert.fail('Invalid id must not fetch.') }), /identifier/);
});

test('runtime imports use explicit existing absolute directory without starting a service', async () => {
  const runtime = await loadGlobalCaptureRuntime(resolve(import.meta.dirname, '..'));
  assert.equal(runtime.exportLive, exportLive); assert.equal(runtime.decodePrimarySnapshot, decodePrimarySnapshot);
  await assert.rejects(loadGlobalCaptureRuntime('relative'), /absolute/);
  await assert.rejects(loadGlobalCaptureRuntime('/tmp'), /prototype\/private-tx/);
});

test('strict CLI accepts repeated explicit ranges and optional private receipts/anchors', () => {
  const args = ['--runtime', '/opt/existing/prototype/private-tx', '--output', '/private/source.json',
    '--range', '0:0', '--range', '1800003:1800003', '--receipt', '/private/receipt.json', '--anchors', '/private/anchors.json'];
  assert.deepEqual(parseGlobalCaptureArgs(args).ranges, [range(0), range(1_800_003)]);
  for (const extra of [['--range', '0:16'], ['--range', '1e2:100'], ['--range', '1'], ['--output', '/other'],
    ['--unknown', 'true'], ['--receipt', 'relative'], ['--max-records', '2049']]) assert.throws(() => parseGlobalCaptureArgs([...args, ...extra]));
  assert.throws(() => parseGlobalCaptureArgs(['--runtime', '/opt/existing/prototype/private-tx', '--output', '/a']), /ranges/);
  assert.throws(() => parseGlobalCaptureArgs(['--runtime', '/opt/existing/prototype/private-tx', '--output', '/a', '--receipt', '/a', '--range', '0:0']), /distinct/);
});

test('CLI writes only complete captures using exclusive private files, with aggregate-only stdout result', async t => {
  const path = await directory(t), value = sample([range(100), range(200)]);
  const output = resolve(path, 'source.json'), receipt = resolve(path, 'receipt.json'), anchors = resolve(path, 'anchors.json');
  const args = ['--runtime', '/opt/existing/prototype/private-tx', '--output', output,
    '--receipt', receipt, '--anchors', anchors, '--range', '100:100', '--range', '200:200'];
  const result = await runGlobalCaptureCli(args, value.dependencies);
  const raw = await readFile(output); const source = JSON.parse(raw); const savedReceipt = JSON.parse(await readFile(receipt));
  assert.equal(result.sourceRawFileSha256, sha(raw)); assert.equal(savedReceipt.hashes.sourceRawFileSha256, sha(raw));
  assert.equal(source.records.length, 2); assert.equal(JSON.parse(await readFile(anchors)).length, 4);
  for (const file of [output, receipt, anchors]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const record of source.records) assert.equal(JSON.stringify(result).includes(record.txid), false);
  assert.equal(JSON.stringify(result).includes('synthetic-public-address'), false);
  await assert.rejects(runGlobalCaptureCli(args, value.dependencies), /already exists/);
  assert.equal(value.calls.capture.length, 2);
});

test('CLI refuses existing/symlink or nonprivate output locations before SQL and leaves no files on capture failure', async t => {
  const path = await directory(t), value = sample([range(100)]);
  const output = resolve(path, 'source.json');
  const args = ['--runtime', '/opt/existing/prototype/private-tx', '--output', output, '--range', '100:100'];
  await writeFile(output, 'preserved', { mode: 0o600 });
  await assert.rejects(runGlobalCaptureCli(args, value.dependencies), /already exists/); assert.equal(value.calls.capture.length, 0);
  assert.equal(await readFile(output, 'utf8'), 'preserved'); await rm(output);
  await symlink(resolve(path, 'missing'), output);
  await assert.rejects(runGlobalCaptureCli(args, value.dependencies), /already exists/); await rm(output);
  await chmod(path, 0o755);
  await assert.rejects(runGlobalCaptureCli(args, value.dependencies), /owned private/); assert.equal(value.calls.capture.length, 0);
  await chmod(path, 0o700);
  value.dependencies.rawFromLoopback = async () => { throw new Error('synthetic capture failure'); };
  await assert.rejects(runGlobalCaptureCli(args, value.dependencies), /synthetic capture failure/);
  assert.deepEqual(await readdir(path), []);
});
