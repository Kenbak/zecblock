#!/usr/bin/env node
/**
 * Backfill daily chain_snapshots for blockchain size history chart.
 * Estimates size from current size_on_disk / block height.
 * Usage: node server/scripts/backfill-chain-size-snapshots.js [--days=400]
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
    body: JSON.stringify({ jsonrpc: '2.0', id: 'backfill-size', method, params }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

async function main() {
  log(`=== Backfill chain_snapshots (${DAYS} days) ===`);

  const info = await callZebraRPC('getblockchaininfo');
  const currentHeight = parseInt(info.blocks, 10) || 0;
  const currentSize = parseInt(info.size_on_disk, 10) || 0;
  const chainSupply = parseInt(info.chainSupply?.chainValueZat, 10) || 0;

  const pools = {};
  for (const p of info.valuePools || []) {
    pools[p.id] = parseInt(p.chainValueZat, 10) || 0;
  }

  if (currentHeight <= 0 || currentSize <= 0) throw new Error('Invalid blockchain info from Zebra');
  const schedule = networkSchedule(info);
  if (!schedule) throw new Error('Could not read the network upgrade schedule from Zebra');

  const bytesPerBlock = currentSize / currentHeight;
  log(`Current: ${(currentSize / 1e9).toFixed(2)} GB at height ${currentHeight.toLocaleString()}`);

  let inserted = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    d.setUTCHours(12, 0, 0, 0);
    const dateStr = d.toISOString().split('T')[0];

    const existing = await pool.query(
      `SELECT 1 FROM chain_snapshots WHERE snapshot_time::date = $1::date LIMIT 1`,
      [dateStr]
    );
    if (existing.rows.length > 0) continue;

    const daysAgo = i;
    const height = Math.max(1, heightBefore(schedule, currentHeight, daysAgo * 86400));
    const sizeBytes = Math.round(bytesPerBlock * height);
    const supplyZat = Math.max(0, chainSupply - daysAgo * 1800 * 1e8);

    await pool.query(
      `INSERT INTO chain_snapshots (
        snapshot_time, block_height, chain_size_bytes, chain_supply_zat,
        sprout_zat, sapling_zat, orchard_zat, transparent_zat
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        d.toISOString(),
        height,
        sizeBytes,
        supplyZat,
        pools.sprout || 0,
        pools.sapling || 0,
        pools.orchard || 0,
        pools.transparent || 0,
      ]
    );
    inserted += 1;
  }

  log(`Inserted ${inserted} daily snapshot rows`);
  const count = await pool.query(`SELECT COUNT(*) AS n FROM chain_snapshots`);
  log(`Total snapshots: ${count.rows[0].n}`);
  await pool.end();
  log('=== Done ===');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
