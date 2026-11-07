"use strict";
const express = require("express");
const { readAnalytics, readSwaps } = require("../../lib/crosschain/analytics");
const { readShielding } = require("../../lib/crosschain/shielding");
const { logSafeError } = require("../lib/safe-log");
const router = express.Router();
const caches = new WeakMap();
function cacheFor(pool) {
  if (!caches.has(pool)) caches.set(pool, new Map());
  return caches.get(pool);
}
function fail(res, err) {
  if (err.status === 400)
    return res
      .status(400)
      .json({ success: false, error: "Invalid cross-chain filters or cursor" });
  logSafeError("Cross-chain analytics unavailable", err);
  return res.status(503).json({
    success: false,
    error: "Cross-chain index temporarily unavailable",
  });
}
router.get("/api/crosschain/analytics", async (req, res) => {
  // Keep explicit property reads for generated v1 query inventory.
  const q = { period: req.query.period, granularity: req.query.granularity };
  const pool = req.app.locals.pool;
  if (!pool)
    return res
      .status(503)
      .json({ success: false, error: "Database unavailable" });
  const v2 = process.env.CROSSCHAIN_V2_READ_ENABLED === "1";
  const cache = cacheFor(pool),
    key = JSON.stringify([v2, q]);
  try {
    let entry = cache.get(key);
    if (!entry || Date.now() - entry.at > 60000) {
      if (cache.size >= 24) cache.delete(cache.keys().next().value);
      entry = { at: Date.now(), promise: readAnalytics(pool, q, { v2 }) };
      cache.set(key, entry);
      entry.promise.catch(() => {
        if (cache.get(key) === entry) cache.delete(key);
      });
    }
    res.set("Cache-Control", "no-store");
    res.json(await entry.promise);
  } catch (err) {
    fail(res, err);
  }
});
router.get("/api/crosschain/swaps", async (req, res) => {
  const q = {
    period: req.query.period,
    direction: req.query.direction,
    status: req.query.status,
    chain: req.query.chain,
    token: req.query.token,
    sourceAsset: req.query.sourceAsset,
    destAsset: req.query.destAsset,
    referral: req.query.referral,
    search: req.query.search,
    minUsd: req.query.minUsd,
    maxUsd: req.query.maxUsd,
    from: req.query.from,
    to: req.query.to,
    cursor: req.query.cursor,
    limit: req.query.limit,
  };
  try {
    res.set("Cache-Control", "no-store");
    res.json(
      await readSwaps(req.app.locals.pool, q, {
        v2: process.env.CROSSCHAIN_V2_READ_ENABLED === "1",
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});
router.get("/api/crosschain/shielding", async (req, res) => {
  // Keep explicit property reads for generated v1 query inventory.
  const q = { period: req.query.period };
  const pool = req.app.locals.pool;
  if (!pool)
    return res
      .status(503)
      .json({ success: false, error: "Database unavailable" });
  const v2 = process.env.CROSSCHAIN_V2_READ_ENABLED === "1";
  const cache = cacheFor(pool),
    key = JSON.stringify(["shielding", v2, q]);
  try {
    let entry = cache.get(key);
    if (!entry || Date.now() - entry.at > 60000) {
      if (cache.size >= 24) cache.delete(cache.keys().next().value);
      entry = { at: Date.now(), promise: readShielding(pool, q, { v2 }) };
      cache.set(key, entry);
      entry.promise.catch(() => {
        if (cache.get(key) === entry) cache.delete(key);
      });
    }
    res.set("Cache-Control", "no-store");
    res.json(await entry.promise);
  } catch (err) {
    if (err.status === 400)
      return res
        .status(400)
        .json({ success: false, error: "Invalid shielding period" });
    logSafeError("Cross-chain shielding unavailable", err);
    return res.status(503).json({
      success: false,
      error: "Shielding index temporarily unavailable",
    });
  }
});
module.exports = router;
