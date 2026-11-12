// Daily observed orphan rate for the mining page chart.
//
// Same orphan definition as orphan-rates.js (indexer reorg archives plus
// node-validated captured competitors, deduplicated by hash, minus hashes that
// are canonical again; only captures at already-indexed heights), bucketed by
// UTC day of the block-header timestamp, in one SQL snapshot.

const MIN_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 60;

// Dated changes in how much we can observe, shown on the chart so a jump in
// the rate is not mistaken for a network change. Public, coarse descriptions only.
const COVERAGE_EVENTS = [
  // 1 -> 4 at 19:55 UTC (regional observers), 4 -> 10 at 22:16 UTC (zecminingpool.com nodes).
  { at: '2026-11-05T19:55:00Z', kind: 'observers', label: 'Observers expanded from 1 to 10 during 5 Nov' },
];

const DAILY_SQL = `
WITH clock AS (
  SELECT floor(extract(epoch FROM now()))::bigint AS as_of
), days AS (
  SELECT d AS day_start, d + 86400 AS day_end
  FROM clock, generate_series((as_of / 86400 - ($1::integer - 1)) * 86400, (as_of / 86400) * 86400, 86400) d
), range AS (
  SELECT min(day_start) AS range_start, max(day_end) AS range_end FROM days
), observed AS (
  SELECT DISTINCT ON (hash) hash, timestamp
  FROM (
    SELECT ob.hash, ob.timestamp, 0 AS priority
    FROM orphaned_blocks ob, range
    WHERE ob.source='indexer' AND ob.consensus_valid IS DISTINCT FROM false
      AND ob.timestamp >= range.range_start AND ob.timestamp < range.range_end
    UNION ALL
    SELECT c.hash, c.timestamp, 1 AS priority
    FROM captured_blocks c JOIN blocks replacement ON replacement.height=c.height, range
    WHERE replacement.hash <> c.hash
      AND c.timestamp >= range.range_start AND c.timestamp < range.range_end
  ) evidence
  WHERE NOT EXISTS (SELECT 1 FROM blocks canonical WHERE canonical.hash=evidence.hash)
  ORDER BY hash, priority
), canonical AS (
  SELECT (b.timestamp / 86400) * 86400 AS day_start, count(*)::bigint AS n
  FROM blocks b, range WHERE b.timestamp >= range.range_start AND b.timestamp < range.range_end
  GROUP BY 1
), orphans AS (
  SELECT (o.timestamp / 86400) * 86400 AS day_start, count(*)::bigint AS n FROM observed o GROUP BY 1
)
SELECT d.day_start, d.day_end, clock.as_of,
       coalesce(c.n, 0) AS canonical_blocks, coalesce(o.n, 0) AS orphaned_blocks,
       (SELECT min(timestamp) FROM blocks) AS history_start,
       (SELECT floor(extract(epoch FROM min(collection_started_at)))::bigint FROM block_capture_observers) AS capture_start
FROM days d CROSS JOIN clock
LEFT JOIN canonical c ON c.day_start = d.day_start
LEFT JOIN orphans o ON o.day_start = d.day_start
ORDER BY d.day_start
`;

function count(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid daily orphan-rate count');
  return n;
}

function parseDays(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_DAYS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) return null;
  return n;
}

function isoDay(seconds) {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

function formatDaily(rows, { nu7Timestamp = null } = {}) {
  if (!rows.length) throw new Error('Missing daily orphan-rate snapshot');
  const asOf = Number(rows[0].as_of);
  const historyStart = rows[0].history_start == null ? null : Number(rows[0].history_start);
  const days = rows.map(row => {
    const canonicalBlocks = count(row.canonical_blocks);
    const orphanedBlocks = count(row.orphaned_blocks);
    const start = Number(row.day_start);
    // A day before indexed history began has no meaningful denominator.
    const complete = historyStart != null && historyStart <= start;
    const total = canonicalBlocks + orphanedBlocks;
    return {
      date: isoDay(start),
      canonicalBlocks,
      orphanedBlocks,
      rate: complete && canonicalBlocks > 0 ? orphanedBlocks / total : null,
      partial: Number(row.day_end) > asOf,
    };
  });
  const events = [];
  if (rows[0].capture_start != null) {
    events.push({ at: new Date(Number(rows[0].capture_start) * 1000).toISOString(), kind: 'capture', label: 'Competing-block capture began' });
  }
  for (const e of COVERAGE_EVENTS) events.push({ ...e });
  if (Number.isFinite(nu7Timestamp) && nu7Timestamp > 0) {
    events.push({ at: new Date(nu7Timestamp * 1000).toISOString(), kind: 'nu7', label: 'NU7 activated' });
  }
  const first = Date.parse(`${days[0].date}T00:00:00Z`);
  return {
    success: true,
    asOf: new Date(asOf * 1000).toISOString(),
    timeBasis: 'block-header-utc-day',
    days,
    events: events.filter(e => Date.parse(e.at) >= first && Date.parse(e.at) <= asOf * 1000)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  };
}

/** NU7 activation header time when the serving node reports a height and it is indexed. */
async function nu7Timestamp(pool, nu7Height) {
  if (!Number.isSafeInteger(nu7Height) || nu7Height <= 0) return null;
  const { rows } = await pool.query('SELECT timestamp FROM blocks WHERE height = $1', [nu7Height]);
  return rows.length ? Number(rows[0].timestamp) : null;
}

async function orphanRateDaily(pool, { days = DEFAULT_DAYS, nu7Height = null } = {}) {
  const [{ rows }, nu7] = await Promise.all([pool.query(DAILY_SQL, [days]), nu7Timestamp(pool, nu7Height)]);
  return formatDaily(rows, { nu7Timestamp: nu7 });
}

module.exports = { orphanRateDaily, formatDaily, parseDays, DAILY_SQL, COVERAGE_EVENTS, MIN_DAYS, MAX_DAYS, DEFAULT_DAYS };
