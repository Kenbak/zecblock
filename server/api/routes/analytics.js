/**
 * Analytics routes — anonymity set, shielding distribution, fee distribution.
 * All endpoints query pre-existing indexed tables. Cached for 1 hour.
 */

const express = require('express');
const { logSafeError } = require('../lib/safe-log');
const router = express.Router();

const CACHE_TTL = 3600; // 1 hour

async function getCached(redisClient, key) {
  try {
    if (!redisClient?.isOpen) return null;
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

async function setCache(redisClient, key, data) {
  try {
    if (!redisClient?.isOpen) return;
    await redisClient.setEx(key, CACHE_TTL, JSON.stringify(data));
  } catch {}
}

// ============================================================================
// ANONYMITY SET — CDF of shield/deshield counts by amount threshold
// ============================================================================

const AMOUNT_THRESHOLDS_ZAT = [
  1000,          // 0.00001 ZEC
  100000,        // 0.001 ZEC
  1000000,       // 0.01 ZEC
  10000000,      // 0.1 ZEC
  25000000,      // 0.25 ZEC
  50000000,      // 0.5 ZEC
  100000000,     // 1 ZEC
  200000000,     // 2 ZEC
  500000000,     // 5 ZEC
  1000000000,    // 10 ZEC
  2500000000,    // 25 ZEC
  5000000000,    // 50 ZEC
  10000000000,   // 100 ZEC
  50000000000,   // 500 ZEC
  100000000000,  // 1000 ZEC
  1000000000000, // 10000 ZEC
];

router.get('/api/analytics/anonymity-set', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const redisClient = req.app.locals.redisClient;
    const period = req.query.period || '30d';

    const cacheKey = `analytics:anonymity-set:${period}`;
    const cached = await getCached(redisClient, cacheKey);
    if (cached) return res.json(cached);

    let timeFilter = '';
    const params = [];
    if (period !== 'all') {
      const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;
      const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
      timeFilter = 'AND block_time >= $1';
      params.push(cutoff);
    }

    const thresholdCases = AMOUNT_THRESHOLDS_ZAT.map((t, i) =>
      `COUNT(*) FILTER (WHERE amount_zat >= ${t}) AS t${i}`
    ).join(',\n      ');

    const result = await pool.query(`
      SELECT flow_type,
      ${thresholdCases}
      FROM shielded_flows
      WHERE flow_type IN ('shield', 'deshield') ${timeFilter}
      GROUP BY flow_type
    `, params);

    const shield = result.rows.find(r => r.flow_type === 'shield') || {};
    const deshield = result.rows.find(r => r.flow_type === 'deshield') || {};

    const data = AMOUNT_THRESHOLDS_ZAT.map((threshold, i) => ({
      thresholdZat: threshold,
      thresholdZec: threshold / 1e8,
      shieldCount: parseInt(shield[`t${i}`] || '0'),
      deshieldCount: parseInt(deshield[`t${i}`] || '0'),
    }));

    const response = { period, thresholds: data, updatedAt: new Date().toISOString() };
    await setCache(redisClient, cacheKey, response);
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching anonymity set:', error);
    res.status(500).json({ error: 'Failed to fetch anonymity set data' });
  }
});

// ============================================================================
// SHIELDING DISTRIBUTION — log-bucketed histogram of shield/deshield sizes
// ============================================================================

const LOG_BUCKETS = [
  { min: 1, max: 100000, label: '<0.001' },
  { min: 100000, max: 1000000, label: '0.001-0.01' },
  { min: 1000000, max: 10000000, label: '0.01-0.1' },
  { min: 10000000, max: 100000000, label: '0.1-1' },
  { min: 100000000, max: 500000000, label: '1-5' },
  { min: 500000000, max: 1000000000, label: '5-10' },
  { min: 1000000000, max: 5000000000, label: '10-50' },
  { min: 5000000000, max: 10000000000, label: '50-100' },
  { min: 10000000000, max: 100000000000, label: '100-1000' },
  { min: 100000000000, max: null, label: '1000+' },
];

router.get('/api/analytics/shielding-distribution', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const redisClient = req.app.locals.redisClient;
    const period = req.query.period || '30d';

    const cacheKey = `analytics:shielding-dist:${period}`;
    const cached = await getCached(redisClient, cacheKey);
    if (cached) return res.json(cached);

    let timeFilter = '';
    const params = [];
    if (period !== 'all') {
      const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;
      const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
      timeFilter = 'AND block_time >= $1';
      params.push(cutoff);
    }

    const bucketCases = LOG_BUCKETS.map((b, i) => {
      const upper = b.max ? `AND amount_zat < ${b.max}` : '';
      return `COUNT(*) FILTER (WHERE amount_zat >= ${b.min} ${upper}) AS b${i}`;
    }).join(',\n      ');

    const volumeCases = LOG_BUCKETS.map((b, i) => {
      const upper = b.max ? `AND amount_zat < ${b.max}` : '';
      return `COALESCE(SUM(amount_zat) FILTER (WHERE amount_zat >= ${b.min} ${upper}), 0) AS v${i}`;
    }).join(',\n      ');

    const result = await pool.query(`
      SELECT flow_type,
      ${bucketCases},
      ${volumeCases}
      FROM shielded_flows
      WHERE flow_type IN ('shield', 'deshield') ${timeFilter}
      GROUP BY flow_type
    `, params);

    const shield = result.rows.find(r => r.flow_type === 'shield') || {};
    const deshield = result.rows.find(r => r.flow_type === 'deshield') || {};

    const buckets = LOG_BUCKETS.map((bucket, i) => ({
      label: bucket.label,
      minZat: bucket.min,
      maxZat: bucket.max,
      shieldCount: parseInt(shield[`b${i}`] || '0'),
      deshieldCount: parseInt(deshield[`b${i}`] || '0'),
      shieldVolumeZat: parseInt(shield[`v${i}`] || '0'),
      deshieldVolumeZat: parseInt(deshield[`v${i}`] || '0'),
    }));

    const response = { period, buckets, updatedAt: new Date().toISOString() };
    await setCache(redisClient, cacheKey, response);
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching shielding distribution:', error);
    res.status(500).json({ error: 'Failed to fetch shielding distribution' });
  }
});

// ============================================================================
// FEE DISTRIBUTION — daily fee percentiles from transactions
// ============================================================================

router.get('/api/network/fee-distribution', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const redisClient = req.app.locals.redisClient;
    const period = req.query.period || '30d';

    const cacheKey = `analytics:fee-dist:v2:${period}`;
    const cached = await getCached(redisClient, cacheKey);
    if (cached) return res.json(cached);

    const historyAvailable = period === 'all' && (await pool.query("SELECT to_regclass('public.analytics_history_daily') IS NOT NULL AS available")).rows[0]?.available;
    if (historyAvailable) {
      const { rows } = await pool.query("SELECT a.date::text AS date, a.fees FROM analytics_history_daily a JOIN blocks b ON b.height=a.anchor_height AND b.hash=a.anchor_hash ORDER BY a.date");
      const response = { period, daily: rows.map(r=>({date:r.date,p10:r.fees.p10,p25:r.fees.p25,median:r.fees.median,p75:r.fees.p75,p90:r.fees.p90,avgFee:r.fees.avgFee,txCount:r.fees.txCount})), method: 'completed_utc_days_positive_fees' };
      if (response.daily.length) {
        await setCache(redisClient, cacheKey, response);
        return res.json(response);
      }
    }
    const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;
    const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);

    const result = await pool.query(`
      SELECT
        date_trunc('day', to_timestamp(block_time)) AS day,
        percentile_cont(0.10) WITHIN GROUP (ORDER BY fee) AS p10,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY fee) AS p25,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY fee) AS median,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY fee) AS p75,
        percentile_cont(0.90) WITHIN GROUP (ORDER BY fee) AS p90,
        AVG(fee) AS avg_fee,
        COUNT(*) AS tx_count
      FROM transactions
      WHERE fee > 0 AND is_coinbase = false AND block_time >= $1
      GROUP BY day
      ORDER BY day
    `, [cutoff]);

    const data = result.rows.map(row => ({
      date: row.day,
      p10: Math.round(parseFloat(row.p10)),
      p25: Math.round(parseFloat(row.p25)),
      median: Math.round(parseFloat(row.median)),
      p75: Math.round(parseFloat(row.p75)),
      p90: Math.round(parseFloat(row.p90)),
      avgFee: Math.round(parseFloat(row.avg_fee)),
      txCount: parseInt(row.tx_count),
    }));

    const response = { period: period === 'all' ? '30d' : period, requestedPeriod: period,
      ...(period === 'all' ? { historyStatus: 'unavailable' } : {}),
      daily: data, updatedAt: new Date().toISOString() };
    await setCache(redisClient, cacheKey, response);
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching fee distribution:', error);
    res.status(500).json({ error: 'Failed to fetch fee distribution' });
  }
});

// ============================================================================
// BLOCK ACTIVITY — per-block transaction and fee means by completed UTC day
// ============================================================================

const BLOCK_ACTIVITY_DAYS = 90;
const SECONDS_PER_DAY = 86400;

router.get('/api/network/block-activity', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const redisClient = req.app.locals.redisClient;
    const todayUtc = Math.floor(Date.now() / (SECONDS_PER_DAY * 1000));

    // Keyed by day so a newly completed day never waits for the TTL.
    const cacheKey = `analytics:block-activity:v1:${todayUtc}`;
    const cached = await getCached(redisClient, cacheKey);
    if (cached) return res.json(cached);

    const { rows } = await pool.query(`
      SELECT
        "timestamp" / ${SECONDS_PER_DAY} AS day,
        COUNT(*)::int AS blocks,
        COUNT(transaction_count)::int AS tx_blocks,
        SUM(transaction_count)::bigint AS transactions,
        COUNT(total_fees)::int AS fee_blocks,
        SUM(total_fees)::text AS total_fees
      FROM blocks
      WHERE "timestamp" >= $1 AND "timestamp" < $2
      GROUP BY 1
      ORDER BY 1
    `, [(todayUtc - BLOCK_ACTIVITY_DAYS) * SECONDS_PER_DAY, todayUtc * SECONDS_PER_DAY]);

    const points = rows.map((row) => {
      const blocks = Number(row.blocks);
      // An unknown value in a day leaves that day's mean as a gap, never a lower mean.
      const txKnown = Number(row.tx_blocks) === blocks;
      const feesKnown = Number(row.fee_blocks) === blocks;
      return {
        date: new Date(Number(row.day) * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10),
        blocks,
        transactions: txKnown ? Number(row.transactions) : null,
        txPerBlock: txKnown ? Number(row.transactions) / blocks : null,
        totalFeesZat: feesKnown ? row.total_fees : null,
        feesPerBlockZec: feesKnown ? Number(row.total_fees) / blocks / 1e8 : null,
      };
    });

    const response = { days: BLOCK_ACTIVITY_DAYS, method: 'completed_utc_days', points };
    if (points.length) await setCache(redisClient, cacheKey, response);
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching block activity:', error);
    res.status(500).json({ error: 'Failed to fetch block activity' });
  }
});

// ============================================================================
// USAGE CLOCK — transaction counts by hour of day and day of week (UTC)
// ============================================================================

const PERIOD_DAYS = { '30d': 30, '90d': 90, '6m': 183, '1y': 365, 'all': 0 };

router.get('/api/analytics/usage-clock', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const redisClient = req.app.locals.redisClient;
    const period = req.query.period || '1y';
    const days = PERIOD_DAYS[period] ?? 365;

    const cacheKey = `analytics:usage-clock:${period}`;
    const cached = await getCached(redisClient, cacheKey);
    if (cached) return res.json(cached);

    const params = [];
    let whereClause = '';
    if (days > 0) {
      params.push(Math.floor(Date.now() / 1000) - days * 86400);
      whereClause = 'WHERE timestamp > $1';
    }

    const query = `
      SELECT
        EXTRACT(HOUR FROM TO_TIMESTAMP(timestamp))::int AS hour,
        EXTRACT(DOW FROM TO_TIMESTAMP(timestamp))::int AS dow,
        SUM(transaction_count)::int AS tx_count,
        COUNT(*)::int AS block_count
      FROM blocks
      ${whereClause}
      GROUP BY hour, dow
      ORDER BY dow, hour
    `;

    const summaryQuery = `
      SELECT
        COUNT(*)::int AS total_blocks,
        SUM(transaction_count)::int AS total_txs,
        MIN(timestamp) AS first_block,
        MAX(timestamp) AS last_block
      FROM blocks
      ${whereClause}
    `;

    const [result, summaryResult] = await Promise.all([
      pool.query(query, params),
      pool.query(summaryQuery, params),
    ]);

    const heatmap = result.rows.map(r => ({
      hour: r.hour,
      dow: r.dow,
      txCount: r.tx_count,
      blockCount: r.block_count,
    }));

    // Aggregate by hour only
    const hourly = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      txCount: heatmap.filter(r => r.hour === h).reduce((s, r) => s + r.txCount, 0),
    }));

    const peakHour = hourly.reduce((max, h) => h.txCount > max.txCount ? h : max, hourly[0]);
    const lowHour = hourly.reduce((min, h) => h.txCount < min.txCount ? h : min, hourly[0]);

    const summary = summaryResult.rows[0] || {};
    const response = {
      period,
      dateRange: {
        from: summary.first_block ? new Date(summary.first_block * 1000).toISOString().slice(0, 10) : null,
        to: summary.last_block ? new Date(summary.last_block * 1000).toISOString().slice(0, 10) : null,
      },
      totalBlocks: summary.total_blocks || 0,
      totalTxs: summary.total_txs || 0,
      heatmap,
      hourly,
      peakHour: peakHour.hour,
      lowHour: lowHour.hour,
      peakToLowRatio: lowHour.txCount > 0
        ? +(peakHour.txCount / lowHour.txCount).toFixed(2)
        : 0,
    };

    await setCache(redisClient, cacheKey, response);
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching usage clock:', error);
    res.status(500).json({ error: 'Failed to fetch usage clock data' });
  }
});

module.exports = router;
