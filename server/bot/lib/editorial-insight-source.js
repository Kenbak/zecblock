'use strict';

const { addDays } = require('../../lib/transaction-activity');

const HISTORY_DAYS = 37; // Seven completed days, preceded by a disjoint 30-day baseline.

// Like readActivity, these are non-coinbase transactions, once per transaction.
// The canonical hash join and surrounding height span also reject retained
// orphan rows, missing blocks, missing coinbases and incomplete classification.
// Public flows use the same economic definition as editorial-data VALID_FLOWS:
// transparent I/O and the net Sapling + Orchard + Ironwood value balance.
// Deriving from canonical transactions avoids mistaking a missing derived
// shielded_flows row for a day with no flow. Sprout-involving transactions are
// excluded: a mixed Sprout-to-modern-pool move can otherwise resemble shielding
// even with transparent fee I/O. Fully shielded migrations are excluded too.
const INSIGHT_SQL = `
WITH window_heights AS MATERIALIZED (
  SELECT height FROM blocks WHERE timestamp >= $1 AND timestamp < $2
), bounds AS (
  SELECT MIN(height) AS first_height, MAX(height) AS last_height FROM window_heights
), height_range AS MATERIALIZED (
  SELECT b.height,b.hash,b.timestamp,b.transaction_count,b.total_fees
  FROM blocks b CROSS JOIN bounds r
  WHERE b.height BETWEEN GREATEST(r.first_height-1,0) AND r.last_height+1
), coverage AS (
  SELECT COUNT(b.height)=r.last_height-r.first_height+2
    + CASE WHEN r.first_height>0 THEN 1 ELSE 0 END AS complete
  FROM bounds r LEFT JOIN height_range b ON true GROUP BY r.first_height,r.last_height
), per_block AS (
  SELECT b.height,b.timestamp,b.transaction_count,b.total_fees,
    COUNT(t.txid) AS indexed_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase=true) AS coinbase_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase=false) AS total_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase=false AND NOT (
      (t.has_sprout IS NOT NULL OR t.sprout_joinsplit_count IS NOT NULL)
      AND (t.has_sapling IS NOT NULL
        OR (t.sapling_spend_count>0 OR t.sapling_output_count>0) IS TRUE
        OR (t.sapling_spend_count IS NOT NULL AND t.sapling_output_count IS NOT NULL))
      AND (t.has_orchard IS NOT NULL OR t.orchard_actions IS NOT NULL)
      AND (t.has_ironwood IS NOT NULL OR t.ironwood_actions IS NOT NULL)
    )) AS unknown_pool_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase=false AND (
      t.has_sprout=true OR t.sprout_joinsplit_count>0 OR t.has_sapling=true
      OR t.sapling_spend_count>0 OR t.sapling_output_count>0
      OR t.has_orchard=true OR t.orchard_actions>0
      OR t.has_ironwood=true OR t.ironwood_actions>0
    )) AS shielded_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase=false AND (
      t.vin_count IS NULL OR t.vout_count IS NULL
      OR t.value_balance_sapling IS NULL OR t.value_balance_orchard IS NULL
      OR t.value_balance_ironwood IS NULL
    )) AS unknown_flow_transactions,
    SUM(CASE WHEN t.is_coinbase=false AND (t.vin_count>0 OR t.vout_count>0)
      AND NOT (COALESCE(t.has_sprout,false) OR COALESCE(t.sprout_joinsplit_count,0)>0)
      THEN GREATEST(-(t.value_balance_sapling::numeric+t.value_balance_orchard::numeric
        +t.value_balance_ironwood::numeric),0) ELSE 0 END) AS shield_zat,
    SUM(CASE WHEN t.is_coinbase=false AND (t.vin_count>0 OR t.vout_count>0)
      AND NOT (COALESCE(t.has_sprout,false) OR COALESCE(t.sprout_joinsplit_count,0)>0)
      THEN GREATEST(t.value_balance_sapling::numeric+t.value_balance_orchard::numeric
        +t.value_balance_ironwood::numeric,0) ELSE 0 END) AS deshield_zat
  FROM height_range b LEFT JOIN transactions t ON t.block_height=b.height AND t.block_hash=b.hash
  WHERE b.timestamp >= $1 AND b.timestamp < $2
  GROUP BY b.height,b.timestamp,b.transaction_count,b.total_fees
), daily AS (
  SELECT (TO_TIMESTAMP(timestamp) AT TIME ZONE 'UTC')::date AS date,
    SUM(total_transactions)::text AS total_transactions,
    SUM(shielded_transactions)::text AS shielded_transactions,
    CASE WHEN COUNT(total_fees)=COUNT(*) AND MIN(total_fees)>=0 THEN SUM(total_fees)::text END AS fees_zat,
    BOOL_AND(unknown_flow_transactions=0) AS public_flow_complete,
    SUM(shield_zat)::text AS shield_zat,SUM(deshield_zat)::text AS deshield_zat,
    -- BOOL_AND ignores NULL inputs; unknown block counts must fail the day.
    BOOL_AND(COALESCE(transaction_count>=1 AND indexed_transactions=transaction_count
      AND coinbase_transactions=1 AND total_transactions+coinbase_transactions=indexed_transactions
      AND unknown_pool_transactions=0,false)) AS complete
  FROM per_block GROUP BY 1
)
SELECT day::date::text AS date,d.total_transactions,d.shielded_transactions,d.fees_zat,
  d.public_flow_complete,d.shield_zat,d.deshield_zat,
  COALESCE(d.complete AND c.complete,false) AS complete
FROM GENERATE_SERIES($3::date::timestamp,($4::date-1)::timestamp,INTERVAL '1 day') day
LEFT JOIN daily d ON d.date=day::date CROSS JOIN coverage c ORDER BY day`;

function safeCount(value, label) {
  if (value == null || value === '') throw new Error(`Unavailable insight ${label}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid insight ${label}`);
  return n;
}

function nonnegativeZat(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value).toString() : null;
}

async function readInsightSource(pool, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid insight time');
  const end = now.toISOString().slice(0,10), start = addDays(end,-HISTORY_DAYS);
  const startEpoch = Date.parse(`${start}T00:00:00Z`)/1000, endEpoch = Date.parse(`${end}T00:00:00Z`)/1000;
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Leave room for the shared client's 35-second timeout to receive the
    // server cancellation and roll back this read-only snapshot cleanly.
    await client.query("SET LOCAL statement_timeout = '25s'");
    const { rows: [network] } = await client.query('SELECT current_database() AS name');
    if (network?.name !== 'zcash_explorer_mainnet') throw new Error('Editorial insights are mainnet-only');
    const { rows: [row] } = await client.query('SELECT height,hash,timestamp FROM blocks ORDER BY height DESC LIMIT 1');
    if (!row) throw new Error('Insight tip unavailable or stale');
    const tip = { height: safeCount(row.height,'tip height'), hash: row.hash, timestamp: safeCount(row.timestamp,'tip timestamp') };
    const age = now.getTime()/1000-tip.timestamp;
    if (typeof tip.hash !== 'string' || !tip.hash || age>1800 || age< -7200 || tip.timestamp<endEpoch) {
      throw new Error('Insight tip unavailable or stale');
    }
    const { rows } = await client.query(INSIGHT_SQL,[startEpoch,endEpoch,start,end]);
    if (rows.length !== HISTORY_DAYS) throw new Error('Incomplete insight day coverage');
    const days = rows.map((r,i) => {
      if (r.date !== addDays(start,i) || r.complete !== true) throw new Error(`Incomplete canonical insight day ${r.date || start}`);
      const totalTransactions = safeCount(r.total_transactions,'transaction count');
      const shieldedTransactions = safeCount(r.shielded_transactions,'shielded count');
      if (shieldedTransactions>totalTransactions) throw new Error('Invalid insight shielded denominator');
      const shieldZat = nonnegativeZat(r.shield_zat), deshieldZat = nonnegativeZat(r.deshield_zat);
      const publicFlowComplete = r.public_flow_complete === true && shieldZat !== null && deshieldZat !== null;
      return { date:r.date, complete:true, totalTransactions, shieldedTransactions,
        feesZat:nonnegativeZat(r.fees_zat), publicFlowComplete,
        shieldZat:publicFlowComplete ? shieldZat : null, deshieldZat:publicFlowComplete ? deshieldZat : null };
    });
    await client.query('COMMIT');
    return { network:'mainnet', days, tip, capturedAt:now.toISOString(), historyStart:start,
      flowScope:'Net public Sapling/Orchard/Ironwood value balances; transparent I/O required; coinbase, fully shielded migrations and all Sprout-involving transactions excluded.' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

module.exports = { HISTORY_DAYS, INSIGHT_SQL, readInsightSource };
