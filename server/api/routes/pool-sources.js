/**
 * Shielded pool source routes
 * /api/pools/sources — where value entering one shielded pool came from and
 * where value leaving it went, per day/week/month (migration 048,
 * jobs/refresh-pool-sources.js, lib/pool-sources.js).
 *
 * Exact zatoshi decimal strings. 503 until the first full rebuild completes;
 * status 'stale' (with staleReason) when the classifier, exchange labels,
 * funding registry or tip moved on. Buckets outside coverage are null, never zero.
 */
const express = require('express');
const { createListCache } = require('../list-cache');
const { poolSources, PoolSourceQueryError } = require('../../lib/pool-sources');
const { logSafeError } = require('../lib/safe-log');

const router = express.Router();
const cacheFallback = createListCache({ enabled: false });

router.get('/api/pools/sources', async (req, res) => {
  try {
    const pool = req.app.locals.pool;
    const tip = req.app.locals.chainTip;
    const { pool: poolName, period, from, to, granularity } = req.query;
    const unknown = Object.keys(req.query).filter(k => !['pool', 'period', 'from', 'to', 'granularity'].includes(k));
    if (unknown.length) throw new PoolSourceQueryError('Unknown query parameter');
    const query = Object.fromEntries(Object.entries({ pool: poolName, period, from, to, granularity }).filter(([, v]) => v !== undefined));
    const data = await (req.app.locals.listCache || cacheFallback).getOrLoad({
      family: 'pool-sources-v1',
      params: { ...query, day: new Date().toISOString().slice(0, 10), tipHeight: tip?.height ?? 0, tipHash: tip?.hash ?? '' },
      freshTtlSeconds: 60, staleTtlSeconds: 61, cacheable: true, shouldCache: value => value?.success === true,
      load: () => poolSources(pool, query),
    });
    // The dataset refreshes every few minutes: let browsers reuse a response briefly,
    // so switching back to a view does not cost another round trip.
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    res.json(data.value);
  } catch (error) {
    if (error instanceof PoolSourceQueryError) {
      if (error.status === 503) res.set('Retry-After', '300');
      return res.status(error.status).json({ success: false, error: error.publicMessage, ...(error.reason ? { reason: error.reason } : {}) });
    }
    logSafeError('Pool source history failed:', error);
    res.status(500).json({ success: false, error: 'Pool source history unavailable' });
  }
});

module.exports = router;
