// "First seen by ZecBlock" is the earliest of two independent receipts:
// the canonical writer's 1s best-tip poll (block_observations, since 026) and
// the capture collector's node block stream (captured_blocks, since 035).
// The tip poll never sees a block that was not the tip on its own, such as a
// reorg replacement, so the stream fills those gaps. Neither is peer arrival.
function column(expr) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(expr)) throw new Error('Invalid hash SQL column');
  return expr;
}

function firstSeenSql(hashExpr) {
  const hash = column(hashExpr);
  return `(SELECT min(first_seen_at) FROM (
    SELECT first_seen_at FROM block_observations WHERE hash = ${hash}
    UNION ALL SELECT first_seen_at FROM captured_blocks WHERE hash = ${hash}) first_seen)`;
}

/** LATERAL row of first_seen_at, source and poll_interval_ms for the earliest receipt. */
function firstSeenLateralSql(hashExpr) {
  const hash = column(hashExpr);
  return `LATERAL (SELECT first_seen_at, source, poll_interval_ms FROM (
    SELECT first_seen_at, source, poll_interval_ms FROM block_observations WHERE hash = ${hash}
    UNION ALL SELECT first_seen_at, 'node-block-stream', NULL::integer FROM captured_blocks WHERE hash = ${hash}
  ) receipts ORDER BY first_seen_at LIMIT 1)`;
}

module.exports = { firstSeenSql, firstSeenLateralSql };
