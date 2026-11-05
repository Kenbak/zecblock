const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setDataHeader } = require('./lib/data-headers');

const CACHE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_REDIS_TIMEOUT_MS = 50;
const REFRESH_LOCK_SECONDS = 30;
const MISS_WAIT_ATTEMPTS = 8;
const MISS_WAIT_MS = 25;
const DELETE_IF_VALUE_MATCHES_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeKeyPart(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
}

function stableSerialize(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('List-cache parameters must contain only finite numbers');
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    )).join(',')}}`;
  }
  throw new TypeError('List-cache parameters must contain only JSON primitives');
}

function duration(startedAt) {
  return Number((performance.now() - startedAt).toFixed(1));
}

function validEntry(entry) {
  return entry
    && entry.version === CACHE_VERSION
    && Number.isFinite(entry.storedAt)
    && Number.isFinite(entry.freshUntil)
    && Number.isFinite(entry.staleUntil)
    && entry.freshUntil >= entry.storedAt
    && entry.staleUntil > entry.freshUntil
    && Object.prototype.hasOwnProperty.call(entry, 'value');
}

function parseEntry(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const entry = JSON.parse(raw);
    return validEntry(entry) ? entry : null;
  } catch {
    return null;
  }
}

function timingToken(value) {
  const token = String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
  return token || 'work';
}

function createLoadTimer() {
  const timings = [];
  return {
    timings,
    async measure(name, operation) {
      const startedAt = performance.now();
      try {
        return await operation();
      } finally {
        timings.push({ name: timingToken(name), durationMs: duration(startedAt) });
      }
    },
  };
}

function formatServerTiming(result) {
  const items = [
    `cache;desc="${result.state}";dur=${result.cacheDurationMs.toFixed(1)}`,
    ...result.loadTimings.map(({ name, durationMs }) => `${timingToken(name)};dur=${durationMs.toFixed(1)}`),
    `total;dur=${result.totalDurationMs.toFixed(1)}`,
  ];
  if (result.refreshScheduled) items.push('refresh;desc="scheduled";dur=0');
  return items.join(', ');
}

function applyListCacheHeaders(res, result) {
  setDataHeader(res, 'Cache', result.state);
  res.set('Server-Timing', formatServerTiming(result));
}

function createListCache({
  redisClient,
  enabled = process.env.API_LIST_CACHE_ENABLED === '1',
  namespace = process.env.API_CACHE_NAMESPACE || process.env.NETWORK || process.env.DB_NAME || 'default',
  maxEntries = positiveInteger(process.env.API_LIST_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
  redisTimeoutMs = positiveInteger(
    process.env.API_LIST_CACHE_REDIS_TIMEOUT_MS,
    DEFAULT_REDIS_TIMEOUT_MS,
  ),
  now = () => Date.now(),
  logger = console,
  schedule = (task) => { void task.catch(() => {}); },
} = {}) {
  const refreshes = new Map();
  const misses = new Map();
  const prefix = `cipherscan:list:v${CACHE_VERSION}:${safeKeyPart(namespace)}`;

  function usableRedis() {
    if (!enabled || !redisClient) return false;
    if (typeof redisClient.isReady === 'boolean') return redisClient.isReady;
    return redisClient.isOpen === true;
  }

  async function redisOperation(operation) {
    if (!usableRedis()) return { ok: false, unavailable: true };
    let timer;
    const operationResult = Promise.resolve().then(operation).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    const timeoutResult = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true }), redisTimeoutMs);
    });
    const result = await Promise.race([operationResult, timeoutResult]);
    clearTimeout(timer);
    return result;
  }

  function cacheKey(family, params) {
    const normalizedFamily = safeKeyPart(family);
    const digest = createHash('sha256').update(stableSerialize(params)).digest('hex');
    return `${prefix}:${normalizedFamily}:${digest}`;
  }

  async function enforceEntryLimit(family, key) {
    if (!usableRedis()
      || typeof redisClient.zAdd !== 'function'
      || typeof redisClient.zCard !== 'function'
      || typeof redisClient.zRange !== 'function') return;

    const indexKey = `${prefix}:index:${safeKeyPart(family)}`;
    const indexed = await redisOperation(() => redisClient.zAdd(indexKey, [{
      score: now(),
      value: key,
    }]));
    if (!indexed.ok) return;
    const cardinality = await redisOperation(() => redisClient.zCard(indexKey));
    if (!cardinality.ok || cardinality.value <= maxEntries) return;

    const overflow = cardinality.value - maxEntries;
    const victimsResult = await redisOperation(() => redisClient.zRange(indexKey, 0, overflow - 1));
    const victims = victimsResult.ok && Array.isArray(victimsResult.value)
      ? victimsResult.value
      : [];
    if (victims.length === 0) return;

    for (const victim of victims) await redisOperation(() => redisClient.del(victim));
    if (typeof redisClient.zRem === 'function') {
      await redisOperation(() => redisClient.zRem(indexKey, victims));
    }
  }

  async function storeEntry({ family, key, value, freshTtlSeconds, staleTtlSeconds }) {
    const storedAt = now();
    const entry = {
      version: CACHE_VERSION,
      storedAt,
      freshUntil: storedAt + freshTtlSeconds * 1_000,
      staleUntil: storedAt + staleTtlSeconds * 1_000,
      value,
    };
    const stored = await redisOperation(() => redisClient.set(
      key,
      JSON.stringify(entry),
      { EX: staleTtlSeconds },
    ));
    if (stored.ok) schedule(enforceEntryLimit(family, key));
    return stored.ok;
  }

  async function runLoader(load) {
    const timer = createLoadTimer();
    const startedAt = performance.now();
    const value = await load({ measure: timer.measure.bind(timer) });
    if (timer.timings.length === 0) {
      timer.timings.push({ name: 'db', durationMs: duration(startedAt) });
    }
    return { value, timings: timer.timings };
  }

  async function releaseOwnedLock(lockKey, lockToken) {
    if (typeof redisClient?.eval !== 'function') return;
    await redisOperation(() => redisClient.eval(
      DELETE_IF_VALUE_MATCHES_SCRIPT,
      { keys: [lockKey], arguments: [lockToken] },
    ));
  }

  async function waitForDistributedFill(key) {
    for (let attempt = 0; attempt < MISS_WAIT_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, MISS_WAIT_MS));
      const read = await redisOperation(() => redisClient.get(key));
      if (!read.ok) return null;
      const entry = parseEntry(read.value);
      if (entry) return entry.value;
    }
    return null;
  }

  function scheduleRefresh({
    family,
    key,
    load,
    freshTtlSeconds,
    staleTtlSeconds,
    shouldCache,
  }) {
    if (refreshes.has(key)) return false;

    const task = (async () => {
      const lockKey = `${key}:refresh-lock`;
      const lockToken = randomUUID();
      const locked = await redisOperation(() => redisClient.set(
        lockKey,
        lockToken,
        { NX: true, EX: REFRESH_LOCK_SECONDS },
      ));
      if (!locked.ok || locked.value !== 'OK') return;

      try {
        const loaded = await runLoader(load);
        if (shouldCache(loaded.value)) {
          await storeEntry({
            family,
            key,
            value: loaded.value,
            freshTtlSeconds,
            staleTtlSeconds,
          });
        }
        if (typeof redisClient.eval === 'function') {
          await redisOperation(() => redisClient.eval(
            DELETE_IF_VALUE_MATCHES_SCRIPT,
            { keys: [lockKey], arguments: [lockToken] },
          ));
        }
      } catch (error) {
        logger?.warn?.(`List-cache refresh failed for ${family}: ${error.message || error}`);
        // Keep the lock until its short expiry as failure backoff. The stale
        // last-known-good entry remains untouched.
      }
    })().finally(() => refreshes.delete(key));

    refreshes.set(key, task);
    schedule(task);
    return true;
  }

  async function getOrLoad({
    family,
    params,
    freshTtlSeconds,
    staleTtlSeconds,
    load,
    cacheable = true,
    shouldCache = (value) => value !== undefined,
  }) {
    if (typeof family !== 'string' || !family) throw new TypeError('List-cache family is required');
    if (typeof load !== 'function') throw new TypeError('List-cache load callback is required');
    if (!Number.isInteger(freshTtlSeconds) || freshTtlSeconds < 1) {
      throw new RangeError('List-cache fresh TTL must be a positive integer');
    }
    if (!Number.isInteger(staleTtlSeconds) || staleTtlSeconds <= freshTtlSeconds) {
      throw new RangeError('List-cache stale TTL must exceed its fresh TTL');
    }

    const totalStartedAt = performance.now();
    const key = cacheKey(family, params);
    const cacheStartedAt = performance.now();
    let cached = null;
    let cacheReadSucceeded = false;

    if (cacheable && usableRedis()) {
      const read = await redisOperation(() => redisClient.get(key));
      cacheReadSucceeded = read.ok;
      if (read.ok) cached = parseEntry(read.value);
      if (read.ok && read.value && !cached && typeof redisClient.eval === 'function') {
        schedule(redisOperation(() => redisClient.eval(
          DELETE_IF_VALUE_MATCHES_SCRIPT,
          { keys: [key], arguments: [read.value] },
        )));
      }
    }
    const cacheDurationMs = duration(cacheStartedAt);
    const currentTime = now();

    if (cached && currentTime < cached.freshUntil) {
      return {
        value: cached.value,
        state: 'HIT',
        cacheDurationMs,
        loadTimings: [],
        totalDurationMs: duration(totalStartedAt),
        refreshScheduled: false,
        key,
      };
    }

    if (cached && currentTime < cached.staleUntil) {
      const refreshScheduled = scheduleRefresh({
        family,
        key,
        load,
        freshTtlSeconds,
        staleTtlSeconds,
        shouldCache,
      });
      return {
        value: cached.value,
        state: 'STALE',
        cacheDurationMs,
        loadTimings: [],
        totalDurationMs: duration(totalStartedAt),
        refreshScheduled,
        key,
      };
    }

    let loaded;
    if (cacheable) {
      let pending = misses.get(key);
      let isLeader = false;
      const waitStartedAt = performance.now();
      if (!pending) {
        isLeader = true;
        pending = (async () => {
          const lockKey = `${key}:miss-lock`;
          const lockToken = randomUUID();
          let ownsDistributedLock = false;
          if (cacheReadSucceeded && usableRedis()) {
            const locked = await redisOperation(() => redisClient.set(
              lockKey,
              lockToken,
              { NX: true, EX: REFRESH_LOCK_SECONDS },
            ));
            ownsDistributedLock = locked.ok && locked.value === 'OK';
            if (!ownsDistributedLock) {
              const filled = await waitForDistributedFill(key);
              if (filled !== null) {
                return {
                  value: filled,
                  timings: [{ name: 'distributed_wait', durationMs: duration(waitStartedAt) }],
                };
              }
            }
          }

          try {
            const result = await runLoader(load);
            if (cacheReadSucceeded && shouldCache(result.value)) {
              await storeEntry({
                family,
                key,
                value: result.value,
                freshTtlSeconds,
                staleTtlSeconds,
              });
            }
            return result;
          } finally {
            if (ownsDistributedLock) await releaseOwnedLock(lockKey, lockToken);
          }
        })().finally(() => misses.delete(key));
        misses.set(key, pending);
      }
      loaded = await pending;
      if (!isLeader) {
        loaded = {
          value: loaded.value,
          timings: [{ name: 'coalesced_wait', durationMs: duration(waitStartedAt) }],
        };
      }
    } else {
      loaded = await runLoader(load);
    }
    return {
      value: loaded.value,
      state: 'MISS',
      cacheDurationMs,
      loadTimings: loaded.timings,
      totalDurationMs: duration(totalStartedAt),
      refreshScheduled: false,
      key,
    };
  }

  return {
    getOrLoad,
    cacheKey,
    enabled,
  };
}

module.exports = {
  CACHE_VERSION,
  applyListCacheHeaders,
  createListCache,
  formatServerTiming,
  parseEntry,
  stableSerialize,
};
