// Orphan races vs late blocks.
//
// A competing block only took part in a race if some node could have treated
// it as the tip. We count it as a race orphan when, at one or more observers,
// it arrived no later than RACE_WINDOW_SECONDS after the block that won that
// height (or that observer never received the winner). Both times come from the
// same observer, so clocks of different machines are never compared. Blocks our
// own node indexed and then reorged out were its tip, so they always count.
//
// Later arrivals are "late blocks": still wasted mining, usually a pool working
// on an outdated tip, but never a candidate for anyone's chain. 2s is about ten
// round trips along the internet's longest common paths.

const RACE_WINDOW_SECONDS = 2;

function column(expr) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(expr)) throw new Error('Invalid hash SQL column');
  return expr;
}

/**
 * SQL boolean: true when the captured block `orphanHash` reached no observer
 * within RACE_WINDOW_SECONDS of `winnerHash` reaching that same observer.
 * Uses the (observer, hash) primary key of block_capture_receipts per observer.
 */
function lateCaptureSql(orphanHash, winnerHash) {
  const orphan = column(orphanHash);
  const winner = column(winnerHash);
  return `NOT EXISTS (
    SELECT 1 FROM block_capture_observers bco
    JOIN block_capture_receipts orphan_receipt ON orphan_receipt.observer = bco.observer AND orphan_receipt.hash = ${orphan}
    LEFT JOIN block_capture_receipts winner_receipt ON winner_receipt.observer = bco.observer AND winner_receipt.hash = ${winner}
    WHERE winner_receipt.received_at IS NULL
       OR orphan_receipt.received_at <= winner_receipt.received_at + interval '${RACE_WINDOW_SECONDS} seconds')`;
}

/** Race orphans ÷ (canonical + race orphans); late blocks leave both sides. */
function raceRate(canonicalBlocks, raceOrphanedBlocks) {
  const total = canonicalBlocks + raceOrphanedBlocks;
  return total > 0 ? raceOrphanedBlocks / total : null;
}

module.exports = { RACE_WINDOW_SECONDS, lateCaptureSql, raceRate };
