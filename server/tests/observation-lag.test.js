const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { formatObservationLag, observationLag, MIN_SAMPLE } = require('../api/lib/observation-lag');
const { firstSeenSql, firstSeenLateralSql } = require('../api/lib/first-seen');

function fixture(patch = {}) {
  return ['24h', '7d', '30d'].flatMap(period => [
    { period, window_start: 1000000, window_end: 4000000, pool: null, is_total: 1, blocks: '120', observed: '100', median_ms: 12340, p90_ms: 40000, header_after_seen: '3', collection_start: new Date('2026-09-20T00:00:00Z'), ...patch },
    { period, window_start: 1000000, window_end: 4000000, pool: 'ViaBTC', is_total: 0, blocks: '110', observed: '95', median_ms: 12000, p90_ms: 39000, header_after_seen: '3', collection_start: null, ...patch },
    { period, window_start: 1000000, window_end: 4000000, pool: 'Unknown', is_total: 0, blocks: '10', observed: '5', median_ms: 9000, p90_ms: 9000, header_after_seen: '0', collection_start: null, ...patch },
  ]);
}

test('formats seconds, keeps unobserved blocks in the denominator and withholds small-sample percentiles', () => {
  const data = formatObservationLag(fixture());
  assert.equal(data.periods.length, 3);
  const window = data.periods[0];
  assert.deepEqual([window.blocks, window.observed, window.medianSeconds, window.p90Seconds, window.headerAfterSeen], [120, 100, 12.3, 40, 3]);
  assert.equal(window.pools[0].name, 'ViaBTC');
  const unknown = window.pools.find(pool => pool.name === 'Unknown');
  assert.ok(unknown.observed < MIN_SAMPLE);
  assert.equal(unknown.medianSeconds, null);
  assert.equal(unknown.p90Seconds, null);
  assert.equal(unknown.blocks, 10);
  assert.equal(window.pools.reduce((n, pool) => n + pool.blocks, 0), window.blocks);
});

test('an empty window is zero blocks, not an error or a pool row', () => {
  const rows = fixture().filter(row => row.period !== '24h');
  rows.push({ period: '24h', window_start: 1000000, window_end: 4000000, pool: null, is_total: null, blocks: null, observed: null, median_ms: null, p90_ms: null, header_after_seen: null, collection_start: null });
  const window = formatObservationLag(rows).periods.find(p => p.period === '24h');
  assert.deepEqual([window.blocks, window.observed, window.medianSeconds, window.pools.length], [0, 0, null, 0]);
  assert.throws(() => formatObservationLag([]));
  assert.throws(() => formatObservationLag(fixture().filter(row => row.period !== '7d')));
  assert.throws(() => formatObservationLag(fixture({ blocks: '-1' })));
});

test('public route fails closed without leaking database errors', async t => {
  const app = express();
  let fail = false;
  app.locals.pool = { query: async () => { if (fail) throw new Error('private connection details'); return { rows: fixture() }; } };
  app.use(require('../api/routes/mining'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/mining/observation-lag`;
  let response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  assert.equal((await response.json()).periods.length, 3);
  fail = true;
  response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error, 'Observation lag unavailable');
});

test('real PostgreSQL: per-pool percentiles, negative lag, unobserved blocks and window boundaries', {
  skip: process.env.OBSERVATION_LAG_POSTGRES !== '1' && !process.env.MINING_TEST_DATABASE_URL,
}, async t => {
  const { Client } = require('pg');
  const db = new Client(process.env.MINING_TEST_DATABASE_URL
    ? { connectionString: process.env.MINING_TEST_DATABASE_URL }
    : { host: '/tmp', database: 'postgres' });
  await db.connect();
  t.after(async () => { await db.query('ROLLBACK'); await db.end(); });
  const viaBTC = 't1MKn34KBa8Xh4g8qU8psibBXvURafphVn7';
  await db.query(`BEGIN;
    CREATE TEMP TABLE blocks(height bigint, hash text UNIQUE, timestamp bigint, miner_address text, coinbase_hex text);
    CREATE TEMP TABLE block_observations(hash text PRIMARY KEY, first_seen_at timestamptz NOT NULL, source text NOT NULL DEFAULT 'local-node-rpc', poll_interval_ms integer DEFAULT 1000);
    CREATE TEMP TABLE captured_blocks(hash text PRIMARY KEY, first_seen_at timestamptz NOT NULL);
    -- 20 ViaBTC blocks in the last hour with lags 1..20s, one header 5s ahead.
    INSERT INTO blocks SELECT i, 'v'||i, floor(extract(epoch FROM now()))::bigint - 3600 + i*60, '${viaBTC}', NULL FROM generate_series(1,20) i;
    INSERT INTO block_observations SELECT 'v'||i, to_timestamp(floor(extract(epoch FROM now())) - 3600 + i*60 + i) FROM generate_series(1,20) i;
    INSERT INTO blocks VALUES (21, 'ahead', floor(extract(epoch FROM now()))::bigint - 600, '${viaBTC}', NULL);
    INSERT INTO block_observations VALUES ('ahead', to_timestamp(floor(extract(epoch FROM now())) - 605));
    -- Stream receipt earlier than the tip poll wins (v20: 20s poll, 2s stream).
    INSERT INTO captured_blocks VALUES ('v20', to_timestamp(floor(extract(epoch FROM now())) - 3600 + 20*60 + 2));
    -- Reorg replacement seen only by the stream: 7s.
    INSERT INTO blocks VALUES (24, 'stream-only', floor(extract(epoch FROM now()))::bigint - 900, '${viaBTC}', NULL);
    INSERT INTO captured_blocks VALUES ('stream-only', to_timestamp(floor(extract(epoch FROM now())) - 893));
    -- Unattributed and unobserved.
    INSERT INTO blocks VALUES (22, 'u1', floor(extract(epoch FROM now()))::bigint - 300, NULL, NULL);
    -- Outside 24h, inside 7d.
    INSERT INTO blocks VALUES (23, 'old', floor(extract(epoch FROM now()))::bigint - 3*86400, '${viaBTC}', NULL);
    INSERT INTO block_observations VALUES ('old', to_timestamp(floor(extract(epoch FROM now())) - 3*86400 + 500));`);
  const data = await observationLag(db);
  const day = data.periods.find(p => p.period === '24h');
  assert.deepEqual([day.blocks, day.observed, day.headerAfterSeen], [23, 22, 1]);
  const via = day.pools.find(p => p.name === 'ViaBTC');
  assert.deepEqual([via.blocks, via.observed], [22, 22]);
  // Lags 1..19, 2 (stream beat the 20s poll), 7 (stream only) and -5: median of 22 = (8+9)/2.
  assert.equal(via.medianSeconds, 8.5);
  assert.equal(day.pools.find(p => p.name === 'Unknown').observed, 0);
  const week = data.periods.find(p => p.period === '7d');
  assert.deepEqual([week.blocks, week.observed], [24, 23]);
  assert.ok(data.collectionStart);
  // Block and reorg APIs: earliest receipt, its source, and NULL when neither collector saw the block.
  const rows = (await db.query(`SELECT b.hash, extract(epoch FROM ${firstSeenSql('b.hash')}) - b.timestamp AS lag,
      f.source, f.poll_interval_ms FROM blocks b LEFT JOIN ${firstSeenLateralSql('b.hash')} f ON true
      WHERE b.hash IN ('v19','v20','stream-only','u1') ORDER BY b.hash`)).rows;
  assert.deepEqual(rows.map(r => [r.hash, r.lag == null ? null : Number(r.lag), r.source ?? null]),
    [['stream-only', 7, 'node-block-stream'], ['u1', null, null], ['v19', 19, 'local-node-rpc'], ['v20', 2, 'node-block-stream']]);
  assert.throws(() => firstSeenSql('hash; DROP TABLE blocks'));
});
