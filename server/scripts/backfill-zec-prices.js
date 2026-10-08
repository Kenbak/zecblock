#!/usr/bin/env node
'use strict';
// Normal collection is missing-only. A full-year import requires --backfill.
const { collectPrices, options } = require('../lib/daily-prices');
async function main(args = process.argv.slice(2)) {
  const opt = options(args);
  require('dotenv').config({ path: require('node:path').join(__dirname, '../api/.env'), quiet: true });
  const { Pool } = require('pg');
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000,
    application_name: 'daily-price-collector',
  });
  let client;
  try {
    client = await pool.connect();
    console.log(`[${new Date().toISOString()}] ${JSON.stringify(await collectPrices(client, opt))}`);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}
if (require.main === module) main().catch(error => {
  console.error(`[${new Date().toISOString()}] ${error.message}`);
  process.exitCode = 1;
});
module.exports = { main };
