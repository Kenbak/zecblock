#!/usr/bin/env node
/**
 * INTERNAL read-only report of competing-block collector coverage (migration 042):
 * streaming fraction since timing began, timed gaps with reasons, journal use,
 * the latest node fork-tip audit and recent uncaptured fork blocks.
 * Not exposed publicly (owner decision 2026-11-05).
 *
 * Usage (on the serving host):
 *   sudo -u postgres node server/scripts/capture-coverage-report.js --db=zcash_explorer_mainnet [--misses=100]
 *   DATABASE_URL=postgres://... node server/scripts/capture-coverage-report.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../api/.env'), quiet: true });
const { Pool } = require('pg');
const { captureCoverageReport } = require('../api/lib/capture-coverage');

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

async function main() {
  const db = arg('db');
  const pool = process.env.DATABASE_URL && !db
    ? new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    : new Pool(db
      ? { host: '/var/run/postgresql', database: db, max: 1 }
      : { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 1 });
  try {
    await pool.query("SET default_transaction_read_only = on; SET statement_timeout = '10s'");
    const report = await captureCoverageReport(pool, { missLimit: Number(arg('misses') ?? 100) });
    if (!report) {
      console.error('Migration 042 is not applied on this database.');
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  // Never print connection strings; the error message alone is enough here.
  console.error('Coverage report failed:', error.message);
  process.exit(1);
});
