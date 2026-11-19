const ZAT_PER_ZEC = 100_000_000;
const MAX_SUPPLY_ZAT = 21_000_000 * ZAT_PER_ZEC;

/** PostgreSQL bigint values are strings. Missing or malformed values are not zero. */
function supplyZat(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_SUPPLY_ZAT ? parsed : null;
}

/** RPC subsidy amounts are ZEC, but comparisons must respect zatoshi rounding. */
function subsidyZat(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 21_000_000) return null;
  const fixed = value.toFixed(8);
  if (Number(fixed) !== value) return null;
  return supplyZat(Math.round(value * ZAT_PER_ZEC));
}

function supplyHistory(rows, source) {
  return rows.map(row => {
    const parsed = supplyZat(source === 'chain_snapshots' ? row.chain_supply_zat : row.chain_supply);
    // Existing snapshot jobs store zero when chain supply is unavailable.
    // These modern history tables cannot distinguish that sentinel from zero.
    const zat = parsed === 0 ? null : parsed;
    const date = source === 'chain_snapshots' ? row.snapshot_time : row.date;
    return {
      date,
      circulating: zat === null ? null : zat / ZAT_PER_ZEC,
      circulatingZat: zat,
      ...(source === 'chain_snapshots' ? { height: supplyZat(row.block_height) } : {}),
    };
  }).filter(point => point.date != null && Number.isFinite(new Date(point.date).getTime()))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

/** Permanent archives represent completed UTC days; snapshots cover newer days. */
function mergedSupplyHistory(archive, snapshots) {
  const days = new Map();
  for (const point of snapshots) {
    const date = new Date(point.date).toISOString().slice(0, 10);
    const previous = days.get(date);
    if (!previous || new Date(point.date) >= new Date(previous.date)) days.set(date, point);
  }
  for (const row of archive) {
    const zat = supplyZat(row.chain_supply_zat);
    if (zat === null || (zat === 0 && Number(row.block_height) !== 0)) continue;
    days.set(String(row.date), {
      date: `${row.date}T23:59:59.000Z`, circulating: zat / ZAT_PER_ZEC,
      circulatingZat: zat, height: Number(row.block_height),
    });
  }
  return [...days.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
}

/** Daily net supply movement is not gross issuance. Do not bridge missing days. */
function dailyNetSupplyChanges(rows) {
  const points = supplyHistory(rows, 'privacy_trends_daily');
  return points.slice(1).map((point, index) => {
    const previous = points[index];
    const consecutive = new Date(point.date).getTime() - new Date(previous.date).getTime() === 86_400_000;
    const zat = consecutive && point.circulatingZat !== null && previous.circulatingZat !== null
      ? point.circulatingZat - previous.circulatingZat : null;
    return { date: point.date, emission: zat === null ? null : zat / ZAT_PER_ZEC, emissionZat: zat };
  });
}

// One target day at the post-NU7 25-second spacing.
const CADENCE_WINDOW_BLOCKS = 3456;

/**
 * A short-term observed cadence over the latest CADENCE_WINDOW_BLOCKS indexed
 * intervals. Informational only: dates and daily issuance use target spacing.
 */
async function observedBlockCadence(pool, currentHeight) {
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 1) return null;
  const { rows } = await pool.query(
    `WITH tip AS (SELECT max(height) AS h FROM blocks WHERE height <= $1)
     SELECT tip.h AS end_height, count(b.height) AS block_count,
       max(b.timestamp) FILTER (WHERE b.height = tip.h) AS end_timestamp,
       max(b.timestamp) FILTER (WHERE b.height = tip.h - $2) AS start_timestamp
     FROM tip LEFT JOIN blocks b ON b.height BETWEEN tip.h - $2 AND tip.h
     GROUP BY tip.h`,
    [currentHeight, CADENCE_WINDOW_BLOCKS],
  );
  const row = rows[0];
  const endHeight = supplyZat(row?.end_height);
  if (endHeight === null) return null;
  const lagBlocks = currentHeight - endHeight;
  // A polling indexer can trail a rapidly advancing node. Use its latest
  // complete window while the lag is bounded; never conceal a large backlog.
  if (lagBlocks < 0 || lagBlocks > 12 || endHeight < CADENCE_WINDOW_BLOCKS) return null;
  const end = supplyZat(row.end_timestamp);
  const start = supplyZat(row.start_timestamp);
  if (supplyZat(row.block_count) !== CADENCE_WINDOW_BLOCKS + 1 || end === null || start === null || end <= start) return null;
  return {
    intervalSeconds: (end - start) / CADENCE_WINDOW_BLOCKS,
    startHeight: endHeight - CADENCE_WINDOW_BLOCKS,
    endHeight,
    lagBlocks,
    intervals: CADENCE_WINDOW_BLOCKS,
    source: 'indexed-block-timestamps',
  };
}

module.exports = { mergedSupplyHistory, ZAT_PER_ZEC, supplyZat, subsidyZat, supplyHistory, dailyNetSupplyChanges, observedBlockCadence, CADENCE_WINDOW_BLOCKS };
