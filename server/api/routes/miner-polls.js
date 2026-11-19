/**
 * Miner sentiment poll routes
 *
 * GET /api/mining/polls/nu7-1 — tally of NU7.1 miner ballots in coinbase Miner Data
 */

const express = require('express');
const { logSafeError } = require('../lib/safe-log');
const { getPoolName } = require('../mining-pools');
const { START_HEIGHT, END_HEIGHT, TALLY_SQL, tallyRows } = require('../lib/miner-poll');

const router = express.Router();
let pool, redisClient;

router.use((req, res, next) => {
  pool = req.app.locals.pool;
  redisClient = req.app.locals.redisClient;
  next();
});

const CACHE_KEY = 'zcash:mining:polls:nu7-1:v1';

router.get('/api/mining/polls/nu7-1', async (req, res) => {
  try {
    try {
      if (redisClient?.isOpen) {
        const hit = await redisClient.get(CACHE_KEY);
        if (hit) return res.json({ success: true, ...JSON.parse(hit) });
      }
    } catch {}

    const tip = await pool.query('SELECT MAX(height) AS height FROM blocks');
    const tipHeight = tip.rows[0]?.height == null ? null : Number(tip.rows[0].height);
    if (tipHeight == null) return res.status(503).json({ error: 'Miner poll tally is not available' });

    const rows = tipHeight >= START_HEIGHT
      ? (await pool.query(TALLY_SQL, [START_HEIGHT, Math.min(tipHeight, END_HEIGHT)])).rows
      : [];
    const data = { ...tallyRows(rows, { tipHeight, getPoolName }), generatedAt: new Date().toISOString() };

    // Short TTL while blocks still arrive or the end is unconfirmed; reorgs can still change it.
    const ttl = data.state === 'final' ? 600 : 20;
    try { if (redisClient?.isOpen) await redisClient.setEx(CACHE_KEY, ttl, JSON.stringify(data)); } catch {}
    return res.json({ success: true, ...data });
  } catch (err) {
    logSafeError('mining/polls/nu7-1 error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
