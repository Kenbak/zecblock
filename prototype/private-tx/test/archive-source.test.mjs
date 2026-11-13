import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureRequest, headerGuardSql, canonicalHeaders, archiveSourceTick, MAX_GUARD_HEIGHTS } from '../pilot/archive-source.mjs';
import { buildPrimarySnapshotSql, decodePrimarySnapshot, MAINNET_GENESIS_HASH, PRIMARY_SNAPSHOT_SCHEMA } from '../primary-source.mjs';
import { collectionManifest } from '../collection.mjs';
import { verifyGuard } from '../pilot/source-guard.mjs';

const id = number => number.toString(16).padStart(64, '0');
const blockHash = height => id(1000 + height);
const GiB = 1024 ** 3;
const request = (startHeight = 10, endHeight = 11) => ({ schema: 'zecblock-private-capture-request-v1', startHeight, endHeight });

function headerValue(heights, { tip = 12 } = {}) {
  return { schema: 'zecblock-private-header-guard-v1', network: 'mainnet', database: 'zcash_explorer_mainnet',
    isPrimary: true, readOnly: true, genesisHash: MAINNET_GENESIS_HASH, observedAt: new Date().toISOString(),
    tip: { height: tip, hash: blockHash(tip) }, blocks: heights.map(height => ({ height, hash: blockHash(height) })) };
}

function primary(startHeight = 10, endHeight = 11, tip = 12) {
  const blocks = Array.from({ length: endHeight - startHeight + 1 }, (_, index) => {
    const height = startHeight + index;
    return { height: String(height), hash: blockHash(height), previous_block_hash: blockHash(height - 1),
      timestamp: String(1793620800 + height), transaction_count: '1' };
  });
  return { schema: PRIMARY_SNAPSHOT_SCHEMA, network: 'mainnet', database: 'zcash_explorer_mainnet', isPrimary: true, readOnly: true,
    genesisHash: MAINNET_GENESIS_HASH, observedAt: new Date().toISOString(), snapshotId: '100:100:',
    limits: { maxBlocks: 128, maxRecords: 2048, maxIoRows: 200_000 },
    coverage: { startHeight, endHeight }, tip: { height: tip, hash: blockHash(tip) }, blocks,
    transactions: blocks.map(block => ({ txid: id(Number(block.height)), block_height: block.height, block_hash: block.hash,
      block_time: block.timestamp, tx_index: '0', vin_count: '1', vout_count: '1', is_coinbase: 'true' })), inputs: [],
    outputs: blocks.map(block => ({ txid: id(Number(block.height)), vout_index: '0', value: '9007199254740993', address: null, spent: 'false' })) };
}

function archivedCollection() {
  const manifest = { schema: 'zecblock-private-tx-full-v1', publicationId: id(900), network: 'mainnet', packing: 'compact-v1',
    coverRow: 2047, geometry: 'full-2k-8k', rows: 2048, rowBytes: 8192, chunkCount: 1,
    scheme: { request_bytes: 20992, response_bytes: 10240, public_bytes: 45056 },
    snapshot: { height: 5, hash: blockHash(5), publishedAt: new Date().toISOString() },
    coverage: { startHeight: 1, endHeight: 2, blocks: [1, 2].map(height => ({ height, hash: blockHash(height), transactionCount: 1 })) },
    catalogue: [1, 2].map((height, index) => ({ txid: id(height), height, rows: [index], recordBytes: 1, recordSha256: id(800 + index) })) };
  return collectionManifest({ segments: [{ publicationId: manifest.publicationId, manifest }] });
}

async function fixture(t, { collection = true, control = request() } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'pir-archive-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = resolve(root, 'source'), localDir = resolve(root, 'control');
  await mkdir(sourceDir); await mkdir(localDir);
  await writeFile(resolve(localDir, 'capture-request.json'), JSON.stringify(control));
  const existing = collection ? archivedCollection() : undefined;
  if (existing) await writeFile(resolve(localDir, 'collection.json'), JSON.stringify(existing));
  const calls = [], captures = [];
  const options = { sourceDir, localDir,
    headers: async heights => { calls.push(heights); return canonicalHeaders(heights, { read: async () => headerValue(heights) }); },
    capture: async config => { captures.push(config); return primary(config.startHeight, config.endHeight); },
    statfsFn: async () => ({ bavail: 2, bsize: GiB }) };
  return { root, sourceDir, localDir, existing, calls, captures, options,
    tick: override => archiveSourceTick({ ...options, ...override }) };
}

test('header and payload SQL bind bounded values separately from fixed read-only statements', () => {
  const sql = headerGuardSql([0, 10, 12]);
  assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /jsonb_array_elements_text\(\$1::jsonb\)/);
  assert.match(sql, /statement_timeout='3s'/);
  assert.match(sql, /lock_timeout='200ms'/);
  assert.match(sql, /work_mem='8MB'/);
  const lines = sql.split('\n');
  assert.ok(lines.includes("\\bind '[0,10,12]'"));
  assert.ok(lines.includes('\\g'));
  assert.ok(lines.filter(line => line.startsWith('\\')).every(line => !line.startsWith('\\\\')));
  assert.match(sql, /ROLLBACK;\n$/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE)\b/i);
  for (const heights of [[1, 1], [-1], [1.5], ['1);DROP TABLE blocks'], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: MAX_GUARD_HEIGHTS + 1 }, (_, n) => n)]) {
    assert.throws(() => headerGuardSql(heights), /bound/);
  }
  assert.doesNotThrow(() => headerGuardSql([]));
  assert.doesNotThrow(() => headerGuardSql(Array.from({ length: MAX_GUARD_HEIGHTS }, (_, n) => n)));
  const payload = buildPrimarySnapshotSql({ startHeight: 10, endHeight: 11, maxBlocks: 128, maxRecords: 2048 });
  assert.match(payload, /SELECT \$1::bigint AS start_height/);
  assert.match(payload, /LIMIT \$4::integer/);
  assert.ok(payload.split('\n').includes('\\bind 10 11 true 129 2049 200001 128 2048 200000'));
  assert.ok(buildPrimarySnapshotSql({ startHeight: 0 }).split('\n').includes('\\bind 0 0 false 17 2049 200001 16 2048 200000'));
});

test('capture requests have stable commitments and reject unbounded or unexpected input types', () => {
  assert.equal(captureRequest(request()).requestId, captureRequest({ endHeight: 11, startHeight: 10, schema: request().schema }).requestId);
  assert.notEqual(captureRequest(request()).requestId, captureRequest(request(10, 12)).requestId);
  for (const value of [{ ...request(), startHeight: -1 }, { ...request(), startHeight: '10' }, { ...request(), endHeight: 9 },
    { ...request(), startHeight: Number.MAX_SAFE_INTEGER + 1 }, { ...request(), arbitrarySql: 'SELECT 1' }, { ...request(), schema: 'other' }]) assert.throws(() => captureRequest(value));
});

test('canonical header replies pin primary/mainnet/genesis and reject duplicate or unsolicited rows', async () => {
  let responseBound;
  await canonicalHeaders([1], { read: async (_sql, options) => { responseBound = options.maxBytes; return headerValue([1]); } });
  assert.equal(responseBound, 512 * 1024);
  for (const mutate of [value => { value.isPrimary = false; }, value => { value.readOnly = false; }, value => { value.network = 'testnet'; },
    value => { value.database = 'other'; }, value => { value.genesisHash = id(0); }, value => { value.tip.hash = 'bad'; },
    value => { value.observedAt = 'invalid'; }, value => { value.blocks = [{ height: 9, hash: blockHash(9) }]; },
    value => { value.blocks.push({ ...value.blocks[0] }); }]) {
    const value = headerValue([1]); mutate(value);
    await assert.rejects(canonicalHeaders([1], { read: async () => value }));
  }
});

test('startup without a collection captures bounded data and publishes request-bound provenance', async t => {
  const box = await fixture(t, { collection: false, control: request(10, 10000) });
  const guard = await box.tick({ maxBlocks: 2 });
  assert.deepEqual(box.captures, [{ startHeight: 10, endHeight: 11, maxBlocks: 2, maxRecords: 2048 }]);
  assert.equal(guard.captureState, 'ready');
  assert.equal(guard.requestId, captureRequest(request(10, 10000)).requestId);
  const snapshot = JSON.parse(await readFile(resolve(box.sourceDir, 'latest.json'), 'utf8'));
  assert.equal(snapshot.requestId, guard.requestId); assert.equal(snapshot.fingerprint, guard.fingerprint);
  assert.deepEqual(box.calls, [[], [10, 11, 12]]);
  assert.equal((await stat(resolve(box.sourceDir, 'latest.json'))).mode & 0o777, 0o640);
});

test('new captures preserve every older archive block and snapshot anchor in the fresh guard', async t => {
  const box = await fixture(t);
  const guard = await box.tick();
  assert.deepEqual(box.calls, [[], [1, 2, 5, 10, 11, 12]]);
  assert.doesNotThrow(() => verifyGuard(guard, box.existing.segments[0].manifest));
  assert.equal(guard.tip.height, 12);
});

test('missing or changed old headers retire that view without retaining cached canonical hashes', async t => {
  for (const changed of [false, true]) {
    const box = await fixture(t, { control: request(20, 21) });
    const guard = await box.tick({ headers: async heights => {
      const value = headerValue(heights);
      value.blocks = changed ? value.blocks.map(block => block.height === 2 ? { ...block, hash: id(999) } : block) : value.blocks.filter(block => block.height !== 2);
      return canonicalHeaders(heights, { read: async () => value });
    } });
    assert.equal(guard.captureState, 'waiting');
    assert.throws(() => verifyGuard(guard, box.existing.segments[0].manifest), /canonical membership/);
    assert.notEqual(guard.blocks.find(block => block.height === 2)?.hash, blockHash(2));
  }
});

test('waiting requests do not reuse or relabel an earlier captured payload', async t => {
  const box = await fixture(t, { control: request(20, 21) });
  const old = '{"requestId":"previous","fingerprint":"previous"}';
  await writeFile(resolve(box.sourceDir, 'latest.json'), old);
  const guard = await box.tick();
  assert.equal(guard.state, 'ready'); assert.equal(guard.captureState, 'waiting'); assert.equal(guard.fingerprint, null);
  assert.equal(box.captures.length, 0);
  assert.equal(await readFile(resolve(box.sourceDir, 'latest.json'), 'utf8'), old);
  assert.doesNotThrow(() => verifyGuard(guard, box.existing.segments[0].manifest));
});

test('payload failure, capacity and exhausted disk reserve preserve healthy archive guards without advancing latest', async t => {
  for (const kind of ['unavailable', 'capacity', 'disk']) {
    const box = await fixture(t);
    await writeFile(resolve(box.sourceDir, 'latest.json'), '{"requestId":"previous"}');
    const guard = await box.tick(kind === 'disk' ? { statfsFn: async () => ({ bavail: 0, bsize: GiB }) } : {
      capture: async () => { const error = new Error('Injected capture failure'); if (kind === 'capacity') error.code = 'CAPACITY'; throw error; },
    });
    assert.equal(guard.state, 'ready');
    assert.equal(guard.captureState, kind === 'capacity' ? 'capacity-blocked' : 'unavailable');
    assert.equal(guard.fingerprint, null); assert.equal(guard.sourceObservedAt, null);
    assert.equal(await readFile(resolve(box.sourceDir, 'latest.json'), 'utf8'), '{"requestId":"previous"}');
    assert.deepEqual(box.calls, [[], [1, 2, 5]]);
    assert.doesNotThrow(() => verifyGuard(guard, box.existing.segments[0].manifest));
  }
});

test('a canonical change during capture cannot advance captured data or a ready guard', async t => {
  const box = await fixture(t);
  await writeFile(resolve(box.sourceDir, 'latest.json'), 'old');
  await assert.rejects(box.tick({ headers: async heights => {
    const value = headerValue(heights);
    value.blocks = value.blocks.map(block => block.height === 10 ? { ...block, hash: id(999) } : block);
    return value;
  } }), /changed during canonical guard/);
  assert.equal(await readFile(resolve(box.sourceDir, 'latest.json'), 'utf8'), 'old');
  await assert.rejects(readFile(resolve(box.sourceDir, 'guard.json')), { code: 'ENOENT' });
});

test('control file size, symlink and invalid block bounds fail before source access', async t => {
  for (const kind of ['oversize-request', 'oversize-collection', 'symlink-request', 'block-bound']) {
    const box = await fixture(t);
    if (kind === 'oversize-request') await writeFile(resolve(box.localDir, 'capture-request.json'), Buffer.alloc(1025, 32));
    if (kind === 'oversize-collection') await writeFile(resolve(box.localDir, 'collection.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    if (kind === 'symlink-request') {
      const outside = resolve(box.root, 'outside-request.json'); await writeFile(outside, JSON.stringify(request()));
      await rm(resolve(box.localDir, 'capture-request.json')); await symlink(outside, resolve(box.localDir, 'capture-request.json'));
    }
    await assert.rejects(box.tick(kind === 'block-bound' ? { maxBlocks: 129 } : {}));
    assert.equal(box.calls.length, 0); assert.equal(box.captures.length, 0);
  }
});

test('header unavailability never reuses cached hashes or advances payload and eventually retires a prior guard', async t => {
  const box = await fixture(t);
  const initial = await box.tick();
  const previous = await readFile(resolve(box.sourceDir, 'latest.json'));
  let calls = 0;
  await assert.rejects(box.tick({ headers: async heights => {
    if (++calls === 2) throw new Error('Primary header connection unavailable');
    return headerValue(heights);
  } }), /header connection unavailable/);
  assert.deepEqual(await readFile(resolve(box.sourceDir, 'latest.json')), previous);
  assert.throws(() => verifyGuard(initial, box.existing.segments[0].manifest, { now: Date.parse(initial.observedAt) + 10_001 }), /unavailable or stale/);
});

// Optional real extended-protocol acceptance. The container is created and
// removed by the operator; a strict disposable label/resource gate prevents
// this test from accepting an arbitrary PostgreSQL or production connection.
test('disposable PostgreSQL16 executes actual psql bind capture and header statements', { skip: !process.env.PIR_ARCHIVE_PG16_CONTAINER }, async () => {
  const docker = process.env.PIR_ARCHIVE_DOCKER ?? '/Applications/Docker.app/Contents/Resources/bin/docker';
  const container = process.env.PIR_ARCHIVE_PG16_CONTAINER;
  assert.match(container, /^pir-archive-source-[a-z0-9-]+$/);
  const run = (args, input) => {
    const result = spawnSync(docker, args, { input, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout.trim();
  };
  const inspected = JSON.parse(run(['inspect', container]))[0];
  assert.equal(inspected.Config.Labels?.['zecblock.pir.fixture'], 'archive-source-pg16');
  assert.ok(inspected.HostConfig.Memory > 0 && inspected.HostConfig.Memory <= 512 * 1024 * 1024);
  const sql = value => run(['exec', '-i', '--user', 'postgres', container, 'psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-d', 'zcash_explorer_mainnet'], value);
  assert.match(sql('SHOW server_version_num;'), /^16\d{4}$/);
  assert.equal(sql("SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('blocks','transactions','transaction_inputs','transaction_outputs');"), '0');
  sql(`CREATE TABLE blocks(height bigint PRIMARY KEY,hash text,previous_block_hash text,timestamp bigint,transaction_count integer);
CREATE TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_hash text,block_time bigint,tx_index integer,vin_count integer,vout_count integer,is_coinbase boolean,total_output bigint);
CREATE TABLE transaction_inputs(txid text,vout_index integer,value bigint,PRIMARY KEY(txid,vout_index));
CREATE TABLE transaction_outputs(txid text,vout_index integer,value bigint,address text,spent boolean,PRIMARY KEY(txid,vout_index));
INSERT INTO blocks VALUES(0,'${MAINNET_GENESIS_HASH}','${id(0)}',0,1);
${[10, 11, 12].map(height => `INSERT INTO blocks VALUES(${height},'${blockHash(height)}','${blockHash(height - 1)}',${1793620800 + height},1);
INSERT INTO transactions VALUES('${id(height)}',${height},'${blockHash(height)}',${1793620800 + height},0,1,1,true,9007199254740993);
INSERT INTO transaction_outputs VALUES('${id(height)}',0,9007199254740993,NULL,false);`).join('\n')}`);
  const captured = decodePrimarySnapshot(sql(buildPrimarySnapshotSql({ startHeight: 10, endHeight: 11, maxBlocks: 128 })));
  assert.equal(captured.tip.height, 12); assert.equal(captured.outputs[0].value, '9007199254740993'); assert.equal(captured.outputs[0].address, null);
  const headers = await canonicalHeaders([0, 10, 12, 999], { read: async statement => JSON.parse(sql(statement)) });
  assert.deepEqual(headers.blocks.map(block => block.height), [0, 10, 12]);
  const empty = await canonicalHeaders([], { read: async statement => JSON.parse(sql(statement)) });
  assert.deepEqual(empty.blocks, []); assert.equal(empty.tip.height, 12);
});
