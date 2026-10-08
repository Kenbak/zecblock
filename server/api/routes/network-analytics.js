const { supplyProjection } = require('../lib/issuance-projection');
const { networkSchedule, targetSeconds, targetSpacing, halvingIndex, halvingHeight } = require('../lib/network-schedule');
const { cachedHashrateHistory } = require('../lib/hashrate');
const { logSafeError } = require('../lib/safe-log');
const { subsidyZat, supplyZat, supplyHistory, mergedSupplyHistory, dailyNetSupplyChanges, observedBlockCadence } = require('../lib/network-issuance');
/**
 * Network analytics routes — halving, mining history, pool trends, emission, chain size.
 * Requires chain_snapshots table for size history (see docs/network-analytics-setup.md).
 */

const MAX_SUPPLY_ZEC = 21_000_000;
// Do not reuse countdowns cached by the old "any subsidy decrease" detector.
const HALVING_CACHE_KEY = 'zcash:halving_info:v3';
const HALVING_CACHE_TTL = 300;

async function getFromRedisCache(redisClient, key) {
  try {
    if (!redisClient?.isOpen) return null;
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

async function setRedisCache(redisClient, key, data, ttlSeconds) {
  try {
    if (!redisClient?.isOpen) return false;
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function periodToInterval(period) {
  const map = {
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
    '1y': '365 days',
    all: '4000 days',
  };
  return map[period] || '90 days';
}

/** True when per-pool columns hold real chain-state history (not flat ratio estimates). */
async function hasVerifiedPerPoolBreakdown(pool) {
  const result = await pool.query(`
    SELECT orchard_pool_size, pool_size
    FROM privacy_trends_daily
    WHERE orchard_pool_size > 0 AND pool_size > 0
      AND date >= CURRENT_DATE - INTERVAL '365 days'
  `);
  if (result.rows.length < 7) return false;

  const ratios = result.rows.map((r) => {
    const orchard = Number(r.orchard_pool_size) || 0;
    const shielded = Number(r.pool_size) || 0;
    return shielded > 0 ? orchard / shielded : 0;
  });

  return Math.max(...ratios) - Math.min(...ratios) > 0.01;
}

/** Shielded supply % = shielded ZEC / total chain supply. Never use tx-adoption %. */
function computeShieldedSupplyPct({ shieldedZat, chainSupplyZat, sproutZat, saplingZat, orchardZat, transparentZat }) {
  if (chainSupplyZat > 0 && shieldedZat > 0) {
    return (shieldedZat / chainSupplyZat) * 100;
  }
  const poolTotalZat = sproutZat + saplingZat + orchardZat + transparentZat;
  if (poolTotalZat > 0 && shieldedZat > 0) {
    return (shieldedZat / poolTotalZat) * 100;
  }
  // pool_size is tracked but chain_supply not backfilled — omit (do not guess from shielded pool)
  return null;
}

function rollingAverage(values, window) {
  if (values.length === 0) return [];
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    const avg = slice.length === window && slice.every(Number.isFinite) ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
    out.push(avg);
  }
  return out;
}

async function discoverNextHalving(callZebraRPC, currentHeight, chainInfo) {
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 1) throw new Error('Invalid chain height');
  const info = chainInfo ?? await callZebraRPC('getblockchaininfo');
  const schedule = networkSchedule(info);
  const current = await callZebraRPC('getblocksubsidy', [currentHeight]);
  if (subsidyZat(current?.totalblocksubsidy) === null) throw new Error('Could not read current block subsidy');
  const fields = {
    currentSubsidy: current.totalblocksubsidy,
    minerReward: subsidyZat(current.miner) === null ? null : current.miner,
    fundingStreams: subsidyZat(current.fundingstreamstotal) === null ? null : current.fundingstreamstotal,
    lockbox: subsidyZat(current.lockboxtotal) === null ? null : current.lockboxtotal,
    schedule,
    scheduleAssumption: 'Current node activation schedule; future unscheduled upgrades can change these estimates.',
  };
  const index = halvingIndex(schedule, currentHeight);
  const nextHeight = index === null ? null : halvingHeight(schedule, index + 1);
  if (nextHeight === null) return { ...fields, halvingStatus: 'unavailable',
    halvingUnavailableReason: 'unsupported-node-schedule', halvingBlock: null, blocksRemaining: null,
    nextSubsidy: null, nextMinerReward: null, eraStartBlock: null, eraProgress: null, targetSecondsRemaining: null };
  const eraStart = index === 0 ? 0 : halvingHeight(schedule, index);
  // Future state-dependent NSM payouts may not be known. The halving clock is
  // still known; unavailable future rewards must not erase its boundary.
  const next = await callZebraRPC('getblocksubsidy', [nextHeight]).catch(() => null);
  return { ...fields, halvingStatus: 'available', halvingUnavailableReason: null,
    halvingBlock: nextHeight, blocksRemaining: nextHeight - currentHeight, eraStartBlock: eraStart,
    eraProgress: 100 * targetSeconds(schedule, eraStart, currentHeight) / targetSeconds(schedule, eraStart, nextHeight),
    nextSubsidy: subsidyZat(next?.totalblocksubsidy) === null ? null : next.totalblocksubsidy,
    nextMinerReward: subsidyZat(next?.miner) === null ? null : next.miner,
    targetSecondsRemaining: targetSeconds(schedule, currentHeight, nextHeight),
  };
}

async function tableExists(pool, tableName) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return r.rows.length > 0;
}

async function columnExists(pool, tableName, columnName) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  return r.rows.length > 0;
}

function registerNetworkAnalyticsRoutes(router) {
  require('./network-readiness').registerNetworkReadinessRoutes(router);
  router.get('/api/network/halving', async (req, res) => {
    try {
      const callZebraRPC = req.app.locals.callZebraRPC;
      const redisClient = req.app.locals.redisClient;
      const cached = await getFromRedisCache(redisClient, HALVING_CACHE_KEY);
      if (cached && cached.halvingBlock != null) return res.json({ success: true, ...cached, cached: true });

      // Use Zebra for both height and subsidy so backfills cannot mix a stale
      // database height with live-chain subsidy values.
      const chainInfo = await callZebraRPC('getblockchaininfo');
      const currentHeight = Number(chainInfo?.blocks);
      if (!Number.isSafeInteger(currentHeight) || currentHeight < 1) {
        throw new Error('Could not read current Zebra height');
      }
      const [halving, cadence] = await Promise.all([
        discoverNextHalving(callZebraRPC, currentHeight, chainInfo),
        observedBlockCadence(req.app.locals.pool, currentHeight).catch(() => null),
      ]);
      const estimatedSeconds = halving.blocksRemaining != null && cadence !== null
        ? halving.targetSecondsRemaining * cadence.intervalSeconds / targetSpacing(halving.schedule, currentHeight) : null;
      const payload = {
        ...halving,
        currentHeight,
        cadence,
        estimatedSeconds,
        estimatedDate: estimatedSeconds
          ? new Date(Date.now() + estimatedSeconds * 1000).toISOString()
          : null,
      };

      // Retry unavailable data promptly, without retaining an old countdown.
      if (payload.halvingStatus === 'available' && cadence !== null) {
        await setRedisCache(redisClient, HALVING_CACHE_KEY, payload, HALVING_CACHE_TTL);
      }
      res.json({ success: true, ...payload, cached: false });
    } catch (error) {
      logSafeError('❌ [HALVING] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch halving info' });
    }
  });

  router.get('/api/network/mining-metrics', async (req, res) => {
    try {
      const pool = req.app.locals.pool;
      const window = Math.min(Math.max(parseInt(req.query.window, 10) || 20, 5), 100);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 120, 20), 500);

      const result = await pool.query(
        `SELECT height, difficulty, timestamp, transaction_count, total_fees
         FROM blocks
         ORDER BY height DESC
         LIMIT $1`,
        // Keep the averaging window and its predecessor outside the displayed range.
        [limit + window]
      );

      const rows = result.rows.reverse();
      const intervals = rows.map((r, i) => {
        if (i === 0) return null;
        const prev = rows[i - 1];
        const delta = parseInt(r.timestamp, 10) - parseInt(prev.timestamp, 10);
        return Number(r.height) === Number(prev.height) + 1 ? delta : null;
      });

      const difficulties = rows.map((r) => parseFloat(r.difficulty) || 0);
      // Same 2^13 Equihash constant as /api/network/stats — see comment there.
      const solrates = difficulties.map((d, i) => intervals[i] > 0 ? (d * 8192) / intervals[i] : null);
      const fees = rows.map((r) => (parseInt(r.total_fees, 10) || 0) / 1e8);
      const txCounts = rows.map((r) => parseInt(r.transaction_count, 10) || 0);

      const rollDiff = rollingAverage(difficulties, window);
      const rollSolrate = rollingAverage(solrates, window);
      const rollBlockTime = rollingAverage(intervals, window);
      const rollFees = rollingAverage(fees, window);
      const rollTx = rollingAverage(txCounts, window);

      const points = rows.map((r, i) => ({
        height: parseInt(r.height, 10),
        difficulty: rollDiff[i],
        solrate: rollSolrate[i],
        blockTime: rollBlockTime[i],
        txFees: rollFees[i],
        txCount: rollTx[i],
      })).slice(-limit);

      const latest = points[points.length - 1] || {};

      res.json({
        success: true,
        window,
        latest: {
          solrate: latest.solrate ?? null,
          difficulty: latest.difficulty ?? null,
          blockTime: latest.blockTime ?? null,
          txFees: latest.txFees ?? null,
          txCount: latest.txCount ?? null,
        },
        points,
      });
    } catch (error) {
      logSafeError('❌ [MINING-METRICS] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch mining metrics' });
    }
  });

  // Historical full trailing windows; headlines use /api/network/stats.
  router.get('/api/network/hashrate-history', async (req, res) => {
    const period = req.query.period || '90d';
    const window = req.query.window || '24h';
    if (!['7d', '30d', '90d', '1y', 'all'].includes(period) || !['24h', '7d'].includes(window)) {
      return res.status(400).json({ success: false, error: 'Invalid period or window' });
    }
    try {
      const pool = req.app.locals.pool;
      const redisClient = req.app.locals.redisClient;
      const cacheKey = `network:hashrate-history:work-v1:${period}:${window}`;
      const cached = await getFromRedisCache(redisClient, cacheKey);
      if (cached) return res.json({ ...cached, cached: true });
      const history = await cachedHashrateHistory(pool, period, window);
      const response = { success: true, period, ...history };
      await setRedisCache(redisClient, cacheKey, response, 600);
      res.json(response);
    } catch (error) {
      logSafeError('❌ [HASHRATE-HISTORY] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch hashrate history' });
    }
  });

  router.get('/api/network/pool-history', async (req, res) => {
    try {
      const pool = req.app.locals.pool;
      const period = req.query.period || '1y';
      const format = req.query.format || 'zec'; // 'zec' (default) or 'zatoshi'
      const useZat = format === 'zatoshi';
      const interval = periodToInterval(period);
      const hasPoolCols = await columnExists(pool, 'privacy_trends_daily', 'orchard_pool_size');
      const hasIronwoodCol = hasPoolCols && await columnExists(pool, 'privacy_trends_daily', 'ironwood_pool_size');

      const cols = hasPoolCols
        ? `date::text AS date, pool_size, shielded_percentage, chain_supply,
           sprout_pool_size, sapling_pool_size, orchard_pool_size,
           ${hasIronwoodCol ? 'ironwood_pool_size,' : ''} transparent_pool_size`
        : `date::text AS date, pool_size, shielded_percentage`;

      const dateFilter =
        period === 'all'
          ? `date >= '2016-10-28'`
          : `date >= CURRENT_DATE - INTERVAL '${interval}'`;

      const result = await pool.query(
        `SELECT ${cols}
         FROM privacy_trends_daily
         WHERE ${dateFilter}
         ORDER BY date ASC`
      );

      const ZAT = 1e8;
      const points = result.rows.map((r) => {
        const sproutZat = hasPoolCols ? (parseInt(r.sprout_pool_size, 10) || 0) : 0;
        const saplingZat = hasPoolCols ? (parseInt(r.sapling_pool_size, 10) || 0) : 0;
        const orchardZat = hasPoolCols ? (parseInt(r.orchard_pool_size, 10) || 0) : 0;
        const ironwoodZat = hasIronwoodCol ? (parseInt(r.ironwood_pool_size, 10) || 0) : 0;
        const transparentZat = hasPoolCols ? (parseInt(r.transparent_pool_size, 10) || 0) : 0;
        const shieldedZat = parseInt(r.pool_size, 10) || 0;
        const chainSupplyZat = hasPoolCols ? (parseInt(r.chain_supply, 10) || 0) : 0;

        if (useZat) {
          return {
            date: r.date,
            shieldedZat: shieldedZat.toString(),
            sproutZat: sproutZat.toString(),
            saplingZat: saplingZat.toString(),
            orchardZat: orchardZat.toString(),
            ironwoodZat: ironwoodZat.toString(),
            transparentZat: transparentZat.toString(),
            chainSupplyZat: chainSupplyZat > 0 ? chainSupplyZat.toString() : null,
            shieldedSupplyPct: computeShieldedSupplyPct({
              shieldedZat,
              chainSupplyZat,
              sproutZat,
              saplingZat,
              orchardZat,
              transparentZat,
            }),
            hasPoolBreakdown: hasPoolCols,
          };
        }

        const shielded = shieldedZat / ZAT;
        const chainSupply = chainSupplyZat / ZAT;

        return {
          date: r.date,
          shielded,
          sprout: sproutZat / ZAT,
          sapling: saplingZat / ZAT,
          orchard: orchardZat / ZAT,
          ironwood: ironwoodZat / ZAT,
          transparent: transparentZat / ZAT,
          chainSupply: chainSupply > 0 ? chainSupply : null,
          shieldedSupplyPct: computeShieldedSupplyPct({
            shieldedZat,
            chainSupplyZat,
            sproutZat,
            saplingZat,
            orchardZat,
            transparentZat,
          }),
          hasPoolBreakdown: hasPoolCols,
        };
      });

      const verifiedPerPool = hasPoolCols ? await hasVerifiedPerPoolBreakdown(pool) : false;

      const coverageStart = points.length > 0 ? String(points[0].date).slice(0, 10) : null;
      const coverageEnd = points.length > 0 ? String(points[points.length - 1].date).slice(0, 10) : null;

      res.json({
        success: true,
        period,
        format,
        points,
        timelineStart: '2016-10-28',
        coverageStart,
        coverageEnd,
        hasPoolBreakdown: hasPoolCols,
        hasVerifiedPerPoolBreakdown: verifiedPerPool,
      });
    } catch (error) {
      logSafeError('❌ [POOL-HISTORY] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch pool history' });
    }
  });

  router.get('/api/network/emission', async (req, res) => {
    try {
      const pool = req.app.locals.pool;
      const callZebraRPC = req.app.locals.callZebraRPC;
      const period = req.query.period || 'all';
      const interval = periodToInterval(period);

      let supplyPoints = [];
      let supplyHistoryTable = null;
      const hasChainSnapshots = await tableExists(pool, 'chain_snapshots');
      if (hasChainSnapshots) {
        const snap = await pool.query(
          `SELECT snapshot_time, chain_supply_zat, block_height
           FROM chain_snapshots
           WHERE ${period === 'all' ? 'TRUE' : `snapshot_time >= NOW() - INTERVAL '${interval}'`}
           ORDER BY snapshot_time ASC`
        );
        supplyPoints = supplyHistory(snap.rows, 'chain_snapshots');
        if (supplyPoints.length) supplyHistoryTable = 'chain_snapshots';
      }

      const trends = await pool.query(
        `SELECT date::text AS date, pool_size, chain_supply
         FROM privacy_trends_daily
         WHERE ${period === 'all' ? 'TRUE' : `date >= CURRENT_DATE - INTERVAL '${interval}'`}
         ORDER BY date ASC`
      );

      // Fall back to daily privacy trends when snapshots are new or sparse
      const validCount = points => points.filter(point => point.circulatingZat !== null).length;
      if (validCount(supplyPoints) < 2) {
        const fromTrends = supplyHistory(trends.rows, 'privacy_trends_daily');
        if (validCount(fromTrends) > validCount(supplyPoints)) {
          supplyPoints = fromTrends;
          supplyHistoryTable = 'privacy_trends_daily';
        }
      }

      if (await tableExists(pool, 'chain_supply_daily')) {
        const state = (await pool.query('SELECT verified_height,verified_hash FROM chain_supply_archive_state WHERE id=true')).rows[0];
        const canonical = state && await callZebraRPC('getblockhash', [Number(state.verified_height)]).catch(() => null) === state.verified_hash;
        const archive = canonical ? await pool.query(
          `SELECT a.date::text AS date,a.block_height,a.chain_supply_zat
           FROM chain_supply_daily a
           WHERE a.date < (NOW() AT TIME ZONE 'UTC')::date
             AND ${period === 'all' ? 'TRUE' : `a.date >= (NOW() AT TIME ZONE 'UTC')::date - INTERVAL '${interval}'`}
           ORDER BY a.date ASC`
        ) : { rows: [] };
        if (archive.rows.length) {
          const recentSource = supplyPoints.length ? supplyHistoryTable : null;
          supplyPoints = mergedSupplyHistory(archive.rows, supplyPoints);
          supplyHistoryTable = recentSource ? `chain_supply_daily+${recentSource}` : 'chain_supply_daily';
        }
      }

      // Keep the observed points, including decreases and unknown values.
      // Interpolating missing dates would invent supply observations.
      const dailyEmission = dailyNetSupplyChanges(trends.rows);
      const latest = supplyPoints.at(-1);
      const latestSupply = latest?.circulating ?? null;
      const currentHeight = Number(await callZebraRPC('getblockcount').catch(() => NaN));
      const [subsidy, cadence, chainInfo] = Number.isSafeInteger(currentHeight) && currentHeight > 0
        ? await Promise.all([
          callZebraRPC('getblocksubsidy', [currentHeight]).catch(() => null),
          observedBlockCadence(pool, currentHeight).catch(() => null),
          callZebraRPC('getblockchaininfo').catch(() => null),
        ]) : [null, null, null];
      const dailyEstimate = subsidyZat(subsidy?.totalblocksubsidy) !== null && cadence !== null
        ? subsidy.totalblocksubsidy * (86400 / cadence.intervalSeconds) : null;
      const observations = validCount(supplyPoints);

      res.json({
        success: true,
        maxSupply: MAX_SUPPLY_ZEC,
        circulating: latestSupply,
        circulatingZat: latest?.circulatingZat ?? null,
        supplyObservedAt: latest?.date ?? null,
        remaining: latestSupply === null ? null : (21_000_000 * 1e8 - latest.circulatingZat) / 1e8,
        circulatingPct: latestSupply === null ? null : (latestSupply / MAX_SUPPLY_ZEC) * 100,
        dailyEmissionEstimate: dailyEstimate,
        cadence,
        supplyHistory: supplyPoints,
        projection: supplyProjection({ schedule: networkSchedule(chainInfo), latest, currentHeight, cadence }),
        dailyEmission,
        dailyEmissionMeaning: 'net-chain-supply-change',
        hasChainSnapshots,
        supplyHistoryTable,
        supplyHistorySource: observations >= 2 ? 'history' : observations === 1 ? 'partial' : 'none',
      });
    } catch (error) {
      logSafeError('❌ [EMISSION] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch emission data' });
    }
  });

  router.get('/api/network/chain-size-history', async (req, res) => {
    try {
      const pool = req.app.locals.pool;
      if (!(await tableExists(pool, 'chain_snapshots'))) {
        return res.json({ success: true, points: [], available: false });
      }

      const period = req.query.period || '90d';
      const interval = periodToInterval(period);

      const result = await pool.query(
        `SELECT snapshot_time, chain_size_bytes, block_height
         FROM chain_snapshots
         WHERE ${period === 'all' ? 'TRUE' : `snapshot_time >= NOW() - INTERVAL '${interval}'`}
         ORDER BY snapshot_time ASC`
      );

      res.json({
        success: true,
        available: true,
        period,
        points: result.rows.map((r) => ({
          time: r.snapshot_time,
          sizeBytes: parseInt(r.chain_size_bytes, 10) || 0,
          sizeGB: (parseInt(r.chain_size_bytes, 10) || 0) / (1024 ** 3),
          height: parseInt(r.block_height, 10),
        })),
      });
    } catch (error) {
      logSafeError('❌ [CHAIN-SIZE] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch chain size history' });
    }
  });

  router.get('/api/network/blocks/recent', async (req, res) => {
    try {
      const pool = req.app.locals.pool;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 50);

      const result = await pool.query(
        `SELECT
          b.height, b.hash, b.timestamp, b.transaction_count, b.size,
          b.miner_address, b.total_fees,
          c.total_output AS coinbase_zat
         FROM blocks b
         LEFT JOIN transactions c ON c.block_height = b.height AND c.is_coinbase = true
         ORDER BY b.height DESC
         LIMIT $1`,
        [limit]
      );

      res.json({
        success: true,
        blocks: result.rows.map((r) => ({
          height: parseInt(r.height, 10),
          hash: r.hash,
          timestamp: parseInt(r.timestamp, 10),
          txCount: parseInt(r.transaction_count, 10) || 0,
          size: parseInt(r.size, 10) || 0,
          minerAddress: r.miner_address,
          fees: (parseInt(r.total_fees, 10) || 0) / 1e8,
          // Legacy alias retained; this is transparent coinbase output value, not miner receipts.
          minerReward: supplyZat(r.coinbase_zat) === null ? null : supplyZat(r.coinbase_zat) / 1e8,
          coinbaseTransparentOutput: supplyZat(r.coinbase_zat) === null ? null : supplyZat(r.coinbase_zat) / 1e8,
        })),
      });
    } catch (error) {
      logSafeError('❌ [RECENT-BLOCKS] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch recent blocks' });
    }
  });
}

module.exports = { registerNetworkAnalyticsRoutes, discoverNextHalving };
