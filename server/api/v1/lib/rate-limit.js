/**
 * server/api/v1/lib/rate-limit.js
 *
 * Minimal, dependency-free per-IP sliding-window rate limiter for
 * endpoint-specific v1 protections (currently: the two scan endpoints).
 *
 * Deliberately NOT built on express-rate-limit: that package's v8
 * `X-Forwarded-For` validation throws hard at request time if the hosting
 * app's `trust proxy` setting doesn't match its expectations — a footgun
 * this module can't control, since /v1 is designed to be mountable either
 * in-process (inheriting server.js's `app.set('trust proxy', 1)`) or on a
 * standalone dedicated host with its own proxy config (see README.md,
 * "Architecture status"). A tiny in-memory counter has no such dependency
 * on how the caller configured Express, and mirrors the existing pattern
 * already used for the WebSocket fallback limiter in server.js
 * (`wsFallbackLimiter`).
 *
 * CAVEAT (documented in README.md too): this is in-memory and per-process.
 * If /v1 is ever horizontally scaled across multiple instances, each
 * instance enforces its own independent window — same caveat the existing
 * WS fallback limiter already carries. Fine for a single dark-launch
 * instance; revisit (e.g. Redis-backed) before scaling out.
 */

const { sendProblem } = require('./problem');

/**
 * @param {object} opts
 * @param {number} opts.windowMs
 * @param {number} opts.max
 * @param {string} opts.key - identifies this limiter in the problem detail (e.g. 'scan/orchard')
 * @param {function} [opts.onLimit] - optional fixed endpoint-specific response
 */
function createRateLimiter({ windowMs, max, key, onLimit }) {
  const hits = new Map(); // ip -> timestamps[]

  // Periodic sweep so the map can't grow unbounded under sustained
  // distinct-IP traffic. Safe no-op if this limiter never gets requests.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) hits.delete(ip);
      else hits.set(ip, active);
    }
  }, Math.max(windowMs, 5000));
  sweep.unref?.();

  function middleware(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    const existing = hits.get(ip) || [];
    const active = existing.filter((t) => t > windowStart);

    if (active.length >= max) {
      const oldestInWindow = active[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      if (onLimit) { onLimit(req, res, retryAfterSeconds); return; }
      sendProblem(res, 'rate-limited', {
        instance: req.originalUrl,
        detail: `Rate limit exceeded for ${key}: max ${max} requests per ${Math.round(windowMs / 1000)}s.`,
      });
      return;
    }

    active.push(now);
    hits.set(ip, active);
    next();
  }

  middleware._stop = () => clearInterval(sweep);
  return middleware;
}

module.exports = { createRateLimiter };
