'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const ps = require('../lib/pool-sources');

const MIGRATION = fs.readFileSync(path.join(__dirname, '../deploy/migrations/048_shielded_pool_sources.sql'), 'utf8');
const MINER = 't1MKn34KBa8Xh4g8qU8psibBXvURafphVn7';
const BINANCE = 't1SzbuFRuPa5upV6c9ZgKb9V7fxn2b8NAKg';
const USER = 't1ejN4MbrPtM8TSJ1aaj1aXnoaANFUZt3hv';
const D1 = Date.parse('2026-11-24T10:00:00Z') / 1000;
const D2 = Date.parse('2026-11-25T10:00:00Z') / 1000;
const NOW = Date.parse('2026-11-26T12:00:00Z');

async function withDatabase(fn) {
  const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
  const admin = new Pool(connection ? { connectionString: connection } : { host: '/tmp', database: 'postgres' });
  const name = `pool_sources_${process.pid}_${Date.now()}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = connection ? new URL(connection) : null; if (url) url.pathname = `/${name}`;
    db = new Pool({ ...(url ? { connectionString: url.toString() } : { host: '/tmp', database: name }), max: 3 });
    await fn(db);
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  }
}

const SCHEMA = `CREATE TABLE blocks(height bigint PRIMARY KEY, hash text NOT NULL, timestamp bigint NOT NULL, miner_address text);
  CREATE TABLE transactions(txid text PRIMARY KEY, block_height bigint NOT NULL, block_hash text NOT NULL, block_time bigint NOT NULL,
    is_coinbase boolean DEFAULT false, fee bigint DEFAULT 0, vin_count integer DEFAULT 0, vout_count integer DEFAULT 0,
    value_balance_sprout bigint DEFAULT 0, value_balance_sapling bigint DEFAULT 0, value_balance_orchard bigint DEFAULT 0, value_balance_ironwood bigint DEFAULT 0);
  CREATE TABLE transaction_inputs(txid text, vout_index int, prev_txid text, prev_vout int, address text, value bigint, PRIMARY KEY(txid, vout_index));
  CREATE TABLE transaction_outputs(txid text, vout_index int, address text, value bigint, PRIMARY KEY(txid, vout_index));
  CREATE TABLE address_labels(address text PRIMARY KEY, label text, category text);`;

function chain(db) {
  const block = (height, time, { hash = `h${height}`, miner = MINER } = {}) => db.query(`INSERT INTO blocks VALUES ($1,$2,$3,$4)
    ON CONFLICT (height) DO UPDATE SET hash = EXCLUDED.hash, timestamp = EXCLUDED.timestamp, miner_address = EXCLUDED.miner_address`, [height, hash, time, miner]);
  const tx = async (txid, height, time, { hash = `h${height}`, coinbase = false, fee = 10_000, vb = {}, ins = [], outs = [] } = {}) => {
    await db.query(`INSERT INTO transactions(txid, block_height, block_hash, block_time, is_coinbase, fee, vin_count, vout_count,
        value_balance_sprout, value_balance_sapling, value_balance_orchard, value_balance_ironwood)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (txid) DO UPDATE SET block_height = EXCLUDED.block_height,
        block_hash = EXCLUDED.block_hash, block_time = EXCLUDED.block_time`,
    [txid, height, hash, time, coinbase, fee, ins.length, outs.length, vb.sprout ?? 0, vb.sapling ?? 0, vb.orchard ?? 0, vb.ironwood ?? 0]);
    for (const [i, [prev, address, value]] of ins.entries()) await db.query('INSERT INTO transaction_inputs VALUES ($1,$2,$3,0,$4,$5) ON CONFLICT DO NOTHING', [txid, i, prev, address, value]);
    for (const [i, [address, value]] of outs.entries()) await db.query('INSERT INTO transaction_outputs VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [txid, i, address, value]);
  };
  return { block, tx };
}

const t = c => c.repeat(64);
const stored = async db => (await db.query(`SELECT day::text, pool, direction, category, detail, amount_zat::text AS z, tx_count
  FROM shielded_pool_source_daily ORDER BY day, pool, direction, category, detail`)).rows.map(r => [r.day, r.pool, r.direction, r.category, r.detail, r.z, r.tx_count]);

async function seed(db) {
  await db.query(SCHEMA);
  await db.query(MIGRATION);
  await db.query(`INSERT INTO address_labels VALUES ($1, 'Binance', 'exchange')`, [BINANCE]);
  const { block, tx } = chain(db);
  await block(100, D1 - 3_600);
  // Two block rewards to ViaBTC's payout address.
  await tx(t('c'), 100, D1 - 3_600, { coinbase: true, fee: null, outs: [[MINER, 41_666_668]] });
  await block(101, D1 - 3_500);
  await tx(t('d'), 101, D1 - 3_500, { coinbase: true, fee: null, outs: [[MINER, 41_666_668]] });
  // Day 1: the pool sweeps both rewards into Sapling; a user shields from Binance into Ironwood.
  await block(110, D1);
  await tx(t('1'), 110, D1, { vb: { sapling: -(83_333_336 - 10_000) }, ins: [[t('c'), MINER, 41_666_668], [t('d'), MINER, 41_666_668]] });
  await tx(t('2'), 110, D1, { vb: { ironwood: -990_000 }, ins: [[t('x'), BINANCE, 1_000_000]] });
  // Day 2: Sapling -> Ironwood migration, then an Ironwood deshield to Binance.
  await block(200, D2);
  await tx(t('3'), 200, D2, { vb: { sapling: 50_000_000, ironwood: -49_990_000 } });
  await tx(t('4'), 200, D2, { vb: { ironwood: 5_000_000 }, outs: [[BINANCE, 4_990_000]] });
}

test('rebuild classifies full history into exact daily rows, and the reader serves them', { skip: process.env.SKIP_POSTGRES === '1' }, async () => {
  await withDatabase(async db => {
    await seed(db);
    const client = await db.connect();
    try {
      const ctx = await ps.loadContext(client);
      assert.equal((await ps.poolSources(client, { pool: 'sapling', period: '7d' }, { now: NOW }).catch(e => e)).status, 503);
      const r = await ps.rebuild(client, { ctx, batchDays: 1, now: () => NOW });
      assert.equal(r.coverageFrom, '2026-11-24');
      assert.equal(r.txs, 4);
      assert.deepEqual(await stored(db), [
        ['2026-11-24', 'ironwood', 'in', 'exchange', 'binance', '990000', 1],
        ['2026-11-24', 'sapling', 'in', 'mining', MINER, '83323336', 1],
        ['2026-11-25', 'ironwood', 'in', 'migration', 'sapling', '49990000', 1],
        ['2026-11-25', 'ironwood', 'out', 'exchange', 'binance', '4990000', 1],
        ['2026-11-25', 'ironwood', 'out', 'fee', '', '10000', 1],
        ['2026-11-25', 'sapling', 'out', 'fee', '', '10000', 1],
        ['2026-11-25', 'sapling', 'out', 'migration', 'ironwood', '49990000', 1],
      ]);
      // Exact reconciliation with the source balances, per pool and day.
      const { rows: recon } = await db.query(`WITH s AS (SELECT day, pool, sum(CASE WHEN direction='in' THEN amount_zat ELSE -amount_zat END) AS net
          FROM shielded_pool_source_daily GROUP BY 1, 2),
        v AS (SELECT (to_timestamp(block_time) AT TIME ZONE 'UTC')::date AS day, p.pool,
          -sum(CASE p.pool WHEN 'sapling' THEN value_balance_sapling WHEN 'ironwood' THEN value_balance_ironwood ELSE 0 END) AS net
          FROM transactions CROSS JOIN (VALUES ('sapling'), ('ironwood')) AS p(pool) GROUP BY 1, 2)
        SELECT count(*)::int AS mismatches FROM s FULL JOIN v USING (day, pool) WHERE COALESCE(s.net, 0) <> COALESCE(v.net, 0)`);
      assert.equal(recon[0].mismatches, 0);

      // A 7-day window reaching before coverage: those days are unknown, never zero, and void the totals.
      const week = await ps.poolSources(client, { pool: 'sapling', period: '7d' }, { now: NOW });
      assert.equal(week.status, 'ok');
      assert.equal(week.coverage.uncoveredDays, 5);
      assert.deepEqual(week.series.filter(d => d.coverage === 'none').map(d => d.inZat), [null, null, null, null, null]);
      assert.equal(week.totals, null);
      assert.equal(week.sources, null);
      assert.deepEqual(week.series.at(-1).in, {});

      const sapling = await ps.poolSources(client, { pool: 'sapling', from: '2026-11-24', to: '2026-11-25' }, { now: NOW });
      assert.deepEqual(sapling.totals, { inZat: '83323336', outZat: '50000000', netZat: '33323336' });
      assert.deepEqual(sapling.sources, [{ category: 'mining', amountZat: '83323336', txCount: 1 }]);
      assert.deepEqual(sapling.sourceDetails, [{ category: 'mining', detail: MINER, label: 'ViaBTC', amountZat: '83323336', txCount: 1 }]);
      assert.deepEqual(sapling.destinations.map(d => d.category), ['migration', 'fee']);
      assert.deepEqual(sapling.series.map(d => [d.date, d.coverage, d.netZat]), [['2026-11-24', 'complete', '83323336'], ['2026-11-25', 'partial', '-50000000']]);
      const window = await ps.poolSources(client, { pool: 'ironwood', from: '2026-11-24', to: '2026-11-25' }, { now: NOW });
      assert.deepEqual(window.totals, { inZat: '50980000', outZat: '5000000', netZat: '45980000' });
      assert.deepEqual(window.sourceDetails.map(d => [d.category, d.detail, d.label]), [['migration', 'sapling', 'Sapling'], ['exchange', 'binance', 'Binance']]);
      assert.equal(window.series[1].coverage, 'partial');
    } finally {
      client.release();
    }
  });
});

test('incremental refresh replaces recent days and follows a tip reorg; a label change marks the data stale', { skip: process.env.SKIP_POSTGRES === '1' }, async () => {
  await withDatabase(async db => {
    await seed(db);
    const client = await db.connect();
    try {
      let ctx = await ps.loadContext(client);
      await ps.rebuild(client, { ctx, now: () => NOW });
      assert.deepEqual(await ps.refresh(client, { ctx: { ...ctx, version: 'c0:x:y' }, now: () => NOW }), { action: 'version-changed' });

      // Reorg: block 200 is replaced; its migration disappears and a new deshield appears.
      const { block, tx } = chain(db);
      await db.query(`DELETE FROM transactions WHERE block_height = 200`);
      await block(200, D2, { hash: 'h200b' });
      await tx(t('5'), 200, D2, { hash: 'h200b', vb: { sapling: 2_000_000 }, outs: [[USER, 1_990_000]] });
      const r = await ps.refresh(client, { ctx, now: () => NOW });
      assert.equal(r.action, 'incremental');
      assert.equal(r.reorged, true);
      const rows = await stored(db);
      assert.deepEqual(rows.filter(x => x[0] === '2026-11-25'), [
        ['2026-11-25', 'sapling', 'out', 'fee', '', '10000', 1],
        ['2026-11-25', 'sapling', 'out', 'transparent', '', '1990000', 1],
      ]);
      assert.equal(rows.filter(x => x[0] === '2026-11-24').length, 2, 'older covered days are kept');

      await db.query(`INSERT INTO address_labels VALUES ($1, 'Kraken', 'exchange')`, [USER]);
      const st = await ps.status(client);
      assert.equal(st.status, 'stale');
      assert.equal(st.reason, 'labels-changed');
      ctx = await ps.loadContext(client);
      assert.equal((await ps.refresh(client, { ctx, now: () => NOW })).action, 'version-changed');
    } finally {
      client.release();
    }
  });
});
