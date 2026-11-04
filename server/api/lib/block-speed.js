const { targetSpacing } = require('./network-schedule');

const DAY = 86400;
const HISTORY_DAYS = 30;
const SUMMARY_SECONDS = 7 * DAY;
// Header timestamps may sit hours away from their neighbours; search below the
// requested start so that boundary blocks are not dropped.
const TIMESTAMP_MARGIN = 3 * 3600;
const MAX_SCAN_BLOCKS = 600000;
const NO_UPPER_TIMESTAMP = Number.MAX_SAFE_INTEGER;

// Adjacent canonical heights only. The interval that ends at block h belongs
// to block h's target-spacing era, matching cadencePoints().
const INTERVALS_CTE = `WITH ordered AS (
    SELECT height, timestamp,
      timestamp - LAG(timestamp) OVER w AS dt,
      height - LAG(height) OVER w AS dh
    FROM blocks
    WHERE height BETWEEN $1 AND $2
    WINDOW w AS (ORDER BY height)
  ), intervals AS (
    SELECT height, timestamp, dt FROM ordered WHERE dh = 1
  )`;

const DAYS_SQL = `${INTERVALS_CTE}
  SELECT (timestamp / ${DAY}) * ${DAY} AS day_start,
    ($4::integer IS NOT NULL AND height >= $4::integer) AS nu7,
    MIN(height)::integer AS first_height, MAX(height)::integer AS last_height,
    COUNT(*)::integer AS intervals, SUM(dt)::bigint AS elapsed,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY dt) AS median,
    percentile_cont(0.9) WITHIN GROUP (ORDER BY dt) AS p90
  FROM intervals
  WHERE timestamp >= $3
  GROUP BY 1, 2
  ORDER BY 1, 2`;

const SUMMARY_SQL = `${INTERVALS_CTE}
  SELECT MIN(height)::integer AS first_height, MAX(height)::integer AS last_height,
    MIN(timestamp)::bigint AS first_timestamp, MAX(timestamp)::bigint AS last_timestamp,
    COUNT(*)::integer AS intervals, SUM(dt)::bigint AS elapsed,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY dt) AS median,
    percentile_cont(0.9) WITHIN GROUP (ORDER BY dt) AS p90
  FROM intervals
  WHERE timestamp >= $3 AND timestamp < $4 AND height >= $5 AND height < $6`;

const round1 = value => value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10) / 10;

function averageSeconds(elapsed, intervals) {
  const seconds = Number(elapsed); const count = Number(intervals);
  return count > 0 && Number.isFinite(seconds) && seconds > 0 ? round1(seconds / count) : null;
}

async function timestampAt(pool, height) {
  const { rows } = await pool.query('SELECT timestamp FROM blocks WHERE height = $1', [height]);
  return rows[0] ? Number(rows[0].timestamp) : null;
}

// The production blocks table has no timestamp index. Widen a height-bounded
// range by primary-key point lookups until it starts before the target time.
async function findLowerHeight(pool, schedule, fromHeight, fromTimestamp, targetTimestamp) {
  const spacing = targetSpacing(schedule, fromHeight) ?? 75;
  let distance = Math.ceil(Math.max(0, fromTimestamp - targetTimestamp + TIMESTAMP_MARGIN) / spacing * 1.25) + 100;
  for (;;) {
    const height = Math.max(0, fromHeight - Math.min(distance, MAX_SCAN_BLOCKS));
    const timestamp = await timestampAt(pool, height);
    if (timestamp != null && timestamp <= targetTimestamp - TIMESTAMP_MARGIN) return { height, timestamp, complete: true };
    if (height === 0 || distance >= MAX_SCAN_BLOCKS) return { height, timestamp, complete: height === 0 && timestamp != null };
    distance *= 2;
  }
}

function summaryFromRow(row, targetSeconds) {
  if (!row || !Number(row.intervals)) return null;
  return {
    fromHeight: Number(row.first_height), toHeight: Number(row.last_height),
    fromTimestamp: Number(row.first_timestamp), toTimestamp: Number(row.last_timestamp),
    intervals: Number(row.intervals), averageSeconds: averageSeconds(row.elapsed, row.intervals),
    medianSeconds: round1(row.median), p90Seconds: round1(row.p90), targetSeconds,
  };
}

function dayFromRow(row, schedule, nowTimestamp, splitDays, partialThrough) {
  const start = Number(row.day_start);
  return {
    date: new Date(start * 1000).toISOString().slice(0, 10), start, nu7: Boolean(row.nu7),
    targetSeconds: targetSpacing(schedule, Number(row.last_height)),
    firstHeight: Number(row.first_height), lastHeight: Number(row.last_height), intervals: Number(row.intervals),
    averageSeconds: averageSeconds(row.elapsed, row.intervals), medianSeconds: round1(row.median), p90Seconds: round1(row.p90),
    complete: start + DAY <= nowTimestamp && !splitDays.has(start) && start > partialThrough,
  };
}

function mapDays(rows, schedule, nowTimestamp, lower) {
  const seen = new Set(); const splitDays = new Set();
  for (const row of rows) {
    const start = Number(row.day_start);
    if (seen.has(start)) splitDays.add(start);
    seen.add(start);
  }
  // A capped scan can begin in the middle of a completed UTC day. Its first
  // row is a predecessor anchor, not a complete day's interval history.
  // If that anchor is missing, conservatively omit the earliest returned day.
  const partialThrough = lower.complete ? -Infinity
    : lower.timestamp ?? Math.min(...rows.map(row => Number(row.day_start)));
  return rows.map(row => dayFromRow(row, schedule, nowTimestamp, splitDays, partialThrough));
}

/** Daily canonical block-header interval history and comparable seven-day summaries. */
async function loadBlockSpeed({ pool, info, schedule, now = Date.now() }) {
  const { rows: [tip] } = await pool.query('SELECT height, timestamp FROM blocks ORDER BY height DESC LIMIT 1');
  if (!tip) return null;
  const tipHeight = Number(tip.height); const tipTimestamp = Number(tip.timestamp);
  const nowTimestamp = Math.floor(now / 1000);
  const nu7Height = schedule?.nu7Height ?? null;
  const nu7Active = nu7Height != null && tipHeight >= nu7Height;
  const historyStart = Math.floor(nowTimestamp / DAY) * DAY - HISTORY_DAYS * DAY;
  const latestStart = nowTimestamp - SUMMARY_SECONDS;
  const lower = await findLowerHeight(pool, schedule, tipHeight, tipTimestamp, historyStart);
  const latestMinHeight = nu7Active ? nu7Height : 0;
  const activationTimestamp = nu7Active ? await timestampAt(pool, nu7Height) : null;

  const [days, latest, before] = await Promise.all([
    pool.query(DAYS_SQL, [lower.height, tipHeight, historyStart, nu7Height]),
    pool.query(SUMMARY_SQL, [Math.max(lower.height, latestMinHeight - 1), tipHeight, latestStart, NO_UPPER_TIMESTAMP, latestMinHeight, tipHeight + 1]),
    activationTimestamp == null ? null : (async () => {
      const start = activationTimestamp - SUMMARY_SECONDS;
      const beforeLower = await findLowerHeight(pool, schedule, nu7Height - 1, activationTimestamp, start);
      const result = await pool.query(SUMMARY_SQL, [beforeLower.height, nu7Height - 1, start, NO_UPPER_TIMESTAMP, 0, nu7Height]);
      return { row: result.rows[0], complete: beforeLower.complete };
    })(),
  ]);
  const currentTarget = targetSpacing(schedule, tipHeight);
  // The full history scan may be capped while still covering the recent week.
  // A newly active era is intentionally measured only since activation, and
  // is covered when the scan includes the activation block's predecessor.
  const latestCovered = lower.complete || (lower.timestamp != null && lower.timestamp < latestStart)
    || (nu7Active && activationTimestamp != null && lower.height < nu7Height);
  return {
    success: true, network: info.chain, source: 'canonical-block-header-timestamps',
    observedAt: new Date(now).toISOString(), nodeHeight: info.blocks, indexedHeight: tipHeight, tipTimestamp,
    schedule, activation: nu7Active ? { height: nu7Height, timestamp: activationTimestamp } : null,
    coverage: { fromTimestamp: lower.timestamp, complete: lower.complete, historyDays: HISTORY_DAYS },
    days: mapDays(days.rows, schedule, nowTimestamp, lower),
    windows: {
      latest: latestCovered ? summaryFromRow(latest.rows[0], currentTarget) : null,
      beforeUpgrade: before && before.complete ? summaryFromRow(before.row, targetSpacing(schedule, nu7Height - 1)) : null,
    },
  };
}

module.exports = { loadBlockSpeed, findLowerHeight, DAYS_SQL, SUMMARY_SQL, HISTORY_DAYS };
