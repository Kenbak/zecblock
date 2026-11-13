'use strict';
const databaseUrl = process.env.TEST_ANALYTICS_DATABASE_URL || process.env.TEST_UTXO_DATABASE_URL;
const test = require('node:test'); const assert = require('node:assert/strict');
const { applyTransaction } = require('../lib/pool-basis');
const tx = (balances, extra = {}) => ({ value_balance_sprout: 0, value_balance_sapling: 0, value_balance_orchard: 0, value_balance_ironwood: 0, ...balances, ...extra });
const { range, refreshDay, rebuild } = require('../jobs/refresh-pool-realized-cap');
const { TABLES, freshnessHealthy, report } = require('../jobs/check-analytics-completeness');
test('catch-up resumes after the seed; refresh is bounded to seven complete days', () => {
  assert.deepEqual(range('2026-10-03', '2026-10-07'), { from: '2026-10-04', to: '2026-10-07', seed: '2026-10-03' });
  assert.equal(range('2026-10-07', '2026-10-07'), null);
  assert.deepEqual(range('2026-10-07', '2026-10-07', true), { from: '2026-10-01', to: '2026-10-07', seed: '2026-09-30' });
  assert.equal(range('2026-09-01', '2026-10-07').to, '2026-09-08');
  assert.throws(() => range(null, '2026-10-07'), /seed/);
});
test('per-pool model carries average basis across spends and migrations', () => {
  const pools = {};
  applyTransaction(pools, tx({ value_balance_sapling: '-300000000' }), 10);
  applyTransaction(pools, tx({ value_balance_sapling: '-100000000' }), 20);
  assert.equal(applyTransaction(pools, tx({ value_balance_sapling: '100000000' }), 999), 0);
  assert.deepEqual(pools.sapling, { balance_zat: 300000000, realized_cap_usd: 37.5 });
  // Pure Sapling -> Orchard move: 1 ZEC enters Orchard, 1.0001 leaves Sapling (fee).
  applyTransaction(pools, tx({ value_balance_sapling: '100010000', value_balance_orchard: '-100000000' }), 999);
  assert.equal(pools.sapling.balance_zat, 199990000);
  assert.equal(pools.orchard.balance_zat, 100000000);
  assert.ok(Math.abs(pools.sapling.realized_cap_usd - 24.99875) < 1e-9);
  assert.ok(Math.abs(pools.orchard.realized_cap_usd - 12.5) < 1e-9, 'migration keeps cost, fee cost leaves');
  assert.throws(() => applyTransaction(pools, tx({}), NaN), /price/);
});
test('mixed shields split new money by pool; shielded coinbase enters at the day price', () => {
  const pools = { sapling: { balance_zat: 100000000, realized_cap_usd: 10 } };
  // 1 ZEC leaves Sapling, 3 ZEC enter Orchard: 1 ZEC carries $10, 2 ZEC are new at $50.
  applyTransaction(pools, tx({ value_balance_sapling: 100000000, value_balance_orchard: -300000000 }), 50);
  assert.deepEqual(pools.sapling, { balance_zat: 0, realized_cap_usd: 0 });
  assert.deepEqual(pools.orchard, { balance_zat: 300000000, realized_cap_usd: 110 });
  assert.equal(pools.mixed, undefined);
  applyTransaction(pools, tx({ value_balance_ironwood: -50000000 }, { is_coinbase: true }), 40);
  assert.deepEqual(pools.ironwood, { balance_zat: 50000000, realized_cap_usd: 20 });
});
test('unknown balances fail closed; overdrawn pools are reported, not hidden', () => {
  assert.throws(() => applyTransaction({}, tx({ value_balance_sprout: null }), 10), /Unknown value_balance_sprout/);
  assert.throws(() => applyTransaction({}, tx({ value_balance_orchard: '1.5' }), 10), /Invalid value_balance_orchard/);
  const pools = { orchard: { balance_zat: 100, realized_cap_usd: 1 } };
  assert.equal(applyTransaction(pools, tx({ value_balance_orchard: 150 }), 10), 50);
  assert.deepEqual(pools.orchard, { balance_zat: 0, realized_cap_usd: 0 });
});
function fixture({ changed = false, broken = false, writeFails = false } = {}) {
  const calls = [];
  const writer = { query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT price_usd')) return { rows: [{ price_usd: '20' }] };
    if (sql.startsWith('SELECT 1 FROM blocks')) return { rowCount: changed ? 0 : 1 };
    if (sql.includes('INSERT') && writeFails) throw Error('write failed');
    return { rows: [], rowCount: 1 };
  } };
  const reader = { query: async sql => {
    if (sql.includes('ORDER BY height DESC LIMIT 1')) return { rows: [{ height: 10, hash: 'canonical', timestamp: Date.parse('2026-10-08') / 1000 }] };
    if (sql.includes('SUM(transaction_count)')) return { rows: [{ expected: '1', observed: broken ? '0' : '1' }] };
    if (sql.includes('FROM transactions') && sql.includes('value_balance')) return { rows: [tx({ value_balance_sapling: '-100000000' })] };
    return { rows: [] };
  } };
  return { calls, writer, reader };
}
test('complete-day recovery writes atomic pool snapshots and leaves the input seed unchanged', async () => {
  const f = fixture(); const pools = { sapling: { balance_zat: 100000000, realized_cap_usd: 10 } };
  const result = await refreshDay(f.writer, f.reader, '2026-10-07', pools, true, async () => ({}));
  assert.equal(pools.sapling.realized_cap_usd, 10); assert.equal(result.pools.sapling.realized_cap_usd, 30);
  assert.ok(f.calls.some(([sql]) => sql === 'COMMIT'));
  assert.deepEqual(f.calls.find(([sql]) => sql.includes('INSERT'))[1], ['2026-10-07', 'sapling', 200000000, 30, 15]);
});
test('incomplete source or a reorg cannot publish the model; write failures roll back', async () => {
  for (const options of [{ broken: true }, { changed: true }, { writeFails: true }]) {
    const f = fixture(options);
    await assert.rejects(refreshDay(f.writer, f.reader, '2026-10-07', {}, true, async () => ({})));
    assert.ok(!f.calls.some(([sql]) => sql === 'COMMIT'));
    if (!options.broken) assert.ok(f.calls.some(([sql]) => sql === 'ROLLBACK'));
  }
});
test('analytics freshness fails when any derived dataset stalls, is empty, or has an interior hole', () => {
  const healthy = Object.fromEntries(TABLES.map(table => [table, { count: 1, interior_missing: 0, stale_days: 0 }]));
  assert.equal(freshnessHealthy(healthy), true);
  for (const table of TABLES) {
    for (const values of [{ stale_days: 2 }, { stale_days: null }, { count: 0 }, { interior_missing: 1 }]) assert.equal(freshnessHealthy({ ...healthy, [table]: { ...healthy[table], ...values } }), false);
  }
  assert.equal(freshnessHealthy({ ...healthy, mvrv_daily: { ...healthy.mvrv_daily, stale_days: 1 } }), true);
});
test('freshness date arithmetic uses UTC independently of database timezone', async () => {
  const sqls = [];
  await report({ query: async sql => { sqls.push(sql); return { rows: [sql.includes('WITH clock') ? { count: 1, interior_missing: 0, stale_days: 0 } : {}] }; } });
  assert.equal(sqls.filter(sql => sql.includes("now() AT TIME ZONE 'UTC'")).length, TABLES.length);
  assert.ok(!require('../signals/compute-mvrv').REBUILD_SQL.includes('CURRENT_DATE'));
});
test('cursor rebuild uses UTC price labels and carries state over idle days before an atomic write', async () => {
  const calls = [];
  const writer = { query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.includes('SELECT date::text')) return { rows: [{ date: '2026-10-04', price_usd: '10' }, { date: '2026-10-06', price_usd: '20' }] };
    return { rows: [], rowCount: 1 };
  } };
  let fetched = false;
  const reader = { query: async sql => {
    if (sql.startsWith('SELECT height')) return { rows: [{ height: 10, hash: 'tip', timestamp: Date.parse('2026-10-08') / 1000 }] };
    if (sql.startsWith('FETCH')) {
      if (fetched) return { rows: [] }; fetched = true;
      // The third block's timestamp steps back across midnight; it stays on 2026-10-06.
      return { rows: [tx({ value_balance_sapling: '-100000000' }, { block_time: Date.parse('2026-10-04') / 1000 }),
        tx({ value_balance_sapling: '-100000000' }, { block_time: Date.parse('2026-10-06') / 1000 }),
        tx({ value_balance_sapling: '50000000' }, { block_time: Date.parse('2026-10-05T23:59:59Z') / 1000 })] };
    }
    return { rows: [] };
  } };
  const result = await rebuild(writer, reader, '2026-10-07', true, async () => ({}));
  assert.equal(result.modelRebuildTransactions, 3); assert.equal(result.rows, 4); assert.equal(result.shortfallZat, 0);
  const written = JSON.parse(calls.find(([sql]) => sql.includes('INSERT'))[1][0]);
  assert.deepEqual(written.map(row => [row.date, row.realized_cap_usd]), [['2026-10-04', 10], ['2026-10-05', 10], ['2026-10-06', 22.5], ['2026-10-07', 22.5]]);
  const deleteAt = calls.findIndex(([sql]) => sql === 'DELETE FROM pool_realized_cap_daily');
  assert.ok(deleteAt > 0 && deleteAt < calls.findIndex(([sql]) => sql.includes('INSERT')), 'rebuild replaces stale pools in the same transaction');
  assert.equal(calls.at(-1)[0], 'COMMIT');
});
test('explicit historical entry point rejects accidental full scans', () => {
  const legacy = require('../signals/build-pool-realized-cap');
  assert.throws(() => legacy.run([]), /--today-only/);
});
test('PostgreSQL cursor rebuild and seven-day model path agree across Berlin UTC boundaries', { skip: !databaseUrl }, async () => {
  const { Client } = require('pg'); const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query(`SET TIME ZONE 'Europe/Berlin';
      CREATE TEMP TABLE blocks(height bigint,hash text,timestamp bigint,transaction_count int);
      CREATE TEMP TABLE transactions(block_height bigint,tx_index int,block_time bigint,value_balance_sprout bigint,value_balance_sapling bigint DEFAULT 0,value_balance_orchard bigint DEFAULT 0,value_balance_ironwood bigint DEFAULT 0);
      CREATE TEMP TABLE zec_price_daily(date date,price_usd numeric);
      CREATE TEMP TABLE pool_realized_cap_daily(date date,pool text,balance_zat bigint,realized_cap_usd numeric,avg_acquisition_price numeric,PRIMARY KEY(date,pool));
      INSERT INTO blocks VALUES(1,'day4',1791072000,1),(2,'day6',1791244800,2),(3,'tip',1791417600,1);
      INSERT INTO transactions VALUES(1,0,1791072000,0,-100000000,0,0),(2,0,1791244800,0,-100000000,0,0),(2,1,1791244800,0,50000000,-49990000,0),(3,0,1791417600,0,0,0,0);
      INSERT INTO pool_realized_cap_daily VALUES('2026-10-01','mixed',1,1,1);
      INSERT INTO zec_price_daily VALUES('2026-10-04',10),('2026-10-06',20)`);
    const result = await rebuild(db, db, '2026-10-07', true, async () => ({}));
    assert.equal(result.rows, 6); assert.equal(result.shortfallZat, 0);
    const seed = (await db.query("SELECT balance_zat,realized_cap_usd FROM pool_realized_cap_daily WHERE date='2026-10-05'")).rows[0];
    const incremental = await refreshDay(db, db, '2026-10-06', { sapling: { balance_zat: Number(seed.balance_zat), realized_cap_usd: Number(seed.realized_cap_usd) } }, true, async () => ({}));
    for (const pool of ['sapling', 'orchard']) {
      assert.equal(incremental.pools[pool].balance_zat, result.pools[pool].balance_zat);
      assert.ok(Math.abs(incremental.pools[pool].realized_cap_usd - result.pools[pool].realized_cap_usd) < 1e-9);
    }
    assert.equal(result.pools.orchard.balance_zat, 49990000);
    assert.equal((await db.query("SELECT COUNT(*)::int count FROM pool_realized_cap_daily WHERE pool='mixed'")).rows[0].count, 0);
    assert.equal((await db.query('SELECT COUNT(*)::int count FROM pool_realized_cap_daily')).rows[0].count, 6);
  } finally { await db.end(); }
});
