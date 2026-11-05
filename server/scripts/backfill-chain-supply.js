#!/usr/bin/env node
/**
 * Backfill privacy_trends_daily.chain_supply with monotonic total chain supply.
 *
 * The chain_supply column must be TOTAL mined ZEC (from Zebra chainSupply),
 * NOT shielded pool size. Never use pool_size / ratio — that causes fake dips.
 *
 * Usage: node server/scripts/backfill-chain-supply.js [--days=400]
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../api/.env') });

const { Pool } = require('pg');
const { networkSchedule, heightBefore, targetSpacing } = require('../api/lib/network-schedule');

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
    body: JSON.stringify({ jsonrpc: '2.0', id: 'backfill-supply', method, params }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

async function getPerBlockSubsidyZat(height) {
  const sub = await callZebraRPC('getblocksubsidy', [height]);
  if (sub?.totalblocksubsidy == null) throw new Error(`No block subsidy from Zebra at height ${height}`);
  return Math.round(sub.totalblocksubsidy * 1e8);
}

async function main() {
  log(`=== Backfill chain_supply (${DAYS} days) ===`);

  const info = await callZebraRPC('getblockchaininfo');
  let supplyZat = parseInt(info.chainSupply?.chainValueZat, 10) || 0;
  let height = parseInt(info.blocks, 10) || 0;

  if (supplyZat <= 0) throw new Error('Could not read chain supply from Zebra');
  const schedule = networkSchedule(info);
  if (!schedule) throw new Error('Could not read the network upgrade schedule from Zebra');

  log(`Current: ${(supplyZat / 1e8).toFixed(4)} ZEC at height ${height.toLocaleString()}`);

  const dates = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  let updated = 0;
  const emissionCache = new Map();

  for (const dateStr of dates) {
    await pool.query(
      `UPDATE privacy_trends_daily SET chain_supply = $2 WHERE date = $1`,
      [dateStr, supplyZat]
    );
    updated += 1;

    // Subsidy per block changes with spacing (NU7) as well as halvings.
    const eraKey = `${Math.floor(height / 100000)}:${targetSpacing(schedule, height)}`;
    let perBlock = emissionCache.get(eraKey);
    if (perBlock == null) {
      perBlock = await getPerBlockSubsidyZat(height);
      emissionCache.set(eraKey, perBlock);
    }

    const previousHeight = Math.max(0, heightBefore(schedule, height, 86400));
    supplyZat = Math.max(0, supplyZat - perBlock * (height - previousHeight));
    height = previousHeight;
  }

  log(`Updated ${updated} daily rows (newest → oldest, monotonic when read forward)`);

  const sample = await pool.query(
    `SELECT date, ROUND(chain_supply / 1e8::numeric, 2) AS chain_m
     FROM privacy_trends_daily
     WHERE date >= CURRENT_DATE - INTERVAL '10 days' OR date <= CURRENT_DATE - INTERVAL '355 days'
     ORDER BY date ASC
     LIMIT 5`
  );
  log('Sample (oldest):');
  sample.rows.slice(0, 3).forEach((r) => log(`  ${r.date.toISOString?.().slice(0, 10) || r.date}: ${r.chain_m}M ZEC`));

  const recent = await pool.query(
    `SELECT date, ROUND(chain_supply / 1e8::numeric, 2) AS chain_m
     FROM privacy_trends_daily
     WHERE date >= CURRENT_DATE - INTERVAL '5 days'
     ORDER BY date ASC`
  );
  log('Sample (recent):');
  recent.rows.forEach((r) => log(`  ${r.date.toISOString?.().slice(0, 10) || r.date}: ${r.chain_m}M ZEC`));

  await pool.end();
  log('=== Done ===');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
