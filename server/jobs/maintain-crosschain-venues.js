#!/usr/bin/env node
"use strict";

// Production Maya/THORChain maintenance. Separate from the NEAR jobs: Midgard
// is an independent provider, so this never takes the NEAR flock or quota.
// Each run: incremental sync from the head, bounded backfill until the
// provider history is exhausted, then a small pending-action refresh.
const { performance } = require("node:perf_hooks");
const { loadEnv } = require("../lib/job-utils");
const { getPool } = require("../lib/db-pool");
const { logSafeError } = require("../api/lib/safe-log");
const { createVenueClient, VENUES } = require("../lib/crosschain/venue-providers");
const { traverseVenue, refreshUnsettled } = require("../lib/crosschain/venue-store");

// Worst case per provider page: 8s request timeout plus the inter-page delay.
const PAGE_BUDGET_MS = 10000;
const DEFAULTS = { syncPages: 3, backfillPages: 5, refreshPending: 2, delayMs: 1000, budgetMs: 150000 };

function parseOptions(args) {
  const options = { apply: false, venues: Object.keys(VENUES), ...DEFAULTS };
  const names = { "--venue": "venue", "--sync-pages": "syncPages", "--backfill-pages": "backfillPages",
    "--refresh-pending": "refreshPending", "--delay-ms": "delayMs", "--budget-ms": "budgetMs" };
  const seen = new Set();
  for (const arg of args) {
    if (arg === "--apply") { if (seen.has("apply")) throw new Error("Duplicate --apply"); options.apply = true; seen.add("apply"); continue; }
    const match = /^(--[a-z-]+)=(.+)$/.exec(arg);
    const key = match && names[match[1]];
    if (!key || seen.has(key)) throw new Error("Unknown or duplicate venue maintenance option");
    seen.add(key);
    if (key === "venue") options.venues = [match[2]];
    else options[key] = /^\d+$/.test(match[2]) ? Number(match[2]) : NaN;
  }
  if (!options.venues.every((venue) => Object.hasOwn(VENUES, venue)) ||
      !Number.isInteger(options.syncPages) || options.syncPages < 1 || options.syncPages > 50 ||
      !Number.isInteger(options.backfillPages) || options.backfillPages < 0 || options.backfillPages > 1000 ||
      !Number.isInteger(options.refreshPending) || options.refreshPending < 0 || options.refreshPending > 20 ||
      !Number.isInteger(options.delayMs) || options.delayMs < 300 || options.delayMs > 60000 ||
      !Number.isInteger(options.budgetMs) || options.budgetMs < 10000 || options.budgetMs > 6 * 3600000)
    throw new Error("Usage: [--venue=maya|thorchain] [--sync-pages=1..50] [--backfill-pages=0..1000] [--refresh-pending=0..20] [--delay-ms=300..60000] [--budget-ms=10000..21600000] [--apply]");
  return options;
}

async function maintainVenue(pool, client, venue, options, remaining, log,
  { traverse = traverseVenue, refresh: refreshPending = refreshUnsettled } = {}) {
  const result = { venue };
  const pagesFor = (wanted) => Math.min(wanted, Math.floor(remaining() / PAGE_BUDGET_MS));
  const syncPages = pagesFor(options.syncPages);
  if (syncPages < 1) return { ...result, yielded: "budget" };
  result.sync = await traverse(pool, client, { venue, mode: "sync", maxPages: syncPages, delayMs: options.delayMs, log });
  const backfillPages = pagesFor(options.backfillPages);
  if (backfillPages > 0)
    result.backfill = await traverse(pool, client, { venue, mode: "backfill", maxPages: backfillPages, delayMs: options.delayMs, log });
  const refresh = pagesFor(options.refreshPending);
  if (refresh > 0 && result.sync.complete)
    result.refresh = await refreshPending(pool, client, { venue, limit: refresh, delayMs: options.delayMs });
  return result;
}

async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args);
  if (!options.apply) {
    console.log(JSON.stringify({ writes: false, ...options, pageBudgetMs: PAGE_BUDGET_MS,
      schema: "server/scripts/create-crosschain-venues.sql" }));
    return;
  }
  loadEnv(__dirname);
  if (env.NETWORK !== "mainnet" || env.CROSSCHAIN_VENUES_WRITER_ENABLED !== "1")
    throw new Error("Requires NETWORK=mainnet and CROSSCHAIN_VENUES_WRITER_ENABLED=1");
  const startedAt = performance.now();
  const remaining = () => options.budgetMs - (performance.now() - startedAt);
  const pool = getPool({ max: 1, statement_timeout: 15000, application_name: "crosschain-venues-maintain" });
  try {
    const identity = (await pool.query("SELECT current_database() AS name,pg_is_in_recovery() AS standby")).rows[0];
    if (identity.name !== "zcash_explorer_mainnet" || identity.standby)
      throw new Error("Venue maintenance requires the primary mainnet database");
    const log = (progress) => console.log(JSON.stringify(progress));
    for (const venue of options.venues) {
      // One provider failure must not stop the other venue; checkpoints persist per page.
      try {
        console.log(JSON.stringify(await maintainVenue(pool, createVenueClient({ venue }), venue, options, remaining, log)));
      } catch (err) {
        logSafeError(`Venue maintenance failed for ${venue}; checkpoint retained`, err);
        process.exitCode = 1;
      }
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((err) => {
  logSafeError("Venue maintenance failed; checkpoints retained", err);
  process.exitCode = 1;
});
module.exports = { parseOptions, maintainVenue, main, PAGE_BUDGET_MS };
