'use strict';

const express = require('express');
const { mainnetOnly } = require('../lib/network-features');
const { setDataHeader } = require('../lib/data-headers');
const { createVenueClient } = require('../../lib/crosschain/venue-providers');
const { readAnalytics, readSwaps } = require('../../lib/crosschain/analytics');

const CACHE_MS = 60_000;
const MAX_STALE_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_IN_FLIGHT = 16;

function createCrosschainVenuesRouter({ createClient = createVenueClient, now = Date.now, cacheMs = CACHE_MS, maxStaleMs = MAX_STALE_MS, indexedEnabled } = {}) {
  const router = express.Router();
  const cache = new Map();
  const pending = new Map();
  const clients = new Map();
  router.use('/api/crosschain/venues', mainnetOnly('Native ZEC cross-chain venues'));

  const indexedCache = new Map();
  async function indexed(req, res, venue, query, collection) {
    res.set('Cache-Control', 'no-store');
    if (!['maya', 'thorchain'].includes(venue)) return res.status(400).json({ success: false, error: 'Choose venue=maya|thorchain.' });
    const enabled = indexedEnabled ?? process.env.CROSSCHAIN_VENUES_READ_ENABLED === '1';
    const pool = req.app.locals.venuePool || req.app.locals.pool;
    if (!enabled || !pool) return res.status(503).json({ success: false, error: 'Indexed venue history is not available on this deployment.' });
    try {
      if (collection) return res.json(await readSwaps(pool, query, { venue, now: new Date(now()) }));
      const key = JSON.stringify([venue, query]);
      let cached = indexedCache.get(key);
      if (!cached || now() - cached.at > CACHE_MS) {
        if (indexedCache.size >= 32) indexedCache.delete(indexedCache.keys().next().value);
        cached = { at: now(), work: readAnalytics(pool, query, { venue, now: new Date(now()) }) };
        indexedCache.set(key, cached);
        cached.work.catch(() => { if (indexedCache.get(key) === cached) indexedCache.delete(key); });
      }
      return res.json(await cached.work);
    } catch (error) {
      return res.status(error.status === 400 ? 400 : 503).json({ success: false, error: error.status === 400 ? 'Invalid venue filters or cursor.' : 'The indexed venue dataset is temporarily unavailable.' });
    }
  }
  router.get('/api/crosschain/venues/analytics', (req, res) => indexed(req, res, req.query.venue, {
    period: req.query.period, granularity: req.query.granularity,
  }, false));
  router.get('/api/crosschain/venues/swaps', (req, res) => indexed(req, res, req.query.venue, {
    period: req.query.period, direction: req.query.direction, status: req.query.status,
    chain: req.query.chain, token: req.query.token, sourceAsset: req.query.sourceAsset, destAsset: req.query.destAsset,
    referral: req.query.referral, search: req.query.search, minUsd: req.query.minUsd, maxUsd: req.query.maxUsd,
    from: req.query.from, to: req.query.to, cursor: req.query.cursor, limit: req.query.limit,
  }, true));

  router.get('/api/crosschain/venues', async (req, res) => {
    const { venue, limit: rawLimit, cursor } = req.query;
    const allowed = ['venue', 'limit', 'cursor'];
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (Object.keys(req.query).some(key => !allowed.includes(key))
        || !['maya', 'thorchain'].includes(venue)
        || (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d{1,2}$/.test(rawLimit)))
        || !Number.isInteger(limit) || limit < 1 || limit > 25
        || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) {
      res.set('Cache-Control', 'no-store');
      return res.status(400).json({ success: false, error: 'Use venue=maya|thorchain, limit=1..25 and an unchanged nextCursor from this venue.' });
    }

    const key = JSON.stringify([venue, limit, cursor || '']);
    const cached = cache.get(key);
    const age = cached ? Math.max(0, now() - cached.at) : null;
    const send = (snapshot, status) => {
      const ageSeconds = Math.max(0, Math.floor((now() - snapshot.at) / 1000));
      res.set('Cache-Control', status === 'stale' ? 'no-store' : 'public, max-age=0, s-maxage=30');
      setDataHeader(res, 'Cache', status);
      return res.json({ success: true, ...snapshot.data, freshness: { status: status === 'stale' ? 'stale' : 'fresh', ageSeconds },
        ...(status === 'stale' ? { warning: 'Provider refresh failed; this is the last observed page.' } : {}) });
    };
    if (cached && age < cacheMs) return send(cached, 'hit');

    try {
      if (!pending.has(key)) {
        if (pending.size >= MAX_IN_FLIGHT) {
          if (cached && age <= maxStaleMs) return send(cached, 'stale');
          res.set('Cache-Control', 'no-store');
          res.set('Retry-After', '5');
          return res.status(503).json({ success: false, error: 'Venue provider requests are busy. Retry shortly.' });
        }
        if (!clients.has(venue)) clients.set(venue, createClient({ venue }));
        const work = Promise.resolve().then(() => clients.get(venue).readPage({ limit, ...(cursor ? { cursor } : {}) }))
          .then(page => {
            const transfers = page.transfers.map(transfer => Object.fromEntries(Object.entries(transfer).filter(([field]) => field !== 'raw')));
            const snapshot = { data: { ...page, transfers }, at: now() };
            if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
            cache.set(key, snapshot);
            return snapshot;
          }).finally(() => pending.delete(key));
        pending.set(key, work);
      }
      return send(await pending.get(key), 'miss');
    } catch (error) {
      if (error?.code === 'INVALID_CURSOR') {
        res.set('Cache-Control', 'no-store');
        return res.status(400).json({ success: false, error: 'Invalid venue cursor. Use the nextCursor returned by this venue.' });
      }
      if (cached && now() - cached.at <= maxStaleMs) return send(cached, 'stale');
      res.set('Cache-Control', 'no-store');
      res.set('Retry-After', '30');
      return res.status(503).json({ success: false, error: `${venue === 'maya' ? 'Maya' : 'THORChain'} activity is temporarily unavailable. No zero activity is inferred.` });
    }
  });
  return router;
}

module.exports = createCrosschainVenuesRouter();
module.exports.createCrosschainVenuesRouter = createCrosschainVenuesRouter;
