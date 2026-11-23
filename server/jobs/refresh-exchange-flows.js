#!/usr/bin/env node
/**
 * Exchange flow refresh (migration 046)
 *
 * Maintains exchange_flows (one row per classified deposit/withdrawal of a
 * labelled exchange or custodian) and exchange_flow_daily (UTC day x entity,
 * exact zatoshi). Classifier: server/lib/exchange-flows.js. Store and reader
 * semantics: server/lib/exchange-flow-store.js.
 *
 * Modes:
 *   node refresh-exchange-flows.js             incremental: label repair (bounded),
 *                                              orphan removal, re-read of the last
 *                                              100 blocks (1000 after a tip reorg)
 *   node refresh-exchange-flows.js --rebuild   full history in height batches;
 *                                              resumes an interrupted rebuild
 *     --batch-blocks=N   blocks per rebuild batch (default 20000)
 *     --max-affected=N   label repair cap for incremental runs (default 100000)
 *
 * The incremental run does nothing until a --rebuild has completed. Readers
 * report the dataset as unavailable until then, and stale while labels,
 * classifier or tip have moved on.
 *
 * Cron (after the owner approves the migration and first rebuild):
 *   *\/5 * * * * cd /root/cipherscan/server/jobs && node refresh-exchange-flows.js >> /var/log/refresh-exchange-flows.log 2>&1
 */

const { log, loadEnv, withAdvisoryLock } = require('../lib/job-utils');
loadEnv(__dirname);

const { getPool } = require('../lib/db-pool');
const { loadLabels } = require('../lib/exchange-flows');
const store = require('../lib/exchange-flow-store');

// Writes and the reads they depend on stay on one primary connection: the
// canonical checks and the replace must see the same chain.
const pool = getPool({ max: 2 });
const LOCK_ID = 839320;
const intArg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
};
const REBUILD = process.argv.includes('--rebuild');
const BATCH = intArg('batch-blocks', store.BATCH_BLOCKS);
const MAX_AFFECTED = intArg('max-affected', store.MAX_AUTO_AFFECTED);

async function main() {
  const start = Date.now();
  log(`=== Exchange flow refresh${REBUILD ? ' (REBUILD)' : ''} ===`);
  const client = await pool.connect();
  try {
    await withAdvisoryLock(client, LOCK_ID, async c => {
      const labels = await loadLabels(c);
      log(`Labels ${labels.version}: ${labels.addresses.length} exchange-category addresses`);
      if (REBUILD) {
        const r = await store.rebuild(c, { labels, batchBlocks: BATCH, log });
        log(`Rebuild done: ${r.batches} batches, ${r.events} events, through ${r.tip.height}; read ${r.readMs}ms write ${r.writeMs}ms; skipped ${JSON.stringify(r.skipped)}`);
      } else {
        const r = await store.refresh(c, { labels, maxAffected: MAX_AFFECTED, log });
        if (r.action !== 'incremental') log(`Nothing written: ${r.action}. Run with --rebuild.`);
        else log(`Heights ${r.from}-${r.to}${r.reorged ? ' (tip reorg)' : ''}: ${r.inserted} events, ${r.deleted} replaced, ${r.days} days${r.deferred ? '; label repair deferred, data stale' : ''}`);
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
