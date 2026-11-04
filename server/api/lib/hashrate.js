/** Canonical-chain expected solutions per second over explicit elapsed-time windows. */
const DAY = 86400;
const TWO_256 = '115792089237316195423570985008687907853269984665640564039457584007913129639936';
const METHOD = 'target-work-v1';

// Bitcoin/Zcash GetBlockProof: floor(2^256 / (target + 1)). Decode nBits,
// including its sign/overflow rules. Invalid/missing targets must not become zero work.
function workCtes(where, { fastLargeTargets = false } = {}) {
  const numericProof = `div(${TWO_256}::numeric, 1 + CASE WHEN (n >> 24) <= 3
        THEN trunc((n & 8388607)::numeric / power(256::numeric, 3 - (n >> 24)))
        ELSE (n & 8388607)::numeric * power(256::numeric, (n >> 24) - 3)
      END)`;
  // For valid e=28..34, let A=256^(35-e), K=256^(e-3), m=mantissa.
  // q=floor((A-1)/m) is exactly floor(AK/(mK+1)): qm<=A-1,
  // (q+1)m>=A and q<K. A<=2^56, so the numerator fits signed BIGINT.
  // The surrounding compact-target guards still reject sign/overflow/zero.
  const proof = fastLargeTargets ? `CASE WHEN (n >> 24) >= 28 THEN
        ((1::bigint << (8 * (35 - (n >> 24)))::int) - 1) / (n & 8388607)
        ELSE ${numericProof} END` : numericProof;
  // History references n repeatedly in validity checks and both aggregates.
  // Decode the compact header once per block instead of letting CTE inlining
  // repeat its regex/bit conversion at every reference in the full-chain scan.
  return `compact AS${fastLargeTargets ? ' MATERIALIZED' : ''} (
    SELECT timestamp, CASE WHEN bits ~ '^[0-9a-fA-F]{8}$'
      THEN ('x' || bits)::bit(32)::bigint END AS n FROM blocks WHERE ${where}
  ), work AS (
    SELECT timestamp, CASE WHEN (n & 8388608) = 0 AND (n & 8388607) > 0
      AND (n >> 24) <= 34
      AND ((n >> 24) <= 33 OR (n & 8388607) <= 255)
      AND ((n >> 24) <= 32 OR (n & 8388607) <= 65535)
      AND ((n >> 24) > 3 OR (n & 8388607) >= power(256::numeric, 3 - (n >> 24)))
      THEN ${proof} END AS proof FROM compact
  )`;

}

function estimate({ work, count, valid, start, end, historyStart }) {
  const blockCount = Number(count);
  const windowSeconds = end - start;
  let unavailableReason = null;
  if (historyStart == null || Number(historyStart) > start) unavailableReason = 'incomplete-history';
  else if (blockCount < 2) unavailableReason = 'insufficient-blocks';
  else if (Number(valid) !== blockCount || work == null) unavailableReason = 'missing-targets';
  const hashrate = unavailableReason ? null : Number(work) / windowSeconds;
  return {
    hashrate, blockCount, windowSeconds,
    windowStart: new Date(start * 1000).toISOString(),
    windowEnd: new Date(end * 1000).toISOString(),
    expectedWork: unavailableReason ? null : String(work),
    unavailableReason, method: METHOD,
  };
}

async function loadHashrateSnapshot(pool) {
  // One statement/snapshot for anchor, tip, history coverage and both windows.
  const { rows } = await pool.query(`WITH anchor AS (
    SELECT floor(extract(epoch FROM now()))::bigint AS at
  ), ${workCtes('timestamp >= (SELECT at FROM anchor) - 604800 AND timestamp < (SELECT at FROM anchor)')}
  SELECT (SELECT at FROM anchor) AS as_of,
    (SELECT timestamp FROM blocks ORDER BY timestamp LIMIT 1) AS history_start,
    (SELECT hash FROM blocks ORDER BY height DESC LIMIT 1) AS tip_hash,
    (SELECT height FROM blocks ORDER BY height DESC LIMIT 1) AS tip_height,
    (SELECT timestamp FROM blocks ORDER BY height DESC LIMIT 1) AS tip_timestamp,
    count(*) AS count_7d, count(proof) AS valid_7d, sum(proof)::text AS work_7d,
    count(*) FILTER (WHERE timestamp >= (SELECT at FROM anchor) - 86400) AS count_24h,
    count(proof) FILTER (WHERE timestamp >= (SELECT at FROM anchor) - 86400) AS valid_24h,
    (sum(proof) FILTER (WHERE timestamp >= (SELECT at FROM anchor) - 86400))::text AS work_24h
  FROM work`);
  const row = rows[0];
  const end = Number(row.as_of);
  const windows = {};
  for (const [key, seconds] of [['24h', DAY], ['7d', 7 * DAY]]) {
    windows[key] = estimate({ work: row[`work_${key}`], count: row[`count_${key}`],
      valid: row[`valid_${key}`], start: end - seconds, end, historyStart: row.history_start });
  }
  return { asOf: new Date(end * 1000).toISOString(), tipHash: row.tip_hash,
    tipHeight: row.tip_height == null ? null : Number(row.tip_height),
    tipTimestamp: row.tip_timestamp == null ? null : Number(row.tip_timestamp), windows };
}

function historyPoints(rows, { windowSeconds, end, start, historyStart }) {
  const byDay = new Map(rows.map(row => [Number(row.day_start), row]));
  const points = [];
  for (let at = start; at <= end; at += DAY) {
    let work = 0n; let count = 0; let valid = 0;
    for (let day = at - windowSeconds; day < at; day += DAY) {
      const row = byDay.get(day);
      if (!row) continue;
      count += Number(row.block_count);
      valid += Number(row.valid_count);
      work += BigInt(row.expected_work ?? '0');
    }
    const value = estimate({ work: work.toString(), count, valid, start: at - windowSeconds,
      end: at, historyStart });
    points.push({ date: value.windowEnd, ...value });
  }
  return points;
}

const histories = new WeakMap();
async function cachedHashrateHistory(pool, period, window) {
  let entries = histories.get(pool);
  if (!entries) { entries = new Map(); histories.set(pool, entries); }
  const key = `${period}:${window}`;
  const old = entries.get(key);
  if (old && old.expires > Date.now()) return old.promise;
  const entry = { expires: Infinity, promise: null };
  entry.promise = loadHashrateHistory(pool, period, window).then(value => {
    entry.expires = Date.now() + 600_000;
    return value;
  }).catch(error => { entries.delete(key); throw error; });
  entries.set(key, entry);
  return entry.promise;
}

async function loadHashrateHistory(pool, period, window) {
  const windowSeconds = window === '7d' ? 7 * DAY : DAY;
  const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: 4000 }[period];
  // Completed windows sampled at UTC midnight. Each sample covers a full
  // trailing window; the live endpoint is supplied by the shared stats snapshot.
  const { rows: [bounds] } = await pool.query(`SELECT
    (floor(extract(epoch FROM now()) / 86400) * 86400)::bigint AS day_end,
    (SELECT timestamp FROM blocks ORDER BY timestamp LIMIT 1) AS history_start`);
  const end = Number(bounds.day_end);
  const earliestEnd = Math.ceil(Number(bounds.history_start) / DAY) * DAY + windowSeconds;
  const start = period === 'all' ? earliestEnd : Math.max(end - (days - 1) * DAY, earliestEnd);
  if (bounds.history_start == null || start > end) return { points: [], window, method: METHOD };
  const { rows } = await pool.query(`WITH ${workCtes('timestamp >= $1 AND timestamp < $2', { fastLargeTargets: true })}
    SELECT timestamp - ((timestamp % 86400 + 86400) % 86400) AS day_start,
      count(*) AS block_count, count(proof) AS valid_count, sum(proof)::text AS expected_work
    FROM work GROUP BY day_start ORDER BY day_start`, [start - windowSeconds, end]);
  return { points: historyPoints(rows, { windowSeconds, start, end, historyStart: bounds.history_start }),
    window, method: METHOD, sampledAt: new Date(end * 1000).toISOString() };
}

function formatHashrate(value) {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  for (const [scale, unit] of [[1e12, 'TSol/s'], [1e9, 'GSol/s'], [1e6, 'MSol/s'], [1e3, 'KSol/s']]) {
    if (value >= scale) return `${(value / scale).toFixed(2)} ${unit}`;
  }
  return `${value.toFixed(2)} Sol/s`;
}

module.exports = { workCtes, estimate, historyPoints, loadHashrateSnapshot, loadHashrateHistory, cachedHashrateHistory, formatHashrate };
