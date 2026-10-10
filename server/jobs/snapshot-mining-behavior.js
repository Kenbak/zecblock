#!/usr/bin/env node
/**
 * Mining Behavior Snapshot Job
 *
 * Pre-computes daily miner sell/hold metrics by checking whether coinbase
 * outputs have been spent (via transaction_inputs.prev_txid lookup).
 *
 * Maintains the mining_behavior_daily table.
 *
 * Modes:
 *   node snapshot-mining-behavior.js              — incremental (last 7 days)
 *   node snapshot-mining-behavior.js --backfill   — full history (slow, hours)
 *
 * Cron:
 *   0 5 * * * cd /root/cipherscan/server/jobs && node snapshot-mining-behavior.js >> /var/log/mining-behavior.log 2>&1
 */

const { log, loadEnv, withAdvisoryLock } = require('../lib/job-utils');
if (require.main === module) loadEnv(__dirname);

const { getPool, getReadPool } = require('../lib/db-pool');

const pool = require.main === module ? getPool({ max: 3 }) : null;
// The per-day work below is read (SELECT aggregate) then write (DELETE +
// INSERT), as two separate, already-autocommitted statement groups — there
// is no explicit BEGIN/COMMIT spanning them (withAdvisoryLock only takes a
// session-level pg_advisory_lock, not a SQL transaction), so the read half
// can safely move to the replica without ever mixing a single transaction
// across primary/replica.
const readPool = require.main === module ? getReadPool({ max: 3 }) : null;

const LOCK_ID = 839275;
const BACKFILL_MODE = process.argv.includes('--backfill');
const DAYS_FLAG = process.argv.find(a => a.startsWith('--days='));
const INCREMENTAL_DAYS = DAYS_FLAG ? parseInt(DAYS_FLAG.split('=')[1]) : 7;

// Share the API registry so snapshots cannot retain obsolete pool identities.
const { getPoolName } = require('../api/mining-pools');
function getPoolNameForAddress(address) {
  return getPoolName(address) || 'Other';
}

/**
 * Compute miner behavior for a single date.
 * Uses a join between coinbase outputs and transaction_inputs to detect spends.
 */
async function readDay(reader, dateStr) {
  const dayStart = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
  const dayEnd = dayStart + 86400;

  const result = await reader.query(`
    WITH coinbase_txs AS MATERIALIZED (
      SELECT b.miner_address, t.txid
      FROM blocks b
      JOIN transactions t ON t.block_height = b.height AND t.is_coinbase = true
      WHERE b.timestamp >= $1 AND b.timestamp < $2
        AND b.miner_address IS NOT NULL
        AND b.miner_address NOT IN ('t3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow', 't2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu')
    ),
    all_cb_outputs AS MATERIALIZED (
      SELECT txo.txid, txo.vout_index, txo.value, txo.address
      FROM transaction_outputs txo
      WHERE txo.txid IN (SELECT txid FROM coinbase_txs)
    ),
    day_coinbase AS (
      SELECT ct.miner_address, o.txid as coinbase_txid, o.vout_index, o.value
      FROM coinbase_txs ct
      JOIN all_cb_outputs o ON o.txid = ct.txid AND o.address = ct.miner_address
    )
    SELECT dc.miner_address, COUNT(*) as output_count,
      SUM(dc.value) as total_earned,
      SUM(CASE WHEN ti.txid IS NOT NULL THEN dc.value ELSE 0 END) as total_spent,
      SUM(CASE WHEN ti.txid IS NOT NULL THEN 1 ELSE 0 END) as spent_count
    FROM day_coinbase dc
    LEFT JOIN transaction_inputs ti
      ON ti.prev_txid = dc.coinbase_txid AND ti.prev_vout = dc.vout_index
    GROUP BY dc.miner_address
  `, [dayStart, dayEnd]);

  const blockCounts = await reader.query(`
    SELECT miner_address, COUNT(*) as blocks
    FROM blocks
    WHERE timestamp >= $1 AND timestamp < $2
      AND miner_address IS NOT NULL
      AND miner_address NOT IN ('t3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow', 't2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu')
    GROUP BY miner_address
  `, [dayStart, dayEnd]);

  const blockMap = {};
  for (const row of blockCounts.rows) {
    blockMap[row.miner_address] = parseInt(row.blocks);
  }

  const poolAgg = {};
  for (const row of result.rows) {
    const poolName = getPoolNameForAddress(row.miner_address);
    if (!poolAgg[poolName]) {
      poolAgg[poolName] = {
        address: row.miner_address,
        earned: 0n,
        spent: 0n,
        blocks: 0,
        outputsSpent: 0,
        outputsTotal: 0,
      };
    }
    const entry = poolAgg[poolName];
    entry.earned += BigInt(row.total_earned || 0);
    entry.spent += BigInt(row.total_spent || 0);
    entry.blocks += blockMap[row.miner_address] || 0;
    entry.outputsSpent += parseInt(row.spent_count || 0);
    entry.outputsTotal += parseInt(row.output_count || 0);
  }

  return poolAgg;
}

async function writeDay(client, dateStr, poolAgg) {
  await client.query('DELETE FROM mining_behavior_daily WHERE date = $1', [dateStr]);

  for (const [poolName, data] of Object.entries(poolAgg)) {
    const held = data.earned - data.spent;
    await client.query(`
      INSERT INTO mining_behavior_daily
        (date, pool_name, miner_address, earned_zat, spent_zat, held_zat, blocks_mined, outputs_spent, outputs_total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      dateStr,
      poolName,
      data.address,
      data.earned.toString(),
      data.spent.toString(),
      held.toString(),
      data.blocks,
      data.outputsSpent,
      data.outputsTotal,
    ]);
  }

  return Object.keys(poolAgg).length;
}

async function computeDay(client, dateStr, reader = readPool) {
  return writeDay(client, dateStr, await readDay(reader, dateStr));
}

async function run() {
  const client = await pool.connect();
  try {
    await withAdvisoryLock(client, LOCK_ID, async (client) => {
      log(`Starting mining behavior snapshot (${BACKFILL_MODE ? 'BACKFILL' : 'incremental'})...`);

      let startDate;
      if (BACKFILL_MODE) {
        const earliest = await readPool.query(
          `SELECT MIN(date_trunc('day', to_timestamp(timestamp)))::date as min_date FROM blocks WHERE miner_address IS NOT NULL`
        );
        startDate = earliest.rows[0]?.min_date || new Date('2016-10-28');
      } else {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - INCREMENTAL_DAYS);
      }

      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1);

      let current = new Date(startDate);
      let daysProcessed = 0;

      while (current <= endDate) {
        const dateStr = current.toISOString().slice(0, 10);
        const poolCount = await computeDay(client, dateStr);
        daysProcessed++;

        if (daysProcessed % 30 === 0 || !BACKFILL_MODE) {
          log(`  ${dateStr}: ${poolCount} pools`);
        }

        current.setDate(current.getDate() + 1);
      }

      log(`Done. Processed ${daysProcessed} days.`);
    });
  } catch (error) {
    log(`ERROR: ${error.message}`);
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    if (readPool !== pool) await readPool.end();
  }
}

if (require.main === module) run();
module.exports = { computeDay, readDay, writeDay };
