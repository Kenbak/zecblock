#!/usr/bin/env node
"use strict";

// Explicit local writer. No dotenv/config discovery, schema auto-application,
// production services, NEAR tables, cron or standby activation.
const { createVenueClient, VENUES } = require("../lib/crosschain/venue-providers");
const { traverseVenue, refreshUnsettled } = require("../lib/crosschain/venue-store");

function parseOptions(args) {
  const options = { apply: false, venue: null, mode: "backfill", maxPages: 20, delayMs: 1000, pageSize: 50, refreshPending: 0 };
  const names = { "--venue": "venue", "--mode": "mode", "--max-pages": "maxPages", "--delay-ms": "delayMs",
    "--page-size": "pageSize", "--refresh-pending": "refreshPending" };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") { if (seen.has("apply")) throw new Error("Duplicate --apply"); options.apply = true; seen.add("apply"); continue; }
    const [name, ...tail] = args[i].split("=");
    const key = names[name];
    if (!key || seen.has(key)) throw new Error("Unknown or duplicate venue writer option");
    const value = tail.length ? tail.join("=") : args[++i];
    if (!value || value.startsWith("--")) throw new Error("Venue writer option requires a value");
    seen.add(key);
    options[key] = ["venue", "mode"].includes(key) ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  }
  if (!Object.hasOwn(VENUES, options.venue) || !["backfill", "sync"].includes(options.mode) ||
      !Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 1000 ||
      !Number.isInteger(options.delayMs) || options.delayMs < 300 || options.delayMs > 60000 ||
      !Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50 ||
      !Number.isInteger(options.refreshPending) || options.refreshPending < 0 || options.refreshPending > 20 ||
      (options.refreshPending > 0 && options.mode !== "sync"))
    throw new Error("Usage: --venue=maya|thorchain [--mode=backfill|sync] [--max-pages=1..1000] [--delay-ms=300..60000] [--page-size=1..50] [--refresh-pending=0..20 (sync only)] [--apply]");
  return options;
}
function localDatabaseConfig(value) {
  if (!value) throw new Error("Explicit isolated local DATABASE_URL is required; no existing explorer config is loaded");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid local DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["", "localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.pathname || url.pathname === "/" ||
      [...url.searchParams.keys()].some((key) => !["host", "sslmode", "application_name"].includes(key)) ||
      (url.searchParams.has("host") && !["localhost", "127.0.0.1", "::1", "/tmp", "/var/run/postgresql"].includes(url.searchParams.get("host"))))
    throw new Error("Venue writer is restricted to an explicitly selected local database");
  for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1)
    throw new Error("Duplicate database URL options are not allowed");
  let database, user, password;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch { throw new Error("Invalid local DATABASE_URL encoding"); }
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new Error("Invalid local database name");
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local database port");
  // Pin the host explicitly so PGHOST or a duplicate DSN parameter cannot turn
  // an apparently local URL into a remote connection.
  return { host: url.searchParams.get("host") || url.hostname.replace(/^\[|\]$/g, "") || "/tmp",
    port, database, user, password, ssl: false, max: 1, statement_timeout: 15000,
    application_name: "zecblock-venue-local-writer" };
}
async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args);
  if (!options.apply) {
    console.log(JSON.stringify({ ...options, writes: false, schema: "server/scripts/create-crosschain-venues.sql",
      action: "Create an isolated local database, apply the additive schema explicitly, then provide DATABASE_URL and --apply. No existing explorer configuration is used." }));
    return;
  }
  const config = localDatabaseConfig(env.DATABASE_URL);
  const { Pool } = require("pg");
  const pool = new Pool(config);
  try {
    const client = createVenueClient({ venue: options.venue });
    const result = await traverseVenue(pool, client, { ...options, log: (progress) => console.log(JSON.stringify(progress)) });
    console.log(JSON.stringify({ ...result, checkpoint: result.checkpoint ? {
      completedAt: result.checkpoint.completed_at, asOf: result.checkpoint.as_of,
      oldest: result.checkpoint.earliest_seen_at, newest: result.checkpoint.latest_seen_at,
      totalPages: result.checkpoint.pages, processedActions: result.checkpoint.actions,
    } : null }));
    if (options.refreshPending && result.complete) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      console.log(JSON.stringify(await refreshUnsettled(pool, client, {
        venue: options.venue, limit: options.refreshPending, delayMs: options.delayMs,
      })));
    }
  } finally { await pool.end(); }
}
if (require.main === module) main().catch((err) => {
  // Intentionally do not emit a DSN, raw response, PostgreSQL detail or stack.
  console.error(JSON.stringify({ error: "Venue writer failed; committed checkpoints preserved", code: err.code || "VENUE_WRITER_FAILED" }));
  process.exitCode = 1;
});
module.exports = { parseOptions, localDatabaseConfig, main };
