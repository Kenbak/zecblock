const { createListCache } = require('../list-cache');
const softwareCacheFallback = createListCache({enabled:false});
const { softwareHistory, SoftwareQueryError } = require('../lib/mining-software');
/**
 * Mining Routes
 * /api/mining/pool-distribution, /api/mining/pool-ranking,
 * /api/mining/hashrate-share, /api/mining/rewards, /api/mining/miner-behavior
 */

const express = require('express');
const router = express.Router();
const { POOL_BY_ADDRESS, POOL_BY_TAG, getPoolTagSql, getPoolName } = require('../mining-pools');
const { logSafeError } = require('../lib/safe-log');
const { orphanRates } = require('../lib/orphan-rates');

let pool;
let redisClient;

router.use((req, res, next) => {
  pool = req.app.locals.pool;
  redisClient = req.app.locals.redisClient;
  next();
});

const CACHE_TTL = 300; // 5 minutes

async function getFromCache(key) {
  try {
    if (!redisClient || !redisClient.isOpen) return null;
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

async function setCache(key, data, ttl = CACHE_TTL) {
  try {
    if (!redisClient || !redisClient.isOpen) return;
    await redisClient.setEx(key, ttl, JSON.stringify(data));
  } catch {}
}

function parsePeriod(period) {
  const map = {
    '24h': '24 hours',
    '3d': '3 days',
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
    '6m': '180 days',
    '1y': '365 days',
    'all': null,
  };
  return Object.hasOwn(map, period) ? map[period] : map['7d'];
}

function resolvePoolName(address, tag) {
  return getPoolName(address) || POOL_BY_TAG[tag]?.name || 'Unknown';
}

// ============================================================================
// GET /api/mining/pool-distribution
// Returns block counts per pool for a time period (for pie/donut chart)
// ============================================================================
router.get('/api/mining/software', async (req,res) => {
  try {
    const { period, from, to, bucket } = req.query;
    const data = await (req.app.locals.listCache || softwareCacheFallback).getOrLoad({
      family:'mining-software-v1',params:{period:period??'30d',from:from??null,to:to??null,bucket:bucket??'auto',tipHeight:req.app.locals.chainTip?.height??0,tipHash:req.app.locals.chainTip?.hash??''},
      freshTtlSeconds:60,staleTtlSeconds:61,cacheable:true,shouldCache:value=>value?.success===true,
      load:()=>softwareHistory(pool,{period,from,to,bucket}),
    });
    res.json(data.value);
  } catch(error) {
    if(error instanceof SoftwareQueryError) return res.status(error.status).json({success:false,error:error.status === 400 ? 'Invalid mining software query' : 'Mining data temporarily unavailable'});
    logSafeError('Mining software history failed:',error);
    res.status(500).json({success:false,error:'Mining software history unavailable'});
  }
});

router.get('/api/mining/orphan-rates', async (req, res) => {
  try {
    // Use the request's read pool; no node RPC, writes or schema changes.
    const data = await orphanRates(req.app.locals.pool);
    res.set('Cache-Control', 'public, max-age=30');
    res.json(data);
  } catch (error) {
    logSafeError('Observed orphan rates failed:', error);
    res.status(503).set('Cache-Control', 'no-store').json({ success: false, error: 'Observed orphan rates unavailable' });
  }
});

router.get('/api/mining/pool-distribution', async (req, res) => {
  try {
    const period = req.query.period || '7d';
    const cacheKey = `mining:history-v3:pool-dist:${period}`;

    const cached = await getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const interval = parsePeriod(period);
    const whereClause = interval
      ? `WHERE timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${interval}')`
      : '';

    const result = await pool.query(`
      SELECT
        miner_address,
        ${getPoolTagSql()} AS pool_tag,
        COUNT(*) as block_count,
        SUM(total_fees) as total_fees_zat
      FROM blocks
      ${whereClause}
      GROUP BY miner_address, pool_tag
      ORDER BY block_count DESC
    `);

    const totalBlocks = result.rows.reduce((sum, r) => sum + parseInt(r.block_count), 0);

    // Aggregate multiple addresses per pool
    const poolAgg = {};
    for (const row of result.rows) {
      const name = resolvePoolName(row.miner_address, row.pool_tag);
      if (!poolAgg[name]) {
        poolAgg[name] = { address: name === 'Unknown' ? null : row.miner_address, name, blocks: 0, totalFeesZat: BigInt(0) };
      }
      poolAgg[name].blocks += parseInt(row.block_count);
      poolAgg[name].totalFeesZat += BigInt(row.total_fees_zat || '0');
    }

    const pools = Object.values(poolAgg)
      .map(p => ({
        address: p.address,
        name: p.name,
        blocks: p.blocks,
        share: totalBlocks > 0 ? p.blocks / totalBlocks : 0,
        totalFeesZat: p.totalFeesZat.toString(),
      }))
      .sort((a, b) => b.blocks - a.blocks);

    const response = {
      period,
      totalBlocks,
      pools,
      generatedAt: new Date().toISOString(),
    };

    await setCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching pool distribution:', error);
    res.status(500).json({ error: 'Failed to fetch pool distribution' });
  }
});

// ============================================================================
// GET /api/mining/pool-ranking
// Sorted ranking table with avg block time per pool
// ============================================================================
router.get('/api/mining/pool-ranking', async (req, res) => {
  try {
    const period = req.query.period || '7d';
    const cacheKey = `mining:history-v3:pool-rank:${period}`;

    const cached = await getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const interval = parsePeriod(period);
    const whereClause = interval
      ? `WHERE timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${interval}')`
      : '';

    const result = await pool.query(`
      WITH pool_blocks AS (
        SELECT
          miner_address,
          ${getPoolTagSql()} AS pool_tag,
          COUNT(*) as block_count,
          SUM(total_fees) as total_fees_zat,
          MIN(timestamp) as first_block_ts,
          MAX(timestamp) as last_block_ts
        FROM blocks
        ${whereClause}
        GROUP BY miner_address, pool_tag
      )
      SELECT
        miner_address,
        pool_tag,
        block_count,
        total_fees_zat,
        first_block_ts,
        last_block_ts,
        CASE WHEN block_count > 1
          THEN (last_block_ts - first_block_ts)::numeric / (block_count - 1)
          ELSE NULL
        END as avg_block_interval
      FROM pool_blocks
      ORDER BY block_count DESC
    `);

    const totalBlocks = result.rows.reduce((sum, r) => sum + parseInt(r.block_count), 0);

    // Aggregate multiple addresses per pool
    const poolAgg = {};
    for (const row of result.rows) {
      const name = resolvePoolName(row.miner_address, row.pool_tag);
      const poolInfo = POOL_BY_ADDRESS[row.miner_address] || POOL_BY_TAG[row.pool_tag];
      if (!poolAgg[name]) {
        poolAgg[name] = {
          address: name === 'Unknown' ? null : row.miner_address,
          name,
          url: poolInfo?.url || null,
          region: poolInfo?.region || null,
          blocks: 0,
          totalFeesZat: BigInt(0),
          firstBlockTs: Infinity,
          lastBlockTs: 0,
        };
      }
      poolAgg[name].blocks += parseInt(row.block_count);
      poolAgg[name].totalFeesZat += BigInt(row.total_fees_zat || '0');
      const first = parseInt(row.first_block_ts);
      const last = parseInt(row.last_block_ts);
      if (first < poolAgg[name].firstBlockTs) poolAgg[name].firstBlockTs = first;
      if (last > poolAgg[name].lastBlockTs) poolAgg[name].lastBlockTs = last;
    }

    const ranking = Object.values(poolAgg)
      .sort((a, b) => b.blocks - a.blocks)
      .map((p, idx) => ({
        rank: idx + 1,
        address: p.address,
        name: p.name,
        url: p.url,
        region: p.region,
        blocks: p.blocks,
        share: totalBlocks > 0 ? p.blocks / totalBlocks : 0,
        totalFeesZat: p.totalFeesZat.toString(),
        avgBlockInterval: p.blocks > 1
          ? (p.lastBlockTs - p.firstBlockTs) / (p.blocks - 1)
          : null,
      }));

    const response = { period, totalBlocks, ranking, generatedAt: new Date().toISOString() };
    await setCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching pool ranking:', error);
    res.status(500).json({ error: 'Failed to fetch pool ranking' });
  }
});

// ============================================================================
// GET /api/mining/hashrate-share
// Time series of pool dominance (for stacked area chart)
// ============================================================================
router.get('/api/mining/hashrate-share', async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const cacheKey = `mining:history-v3:hashrate-share:${period}`;

    const cached = await getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const interval = parsePeriod(period);
    const whereClause = interval
      ? `WHERE timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${interval}')`
      : '';

    // Historical rollups are built slowly off-request; never scan the entire
    // block table and its attribution regexes for an all-history chart.
    const result = period === 'all' ? await pool.query(`
      SELECT a.date::text AS day,p.key AS pool_name,p.value AS block_count
      FROM analytics_history_daily a JOIN blocks b ON b.height=a.anchor_height AND b.hash=a.anchor_hash
      CROSS JOIN LATERAL jsonb_each_text(a.mining_pool_blocks) p ORDER BY a.date
    `) : await pool.query(`
      SELECT
        (to_timestamp(timestamp) AT TIME ZONE 'UTC')::date::text as day,
        miner_address,
        ${getPoolTagSql()} AS pool_tag,
        COUNT(*) as block_count
      FROM blocks
      ${whereClause}
      GROUP BY day, miner_address, pool_tag
      ORDER BY day
    `);

    // Aggregate: for each day, compute share per pool
    const dayMap = new Map();
    for (const row of result.rows) {
      const dayKey = row.day;
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, {});
      const poolName = row.pool_name || resolvePoolName(row.miner_address, row.pool_tag);
      const dayPools = dayMap.get(dayKey);
      dayPools[poolName] = (dayPools[poolName] || 0) + parseInt(row.block_count);
    }

    // Build time series: each point = { date, pools: { name: share } }
    const series = [];
    for (const [date, pools] of dayMap.entries()) {
      const total = Object.values(pools).reduce((s, v) => s + v, 0);
      const shares = {};
      for (const [name, count] of Object.entries(pools)) {
        shares[name] = total > 0 ? count / total : 0;
      }
      series.push({ date, totalBlocks: total, pools: shares });
    }

    // Collect all pool names seen
    const allPools = [...new Set(series.flatMap(s => Object.keys(s.pools)))];

    const response = { period, series, allPools, generatedAt: new Date().toISOString() };
    await setCache(cacheKey, response, 600); // 10 min cache for time series
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching hashrate share:', error);
    res.status(500).json({ error: 'Failed to fetch hashrate share' });
  }
});

// ============================================================================
// GET /api/mining/rewards
// Miner reward stats (subsidy, fees, total) for recent blocks
// ============================================================================
router.get('/api/mining/rewards', async (req, res) => {
  try {
    const period = req.query.period || '7d';
    const cacheKey = `mining:history-v3:rewards:${period}`;

    const cached = await getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const interval = parsePeriod(period);
    const whereClause = interval
      ? `WHERE b.timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '${interval}')`
      : '';

    // Block subsidy = coinbase total_output; fees = block.total_fees
    const result = await pool.query(`
      SELECT
        (to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date::text as day,
        COUNT(*) as block_count,
        SUM(b.total_fees) as total_fees_zat,
        SUM(t.total_output) as total_coinbase_output_zat
      FROM blocks b
      JOIN transactions t ON t.block_height = b.height AND t.is_coinbase = true
      ${whereClause}
      GROUP BY day
      ORDER BY day
    `);

    const series = result.rows.map(row => ({
      date: row.day,
      blocks: parseInt(row.block_count),
      totalFeesZat: row.total_fees_zat || '0',
      totalCoinbaseZat: row.total_coinbase_output_zat || '0',
    }));

    const response = { period, series, generatedAt: new Date().toISOString() };
    await setCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching mining rewards:', error);
    res.status(500).json({ error: 'Failed to fetch mining rewards' });
  }
});

// ============================================================================
// GET /api/mining/miner-behavior
// Pre-computed miner sell/hold behavior from snapshot table
// ============================================================================
router.get('/api/mining/miner-behavior', async (req, res) => {
  try {
    const period = req.query.period || '90d';
    const cacheKey = `mining:history-v3:miner-behavior:${period}`;

    const cached = await getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const interval = parsePeriod(period);
    const whereClause = interval
      ? `WHERE date >= CURRENT_DATE - INTERVAL '${interval}'`
      : '';

    // Check if snapshot table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'mining_behavior_daily'
      ) as exists
    `);

    if (!tableCheck.rows[0].exists) {
      return res.json({
        period,
        series: [],
        summary: null,
        message: 'Miner behavior data is being computed. Check back soon.',
        generatedAt: new Date().toISOString(),
      });
    }

    const result = await pool.query(`
      SELECT
        date::text AS date,
        pool_name,
        earned_zat,
        spent_zat,
        held_zat,
        blocks_mined,
        outputs_spent,
        outputs_total
      FROM mining_behavior_daily
      ${whereClause}
      ORDER BY date, pool_name
    `);

    // Group by date for aggregate view
    const byDate = new Map();
    for (const row of result.rows) {
      const dateKey = row.date;
      if (!byDate.has(dateKey)) {
        byDate.set(dateKey, { date: dateKey, earned: BigInt(0), spent: BigInt(0), held: BigInt(0), pools: {} });
      }
      const entry = byDate.get(dateKey);
      const earned = BigInt(row.earned_zat);
      const spent = BigInt(row.spent_zat);
      const held = BigInt(row.held_zat);
      entry.earned += earned;
      entry.spent += spent;
      entry.held += held;
      entry.pools[row.pool_name] = {
        earned: row.earned_zat,
        spent: row.spent_zat,
        held: row.held_zat,
        blocks: parseInt(row.blocks_mined),
      };
    }

    const series = [...byDate.values()].map(entry => ({
      date: entry.date,
      earnedZat: entry.earned.toString(),
      spentZat: entry.spent.toString(),
      heldZat: entry.held.toString(),
      sellRatio: entry.earned > 0n ? Number((entry.spent * 10000n) / entry.earned) / 10000 : 0,
      pools: entry.pools,
    }));

    // Compute overall summary
    const totalEarned = series.reduce((s, r) => s + BigInt(r.earnedZat), 0n);
    const totalSpent = series.reduce((s, r) => s + BigInt(r.spentZat), 0n);
    const summary = {
      totalEarnedZat: totalEarned.toString(),
      totalSpentZat: totalSpent.toString(),
      totalHeldZat: (totalEarned - totalSpent).toString(),
      overallSellRatio: totalEarned > 0n ? Number((totalSpent * 10000n) / totalEarned) / 10000 : 0,
    };

    const response = { period, series, summary, generatedAt: new Date().toISOString() };
    await setCache(cacheKey, response, 900); // 15 min cache
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching miner behavior:', error);
    res.status(500).json({ error: 'Failed to fetch miner behavior' });
  }
});

// ============================================================================
// GET /api/mining/zodl-leaderboard
// Per-pool accumulation ranking — how much of earned rewards each pool holds
// vs. sells over a period (the "ZODL" leaderboard).
// ============================================================================
router.get('/api/mining/zodl-leaderboard', async (req, res) => {
  try {
    const period = req.query.period || '90d';
    const cacheKey = `mining:history-v3:zodl:${period}`;

    const cached = await getFromCache(cacheKey);
    if (cached) return res.json(cached);

    const interval = parsePeriod(period);
    const whereClause = interval
      ? `WHERE b.date >= CURRENT_DATE - INTERVAL '${interval}'`
      : '';

    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'mining_behavior_daily'
      ) as exists
    `);

    if (!tableCheck.rows[0].exists) {
      return res.json({
        period,
        pools: [],
        summary: null,
        message: 'Miner behavior data is being computed. Check back soon.',
        generatedAt: new Date().toISOString(),
      });
    }

    // Join the destination breakdown (shielded / exchange / bridge / other).
    // Days not yet classified contribute 0 to the breakdown; the remainder of
    // each pool's spend is reported as "unclassified" so totals always reconcile.
    const result = await pool.query(`
      SELECT
        b.pool_name,
        SUM(b.earned_zat)::numeric AS earned,
        SUM(b.spent_zat)::numeric AS spent,
        SUM(b.held_zat)::numeric AS held,
        SUM(b.blocks_mined)::bigint AS blocks,
        COUNT(DISTINCT b.date) AS active_days,
        COALESCE(SUM(d.shielded_zat), 0)::numeric AS shielded,
        COALESCE(SUM(d.exchange_zat), 0)::numeric AS exchange,
        COALESCE(SUM(d.bridge_zat),   0)::numeric AS bridge,
        COALESCE(SUM(d.other_zat),    0)::numeric AS classified_other,
        COUNT(DISTINCT d.date) AS classified_days
      FROM mining_behavior_daily b
      LEFT JOIN miner_destination_daily d
        ON d.date = b.date AND d.pool_name = b.pool_name
      ${whereClause}
      GROUP BY b.pool_name
      HAVING SUM(b.earned_zat) > 0
      ORDER BY held DESC
    `);

    const pools = result.rows.map((row) => {
      const earned = BigInt(row.earned);
      const spent = BigInt(row.spent);
      const held = BigInt(row.held);
      const shielded = BigInt(row.shielded);
      const exchange = BigInt(row.exchange);
      const bridge = BigInt(row.bridge);
      const classifiedOther = BigInt(row.classified_other);
      // Spend not yet classified (days missing from destination table).
      let unclassified = spent - shielded - exchange - bridge - classifiedOther;
      if (unclassified < 0n) unclassified = 0n;
      const otherTransparent = classifiedOther + unclassified;
      const ratio = (v) => (earned > 0n ? Number((v * 10000n) / earned) / 10000 : 0);
      return {
        pool: row.pool_name,
        earnedZat: earned.toString(),
        spentZat: spent.toString(),
        heldZat: held.toString(),
        shieldedZat: shielded.toString(),
        exchangeZat: exchange.toString(),
        bridgeZat: bridge.toString(),
        otherZat: otherTransparent.toString(),
        blocks: Number(row.blocks),
        activeDays: Number(row.active_days),
        classifiedDays: Number(row.classified_days),
        holdRatio: ratio(held),
        sellRatio: ratio(spent),
        shieldedRatio: ratio(shielded),
        offrampRatio: ratio(exchange + bridge),
        otherRatio: ratio(otherTransparent),
      };
    });

    const sum = (key) => pools.reduce((s, p) => s + BigInt(p[key]), 0n);
    const totalEarned = sum('earnedZat');
    const totalHeld = sum('heldZat');
    const totalSpent = sum('spentZat');
    const totalShielded = sum('shieldedZat');
    const totalOfframp = pools.reduce((s, p) => s + BigInt(p.exchangeZat) + BigInt(p.bridgeZat), 0n);
    const ratioOf = (v) => (totalEarned > 0n ? Number((v * 10000n) / totalEarned) / 10000 : 0);
    const summary = {
      totalEarnedZat: totalEarned.toString(),
      totalHeldZat: totalHeld.toString(),
      totalSpentZat: totalSpent.toString(),
      totalShieldedZat: totalShielded.toString(),
      totalOfframpZat: totalOfframp.toString(),
      networkHoldRatio: ratioOf(totalHeld),
      networkShieldedRatio: ratioOf(totalShielded),
      networkOfframpRatio: ratioOf(totalOfframp),
      poolCount: pools.length,
    };

    const response = { period, pools, summary, generatedAt: new Date().toISOString() };
    await setCache(cacheKey, response, 900); // 15 min cache
    res.json(response);
  } catch (error) {
    logSafeError('Error fetching ZODL leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch ZODL leaderboard' });
  }
});

module.exports = router;
