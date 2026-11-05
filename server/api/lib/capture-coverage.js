// INTERNAL ONLY. Competing-block collector coverage (migration 042): timed
// not-streaming gaps and the node fork-tip audit. Owner decision 2026-11-05:
// keep these private while we collect a month or two of history; do not
// expose them through public API routes, the v1 inventory or the UI.
//
// Coverage is measured only against our own serving node: competing blocks
// that never reached it are invisible to both the collector and the audit.

const READY_SQL = `
SELECT to_regclass('block_capture_audit_misses') IS NOT NULL
  AND (SELECT count(*) = 12 FROM pg_attribute
       WHERE attrelid = to_regclass('block_capture_observers') AND NOT attisdropped
         AND attname IN ('coverage_since','unobserved_ms','outage_since','recent_gaps','pending_bytes','journal_max_bytes',
           'audit_checked_at','audit_status','audit_fork_tips','audit_fork_blocks','audit_canonical_checked','audit_canonical_missing')) AS ready`;

const OBSERVERS_SQL = `
SELECT o.observer, o.network, o.collection_started_at, o.heartbeat_at, o.stream_connected, o.gaps, o.pending_records,
  o.coverage_since, o.unobserved_ms, o.outage_since, o.recent_gaps, o.pending_bytes, o.journal_max_bytes,
  o.audit_checked_at, o.audit_status, o.audit_fork_tips, o.audit_fork_blocks,
  o.audit_canonical_checked, o.audit_canonical_missing,
  (SELECT count(*) FROM block_capture_audit_misses m WHERE m.observer = o.observer AND m.captured_later_at IS NULL)::integer AS uncaptured,
  (SELECT count(*) FROM block_capture_audit_misses m WHERE m.observer = o.observer AND m.captured_later_at IS NOT NULL)::integer AS late,
  now() AS db_now
FROM block_capture_observers o
ORDER BY o.observer`;

const MISSES_SQL = `
SELECT observer, hash, network, height, branch_len, detected_at, captured_later_at
FROM block_capture_audit_misses
ORDER BY detected_at DESC
LIMIT $1`;

function count(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid capture coverage count');
  return n;
}

function optionalCount(value) {
  return value == null ? null : count(value);
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

// Streaming time is counted only from coverage_since: earlier gaps were never timed.
function formatObserver(row) {
  const now = new Date(row.db_now).getTime();
  const since = row.coverage_since == null ? null : new Date(row.coverage_since).getTime();
  const elapsed = since == null ? 0 : Math.max(0, now - since);
  const open = since == null || row.outage_since == null ? 0
    : Math.max(0, now - Math.max(since, new Date(row.outage_since).getTime()));
  const unobserved = since == null ? null : count(row.unobserved_ms ?? 0) + open;
  const gaps = Array.isArray(row.recent_gaps) ? row.recent_gaps : [];
  return {
    observer: row.observer,
    network: row.network,
    collectionStartedAt: iso(row.collection_started_at),
    heartbeatAt: iso(row.heartbeat_at),
    streamConnected: row.stream_connected === true,
    gapEvents: optionalCount(row.gaps),
    pendingRecords: optionalCount(row.pending_records),
    measuredSince: iso(row.coverage_since),
    streamingFraction: since != null && elapsed > 0 ? Math.min(1, Math.max(0, 1 - unobserved / elapsed)) : null,
    unobservedSeconds: unobserved == null ? null : unobserved / 1000,
    outageSince: iso(row.outage_since),
    recentGaps: gaps
      .filter(g => Number.isSafeInteger(g?.start_ms) && Number.isSafeInteger(g?.end_ms) && g.end_ms >= g.start_ms)
      .map(g => ({ start: new Date(g.start_ms).toISOString(), end: new Date(g.end_ms).toISOString(),
        seconds: (g.end_ms - g.start_ms) / 1000, reason: typeof g.reason === 'string' ? g.reason : null })),
    journal: { pendingBytes: optionalCount(row.pending_bytes), maxBytes: optionalCount(row.journal_max_bytes) },
    audit: row.audit_checked_at == null ? null : {
      checkedAt: iso(row.audit_checked_at),
      status: row.audit_status ?? null,
      forkTips: optionalCount(row.audit_fork_tips),
      forkBlocksChecked: optionalCount(row.audit_fork_blocks),
      uncapturedForkBlocks: count(row.uncaptured),
      lateCapturedForkBlocks: count(row.late),
      canonicalBlocksChecked: optionalCount(row.audit_canonical_checked),
      canonicalBlocksMissing: optionalCount(row.audit_canonical_missing),
    },
  };
}

function formatMiss(row) {
  return {
    observer: row.observer, hash: row.hash, network: row.network, height: count(row.height),
    branchLength: count(row.branch_len), detectedAt: iso(row.detected_at), capturedLaterAt: iso(row.captured_later_at),
  };
}

/** Internal coverage report; null before migration 042. */
async function captureCoverageReport(pool, { missLimit = 100 } = {}) {
  const limit = Number.isSafeInteger(missLimit) && missLimit > 0 && missLimit <= 10000 ? missLimit : 100;
  const { rows: [ready] } = await pool.query(READY_SQL);
  if (!ready?.ready) return null;
  const [{ rows: observers }, { rows: misses }] = [await pool.query(OBSERVERS_SQL), await pool.query(MISSES_SQL, [limit])];
  return { observers: observers.map(formatObserver), recentMisses: misses.map(formatMiss) };
}

module.exports = { captureCoverageReport, formatObserver, formatMiss };
