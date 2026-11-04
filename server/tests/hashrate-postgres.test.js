const test = require('node:test');
const assert = require('node:assert/strict');
const { workCtes, loadHashrateSnapshot, loadHashrateHistory } = require('../api/lib/hashrate');
const connectionString = process.env.HASHRATE_TEST_DATABASE_URL;
const DAY = 86400;
function referenceProof(bits) {
  if (!/^[0-9a-f]{8}$/i.test(bits ?? '')) return null;
  const n = BigInt(`0x${bits}`), size = n >> 24n, mantissa = n & 0x7fffffn;
  if (n & 0x800000n || !mantissa || size > 34n) return null;
  const target = size <= 3n ? mantissa >> (8n * (3n - size)) : mantissa << (8n * (size - 3n));
  return target > 0n && target < (1n << 256n) ? ((1n << 256n) / (target + 1n)).toString() : null;
}

test('PostgreSQL history fast path is exact for compact-target boundaries and deterministic random targets', { skip: !connectionString }, async () => {
  const { Client } = require('pg');
  const db = new Client({ connectionString }); await db.connect();
  try {
    await db.query('BEGIN; CREATE TEMP TABLE blocks (height bigint PRIMARY KEY, hash text, timestamp bigint, bits text) ON COMMIT DROP;');
    const fixtures = ['zzzzzzzz', '2007fff', '2007ffff0', '', null];
    for (let exponent = 0; exponent <= 36; exponent++) {
      for (const mantissa of [0, 1, 2, 255, 256, 65535, 65536, 0x7fffff, 0x800000, 0xffffff]) {
        const bits = ((BigInt(exponent) << 24n) | BigInt(mantissa)).toString(16).padStart(8, '0');
        fixtures.push(bits, bits.toUpperCase());
      }
    }
    let seed = 0x6b47c931;
    for (let exponent = 28; exponent <= 34; exponent++) {
      const maximum = exponent === 34 ? 255 : exponent === 33 ? 65535 : 0x7fffff;
      for (let i = 0; i < 1024; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const mantissa = 1 + seed % maximum;
        const bits = ((BigInt(exponent) << 24n) | BigInt(mantissa)).toString(16);
        fixtures.push(i % 2 ? bits : bits.toUpperCase());
      }
    }
    await db.query("INSERT INTO blocks SELECT ordinality, ordinality::text, ordinality, bits FROM unnest($1::text[]) WITH ORDINALITY AS fixture(bits, ordinality)", [fixtures]);
    const readProofs = async options => (await db.query(`WITH ${workCtes('true', options)} SELECT proof::text FROM work ORDER BY timestamp`)).rows.map(row => row.proof);
    const legacy = await readProofs();
    const fast = await readProofs({ fastLargeTargets: true });
    assert.deepEqual(legacy, fixtures.map(referenceProof));
    assert.deepEqual(fast, legacy, 'the SQL fast path must preserve every exact proof and invalid-target null');
  } finally { await db.query('ROLLBACK'); await db.end(); }
});

test('PostgreSQL fast history remains byte-equivalent to legacy daily and seven-day histories', { skip: !connectionString }, async () => {
  const { Client } = require('pg');
  const db = new Client({ connectionString }); await db.connect();
  try {
    await db.query('BEGIN; CREATE TEMP TABLE blocks (height bigint PRIMARY KEY, hash text, timestamp bigint, bits text) ON COMMIT DROP;');
    const midnight = Number((await db.query('SELECT (floor(extract(epoch FROM now()) / 86400) * 86400)::bigint AS at')).rows[0].at);
    let height = 0;
    for (let day = 45; day >= 1; day--) {
      for (const bits of ['207fffff', '1C009E0A', '2100ffff', '220000ff', day === 15 ? null : '1b741ecd']) {
        await db.query('INSERT INTO blocks VALUES ($1,$2,$3,$4)', [++height, String(height), midnight - day * DAY + height % 100, bits]);
      }
    }
    const where = 'timestamp >= $1 AND timestamp < $2';
    const fast = workCtes(where, { fastLargeTargets: true });
    const legacy = workCtes(where);
    const fastBucket = 'timestamp - ((timestamp % 86400 + 86400) % 86400)';
    const legacyBucket = '(floor(timestamp::numeric / 86400) * 86400)::bigint';
    const referenceDb = { query: (sql, values) => db.query(sql.replace(fast, () => legacy).replace(fastBucket, () => legacyBucket), values) };
    const bucketRows = await db.query(`SELECT (${fastBucket})::text AS fast, (${legacyBucket})::text AS legacy
      FROM unnest($1::bigint[]) AS boundary(timestamp)`, [[-172801, -172800, -86401, -86400, -86399, -1, 0, 1, 86399, 86400, 172799, 4294967295, '9223372036854775807']]);
    assert.ok(bucketRows.rows.every(row => row.fast === row.legacy), 'integer UTC bucketing must preserve floor semantics across negative boundaries and large timestamps');
    for (const period of ['7d', '30d', 'all']) {
      for (const window of ['24h', '7d']) {
        const actual = await loadHashrateHistory(db, period, window);
        const reference = await loadHashrateHistory(referenceDb, period, window);
        assert.equal(JSON.stringify(actual), JSON.stringify(reference), `${period}/${window}`);
      }
    }
    await db.query("UPDATE blocks SET bits='203fffff', hash='canonical-replacement' WHERE height=200");
    assert.equal(JSON.stringify(await loadHashrateHistory(db, 'all', '7d')), JSON.stringify(await loadHashrateHistory(referenceDb, 'all', '7d')));
  } finally { await db.query('ROLLBACK'); await db.end(); }
});

test('actual PostgreSQL target decoding, fixed windows, history and canonical replacement', { skip: !connectionString }, async () => {
  const { Client } = require('pg');
  const db = new Client({ connectionString }); await db.connect();
  try {
    await db.query('BEGIN; CREATE TEMP TABLE blocks (height bigint PRIMARY KEY, hash text, timestamp bigint, bits text) ON COMMIT DROP;');
    const fixtures = ['207fffff', '203fffff', '1c009e0a', '1b741ecd', '03008000', '02008000', '01010000', '01003456', '00000001', '1c809e0a', '220000ff', '22000100', '2100ffff', '21010000', '23000001', 'zzzzzzzz', null];
    for (let i = 0; i < fixtures.length; i++) await db.query('INSERT INTO blocks VALUES ($1,$2,$3,$4)', [i, String(i), i, fixtures[i]]);
    const proofRows = await db.query(`WITH ${workCtes('true')} SELECT timestamp, proof::text FROM work ORDER BY timestamp`);
    assert.deepEqual(proofRows.rows.map(r => r.proof), fixtures.map(referenceProof));
    await db.query('TRUNCATE blocks');
    const now = Number((await db.query('SELECT floor(extract(epoch FROM now()))::bigint AS at')).rows[0].at);
    const put = (height, timestamp, bits = '207fffff') => db.query('INSERT INTO blocks VALUES ($1,$2,$3,$4)', [height, String(height), timestamp, bits]);
    await put(0, now - 8 * DAY);
    await put(1, now - DAY - 1, '203fffff'); // outside 24h, inside 7d
    await put(2, now - DAY); // exact lower bound included
    await put(3, now - 1, '203fffff');
    await put(4, now); // exact upper bound excluded
    await put(5, now + 1); // future timestamp excluded
    const current = await loadHashrateSnapshot(db);
    assert.equal(current.windows['24h'].expectedWork, '6');
    assert.equal(current.windows['24h'].hashrate, 6 / DAY);
    assert.equal(current.windows['7d'].expectedWork, '10');
    assert.equal(current.asOf, current.windows['24h'].windowEnd);
    await db.query("UPDATE blocks SET hash='replacement', bits='207fffff' WHERE height=3");
    assert.equal((await loadHashrateSnapshot(db)).windows['24h'].expectedWork, '4');
    await db.query('UPDATE blocks SET bits=NULL WHERE height=3');
    assert.equal((await loadHashrateSnapshot(db)).windows['24h'].unavailableReason, 'missing-targets');
    await db.query('TRUNCATE blocks');
    const midnight = Math.floor(now / DAY) * DAY;
    await put(0, midnight - 40 * DAY);
    for (let i = 1; i <= 31; i++) {
      await put(i * 2, midnight - i * DAY);
      await put(i * 2 + 1, midnight - i * DAY + 1, '203fffff');
    }
    const history = await loadHashrateHistory(db, '30d', '24h');
    assert.equal(history.points.length, 30);
    assert.ok(history.points.every(p => p.hashrate === 6 / DAY));
    assert.equal(history.points.at(-1).windowEnd, new Date(midnight * 1000).toISOString());
    const weekly = await loadHashrateHistory(db, '30d', '7d');
    assert.equal(weekly.points.at(-1).expectedWork, '42');
    // Invalid early-chain coverage must never use a 75-second fallback.
    await db.query('DELETE FROM blocks WHERE height=0');
    const all = await loadHashrateHistory(db, 'all', '7d');
    assert.ok(all.points.length < 30);
    // Exercise the public routes with real work SQL; unrelated RPC/stats are stubbed.
    await put(500, now - 2); await put(501, now - 1, '203fffff');
    const express = require('express'); const app = express();
    app.locals.pool = { query: (sql, args) => sql.includes('WITH latest AS')
      ? Promise.resolve({ rows: [{ height: 501, timestamp: now - 1, difficulty: 999999, blocks_24h: 2, rolling_block_time_secs: 75 }] })
      : db.query(sql, args) };
    app.locals.callZebraRPC = async () => null;
    app.use(require('../api/routes/network'));
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const stats = await (await fetch(`${base}/api/network/stats`)).json();
      assert.equal(stats.mining.networkHashrateRaw, stats.mining.hashrateEstimate.windows['24h'].hashrate);
      assert.equal(stats.mining.hashrateEstimate.windows['24h'].method, 'target-work-v1');
      assert.notEqual(stats.mining.networkHashrateRaw, 999999 * 8192 / 75);
      const weeklyResponse = await fetch(`${base}/api/network/hashrate-history?period=30d&window=7d`);
      assert.equal(weeklyResponse.status, 200);
      assert.equal((await weeklyResponse.json()).window, '7d');
      assert.equal((await fetch(`${base}/api/network/hashrate-history?period=30d&window=bad`)).status, 400);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  } finally { await db.query('ROLLBACK'); await db.end(); }
});
