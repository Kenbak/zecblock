#!/usr/bin/env node
/**
 * Backfill per-pool columns from Zebra getblock valuePools at historical heights.
 * One RPC pair (getblockhash + getblock) per day — ~10 min for 400 days.
 *
 * Usage: node server/scripts/backfill-pool-columns-from-zebra.js [--days=400]
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../api/.env') });

const { Pool } = require('pg');
const { networkSchedule, heightBefore } = require('../api/lib/network-schedule');

const DAYS = parseInt(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '400', 10);
const ZEBRA_RPC_URL = process.env.ZEBRA_RPC_URL || 'http://127.0.0.1:8232';
const ZEBRA_COOKIE_FILE = process.env.ZEBRA_RPC_COOKIE_FILE || '/root/.cache/zebra/.cookie';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 3,
});

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callZebraRPC(method, params = []) {
  let auth = '';
  try {
    const cookie = fs.readFileSync(ZEBRA_COOKIE_FILE, 'utf8').trim();
    auth = `Basic ${Buffer.from(cookie).toString('base64')}`;
  } catch {
    // no auth
  }
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;

  const response = await fetch(ZEBRA_RPC_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'pool-zebra', method, params }),
  });
  const data = await response.json();
  if (data.error) throw new Error(`${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

function poolZat(entry) {
  if (!entry) return '0';
  if (entry.chainValueZat != null) return String(entry.chainValueZat);
  if (entry.chainValue != null) return String(Math.round(parseFloat(entry.chainValue) * 1e8));
  return '0';
}

function zatSum(...parts) {
  return parts.reduce((sum, p) => sum + BigInt(p || '0'), 0n).toString();
}

async function main() {
  log(`=== Zebra per-pool backfill (${DAYS} days) ===`);

  const info = await callZebraRPC('getblockchaininfo');
  const currentHeight = parseInt(info.blocks, 10) || 0;
  log(`Tip height: ${currentHeight.toLocaleString()}`);
  const schedule = networkSchedule(info);
  if (!schedule) throw new Error('Could not read the network upgrade schedule from Zebra');

  const { rows } = await pool.query(
    `SELECT date FROM privacy_trends_daily
     WHERE date >= CURRENT_DATE - $1::int
       AND pool_size > 0
     ORDER BY date ASC`,
    [DAYS]
  );

  log(`Processing ${rows.length} daily rows…`);

  let updated = 0;
  let failed = 0;

  for (const row of rows) {
    const dateStr = row.date.toISOString?.().slice(0, 10) || String(row.date).slice(0, 10);
    const daysAgo = Math.max(0, Math.round((Date.now() - new Date(`${dateStr}T12:00:00Z`).getTime()) / 86400000));
    const height = Math.max(1, heightBefore(schedule, currentHeight, daysAgo * 86400));

    try {
      const hash = await callZebraRPC('getblockhash', [height]);
      const block = await callZebraRPC('getblock', [hash, 1]);
      const valuePools = block?.valuePools;
      if (!valuePools?.length) throw new Error('no valuePools on block');

      const byId = {};
      for (const p of valuePools) byId[p.id] = p;

      const sprout = poolZat(byId.sprout);
      const sapling = poolZat(byId.sapling);
      const orchard = poolZat(byId.orchard);
      const transparent = poolZat(byId.transparent);
      const shielded = zatSum(sprout, sapling, orchard);
      const chainSupply = zatSum(transparent, shielded, poolZat(byId.lockbox));

      await pool.query(
        `UPDATE privacy_trends_daily SET
          pool_size = $2::bigint,
          sprout_pool_size = $3::bigint,
          sapling_pool_size = $4::bigint,
          orchard_pool_size = $5::bigint,
          transparent_pool_size = $6::bigint,
          chain_supply = COALESCE(NULLIF($7::bigint, 0), chain_supply)
        WHERE date = $1`,
        [dateStr, shielded, sprout, sapling, orchard, transparent, chainSupply]
      );
      updated += 1;

      if (updated % 25 === 0) {
        log(`  ${updated}/${rows.length} — latest ${dateStr} h=${height} O=${(Number(orchard) / 1e8).toFixed(0)}M S=${(Number(sapling) / 1e8).toFixed(0)}M`);
      }
    } catch (err) {
      failed += 1;
      if (failed <= 5) log(`  WARN ${dateStr} h~${height}: ${err.message}`);
    }

    if (updated % 10 === 0) await sleep(50);
  }

  log(`Done: ${updated} updated, ${failed} failed`);

  const sample = await pool.query(`
    SELECT date,
      ROUND(orchard_pool_size::numeric / NULLIF(pool_size, 0) * 100, 1) AS orchard_pct,
      ROUND(sapling_pool_size::numeric / NULLIF(pool_size, 0) * 100, 1) AS sapling_pct
    FROM privacy_trends_daily
    WHERE orchard_pool_size > 0
    ORDER BY date ASC
    LIMIT 1
  `);
  const recent = await pool.query(`
    SELECT date,
      ROUND(orchard_pool_size::numeric / NULLIF(pool_size, 0) * 100, 1) AS orchard_pct,
      ROUND(sapling_pool_size::numeric / NULLIF(pool_size, 0) * 100, 1) AS sapling_pct
    FROM privacy_trends_daily
    WHERE orchard_pool_size > 0
    ORDER BY date DESC
    LIMIT 1
  `);
  if (sample.rows[0] && recent.rows[0]) {
    const s = sample.rows[0];
    const r = recent.rows[0];
    log(`Orchard share: ${s.date.toISOString?.().slice(0, 10)} ${s.orchard_pct}% → ${r.date.toISOString?.().slice(0, 10)} ${r.orchard_pct}%`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
