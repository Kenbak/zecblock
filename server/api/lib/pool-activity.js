'use strict';

const DAY_MS = 86400000;
const PERIOD_DAYS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90, '1y': 365 });
const POOLS = Object.freeze(['sprout', 'sapling', 'orchard', 'ironwood']);

// One database snapshot binds transaction counts to canonical block identities.
// The surrounding height range detects missing blocks without treating ordinary
// out-of-order block timestamps as gaps in an individual calendar day.
// Materialize timestamp-filtered heights before MIN/MAX: otherwise PostgreSQL
// can search the height primary key from genesis to find the first timestamp.
const ACTIVITY_SQL = `
WITH tip AS (
  SELECT height, timestamp FROM blocks ORDER BY height DESC LIMIT 1
), window_heights AS MATERIALIZED (
  SELECT height FROM blocks WHERE timestamp >= $1 AND timestamp < $2
), bounds AS (
  SELECT MIN(height) AS first_height, MAX(height) AS last_height
  FROM window_heights
), height_range AS MATERIALIZED (
  SELECT b.height, b.hash, b.timestamp, b.transaction_count
  FROM blocks b CROSS JOIN bounds r
  WHERE b.height BETWEEN GREATEST(r.first_height - 1, 0) AND r.last_height + 1
), coverage AS (
  SELECT COUNT(b.height) = r.last_height - r.first_height + 2
    + CASE WHEN r.first_height > 0 THEN 1 ELSE 0 END AS complete
  FROM bounds r LEFT JOIN height_range b ON true
  GROUP BY r.first_height, r.last_height
), per_block AS (
  SELECT b.height, b.timestamp, b.transaction_count,
    COUNT(t.txid) AS indexed_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase = true) AS coinbase_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase = false) AS total_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase = false AND NOT (
      (t.has_sprout IS NOT NULL OR t.sprout_joinsplit_count IS NOT NULL)
      AND (t.has_sapling IS NOT NULL
        OR (t.sapling_spend_count > 0 OR t.sapling_output_count > 0) IS TRUE
        OR (t.sapling_spend_count IS NOT NULL AND t.sapling_output_count IS NOT NULL))
      AND (t.has_orchard IS NOT NULL OR t.orchard_actions IS NOT NULL)
      AND (t.has_ironwood IS NOT NULL OR t.ironwood_actions IS NOT NULL)
    )) AS unknown_pool_transactions,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase = false AND
      (t.has_sprout = true OR t.sprout_joinsplit_count > 0)) AS sprout,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase = false AND
      (t.has_sapling = true OR t.sapling_spend_count > 0 OR t.sapling_output_count > 0)) AS sapling,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase = false AND
      (t.has_orchard = true OR t.orchard_actions > 0)) AS orchard,
    COUNT(t.txid) FILTER (WHERE t.is_coinbase = false AND
      (t.has_ironwood = true OR t.ironwood_actions > 0)) AS ironwood
  FROM height_range b
  LEFT JOIN transactions t ON t.block_height = b.height AND t.block_hash = b.hash
  WHERE b.timestamp >= $1 AND b.timestamp < $2
  GROUP BY b.height, b.timestamp, b.transaction_count
), daily AS (
  SELECT (TO_TIMESTAMP(timestamp) AT TIME ZONE 'UTC')::date AS date,
    SUM(total_transactions) AS total_transactions,
    SUM(sprout) AS sprout, SUM(sapling) AS sapling,
    SUM(orchard) AS orchard, SUM(ironwood) AS ironwood,
    BOOL_AND(transaction_count >= 1 AND indexed_transactions = transaction_count
      AND coinbase_transactions = 1
      AND total_transactions + coinbase_transactions = indexed_transactions
      AND unknown_pool_transactions = 0) AS complete
  FROM per_block GROUP BY 1
)
SELECT day::date::text AS date, d.total_transactions,
  d.sprout, d.sapling, d.orchard, d.ironwood,
  COALESCE(d.complete AND c.complete AND tip.timestamp >= $2, false) AS complete,
  tip.height AS source_height
FROM GENERATE_SERIES($3::date::timestamp, ($4::date - 1)::timestamp, INTERVAL '1 day') day
LEFT JOIN daily d ON d.date = day::date
CROSS JOIN coverage c LEFT JOIN tip ON true
ORDER BY day`;

function activityWindow(period = '30d', now = new Date()) {
  if (!Object.hasOwn(PERIOD_DAYS, period)) throw new RangeError('Unsupported activity period');
  const days = PERIOD_DAYS[period];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - days * DAY_MS;
  return {
    period, days,
    startDate: new Date(start).toISOString().slice(0, 10),
    endDate: new Date(end - DAY_MS).toISOString().slice(0, 10),
    params: [start / 1000, end / 1000, new Date(start).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10)],
  };
}

function safeCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function activityResponse(rows, window) {
  const points = rows.map(row => {
    const counts = Object.fromEntries(POOLS.map(key => [key, safeCount(row[key])]));
    const totalTransactions = safeCount(row.total_transactions);
    const complete = row.complete === true && totalTransactions !== null
      && Object.values(counts).every(value => value !== null && value <= totalTransactions);
    return {
      date: row.date, totalTransactions: complete ? totalTransactions : null,
      ...Object.fromEntries(POOLS.map(key => [key, complete ? counts[key] : null])), complete,
    };
  });
  const completeDays = points.filter(point => point.complete).length;
  const complete = completeDays === window.days && points.length === window.days;
  const totals = Object.fromEntries(['totalTransactions', ...POOLS].map(key => [key,
    complete ? points.reduce((sum, point) => sum + point[key], 0) : null,
  ]));
  return {
    period: window.period, startDate: window.startDate, endDate: window.endDate,
    sourceHeight: safeCount(rows[0]?.source_height), points, totals,
    coverage: { completeDays, expectedDays: window.days },
    denominator: 'canonical non-coinbase transactions', overlappingPools: true,
  };
}

module.exports = { PERIOD_DAYS, POOLS, ACTIVITY_SQL, activityWindow, activityResponse };
