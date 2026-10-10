#!/usr/bin/env node
'use strict';

// Rebuild mining summaries only, one completed UTC day per transaction.
// No financial replay, schema change or raw block rewrite. Dry-run by default.
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { selectDays } = require('../lib/utxo-age');
const { loadEnv } = require('../lib/job-utils');
const { POOL_BY_ADDRESS, POOL_BY_TAG, getPoolName, getPoolTagSql } = require('../api/mining-pools');
const behavior = require('../jobs/snapshot-mining-behavior');
const destinations = require('../jobs/snapshot-miner-destinations');

function options(args) {
  const dateArgs = [], result = { apply: false, pauseMs: 100 };
  for (const arg of args) {
    if (/^--(from|to)=/.test(arg)) dateArgs.push(arg);
    else if (arg === '--apply') result.apply = true;
    else if (/^--report=.+/.test(arg)) result.report = arg.slice(9);
    else if (/^--pause-ms=\d+$/.test(arg)) result.pauseMs = Number(arg.slice(11));
    else throw new Error('Use --from=DATE --to=DATE [--apply --report=PATH] [--pause-ms=100..60000]');
  }
  if (dateArgs.length !== 2 || !Number.isInteger(result.pauseMs) || result.pauseMs < 100 || result.pauseMs > 60000) throw new Error('Explicit bounded dates and a safe pause are required');
  result.dates = selectDays(dateArgs);
  if (result.apply && !result.report) throw new Error('Apply requires a new backup/report file');
  return result;
}

function checkTotals(poolCounts, blockCount, earned, flows) {
  if (Object.values(poolCounts).reduce((s, n) => s + n, 0) !== blockCount) throw new Error('Block denominator mismatch');
  const totals = { blocks: blockCount, earned: 0n, spent: 0n, held: 0n, destinations: 0n };
  for (const [name, row] of Object.entries(earned)) {
    if (row.earned < row.spent || row.earned < 0n || row.spent < 0n) throw new Error('Invalid earned/spent balance');
    const flow = flows[name];
    if (!flow) throw new Error('Missing destination pool');
    const moved = Object.values(flow).reduce((s, value) => s + value, 0n);
    if (Object.values(flow).some(value => value < 0n) || moved !== row.spent) throw new Error('Destination/spent mismatch');
    totals.earned += row.earned; totals.spent += row.spent; totals.held += row.earned - row.spent; totals.destinations += moved;
  }
  if (Object.keys(flows).some(name => !earned[name])) throw new Error('Unexpected destination pool');
  return totals;
}

async function readDay(reader, date) {
  const start = Date.parse(`${date}T00:00:00Z`) / 1000;
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await reader.query("SET LOCAL statement_timeout='20s'; SET LOCAL work_mem='16MB'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL TIME ZONE 'UTC'");
    const anchor = (await reader.query('SELECT height,hash,timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
    if (!anchor || Number(anchor.timestamp) < start + 86400) throw new Error('Source day is incomplete');
    const known = Object.keys(POOL_BY_ADDRESS).filter(address => !POOL_BY_ADDRESS[address].isFundingStream);
    const rows = (await reader.query(`SELECT miner_address,
      CASE WHEN miner_address=ANY($3::text[]) THEN NULL ELSE ${getPoolTagSql()} END pool_tag, COUNT(*)::int blocks
      FROM blocks WHERE timestamp >= $1 AND timestamp < $2 GROUP BY miner_address,pool_tag`, [start, start + 86400, known])).rows;
    const poolCounts = {};
    let blockCount = 0;
    for (const row of rows) {
      const name = getPoolName(row.miner_address) || POOL_BY_TAG[row.pool_tag]?.name || 'Unknown';
      poolCounts[name] = (poolCounts[name] || 0) + row.blocks; blockCount += row.blocks;
    }
    const earned = await behavior.readDay(reader, date);
    const flows = await destinations.readDay(reader, date);
    const expected = (await reader.query('SELECT COUNT(*)::int blocks FROM blocks WHERE timestamp >= $1 AND timestamp < $2', [start, start + 86400])).rows[0].blocks;
    if (blockCount !== expected) throw new Error('Incomplete block classification');
    const totals = checkTotals(poolCounts, expected, earned, flows);
    await reader.query('COMMIT');
    return { date, anchor, poolCounts, earned, flows, totals };
  } catch (error) { await reader.query('ROLLBACK'); throw error; }
}

async function applyDay(writer, data, record) {
  await writer.query('BEGIN');
  try {
    await writer.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL TIME ZONE 'UTC'");
    if (!(await writer.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2', [data.anchor.height, data.anchor.hash])).rowCount) throw new Error('Source chain changed');
    const before = {
      analytics: (await writer.query('SELECT date::text,anchor_height,anchor_hash,mining_pool_blocks,fees FROM analytics_history_daily WHERE date=$1 FOR UPDATE', [data.date])).rows,
      behavior: (await writer.query('SELECT * FROM mining_behavior_daily WHERE date=$1 FOR UPDATE', [data.date])).rows,
      destinations: (await writer.query('SELECT * FROM miner_destination_daily WHERE date=$1 FOR UPDATE', [data.date])).rows,
    };
    if (!before.analytics.length && !before.behavior.length && !before.destinations.length) throw new Error('No existing summary for this date');
    for (const row of before.analytics) {
      if (!(await writer.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2', [row.anchor_height, row.anchor_hash])).rowCount) throw new Error('Stored analytics anchor is stale');
    }
    // The durable backup is written before any row replacement. It contains
    // exact prior rows and new calculations, so a failed day is recoverable.
    record({ event: 'before-write', ...data, before });
    await behavior.writeDay(writer, data.date, data.earned);
    await destinations.writeDay(writer, data.date, data.flows);
    await writer.query(`UPDATE analytics_history_daily SET mining_pool_blocks=$2::jsonb,
      fees=jsonb_set(COALESCE(fees,'{}'::jsonb),'{minerDestinationRows}',to_jsonb($3::int)) WHERE date=$1`,
    [data.date, JSON.stringify(data.poolCounts), Object.keys(data.flows).length]);
    // Re-read persisted integer values before committing, independent of
    // the calculation's BigInt representation and each job's inserts.
    const actual = (await writer.query(`SELECT
      (SELECT COALESCE(SUM(earned_zat),0)::text FROM mining_behavior_daily WHERE date=$1) earned,
      (SELECT COALESCE(SUM(spent_zat),0)::text FROM mining_behavior_daily WHERE date=$1) spent,
      (SELECT COALESCE(SUM(held_zat),0)::text FROM mining_behavior_daily WHERE date=$1) held,
      (SELECT COALESCE(SUM(shielded_zat+exchange_zat+bridge_zat+other_zat),0)::text FROM miner_destination_daily WHERE date=$1) destinations`, [data.date])).rows[0];
    for (const key of ['earned','spent','held','destinations']) if (BigInt(actual[key]) !== data.totals[key]) throw new Error(`Stored ${key} total mismatch`);
    await writer.query('COMMIT');
    record({ event: 'committed', date: data.date, totals: data.totals });
  } catch (error) { await writer.query('ROLLBACK'); throw error; }
}

async function run(args = process.argv.slice(2)) {
  const opt = options(args); loadEnv(__dirname);
  const { getPool, getReadPool, hasReadReplica } = require('../lib/db-pool');
  if (!hasReadReplica()) throw new Error('Configure REPLICA_DB_HOST; historical repair requires replica reads');
  const primary = getPool({ max: 1, application_name: 'mining-attribution-repair-writer' });
  const replica = getReadPool({ max: 1, application_name: 'mining-attribution-repair-reader' });
  const writer = await primary.connect(), reader = await replica.connect();
  let fd; const held = [];
  const record = value => {
    const line = JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v) + '\n';
    if (fd !== undefined) { fs.writeSync(fd, line); fs.fsyncSync(fd); }
    if (value.event !== 'before-write') process.stdout.write(line);
  };
  try {
    if (opt.report) fd = fs.openSync(opt.report, 'wx', 0o600);
    if ((await writer.query('SELECT pg_is_in_recovery() recovery')).rows[0].recovery || !(await reader.query('SELECT pg_is_in_recovery() recovery')).rows[0].recovery) throw new Error('Repair requires a primary writer and a physical replica reader');
    for (const lock of [839302,839275,839276,839303]) {
      if (!(await writer.query('SELECT pg_try_advisory_lock($1) acquired', [lock])).rows[0].acquired) throw new Error('Another mining/analytics job is running');
      held.push(lock);
    }
    record({ event: 'start', apply: opt.apply, from: opt.dates[0], to: opt.dates.at(-1), observedAt: new Date().toISOString() });
    for (const date of opt.dates) {
      const tip = (await writer.query('SELECT timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
      if (!tip || Date.now()/1000 - Number(tip.timestamp) > 600) throw new Error('Indexed tip is stale');
      const lag = (await reader.query('SELECT height FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
      const primaryTip = (await writer.query('SELECT height FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
      if (Number(primaryTip.height) - Number(lag?.height) > 5) throw new Error('Replica is behind');
      const data = await readDay(reader, date);
      if (opt.apply) await applyDay(writer, data, record);
      else record({ event: 'dry-run', ...data });
      await delay(opt.pauseMs);
    }
    record({ event: 'complete', days: opt.dates.length, apply: opt.apply });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    for (const lock of held.reverse()) await writer.query('SELECT pg_advisory_unlock($1)', [lock]).catch(() => {});
    writer.release(); reader.release(); await primary.end(); await replica.end();
  }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, checkTotals, readDay, applyDay };
