#!/usr/bin/env node
/**
 * Shielded pool sources and destinations refresh (migration 048)
 *
 * Maintains shielded_pool_source_daily: per UTC day, pool, direction and
 * category, exact zatoshis of value entering/leaving each shielded pool.
 * Classifier, store and reader: server/lib/pool-sources.js.
 *
 * Modes:
 *   node refresh-pool-sources.js             incremental: re-reads from the day
 *                                            before the last covered block (further
 *                                            after a tip reorg) through today
 *   node refresh-pool-sources.js --rebuild   full history in UTC-day batches from
 *                                            the first indexed block; resumes an
 *                                            interrupted rebuild of the same version
 *     --batch-days=N   days per rebuild batch (default 7)
 *
 * The incremental run does nothing until a --rebuild has completed, and stops
 * (data reads stale) when the classifier, exchange labels or funding-stream
 * registry changed: run --rebuild again.
 *
 * Cron (after the owner approves the migration and first rebuild):
 *   *\/10 * * * * cd /root/cipherscan/server/jobs && node refresh-pool-sources.js >> /var/log/refresh-pool-sources.log 2>&1
 */

const { log, loadEnv, withAdvisoryLock } = require('../lib/job-utils');
loadEnv(__dirname);

const { getPool } = require('../lib/db-pool');
const store = require('../lib/pool-sources');

// Reads and the replace stay on one primary connection: the canonical join
// and the write must see the same chain.
const pool = getPool({ max: 2 });
const LOCK_ID = 839321;
const intArg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
};
const REBUILD = process.argv.includes('--rebuild');
const BATCH_DAYS = intArg('batch-days', store.BATCH_DAYS);

async function main() {
  const start = Date.now();
  log(`=== Pool sources refresh${REBUILD ? ' (REBUILD)' : ''} ===`);
  const client = await pool.connect();
  try {
    await withAdvisoryLock(client, LOCK_ID, async c => {
      const ctx = await store.loadContext(c);
      log(`Version ${ctx.version}: ${ctx.labelCount} exchange-labelled addresses, ${ctx.funding.size} funding-stream addresses`);
      if (REBUILD) {
        const r = await store.rebuild(c, { ctx, batchDays: BATCH_DAYS, log });
        log(`Rebuild done: ${r.batches} batches, ${r.txs} txs, ${r.rows} rows, from ${r.coverageFrom} through ${r.tip.height}; read ${r.readMs}ms write ${r.writeMs}ms; skipped ${JSON.stringify(r.skipped)}`);
      } else {
        const r = await store.refresh(c, { ctx, log });
        if (r.action !== 'incremental') log(`Nothing written: ${r.action}. Run with --rebuild.`);
        else log(`Days ${r.fromDay}..${r.toDay}${r.reorged ? ' (tip reorg)' : ''}: ${r.txs} txs, ${r.inserted} rows, ${r.deleted} replaced; skipped ${JSON.stringify(r.skipped)}`);
      }
    });
    log(`=== Done in ${((Date.now() - start) / 1000).toFixed(2)}s ===`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
