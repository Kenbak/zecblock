'use strict';

/**
 * IndexNow notifier for durable public mainnet URL state changes.
 *
 * IndexNow is a discovery hint for Bing/Yandex/Seznam/Naver. It never
 * replaces internal links, sitemaps or canonical tags, and every submission
 * spends crawl budget, so this module is deliberately narrow (see the SEO
 * checklist in AGENTS.md, section 6):
 *
 * - Only mainnet, only the canonical https host, only the exact page shapes
 *   below. Testnet/Crosslink, API/private URLs, filter/query variants,
 *   noindex pages and block-hash aliases that canonicalize to a height are
 *   never built, so they can never be submitted.
 * - Only state changes: a new canonical block, a transaction first entering
 *   the mempool, (re)confirmation, a drop of a transaction this notifier
 *   announced as pending, a reorg, and newsletter publication/update. Never
 *   polls, self-corrections or repeated broadcasts of the same state.
 * - Batched, deduplicated and capped per hour. Submission happens off the
 *   event path and every failure is swallowed into `onError`, so a slow or
 *   failing IndexNow endpoint can never disturb block/mempool broadcasting.
 *
 * The key itself is private configuration (INDEXNOW_KEY); the frontend
 * serves it at https://<host>/<key>.txt from the same environment value.
 */

const DEFAULT_ENDPOINT = 'https://api.indexnow.org/indexnow';

const DEFAULTS = {
  flushIntervalMs: 30_000,
  maxBatchSize: 1_000,
  maxUrlsPerHour: 3_000,
  recentTtlMs: 15 * 60_000,
  maxRecentEntries: 20_000,
  maxPendingAnnounced: 20_000,
  maxReorgDepth: 10,
  requestTimeoutMs: 10_000,
};

// IndexNow key format: 8–128 characters of a-z, A-Z, 0-9 and '-'.
const KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_HEIGHT = 100_000_000; // Mirrors proxy.ts block-height validation.
// Mirrors lib/newsletter NEWSLETTER_SLUG; one path segment, never a path.
const NEWSLETTER_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;

// The complete set of path shapes this notifier may ever submit.
const ELIGIBLE_PATHS = [
  /^\/block\/(?:0|[1-9][0-9]{0,8})$/,
  /^\/block\/[0-9a-f]{64}$/, // Persistent orphan pages only (self-canonical).
  /^\/tx\/[0-9a-f]{64}$/,
  /^\/newsletter\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/,
];

function normalizeHash(value) {
  if (typeof value !== 'string') return null;
  const hash = value.trim().toLowerCase();
  return HASH_PATTERN.test(hash) ? hash : null;
}

function normalizeHeight(value) {
  const height = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(height) && height >= 0 && height <= MAX_HEIGHT ? height : null;
}

function isEligibleIndexNowPath(path) {
  return typeof path === 'string' && ELIGIBLE_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Builds the canonical path for an allowed event, or null when the event is
 * not one IndexNow may announce. Canonical block hashes are deliberately not
 * representable: only `block-orphaned` produces a hash path.
 */
function pathForEvent(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'block-canonical':
    case 'block-reorg': {
      const height = normalizeHeight(event.height);
      return height === null ? null : `/block/${height}`;
    }
    case 'block-orphaned': {
      const hash = normalizeHash(event.hash);
      return hash ? `/block/${hash}` : null;
    }
    case 'tx-pending':
    case 'tx-confirmed':
    case 'tx-dropped': {
      const txid = normalizeHash(event.txid);
      return txid ? `/tx/${txid}` : null;
    }
    case 'newsletter': {
      const slug = typeof event.slug === 'string' ? event.slug : '';
      return NEWSLETTER_SLUG.test(slug) ? `/newsletter/${slug}` : null;
    }
    default:
      return null;
  }
}

/**
 * Returns the IndexNow configuration only when every precondition for a
 * public mainnet submission holds; otherwise `{ enabled: false, reason }`.
 * The network must be explicitly mainnet: a missing value is not assumed to
 * be mainnet, so testnet/Crosslink API instances can never submit.
 */
function resolveIndexNowConfig(env = process.env) {
  const network = String(env.ZCASH_NETWORK || env.NETWORK || '').trim().toLowerCase();
  const key = String(env.INDEXNOW_KEY || '').trim();
  const host = String(env.INDEXNOW_HOST || '').trim().toLowerCase();
  const endpoint = String(env.INDEXNOW_ENDPOINT || DEFAULT_ENDPOINT).trim();

  if (!key) return { enabled: false, reason: 'INDEXNOW_KEY not configured' };
  if (!KEY_PATTERN.test(key)) return { enabled: false, reason: 'INDEXNOW_KEY has an invalid format' };
  if (network !== 'mainnet') return { enabled: false, reason: 'network is not explicitly mainnet' };
  if (!HOST_PATTERN.test(host)) return { enabled: false, reason: 'INDEXNOW_HOST not configured' };
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return { enabled: false, reason: 'INDEXNOW_ENDPOINT is not a URL' };
  }
  if (endpointUrl.protocol !== 'https:') return { enabled: false, reason: 'INDEXNOW_ENDPOINT must use https' };
  return { enabled: true, key, host, endpoint: endpointUrl.toString() };
}

function createIndexNowNotifier({
  key,
  host,
  endpoint = DEFAULT_ENDPOINT,
  enabled = true,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  onError = () => {},
  onSubmit = () => {},
  flushIntervalMs = DEFAULTS.flushIntervalMs,
  maxBatchSize = DEFAULTS.maxBatchSize,
  maxUrlsPerHour = DEFAULTS.maxUrlsPerHour,
  recentTtlMs = DEFAULTS.recentTtlMs,
  maxRecentEntries = DEFAULTS.maxRecentEntries,
  maxPendingAnnounced = DEFAULTS.maxPendingAnnounced,
  maxReorgDepth = DEFAULTS.maxReorgDepth,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
} = {}) {
  const active = Boolean(enabled && key && host && typeof fetchImpl === 'function');

  // URL path -> nothing; insertion order is the submission order.
  const queue = new Set();
  // `${type}|${path}` -> expiry. Suppresses repeated broadcasts of one state
  // (chain-tip self-corrections, poll fallbacks, Redis relays) while still
  // letting a later, different state of the same URL through.
  const recent = new Map();
  // txids this notifier announced as pending; only their drops are announced,
  // so a drop never introduces a URL search engines were not told about.
  const announcedPending = new Map();
  // Submitted URL timestamps inside the trailing hour.
  const submittedAt = [];
  let lastTip = null;
  let timer = null;
  let inFlight = null;
  let stopped = false;
  const stats = { queued: 0, submitted: 0, rejectedIneligible: 0, droppedDuplicate: 0, droppedRateLimit: 0, failedBatches: 0 };

  function safeError(context, err) {
    try {
      onError(context, err);
    } catch {
      // Logging must never break the caller.
    }
  }

  function prune(map, limit, at) {
    for (const [entry, expiry] of map) {
      if (expiry > at && map.size <= limit) break;
      map.delete(entry);
    }
  }

  function scheduleFlush() {
    if (timer || stopped || queue.size === 0) return;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  }

  function enqueue(event) {
    if (!active || stopped) return false;
    const path = pathForEvent(event);
    if (!path || !isEligibleIndexNowPath(path)) {
      stats.rejectedIneligible++;
      return false;
    }
    const at = now();
    const dedupeKey = `${event.type}|${path}`;
    prune(recent, maxRecentEntries, at);
    if ((recent.get(dedupeKey) || 0) > at) {
      stats.droppedDuplicate++;
      return false;
    }
    recent.delete(dedupeKey); // Re-insert so Map order tracks expiry order.
    recent.set(dedupeKey, at + recentTtlMs);
    if (queue.has(path)) {
      stats.droppedDuplicate++;
    } else {
      queue.add(path);
      stats.queued++;
    }
    scheduleFlush();
    return true;
  }

  function takeBatch(at) {
    while (submittedAt.length && submittedAt[0] <= at - 3_600_000) submittedAt.shift();
    const budget = Math.max(0, Math.min(maxBatchSize, maxUrlsPerHour - submittedAt.length));
    const batch = [];
    for (const path of queue) {
      if (batch.length >= budget) break;
      batch.push(path);
      queue.delete(path);
    }
    // Over the hourly cap, newest state wins later; drop the backlog rather
    // than letting it grow without bound while the cap is exhausted.
    if (budget === 0 && queue.size) {
      stats.droppedRateLimit += queue.size;
      queue.clear();
    }
    return batch;
  }

  async function submit(paths) {
    const urlList = paths.map((path) => `https://${host}${path}`);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const abortTimer = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;
    abortTimer?.unref?.();
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList }),
        signal: controller?.signal,
      });
      // 200 OK and 202 Accepted (key validation pending) are both success.
      if (response.status !== 200 && response.status !== 202) {
        stats.failedBatches++;
        safeError('submit', new Error(`IndexNow responded with HTTP ${response.status}`));
        return { ok: false, status: response.status, count: urlList.length };
      }
      stats.submitted += urlList.length;
      try {
        onSubmit({ status: response.status, count: urlList.length });
      } catch {
        // Observability hooks must not affect submission state.
      }
      return { ok: true, status: response.status, count: urlList.length };
    } catch (err) {
      stats.failedBatches++;
      safeError('submit', err);
      return { ok: false, status: null, count: urlList.length };
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
  }

  /** Submits everything currently queued (respecting caps). Never rejects. */
  async function flush() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (!active) return [];
    if (inFlight) await inFlight;
    const results = [];
    const run = (async () => {
      while (queue.size) {
        const at = now();
        const batch = takeBatch(at);
        if (!batch.length) break;
        // Count the attempt against the hourly cap whether or not it
        // succeeds, so a failing endpoint is not hammered with retries.
        for (let i = 0; i < batch.length; i++) submittedAt.push(at);
        results.push(await submit(batch));
      }
    })().catch((err) => safeError('flush', err));
    inFlight = run;
    await run;
    inFlight = null;
    return results;
  }

  /**
   * A block became the canonical tip. Detects reorgs against the previously
   * seen tip: a same-or-lower height with a different hash, or a child whose
   * parent is not the previous tip. Partial rows (height+hash only) are fine.
   */
  function blockConnected(block) {
    if (!active || !block) return;
    const height = normalizeHeight(block.height);
    const hash = normalizeHash(block.hash);
    if (height === null || !hash) return;
    const previousHash = normalizeHash(block.previous_block_hash ?? block.previousBlockHash ?? null);

    const prior = lastTip;
    if (prior && prior.height === height && prior.hash === hash) {
      // Same tip re-broadcast (chain-tip self-correction, poll fallback,
      // relay). A partial row may have arrived first, so the parent link can
      // only be checked now that the full row carries it.
      if (!prior.parentChecked && previousHash && prior.parent) {
        prior.parentChecked = true;
        announceParentMismatch(prior.parent, height, previousHash);
      }
      return;
    }
    if (prior && height < prior.height - maxReorgDepth) return; // Stale or out-of-order event.

    if (prior && height <= prior.height) {
      // The tip moved back or sideways: every height from here to the old
      // tip now shows a replacement (or no) block, and the old tip is an orphan.
      const top = Math.min(prior.height, height + maxReorgDepth);
      for (let h = height; h <= top; h++) enqueue({ type: 'block-reorg', height: h });
      enqueue({ type: 'block-orphaned', hash: prior.hash });
    } else if (prior && previousHash) {
      announceParentMismatch(prior, height, previousHash);
    }

    lastTip = {
      height,
      hash,
      parent: prior ? { height: prior.height, hash: prior.hash } : null,
      parentChecked: Boolean(previousHash),
    };
    enqueue({ type: 'block-canonical', height });
  }

  // A child whose parent is not the previously seen tip replaced that tip.
  function announceParentMismatch(parent, height, previousHash) {
    if (height !== parent.height + 1 || previousHash === parent.hash) return;
    enqueue({ type: 'block-reorg', height: parent.height });
    enqueue({ type: 'block-orphaned', hash: parent.hash });
  }

  function mempoolAdded(txid) {
    const normalized = normalizeHash(txid);
    if (!normalized) return;
    if (enqueue({ type: 'tx-pending', txid: normalized })) {
      const at = now();
      prune(announcedPending, maxPendingAnnounced, at);
      announcedPending.set(normalized, at + 24 * 3_600_000);
    }
  }

  function transactionMined(txid) {
    const normalized = normalizeHash(txid);
    if (!normalized) return;
    announcedPending.delete(normalized);
    enqueue({ type: 'tx-confirmed', txid: normalized });
  }

  function mempoolDropped(txid) {
    const normalized = normalizeHash(txid);
    if (!normalized || !announcedPending.has(normalized)) return;
    announcedPending.delete(normalized);
    enqueue({ type: 'tx-dropped', txid: normalized });
  }

  function newsletterPublished(slug) {
    enqueue({ type: 'newsletter', slug });
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (inFlight) await inFlight;
  }

  return {
    enabled: active,
    blockConnected,
    mempoolAdded,
    transactionMined,
    mempoolDropped,
    newsletterPublished,
    enqueue,
    flush,
    stop,
    stats: () => ({ ...stats, pending: queue.size }),
  };
}

module.exports = {
  createIndexNowNotifier,
  resolveIndexNowConfig,
  isEligibleIndexNowPath,
  pathForEvent,
  DEFAULTS,
  DEFAULT_ENDPOINT,
};
