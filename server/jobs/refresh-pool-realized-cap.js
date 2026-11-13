#!/usr/bin/env node
'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { average, applyTransaction } = require('../lib/pool-basis');
// Every canonical transaction (coinbase included) that changes a shielded pool.
// Value balances are signed zatoshis; NULL means unknown and fails the run.
const POOL_TX_COLUMNS = 'block_time,value_balance_sprout,value_balance_sapling,value_balance_orchard,value_balance_ironwood';
const POOL_TX_FILTER = `(value_balance_sprout IS DISTINCT FROM 0 OR value_balance_sapling IS DISTINCT FROM 0
      OR value_balance_orchard IS DISTINCT FROM 0 OR value_balance_ironwood IS DISTINCT FROM 0)`;
const DAY = 86400000;
const addDays = (date, days) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
function range(last, yesterday, refresh = false) {
  if (!last) throw new Error('Pool model needs an existing historical seed; run the reviewed historical rebuild first');
  const from = last < yesterday ? addDays(last, 1) : refresh ? addDays(yesterday, -6) : null;
  return from ? { from, to: addDays(from, Math.min(6, (Date.parse(yesterday) - Date.parse(from)) / DAY)), seed: addDays(from, -1) } : null;
}
async function rebuild(writer, reader, yesterday, apply, health, log = () => {}) {
  const prices = new Map((await writer.query('SELECT date::text date,price_usd FROM zec_price_daily WHERE date<=$1', [yesterday])).rows.map(row => [row.date, Number(row.price_usd)]));
  const pools = Object.create(null), snapshots = [];
  let date = null, tip, processed = 0, shortfall = 0;
  const snapshot = day => {
    for (const [name, state] of Object.entries(pools)) snapshots.push({ date: day, pool: name, ...state, avg_acquisition_price: average(state) });
  };
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await reader.query("SET LOCAL statement_timeout='20s'; SET LOCAL work_mem='16MB'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL TIME ZONE 'UTC'");
    tip = (await reader.query('SELECT height,hash,timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
    if (!tip || Number(tip.timestamp) < Date.parse(addDays(yesterday, 1)) / 1000) throw new Error('Source has not reached completed UTC day');
    // Cursor avoids OFFSET rescans and keeps all reads in one snapshot. Chain
    // order (height, index) keeps spends after the value they spend. Block
    // timestamps may step back across midnight; such a block stays on the
    // day already reached, so each completed day is written once.
    await reader.query(`DECLARE pool_txs NO SCROLL CURSOR FOR
      SELECT ${POOL_TX_COLUMNS} FROM transactions
      WHERE block_time IS NOT NULL AND block_time < ${Date.parse(addDays(yesterday, 1)) / 1000} AND ${POOL_TX_FILTER}
      ORDER BY block_height,tx_index`);
    while (true) {
      const { rows } = await reader.query('FETCH FORWARD 10000 FROM pool_txs');
      if (!rows.length) break;
      for (const row of rows) {
        const stamp = new Date(Number(row.block_time) * 1000).toISOString().slice(0, 10);
        const day = date && stamp < date ? date : stamp;
        if (date && day !== date) {
          for (let completed = date; completed < day; completed = addDays(completed, 1)) snapshot(completed);
        }
        date = day;
        shortfall += applyTransaction(pools, row, prices.get(day));
      }
      processed += rows.length;
      if (processed > 50000000) throw new Error('Full pool model safety limit exceeded');
      await health(writer, reader);
      if (processed % 1000000 === 0) log(JSON.stringify({ modelRebuildTransactions: processed, date }));
      await delay(100);
    }
    if (!date) throw new Error('No shielded model source transactions');
    for (let completed = date; completed <= yesterday; completed = addDays(completed, 1)) snapshot(completed);
    await reader.query('COMMIT');
  } catch (error) { await reader.query('ROLLBACK'); throw error; }
  await health(writer, reader);
  if (apply) {
    await writer.query('BEGIN');
    try {
      await writer.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'");
      if (!(await writer.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2', [tip.height, tip.hash])).rowCount) throw new Error('Source chain changed before pool model rebuild write');
      // A rebuild replaces the whole model, including rows for retired pseudo-pools.
      await writer.query('DELETE FROM pool_realized_cap_daily');
      await writer.query(`INSERT INTO pool_realized_cap_daily(date,pool,balance_zat,realized_cap_usd,avg_acquisition_price)
        SELECT date,pool,balance_zat,realized_cap_usd,avg_acquisition_price FROM jsonb_to_recordset($1::jsonb)
        AS r(date date,pool text,balance_zat bigint,realized_cap_usd numeric,avg_acquisition_price numeric)
        ON CONFLICT(date,pool) DO UPDATE SET balance_zat=excluded.balance_zat,
        realized_cap_usd=excluded.realized_cap_usd,avg_acquisition_price=excluded.avg_acquisition_price`, [JSON.stringify(snapshots)]);
      await writer.query('COMMIT');
    } catch (error) { await writer.query('ROLLBACK'); throw error; }
  }
  return { applied: apply, modelRebuildTransactions: processed, shortfallZat: shortfall, first: snapshots[0].date, through: yesterday, rows: snapshots.length, pools };
}
async function refreshDay(writer, reader, date, pools, apply, health) {
  const start = Date.parse(date) / 1000;
  const price = Number((await writer.query('SELECT price_usd FROM zec_price_daily WHERE date=$1', [date])).rows[0]?.price_usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Missing or invalid daily price: ${date}`);
  let anchor, tip, txs;
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await reader.query("SET LOCAL statement_timeout='20s'; SET LOCAL work_mem='16MB'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL TIME ZONE 'UTC'");
    tip = (await reader.query('SELECT height,hash,timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
    if (!tip || Number(tip.timestamp) < start + 86400) throw new Error('Source has not reached completed UTC day');
    const counts = (await reader.query(`SELECT SUM(transaction_count)::text expected,
      (SELECT COUNT(*)::text FROM transactions WHERE block_time >= $1 AND block_time < $2) observed
      FROM blocks WHERE timestamp >= $1 AND timestamp < $2`, [start, start + 86400])).rows[0];
    if (counts.expected !== counts.observed) throw new Error('Incomplete daily transaction coverage');
    anchor = (await reader.query('SELECT height,hash FROM blocks WHERE timestamp >= $1 AND timestamp < $2 ORDER BY height DESC LIMIT 1', [start, start + 86400])).rows[0];
    if (!anchor) throw new Error('No canonical daily anchor');
    txs = (await reader.query(`SELECT ${POOL_TX_COLUMNS} FROM transactions
      WHERE block_time >= $1 AND block_time < $2 AND ${POOL_TX_FILTER}
      ORDER BY block_height,tx_index LIMIT 500001`, [start, start + 86400])).rows;
    if (txs.length > 500000) throw new Error('Daily transaction safety limit exceeded');
    await reader.query('COMMIT');
  } catch (error) { await reader.query('ROLLBACK'); throw error; }
  const next = structuredClone(pools);
  let shortfall = 0;
  for (const row of txs) shortfall += applyTransaction(next, row, price);
  const stats = await health(writer, reader);
  if (apply) {
    await writer.query('BEGIN');
    try {
      await writer.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'");
      for (const block of [tip, anchor]) {
        if (!(await writer.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2', [block.height, block.hash])).rowCount) throw new Error('Source chain changed before pool model write');
      }
      for (const [name, state] of Object.entries(next)) {
        await writer.query(`INSERT INTO pool_realized_cap_daily(date,pool,balance_zat,realized_cap_usd,avg_acquisition_price)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(date,pool) DO UPDATE SET balance_zat=excluded.balance_zat,
          realized_cap_usd=excluded.realized_cap_usd,avg_acquisition_price=excluded.avg_acquisition_price`,
        [date, name, state.balance_zat, state.realized_cap_usd, average(state)]);
      }
      await writer.query('COMMIT');
    } catch (error) { await writer.query('ROLLBACK'); throw error; }
  }
  return { pools: next, summary: { date, applied: apply, transactions: txs.length, shortfallZat: shortfall, pools: Object.keys(next).length, ...stats } };
}
async function run(args = process.argv.slice(2)) {
  if (args.some(arg => !['--apply', '--refresh', '--rebuild'].includes(arg)) || (args.includes('--refresh') && args.includes('--rebuild'))) throw new Error('Use --apply and optionally --refresh (seven complete days) or --rebuild (all historical pool transactions)');
  const { loadEnv, log } = require('../lib/job-utils');
  loadEnv(__dirname);
  const { getPool, getReadPool, hasReadReplica } = require('../lib/db-pool');
  const { health } = require('./backfill-analytics-history');
  if (!hasReadReplica()) throw new Error('Pool model catch-up requires the physical replica');
  const primary = getPool({ max: 1, statement_timeout: 5000, query_timeout: 6000, application_name: 'pool-basis-writer' });
  const replica = getReadPool({ max: 1, statement_timeout: 20000, query_timeout: 21000, application_name: 'pool-basis-reader' });
  let writer, reader, locked = false;
  try {
    writer = await primary.connect(); reader = await replica.connect();
    locked = (await writer.query('SELECT pg_try_advisory_lock(839303) acquired')).rows[0].acquired;
    if (!locked) throw new Error('PAUSE: another analytics job is running');
    await health(writer, reader);
    const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
    if (args.includes('--rebuild')) { log(JSON.stringify(await rebuild(writer, reader, yesterday, args.includes('--apply'), health, log))); return; }
    const last = (await writer.query('SELECT MAX(date)::text date FROM pool_realized_cap_daily WHERE date<=$1', [yesterday])).rows[0].date;
    const plan = range(last, yesterday, args.includes('--refresh'));
    if (!plan) { log(JSON.stringify({ skipped: 'completed pool model dates are current', through: last })); return; }
    let pools = Object.fromEntries((await writer.query('SELECT pool,balance_zat,realized_cap_usd FROM pool_realized_cap_daily WHERE date=$1', [plan.seed])).rows.map(row => [row.pool, { balance_zat: Number(row.balance_zat), realized_cap_usd: Number(row.realized_cap_usd) }]));
    const expected = (await writer.query('SELECT COUNT(DISTINCT pool)::int count FROM pool_realized_cap_daily WHERE date<=$1', [plan.seed])).rows[0].count;
    if (!expected || Object.keys(pools).length !== expected || Object.values(pools).some(state => !Number.isSafeInteger(state.balance_zat) || state.balance_zat < 0 || !Number.isFinite(state.realized_cap_usd) || state.realized_cap_usd < 0)) throw new Error('Incomplete or invalid pool model seed');
    for (let date = plan.from; date <= plan.to; date = addDays(date, 1)) {
      const result = await refreshDay(writer, reader, date, pools, args.includes('--apply'), health);
      pools = result.pools;
      log(JSON.stringify(result.summary));
      if (date < plan.to) await delay(10000);
    }
  } finally {
    if (locked) await writer.query('SELECT pg_advisory_unlock(839303)').catch(() => {});
    if (writer) writer.release(); if (reader) reader.release();
    await primary.end(); if (replica !== primary) await replica.end();
  }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { range, refreshDay, rebuild, run };
