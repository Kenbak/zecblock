/**
 * Exchange flow routes
 * /api/exchange-flows/daily — daily deposits, withdrawals and net flow of
 * labelled exchange and custody wallets (migration 026, jobs/refresh-exchange-flows.js).
 *
 * Exact zatoshi decimal strings. 503 until the first full rebuild completes;
 * status 'stale' (with staleReason) when labels, classifier or tip moved on.
 * Days outside coverage are null, never zero.
 */
const express = require('express');
const { createListCache } = require('../list-cache');
const { dailyFlows, ExchangeFlowQueryError } = require('../../lib/exchange-flow-store');
const { logSafeError } = require('../lib/safe-log');

const router = express.Router();
const cacheFallback = createListCache({ enabled: false });

router.get('/api/exchange-flows/daily', async (req, res) => {
  try {
    const { entity, from, to } = req.query;
    const pool = req.app.locals.pool;
    const tip = req.app.locals.chainTip;
    const data = await (req.app.locals.listCache || cacheFallback).getOrLoad({
      family: 'exchange-flows-daily-v1',
      params: { entity: entity ?? 'all', from: from ?? null, to: to ?? null, day: new Date().toISOString().slice(0, 10),
        tipHeight: tip?.height ?? 0, tipHash: tip?.hash ?? '' },
      freshTtlSeconds: 60, staleTtlSeconds: 61, cacheable: true, shouldCache: value => value?.success === true,
      load: () => dailyFlows(pool, { entity, from, to }),
    });
    res.json(data.value);
  } catch (error) {
    if (error instanceof ExchangeFlowQueryError) {
      if (error.status === 503) res.set('Retry-After', '300');
      return res.status(error.status).json({ success: false, error: error.publicMessage, ...(error.reason ? { reason: error.reason } : {}) });
    }
    logSafeError('Exchange flow history failed:', error);
    res.status(500).json({ success: false, error: 'Exchange flow history unavailable' });
  }
});

module.exports = router;
