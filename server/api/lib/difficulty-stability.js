const { heightBefore } = require('./network-schedule');

const METHOD = 'centered-24h-median-v1';
const HOUR = 3600;
const DAY = 24 * HOUR;
const HALF_WINDOW = 12 * HOUR;
const COMPARISON_SECONDS = 14 * DAY;
// Difficulty is still falling to its new 25-second level just after activation.
const SETTLE_SECONDS = 6 * HOUR;
const BUCKET_SECONDS = 30 * 60;
// Header times can run ahead of target spacing; load past the requested start.
const HEIGHT_MARGIN = 1152;

const BLOCKS_SQL = `SELECT height, timestamp, difficulty
  FROM blocks WHERE height BETWEEN $1 AND $2 ORDER BY height`;

const round2 = value => Math.round(value * 100) / 100;
const percentile = (sorted, p) => sorted[Math.floor(p / 100 * (sorted.length - 1))];

function insertSorted(sorted, value) {
  let low = 0; let high = sorted.length;
  while (low < high) { const mid = (low + high) >> 1; if (sorted[mid] < value) low = mid + 1; else high = mid; }
  sorted.splice(low, 0, value);
}
function removeSorted(sorted, value) {
  let low = 0; let high = sorted.length;
  while (low < high) { const mid = (low + high) >> 1; if (sorted[mid] < value) low = mid + 1; else high = mid; }
  sorted.splice(low, 1);
}
const medianOf = sorted => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function normalizeRows(rows) {
  return rows.map(row => ({ height: Number(row.height), timestamp: Number(row.timestamp), difficulty: Number(row.difficulty) }))
    .filter(row => Number.isSafeInteger(row.height) && Number.isSafeInteger(row.timestamp) && Number.isFinite(row.difficulty) && row.difficulty > 0);
}

/** Only blocks with a full 12 hours of the same era on each side get a deviation. */
function deviations(blocks) {
  if (blocks.length === 0) return [];
  const first = blocks[0].timestamp; const last = blocks[blocks.length - 1].timestamp;
  const sorted = []; const out = [];
  let low = 0; let high = 0;
  for (const block of blocks) {
    while (high < blocks.length && blocks[high].timestamp <= block.timestamp + HALF_WINDOW) insertSorted(sorted, blocks[high++].difficulty);
    while (low < high && blocks[low].timestamp < block.timestamp - HALF_WINDOW) removeSorted(sorted, blocks[low++].difficulty);
    if (block.timestamp - HALF_WINDOW < first || block.timestamp + HALF_WINDOW > last || sorted.length === 0) continue;
    out.push({ height: block.height, timestamp: block.timestamp, deviation: (block.difficulty / medianOf(sorted) - 1) * 100 });
  }
  return out;
}

/** Median high-versus-low range across UTC days fully inside the block range. */
function typicalDailyRange(blocks) {
  if (blocks.length === 0) return null;
  const first = blocks[0].timestamp; const last = blocks[blocks.length - 1].timestamp;
  const days = new Map();
  for (const block of blocks) {
    const day = Math.floor(block.timestamp / DAY) * DAY;
    if (day < first || day + DAY > last) continue;
    const range = days.get(day);
    if (range) { range.min = Math.min(range.min, block.difficulty); range.max = Math.max(range.max, block.difficulty); }
    else days.set(day, { min: block.difficulty, max: block.difficulty });
  }
  if (days.size === 0) return null;
  const ranges = [...days.values()].map(({ min, max }) => (max / min - 1) * 100).sort((a, b) => a - b);
  return round2(medianOf(ranges));
}

function summarize(blocks, evaluated, expectedBlocks) {
  if (evaluated.length === 0) return null;
  const values = evaluated.map(row => row.deviation).sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const start = evaluated[0].timestamp; const end = evaluated[evaluated.length - 1].timestamp;
  return {
    firstHeight: evaluated[0].height, lastHeight: evaluated[evaluated.length - 1].height,
    start, end, days: round2((end - start) / DAY), blocks: evaluated.length,
    missingBlocks: Math.max(0, expectedBlocks - blocks.length),
    largestDropPct: round2(values[0]), largestRisePct: round2(values[values.length - 1]),
    p1Pct: round2(percentile(values, 1)), p99Pct: round2(percentile(values, 99)),
    typicalSwingPct: round2(Math.sqrt(variance)),
    typicalDailyRangePct: typicalDailyRange(blocks),
  };
}

function bucketPoints(evaluated, era) {
  const buckets = new Map();
  for (const { timestamp, deviation } of evaluated) {
    const key = Math.floor(timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
    const bucket = buckets.get(key);
    if (bucket) { bucket.low = Math.min(bucket.low, deviation); bucket.high = Math.max(bucket.high, deviation); }
    else buckets.set(key, { low: deviation, high: deviation });
  }
  return [...buckets].sort(([a], [b]) => a - b).map(([timestamp, { low, high }]) => (
    { timestamp, era, lowPct: round2(low), highPct: round2(high) }
  ));
}

const inRange = (blocks, start, end) => blocks.filter(block => block.timestamp >= start && block.timestamp < end);

/** Pure comparison over canonical rows for both eras. */
function compareEras({ beforeRows, afterRows, activationHeight, activationTimestamp, tipTimestamp }) {
  const beforeBlocks = inRange(normalizeRows(beforeRows), activationTimestamp - COMPARISON_SECONDS, activationTimestamp)
    .filter(block => block.height < activationHeight);
  const afterStart = Math.max(activationTimestamp + SETTLE_SECONDS, tipTimestamp - COMPARISON_SECONDS);
  const afterBlocks = inRange(normalizeRows(afterRows), afterStart, Number.MAX_SAFE_INTEGER)
    .filter(block => block.height >= activationHeight);
  const expected = blocks => (blocks.length ? blocks[blocks.length - 1].height - blocks[0].height + 1 : 0);
  const beforeDeviations = deviations(beforeBlocks); const afterDeviations = deviations(afterBlocks);
  const before = summarize(beforeBlocks, beforeDeviations, expected(beforeBlocks));
  const after = summarize(afterBlocks, afterDeviations, expected(afterBlocks));
  if (!before || !after) return null;
  return {
    before, after,
    swingReduction: after.typicalSwingPct > 0 ? round2(before.typicalSwingPct / after.typicalSwingPct) : null,
    points: [...bucketPoints(beforeDeviations, 'before'), ...bucketPoints(afterDeviations, 'after')],
  };
}

const unavailable = reason => ({ available: false, reason, method: METHOD });

async function loadDifficultyStability({ pool, schedule, now = () => Date.now() }) {
  if (schedule?.network !== 'main') return unavailable('network-not-comparable');
  const activationHeight = schedule.nu7Height;
  if (activationHeight == null) return unavailable('nu7-not-active');
  const tip = (await pool.query('SELECT height, timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
  const tipHeight = Number(tip?.height);
  if (!Number.isSafeInteger(tipHeight) || tipHeight < activationHeight) return unavailable('nu7-not-active');
  const activation = (await pool.query('SELECT timestamp FROM blocks WHERE height = $1', [activationHeight])).rows[0];
  if (!activation) return unavailable('insufficient-history');
  const activationTimestamp = Number(activation.timestamp); const tipTimestamp = Number(tip.timestamp);
  const beforeLower = Math.max(0, heightBefore(schedule, activationHeight, COMPARISON_SECONDS) - HEIGHT_MARGIN);
  const afterLower = Math.max(activationHeight, heightBefore(schedule, tipHeight, COMPARISON_SECONDS) - HEIGHT_MARGIN);
  const [beforeResult, afterResult] = await Promise.all([
    pool.query(BLOCKS_SQL, [beforeLower, activationHeight - 1]),
    pool.query(BLOCKS_SQL, [afterLower, tipHeight]),
  ]);
  const comparison = compareEras({ beforeRows: beforeResult.rows, afterRows: afterResult.rows, activationHeight, activationTimestamp, tipTimestamp });
  if (!comparison) return unavailable('insufficient-history');
  return {
    available: true, reason: null, method: METHOD, network: 'mainnet',
    asOf: new Date(now()).toISOString(), tipHeight,
    activation: { height: activationHeight, timestamp: activationTimestamp },
    medianWindowSeconds: DAY, settleSeconds: SETTLE_SECONDS, bucketSeconds: BUCKET_SECONDS,
    ...comparison,
  };
}

module.exports = { METHOD, SETTLE_SECONDS, compareEras, deviations, loadDifficultyStability, typicalDailyRange };
