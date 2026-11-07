#!/usr/bin/env node
/**
 * Cross-chain shielded-rate refresh.
 *
 * Classifies successful NEAR 1Click ZEC inflows into crosschain_shielding
 * (migration 044) using the Turnstile one-hop rules. Idempotent: each batch
 * deletes and recomputes the selected swap identities in one transaction.
 *
 * Each run, bounded by --batch (default 500, max 5000):
 *   1. unclassified successful inflows, oldest first (this is also the backfill)
 *   2. provider records updated since classification (late tx hash / status)
 *   3. open rows: delivery not indexed, unmatched, or held outputs (<=120 days)
 *
 * Flags:
 *   --backfill    loop step 1 until no unclassified swaps remain (max --max-batches)
 *   --sweep       also prune rows that are no longer successful inflows
 *   --dry-run     report what would be selected, write nothing
 *
 * Cron (after maintain-crosschain-v2 and refresh-turnstile):
 *   4-59/5 * * * * flock -n /run/cipherscan-crosschain-shielding.lock bash -lc 'cd /root/cipherscan/server/jobs && node refresh-crosschain-shielding.js' >> /var/log/cipherscan/refresh-crosschain-shielding.log 2>&1
 *   30 4 * * *     flock -n /run/cipherscan-crosschain-shielding.lock bash -lc 'cd /root/cipherscan/server/jobs && node refresh-crosschain-shielding.js --sweep' >> /var/log/cipherscan/refresh-crosschain-shielding.log 2>&1
 */
const { log, loadEnv, withAdvisoryLock } = require("../lib/job-utils");
loadEnv(__dirname);

const { getPool } = require("../lib/db-pool");
const { classifySwaps, findUnclassified, findOpen, findChanged, pruneStale } = require("../lib/crosschain/shielding");

// Temp tables are connection-scoped: stay on one primary client, like Turnstile.
const pool = getPool({ max: 2 });
const LOCK_ID = 839272;

function intFlag(name, fallback, min, max) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be ${min}..${max}`);
  return n;
}
const BATCH = intFlag("batch", 500, 1, 5000);
const MAX_BATCHES = intFlag("max-batches", 200, 1, 10000);
const BACKFILL = process.argv.includes("--backfill");
const SWEEP = process.argv.includes("--sweep");
const DRY_RUN = process.argv.includes("--dry-run");
const v2 = process.env.CROSSCHAIN_V2_READ_ENABLED === "1";

const dedupe = (rows) => {
  const seen = new Map();
  for (const r of rows) seen.set(`${r.address}\u0000${r.memo}`, r);
  return [...seen.values()];
};

async function run(client) {
  let written = 0;
  let batches = 0;
  // 1. unclassified (backfill loops; incremental takes one batch)
  for (;;) {
    const fresh = await findUnclassified(client, { v2, limit: BATCH });
    if (fresh.length === 0) break;
    batches += 1;
    if (DRY_RUN) { log(`[dry-run] would classify ${fresh.length} new swap(s)`); break; }
    written += await classifySwaps(client, fresh, { v2 });
    log(`Classified ${fresh.length} new swap(s) (batch ${batches})`);
    if (!BACKFILL || batches >= MAX_BATCHES || fresh.length < BATCH) break;
  }
  // 2 + 3. changed provider records and open rows
  const recheck = dedupe([
    ...(await findChanged(client, { v2, limit: BATCH })),
    ...(await findOpen(client, { limit: BATCH })),
  ]);
  if (recheck.length) {
    if (DRY_RUN) log(`[dry-run] would recheck ${recheck.length} swap(s)`);
    else {
      written += await classifySwaps(client, recheck, { v2 });
      log(`Rechecked ${recheck.length} swap(s)`);
    }
  }
  if (SWEEP && !DRY_RUN) log(`Pruned ${await pruneStale(client, { v2 })} stale row(s)`);
  return written;
}

async function main() {
  const start = Date.now();
  log(`=== Cross-chain shielding refresh (${v2 ? "v2" : "legacy"} source${BACKFILL ? ", backfill" : ""}${SWEEP ? ", sweep" : ""}${DRY_RUN ? ", dry-run" : ""}) ===`);
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '120s'");
    await withAdvisoryLock(client, LOCK_ID, async (c) => {
      const written = await run(c);
      log(`=== Done: ${written} row(s) in ${((Date.now() - start) / 1000).toFixed(2)}s ===`);
    });
  } catch (err) {
    log(`ERROR: ${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main();
