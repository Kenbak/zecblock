/**
 * Cross-chain Routes (NEAR Intents)
 * /api/crosschain/*
 */

const express = require('express');
const router = express.Router();
const { mainnetOnly } = require('../lib/network-features');
router.use('/api/crosschain', mainnetOnly('NEAR Intents'));
router.use(require('./crosschain-analytics'));
router.use(require('./crosschain-venues'));
const { getNearIntentsClient, CHAIN_CONFIG } = require('../near-intents');
const { validate } = require('../validation');
const { parseSafePagePagination, offsetExceededError } = require('../lib/pagination');
const { logSafeError } = require('../lib/safe-log');

// cross_chain_swaps grows steadily but is far smaller than the on-chain
// tables; still capped so a scraper incrementing `page` indefinitely can't
// force an ever-growing OFFSET scan.
const MAX_CROSSCHAIN_HISTORY_OFFSET = 50_000;

/**
 * GET /api/crosschain/stats
 * Get cross-chain ZEC swap statistics via NEAR Intents
 */
router.get('/api/crosschain/stats', async (req, res) => {
  try {
    const client = getNearIntentsClient();

    // Check if API key is configured
    if (!client.hasApiKey()) {
      return res.status(503).json({
        success: false,
        error: 'NEAR Intents API key not configured',
        message: 'Set NEAR_INTENTS_API_KEY environment variable',
        docsUrl: 'https://docs.near-intents.org/near-intents/integration/distribution-channels/intents-explorer-api',
      });
    }

    console.log('🌉 [CROSSCHAIN] Fetching cross-chain stats...');

    const stats = await client.getCrossChainStats();

    res.json({
      success: true,
      ...stats,
      chainConfig: CHAIN_CONFIG,
    });
  } catch (error) {
    logSafeError('❌ [CROSSCHAIN] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch cross-chain stats',
    });
  }
});

/**
 * GET /api/crosschain/inflows
 * Get recent ZEC inflows (other chains → ZEC)
 */
router.get('/api/crosschain/inflows', async (req, res) => {
  try {
    const client = getNearIntentsClient();

    if (!client.hasApiKey()) {
      return res.status(503).json({
        success: false,
        error: 'NEAR Intents API key not configured',
      });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const page = parseInt(req.query.page) || 1;

    const data = await client.getZecInflows({ limit, page });

    res.json({
      success: true,
      ...data,
    });
  } catch (error) {
    logSafeError('❌ [CROSSCHAIN] Inflows error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch cross-chain inflows',
    });
  }
});

/**
 * GET /api/crosschain/outflows
 * Get recent ZEC outflows (ZEC → other chains)
 */
router.get('/api/crosschain/outflows', async (req, res) => {
  try {
    const client = getNearIntentsClient();

    if (!client.hasApiKey()) {
      return res.status(503).json({
        success: false,
        error: 'NEAR Intents API key not configured',
      });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const page = parseInt(req.query.page) || 1;

    const data = await client.getZecOutflows({ limit, page });

    res.json({
      success: true,
      ...data,
    });
  } catch (error) {
    logSafeError('❌ [CROSSCHAIN] Outflows error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch cross-chain outflows',
    });
  }
});

/**
 * GET /api/crosschain/status
 * Check if NEAR Intents integration is configured
 */
router.get('/api/crosschain/status', async (req, res) => {
  const client = getNearIntentsClient();

  res.json({
    success: true,
    configured: client.hasApiKey(),
    message: client.hasApiKey()
      ? 'NEAR Intents API configured'
      : 'NEAR Intents API key not set. Cross-chain features disabled.',
    docsUrl: 'https://docs.near-intents.org/near-intents/integration/distribution-channels/intents-explorer-api',
  });
});

// ============================================================================
// In-memory cache with stale-while-revalidate for expensive DB queries
// ============================================================================
const cache = {};
const refreshing = {};

function getCached(key, ttlMs) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}

function getStale(key) {
  const entry = cache[key];
  return entry ? entry.data : null;
}

function setCache(key, data) {
  cache[key] = { data, ts: Date.now() };
}

// ============================================================================
// Historical endpoints (from PostgreSQL cross_chain_swaps table)
// ============================================================================

/**
 * GET /api/crosschain/db-stats
 * Reads pre-computed materialized views — instant response.
 * Views are refreshed every 5 min by the sync-crosschain-swaps.js cron job.
 */
router.get('/api/crosschain/db-stats', async (req, res) => {
  try {
    const cached = getCached('db-stats', 30_000);
    if (cached) return res.json(cached);

    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database pool not available' });
    }

    const [summaryRes, volumeRes, latencyRes, recentRes, walletsRes] = await Promise.all([
      pool.query('SELECT * FROM mv_crosschain_summary LIMIT 1'),
      pool.query('SELECT * FROM mv_crosschain_volume_24h'),
      pool.query('SELECT * FROM mv_crosschain_latency'),
      pool.query(`
        SELECT deposit_address, direction, source_chain, source_token, source_amount, source_amount_usd,
          dest_chain, dest_token, dest_amount, dest_amount_usd,
          zec_txid, source_tx_hashes, dest_tx_hashes, status, swap_created_at
        FROM cross_chain_swaps WHERE status = 'SUCCESS'
        ORDER BY swap_created_at DESC LIMIT 20
      `),
      pool.query(`
        SELECT COUNT(DISTINCT sender) as unique_wallets
        FROM cross_chain_swaps, LATERAL unnest(senders) AS sender
        WHERE status = 'SUCCESS'
          AND swap_created_at >= NOW() - INTERVAL '30 days'
          AND sender IS NOT NULL AND sender != ''
      `).catch(() => ({ rows: [{ unique_wallets: null }] })),
    ]);

    const s = summaryRes.rows[0] || {};

    const buildFlows = (dir) => {
      const byChain = {};
      for (const r of volumeRes.rows) {
        if (r.direction !== dir) continue;
        const chain = r.chain?.toLowerCase() || 'unknown';
        if (chain === 'zec') continue;
        if (!byChain[chain]) {
          const config = CHAIN_CONFIG[chain] || { name: chain, color: '#888' };
          byChain[chain] = { chain, chainName: config.name || chain, totalVolume24h: 0, tokens: [] };
        }
        byChain[chain].totalVolume24h += parseFloat(r.volume_usd || 0);
        byChain[chain].tokens.push({ symbol: r.token || 'UNKNOWN', volume24h: parseFloat(r.volume_usd || 0) });
      }
      return Object.values(byChain)
        .sort((a, b) => b.totalVolume24h - a.totalVolume24h)
        .map(c => ({ ...c, totalVolume24h: parseFloat(c.totalVolume24h.toFixed(2)), volumeUsd: parseFloat(c.totalVolume24h.toFixed(2)) }));
    };

    const formatSwap = (r) => {
      const isInflow = r.direction === 'inflow';
      const srcHash = Array.isArray(r.source_tx_hashes) && r.source_tx_hashes.length > 0 ? r.source_tx_hashes[0] : null;
      const dstHash = Array.isArray(r.dest_tx_hashes) && r.dest_tx_hashes.length > 0 ? r.dest_tx_hashes[0] : r.zec_txid;
      return {
        id: r.deposit_address, timestamp: new Date(r.swap_created_at).getTime(),
        direction: isInflow ? 'in' : 'out',
        fromChain: isInflow ? (r.source_chain || 'unknown') : 'zec',
        toChain: isInflow ? 'zec' : (r.dest_chain || 'unknown'),
        fromAmount: parseFloat(r.source_amount) || 0,
        fromSymbol: isInflow ? (r.source_token || 'UNKNOWN') : 'ZEC',
        toAmount: parseFloat(r.dest_amount) || 0,
        toSymbol: isInflow ? 'ZEC' : (r.dest_token || 'UNKNOWN'),
        amountUsd: parseFloat(isInflow ? r.source_amount_usd : r.dest_amount_usd) || 0,
        status: r.status || 'SUCCESS', zecTxid: r.zec_txid || null,
        sourceTxHash: isInflow ? srcHash : r.zec_txid,
        destTxHash: isInflow ? r.zec_txid : dstHash,
      };
    };

    const mapLatency = (dir) => latencyRes.rows
      .filter(r => r.direction === dir)
      .map(r => {
        const chain = r.chain?.toLowerCase() || 'unknown';
        const config = CHAIN_CONFIG[chain] || { name: chain };
        return {
          chain, chainName: config.name || chain,
          avgMinutes: parseFloat(parseFloat(r.avg_minutes || 0).toFixed(1)),
          medianMinutes: parseFloat(parseFloat(r.median_minutes || 0).toFixed(1)),
          swapCount: parseInt(r.swap_count || 0),
        };
      })
      .sort((a, b) => b.swapCount - a.swapCount);

    const uniqueWallets = walletsRes.rows[0]?.unique_wallets;

    const result = {
      success: true,
      totalVolume24h: parseFloat(parseFloat(s.volume_24h || 0).toFixed(2)),
      totalSwaps24h: parseInt(s.swaps_24h || 0),
      totalSwapsAllTime: parseInt(s.swaps_all_time || 0),
      totalVolumeAllTime: parseFloat(parseFloat(s.volume_all_time || 0).toFixed(2)),
      inflows: buildFlows('inflow'),
      outflows: buildFlows('outflow'),
      recentSwaps: recentRes.rows.map(formatSwap),
      latencyByChain: mapLatency('inflow'),
      latencyOutflows: mapLatency('outflow'),
      uniqueWallets30d: uniqueWallets ? parseInt(uniqueWallets) : null,
      chainConfig: CHAIN_CONFIG,
    };
    setCache('db-stats', result);
    res.json(result);
  } catch (error) {
    logSafeError('❌ [CROSSCHAIN] db-stats error:', error);
    const stale = getStale('db-stats');
    if (stale) return res.json(stale);
    res.status(500).json({ success: false, error: 'Failed to fetch cross-chain stats' });
  }
});

/**
 * GET /api/crosschain/trends
 * Historical volume trends from stored swap data
 * ?period=7d|30d|90d  &granularity=daily|weekly
 */
router.get('/api/crosschain/trends', validate('crosschainTrends'), async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const granularity = req.query.granularity || 'daily';
    const cacheKey = `trends-${period}-${granularity}`;
    const cached = getCached(cacheKey, 300_000);
    if (cached) return res.json(cached);

    const pool = req.app.locals.pool;

    const days = period === 'all' ? null : period === '1y' ? 365 : period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const granIsWeekly = granularity === 'weekly';

    const { rows } = granIsWeekly
      ? await pool.query(`
          SELECT DATE_TRUNC('week', day) as period, direction,
            SUM(swap_count)::int as swap_count, SUM(volume_usd)::float as volume_usd
          FROM mv_crosschain_trends
          WHERE ($1::int IS NULL OR day >= CURRENT_DATE - $1::int)
          GROUP BY period, direction ORDER BY period
        `, [days])
      : await pool.query(`
          SELECT day as period, direction, swap_count, volume_usd
          FROM mv_crosschain_trends
          WHERE ($1::int IS NULL OR day >= CURRENT_DATE - $1::int)
          ORDER BY day
        `, [days]);

    // Pivot into { period, inflow_volume, outflow_volume, inflow_count, outflow_count }
    const byPeriod = {};
    for (const r of rows) {
      const key = r.period.toISOString().slice(0, 10);
      if (!byPeriod[key]) byPeriod[key] = { date: key, inflowVolume: 0, outflowVolume: 0, inflowCount: 0, outflowCount: 0 };
      if (r.direction === 'inflow') {
        byPeriod[key].inflowVolume = parseFloat(r.volume_usd);
        byPeriod[key].inflowCount = parseInt(r.swap_count);
      } else {
        byPeriod[key].outflowVolume = parseFloat(r.volume_usd);
        byPeriod[key].outflowCount = parseInt(r.swap_count);
      }
    }

    const data = Object.values(byPeriod).sort((a, b) => a.date.localeCompare(b.date));

    // Compute period-over-period change
    let volumeChange = 0;
    if (data.length >= 2) {
      const half = Math.floor(data.length / 2);
      const recentHalf = data.slice(half);
      const olderHalf = data.slice(0, half);
      const recentVol = recentHalf.reduce((s, d) => s + d.inflowVolume + d.outflowVolume, 0);
      const olderVol = olderHalf.reduce((s, d) => s + d.inflowVolume + d.outflowVolume, 0);
      volumeChange = olderVol > 0 ? ((recentVol - olderVol) / olderVol * 100) : 0;
    }

    const result = { success: true, period, granularity, volumeChange: parseFloat(volumeChange.toFixed(1)), data };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error) {
    logSafeError('Trends error:', error);
    const stale = getStale(cacheKey);
    if (stale) return res.json(stale);
    res.status(500).json({ success: false, error: 'Failed to fetch cross-chain trends' });
  }
});

/**
 * GET /api/crosschain/history
 * Paginated historical swap list from DB
 * ?page=1&limit=25&direction=inflow|outflow&chain=eth
 */
router.get('/api/crosschain/history', validate('crosschainHistory'), async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { limit, page, offset, requestedOffset, offsetExceeded } = parseSafePagePagination(req.query, {
      defaultLimit: 25,
      maxLimit: 100,
      maxOffset: MAX_CROSSCHAIN_HISTORY_OFFSET,
    });

    if (offsetExceeded) {
      return res.status(400).json(offsetExceededError({
        requestedOffset,
        maxOffset: MAX_CROSSCHAIN_HISTORY_OFFSET,
      }));
    }

    const direction = req.query.direction;
    const chain = req.query.chain;

    const conditions = ["status = 'SUCCESS'"];
    const params = [];
    let idx = 1;

    if (direction) { conditions.push(`direction = $${idx++}`); params.push(direction); }
    if (chain) { conditions.push(`(source_chain = $${idx} OR dest_chain = $${idx})`); params.push(chain); idx++; }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*) as total FROM cross_chain_swaps ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const { rows } = await pool.query(`
      SELECT deposit_address, direction, source_chain, source_token, source_amount, source_amount_usd,
             dest_chain, dest_token, dest_amount, dest_amount_usd,
             zec_txid, matched, swap_created_at,
             source_tx_hashes, dest_tx_hashes
      FROM cross_chain_swaps ${where}
      ORDER BY swap_created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, params);

    res.json({
      success: true,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      swaps: rows.map(r => ({
        id: r.deposit_address,
        direction: r.direction,
        sourceChain: r.source_chain,
        sourceToken: r.source_token,
        sourceAmount: parseFloat(r.source_amount),
        sourceAmountUsd: parseFloat(r.source_amount_usd),
        destChain: r.dest_chain,
        destToken: r.dest_token,
        destAmount: parseFloat(r.dest_amount),
        destAmountUsd: parseFloat(r.dest_amount_usd),
        zecTxid: r.zec_txid,
        matched: r.matched,
        timestamp: new Date(r.swap_created_at).getTime(),
        sourceTxHashes: r.source_tx_hashes,
        destTxHashes: r.dest_tx_hashes,
      })),
    });
  } catch (error) {
    logSafeError('History error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch cross-chain history' });
  }
});

/**
 * GET /api/crosschain/volume-by-chain
 * Aggregated volume by chain for a given period
 * ?period=7d|30d
 */
router.get('/api/crosschain/volume-by-chain', validate('volumeByChain'), async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const days = req.query.period === '7d' ? 7 : 30;

    const { rows } = await pool.query(`
      SELECT
        CASE WHEN direction = 'inflow' THEN source_chain ELSE dest_chain END as chain,
        direction,
        COUNT(*) as swap_count,
        COALESCE(SUM(source_amount_usd), 0) as volume_usd,
        COALESCE(AVG(source_amount_usd), 0) as avg_size_usd
      FROM cross_chain_swaps
      WHERE status = 'SUCCESS'
        AND swap_created_at >= NOW() - ($1 || ' days')::INTERVAL
      GROUP BY chain, direction
      ORDER BY volume_usd DESC
    `, [days]);

    res.json({ success: true, period: `${days}d`, chains: rows.map(r => ({
      chain: r.chain,
      direction: r.direction,
      swapCount: parseInt(r.swap_count),
      volumeUsd: parseFloat(parseFloat(r.volume_usd).toFixed(2)),
      avgSizeUsd: parseFloat(parseFloat(r.avg_size_usd).toFixed(2)),
    }))});
  } catch (error) {
    logSafeError('Volume by chain error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch cross-chain volume by chain' });
  }
});

/**
 * GET /api/crosschain/address/:address
 * Cross-chain activity for a specific ZEC address
 */
router.get('/api/crosschain/address/:address', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const { address } = req.params;

    // Find swaps linked to this address via zec_address column
    // OR by matching zec_txid against transaction outputs/inputs for this address
    const { rows } = await pool.query(`
      (
        SELECT deposit_address, direction, source_chain, source_token,
               source_amount, source_amount_usd, dest_chain, dest_token,
               dest_amount, dest_amount_usd, zec_txid, swap_created_at,
               source_tx_hashes, dest_tx_hashes
        FROM cross_chain_swaps
        WHERE zec_address = $1 AND status = 'SUCCESS' AND matched = true
      )
      UNION
      (
        SELECT ccs.deposit_address, ccs.direction, ccs.source_chain, ccs.source_token,
               ccs.source_amount, ccs.source_amount_usd, ccs.dest_chain, ccs.dest_token,
               ccs.dest_amount, ccs.dest_amount_usd, ccs.zec_txid, ccs.swap_created_at,
               ccs.source_tx_hashes, ccs.dest_tx_hashes
        FROM cross_chain_swaps ccs
        JOIN transaction_outputs tou ON tou.txid = ccs.zec_txid AND tou.address = $1
        WHERE ccs.status = 'SUCCESS' AND ccs.matched = true AND ccs.zec_address IS NULL
      )
      ORDER BY swap_created_at DESC
      LIMIT 50
    `, [address]);

    const totalVolumeUsd = rows.reduce((s, r) => s + (parseFloat(r.source_amount_usd) || 0), 0);
    const entryCount = rows.filter(r => r.direction === 'inflow').length;
    const exitCount = rows.filter(r => r.direction === 'outflow').length;

    res.json({
      success: true,
      address,
      totalSwaps: rows.length,
      totalVolumeUsd: parseFloat(totalVolumeUsd.toFixed(2)),
      entryCount,
      exitCount,
      swaps: rows.map(r => ({
        id: r.deposit_address,
        direction: r.direction,
        sourceChain: r.source_chain,
        sourceToken: r.source_token,
        sourceAmount: parseFloat(r.source_amount),
        sourceAmountUsd: parseFloat(r.source_amount_usd),
        destChain: r.dest_chain,
        destToken: r.dest_token,
        destAmount: parseFloat(r.dest_amount),
        destAmountUsd: parseFloat(r.dest_amount_usd),
        zecTxid: r.zec_txid,
        timestamp: new Date(r.swap_created_at).getTime(),
      })),
    });
  } catch (error) {
    logSafeError('Address crosschain error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch cross-chain activity for address' });
  }
});

/**
 * GET /api/crosschain/popular-pairs
 * Top token+chain combos ranked by 30d swap count for dynamic sorting
 * Returns: [{ chain: "eth", token: "USDC", swapCount: 42 }, ...]
 */
router.get('/api/crosschain/popular-pairs', async (req, res) => {
  try {
    const cached = getCached('popular-pairs', 300_000);
    if (cached) return res.json(cached);

    const pool = req.app.locals.pool;
    const { rows } = await pool.query(
      'SELECT chain, token, swap_count FROM mv_crosschain_popular_pairs ORDER BY swap_count DESC'
    );

    const result = {
      success: true,
      pairs: rows.map(r => ({
        chain: r.chain,
        token: r.token,
        swapCount: parseInt(r.swap_count),
      })),
    };
    setCache('popular-pairs', result);
    res.json(result);
  } catch (error) {
    logSafeError('Popular pairs error:', error);
    const stale = getStale('popular-pairs');
    if (stale) return res.json(stale);
    res.status(500).json({ success: false, error: 'Failed to fetch popular pairs' });
  }
});

/**
 * GET /api/crosschain/size-distribution
 * Swap-size buckets from the swap_amount_stats_daily table (30d).
 * Returns: { buckets: [{ bucket, centroid, swapCount, volumeUsd }] }
 */
router.get('/api/crosschain/size-distribution', async (req, res) => {
  try {
    const cached = getCached('size-distribution', 300_000);
    if (cached) return res.json(cached);

    const pool = req.app.locals.pool;
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Database pool not available' });
    }

    const { rows } = await pool.query(`
      SELECT
        amount_bucket as centroid,
        SUM(swap_count)::int as swap_count,
        SUM(total_volume_usd)::float as volume_usd
      FROM swap_amount_stats_daily
      WHERE date >= (CURRENT_DATE - INTERVAL '30 days')
      GROUP BY amount_bucket
      ORDER BY amount_bucket
    `);

    const result = {
      success: true,
      buckets: rows.map(r => ({
        bucket: `${parseFloat(r.centroid).toFixed(0)}`,
        centroid: parseFloat(r.centroid),
        swapCount: parseInt(r.swap_count),
        volumeUsd: parseFloat(parseFloat(r.volume_usd).toFixed(2)),
      })),
    };
    setCache('size-distribution', result);
    res.json(result);
  } catch (error) {
    logSafeError('Size distribution error:', error);
    const stale = getStale('size-distribution');
    if (stale) return res.json(stale);
    res.status(500).json({ success: false, error: 'Failed to fetch size distribution' });
  }
});

module.exports = router;
