const { getPoolTagSql, POOL_BY_ADDRESS, POOL_BY_TAG } = require('../mining-pools');

const PERIODS = ['24h', '7d', '30d'];
// Percentiles from a handful of blocks would read as a pool characteristic.
const MIN_SAMPLE = 10;

// Lag = first local-node tip receipt − miner header timestamp. Windows use the
// header clock, like orphan rates, so the denominator is every canonical block
// in the window; blocks the 1s tip poll never saw stay counted but unobserved.
// Pool names are resolved in SQL so percentiles are computed per pool rather
// than merged across addresses.
const OBSERVATION_LAG_SQL = `
WITH clock AS (
  SELECT floor(extract(epoch FROM now()))::bigint AS as_of
), windows AS (
  SELECT period, as_of - seconds AS window_start, as_of AS window_end
  FROM clock CROSS JOIN (VALUES ('24h', 86400), ('7d', 604800), ('30d', 2592000)) p(period, seconds)
), names AS (
  SELECT $1::jsonb AS by_address, $2::jsonb AS by_tag
), lags AS (
  SELECT w.period,
         coalesce(n.by_address->>b.miner_address, n.by_tag->>(${getPoolTagSql('b.coinbase_hex')}), 'Unknown') AS pool,
         extract(epoch FROM o.first_seen_at) * 1000 - b.timestamp * 1000 AS lag_ms
  FROM windows w
  JOIN blocks b ON b.timestamp >= w.window_start AND b.timestamp < w.window_end
  CROSS JOIN names n
  LEFT JOIN block_observations o ON o.hash = b.hash
), grouped AS (
  SELECT period, pool, GROUPING(pool) AS is_total, count(*)::bigint AS blocks, count(lag_ms)::bigint AS observed,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_ms) AS median_ms,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY lag_ms) AS p90_ms,
         count(*) FILTER (WHERE lag_ms < 0)::bigint AS header_after_seen
  FROM lags GROUP BY GROUPING SETS ((period, pool), (period))
)
SELECT w.period, w.window_start, w.window_end, g.pool, g.is_total, g.blocks, g.observed,
       g.median_ms, g.p90_ms, g.header_after_seen,
       (SELECT min(first_seen_at) FROM block_observations) AS collection_start
FROM windows w LEFT JOIN grouped g ON g.period = w.period
`;

function poolNameMaps() {
  const byAddress = {}, byTag = {};
  for (const [address, info] of Object.entries(POOL_BY_ADDRESS)) if (!info.isFundingStream) byAddress[address] = info.name;
  for (const [tag, info] of Object.entries(POOL_BY_TAG)) byTag[tag] = info.name;
  return [byAddress, byTag];
}

function count(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid observation-lag count');
  return n;
}

function seconds(ms) {
  return ms == null ? null : Math.round(Number(ms) / 100) / 10;
}

function summary(row) {
  const blocks = count(row.blocks), observed = count(row.observed);
  const enough = observed >= MIN_SAMPLE;
  return {
    blocks, observed,
    medianSeconds: enough ? seconds(row.median_ms) : null,
    p90Seconds: enough ? seconds(row.p90_ms) : null,
    headerAfterSeen: count(row.header_after_seen),
  };
}

function formatObservationLag(rows) {
  if (!rows.length) throw new Error('Missing observation-lag snapshot');
  const first = rows[0];
  const periods = PERIODS.map(period => {
    const selected = rows.filter(row => row.period === period);
    if (!selected.length) throw new Error('Incomplete observation-lag snapshot');
    const { window_start: start, window_end: end } = selected[0];
    // An empty window joins no grouped rows, leaving is_total NULL.
    const total = selected.find(row => row.is_total != null && Number(row.is_total) === 1);
    return {
      period,
      windowStart: new Date(Number(start) * 1000).toISOString(),
      windowEnd: new Date(Number(end) * 1000).toISOString(),
      ...(total ? summary(total) : { blocks: 0, observed: 0, medianSeconds: null, p90Seconds: null, headerAfterSeen: 0 }),
      pools: selected.filter(row => row.is_total != null && Number(row.is_total) === 0)
        .map(row => ({ name: row.pool, ...summary(row) }))
        .sort((a, b) => b.blocks - a.blocks || a.name.localeCompare(b.name)),
    };
  });
  return {
    success: true,
    asOf: new Date(Number(first.window_end) * 1000).toISOString(),
    method: 'local-node-tip-receipt-v1',
    timeBasis: 'block-header',
    minSample: MIN_SAMPLE,
    collectionStart: first.collection_start == null ? null : new Date(first.collection_start).toISOString(),
    periods,
  };
}

async function observationLag(pool) {
  const [byAddress, byTag] = poolNameMaps();
  return formatObservationLag((await pool.query(OBSERVATION_LAG_SQL, [JSON.stringify(byAddress), JSON.stringify(byTag)])).rows);
}

module.exports = { observationLag, formatObservationLag, OBSERVATION_LAG_SQL, MIN_SAMPLE };
