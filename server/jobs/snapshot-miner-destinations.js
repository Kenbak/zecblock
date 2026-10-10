#!/usr/bin/env node
/**
 * Miner Destination Snapshot Job
 *
 * Complements snapshot-mining-behavior.js. For each day, classifies how a
 * pool's SPENT coinbase rewards left its payout address:
 *   - shielded  → swept into the shielded pool (privacy move, likely still held)
 *   - exchange  → sent to a labeled exchange address (real off-ramp)
 *   - bridge    → sent to a labeled bridge address (cross-chain off-ramp)
 *   - other     → moved to another transparent address (rotation/cold storage)
 *
 * Writes into `miner_destination_daily` (date, pool_name, shielded/exchange/
 * bridge/other _zat). That table is created by an out-of-band migration; this
 * job intentionally contains no DDL.
 *
 * Modes:
 *   node snapshot-miner-destinations.js              — incremental (last 7 days)
 *   node snapshot-miner-destinations.js --from=2020-01-01 --to=2020-01-31 — bounded complete UTC days
 *
 * Cron (after the behavior job):
 *   15 5 * * * cd /root/cipherscan/server/jobs && node snapshot-miner-destinations.js >> /var/log/miner-destinations.log 2>&1
 */

const { log, loadEnv, withAdvisoryLock } = require('../lib/job-utils');
if (require.main === module) loadEnv(__dirname);

const { getPool, getReadPool } = require('../lib/db-pool');

const pool = require.main === module ? getPool({ max: 2 }) : null;
// Classification uses a repeatable read on the replica. The per-day replacement
// is atomic on the primary after verifying its canonical source anchor.
const readPool = require.main === module ? getReadPool({ max: 1 }) : null;

const LOCK_ID = 839276;
const { selectDays } = require('../lib/utxo-age');

// Share the API registry so snapshots cannot retain obsolete pool identities.
const { getPoolName } = require('../api/mining-pools');
function getPoolNameForAddress(address) {
  return getPoolName(address) || 'Other';
}

/**
 * Classify a single day's spent coinbase rewards by destination.
 * Priority: shielded > exchange > bridge > other (matches the turnstile job).
 */
async function readDay(reader, dateStr) {
  const dayStart = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
  const dayEnd = dayStart + 86400;

  const result = await reader.query(
    `
    WITH cb AS MATERIALIZED (
      SELECT b.miner_address, t.txid
      FROM blocks b
      JOIN transactions t ON t.block_height = b.height AND t.is_coinbase = true
      WHERE b.timestamp >= $1 AND b.timestamp < $2
        AND b.miner_address IS NOT NULL
        AND b.miner_address NOT IN ('t3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow', 't2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu')
    ),
    -- Resolve by transaction first: address bitmap intersections can scan a
    -- large pool/exchange address index once per reward. Classify each output once.
    cbo AS MATERIALIZED (
      SELECT ct.miner_address, o.txid AS cbtxid, o.vout_index, o.value
      FROM cb ct
      CROSS JOIN LATERAL (
        SELECT txid,vout_index,value,address FROM transaction_outputs
        WHERE txid=ct.txid OFFSET 0
      ) o
      WHERE o.address = ct.miner_address
    ),
    sp AS MATERIALIZED (
      SELECT c.miner_address, c.value, ti.txid AS stx
      FROM cbo c
      LEFT JOIN transaction_inputs ti ON ti.prev_txid = c.cbtxid AND ti.prev_vout = c.vout_index
    ),
    cls AS MATERIALIZED (
      SELECT miner_address, value,
        CASE
          WHEN stx IS NULL THEN 'held'
          WHEN EXISTS (
            SELECT 1 FROM shielded_flows sf
            WHERE sf.txid = stx AND sf.flow_type = 'shield'
          ) THEN 'shielded'
          WHEN EXISTS (
            SELECT 1 FROM (SELECT address FROM transaction_outputs WHERE txid=stx OFFSET 0) o
            JOIN address_labels al ON al.address = o.address AND al.category = 'exchange'
          ) THEN 'exchange'
          WHEN EXISTS (
            SELECT 1 FROM (SELECT address FROM transaction_outputs WHERE txid=stx OFFSET 0) o
            JOIN address_labels al ON al.address = o.address AND al.category = 'bridge'
          ) THEN 'bridge'
          ELSE 'other'
        END AS cat
      FROM sp
    )
    SELECT miner_address,
      COALESCE(SUM(value) FILTER (WHERE cat = 'shielded'), 0) AS shielded,
      COALESCE(SUM(value) FILTER (WHERE cat = 'exchange'), 0) AS exchange,
      COALESCE(SUM(value) FILTER (WHERE cat = 'bridge'),   0) AS bridge,
      COALESCE(SUM(value) FILTER (WHERE cat = 'other'),    0) AS other
    FROM cls
    GROUP BY miner_address
  `,
    [dayStart, dayEnd]
  );

  const poolAgg = {};
  for (const row of result.rows) {
    const poolName = getPoolNameForAddress(row.miner_address);
    if (!poolAgg[poolName]) {
      poolAgg[poolName] = { shielded: 0n, exchange: 0n, bridge: 0n, other: 0n };
    }
    const e = poolAgg[poolName];
    e.shielded += BigInt(row.shielded || 0);
    e.exchange += BigInt(row.exchange || 0);
    e.bridge += BigInt(row.bridge || 0);
    e.other += BigInt(row.other || 0);
  }

  return poolAgg;
}

async function writeDay(client, dateStr, poolAgg) {
  await client.query('DELETE FROM miner_destination_daily WHERE date = $1', [dateStr]);

  for (const [poolName, d] of Object.entries(poolAgg)) {
    await client.query(
      `
      INSERT INTO miner_destination_daily
        (date, pool_name, shielded_zat, exchange_zat, bridge_zat, other_zat, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (date, pool_name) DO UPDATE SET
        shielded_zat = EXCLUDED.shielded_zat,
        exchange_zat = EXCLUDED.exchange_zat,
        bridge_zat = EXCLUDED.bridge_zat,
        other_zat = EXCLUDED.other_zat,
        updated_at = NOW()
    `,
      [dateStr, poolName, d.shielded.toString(), d.exchange.toString(), d.bridge.toString(), d.other.toString()]
    );
  }

  return Object.keys(poolAgg).length;
}

async function run() {
  const client = await pool.connect();
  try {
    await withAdvisoryLock(client, LOCK_ID, async (client) => {
      const dates = selectDays(process.argv.slice(2));
      for (const dateStr of dates) {
        const reader = await readPool.connect();
        let data, anchor;
        try {
          await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          anchor = (await reader.query('SELECT height,hash,timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
          if (!anchor || Number(anchor.timestamp) < Date.parse(dateStr+'T00:00:00Z')/1000+86400) throw new Error('Incomplete source day');
          data = await readDay(reader,dateStr);
          await reader.query('COMMIT');
        } catch (error) { await reader.query('ROLLBACK'); throw error; }
        finally { reader.release(); }
        await client.query('BEGIN');
        try {
          if (!(await client.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2',[anchor.height,anchor.hash])).rowCount) throw new Error('Source chain changed');
          await writeDay(client,dateStr,data);
          await client.query('COMMIT');
        } catch(error) { await client.query('ROLLBACK'); throw error; }
        log(`Completed ${dateStr}`);
      }
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
module.exports = { readDay, writeDay };
