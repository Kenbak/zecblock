/**
 * Privacy Routes
 *
 * Handles privacy analysis and risk detection endpoints backed by
 * precomputed linkage edges and batch clusters.
 */

const express = require('express');
const router = express.Router();
const { isNonMainnet, mainnetOnly } = require('../lib/network-features');
// These precomputed analytics have no producer on testnet. Preserve the
// on-chain common-amount, fee-lane and wallet-fingerprint endpoints there.
router.use([
  '/api/privacy/risks', '/api/privacy/linkage-edges', '/api/privacy/batch-risks',
  '/api/privacy/clusters', '/api/privacy/graph', '/api/privacy/shield',
  '/api/privacy/patterns',
], mainnetOnly('Precomputed privacy analytics'));
router.use('/api/privacy/recommended-swap-amounts', mainnetOnly('NEAR Intents'));
router.use('/api/privacy/common-amounts', (req, res, next) => {
  if (isNonMainnet() && req.query.chain) return mainnetOnly('NEAR Intents')(req, res, next);
  next();
});
const { validate } = require('../validation');
const { parseSafeListPagination, offsetExceededError } = require('../lib/pagination');
const { logSafeError } = require('../lib/safe-log');

// privacy_linkage_edges/detected_patterns are curated, expiry-bounded
// tables (90-day TTL on linkage edges), far smaller than raw chain tables,
// but still capped for consistency and to guard against future retention
// changes.
const MAX_PRIVACY_OFFSET = 50_000;

// Dependencies injected via app.locals
let pool;
let redisClient;
let queryPrivacyLinkageEdges;
let queryPrivacyBatchClusters;
let detectBatchDeshields;
let detectBatchForShield;
let getPrivacyGraph;

// Middleware to inject dependencies
router.use((req, res, next) => {
  pool = req.app.locals.pool;
  redisClient = req.app.locals.redisClient;
  queryPrivacyLinkageEdges = req.app.locals.queryPrivacyLinkageEdges;
  queryPrivacyBatchClusters = req.app.locals.queryPrivacyBatchClusters;
  detectBatchDeshields = req.app.locals.detectBatchDeshields;
  detectBatchForShield = req.app.locals.detectBatchForShield;
  getPrivacyGraph = req.app.locals.getPrivacyGraph;
  next();
});


router.get('/api/privacy/risks', validate('privacyRisks'), async (req, res) => {
  try {
    const { limit, offset, requestedOffset, offsetExceeded } = parseSafeListPagination(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
      maxOffset: MAX_PRIVACY_OFFSET,
    });

    if (offsetExceeded) {
      return res.status(400).json({
        success: false,
        ...offsetExceededError({ requestedOffset, maxOffset: MAX_PRIVACY_OFFSET }),
      });
    }

    const { transactions, pagination, riskBreakdown } = await queryPrivacyLinkageEdges(pool, {
      limit,
      offset,
      minScore: req.query.minScore != null ? Number(req.query.minScore) : undefined,
      period: req.query.period,
      riskLevel: req.query.riskLevel,
      sort: req.query.sort,
    });

    const stats = {
      total: pagination.total,
      highRisk: riskBreakdown.HIGH,
      mediumRisk: riskBreakdown.MEDIUM,
      lowRisk: riskBreakdown.LOW,
      avgScore: transactions.length > 0
        ? Math.round(transactions.reduce((sum, row) => sum + row.score, 0) / transactions.length)
        : 0,
      period: req.query.period,
    };

    console.log(`✅ [PRIVACY RISKS] Returning ${transactions.length}/${pagination.total} (H:${riskBreakdown.HIGH} M:${riskBreakdown.MEDIUM} L:${riskBreakdown.LOW})`);

    res.json({
      success: true,
      transactions,
      stats,
      pagination,
    });
  } catch (error) {
    logSafeError('❌ [PRIVACY RISKS] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch privacy risks',
    });
  }
});

router.get('/api/privacy/linkage-edges', validate('privacyLinkageEdges'), async (req, res) => {
  try {
    const { limit, offset, requestedOffset, offsetExceeded } = parseSafeListPagination(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
      maxOffset: MAX_PRIVACY_OFFSET,
    });

    if (offsetExceeded) {
      return res.status(400).json({
        success: false,
        ...offsetExceededError({ requestedOffset, maxOffset: MAX_PRIVACY_OFFSET }),
      });
    }

    const result = await queryPrivacyLinkageEdges(pool, {
      limit,
      offset,
      minScore: Number(req.query.minScore ?? 40),
      period: req.query.period || '7d',
      riskLevel: req.query.riskLevel || 'ALL',
      sort: req.query.sort || 'recent',
      txid: req.query.txid || null,
    });

    res.json({
      success: true,
      edges: result.transactions,
      pagination: result.pagination,
    });
  } catch (error) {
    logSafeError('❌ [LINKAGE EDGES] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch linkage edges',
    });
  }
});

router.get('/api/privacy/batch-risks', validate('privacyBatchRisks'), async (req, res) => {
  try {
    const result = await queryPrivacyBatchClusters(pool, {
      limit: Number(req.query.limit),
      period: req.query.period,
      riskLevel: req.query.riskLevel,
      sort: req.query.sort,
      afterScore: req.query.afterScore ? Number(req.query.afterScore) : null,
      afterAmount: req.query.afterAmount ? Number(req.query.afterAmount) : null,
      minScore: Number(req.query.minScore || 35),
    });

    const stats = {
      total: result.pagination.total,
      highRisk: result.riskBreakdown.HIGH,
      mediumRisk: result.riskBreakdown.MEDIUM,
      lowRisk: result.riskBreakdown.LOW,
      totalZecFlagged: result.patterns.reduce((sum, p) => sum + (p.totalAmountZec || 0), 0),
      period: req.query.period,
      filteredTotal: result.pagination.returned,
    };

    res.json({
      success: true,
      patterns: result.patterns,
      pagination: result.pagination,
      stats,
      algorithm: {
        version: '2.0',
        description: 'Precomputed batch clusters with amount, timing, conservation, and ambiguity scoring',
      },
    });
  } catch (error) {
    logSafeError('❌ [BATCH RISKS] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to detect batch patterns',
    });
  }
});

router.get('/api/privacy/clusters', validate('privacyBatchRisks'), async (req, res) => {
  try {
    const result = await queryPrivacyBatchClusters(pool, {
      limit: Number(req.query.limit),
      period: req.query.period,
      riskLevel: req.query.riskLevel,
      sort: req.query.sort,
      afterScore: req.query.afterScore ? Number(req.query.afterScore) : null,
      afterAmount: req.query.afterAmount ? Number(req.query.afterAmount) : null,
      minScore: Number(req.query.minScore || 35),
    });

    res.json({
      success: true,
      clusters: result.patterns,
      pagination: result.pagination,
    });
  } catch (error) {
    logSafeError('❌ [CLUSTERS] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch clusters',
    });
  }
});

router.get('/api/privacy/graph/:txid', validate('privacyGraph'), async (req, res) => {
  try {
    const graph = await getPrivacyGraph(pool, req.params.txid);
    res.json({ success: true, ...graph });
  } catch (error) {
    logSafeError('❌ [PRIVACY GRAPH] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch privacy graph',
    });
  }
});

router.get('/api/privacy/shield/:txid/batch', validate('privacyGraph'), async (req, res) => {
  try {
    const result = await detectBatchForShield(pool, req.params.txid);
    if (result.error) {
      return res.status(404).json({
        success: false,
        error: result.error,
      });
    }
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logSafeError('❌ [BATCH CHECK] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze shield for batch patterns',
    });
  }
});

/**
 * GET /api/privacy/patterns
 *
 * Get stored legacy patterns from the detected_patterns table.
 */
router.get('/api/privacy/patterns', async (req, res) => {
  try {
    const { limit, offset, requestedOffset, offsetExceeded } = parseSafeListPagination(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
      maxOffset: MAX_PRIVACY_OFFSET,
    });

    if (offsetExceeded) {
      return res.status(400).json({
        success: false,
        ...offsetExceededError({ requestedOffset, maxOffset: MAX_PRIVACY_OFFSET }),
      });
    }

    const patternType = req.query.type?.toUpperCase();
    const riskLevel = (req.query.riskLevel || 'ALL').toUpperCase();

    let whereClause = 'WHERE expires_at > NOW()';
    const params = [];
    let paramIndex = 1;

    if (patternType) {
      whereClause += ` AND pattern_type = $${paramIndex++}`;
      params.push(patternType);
    }

    if (riskLevel !== 'ALL') {
      whereClause += ` AND warning_level = $${paramIndex++}`;
      params.push(riskLevel);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM detected_patterns ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0]?.total) || 0;

    params.push(limit, offset);
    const result = await pool.query(`
      SELECT
        id,
        pattern_type,
        score,
        warning_level,
        shield_txids,
        deshield_txids,
        total_amount_zat / 100000000.0 as total_amount_zec,
        per_tx_amount_zat / 100000000.0 as per_tx_amount_zec,
        batch_count,
        first_tx_time,
        last_tx_time,
        time_span_hours,
        metadata,
        detected_at
      FROM detected_patterns
      ${whereClause}
      ORDER BY score DESC, detected_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `, params);

    const patterns = result.rows.map(row => ({
      id: row.id,
      patternType: row.pattern_type,
      score: row.score,
      warningLevel: row.warning_level,
      shieldTxids: row.shield_txids || [],
      deshieldTxids: row.deshield_txids || [],
      totalAmountZec: parseFloat(row.total_amount_zec),
      perTxAmountZec: parseFloat(row.per_tx_amount_zec),
      batchCount: row.batch_count,
      firstTime: row.first_tx_time,
      lastTime: row.last_tx_time,
      timeSpanHours: parseFloat(row.time_span_hours),
      metadata: row.metadata,
      detectedAt: row.detected_at,
    }));

    res.json({
      success: true,
      patterns,
      pagination: {
        total: totalCount,
        limit,
        offset,
        returned: patterns.length,
        hasMore: offset + limit < totalCount,
      },
      note: 'Legacy detected_patterns view. Prefer /api/privacy/clusters for the new linkage pipeline.',
    });
  } catch (error) {
    if (error.code === '42P01') {
      return res.json({
        success: true,
        patterns: [],
        pagination: { total: 0, limit: 0, offset: 0, returned: 0, hasMore: false },
        note: 'Pattern detection table not yet initialized. Run the migration.',
      });
    }

    logSafeError('❌ [PATTERNS] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch patterns',
    });
  }
});

/**
 * GET /api/privacy/common-amounts
 *
 * Get the most common shielding amounts (for privacy education).
 * Users can "blend in" by using popular amounts.
 *
 * Query params:
 *   - period: 24h, 7d, 30d, 90d (default 7d)
 *   - limit: number of amounts to return (default 10, max 50)
 *   - chain: optional source chain (btc, eth, sol, etc.) — cross-references
 *            with cross_chain_swaps to find ZEC amounts that also have common
 *            source-side amounts, giving dual-chain anonymity.
 */

// Redis cache for cross-referenced results (keyed per chain + period)
const COMMON_AMOUNTS_CACHE_PREFIX = 'zcash:common_amounts:';
const COMMON_AMOUNTS_CACHE_TTL = 900; // 15 minutes

router.get('/api/privacy/common-amounts', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
    const chain = (req.query.chain || '').toLowerCase();

    const periodMap = {
      '24h': 24 * 3600,
      '7d': 7 * 24 * 3600,
      '30d': 30 * 24 * 3600,
      '90d': 90 * 24 * 3600,
    };
    const periodKey = req.query.period || '7d';
    const periodSeconds = periodMap[periodKey] || periodMap['7d'];
    const minTime = Math.floor(Date.now() / 1000) - periodSeconds;
    const MIN_AMOUNT_ZAT = 1000000;

    // Try Redis cache
    const cacheKey = `${COMMON_AMOUNTS_CACHE_PREFIX}${chain || 'all'}:${periodKey}`;
    if (redisClient && redisClient.isOpen) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));
      } catch {}
    }

    // Base query: common ZEC shielding amounts from shielded_flows
    const result = await pool.query(`
      SELECT
        ROUND(amount_zat / 100000000.0, 2) as amount_zec,
        COUNT(*) as tx_count,
        COUNT(DISTINCT txid) as unique_txs
      FROM shielded_flows
      WHERE block_time > $1
        AND amount_zat >= $2
      GROUP BY ROUND(amount_zat / 100000000.0, 2)
      ORDER BY tx_count DESC
      LIMIT $3
    `, [minTime, MIN_AMOUNT_ZAT, limit]);

    const totalResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM shielded_flows
      WHERE block_time > $1
        AND amount_zat >= $2
    `, [minTime, MIN_AMOUNT_ZAT]);

    const totalTxs = parseInt(totalResult.rows[0]?.total) || 1;

    // If chain is specified, cross-reference with cross_chain_swaps
    // to find how many swaps from that chain landed on each ZEC amount
    let chainSwapCounts = {};
    let chainSourceAmounts = {};
    if (chain) {
      const zecAmounts = result.rows.map(r => parseFloat(r.amount_zec));
      if (zecAmounts.length > 0) {
        const crossRef = await pool.query(`
          SELECT
            ROUND(dest_amount::numeric, 2) as zec_amount,
            COUNT(*) as swap_count,
            ROUND(AVG(source_amount)::numeric, 6) as avg_source_amount,
            source_token
          FROM cross_chain_swaps
          WHERE source_chain = $1
            AND direction = 'inflow'
            AND status = 'SUCCESS'
            AND swap_created_at >= NOW() - INTERVAL '${periodKey === '90d' ? '90 days' : periodKey === '30d' ? '30 days' : periodKey === '24h' ? '1 day' : '7 days'}'
            AND ROUND(dest_amount::numeric, 2) = ANY($2::numeric[])
          GROUP BY ROUND(dest_amount::numeric, 2), source_token
          ORDER BY swap_count DESC
        `, [chain, zecAmounts]);

        for (const row of crossRef.rows) {
          const key = parseFloat(row.zec_amount);
          chainSwapCounts[key] = (chainSwapCounts[key] || 0) + parseInt(row.swap_count);
          if (!chainSourceAmounts[key]) {
            chainSourceAmounts[key] = {
              avgAmount: parseFloat(row.avg_source_amount),
              token: row.source_token,
            };
          }
        }
      }
    }

    const commonAmounts = result.rows.map(row => {
      const amountZec = parseFloat(row.amount_zec);
      const entry = {
        amountZec,
        txCount: parseInt(row.tx_count),
        percentage: ((parseInt(row.tx_count) / totalTxs) * 100).toFixed(1),
        blendingScore: Math.min(100, Math.round((parseInt(row.tx_count) / totalTxs) * 1000)),
      };

      if (chain && chainSwapCounts[amountZec]) {
        entry.chainSwapCount = chainSwapCounts[amountZec];
        entry.sourceAmount = chainSourceAmounts[amountZec]?.avgAmount || null;
        entry.sourceToken = chainSourceAmounts[amountZec]?.token || null;
        entry.dualBlendScore = entry.blendingScore + Math.min(50, chainSwapCounts[amountZec]);
      }

      return entry;
    });

    // When chain is specified, sort by dual blend score (best on both sides first)
    if (chain) {
      commonAmounts.sort((a, b) => (b.dualBlendScore || b.blendingScore) - (a.dualBlendScore || a.blendingScore));
    }

    const response = {
      success: true,
      period: periodKey,
      chain: chain || null,
      totalTransactions: totalTxs,
      amounts: commonAmounts,
      tip: chain
        ? `Amounts that blend in on both the ${chain.toUpperCase()} and Zcash sides for maximum privacy.`
        : 'Using common amounts helps you blend in with other transactions, making linkability analysis harder.',
    };

    // Cache in Redis
    if (redisClient && redisClient.isOpen) {
      try { await redisClient.setEx(cacheKey, COMMON_AMOUNTS_CACHE_TTL, JSON.stringify(response)); } catch {}
    }

    res.json(response);
  } catch (error) {
    logSafeError('❌ [COMMON AMOUNTS] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch common amounts',
    });
  }
});

/**
 * GET /api/privacy/recommended-swap-amounts
 *
 * Privacy-aware swap amount recommendations based on cross-chain swap patterns.
 * Suggests amounts that blend into the highest-density anonymity sets.
 *
 * Query params:
 *   - chain: Source chain (eth, sol, btc, etc.)
 *   - token: Source token (USDC, BTC, etc.)
 */
router.get('/api/privacy/recommended-swap-amounts', validate('recommendedAmounts'), async (req, res) => {
  try {
    const chain = (req.query.chain || '').toLowerCase();
    const token = (req.query.token || '').toUpperCase();

    if (!chain || !token) {
      return res.status(400).json({
        success: false,
        error: 'chain and token query params required',
      });
    }

    // Stablecoins have price ~$1; non-stablecoins need a sanity check
    // to filter out mislabeled entries (e.g., USDC amounts tagged as SOL)
    const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'UST', 'FRAX'];
    const isStable = stablecoins.includes(token);

    // For non-stablecoins: exclude entries where amount ≈ amount_usd (implied price ~$1),
    // and also exclude extreme outliers beyond the 95th percentile
    let sanityFilter = '';
    if (!isStable) {
      sanityFilter = `
        AND (source_amount_usd = 0 OR ABS(source_amount_usd / NULLIF(source_amount, 0) - 1) > 0.3)
        AND source_amount < (
          SELECT COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY source_amount), 1e18)
          FROM cross_chain_swaps
          WHERE source_chain = $1 AND source_token = $2 AND status = 'SUCCESS'
            AND (source_amount_usd = 0 OR ABS(source_amount_usd / NULLIF(source_amount, 0) - 1) > 0.3)
        )`;
    }

    const { rows } = await pool.query(`
      SELECT
        source_amount as exact_amount,
        COUNT(*) as swap_count
      FROM cross_chain_swaps
      WHERE source_chain = $1 AND source_token = $2
        AND direction = 'inflow' AND status = 'SUCCESS'
        AND source_amount > 0
        AND source_token != 'UNKNOWN_TOKEN'
        AND swap_created_at >= NOW() - INTERVAL '7 days'
        ${sanityFilter}
      GROUP BY source_amount
      ORDER BY swap_count DESC, source_amount
      LIMIT 50
    `, [chain, token]);

    if (rows.length === 0) {
      return res.json({
        success: true,
        chain,
        token,
        recommendations: [],
        tip: `Not enough ${token} swap data from ${chain.toUpperCase()} this week to generate recommendations.`,
      });
    }

    // Group amounts that are within 2% of each other (same "intended" amount)
    const grouped = [];
    const used = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (used.has(i)) continue;
      const amt = parseFloat(rows[i].exact_amount);
      let count = parseInt(rows[i].swap_count);
      for (let j = i + 1; j < rows.length; j++) {
        if (used.has(j)) continue;
        const other = parseFloat(rows[j].exact_amount);
        if (amt > 0 && Math.abs(other - amt) / amt <= 0.02) {
          count += parseInt(rows[j].swap_count);
          used.add(j);
        }
      }
      grouped.push({ amount: amt, swapCount: count });
      used.add(i);
    }

    grouped.sort((a, b) => b.swapCount - a.swapCount);

    const totalSwaps = grouped.reduce((s, g) => s + g.swapCount, 0);

    const recommendations = grouped
      .slice(0, 5)
      .map(g => {
        const pct = (g.swapCount / totalSwaps) * 100;
        return {
          amount: g.amount,
          swapCount: g.swapCount,
          percentage: parseFloat(pct.toFixed(1)),
          blendingScore: pct >= 10 ? 'high' : pct >= 5 ? 'medium' : 'low',
        };
      });

    const topRec = recommendations[0];
    const tip = topRec
      ? `Using common amounts makes your swap harder to trace. ${topRec.percentage}% of ${chain.toUpperCase()}→ZEC swaps this week used ~${topRec.amount} ${token}.`
      : '';

    res.json({
      success: true,
      chain,
      token,
      recommendations,
      tip,
    });
  } catch (error) {
    // Table may not exist yet
    if (error.code === '42P01') {
      return res.json({
        success: true,
        chain: req.query.chain,
        token: req.query.token,
        recommendations: [],
        tip: 'Cross-chain swap data is being collected. Recommendations coming soon.',
      });
    }
    logSafeError('Recommended amounts error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch recommended swap amounts' });
  }
});

// ============================================================================
// FEE LANE ANONYMITY ANALYSIS (ZIP-317)
// ============================================================================

/**
 * GET /api/privacy/fee-lanes?period=30d
 *
 * Computes fee-per-action buckets for shielded transactions using the ZIP-317
 * formula: conventional_actions = max(2, logical_actions), where
 * logical_actions = max(vin, vout) + max(sapling_spends, sapling_outputs)
 *                   + orchard_actions + ironwood_actions.
 *
 * Buckets: standard (5000 zat/action), priority (20000), non-standard (other).
 */
router.get('/api/privacy/fee-lanes', async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const periodDays = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
    const days = periodDays[period] || 30;

    const since = Math.floor(Date.now() / 1000) - days * 86400;

    const cacheKey = `fee-lanes:time-v2:${period}`;
    if (redisClient) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));
      } catch (_) {}
    }

    // conv_actions is a LOWER BOUND on the true ZIP-317 logical action count:
    // we approximate the transparent contribution with max(vin,vout), but the
    // spec counts by byte size (ceil(in/150), ceil(out/34)), which can only be
    // >= the input/output count. Shielded counts are exact. Therefore a tx that
    // follows the 5000 zat/action policy always pays fee = 5000 * true_actions
    // where true_actions >= conv_actions, i.e. fee is (near) a multiple of 5000
    // at or above 5000 * conv_actions.
    //
    // The ±2 zatoshi tolerance handles wallets that end up a few zats short of a
    // round multiple due to "recipient pays fee" / dust-change handling (observed
    // fees like 14999, 99998). Without it these standard-intent txs were wrongly
    // counted as non-standard, inflating that bucket from ~3% to ~11%.
    const NEAR_MULT = `(fee % 5000 <= 2 OR fee % 5000 >= 4998)`;
    const STANDARD_FILTER = `${NEAR_MULT} AND fee >= 5000 * conv_actions - 2 AND fee < 20000 * conv_actions - 2`;
    const PRIORITY_FILTER = `fee BETWEEN 20000 * conv_actions - 2 AND 20000 * conv_actions + 2`;
    const CONV_ACTIONS = `GREATEST(2,
      GREATEST(vin_count, vout_count) +
      GREATEST(sapling_spend_count, sapling_output_count) +
      orchard_actions +
      COALESCE(ironwood_actions, 0)
    )`;

    const [summaryResult, historyResult] = await Promise.all([
      pool.query(`
        WITH fee_calc AS (
          SELECT fee, ${CONV_ACTIONS} AS conv_actions
          FROM transactions
          WHERE block_time >= $1
            AND is_coinbase = false
            AND fee > 0
            AND (has_sapling = true OR has_orchard = true OR has_ironwood = true)
        )
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE ${STANDARD_FILTER}) AS standard,
          COUNT(*) FILTER (WHERE ${PRIORITY_FILTER}) AS priority
        FROM fee_calc
      `, [since]),

      pool.query(`
        WITH fee_calc AS (
          SELECT fee, block_time, ${CONV_ACTIONS} AS conv_actions
          FROM transactions
          WHERE block_time >= $1
            AND is_coinbase = false
            AND fee > 0
            AND (has_sapling = true OR has_orchard = true OR has_ironwood = true)
        )
        SELECT
          to_char(to_timestamp(block_time), 'YYYY-MM-DD') AS date,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE ${STANDARD_FILTER}) AS standard,
          COUNT(*) FILTER (WHERE ${PRIORITY_FILTER}) AS priority
        FROM fee_calc
        GROUP BY 1
        ORDER BY 1
      `, [since]),
    ]);

    const s = summaryResult.rows[0];
    const total = parseInt(s.total);
    const standard = parseInt(s.standard);
    const priority = parseInt(s.priority);
    const nonStandard = Math.max(0, total - standard - priority);

    const response = {
      success: true,
      period,
      totalShieldedTxs: total,
      buckets: {
        standard: { count: standard, pct: total > 0 ? Math.round((standard / total) * 1000) / 10 : 0 },
        priority: { count: priority, pct: total > 0 ? Math.round((priority / total) * 1000) / 10 : 0 },
        non_standard: { count: nonStandard, pct: total > 0 ? Math.round((nonStandard / total) * 1000) / 10 : 0 },
      },
      history: historyResult.rows.map(r => {
        const dayTotal = parseInt(r.total);
        const dayStd = parseInt(r.standard);
        const dayPri = parseInt(r.priority);
        return {
          date: r.date,
          standard: dayStd,
          priority: dayPri,
          non_standard: Math.max(0, dayTotal - dayStd - dayPri),
        };
      }),
    };

    if (redisClient) {
      try { await redisClient.setEx(cacheKey, 3600, JSON.stringify(response)); } catch (_) {}
    }

    res.json(response);
  } catch (error) {
    logSafeError('❌ [FEE LANES] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to compute fee lane distribution' });
  }
});

// ============================================================================
// WALLET FINGERPRINTING
// ============================================================================

/**
 * GET /api/privacy/wallet-fingerprints?period=30d
 *
 * Returns on-chain match counts for known wallet fingerprint patterns.
 * Signals: action padding, expiry delta, nLockTime, fee strategy.
 */
router.get('/api/privacy/wallet-fingerprints', async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const periodDays = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
    const days = periodDays[period] || 30;

    const since = Math.floor(Date.now() / 1000) - days * 86400;

    const cacheKey = `wallet-fingerprints:time-v2:${period}`;
    if (redisClient) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));
      } catch (_) {}
    }

    // Expiry delta is measured as (expiry_height - mined block_height). Because a
    // wallet sets expiry = target_height + BUILD_DELTA at construction time and the
    // tx is mined at some height >= target, the OBSERVED delta = BUILD_DELTA minus
    // the confirmation delay (blocks waited to be mined). So a "+40" wallet produces
    // a decaying distribution 40, 39, 38, ... not a single value. We therefore match
    // a tight window just below each configured peak: this captures the bulk of each
    // wallet's traffic (most txs confirm within a few blocks) while keeping windows
    // non-overlapping. Cross-contamination (a +40 tx delayed >15 blocks landing in
    // the +20 window) is rare and reflected in confidence levels.
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE orchard_actions = 2 AND vin_count = 0 AND vout_count = 0
            AND has_orchard = true
        ) AS sdk_2action,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 16 AND 20
            AND has_orchard = true
        ) AS brave_expiry20,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 36 AND 40
            AND (has_orchard = true OR has_ironwood = true)
        ) AS family_expiry40,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 36 AND 40
            AND has_ironwood = true AND has_orchard = false AND has_sapling = false
            AND vin_count = 0 AND vout_count = 0
        ) AS family40_ironwood_only,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 36 AND 40
            AND has_orchard = true AND has_ironwood = false
            AND vin_count = 0 AND vout_count = 0
        ) AS family40_orchard_shielded,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 36 AND 40
            AND (has_orchard = true OR has_ironwood = true)
            AND (vin_count > 0 OR vout_count > 0)
        ) AS family40_mixed_transparent,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 36 AND 40
            AND has_orchard = true AND has_ironwood = true
            AND vin_count = 0 AND vout_count = 0
        ) AS family40_cross_pool,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 90 AND 100
            AND (has_orchard = true OR has_sapling = true)
        ) AS zkool_expiry100,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 1 AND 6
            AND fee = 40000
            AND locktime = 0
            AND has_orchard = true
            AND vin_count = 0 AND vout_count = 0
        ) AS nozy_expiry5_fee4x,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) BETWEEN 46 AND 60
            AND locktime = 0
            AND (has_orchard = true OR has_ironwood = true)
        ) AS cake_expiry60,

        COUNT(*) FILTER (
          WHERE expiry_height IS NOT NULL AND expiry_height > 0
            AND (expiry_height - block_height) > 20000
            AND orchard_actions >= 6
            AND has_orchard = true
            AND vin_count = 0 AND vout_count = 0
        ) AS migration_batches,

        COUNT(*) FILTER (
          WHERE locktime > 0 AND locktime < 500000000
            AND has_orchard = true
        ) AS nonzero_locktime_height,

        COUNT(*) FILTER (
          WHERE orchard_actions >= 2 AND vin_count = 0 AND vout_count = 0
            AND has_orchard = true
        ) AS total_fully_shielded_orchard,

        COUNT(*) FILTER (
          WHERE has_sapling = true OR has_orchard = true OR has_ironwood = true
        ) AS total_shielded
      FROM transactions
      WHERE block_time >= $1
        AND is_coinbase = false
        AND fee > 0
    `, [since]);

    const r = result.rows[0];
    const familyExpiry40 = parseInt(r.family_expiry40);
    const nozyCount = parseInt(r.nozy_expiry5_fee4x);
    const cakeCount = parseInt(r.cake_expiry60);
    const migrationCount = parseInt(r.migration_batches);
    const ironwoodOnlyCount = parseInt(r.family40_ironwood_only);
    const orchardShieldedCount = parseInt(r.family40_orchard_shielded);
    const mixedTransparentCount = parseInt(r.family40_mixed_transparent);
    const crossPoolCount = parseInt(r.family40_cross_pool);

    const wallets = [
      {
        name: 'ZODL / Vizor (Ironwood sends)',
        description: 'Fully migrated SDK wallets now sending within the Ironwood pool. Expiry +40, standard fee, no transparent component. Primarily ZODL users (largest migrated user base).',
        familyMembers: ['ZODL (iOS)', 'ZODL (Android)', 'Vizor'],
        nym: 'none',
        signals: {
          fee: { value: '5000/action', confidence: 'high', source: 'librustzcash zip317 FeeRule' },
          expiry: { value: '+40 blocks', matchCount: ironwoodOnlyCount, confidence: 'high', source: 'librustzcash DEFAULT_TX_EXPIRY_DELTA = 40. Ironwood-only pool sends.' },
          locktime: { value: '0', confidence: 'high', source: 'librustzcash never sets nLockTime' },
          actionPadding: { value: '2 actions', confidence: 'high', source: 'Standard Ironwood BundleType padding' },
        },
        note: 'Your anonymity set if you are a migrated ZODL/Vizor user sending within Ironwood.',
      },
      {
        name: 'ZODL / Vizor (ZIP-318 migration)',
        description: 'Automated pool migration from Orchard → Ironwood using the zcash_pool_migration crate. Canonical 1-2-5 ZEC denominations batched into high-action transactions.',
        nym: 'none',
        signals: {
          fee: { value: '5000/action', confidence: 'high', source: 'Exact ZIP-317: fee = actions × 5000. Typical: 11-16 actions = 55,000-80,000 zat.' },
          expiry: { value: '>20,000 blocks (~2+ weeks)', matchCount: migrationCount, confidence: 'high', source: 'Long expiry prevents timeout during multi-step automated migration.' },
          locktime: { value: '0', confidence: 'high', source: 'SDK default' },
          actionPadding: { value: '11-16 actions', confidence: 'high', source: 'zcash_pool_migration crate batches canonical denominations. 99.7% have exact ZIP-317 fee.' },
        },
        note: 'Trivially identifiable by high action count + extreme expiry. Zkool uses a different private-splitting approach not captured here.',
      },
      {
        name: 'SDK wallets (cross-pool)',
        description: 'Transactions touching both Orchard and Ironwood pools without transparent components — smaller manual migrations, cross-pool consolidation, or wallet-initiated pool moves with standard +40 expiry.',
        nym: 'none',
        signals: {
          fee: { value: '5000/action', confidence: 'high', source: 'librustzcash zip317 FeeRule' },
          expiry: { value: '+40 blocks', matchCount: crossPoolCount, confidence: 'high', source: 'Standard SDK expiry. Shorter than automated ZIP-318 migration (>20k blocks).' },
          locktime: { value: '0', confidence: 'high', source: 'librustzcash default' },
          actionPadding: { value: '2+ actions', confidence: 'high', source: 'Varies with amounts being moved' },
        },
        note: 'Distinct from ZIP-318 migration (which uses extreme expiry). These are smaller, user-initiated cross-pool sends.',
      },
      {
        name: 'SDK wallets (Orchard pool)',
        description: 'SDK wallets still transacting in Orchard — users who have not yet migrated to Ironwood. Includes Edge, Unstoppable, and older ZODL versions.',
        familyMembers: ['Edge', 'Unstoppable', 'ZODL (pre-migration)', 'Zkool (current)'],
        nym: 'partial',
        nymNote: 'Zkool (within this group) ships Nym mixnet support since PR #1195. Other SDK wallets do not.',
        signals: {
          fee: { value: '5000/action', confidence: 'high', source: 'librustzcash zip317 FeeRule' },
          expiry: { value: '+40 blocks', confidence: 'high', source: 'librustzcash DEFAULT_TX_EXPIRY_DELTA = 40. Orchard-only fully-shielded sends.' },
          locktime: { value: '0', confidence: 'high', source: 'librustzcash never sets nLockTime' },
          actionPadding: { value: '2 actions', matchCount: orchardShieldedCount, confidence: 'high', source: 'librustzcash orchard BundleType pads to 2 actions' },
        },
        note: 'Shrinking pool as users migrate to Ironwood. On-chain indistinguishable between Edge, Unstoppable, ZODL, and Zkool.',
      },
      {
        name: 'SDK wallets (shielding/deshielding)',
        description: 'SDK wallet transactions with transparent inputs or outputs — receiving from exchanges, auto-shielding, or transparent operations. Same +40 expiry as other SDK wallets.',
        nym: 'none',
        signals: {
          fee: { value: '5000/action', confidence: 'high', source: 'ZIP-317 fee includes transparent inputs in logical action count' },
          expiry: { value: '+40 blocks', matchCount: mixedTransparentCount, confidence: 'high', source: 'librustzcash DEFAULT_TX_EXPIRY_DELTA = 40' },
          locktime: { value: '0', confidence: 'high', source: 'librustzcash default' },
          actionPadding: { value: '2 actions', confidence: 'high', source: 'Standard padding' },
        },
        note: 'Transparent component makes these distinguishable from fully-shielded sends but does not reveal which SDK wallet.',
      },
      {
        name: 'Cake Wallet (probable)',
        description: 'Multi-coin wallet using hanh\'s zkool2 backend for Zcash. Auto-shielding by default. Distinguished by +60 block expiry (longer than SDK to accommodate transparent confirmation). Migration uses Zkool\'s private splitting approach.',
        nym: 'none',
        signals: {
          fee: { value: '5000/action', confidence: 'high', source: 'Standard ZIP-317 fee (auto-shield txs have higher fees due to transparent inputs adding logical actions)' },
          expiry: { value: '+60 blocks', matchCount: cakeCount, confidence: 'medium', source: 'Observed delta 46-60 (consistent with +60 setting). Distinct from librustzcash (+40) and Brave (+20).' },
          locktime: { value: '0', confidence: 'high', source: 'zkool2 backend sets locktime=0' },
          actionPadding: { value: '2 actions', confidence: 'high', source: 'Standard Orchard builder padding' },
        },
        note: 'Identified by expiry +60 (non-standard). Uses zkool2 backend (confirmed: cake-tech/cake_wallet commit 424f9e6). Frequent auto-shielding pattern (transparent inputs → shielded).',
      },
      {
        name: 'Brave',
        description: 'Browser wallet with its own C++ ZCash implementation (not librustzcash).',
        nym: 'none',
        signals: {
          fee: { value: '5000/action', confidence: 'medium', source: 'ZIP-317 compliant (brave-core PR #32580)' },
          expiry: { value: '+20 blocks', matchCount: parseInt(r.brave_expiry20), confidence: 'medium', source: 'zcashd legacy default (+20). Also matches legacy zcashd/zebra wallets.' },
          locktime: { value: 'Current height', matchCount: parseInt(r.nonzero_locktime_height), confidence: 'high', source: 'brave-core sets nLockTime = chain tip — the cleanest non-SDK signal we have' },
          actionPadding: { value: '2 actions', confidence: 'medium', source: 'standard Orchard builder padding' },
        },
        note: 'Non-zero nLockTime is the strongest discriminator: librustzcash never sets it.',
      },
      {
        name: 'Nozy',
        description: 'Privacy-first Orchard/Ironwood CLI wallet built in Rust for Zebrad. Uses a custom dynamic fee pilot with 4× ZIP-317 priority and short expiry.',
        nym: 'supported',
        nymNote: 'Nym VPN/mixnet integrated for broadcast IP protection during Ironwood migration and normal sends. Ticketbooks ready.',
        signals: {
          fee: { value: '40000 zat (4× ZIP-317)', matchCount: nozyCount, confidence: 'high', source: 'fee_policy.rs: PRIORITY_MULTIPLIER = 4, always applied. Typical 2-action send = 40,000 zat.' },
          expiry: { value: '+5 blocks', matchCount: nozyCount, confidence: 'high', source: 'fee_policy.rs: PILOT_EXPIRY_DELTA_BLOCKS = 5 (raised from 2 in PR #59). Window 1–6 on-chain.' },
          locktime: { value: '0', confidence: 'high', source: 'orchard_tx.rs: TransactionData::from_parts(..., 0, ...) — hardcoded zero locktime' },
          actionPadding: { value: '2 actions', confidence: 'high', source: 'BundleType::Transactional with orchard Builder (same as librustzcash)' },
        },
        note: 'Highly distinguishable: combination of 4× fee + short expiry is unique on the network. First wallet with mandatory priority fee.',
      },
      {
        name: 'Zkool (historical)',
        description: 'Successor to YWallet (hhanh00). Used a distinctive +100 expiry delta until March 2026.',
        nym: 'supported',
        nymNote: 'Nym mixnet added as pluggable transport and direct Nym Zcash RPC node option (PR #1195).',
        signals: {
          fee: { value: '5000/action', confidence: 'high', source: 'librustzcash FeeRule (zip317)' },
          expiry: { value: '+100 (pre-Mar 2026)', matchCount: parseInt(r.zkool_expiry100), confidence: 'high', source: 'zkool2 commit 393bf2d fixed delta 100→40 on Mar 10 2026' },
          locktime: { value: '0', confidence: 'high', source: 'librustzcash Builder (locktime=0)' },
          actionPadding: { value: '2 actions', confidence: 'high', source: 'librustzcash orchard BundleType pads to 2 actions' },
        },
        note: 'Only historical txs are identifiable. Current Zkool folds into the SDK wallets group.',
      },
      {
        name: 'YWallet (deprecated)',
        description: 'Deprecated mobile wallet, predecessor to Zkool. Custom Warp Sync engine.',
        nym: 'none',
        signals: {
          fee: { value: '5000/action', confidence: 'medium', source: 'ZIP-317 compliant (own builder)' },
          expiry: { value: 'Unknown', confidence: 'low', source: 'custom builder, not verified' },
          locktime: { value: 'Unknown', confidence: 'low', source: 'custom builder' },
          actionPadding: { value: 'Unknown', confidence: 'low', source: 'deprecated' },
        },
      },
    ];

    const response = {
      success: true,
      period,
      totalShielded: parseInt(r.total_shielded),
      totalFullyShieldedOrchard: parseInt(r.total_fully_shielded_orchard),
      wallets,
    };

    if (redisClient) {
      try { await redisClient.setEx(cacheKey, 3600, JSON.stringify(response)); } catch (_) {}
    }

    res.json(response);
  } catch (error) {
    logSafeError('❌ [WALLET FINGERPRINTS] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to compute wallet fingerprints' });
  }
});

module.exports = router;
