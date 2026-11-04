/**
 * Pool Analytics Routes
 *
 * GET /api/pools/overview   — current pool sizes + 24h/7d/30d deltas
 * GET /api/pools/flows      — daily shield/deshield volume aggregation
 * GET /api/pools/activity   — canonical non-coinbase transaction counts per pool
 * GET /api/pools/turnstile  — deshield UTXO spend status (held vs moved)
 */

const express = require('express');
const { logSafeError } = require('../lib/safe-log');
const { PERIOD_DAYS, ACTIVITY_SQL, activityWindow, activityResponse } = require('../lib/pool-activity');
const router = express.Router();

let pool, redisClient;

router.use((req, res, next) => {
  pool = req.app.locals.pool;
  redisClient = req.app.locals.redisClient;
  next();
});

async function cached(key, ttl, fn) {
  try {
    if (redisClient?.isOpen) {
      const hit = await redisClient.get(key);
      if (hit) return JSON.parse(hit);
    }
  } catch {}
  const data = await fn();
  try {
    const seconds = typeof ttl === 'function' ? ttl(data) : ttl;
    if (redisClient?.isOpen && seconds > 0) await redisClient.setEx(key, seconds, JSON.stringify(data));
  } catch {}
  return data;
}

function periodToSeconds(period) {
  const map = { '7d': 604800, '30d': 2592000, '90d': 7776000, '1y': 31536000 };
  return map[period] || 2592000;
}

router.get('/api/pools/activity', async (req, res) => {
  const period = req.query.period === undefined ? '30d' : req.query.period;
  if (typeof period !== 'string' || !Object.hasOwn(PERIOD_DAYS, period)
      || Object.keys(req.query).some(key => key !== 'period')) {
    return res.status(400).json({ error: 'Use period=7d, 30d, 90d or 1y.' });
  }
  const window = activityWindow(period);
  try {
    const ttl = data => data.sourceHeight === null ? 0
      : data.coverage.completeDays === data.coverage.expectedDays ? 300 : 15;
    const data = await cached(`zcash:pools:activity:v1:${period}:${window.endDate}`, ttl, async () => {
      const { rows } = await pool.query(ACTIVITY_SQL, window.params);
      return activityResponse(rows, window);
    });
    if (data.sourceHeight === null) return res.status(503).json({ error: 'Pool activity is not available' });
    return res.json({ success: true, ...data });
  } catch (err) {
    logSafeError('pools/activity error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/pools/overview ────────────────────────────────────────────────

router.get('/api/pools/overview', async (req, res) => {
  try {
    const data = await cached('zcash:pools:overview', 300, async () => {
      const current = await pool.query(`
        SELECT sprout_pool_size, sapling_pool_size, orchard_pool_size,
               COALESCE(ironwood_pool_size, 0) AS ironwood_pool_size,
               transparent_pool_size, shielded_pool_size, chain_supply, updated_at
        FROM privacy_stats ORDER BY updated_at DESC LIMIT 1
      `);
      if (!current.rows.length) return null;
      const s = current.rows[0];

      const deltas = await pool.query(`
        SELECT date,
               sprout_pool_size, sapling_pool_size, orchard_pool_size,
               transparent_pool_size, pool_size, chain_supply
        FROM privacy_trends_daily
        WHERE date IN (CURRENT_DATE - 1, CURRENT_DATE - 7, CURRENT_DATE - 30)
        ORDER BY date DESC
      `);

      const deltaMap = {};
      for (const r of deltas.rows) {
        const daysAgo = Math.round((Date.now() - new Date(r.date).getTime()) / 86400000);
        const key = daysAgo <= 2 ? '24h' : daysAgo <= 8 ? '7d' : '30d';
        deltaMap[key] = r;
      }

      function computeDeltas(currentZat, field) {
        const result = {};
        for (const [period, row] of Object.entries(deltaMap)) {
          const prev = Number(row[field]) || 0;
          result[period] = prev > 0 ? Number(currentZat) - prev : null;
        }
        return result;
      }

      return {
        current: {
          sprout: Number(s.sprout_pool_size) || 0,
          sapling: Number(s.sapling_pool_size) || 0,
          orchard: Number(s.orchard_pool_size) || 0,
          ironwood: Number(s.ironwood_pool_size) || 0,
          transparent: Number(s.transparent_pool_size) || 0,
          shielded: Number(s.shielded_pool_size) || 0,
          chainSupply: Number(s.chain_supply) || 0,
          updatedAt: s.updated_at,
        },
        deltas: {
          sprout: computeDeltas(s.sprout_pool_size, 'sprout_pool_size'),
          sapling: computeDeltas(s.sapling_pool_size, 'sapling_pool_size'),
          orchard: computeDeltas(s.orchard_pool_size, 'orchard_pool_size'),
          ironwood: computeDeltas(s.ironwood_pool_size, 'ironwood_pool_size'),
          shielded: computeDeltas(s.shielded_pool_size, 'pool_size'),
        },
      };
    });

    if (!data) return res.status(503).json({ error: 'Pool data not available' });
    res.json({ success: true, ...data });
  } catch (err) {
    logSafeError('pools/overview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/pools/flows ───────────────────────────────────────────────────

router.get('/api/pools/flows', async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const poolFilter = req.query.pool || 'all';
    const granularity = req.query.granularity || 'daily';
    const format = req.query.format || 'zec'; // 'zec' (default) or 'zatoshi'
    const useZat = format === 'zatoshi';
    const isHourly = granularity === 'hourly';
    const cacheKey = `zcash:pools:flows:v3:${period}:${poolFilter}:${granularity}:${format}`;
    const cacheTtl = isHourly ? 120 : 300;

    const data = await cached(cacheKey, cacheTtl, async () => {
      const since = period === 'all' ? 0 : Math.floor(Date.now() / 1000) - periodToSeconds(period);
      const params = [since];
      let poolClause = '';
      if (poolFilter !== 'all') {
        poolClause = ' AND pool = $2';
        params.push(poolFilter);
      }

      let result;
      if (isHourly) {
        result = await pool.query(`
          SELECT DATE_TRUNC('hour', TO_TIMESTAMP(block_time) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' as bucket,
                 flow_type, pool,
                 SUM(amount_zat) as total_zat, COUNT(*) as tx_count
          FROM shielded_flows
          WHERE block_time >= $1${poolClause}
          GROUP BY bucket, flow_type, pool
          ORDER BY bucket
        `, params);
      } else {
        try {
          result = await pool.query(`
            SELECT date::text AS date, flow_type, pool, total_zat, tx_count
            FROM flow_daily
            WHERE date >= (TO_TIMESTAMP($1) AT TIME ZONE 'UTC')::date${poolFilter !== 'all' ? ' AND pool = $2' : ''}
            ORDER BY date
          `, params);
        } catch {
          result = await pool.query(`
            SELECT (TO_TIMESTAMP(block_time) AT TIME ZONE 'UTC')::date::text as date, flow_type, pool,
                   SUM(amount_zat) as total_zat, COUNT(*) as tx_count
            FROM shielded_flows
            WHERE block_time >= $1${poolClause}
            GROUP BY date, flow_type, pool
            ORDER BY date
          `, params);
        }
      }

      const byBucket = {};
      for (const r of result.rows) {
        const key = isHourly
          ? new Date(r.bucket).toISOString()
          : r.date;
        if (!byBucket[key]) byBucket[key] = { date: key, shield: 0, deshield: 0, shieldTx: 0, deshieldTx: 0 };
        const amount = useZat ? BigInt(r.total_zat) : Number(r.total_zat) / 1e8;
        if (r.flow_type === 'shield') {
          if (useZat) {
            byBucket[key].shield = (BigInt(byBucket[key].shield) + amount).toString();
          } else {
            byBucket[key].shield += amount;
          }
          byBucket[key].shieldTx += Number(r.tx_count);
        } else {
          if (useZat) {
            byBucket[key].deshield = (BigInt(byBucket[key].deshield) + amount).toString();
          } else {
            byBucket[key].deshield += amount;
          }
          byBucket[key].deshieldTx += Number(r.tx_count);
        }
      }

      const points = Object.values(byBucket).sort((a, b) => a.date.localeCompare(b.date));
      for (const p of points) {
        if (useZat) {
          p.net = (BigInt(p.shield) - BigInt(p.deshield)).toString();
        } else {
          p.net = p.shield - p.deshield;
        }
      }

      return { period, pool: poolFilter, granularity, format, points };
    });

    res.json({ success: true, ...data });
  } catch (err) {
    logSafeError('pools/flows error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/pools/turnstile ───────────────────────────────────────────────

// Short-circuit: if the materialized view is being rebuilt, avoid hammering
// the DB with expensive fallback queries. Cache the "building" state briefly.
let turnstileViewAvailable = null; // null = unknown, true/false = cached result
let turnstileViewCheckAt = 0;
const VIEW_CHECK_TTL_MS = 30_000; // re-check every 30s

async function isTurnstileViewReady(pg) {
  const now = Date.now();
  if (turnstileViewAvailable !== null && now - turnstileViewCheckAt < VIEW_CHECK_TTL_MS) {
    return turnstileViewAvailable;
  }
  try {
    const r = await pg.query(`SELECT COUNT(*) AS n FROM turnstile_daily LIMIT 1`);
    turnstileViewAvailable = parseInt(r.rows[0].n) > 0;
  } catch {
    turnstileViewAvailable = false;
  }
  turnstileViewCheckAt = now;
  return turnstileViewAvailable;
}

router.get('/api/pools/turnstile', async (req, res) => {
  try {
    // Fast-path: if view is rebuilding, return immediately
    const viewReady = await isTurnstileViewReady(pool);
    if (!viewReady) {
      return res.status(503).json({
        success: false,
        error: 'turnstile_daily view is rebuilding',
        status: 'building',
        retryAfter: 60,
      });
    }

    const since = req.query.since || '2020-01-01';
    const cacheKey = `zcash:pools:turnstile:${since}`;

    const data = await cached(cacheKey, 600, async () => {
      let summaryResult, timeseriesResult;
      try {
        summaryResult = await pool.query(`
          SELECT
            SUM(deshielded_zat) as total_deshielded,
            SUM(held_zat) as total_held,
            COALESCE(SUM(reshielded_zat), 0) as total_reshielded,
            COALESCE(SUM(exchange_zat), 0) as total_exchange,
            COALESCE(SUM(bridge_zat), 0) as total_bridge,
            COALESCE(SUM(transferred_zat), 0) as total_transferred,
            SUM(tx_count) as total_tx
          FROM turnstile_daily
          WHERE date >= $1::date
        `, [since]);

        timeseriesResult = await pool.query(`
          SELECT date,
                 SUM(deshielded_zat) as deshielded,
                 SUM(held_zat) as held,
                 COALESCE(SUM(reshielded_zat), 0) as reshielded,
                 COALESCE(SUM(exchange_zat), 0) as exchange,
                 COALESCE(SUM(bridge_zat), 0) as bridge,
                 COALESCE(SUM(transferred_zat), 0) as transferred,
                 SUM(tx_count) as tx_count
          FROM turnstile_daily
          WHERE date >= $1::date
          GROUP BY date
          ORDER BY date
        `, [since]);
      } catch {
        summaryResult = await pool.query(`
          WITH deshield_outputs AS (
            SELECT sf.txid, txo.vout_index, txo.value
            FROM shielded_flows sf
            JOIN transaction_outputs txo ON txo.txid = sf.txid
            WHERE sf.flow_type = 'deshield'
              AND txo.address LIKE 't%'
              AND sf.block_time >= EXTRACT(EPOCH FROM $1::date)
          )
          SELECT
            SUM(d.value) as total_deshielded,
            SUM(CASE WHEN ti.prev_txid IS NULL THEN d.value ELSE 0 END) as total_held,
            0 as total_reshielded, 0 as total_exchange, 0 as total_bridge, 0 as total_transferred
          FROM deshield_outputs d
          LEFT JOIN transaction_inputs ti ON ti.prev_txid = d.txid AND ti.prev_vout = d.vout_index
        `, [since]);

        timeseriesResult = { rows: [] };
      }

      const summary = summaryResult.rows[0] || {};
      const totalDeshielded = Number(summary.total_deshielded) || 0;
      const totalHeld = Number(summary.total_held) || 0;
      const totalReshielded = Number(summary.total_reshielded) || 0;
      const totalExchange = Number(summary.total_exchange) || 0;
      const totalBridge = Number(summary.total_bridge) || 0;
      const totalTransferred = Number(summary.total_transferred) || 0;
      const totalMoved = totalReshielded + totalExchange + totalBridge + totalTransferred;

      const timeseries = timeseriesResult.rows.map(r => ({
        date: r.date,
        deshielded: Number(r.deshielded) / 1e8,
        held: Number(r.held) / 1e8,
        reshielded: Number(r.reshielded) / 1e8,
        exchange: Number(r.exchange) / 1e8,
        bridge: Number(r.bridge) / 1e8,
        transferred: Number(r.transferred) / 1e8,
        txCount: Number(r.tx_count),
      }));

      // Fetch last refresh timestamp
      let lastUpdated = null;
      try {
        const stateRow = await pool.query(
          "SELECT updated_at FROM indexer_state WHERE key = 'turnstile_last_processed_time'"
        );
        if (stateRow.rows.length) lastUpdated = stateRow.rows[0].updated_at;
      } catch {}

      return {
        since,
        lastUpdated,
        summary: {
          totalDeshielded: totalDeshielded / 1e8,
          totalHeld: totalHeld / 1e8,
          totalReshielded: totalReshielded / 1e8,
          totalExchange: totalExchange / 1e8,
          totalBridge: totalBridge / 1e8,
          totalTransferred: totalTransferred / 1e8,
          totalMoved: totalMoved / 1e8,
          heldPercent: totalDeshielded > 0 ? (totalHeld / totalDeshielded) * 100 : 0,
          reshieldedPercent: totalDeshielded > 0 ? (totalReshielded / totalDeshielded) * 100 : 0,
          exchangePercent: totalDeshielded > 0 ? (totalExchange / totalDeshielded) * 100 : 0,
          bridgePercent: totalDeshielded > 0 ? (totalBridge / totalDeshielded) * 100 : 0,
          transferredPercent: totalDeshielded > 0 ? (totalTransferred / totalDeshielded) * 100 : 0,
          movedPercent: totalDeshielded > 0 ? (totalMoved / totalDeshielded) * 100 : 0,
          txCount: Number(summary.total_tx) || 0,
        },
        timeseries,
      };
    });

    res.json({ success: true, ...data });
  } catch (err) {
    logSafeError('pools/turnstile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
