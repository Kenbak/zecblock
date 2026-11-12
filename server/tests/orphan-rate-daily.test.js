const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDaily, parseDays, orphanRateDaily } = require('../api/lib/orphan-rate-daily');

const DAY = 86400;
const asOf = 20_000 * DAY + 3600; // one hour into "today"

function row(dayIndex, canonical, orphans, extra = {}) {
  const start = (20_000 - dayIndex) * DAY;
  return { day_start: start, day_end: start + DAY, as_of: asOf, canonical_blocks: canonical,
    orphaned_blocks: orphans, history_start: 0, capture_start: null, ...extra };
}

test('days parameter is bounded and defaults to 60', () => {
  assert.equal(parseDays(undefined), 60);
  assert.equal(parseDays('7'), 7);
  assert.equal(parseDays('90'), 90);
  for (const bad of ['6', '91', '1.5', 'abc', '-7']) assert.equal(parseDays(bad), null, bad);
});

test('rates use canonical plus observed orphans; today is partial; no history means no rate', () => {
  const out = formatDaily([row(1, 1000, 10), row(0, 40, 0)]);
  assert.deepEqual(out.days.map(d => [d.canonicalBlocks, d.orphanedBlocks, d.partial]), [[1000, 10, false], [40, 0, true]]);
  assert.equal(out.days[0].rate, 10 / 1010);
  assert.equal(out.days[1].rate, 0, 'observed zero stays zero');
  const early = formatDaily([row(1, 1000, 10, { history_start: asOf })]);
  assert.equal(early.days[0].rate, null);
  assert.equal(formatDaily([row(0, 0, 0)]).days[0].rate, null, 'no canonical blocks, no rate');
});

test('events stay inside the charted range and NU7 appears only once activated', () => {
  const capture = (20_000 - 1) * DAY + 100;
  const out = formatDaily([row(1, 10, 0, { capture_start: capture }), row(0, 10, 0, { capture_start: capture })],
    { nu7Timestamp: 20_000 * DAY + 60 });
  assert.deepEqual(out.events.map(e => e.kind), ['capture', 'nu7']);
  assert.ok(!formatDaily([row(0, 1, 0)]).events.some(e => e.kind === 'nu7'));
});

test('real PostgreSQL: same orphan definition as the rate cards', {
  skip: process.env.ORPHAN_RATES_POSTGRES !== '1' && !process.env.MINING_TEST_DATABASE_URL,
}, async t => {
  const { Client } = require('pg');
  const db = new Client(process.env.MINING_TEST_DATABASE_URL
    ? { connectionString: process.env.MINING_TEST_DATABASE_URL }
    : { host: '/tmp', database: 'postgres' });
  await db.connect();
  t.after(async () => { await db.query('ROLLBACK'); await db.end(); });
  await db.query(`BEGIN;
    CREATE TEMP TABLE blocks(height bigint, hash text UNIQUE, timestamp bigint, miner_address text, coinbase_hex text);
    CREATE TEMP TABLE captured_blocks(hash text PRIMARY KEY, height bigint, timestamp bigint, miner_address text, coinbase_hex text);
    CREATE TEMP TABLE block_capture_observers(observer text, network text, collection_started_at timestamptz, heartbeat_at timestamptz, stream_connected boolean, pending_records integer);
    CREATE TEMP TABLE orphaned_blocks(hash text UNIQUE, timestamp bigint, miner_address text, coinbase_hex text, source text, consensus_valid boolean);
    INSERT INTO blocks(height,hash,timestamp) SELECT i, 'c'||i, (floor(extract(epoch FROM now()))::bigint / 86400) * 86400 - 86400 * d + 600
    FROM (VALUES (1,0),(2,0),(3,1),(4,1),(5,1),(6,20)) v(i,d);
    INSERT INTO orphaned_blocks VALUES
      ('reorged', (floor(extract(epoch FROM now()))::bigint / 86400) * 86400 - 86400 + 60, null, null, 'indexer', null),
      ('invalid', (floor(extract(epoch FROM now()))::bigint / 86400) * 86400 - 86400 + 60, null, null, 'indexer', false),
      ('external', (floor(extract(epoch FROM now()))::bigint / 86400) * 86400 + 60, null, null, 'external', true);
    INSERT INTO captured_blocks VALUES
      ('competitor', 2, (floor(extract(epoch FROM now()))::bigint / 86400) * 86400 + 60, null, null),
      ('reorged', 3, (floor(extract(epoch FROM now()))::bigint / 86400) * 86400 - 86400 + 60, null, null),
      ('c4', 4, (floor(extract(epoch FROM now()))::bigint / 86400) * 86400 - 86400 + 60, null, null),
      ('ahead', 999, (floor(extract(epoch FROM now()))::bigint / 86400) * 86400 + 60, null, null);
    INSERT INTO block_capture_observers VALUES ('local-node','mainnet', now() - interval '3 days', now(), true, 0);`);
  const out = await orphanRateDaily(db, { days: 7 });
  assert.equal(out.days.length, 7);
  const [yesterday, today] = out.days.slice(-2);
  assert.deepEqual([yesterday.canonicalBlocks, yesterday.orphanedBlocks], [3, 1], 'archive+capture deduped; invalid and canonical excluded');
  assert.deepEqual([today.canonicalBlocks, today.orphanedBlocks], [2, 1], 'capture counted; external report and unindexed height excluded');
  assert.equal(today.partial, true);
  assert.ok(out.events.some(e => e.kind === 'capture'));
});
