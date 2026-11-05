const { getPoolTagSql, getPoolName, POOL_BY_TAG } = require('../mining-pools');

const PERIODS = ['24h', '7d', '30d'];

// A single statement gives the numerator and denominator the same snapshot
// and clock. External hash reports are not validated blocks; indexer archives
// were copied from the canonical chain before rollback. A restored hash is
// excluded even if an old archive row remains.
const ORPHAN_RATES_SQL = `
WITH clock AS (
  SELECT floor(extract(epoch FROM now()))::bigint AS as_of
), capture AS (
  SELECT min(collection_started_at) AS capture_start, max(heartbeat_at) AS capture_heartbeat,
    count(*) FILTER (WHERE stream_connected AND heartbeat_at > now() - interval '45 seconds' AND pending_records=0)::integer AS healthy_observers,
    count(*)::integer AS observers
  FROM block_capture_observers
), activation AS (
  -- The canonical NU7 activation block's header time; absent until it is indexed.
  SELECT timestamp::bigint AS ts FROM blocks WHERE height = $1::integer
), windows AS (
  SELECT period, as_of - seconds AS window_start, as_of AS window_end
  FROM clock CROSS JOIN (VALUES ('24h', 86400), ('7d', 604800), ('30d', 2592000)) p(period, seconds)
  UNION ALL
  -- Up to 30 days before activation, starting no earlier than competing-block
  -- capture so both sides share one collection method.
  SELECT 'pre-nu7', greatest(a.ts - 2592000, coalesce(floor(extract(epoch FROM capture.capture_start))::bigint, a.ts - 2592000)), a.ts
  FROM activation a CROSS JOIN capture
  UNION ALL
  SELECT 'nu7', a.ts, clock.as_of FROM activation a CROSS JOIN clock
), tip AS (
  SELECT height, hash, timestamp FROM blocks ORDER BY height DESC LIMIT 1
), history AS (
  SELECT min(timestamp) AS history_start FROM blocks
), observed AS (
  -- Prefer the established archive's attribution when both sources saw a hash.
  SELECT DISTINCT ON (hash) hash, timestamp, miner_address, coinbase_hex
  FROM (
    SELECT ob.hash, ob.timestamp, ob.miner_address, ob.coinbase_hex, 0 AS priority
    FROM orphaned_blocks ob
    WHERE ob.source='indexer' AND ob.consensus_valid IS DISTINCT FROM false
      AND ob.timestamp >= (SELECT min(window_start) FROM windows)
      AND ob.timestamp < (SELECT max(window_end) FROM windows)
    UNION ALL
    SELECT c.hash, c.timestamp, c.miner_address, c.coinbase_hex, 1 AS priority
    FROM captured_blocks c JOIN blocks replacement ON replacement.height=c.height
    WHERE replacement.hash <> c.hash
      AND c.timestamp >= (SELECT min(window_start) FROM windows)
      AND c.timestamp < (SELECT max(window_end) FROM windows)
  ) evidence
  WHERE NOT EXISTS (SELECT 1 FROM blocks canonical WHERE canonical.hash=evidence.hash)
  ORDER BY hash, priority
), counts AS (
  SELECT w.period, b.miner_address, ${getPoolTagSql('b.coinbase_hex')} AS tag,
         count(*)::bigint AS canonical_blocks, 0::bigint AS orphaned_blocks
  FROM windows w JOIN blocks b ON b.timestamp >= w.window_start AND b.timestamp < w.window_end
  GROUP BY w.period, b.miner_address, tag
  UNION ALL
  SELECT w.period, ob.miner_address, ${getPoolTagSql('ob.coinbase_hex')} AS tag,
         0::bigint AS canonical_blocks, count(*)::bigint AS orphaned_blocks
  FROM windows w JOIN observed ob ON ob.timestamp >= w.window_start AND ob.timestamp < w.window_end
  GROUP BY w.period, ob.miner_address, tag
)
SELECT w.*, capture.*, h.history_start, t.height AS indexed_height, t.hash AS indexed_hash,
       t.timestamp AS indexed_timestamp, c.miner_address, c.tag,
       coalesce(c.canonical_blocks, 0) AS canonical_blocks,
       coalesce(c.orphaned_blocks, 0) AS orphaned_blocks
FROM windows w CROSS JOIN history h CROSS JOIN capture LEFT JOIN tip t ON true
LEFT JOIN counts c ON c.period = w.period
`;

// Migration 042 coverage measurement, read separately so the rate query keeps
// working on databases without it. Gap reasons stay private (internal errors).
const COVERAGE_READY_SQL = `
SELECT to_regclass('block_capture_audit_misses') IS NOT NULL
  AND (SELECT count(*) = 12 FROM pg_attribute
       WHERE attrelid = to_regclass('block_capture_observers') AND NOT attisdropped
         AND attname IN ('coverage_since','unobserved_ms','outage_since','recent_gaps','pending_bytes','journal_max_bytes',
           'audit_checked_at','audit_status','audit_fork_tips','audit_fork_blocks','audit_canonical_checked','audit_canonical_missing')) AS ready`;

const COVERAGE_SQL = `
SELECT o.observer, o.coverage_since, o.unobserved_ms, o.outage_since, o.recent_gaps,
  o.pending_bytes, o.journal_max_bytes, o.audit_checked_at, o.audit_status, o.audit_fork_tips,
  o.audit_fork_blocks, o.audit_canonical_checked, o.audit_canonical_missing,
  (SELECT count(*) FROM block_capture_audit_misses m WHERE m.observer = o.observer AND m.captured_later_at IS NULL)::integer AS uncaptured,
  (SELECT count(*) FROM block_capture_audit_misses m WHERE m.observer = o.observer AND m.captured_later_at IS NOT NULL)::integer AS late,
  now() AS db_now
FROM block_capture_observers o
ORDER BY o.observer`;

const MS_PER_SECOND = 1000;

function optionalCount(value) {
  return value == null ? null : count(value);
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

// Streaming time only from coverage_since: earlier gaps were never timed.
function formatMeasurement(row) {
  if (row.coverage_since == null) return null;
  const now = new Date(row.db_now).getTime();
  const since = new Date(row.coverage_since).getTime();
  const elapsed = Math.max(0, now - since);
  const open = row.outage_since == null ? 0 : Math.max(0, now - Math.max(since, new Date(row.outage_since).getTime()));
  const unobserved = count(row.unobserved_ms ?? 0) + open;
  const gaps = Array.isArray(row.recent_gaps) ? row.recent_gaps : [];
  return {
    measuredSince: iso(row.coverage_since),
    streamingFraction: elapsed > 0 ? Math.min(1, Math.max(0, 1 - unobserved / elapsed)) : null,
    unobservedSeconds: unobserved / MS_PER_SECOND,
    outageSince: iso(row.outage_since),
    recentGaps: gaps.filter(g => Number.isSafeInteger(g?.start_ms) && Number.isSafeInteger(g?.end_ms) && g.end_ms >= g.start_ms)
      .map(g => ({ start: new Date(g.start_ms).toISOString(), end: new Date(g.end_ms).toISOString(), seconds: (g.end_ms - g.start_ms) / MS_PER_SECOND })),
    journal: { pendingBytes: optionalCount(row.pending_bytes), maxBytes: optionalCount(row.journal_max_bytes) },
    audit: row.audit_checked_at == null ? null : {
      checkedAt: iso(row.audit_checked_at),
      status: row.audit_status === 'ok' ? 'ok' : 'error',
      forkTips: optionalCount(row.audit_fork_tips),
      forkBlocksChecked: optionalCount(row.audit_fork_blocks),
      uncapturedForkBlocks: count(row.uncaptured),
      lateCapturedForkBlocks: count(row.late),
      canonicalBlocksChecked: optionalCount(row.audit_canonical_checked),
      canonicalBlocksMissing: optionalCount(row.audit_canonical_missing),
    },
  };
}

async function captureMeasurement(pool) {
  const { rows: [ready] } = await pool.query(COVERAGE_READY_SQL);
  if (!ready?.ready) return null;
  const { rows } = await pool.query(COVERAGE_SQL);
  const observers = rows.map(row => ({ observer: row.observer, ...formatMeasurement(row) })).filter(o => o.measuredSince);
  return observers.length ? observers : null;
}

function count(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid orphan-rate count');
  return n;
}

function formatWindow(period, selected) {
  const { window_start: start, window_end: end, history_start: historyStart } = selected[0];
  const pools = new Map();
  let canonicalBlocks = 0, orphanedBlocks = 0;
  for (const row of selected) {
    const canonical = count(row.canonical_blocks), orphaned = count(row.orphaned_blocks);
    canonicalBlocks += canonical;
    orphanedBlocks += orphaned;
    if (canonical + orphaned === 0) continue;
    const name = getPoolName(row.miner_address) || POOL_BY_TAG[row.tag]?.name || 'Unknown';
    const pool = pools.get(name) || { name, canonicalBlocks: 0, orphanedBlocks: 0 };
    pool.canonicalBlocks += canonical;
    pool.orphanedBlocks += orphaned;
    pools.set(name, pool);
  }
  const unavailableReason = period === 'pre-nu7' && Number(start) >= Number(end) ? 'capture-began-after-activation'
    : historyStart == null || Number(historyStart) > Number(start)
      ? 'incomplete-canonical-history' : canonicalBlocks === 0 ? 'no-canonical-blocks' : null;
  return {
    period, windowStart: new Date(Number(start) * 1000).toISOString(),
    windowEnd: new Date(Number(end) * 1000).toISOString(),
    canonicalBlocks, orphanedBlocks,
    rate: unavailableReason ? null : orphanedBlocks / (canonicalBlocks + orphanedBlocks),
    unavailableReason,
    pools: [...pools.values()].map(pool => ({
      ...pool, rate: unavailableReason ? null : pool.orphanedBlocks / (pool.canonicalBlocks + pool.orphanedBlocks),
    })).sort((a, b) => b.orphanedBlocks - a.orphanedBlocks || b.canonicalBlocks - a.canonicalBlocks || a.name.localeCompare(b.name)),
  };
}

function formatOrphanRates(rows, nu7Height = null, measurement = null) {
  // Rolling windows share the snapshot clock; NU7 windows may end at activation.
  const first = rows.find(row => row.period === PERIODS[0]);
  if (!first) throw new Error('Missing orphan-rate snapshot');
  const periods = PERIODS.map(period => {
    const selected = rows.filter(row => row.period === period);
    if (!selected.length) throw new Error('Incomplete orphan-rate snapshot');
    return formatWindow(period, selected);
  });
  const before = rows.filter(row => row.period === 'pre-nu7');
  const since = rows.filter(row => row.period === 'nu7');
  // Before/after NU7 on one collection method. Null until the activation block is indexed.
  const nu7 = before.length && since.length ? {
    activationHeight: nu7Height,
    activationTimestamp: new Date(Number(since[0].window_start) * 1000).toISOString(),
    before: formatWindow('pre-nu7', before),
    since: formatWindow('nu7', since),
  } : null;
  return {
    success: true, asOf: new Date(Number(first.window_end) * 1000).toISOString(),
    indexedHeight: first.indexed_height == null ? null : count(first.indexed_height),
    indexedHash: first.indexed_hash ?? null,
    indexedTimestamp: first.indexed_timestamp == null ? null : new Date(Number(first.indexed_timestamp) * 1000).toISOString(),
    method: 'observed-block-capture-v2', timeBasis: 'block-header',
    coverage: { status: 'unverified', collectionStart: null, uptimeVerified: false },
    capture: {
      startedAt: first.capture_start == null ? null : new Date(first.capture_start).toISOString(),
      heartbeatAt: first.capture_heartbeat == null ? null : new Date(first.capture_heartbeat).toISOString(),
      observers: Number(first.observers ?? 0),
      healthyObservers: Number(first.healthy_observers ?? 0),
      status: Number(first.healthy_observers ?? 0) > 0 ? 'collecting' : 'unavailable',
      // Self-measured against the serving node; a single vantage point still
      // cannot see competing blocks that never reached it, so coverage stays unverified.
      measurement,
    },
    periods,
    nu7,
  };
}

async function orphanRates(pool, { nu7Height = null } = {}) {
  const height = Number.isSafeInteger(nu7Height) && nu7Height > 0 ? nu7Height : null;
  const { rows } = await pool.query(ORPHAN_RATES_SQL, [height]);
  // Measurement is supplementary: its absence or failure never hides the rates.
  const measurement = await captureMeasurement(pool).catch(() => null);
  return formatOrphanRates(rows, height, measurement);
}

module.exports = { orphanRates, formatOrphanRates, formatMeasurement, captureMeasurement, ORPHAN_RATES_SQL };
