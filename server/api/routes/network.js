const { networkSchedule, targetSpacing } = require('../lib/network-schedule');
const { subsidyZat, supplyZat } = require('../lib/network-issuance');
/**
 * Network Routes
 * /api/network/stats, /api/network/fees, /api/network/health, /api/network/peers
 */

const express = require('express');
const { loadHashrateSnapshot, formatHashrate } = require('../lib/hashrate');
const router = express.Router();
const { isTestnet } = require('../lib/network-features');
const { registerNetworkAnalyticsRoutes } = require('./network-analytics');
const { parsePeerClient } = require('../../lib/peer-client');
const { parseSafeListPagination, offsetExceededError } = require('../lib/pagination');
const { logSafeError } = require('../lib/safe-log');
const { applyListCacheHeaders } = require('../list-cache');

// The crawled node census is bounded to the live network's peer count
// (thousands, not millions), but the shared cap still applies for
// consistency and to guard against future growth (e.g. historical node
// tracking).
const MAX_NODES_OFFSET = 50_000;

// Dependencies injected via middleware
let pool;
let callZebraRPC;
let redisClient;
let listCache;

const NODE_SOURCE = process.env.NODE_SOURCE || 'peer';
const { censusTable, CENSUS_VERSION, PEER_WINDOW_SECONDS } = require('../../lib/node-census');
const NODES_TABLE = censusTable(NODE_SOURCE);
const SNAPSHOT_FILTER = NODE_SOURCE === 'crawl' ? `AND census_version = ${CENSUS_VERSION}` : '';

// Middleware to inject dependencies
router.use((req, res, next) => {
  pool = req.app.locals.pool;
  callZebraRPC = req.app.locals.callZebraRPC;
  redisClient = req.app.locals.redisClient;
  listCache = req.app.locals.listCache;
  next();
});

// ============================================================================
// CACHE CONFIGURATION
// ============================================================================

const AVG_BLOCK_TIME_WINDOW = isTestnet() ? 500 : 1000;
const NETWORK_STATS_CACHE_KEY = isTestnet()
  ? 'zcash:network_stats:nu7-v1:testnet-500'
  : 'zcash:network_stats:nu7-v1';
const NETWORK_STATS_CACHE_DURATION = 120; // 2 minutes — network stats don't change fast
const NETWORK_HEALTH_CACHE_KEY = 'zcash:network_health';
const NETWORK_HEALTH_CACHE_DURATION = 60;
const NETWORK_TOPOLOGY_CACHE_KEY = 'zcash:network_topology:census-v2';
const NETWORK_TOPOLOGY_CACHE_DURATION = 300; // 5 minutes — aligned with crawler ingest cycle

// Fallback in-memory cache (if Redis fails)
let networkStatsCache = null;
let networkStatsCacheTime = 0;

async function getOrLoadRoute(options) {
  if (listCache?.getOrLoad) return listCache.getOrLoad(options);
  const value = await options.load({
    measure: async (_name, operation) => operation(),
  });
  return {
    value,
    state: 'BYPASS',
    cacheDurationMs: 0,
    loadTimings: [],
    totalDurationMs: 0,
    refreshScheduled: false,
  };
}

/**
 * Get data from Redis cache
 */
async function getFromRedisCache(key) {
  try {
    if (!redisClient || !redisClient.isOpen) {
      return null;
    }
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logSafeError('Redis GET error:', err);
    return null;
  }
}

/**
 * Set data in Redis cache with TTL
 */
async function setInRedisCache(key, data, ttlSeconds) {
  try {
    if (!redisClient || !redisClient.isOpen) {
      return false;
    }
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(data));
    return true;
  } catch (err) {
    logSafeError('Redis SET error:', err);
    return false;
  }
}

/**
 * Fetch network stats (optimized - 1 PostgreSQL query + 1 RPC call)
 */
async function fetchNetworkStatsOptimized() {
  try {
    // Single optimized PostgreSQL query (FAST!)
    const dbStats = await pool.query(`
      WITH latest AS (
        SELECT height, timestamp, difficulty
        FROM blocks
        ORDER BY height DESC
        LIMIT 1
      ),
      last_24h AS (
        SELECT
          COUNT(*) as blocks_24h,
          AVG(difficulty) as avg_difficulty,
          SUM(transaction_count) as tx_24h,
          -- transaction_count includes each block's mandatory coinbase tx,
          -- which would otherwise inflate "txs per block" with a transaction
          -- nobody sent — exactly one coinbase per block, so COUNT(*) is the
          -- exact amount to subtract, no separate transactions-table query.
          SUM(transaction_count) - COUNT(*) as tx_24h_excl_coinbase,
          AVG(total_fees) as avg_block_fee_zat
        FROM blocks
        WHERE timestamp >= EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')
      ),
      rolling_block_time AS (
        SELECT (MAX(timestamp) - MIN(timestamp))::float / NULLIF(COUNT(*) - 1, 0) AS avg_secs
        FROM (SELECT timestamp FROM blocks ORDER BY height DESC LIMIT ${AVG_BLOCK_TIME_WINDOW}) sub
      )
      SELECT
        latest.height,
        latest.difficulty,
        latest.timestamp,
        last_24h.blocks_24h,
        last_24h.avg_difficulty,
        last_24h.tx_24h,
        last_24h.tx_24h_excl_coinbase,
        last_24h.avg_block_fee_zat,
        rolling_block_time.avg_secs AS rolling_block_time_secs
      FROM latest, last_24h, rolling_block_time
    `);

    if (!dbStats.rows[0]) {
      throw new Error('No blockchain data available');
    }

    const { height, difficulty, timestamp, blocks_24h, avg_difficulty, tx_24h, tx_24h_excl_coinbase, avg_block_fee_zat, rolling_block_time_secs } = dbStats.rows[0];

    const [networkInfo, peerInfo, blockchainInfo, blockSubsidy, hashrateSnapshot] = await Promise.all([
      callZebraRPC('getnetworkinfo').catch(() => null),
      callZebraRPC('getpeerinfo').catch(() => []),
      callZebraRPC('getblockchaininfo').catch(() => null),
      callZebraRPC('getblocksubsidy', [Number(height)]).catch(() => null),
      loadHashrateSnapshot(pool),
    ]);

    // Extract peer count and network details
    const peerCount = networkInfo?.connections || (Array.isArray(peerInfo) ? peerInfo.length : 0);
    const protocolVersion = networkInfo?.protocolversion || null;
    const subversion = networkInfo?.subversion || null;

    // Extract supply and pool data from getblockchaininfo
    let supplyData = null;
    if (blockchainInfo) {
      const chainSupplyZat = supplyZat(blockchainInfo.chainSupply?.chainValueZat);
      const valuePools = blockchainInfo.valuePools || [];

      const transparent = supplyZat(valuePools.find(p => p.id === 'transparent')?.chainValueZat);
      const sprout = supplyZat(valuePools.find(p => p.id === 'sprout')?.chainValueZat);
      const sapling = supplyZat(valuePools.find(p => p.id === 'sapling')?.chainValueZat);
      const orchard = supplyZat(valuePools.find(p => p.id === 'orchard')?.chainValueZat);
      const ironwood = supplyZat(valuePools.find(p => p.id === 'ironwood')?.chainValueZat);
      const lockbox = supplyZat(valuePools.find(p => p.id === 'lockbox')?.chainValueZat);

      const totalShielded = sprout + sapling + orchard + ironwood;
      const shieldedPercentage = chainSupplyZat > 0 ? (totalShielded / chainSupplyZat) * 100 : 0;

      // Get active upgrade
      const upgrades = blockchainInfo.upgrades || {};
      const activeUpgrades = Object.values(upgrades).filter((u) => u.status === 'active');
      const latestUpgrade = activeUpgrades.length > 0
        ? activeUpgrades.reduce((latest, u) => u.activationheight > latest.activationheight ? u : latest)
        : null;

      if ([chainSupplyZat, transparent, sprout, sapling, orchard, ironwood, lockbox].every(value => value !== null)) supplyData = {
        chainSupply: chainSupplyZat / 100000000,
        transparent: transparent / 100000000,
        sprout: sprout / 100000000,
        sapling: sapling / 100000000,
        orchard: orchard / 100000000,
        ironwood: ironwood / 100000000,
        lockbox: lockbox / 100000000,
        totalShielded: totalShielded / 100000000,
        shieldedPercentage: shieldedPercentage,
        sizeOnDisk: blockchainInfo.size_on_disk || 0,
        activeUpgrade: latestUpgrade?.name || null,
        chain: blockchainInfo.chain || 'unknown',
      };
    }

    // Calculate hashrate
    const blocks24h = parseInt(blocks_24h || 0);
    const tx24h = parseInt(tx_24h || 0);
    const tx24hExclCoinbase = parseInt(tx_24h_excl_coinbase || 0);
    const avgBlockTime = rolling_block_time_secs
      ? Math.round(Number(rolling_block_time_secs) * 10) / 10
      : (blocks24h > 0 ? Math.round(86400 / blocks24h) : null);
    const difficultyNum = parseFloat(difficulty || 0);
    const networkHashrate = hashrateSnapshot.windows['24h'].hashrate;
    const avgBlockFee = avg_block_fee_zat != null ? parseFloat(avg_block_fee_zat) / 100000000 : null;

    // Block subsidy from Zebra RPC (dynamic, adjusts at halvings)
    const totalBlockSubsidy = subsidyZat(blockSubsidy?.totalblocksubsidy) === null ? null : blockSubsidy.totalblocksubsidy;
    const minerReward = subsidyZat(blockSubsidy?.miner) === null ? null : blockSubsidy.miner;
    const fundingStreamsTotal = subsidyZat(blockSubsidy?.fundingstreamstotal) === null ? null : blockSubsidy.fundingstreamstotal;
    const lockboxTotal = subsidyZat(blockSubsidy?.lockboxtotal) === null ? null : blockSubsidy.lockboxtotal;
    const dailyRevenue = totalBlockSubsidy === null ? null : blocks24h * totalBlockSubsidy;
    const dailyMinerRevenue = minerReward === null ? null : blocks24h * minerReward;

    return {
      success: true,
      mining: {
        networkHashrate: formatHashrate(networkHashrate),
        networkHashrateRaw: networkHashrate,
        hashrateEstimate: hashrateSnapshot,
        difficulty: difficultyNum,
        schedule: networkSchedule(blockchainInfo),
        targetBlockTime: targetSpacing(networkSchedule(blockchainInfo), Number(height)),
        dailyRevenueMeaning: 'Current subsidy extrapolated over observed 24-hour block count; excludes fees.',
        avgBlockTime, // in seconds
        avgBlockFee, // in ZEC, null if no blocks in the last 24h
        blocks24h,
        blockReward: totalBlockSubsidy,
        minerReward,
        fundingStreams: fundingStreamsTotal,
        lockbox: lockboxTotal,
        dailyRevenue,
        dailyMinerRevenue,
      },
      network: {
        peers: peerCount,
        height: parseInt(height),
        protocolVersion: protocolVersion,
        subversion: subversion,
      },
      blockchain: {
        height: parseInt(height),
        latestBlockTime: parseInt(timestamp),
        syncProgress: 100, // Assume synced if we have recent blocks
        sizeBytes: blockchainInfo?.size_on_disk || 0,
        sizeGB: parseFloat(((blockchainInfo?.size_on_disk || 0) / (1024 * 1024 * 1024)).toFixed(2)),
        tx24h,
        tx24hExclCoinbase,
      },
      supply: supplyData,
      timestamp: Date.now(),
    };
  } catch (error) {
    logSafeError('❌ [NETWORK] Error fetching stats:', error);
    throw error;
  }
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * GET /api/network/stats
 * Get network statistics (cached for 30s)
 */
router.get('/api/network/stats', async (req, res) => {
  try {
    // Try Redis cache first
    const cachedData = await getFromRedisCache(NETWORK_STATS_CACHE_KEY);
    if (cachedData) {
      return res.json({
        ...cachedData,
        cached: true,
        source: 'redis',
      });
    }

    // Fallback to in-memory cache
    const now = Date.now();
    if (networkStatsCache && (now - networkStatsCacheTime) < (NETWORK_STATS_CACHE_DURATION * 1000)) {
      return res.json({
        ...networkStatsCache,
        cached: true,
        source: 'memory',
      });
    }

    // Fetch fresh data
    const stats = await fetchNetworkStatsOptimized();
    stats.apiEndpoints = req.app.locals.apiRouteCount || null;

    // Update Redis cache
    await setInRedisCache(NETWORK_STATS_CACHE_KEY, stats, NETWORK_STATS_CACHE_DURATION);

    // Update in-memory cache (fallback)
    networkStatsCache = stats;
    networkStatsCacheTime = now;

    res.json(stats);
  } catch (error) {
    logSafeError('❌ [NETWORK] Error in API endpoint:', error);

    // Try Redis cache as fallback
    const cachedData = await getFromRedisCache(NETWORK_STATS_CACHE_KEY);
    if (cachedData) {
      return res.json({
        ...cachedData,
        cached: true,
        stale: true,
        source: 'redis',
        warning: 'Using stale Redis data due to fetch error',
      });
    }

    // Try in-memory cache as last resort
    if (networkStatsCache) {
      return res.json({
        ...networkStatsCache,
        cached: true,
        stale: true,
        source: 'memory',
        warning: 'Using stale memory data due to fetch error',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to fetch network stats',
    });
  }
});

/**
 * GET /api/network/fees
 * Get estimated transaction fees per ZIP-317
 * ZIP-317: marginal_fee = 5000 zatoshi/action, grace_actions = 2, p2pkh_standard_fee = 10000 zatoshi
 * Formula: max(marginal_fee * max(grace_actions, logical_actions), p2pkh_standard_fee)
 */
router.get('/api/network/fees', async (req, res) => {
  try {
    console.log('💰 [FEES] Fetching fee estimates...');

    // ZIP-317 conventional fees based on logical actions
    // 2 actions (simple tx): max(5000*2, 10000) = 10000 zatoshi
    // 3 actions: max(5000*3, 10000) = 15000 zatoshi
    // 5 actions (complex): max(5000*5, 10000) = 25000 zatoshi
    res.json({
      success: true,
      fees: {
        low: 0.0001,          // 10,000 zatoshi — simple tx (2 logical actions)
        standard: 0.00015,    // 15,000 zatoshi — typical shielded tx (3 actions)
        high: 0.00025,        // 25,000 zatoshi — complex tx (5 actions)
      },
      unit: 'ZEC',
      zip317: {
        marginalFee: 5000,
        graceActions: 2,
        p2pkhStandardFee: 10000,
        formula: 'max(marginal_fee * max(grace_actions, logical_actions), p2pkh_standard_fee)',
      },
      note: 'Fees follow ZIP-317 proportional fee mechanism. Actual fee depends on the number of logical actions in the transaction.',
      timestamp: Date.now(),
    });

    console.log(`✅ [FEES] Fee estimates returned`);
  } catch (error) {
    logSafeError('❌ [FEES] Error fetching fees:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch fee estimates',
    });
  }
});

/**
 * GET /api/network/health
 * Get Zebra node health status (Zebra 3.0+)
 */
router.get('/api/network/health', async (req, res) => {
  try {
    const cached = await getFromRedisCache(NETWORK_HEALTH_CACHE_KEY);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const zebraHealthUrl = process.env.ZEBRA_HEALTH_URL || 'http://127.0.0.1:8080';

    const [healthyRes, readyRes] = await Promise.allSettled([
      fetch(`${zebraHealthUrl}/healthy`).then(r => ({ status: r.status, ok: r.ok })).catch(() => null),
      fetch(`${zebraHealthUrl}/ready`).then(r => ({ status: r.status, ok: r.ok })).catch(() => null),
    ]);

    const healthy = healthyRes.status === 'fulfilled' && healthyRes.value?.ok;
    const ready = readyRes.status === 'fulfilled' && readyRes.value?.ok;

    let fallbackHealthy = false;
    if (!healthy) {
      try {
        const blockchainInfo = await callZebraRPC('getblockchaininfo');
        fallbackHealthy = blockchainInfo && blockchainInfo.blocks > 0;
      } catch (error) {
        fallbackHealthy = false;
      }
    }

    const result = {
      success: true,
      zebra: {
        healthy: healthy || fallbackHealthy,
        ready: ready,
        healthEndpointAvailable: healthy,
        readyEndpointAvailable: ready,
      },
      timestamp: Date.now(),
    };

    await setInRedisCache(NETWORK_HEALTH_CACHE_KEY, result, NETWORK_HEALTH_CACHE_DURATION);
    res.json(result);
  } catch (error) {
    logSafeError('❌ [HEALTH] Error checking health:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check node health',
    });
  }
});

/**
 * GET /api/network/peers
 * Get privacy-preserving aggregate information about connected peers.
 */
router.get('/api/network/peers', async (req, res) => {
  try {
    console.log('🌐 [PEERS] Fetching peer information...');

    // Get detailed peer info from Zebra
    const peerInfo = await callZebraRPC('getpeerinfo').catch(() => []);

    if (!Array.isArray(peerInfo)) {
      return res.json({
        success: true,
        count: 0,
        peers: [],
      });
    }

    const clientCounts = {};
    let inbound = 0;
    let outbound = 0;
    let pingTotal = 0;
    let pingSamples = 0;
    for (const peer of peerInfo) {
      const { clientImpl } = parsePeerClient(peer.subver);
      clientCounts[clientImpl] = (clientCounts[clientImpl] || 0) + 1;
      if (peer.inbound) inbound++;
      else outbound++;
      if (Number.isFinite(peer.pingtime) && peer.pingtime >= 0) {
        pingTotal += peer.pingtime * 1000;
        pingSamples++;
      }
    }

    res.json({
      success: true,
      count: peerInfo.length,
      inbound,
      outbound,
      avgPingMs: pingSamples > 0 ? Number((pingTotal / pingSamples).toFixed(1)) : null,
      clientDistribution: Object.entries(clientCounts)
        .map(([client, count]) => ({ client, count }))
        .sort((a, b) => b.count - a.count || a.client.localeCompare(b.client)),
      timestamp: Date.now(),
    });

    console.log(`✅ [PEERS] Returned aggregates for ${peerInfo.length} peers`);
  } catch (error) {
    logSafeError('❌ [PEERS] Error fetching peers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch peer information',
    });
  }
});

// ============================================================================
// TRANSPARENT SUPPLY BREAKDOWN
// ============================================================================

const BREAKDOWN_CACHE_KEY = 'zcash:transparent_breakdown';
const BREAKDOWN_CACHE_DURATION = 600; // 10 minutes

router.get('/api/supply/transparent-breakdown', async (req, res) => {
  try {
    const cached = await getFromRedisCache(BREAKDOWN_CACHE_KEY);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const [categoryResult, addressTypeResult, blockchainInfo] = await Promise.all([
      pool.query(
        `SELECT COALESCE(l.category, 'unlabeled') AS category,
                COUNT(*)::int AS address_count,
                COALESCE(SUM(a.balance), 0) AS total_balance
         FROM addresses a
         LEFT JOIN address_labels l ON a.address = l.address
         WHERE a.balance > 0
         GROUP BY COALESCE(l.category, 'unlabeled')
         ORDER BY total_balance DESC`
      ),
      pool.query(
        `SELECT
           CASE
             WHEN address LIKE 't1%' THEN 'P2PKH'
             WHEN address LIKE 't3%' THEN 'P2SH'
             ELSE 'other'
           END AS script_type,
           COUNT(*)::int AS address_count,
           COALESCE(SUM(balance), 0) AS total_balance
         FROM addresses
         WHERE balance > 0
         GROUP BY script_type
         ORDER BY total_balance DESC`
      ),
      callZebraRPC('getblockchaininfo').catch(() => null),
    ]);

    const transparentZat = blockchainInfo?.valuePools?.find(p => p.id === 'transparent')?.chainValueZat || 0;
    const transparentTotal = transparentZat / 1e8;

    let labeledTotal = 0;
    const categories = categoryResult.rows.map(row => {
      const balance = parseFloat(row.total_balance) / 1e8;
      if (row.category !== 'unlabeled') labeledTotal += balance;
      return {
        category: row.category,
        addressCount: row.address_count,
        totalBalance: balance,
        percentage: transparentTotal > 0 ? (balance / transparentTotal) * 100 : 0,
      };
    });

    const addressTypes = addressTypeResult.rows.map(row => {
      const balance = parseFloat(row.total_balance) / 1e8;
      return {
        type: row.script_type,
        description: row.script_type === 'P2PKH' ? 'Pay-to-Public-Key-Hash (t1...)' :
                     row.script_type === 'P2SH' ? 'Pay-to-Script-Hash (t3..., multi-sig/custody)' : 'Other',
        addressCount: row.address_count,
        totalBalance: balance,
        percentage: transparentTotal > 0 ? (balance / transparentTotal) * 100 : 0,
      };
    });

    const result = {
      success: true,
      categories,
      addressTypes,
      transparentTotal,
      labeledTotal,
      labeledPercentage: transparentTotal > 0 ? (labeledTotal / transparentTotal) * 100 : 0,
      timestamp: Date.now(),
    };

    await setInRedisCache(BREAKDOWN_CACHE_KEY, result, BREAKDOWN_CACHE_DURATION);
    res.json(result);
  } catch (error) {
    logSafeError('Error fetching transparent breakdown:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch transparent breakdown' });
  }
});

// ============================================================================
// SUPPLY & BLOCKCHAIN INFO APIs
// ============================================================================

/**
 * GET /api/supply
 * Get value pool breakdown (transparent, sprout, sapling, orchard, lockbox)
 * Compatible with zcashexplorer.app /api/v1/supply format
 */
router.get('/api/supply', async (req, res) => {
  try {
    const blockchainInfo = await callZebraRPC('getblockchaininfo');

    if (!blockchainInfo || !blockchainInfo.valuePools) {
      return res.status(500).json({ error: 'Could not fetch supply data' });
    }

    // Return in same format as zcashexplorer.app
    const pools = blockchainInfo.valuePools.map(pool => ({
      id: pool.id,
      chainValue: pool.chainValue,
      chainValueZat: pool.chainValueZat,
      monitored: pool.monitored,
    }));

    res.json(pools);
  } catch (error) {
    logSafeError('❌ [SUPPLY] Error:', error);
    res.status(500).json({ error: 'Failed to fetch supply data' });
  }
});

/**
 * GET /api/blockchain-info
 * Full blockchain info (supply, difficulty, upgrades, softforks, etc.)
 * Compatible with zcashexplorer.app /api/v1/blockchain-info format
 */
router.get('/api/blockchain-info', async (req, res) => {
  try {
    const [blockchainInfo, networkInfo, dbTip] = await Promise.all([
      callZebraRPC('getblockchaininfo'),
      callZebraRPC('getnetworkinfo').catch(() => null),
      pool.query('SELECT MAX(height) AS h FROM blocks').then(r =>
        r.rows.length ? Number(r.rows[0].h) || 0 : 0
      ).catch(() => null),
    ]);

    if (!blockchainInfo) {
      return res.status(500).json({ error: 'Could not fetch blockchain info' });
    }

    if (networkInfo?.subversion) {
      blockchainInfo.build = networkInfo.subversion;
    }

    // Return the indexed height so consumers never request unindexed blocks
    if (dbTip !== null) {
      blockchainInfo.blocks = dbTip;
      blockchainInfo.estimatedheight = dbTip;
    }

    res.json(blockchainInfo);
  } catch (error) {
    logSafeError('❌ [BLOCKCHAIN-INFO] Error:', error);
    res.status(500).json({ error: 'Failed to fetch blockchain info' });
  }
});

/**
 * GET /api/circulating-supply
 * Returns just the circulating supply number (plain text or JSON)
 * Useful for CoinGecko, CoinMarketCap integrations
 */
router.get('/api/circulating-supply', async (req, res) => {
  try {
    const blockchainInfo = await callZebraRPC('getblockchaininfo');

    if (!blockchainInfo?.chainSupply) {
      return res.status(500).json({ error: 'Could not fetch supply data' });
    }

    const supply = blockchainInfo.chainSupply.chainValue;

    // If ?format=json, return JSON; otherwise plain text (for aggregators)
    if (req.query.format === 'json') {
      res.json({
        circulatingSupply: supply,
        circulatingSupplyZat: blockchainInfo.chainSupply.chainValueZat,
        maxSupply: 21000000,
        unit: 'ZEC',
      });
    } else {
      res.type('text/plain').send(supply.toString());
    }
  } catch (error) {
    logSafeError('❌ [CIRCULATING-SUPPLY] Error:', error);
    res.status(500).json({ error: 'Failed to fetch circulating supply' });
  }
});

// ============================================================================
// NODE MAP (Aggregated by location for privacy)
// ============================================================================

/**
 * GET /api/network/nodes
 * Get node locations aggregated by city (for privacy)
 */
router.get('/api/network/nodes', async (req, res) => {
  try {
    // Return coarse geographic cells only: no IP, exact city, or precise
    // coordinates leave the server. `top_client`/`top_isp` are the most
    // common values *within the cell* (already-aggregate P2P handshake /
    // ASN data, same disclosure level as the Concentration Risk endpoint) —
    // never a raw IP.
    const cachedResult = await getOrLoadRoute({
      family: 'network-node-locations',
      params: { source: NODE_SOURCE, censusVersion: CENSUS_VERSION },
      freshTtlSeconds: 300,
      staleTtlSeconds: 301,
      load: async ({ measure }) => {
        const result = await measure('database_read', () => pool.query(`
          SELECT
            country,
            country_code,
            ROUND(lat::numeric, 0) as lat,
            ROUND(lon::numeric, 0) as lon,
            COUNT(*) as node_count,
            ROUND(AVG(ping_ms)::numeric, 1) as avg_ping_ms,
            MODE() WITHIN GROUP (ORDER BY client_impl) as top_client,
            MODE() WITHIN GROUP (ORDER BY isp) as top_isp
          FROM ${NODES_TABLE} census
          WHERE census_active = TRUE AND lat IS NOT NULL
          GROUP BY country, country_code, ROUND(lat::numeric, 0), ROUND(lon::numeric, 0)
          ORDER BY node_count DESC
        `));
        return {
          success: true,
          locations: result.rows.map(row => ({
            country: row.country,
            countryCode: row.country_code,
            lat: parseFloat(row.lat),
            lon: parseFloat(row.lon),
            nodeCount: parseInt(row.node_count),
            avgPingMs: row.avg_ping_ms ? parseFloat(row.avg_ping_ms) : null,
            topClient: row.top_client || null,
            topIsp: row.top_isp || null,
          })),
          timestamp: Date.now(),
        };
      },
    });
    applyListCacheHeaders(res, cachedResult);
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, must-revalidate');
    res.json(cachedResult.value);
  } catch (error) {
    logSafeError('❌ [NODES] Error fetching node locations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch node locations',
    });
  }
});

/**
 * GET /api/network/nodes/stats
 * Get aggregated node statistics with Tor count, version distribution, and trends
 */
router.get('/api/network/nodes/stats', async (req, res) => {
  try {
    const cachedResult = await getOrLoadRoute({
      family: 'network-node-stats',
      params: { source: NODE_SOURCE, censusVersion: CENSUS_VERSION },
      freshTtlSeconds: 300,
      staleTtlSeconds: 301,
      load: async ({ measure }) => {
        const sourceFilter = NODE_SOURCE === 'crawl' ? '' : "AND observed_via = 'peer'";
        const [statsResult, topCountries, trends, clients, versions] = await measure(
          'database_read',
          () => Promise.all([
            pool.query(`
              SELECT
                COUNT(*) FILTER (WHERE census_active) as active_nodes,
                COUNT(*) as total_nodes,
                COUNT(DISTINCT country_code) FILTER (WHERE census_active) as countries,
                COUNT(DISTINCT city) FILTER (WHERE census_active) as cities,
                ROUND(AVG(ping_ms) FILTER (WHERE census_active AND ping_ms > 0)::numeric, 1) as avg_ping_ms,
                COUNT(*) FILTER (WHERE census_active AND is_tor) as tor_nodes,
                MAX(${NODE_SOURCE === 'crawl' ? 'GREATEST(last_verified_at, last_peer_seen_at)' : 'last_seen'}) FILTER (WHERE census_active) as last_updated
              FROM ${NODES_TABLE} census
            `),
            pool.query(`
              SELECT country_code, MODE() WITHIN GROUP (ORDER BY country) as country,
                     COUNT(*) as node_count
              FROM ${NODES_TABLE} census
              WHERE census_active = TRUE AND country_code IS NOT NULL
              GROUP BY country_code
              ORDER BY node_count DESC
              LIMIT 10
            `),
            pool.query(`
              SELECT
                (SELECT active_nodes FROM node_snapshots
                 WHERE 1=1 ${SNAPSHOT_FILTER} AND snapshot_time <= NOW() - INTERVAL '24 hours'
                   AND snapshot_time > NOW() - INTERVAL '25 hours'
                 ORDER BY snapshot_time DESC LIMIT 1) as nodes_24h_ago,
                (SELECT active_nodes FROM node_snapshots
                 WHERE 1=1 ${SNAPSHOT_FILTER} AND snapshot_time <= NOW() - INTERVAL '7 days'
                   AND snapshot_time > NOW() - INTERVAL '7 days 1 hour'
                 ORDER BY snapshot_time DESC LIMIT 1) as nodes_7d_ago,
                (SELECT active_nodes FROM node_snapshots
                 WHERE 1=1 ${SNAPSHOT_FILTER} AND snapshot_time <= NOW() - INTERVAL '30 days'
                   AND snapshot_time > NOW() - INTERVAL '30 days 1 hour'
                 ORDER BY snapshot_time DESC LIMIT 1) as nodes_30d_ago
            `).catch(() => ({ rows: [{}] })),
            pool.query(`
              SELECT client_impl, COUNT(*)::int AS node_count
              FROM ${NODES_TABLE} census
              WHERE census_active = TRUE ${sourceFilter}
              GROUP BY client_impl
              ORDER BY node_count DESC, client_impl ASC
            `),
            pool.query(`
              SELECT client_impl, client_version, COUNT(*)::int AS node_count
              FROM ${NODES_TABLE} census
              WHERE census_active = TRUE ${sourceFilter} AND client_version IS NOT NULL
              GROUP BY client_impl, client_version
              ORDER BY node_count DESC, client_impl ASC, client_version DESC
              LIMIT 12
            `),
          ]),
        );

        const row = statsResult.rows[0];
        const activeNodes = parseInt(row.active_nodes) || 0;
        const trendRow = trends.rows[0] || {};
        const clientDistribution = clients.rows.map((client) => ({
          client: client.client_impl || 'Unknown',
          count: Number(client.node_count) || 0,
        }));
        const observedClientNodes = clientDistribution.reduce((sum, client) => sum + client.count, 0);
        const identifiedClientNodes = clientDistribution
          .filter((client) => client.client !== 'Unknown')
          .reduce((sum, client) => sum + client.count, 0);
        const calcChange = (prev) => {
          if (!prev || prev === 0) return null;
          return parseFloat(((activeNodes - prev) / prev * 100).toFixed(1));
        };

        return {
          success: true,
          stats: {
            activeNodes,
            totalNodes: parseInt(row.total_nodes) || 0,
            countries: parseInt(row.countries) || 0,
            cities: parseInt(row.cities) || 0,
            avgPingMs: row.avg_ping_ms ? parseFloat(row.avg_ping_ms) : null,
            torNodes: parseInt(row.tor_nodes) || 0,
            lastUpdated: row.last_updated,
            ...(NODE_SOURCE === 'crawl' ? { censusVersion: CENSUS_VERSION,
              observationWindowSeconds: 3600, peerObservationWindowSeconds: PEER_WINDOW_SECONDS,
              scope: 'live-peers-and-crawler-unique-ips' } : {}),
          },
          trends: {
            change24h: calcChange(trendRow.nodes_24h_ago),
            change7d: calcChange(trendRow.nodes_7d_ago),
            change30d: calcChange(trendRow.nodes_30d_ago),
          },
          topCountries: topCountries.rows.map(r => ({
            country: r.country,
            countryCode: r.country_code,
            nodeCount: parseInt(r.node_count),
          })),
          clients: {
            observedNodes: observedClientNodes,
            identifiedNodes: identifiedClientNodes,
            coveragePercentage: observedClientNodes > 0
              ? Number(((identifiedClientNodes / observedClientNodes) * 100).toFixed(1))
              : 0,
            distribution: clientDistribution,
            versions: versions.rows.map((version) => ({
              client: version.client_impl || 'Unknown',
              version: version.client_version,
              count: Number(version.node_count) || 0,
            })),
          },
          timestamp: Date.now(),
        };
      },
    });
    applyListCacheHeaders(res, cachedResult);
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, must-revalidate');
    res.json(cachedResult.value);
  } catch (error) {
    logSafeError('❌ [NODES] Error fetching node stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch node stats',
    });
  }
});

/**
 * GET /api/network/node-history?period=30d
 * Get historical node count snapshots for charting
 */
router.get('/api/network/node-history', async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const intervalMap = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
    const interval = intervalMap[period] || '30 days';

    const result = await pool.query(`
      SELECT
        snapshot_time,
        active_nodes,
        tor_nodes,
        countries,
        inbound_nodes,
        outbound_nodes,
        avg_ping_ms,
        identified_client_nodes,
        client_counts
      FROM node_snapshots
      WHERE 1=1 ${SNAPSHOT_FILTER} AND snapshot_time >= NOW() - INTERVAL '${interval}'
      ORDER BY snapshot_time ASC
    `);

    res.json({
      success: true,
      period,
      snapshots: result.rows.map(r => ({
        time: r.snapshot_time,
        activeNodes: r.active_nodes,
        torNodes: r.tor_nodes,
        countries: r.countries,
        inboundNodes: r.inbound_nodes,
        outboundNodes: r.outbound_nodes,
        avgPingMs: r.avg_ping_ms ? parseFloat(r.avg_ping_ms) : null,
        identifiedClientNodes: r.identified_client_nodes,
        clientCounts: r.client_counts || {},
      })),
      timestamp: Date.now(),
    });
  } catch (error) {
    logSafeError('❌ [NODE-HISTORY] Error fetching node history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch node history',
    });
  }
});

// ============================================================================
// ZEC PRICE (Privacy proxy — prevents user IPs from leaking to CoinGecko)
// ============================================================================

let priceCache = { data: null, timestamp: 0 };
const PRICE_CACHE_MS = 60_000;

router.get('/api/price', async (req, res) => {
  if (isTestnet()) return res.json({ price: null, change24h: null, available: false, network: 'testnet' });
  try {
    const now = Date.now();
    if (priceCache.data && now - priceCache.timestamp < PRICE_CACHE_MS) {
      return res.json(priceCache.data);
    }

    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true',
      { signal: AbortSignal.timeout(8000) }
    );

    if (!response.ok) {
      if (priceCache.data) return res.json(priceCache.data);
      return res.status(502).json({ error: 'Price service unavailable' });
    }

    const raw = await response.json();
    const data = {
      price: raw.zcash?.usd ?? null,
      change24h: raw.zcash?.usd_24h_change ?? null,
      marketCapUsd: raw.zcash?.usd_market_cap ?? null,
      volume24hUsd: raw.zcash?.usd_24h_vol ?? null,
      sourceUpdatedAt: raw.zcash?.last_updated_at ? raw.zcash.last_updated_at * 1000 : null,
      timestamp: now,
    };

    priceCache = { data, timestamp: now };
    res.json(data);
  } catch (error) {
    logSafeError('❌ [PRICE] Error:', error);
    if (priceCache.data) return res.json(priceCache.data);
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

// ============================================================================
// HISTORICAL PRICE LOOKUP
// ============================================================================

router.get('/api/price/at', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
    }

    if (isTestnet()) return res.json({ date, price_usd: null, exact: false, available: false, network: 'testnet' });

    const result = await pool.query(
      'SELECT price_usd FROM zec_price_daily WHERE date = $1',
      [date]
    );

    if (result.rows.length === 0) {
      const closest = await pool.query(
        `SELECT date, price_usd FROM zec_price_daily
         WHERE date <= $1 ORDER BY date DESC LIMIT 1`,
        [date]
      );
      if (closest.rows.length === 0) {
        return res.json({ date, price_usd: null, exact: false });
      }
      return res.json({
        date,
        price_usd: parseFloat(closest.rows[0].price_usd),
        actual_date: closest.rows[0].date,
        exact: false,
      });
    }

    res.json({
      date,
      price_usd: parseFloat(result.rows[0].price_usd),
      exact: true,
    });
  } catch (error) {
    logSafeError('Error fetching historical price:', error);
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

// ============================================================================
// PROTOCOL STATS: Commitment trees & nullifier sets
// ============================================================================

const PROTOCOL_STATS_CACHE_KEY = 'zcash:protocol_stats';
const PROTOCOL_STATS_CACHE_DURATION = 300; // 5 minutes

router.get('/api/network/protocol-stats', async (req, res) => {
  try {
    const cached = await getFromRedisCache(PROTOCOL_STATS_CACHE_KEY);
    if (cached) return res.json({ ...cached, cached: true });

    const [totals, monthly] = await Promise.all([
      pool.query(`
        SELECT
          SUM(sapling_output_count)::bigint AS sapling_commitments,
          SUM(sapling_spend_count)::bigint AS sapling_nullifiers,
          SUM(orchard_actions)::bigint AS orchard_commitments,
          SUM(orchard_actions)::bigint AS orchard_nullifiers,
          SUM(ironwood_actions)::bigint AS ironwood_commitments,
          SUM(ironwood_actions)::bigint AS ironwood_nullifiers
        FROM transactions
      `),
      pool.query(`
        SELECT
          date_trunc('month', to_timestamp(block_time))::date AS month,
          SUM(sapling_output_count)::bigint AS sapling_outputs,
          SUM(sapling_spend_count)::bigint AS sapling_spends,
          SUM(orchard_actions)::bigint AS orchard_actions,
          SUM(ironwood_actions)::bigint AS ironwood_actions
        FROM transactions
        WHERE block_time > 0
        GROUP BY month
        ORDER BY month
      `),
    ]);

    const t = totals.rows[0];

    let saplingCum = 0;
    let saplingNullCum = 0;
    let orchardCum = 0;
    let orchardNullCum = 0;
    let ironwoodCum = 0;
    let ironwoodNullCum = 0;
    const history = monthly.rows.map(row => {
      saplingCum += parseInt(row.sapling_outputs) || 0;
      saplingNullCum += parseInt(row.sapling_spends) || 0;
      orchardCum += parseInt(row.orchard_actions) || 0;
      orchardNullCum += parseInt(row.orchard_actions) || 0;
      ironwoodCum += parseInt(row.ironwood_actions) || 0;
      ironwoodNullCum += parseInt(row.ironwood_actions) || 0;
      return {
        month: row.month,
        saplingCommitments: saplingCum,
        saplingNullifiers: saplingNullCum,
        orchardCommitments: orchardCum,
        orchardNullifiers: orchardNullCum,
        ironwoodCommitments: ironwoodCum,
        ironwoodNullifiers: ironwoodNullCum,
      };
    });

    const result = {
      success: true,
      current: {
        saplingCommitments: parseInt(t.sapling_commitments) || 0,
        saplingNullifiers: parseInt(t.sapling_nullifiers) || 0,
        orchardCommitments: parseInt(t.orchard_commitments) || 0,
        orchardNullifiers: parseInt(t.orchard_nullifiers) || 0,
        ironwoodCommitments: parseInt(t.ironwood_commitments) || 0,
        ironwoodNullifiers: parseInt(t.ironwood_nullifiers) || 0,
      },
      history,
      timestamp: Date.now(),
    };

    await setInRedisCache(PROTOCOL_STATS_CACHE_KEY, result, PROTOCOL_STATS_CACHE_DURATION);
    res.json(result);
  } catch (error) {
    logSafeError('Error fetching protocol stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch protocol stats' });
  }
});

// ============================================================================
// NETWORK TOPOLOGY (Phase 2)
// ============================================================================

/**
 * GET /api/network/topology
 * Returns an anonymized force-directed graph (node IDs + geo cells + centrality).
 * Never exposes raw IPs or .onion addresses.
 */
router.get('/api/network/topology', async (req, res) => {
  try {
    // Serve from Redis cache when available (topology data changes every ~5 min).
    const cached = await getFromRedisCache(NETWORK_TOPOLOGY_CACHE_KEY);
    if (cached) {
      return res.json(cached);
    }

    // Full known-network graph: reachable core + connected "off" (gossiped but
    // unreachable) nodes. Reachable nodes get the richer client classification
    // from the nodes table; grey nodes fall back to the crawler-derived label.
    //
    // Privacy: topology_nodes.addr / ip are server-side identity/join keys only.
    // They are NEVER returned — the client receives a synthetic per-response id.
    // Active nodes include fresh peer observations and crawler handshakes.
    // Keep peer-only nodes even without gossip edges; do not invent connections.
    // A stale topology flag cannot override census eligibility.
    //
    // Nodes are collapsed to ONE per IP: the gossip graph lists the same host under
    // several ports, so keying by ip:port would double-count reachable nodes vs the
    // node list. We keep the highest-degree row per IP as its representative.
    const nodesResult = await pool.query(`
      SELECT
        COALESCE(tn.addr, n.ip) AS addr,
        COALESCE(tn.ip, n.ip) AS ip,
        (n.id IS NOT NULL) AS reachable,
        COALESCE(NULLIF(n.client_impl, 'Unknown'), NULLIF(tn.client_impl, 'Unknown')) AS client_impl,
        (COALESCE(tn.is_tor, FALSE) OR COALESCE(n.is_tor, FALSE)) AS is_tor,
        COALESCE(n.country_code, tn.country_code) AS country_code,
        COALESCE(tn.degree, 0) AS degree,
        tn.betweenness,
        tn.closeness
      FROM topology_nodes tn
      FULL OUTER JOIN (SELECT * FROM ${NODES_TABLE} census WHERE census_active = TRUE) n ON n.ip = tn.ip
      ORDER BY tn.degree DESC NULLS LAST
    `);

    // Collapse to one node per IP (keep the highest-degree representative; a node is
    // reachable if ANY of its addr entries is). Map every addr → its representative id
    // so edges can be rewritten into ip space. Never leak addr/ip to the client.
    const idByIp = new Map();
    const idByAddr = new Map();
    const nodes = [];
    for (const r of nodesResult.rows) {
      let id = idByIp.get(r.ip);
      if (id === undefined) {
        id = nodes.length;
        idByIp.set(r.ip, id);
        nodes.push({
          id,
          reachable: r.reachable === true,
          client: r.client_impl || null,
          isTor: r.is_tor === true,
          countryCode: r.country_code,
          betweenness: r.betweenness != null ? parseFloat(r.betweenness) : null,
          closeness: r.closeness != null ? parseFloat(r.closeness) : null,
          degree: r.degree != null ? parseInt(r.degree) : null,
        });
      } else if (r.reachable === true) {
        nodes[id].reachable = true;
      }
      idByAddr.set(r.addr, id);
    }

    const edgesResult = await pool.query('SELECT src, dst FROM topology_edges LIMIT 40000');

    // Rewrite edges into ip space, drop self-loops, and dedupe (undirected).
    const edges = [];
    const seenEdge = new Set();
    for (const e of edgesResult.rows) {
      const source = idByAddr.get(e.src);
      const target = idByAddr.get(e.dst);
      if (source === undefined || target === undefined || source === target) continue;
      const key = source < target ? `${source}-${target}` : `${target}-${source}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ source, target });
    }

    const reachableCount = nodes.filter(n => n.reachable).length;

    const response = {
      success: true,
      nodes,
      edges,
      counts: {
        total: nodes.length,
        reachable: reachableCount,
        off: nodes.length - reachableCount,
        edges: edges.length,
      },
      timestamp: Date.now(),
    };

    await setInRedisCache(NETWORK_TOPOLOGY_CACHE_KEY, response, NETWORK_TOPOLOGY_CACHE_DURATION);

    res.json(response);
  } catch (error) {
    logSafeError('Error fetching topology:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch topology' });
  }
});

/**
 * GET /api/network/nodes/list
 * Returns pseudonymized node list for the /network/nodes detail page.
 * Never exposes raw IPs or .onion addresses.
 */
router.get('/api/network/nodes/list', async (req, res) => {
  try {
    const { limit, offset, requestedOffset, offsetExceeded } = parseSafeListPagination(req.query, {
      defaultLimit: 100,
      maxLimit: 500,
      maxOffset: MAX_NODES_OFFSET,
    });

    if (offsetExceeded) {
      return res.status(400).json(offsetExceededError({ requestedOffset, maxOffset: MAX_NODES_OFFSET }));
    }

    const sortBy = req.query.sort || 'last_seen';
    const allowedSorts = ['last_seen', 'client_impl', 'country_code', 'protocol_version', 'ping_ms', 'degree'];
    const orderCol = allowedSorts.includes(sortBy) ? `n.${sortBy}` : 'n.last_seen';
    const orderDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const [nodesResult, countResult] = await Promise.all([
      pool.query(`
        SELECT
          n.id,
          COALESCE(n.client_impl, zn.client_impl) AS client_impl,
          COALESCE(n.client_version, zn.client_version) AS client_version,
          COALESCE(n.protocol_version, zn.protocol_version) AS protocol_version,
          n.country,
          n.country_code,
          ROUND(n.lat::numeric, 0) as lat,
          ROUND(n.lon::numeric, 0) as lon,
          n.is_tor,
          n.tor_type,
          n.ping_ms,
          n.census_active,
          n.first_seen,
          n.last_seen,
          n.observed_via,
          n.isp,
          n.degree,
          n.betweenness,
          n.closeness
        FROM ${NODES_TABLE} n
        LEFT JOIN ${NODES_TABLE} zn ON zn.ip = n.ip AND n.client_impl = 'Unknown' AND zn.client_impl IS NOT NULL AND zn.client_impl != 'Unknown'
        WHERE n.census_active = TRUE
        ORDER BY ${orderCol} ${orderDir} NULLS LAST
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS total FROM ${NODES_TABLE} census WHERE census_active = TRUE`),
    ]);

    res.json({
      success: true,
      total: countResult.rows[0].total,
      nodes: nodesResult.rows.map(n => ({
        id: n.id,
        client: n.client_impl,
        version: n.client_version,
        protocolVersion: n.protocol_version,
        country: n.country,
        countryCode: n.country_code,
        lat: n.lat ? parseFloat(n.lat) : null,
        lon: n.lon ? parseFloat(n.lon) : null,
        isTor: n.is_tor,
        torType: n.tor_type,
        pingMs: n.ping_ms ? parseFloat(n.ping_ms) : null,
        isActive: n.census_active,
        firstSeen: n.first_seen,
        lastSeen: n.last_seen,
        source: n.observed_via,
        isp: n.isp,
        degree: n.degree,
        betweenness: n.betweenness ? parseFloat(n.betweenness) : null,
        closeness: n.closeness ? parseFloat(n.closeness) : null,
      })),
      timestamp: Date.now(),
    });
  } catch (error) {
    logSafeError('Error fetching node list:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch node list' });
  }
});

// ============================================================================
// NETWORK INTELLIGENCE ENDPOINTS
// ============================================================================

/**
 * GET /api/network/nodes/health-score
 * Composite network health metric derived from crawler data.
 */
router.get('/api/network/nodes/health-score', async (req, res) => {
  try {
    const [connectivityResult, versionResult, clientResult, geoResult, reliabilityResult] = await Promise.all([
      pool.query(`
        SELECT
          AVG(degree) FILTER (WHERE census_active AND degree > 0) AS avg_degree,
          MAX(degree) FILTER (WHERE census_active) AS max_degree,
          COUNT(*) FILTER (WHERE census_active AND degree <= 1) AS poorly_connected,
          COUNT(*) FILTER (WHERE census_active AND degree > 0) AS connected_nodes,
          COUNT(*) FILTER (WHERE census_active) AS total_active
        FROM ${NODES_TABLE} census
      `),
      pool.query(`
        SELECT protocol_version, COUNT(*)::int AS cnt
        FROM ${NODES_TABLE} census WHERE census_active = TRUE AND protocol_version IS NOT NULL
        GROUP BY protocol_version ORDER BY cnt DESC
      `),
      pool.query(`
        SELECT COALESCE(client_impl, 'Unidentified') AS client_impl, COUNT(*)::int AS cnt
        FROM ${NODES_TABLE} census WHERE census_active = TRUE
        GROUP BY client_impl ORDER BY cnt DESC
      `),
      pool.query(`
        SELECT
          COUNT(DISTINCT country_code) FILTER (WHERE census_active AND country_code IS NOT NULL) AS countries,
          COUNT(DISTINCT SUBSTRING(ip FROM '^[0-9]+\\.[0-9]+\\.[0-9]+')) FILTER (WHERE census_active) AS unique_subnets
        FROM ${NODES_TABLE} census
      `),
      pool.query(`
        SELECT
          AVG(crawl_seen_count::numeric / NULLIF(crawl_seen_count + COALESCE(crawl_miss_count, 0), 0))
            FILTER (WHERE census_active AND (crawl_seen_count + COALESCE(crawl_miss_count, 0)) >= 3) AS avg_reliability,
          COUNT(*) FILTER (WHERE census_active AND (crawl_seen_count + COALESCE(crawl_miss_count, 0)) >= 3) AS scored_nodes
        FROM ${NODES_TABLE} census
      `),
    ]);

    const conn = connectivityResult.rows[0];
    const geo = geoResult.rows[0];
    const versions = versionResult.rows;
    const clients = clientResult.rows;
    const rel = reliabilityResult.rows[0];

    const totalActive = parseInt(conn.total_active) || 1;

    // Connectivity: based on avg peer degree (healthy mesh ~8+)
    const avgDegree = parseFloat(conn.avg_degree) || 0;
    const connectivityScore = Math.min(100, Math.round((avgDegree / 8) * 100));

    // Upgrade adoption: share of nodes on the latest protocol version
    const LATEST_PROTOCOL = 170160; // NU6.3
    const totalVersioned = versions.reduce((s, v) => s + v.cnt, 0) || 1;
    const latestCount = versions.filter(v => parseInt(v.protocol_version) >= LATEST_PROTOCOL).reduce((s, v) => s + v.cnt, 0);
    const upgradePct = (latestCount / totalVersioned) * 100;
    const upgradeScore = Math.round(upgradePct);

    // Client diversity: penalize implementation monoculture (single-client dominance)
    const identifiedClients = clients.filter(c => c.client_impl !== 'Unidentified' && c.client_impl !== 'Seeder');
    const totalIdentified = identifiedClients.reduce((s, c) => s + c.cnt, 0) || 1;
    const topClient = identifiedClients[0] || { client_impl: null, cnt: 0 };
    const topClientPct = (topClient.cnt / totalIdentified) * 100;
    const clientDiversityScore = topClientPct > 90 ? 40 : topClientPct > 75 ? 70 : topClientPct > 60 ? 85 : 100;

    // Geographic diversity: country spread (healthy ~30+)
    const countries = parseInt(geo.countries) || 0;
    const geoScore = Math.min(100, Math.round((countries / 30) * 100));

    // Reliability: how consistently reachable nodes are across crawl cycles
    const avgReliability = rel.avg_reliability != null ? parseFloat(rel.avg_reliability) : null;
    const reliabilityScore = avgReliability != null ? Math.round(avgReliability * 100) : 50;

    // Composite (weighted, honest signals only)
    const composite = Math.round(
      connectivityScore * 0.25 +
      upgradeScore * 0.20 +
      clientDiversityScore * 0.20 +
      geoScore * 0.15 +
      reliabilityScore * 0.20
    );

    res.json({
      success: true,
      healthScore: composite,
      components: {
        connectivity: { score: connectivityScore, avgDegree: parseFloat(avgDegree.toFixed(1)), poorlyConnected: parseInt(conn.poorly_connected) || 0, maxDegree: parseInt(conn.max_degree) || 0 },
        upgrade: { score: upgradeScore, latestProtocol: LATEST_PROTOCOL, adoptionPct: parseFloat(upgradePct.toFixed(1)), latestCount },
        clientDiversity: { score: clientDiversityScore, topClient: topClient.client_impl, topClientPct: parseFloat(topClientPct.toFixed(1)), implementations: identifiedClients.length },
        geographic: { score: geoScore, countries, uniqueSubnets: parseInt(geo.unique_subnets) || 0 },
        reliability: { score: reliabilityScore, avgReliabilityPct: avgReliability != null ? parseFloat((avgReliability * 100).toFixed(1)) : null, scoredNodes: parseInt(rel.scored_nodes) || 0 },
      },
      totalActive,
      timestamp: Date.now(),
    });
  } catch (error) {
    logSafeError('Error computing health score:', error);
    res.status(500).json({ success: false, error: 'Failed to compute health score' });
  }
});

/**
 * GET /api/network/nodes/reliability
 * Real per-node signals from the crawler: reachability across crawl cycles,
 * handshake latency distribution, and advertised service flags.
 */
router.get('/api/network/nodes/reliability', async (req, res) => {
  try {
    const [leaderboard, latencyDist, servicesDist, summary] = await Promise.all([
      pool.query(`
        SELECT
          id,
          COALESCE(client_impl, 'Unidentified') AS client_impl,
          country_code,
          country,
          ping_ms,
          crawl_seen_count,
          COALESCE(crawl_miss_count, 0) AS crawl_miss_count,
          ROUND((crawl_seen_count::numeric / NULLIF(crawl_seen_count + COALESCE(crawl_miss_count, 0), 0)) * 100, 1) AS reliability_pct
        FROM ${NODES_TABLE} census
        WHERE census_active = TRUE AND (crawl_seen_count + COALESCE(crawl_miss_count, 0)) >= 3
        ORDER BY reliability_pct DESC NULLS LAST, crawl_seen_count DESC, ping_ms ASC NULLS LAST
        LIMIT 12
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE ping_ms > 0 AND ping_ms < 50) AS b0,
          COUNT(*) FILTER (WHERE ping_ms >= 50 AND ping_ms < 100) AS b1,
          COUNT(*) FILTER (WHERE ping_ms >= 100 AND ping_ms < 200) AS b2,
          COUNT(*) FILTER (WHERE ping_ms >= 200 AND ping_ms < 500) AS b3,
          COUNT(*) FILTER (WHERE ping_ms >= 500) AS b4,
          ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ping_ms) FILTER (WHERE ping_ms > 0)::numeric, 0) AS median_ms,
          COUNT(*) FILTER (WHERE ping_ms > 0) AS measured
        FROM ${NODES_TABLE} census WHERE census_active = TRUE
      `),
      pool.query(`
        SELECT services, COUNT(*)::int AS cnt
        FROM ${NODES_TABLE} census WHERE census_active = TRUE AND services IS NOT NULL
        GROUP BY services ORDER BY cnt DESC
      `),
      pool.query(`
        SELECT
          ROUND(AVG(crawl_seen_count::numeric / NULLIF(crawl_seen_count + COALESCE(crawl_miss_count, 0), 0))
            FILTER (WHERE (crawl_seen_count + COALESCE(crawl_miss_count, 0)) >= 3) * 100, 1) AS avg_reliability_pct,
          MAX(crawl_seen_count) AS max_seen,
          COUNT(*) FILTER (WHERE services IS NOT NULL) AS services_known
        FROM ${NODES_TABLE} census WHERE census_active = TRUE
      `),
    ]);

    // Decode the NODE_NETWORK bit (0x1) — the flag that matters for full-node service.
    const NODE_NETWORK = 1;
    const svcRows = servicesDist.rows;
    const totalWithServices = svcRows.reduce((s, r) => s + r.cnt, 0);
    const fullNodeCount = svcRows
      .filter(r => (BigInt(r.services) & BigInt(NODE_NETWORK)) !== 0n)
      .reduce((s, r) => s + r.cnt, 0);

    const lat = latencyDist.rows[0];
    const sum = summary.rows[0];

    res.json({
      success: true,
      leaderboard: leaderboard.rows.map(r => ({
        id: r.id,
        client: r.client_impl,
        countryCode: r.country_code,
        country: r.country,
        pingMs: r.ping_ms != null ? parseFloat(r.ping_ms) : null,
        seen: parseInt(r.crawl_seen_count) || 0,
        missed: parseInt(r.crawl_miss_count) || 0,
        reliabilityPct: r.reliability_pct != null ? parseFloat(r.reliability_pct) : null,
      })),
      latency: {
        median: lat.median_ms != null ? parseInt(lat.median_ms) : null,
        measured: parseInt(lat.measured) || 0,
        buckets: [
          { label: '<50ms', count: parseInt(lat.b0) || 0 },
          { label: '50\u2013100ms', count: parseInt(lat.b1) || 0 },
          { label: '100\u2013200ms', count: parseInt(lat.b2) || 0 },
          { label: '200\u2013500ms', count: parseInt(lat.b3) || 0 },
          { label: '\u2265500ms', count: parseInt(lat.b4) || 0 },
        ],
      },
      services: {
        known: totalWithServices,
        fullNodes: fullNodeCount,
        fullNodePct: totalWithServices > 0 ? parseFloat(((fullNodeCount / totalWithServices) * 100).toFixed(1)) : 0,
      },
      avgReliabilityPct: sum.avg_reliability_pct != null ? parseFloat(sum.avg_reliability_pct) : null,
      maxSeen: parseInt(sum.max_seen) || 0,
      timestamp: Date.now(),
    });
  } catch (error) {
    logSafeError('Error fetching node reliability:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch node reliability' });
  }
});

/**
 * GET /api/network/nodes/upgrade-readiness
 * Protocol version adoption tracking.
 */
router.get('/api/network/nodes/upgrade-readiness', async (req, res) => {
  try {
    const [currentDist, historicalResult] = await Promise.all([
      pool.query(`
        SELECT
          protocol_version,
          COUNT(*)::int AS node_count,
          ARRAY_AGG(DISTINCT client_impl) AS clients,
          ROUND(AVG(degree) FILTER (WHERE degree > 0)::numeric, 1) AS avg_degree
        FROM ${NODES_TABLE} census
        WHERE census_active = TRUE AND protocol_version IS NOT NULL
        GROUP BY protocol_version
        ORDER BY node_count DESC
      `),
      pool.query(`
        SELECT
          DATE(snapshot_time) AS day,
          client_counts
        FROM node_snapshots
        WHERE 1=1 ${SNAPSHOT_FILTER} AND snapshot_time >= NOW() - INTERVAL '30 days'
        ORDER BY snapshot_time DESC
        LIMIT 30
      `).catch(() => ({ rows: [] })),
    ]);

    const totalActive = currentDist.rows.reduce((s, r) => s + r.node_count, 0) || 1;
    const LATEST_PROTOCOL = 170160; // NU6.3

    const versions = currentDist.rows.map(r => ({
      protocolVersion: parseInt(r.protocol_version),
      nodeCount: r.node_count,
      percentage: parseFloat(((r.node_count / totalActive) * 100).toFixed(1)),
      clients: r.clients.filter(c => c && c !== 'Unknown' && c !== 'Seeder'),
      avgDegree: r.avg_degree ? parseFloat(r.avg_degree) : null,
      isLatest: parseInt(r.protocol_version) >= LATEST_PROTOCOL,
    }));

    const latestCount = versions.filter(v => v.isLatest).reduce((s, v) => s + v.nodeCount, 0);
    const readinessPct = parseFloat(((latestCount / totalActive) * 100).toFixed(1));

    res.json({
      success: true,
      latestProtocol: LATEST_PROTOCOL,
      readinessPct,
      latestCount,
      totalActive,
      versions,
      timestamp: Date.now(),
    });
  } catch (error) {
    logSafeError('Error fetching upgrade readiness:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch upgrade readiness' });
  }
});

/**
 * GET /api/network/nodes/concentration
 * Sybil/concentration risk analysis — subnet and ASN clustering.
 */
router.get('/api/network/nodes/concentration', async (req, res) => {
  try {
    const [subnetResult, ispResult, highDegreeResult] = await Promise.all([
      pool.query(`
        SELECT
          SUBSTRING(ip FROM '^([0-9]+\\.[0-9]+\\.[0-9]+)') AS subnet,
          COUNT(*)::int AS node_count,
          ARRAY_AGG(DISTINCT client_impl) AS clients
        FROM ${NODES_TABLE} census
        WHERE census_active = TRUE AND ip !~ ':' AND ip != '127.0.0.1'
        GROUP BY subnet
        HAVING COUNT(*) >= 3
        ORDER BY node_count DESC
        LIMIT 15
      `),
      pool.query(`
        SELECT
          COALESCE(isp, 'Unresolved') AS isp,
          COUNT(*)::int AS node_count,
          ROUND((COUNT(*)::numeric / NULLIF((SELECT COUNT(*) FROM ${NODES_TABLE} census WHERE census_active), 0)) * 100, 1) AS pct
        FROM ${NODES_TABLE} census
        WHERE census_active = TRUE
        GROUP BY isp
        ORDER BY node_count DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE degree > 50 AND census_active) AS high_degree_nodes,
          COUNT(*) FILTER (WHERE census_active AND degree > 0) AS total_with_degree,
          MAX(degree) FILTER (WHERE census_active) AS max_degree
        FROM ${NODES_TABLE} census
      `),
    ]);

    const totalActive = parseInt(highDegreeResult.rows[0]?.total_with_degree) || 1;
    // Ignore the "Unresolved" bucket (missing ASN data) when assessing real concentration.
    const topRealIsp = ispResult.rows.find(r => r.isp !== 'Unresolved');
    const topIspPct = parseFloat(topRealIsp?.pct) || 0;

    // Concentration risk: high if top ISP has >40% or medium above 25%
    const concentrationRisk = topIspPct > 40 ? 'high' : topIspPct > 25 ? 'medium' : 'low';

    res.json({
      success: true,
      concentrationRisk,
      subnets: subnetResult.rows.map(r => ({
        subnet: r.subnet + '.x',
        nodeCount: r.node_count,
        clients: r.clients.filter(Boolean),
      })),
      isps: ispResult.rows.map(r => ({
        isp: r.isp,
        nodeCount: r.node_count,
        percentage: parseFloat(r.pct) || 0,
      })),
      highDegreeNodes: parseInt(highDegreeResult.rows[0]?.high_degree_nodes) || 0,
      maxDegree: parseInt(highDegreeResult.rows[0]?.max_degree) || 0,
      timestamp: Date.now(),
    });
  } catch (error) {
    logSafeError('Error fetching concentration data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch concentration data' });
  }
});

registerNetworkAnalyticsRoutes(router);

module.exports = router;
