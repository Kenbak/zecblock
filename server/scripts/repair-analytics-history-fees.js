#!/usr/bin/env node
'use strict';

// Recompute only analytics_history_daily.fees percentiles after a transaction
// fee repair (e.g. Sprout JoinSplit fees). Same query as the daily job; keeps
// every other fees key (blockCount, minerDestinationRows) and all other
// columns. No financial replay. Dry-run by default; one UTC day per commit.
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { selectDays } = require('../lib/utxo-age');
const { loadEnv } = require('../lib/job-utils');

const FEE_KEYS = ['p10', 'p25', 'median', 'p75', 'p90', 'avgFee', 'txCount'];
const FEES_SQL = `SELECT percentile_cont(0.1) WITHIN GROUP(ORDER BY fee) p10,percentile_cont(0.25) WITHIN GROUP(ORDER BY fee) p25,
 percentile_cont(0.5) WITHIN GROUP(ORDER BY fee) median,percentile_cont(0.75) WITHIN GROUP(ORDER BY fee) p75,percentile_cont(0.9) WITHIN GROUP(ORDER BY fee) p90,
 AVG(fee) "avgFee",COUNT(*)::int "txCount" FROM transactions WHERE block_time >= $1 AND block_time < $2 AND NOT is_coinbase AND fee>0`;

function options(args) {
  const dateArgs = [], result = { apply: false, pauseMs: 50 };
  for (const arg of args) {
    if (/^--(from|to)=/.test(arg)) dateArgs.push(arg);
    else if (arg === '--apply') result.apply = true;
    else if (/^--report=.+/.test(arg)) result.report = arg.slice(9);
    else if (/^--pause-ms=\d+$/.test(arg)) result.pauseMs = Number(arg.slice(11));
    else throw new Error('Use --from=DATE --to=DATE [--apply --report=PATH] [--pause-ms=0..60000]');
  }
  if (dateArgs.length !== 2 || result.pauseMs > 60000) throw new Error('Explicit bounded dates (max 366) are required');
  result.dates = selectDays(dateArgs);
  if (result.apply && !result.report) throw new Error('Apply requires a new backup/report file');
  return result;
}

// pg returns numeric/float as strings or numbers depending on type; compare
// the JSON the daily job would store.
function normalize(fees) {
  const out = {};
  for (const key of FEE_KEYS) out[key] = fees?.[key] == null ? null : Number(fees[key]);
  return out;
}

function changed(before, after) {
  const a = normalize(before), b = normalize(after);
  return FEE_KEYS.some(key => a[key] !== b[key]);
}

async function run(args = process.argv.slice(2)) {
  const opt = options(args); loadEnv(__dirname);
  const { getPool } = require('../lib/db-pool');
  const primary = getPool({ max: 1, application_name: 'analytics-history-fee-repair' });
  const db = await primary.connect();
  let fd;
  const record = value => {
    const line = JSON.stringify(value) + '\n';
    if (fd !== undefined) { fs.writeSync(fd, line); fs.fsyncSync(fd); }
    if (value.event !== 'before-write') process.stdout.write(line);
  };
  let changedDays = 0;
  try {
    if (opt.report) fd = fs.openSync(opt.report, 'wx', 0o600);
    if ((await db.query('SELECT pg_is_in_recovery() recovery')).rows[0].recovery) throw new Error('Repair requires the primary');
    record({ event: 'start', apply: opt.apply, from: opt.dates[0], to: opt.dates.at(-1) });
    for (const date of opt.dates) {
      const start = Date.parse(`${date}T00:00:00Z`) / 1000;
      await db.query('BEGIN');
      try {
        await db.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
        const row = (await db.query('SELECT fees FROM analytics_history_daily WHERE date=$1 FOR UPDATE', [date])).rows[0];
        if (!row) { await db.query('ROLLBACK'); record({ event: 'missing', date }); continue; }
        const fresh = (await db.query(FEES_SQL, [start, start + 86400])).rows[0];
        if (!changed(row.fees, fresh)) { await db.query('ROLLBACK'); continue; }
        changedDays += 1;
        const after = { ...(row.fees || {}), ...fresh };
        if (!opt.apply) {
          await db.query('ROLLBACK');
          record({ event: 'dry-run', date, before: normalize(row.fees), after: normalize(after) });
          continue;
        }
        record({ event: 'before-write', date, before: row.fees });
        await db.query('UPDATE analytics_history_daily SET fees=$2::jsonb WHERE date=$1', [date, JSON.stringify(after)]);
        await db.query('COMMIT');
        record({ event: 'committed', date, before: normalize(row.fees), after: normalize(after) });
      } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
      if (opt.pauseMs) await delay(opt.pauseMs);
    }
    record({ event: 'complete', days: opt.dates.length, changedDays, apply: opt.apply });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    db.release(); await primary.end();
  }
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, normalize, changed, FEES_SQL };
