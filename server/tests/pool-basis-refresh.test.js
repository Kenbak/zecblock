'use strict';
const databaseUrl = process.env.TEST_ANALYTICS_DATABASE_URL || process.env.TEST_UTXO_DATABASE_URL;
const test = require('node:test'); const assert = require('node:assert/strict');
const { applyFlow } = require('../lib/pool-basis');
const { range, refreshDay, rebuild } = require('../jobs/refresh-pool-realized-cap');
const { TABLES, freshnessHealthy, report } = require('../jobs/check-analytics-completeness');
test('catch-up resumes after the seed; refresh is bounded to seven complete days', () => {
  assert.deepEqual(range('2026-10-03', '2026-10-07'), { from: '2026-10-04', to: '2026-10-07', seed: '2026-10-03' });
  assert.equal(range('2026-10-07', '2026-10-07'), null);
  assert.deepEqual(range('2026-10-07', '2026-10-07', true), { from: '2026-10-01', to: '2026-10-07', seed: '2026-09-30' });
  assert.equal(range('2026-09-01', '2026-10-07').to, '2026-09-08');
  assert.throws(() => range(null, '2026-10-07'), /seed/);
});
test('stored flow model carries average basis across spends and migrations', () => {
  const pools = {};
  applyFlow(pools, { flow_type: 'shield', pool: 'sapling', amount_zat: '300000000' }, 10);
  applyFlow(pools, { flow_type: 'shield', pool: 'sapling', amount_zat: '100000000' }, 20);
  applyFlow(pools, { flow_type: 'deshield', pool: 'sapling', amount_zat: '100000000' }, 999);
  assert.deepEqual(pools.sapling, { balance_zat: 300000000, realized_cap_usd: 37.5 });
  applyFlow(pools, { is_pool_migration: true, migration_from_pool: 'sapling', migration_to_pool: 'orchard', amount_zat: '100000000' }, 999);
  assert.deepEqual(pools.sapling, { balance_zat: 200000000, realized_cap_usd: 25 });
  assert.deepEqual(pools.orchard, { balance_zat: 100000000, realized_cap_usd: 12.5 });
  assert.throws(() => applyFlow(pools, { amount_zat: 1 }, NaN), /price/);
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
    if (sql.includes('FROM shielded_flows')) return { rows: [{ flow_type: 'shield', pool: 'sapling', amount_zat: '100000000' }] };
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
      return { rows: [{ block_time: Date.parse('2026-10-04') / 1000, flow_type: 'shield', pool: 'sapling', amount_zat: '100000000' }, { block_time: Date.parse('2026-10-06') / 1000, flow_type: 'shield', pool: 'sapling', amount_zat: '100000000' }] };
    }
    return { rows: [] };
  } };
  const result = await rebuild(writer, reader, '2026-10-07', true, async () => ({}));
  assert.equal(result.modelRebuildFlows, 2); assert.equal(result.rows, 4);
  const written = JSON.parse(calls.find(([sql]) => sql.includes('INSERT'))[1][0]);
  assert.deepEqual(written.map(row => [row.date, row.realized_cap_usd]), [['2026-10-04', 10], ['2026-10-05', 10], ['2026-10-06', 30], ['2026-10-07', 30]]);
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
      CREATE TEMP TABLE transactions(block_time bigint);
      CREATE TEMP TABLE shielded_flows(id bigint,txid text,block_time bigint,flow_type text,pool text,amount_zat bigint,is_pool_migration boolean,migration_from_pool text,migration_to_pool text);
      CREATE TEMP TABLE zec_price_daily(date date,price_usd numeric);
      CREATE TEMP TABLE pool_realized_cap_daily(date date,pool text,balance_zat bigint,realized_cap_usd numeric,avg_acquisition_price numeric,PRIMARY KEY(date,pool));
      INSERT INTO blocks VALUES(1,'day4',1791072000,1),(2,'day6',1791244800,1),(3,'tip',1791417600,1);
      INSERT INTO transactions VALUES(1791072000),(1791244800),(1791417600);
      INSERT INTO shielded_flows VALUES(1,'a',1791072000,'shield','sapling',100000000,false,NULL,NULL),(2,'b',1791244800,'shield','sapling',100000000,false,NULL,NULL);
      INSERT INTO zec_price_daily VALUES('2026-10-04',10),('2026-10-06',20)`);
    const result = await rebuild(db, db, '2026-10-07', true, async () => ({}));
    assert.equal(result.rows, 4);
    const seed = (await db.query("SELECT balance_zat,realized_cap_usd FROM pool_realized_cap_daily WHERE date='2026-10-05'")).rows[0];
    const incremental = await refreshDay(db, db, '2026-10-06', { sapling: { balance_zat: Number(seed.balance_zat), realized_cap_usd: Number(seed.realized_cap_usd) } }, true, async () => ({}));
    assert.equal(incremental.pools.sapling.realized_cap_usd, result.pools.sapling.realized_cap_usd);
    assert.equal(incremental.pools.sapling.balance_zat, result.pools.sapling.balance_zat);
    assert.equal((await db.query('SELECT COUNT(*)::int count FROM pool_realized_cap_daily')).rows[0].count, 4);
  } finally { await db.end(); }
});
