const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setImmediate: setImmediatePromise } = require('node:timers/promises');
const test = require('node:test');

const {
  CACHE_VERSION,
  applyListCacheHeaders,
  createListCache,
  formatServerTiming,
  parseEntry,
  stableSerialize,
} = require('../list-cache');

class FakeRedis {
  constructor({ now = () => Date.now() } = {}) {
    this.isReady = true;
    this.now = now;
    this.strings = new Map();
    this.sortedSets = new Map();
    this.calls = [];
    this.failures = new Map();
    this.hangs = new Set();
  }

  fail(operation, error = new Error(`${operation} failed`)) {
    this.failures.set(operation, error);
  }

  hang(operation) {
    this.hangs.add(operation);
  }

  _before(operation, args) {
    this.calls.push({ operation, args });
    if (this.hangs.has(operation)) return new Promise(() => {});
    if (this.failures.has(operation)) throw this.failures.get(operation);
    return null;
  }

  _purgeString(key) {
    const item = this.strings.get(key);
    if (item?.expiresAt !== null && item?.expiresAt <= this.now()) {
      this.strings.delete(key);
    }
  }

  async get(key) {
    const pending = this._before('get', [key]);
    if (pending) return pending;
    this._purgeString(key);
    return this.strings.get(key)?.value ?? null;
  }

  async set(key, value, options = {}) {
    const pending = this._before('set', [key, value, options]);
    if (pending) return pending;
    this._purgeString(key);
    if (options.NX && this.strings.has(key)) return null;
    const expiresAt = options.EX === undefined ? null : this.now() + options.EX * 1_000;
    this.strings.set(key, { value: String(value), expiresAt });
    return 'OK';
  }

  async del(...keys) {
    const flattened = keys.flat();
    const pending = this._before('del', flattened);
    if (pending) return pending;
    let deleted = 0;
    for (const key of flattened) {
      deleted += Number(this.strings.delete(key));
      deleted += Number(this.sortedSets.delete(key));
    }
    return deleted;
  }

  async eval(_script, { keys, arguments: args }) {
    const pending = this._before('eval', [keys, args]);
    if (pending) return pending;
    const [key] = keys;
    this._purgeString(key);
    if (this.strings.get(key)?.value !== args[0]) return 0;
    this.strings.delete(key);
    return 1;
  }

  async zAdd(key, entries) {
    const pending = this._before('zAdd', [key, entries]);
    if (pending) return pending;
    const set = this.sortedSets.get(key) || new Map();
    let added = 0;
    for (const { score, value } of entries) {
      if (!set.has(value)) added += 1;
      set.set(value, score);
    }
    this.sortedSets.set(key, set);
    return added;
  }

  async zCard(key) {
    const pending = this._before('zCard', [key]);
    if (pending) return pending;
    return this.sortedSets.get(key)?.size ?? 0;
  }

  async zRange(key, start, stop) {
    const pending = this._before('zRange', [key, start, stop]);
    if (pending) return pending;
    const members = [...(this.sortedSets.get(key) || new Map()).entries()]
      .sort(([leftValue, leftScore], [rightValue, rightScore]) => (
        leftScore - rightScore || leftValue.localeCompare(rightValue)
      ))
      .map(([value]) => value);
    const normalizedStop = stop < 0 ? members.length + stop : stop;
    return members.slice(start, normalizedStop + 1);
  }

  async zRem(key, members) {
    const pending = this._before('zRem', [key, members]);
    if (pending) return pending;
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) removed += Number(set.delete(member));
    return removed;
  }

  async expire(key, seconds) {
    const pending = this._before('expire', [key, seconds]);
    if (pending) return pending;
    return this.sortedSets.has(key) || this.strings.has(key) ? 1 : 0;
  }

  raw(key) {
    this._purgeString(key);
    return this.strings.get(key)?.value ?? null;
  }

  has(key) {
    this._purgeString(key);
    return this.strings.has(key);
  }
}

function scheduledTasks() {
  const pending = new Set();
  return {
    schedule(task) {
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    async flush() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}

function harness({
  redis,
  now = () => Date.now(),
  enabled = true,
  namespace = 'unit-test',
  maxEntries = 1_000,
  redisTimeoutMs = 50,
  logger = { warn() {} },
} = {}) {
  const tasks = scheduledTasks();
  return {
    tasks,
    cache: createListCache({
      redisClient: redis,
      enabled,
      namespace,
      maxEntries,
      redisTimeoutMs,
      now,
      logger,
      schedule: tasks.schedule,
    }),
  };
}

const request = (overrides = {}) => ({
  family: 'blocks',
  params: { page: 1, limit: 20 },
  freshTtlSeconds: 10,
  staleTtlSeconds: 60,
  load: async () => ({ height: 1 }),
  ...overrides,
});

async function waitUntil(predicate, message = 'condition was not met') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await setImmediatePromise();
  }
  assert.fail(message);
}

test('stableSerialize and cacheKey are deterministic and reject non-JSON values', () => {
  const left = { z: [3, { b: true, a: null }], a: 'value' };
  const right = { a: 'value', z: [3, { a: null, b: true }] };
  assert.equal(stableSerialize(left), stableSerialize(right));
  assert.notEqual(stableSerialize([1, 2]), stableSerialize([2, 1]));
  assert.throws(() => stableSerialize({ value: Number.NaN }), /finite numbers/);
  assert.throws(() => stableSerialize({ value: Number.POSITIVE_INFINITY }), /finite numbers/);
  assert.throws(() => stableSerialize({ value: undefined }), /JSON primitives/);

  const { cache } = harness({ enabled: false, namespace: 'main net/1' });
  const serialized = stableSerialize(left);
  const digest = createHash('sha256').update(serialized).digest('hex');
  assert.equal(
    cache.cacheKey('rich list!', left),
    `cipherscan:list:v${CACHE_VERSION}:main_net_1:rich_list_:${digest}`,
  );
  assert.equal(cache.cacheKey('rich list!', left), cache.cacheKey('rich list!', right));
  assert.notEqual(cache.cacheKey('blocks', left), cache.cacheKey('txs', left));
});

test('first request is a MISS, stores a bounded entry, and the next request is a HIT', async () => {
  let clock = 1_000_000;
  const redis = new FakeRedis({ now: () => clock });
  const { cache, tasks } = harness({ redis, now: () => clock });
  let loads = 0;
  const options = request({
    load: async () => {
      loads += 1;
      return { height: 42 };
    },
  });

  const miss = await cache.getOrLoad(options);
  const hit = await cache.getOrLoad(options);
  await tasks.flush();

  assert.equal(miss.state, 'MISS');
  assert.deepEqual(miss.value, { height: 42 });
  assert.equal(hit.state, 'HIT');
  assert.deepEqual(hit.value, { height: 42 });
  assert.equal(loads, 1);
  assert.deepEqual(hit.loadTimings, []);

  const entry = parseEntry(redis.raw(miss.key));
  assert.deepEqual(entry, {
    version: CACHE_VERSION,
    storedAt: clock,
    freshUntil: clock + 10_000,
    staleUntil: clock + 60_000,
    value: { height: 42 },
  });
  assert.equal(redis.strings.get(miss.key).expiresAt, clock + 60_000);
});

test('concurrent first misses share one in-process load and one cache write', async () => {
  const redis = new FakeRedis();
  const { cache, tasks } = harness({ redis });
  let releaseLoad;
  let loads = 0;
  const options = request({
    load: async () => {
      loads += 1;
      return new Promise((resolve) => { releaseLoad = resolve; });
    },
  });

  const requests = [cache.getOrLoad(options), cache.getOrLoad(options), cache.getOrLoad(options)];
  await waitUntil(() => loads === 1 && typeof releaseLoad === 'function');
  releaseLoad({ height: 42 });
  const results = await Promise.all(requests);
  await tasks.flush();

  assert.equal(loads, 1);
  assert.deepEqual(results.map(({ state }) => state), ['MISS', 'MISS', 'MISS']);
  assert.ok(results.every(({ value }) => value.height === 42));
  assert.deepEqual(
    results.map(({ loadTimings }) => loadTimings[0].name).sort(),
    ['coalesced_wait', 'coalesced_wait', 'db'],
  );
  const cacheWrites = redis.calls.filter(({ operation, args }) => (
    operation === 'set' && !String(args[0]).endsWith('-lock')
  ));
  assert.equal(cacheWrites.length, 1);
});

test('a Redis miss lock coalesces first loads across cache instances', async () => {
  const redis = new FakeRedis();
  const firstHarness = harness({ redis });
  const secondHarness = harness({ redis });
  let releaseLoad;
  let loads = 0;
  const options = request({
    load: async () => {
      loads += 1;
      return new Promise((resolve) => { releaseLoad = resolve; });
    },
  });

  const first = firstHarness.cache.getOrLoad(options);
  await waitUntil(() => loads === 1 && typeof releaseLoad === 'function');
  const second = secondHarness.cache.getOrLoad(options);
  releaseLoad({ height: 42 });
  const [left, right] = await Promise.all([first, second]);

  assert.equal(loads, 1);
  assert.equal(left.value.height, 42);
  assert.equal(right.value.height, 42);
  assert.equal(right.loadTimings[0].name, 'distributed_wait');
});

test('stale values return without waiting and concurrent callers share one local refresh', async () => {
  let clock = 2_000_000;
  const redis = new FakeRedis({ now: () => clock });
  const { cache, tasks } = harness({ redis, now: () => clock });
  let resolveRefresh;
  let loads = 0;
  const options = request({
    load: async () => {
      loads += 1;
      if (loads === 1) return { height: 1 };
      return new Promise((resolve) => { resolveRefresh = resolve; });
    },
  });

  await cache.getOrLoad(options);
  clock += 11_000;
  const [first, second] = await Promise.all([
    cache.getOrLoad(options),
    cache.getOrLoad(options),
  ]);

  assert.equal(first.state, 'STALE');
  assert.equal(second.state, 'STALE');
  assert.deepEqual(first.value, { height: 1 });
  assert.deepEqual(second.value, { height: 1 });
  assert.deepEqual([first.refreshScheduled, second.refreshScheduled].sort(), [false, true]);
  await waitUntil(() => loads === 2 && typeof resolveRefresh === 'function', 'refresh did not start');

  resolveRefresh({ height: 2 });
  await tasks.flush();
  const refreshed = await cache.getOrLoad(options);
  assert.equal(refreshed.state, 'HIT');
  assert.deepEqual(refreshed.value, { height: 2 });
  assert.equal(loads, 2);
});

test('a Redis refresh lock coalesces stale refreshes across cache instances', async () => {
  let clock = 3_000_000;
  const redis = new FakeRedis({ now: () => clock });
  const firstHarness = harness({ redis, now: () => clock });
  const secondHarness = harness({ redis, now: () => clock });
  await firstHarness.cache.getOrLoad(request({ load: async () => 'old' }));
  clock += 11_000;

  let refreshLoads = 0;
  const staleRequest = request({
    load: async () => {
      refreshLoads += 1;
      return 'new';
    },
  });
  const [left, right] = await Promise.all([
    firstHarness.cache.getOrLoad(staleRequest),
    secondHarness.cache.getOrLoad(staleRequest),
  ]);
  await Promise.all([firstHarness.tasks.flush(), secondHarness.tasks.flush()]);

  assert.equal(left.state, 'STALE');
  assert.equal(right.state, 'STALE');
  assert.equal(refreshLoads, 1);
  const final = await firstHarness.cache.getOrLoad(staleRequest);
  assert.equal(final.state, 'HIT');
  assert.equal(final.value, 'new');
});

test('a failed refresh preserves stale data and the lock provides retry backoff', async () => {
  let clock = 4_000_000;
  const redis = new FakeRedis({ now: () => clock });
  const warnings = [];
  const { cache, tasks } = harness({
    redis,
    now: () => clock,
    logger: { warn(message) { warnings.push(message); } },
  });
  let loads = 0;
  const options = request({
    freshTtlSeconds: 1,
    staleTtlSeconds: 120,
    load: async () => {
      loads += 1;
      if (loads === 1) return 'last-known-good';
      if (loads === 2) throw new Error('database unavailable');
      return 'recovered';
    },
  });

  const initial = await cache.getOrLoad(options);
  clock += 2_000;
  const stale = await cache.getOrLoad(options);
  await tasks.flush();
  assert.equal(stale.state, 'STALE');
  assert.equal(stale.value, 'last-known-good');
  assert.match(warnings[0], /database unavailable/);
  assert.equal(parseEntry(redis.raw(initial.key)).value, 'last-known-good');
  assert.equal(redis.has(`${initial.key}:refresh-lock`), true);

  await cache.getOrLoad(options);
  await tasks.flush();
  assert.equal(loads, 2, 'the unexpired failure lock should prevent another refresh');

  clock += 31_000;
  await cache.getOrLoad(options);
  await tasks.flush();
  assert.equal(loads, 3);
  assert.equal(parseEntry(redis.raw(initial.key)).value, 'recovered');
  assert.equal(redis.has(`${initial.key}:refresh-lock`), false);
});

test('disabled, unavailable, failed, and timed-out Redis all fail open', async (t) => {
  await t.test('disabled cache never touches Redis', async () => {
    const redis = new FakeRedis();
    redis.fail('get');
    const { cache } = harness({ redis, enabled: false });
    const result = await cache.getOrLoad(request({ load: async () => 'live' }));
    assert.equal(result.state, 'MISS');
    assert.equal(result.value, 'live');
    assert.equal(redis.calls.length, 0);
  });

  await t.test('unready Redis is bypassed', async () => {
    const redis = new FakeRedis();
    redis.isReady = false;
    const { cache } = harness({ redis });
    const result = await cache.getOrLoad(request({ load: async () => 'live' }));
    assert.equal(result.state, 'MISS');
    assert.equal(result.value, 'live');
    assert.equal(redis.calls.length, 0);
  });

  await t.test('read error does not block the loader or attempt a write', async () => {
    const redis = new FakeRedis();
    redis.fail('get');
    const { cache } = harness({ redis });
    const result = await cache.getOrLoad(request({ load: async () => 'live' }));
    assert.equal(result.state, 'MISS');
    assert.equal(result.value, 'live');
    assert.deepEqual(redis.calls.map(({ operation }) => operation), ['get']);
  });

  await t.test('read errors still coalesce same-key database loads', async () => {
    const redis = new FakeRedis();
    redis.fail('get');
    const { cache } = harness({ redis });
    let releaseLoad;
    let loads = 0;
    const options = request({
      load: async () => {
        loads += 1;
        return new Promise((resolve) => { releaseLoad = resolve; });
      },
    });
    const requests = [cache.getOrLoad(options), cache.getOrLoad(options), cache.getOrLoad(options)];
    await waitUntil(() => loads === 1 && typeof releaseLoad === 'function');
    releaseLoad('live');
    const results = await Promise.all(requests);
    assert.equal(loads, 1);
    assert.ok(results.every(({ value }) => value === 'live'));
    assert.equal(redis.calls.filter(({ operation }) => operation === 'get').length, 3);
    assert.equal(redis.calls.filter(({ operation }) => operation === 'set').length, 0);
  });

  await t.test('read timeout is bounded and does not block the loader', async () => {
    const redis = new FakeRedis();
    redis.hang('get');
    const { cache } = harness({ redis, redisTimeoutMs: 5 });
    const startedAt = Date.now();
    const result = await cache.getOrLoad(request({ load: async () => 'live' }));
    assert.equal(result.state, 'MISS');
    assert.equal(result.value, 'live');
    assert.ok(Date.now() - startedAt < 250, 'Redis timeout should remain tightly bounded');
  });
});

test('a cache write failure returns live data and leaves the next request as a MISS', async () => {
  const redis = new FakeRedis();
  redis.fail('set');
  const { cache } = harness({ redis });
  let loads = 0;
  const options = request({ load: async () => ++loads });
  const first = await cache.getOrLoad(options);
  const second = await cache.getOrLoad(options);
  assert.equal(first.state, 'MISS');
  assert.equal(second.state, 'MISS');
  assert.equal(second.value, 2);
});

test('malformed entries are discarded and replaced by a successful load', async () => {
  const redis = new FakeRedis();
  const { cache, tasks } = harness({ redis });
  const options = request({ load: async () => 'replacement' });
  const key = cache.cacheKey(options.family, options.params);
  await redis.set(key, '{not-json', { EX: 60 });

  const result = await cache.getOrLoad(options);
  await tasks.flush();

  assert.equal(result.state, 'MISS');
  assert.equal(result.value, 'replacement');
  assert.equal(parseEntry(redis.raw(key)).value, 'replacement');
  assert.ok(redis.calls.some(({ operation }) => operation === 'eval'));
});

test('expired stale entries reload synchronously and shouldCache can suppress storage', async () => {
  let clock = 5_000_000;
  const redis = new FakeRedis({ now: () => clock });
  const { cache } = harness({ redis, now: () => clock });
  let loads = 0;
  const options = request({
    freshTtlSeconds: 1,
    staleTtlSeconds: 2,
    load: async () => ++loads,
  });
  await cache.getOrLoad(options);
  clock += 2_001;
  const expired = await cache.getOrLoad(options);
  assert.equal(expired.state, 'MISS');
  assert.equal(expired.value, 2);

  const uncached = request({
    family: 'empty',
    shouldCache: () => false,
    load: async () => null,
  });
  const first = await cache.getOrLoad(uncached);
  const second = await cache.getOrLoad(uncached);
  assert.equal(first.state, 'MISS');
  assert.equal(second.state, 'MISS');
});

test('load timings and response headers expose cache state and measured phases', async () => {
  const { cache } = harness({ enabled: false });
  const result = await cache.getOrLoad(request({
    load: async ({ measure }) => measure('postgres query', async () => 'rows'),
  }));
  assert.equal(result.loadTimings.length, 1);
  assert.equal(result.loadTimings[0].name, 'postgres_query');

  const sample = {
    ...result,
    state: 'STALE',
    cacheDurationMs: 1.24,
    loadTimings: [{ name: 'database read', durationMs: 2.26 }],
    totalDurationMs: 3.55,
    refreshScheduled: true,
  };
  assert.equal(
    formatServerTiming(sample),
    'cache;desc="STALE";dur=1.2, database_read;dur=2.3, total;dur=3.5, refresh;desc="scheduled";dur=0',
  );
  const headers = new Map();
  applyListCacheHeaders({ set(name, value) { headers.set(name, value); } }, sample);
  assert.equal(headers.get('X-CipherScan-Cache'), 'STALE');
  assert.equal(headers.get('X-ZecBlock-Cache'), 'STALE');
  assert.equal(headers.get('Server-Timing'), formatServerTiming(sample));
});

test('entry limit evicts the oldest keys within a route family', async () => {
  let clock = 6_000_000;
  const redis = new FakeRedis({ now: () => clock });
  const { cache, tasks } = harness({ redis, now: () => clock, maxEntries: 2 });
  const keys = [];

  for (let page = 1; page <= 3; page += 1) {
    const result = await cache.getOrLoad(request({
      params: { page },
      load: async () => `page-${page}`,
    }));
    keys.push(result.key);
    await tasks.flush();
    clock += 1;
  }

  assert.equal(redis.has(keys[0]), false);
  assert.equal(redis.has(keys[1]), true);
  assert.equal(redis.has(keys[2]), true);
});

test('getOrLoad validates its contract', async () => {
  const { cache } = harness({ enabled: false });
  await assert.rejects(cache.getOrLoad(request({ family: '' })), /family is required/);
  await assert.rejects(cache.getOrLoad(request({ load: null })), /load callback is required/);
  await assert.rejects(cache.getOrLoad(request({ freshTtlSeconds: 0 })), /fresh TTL/);
  await assert.rejects(cache.getOrLoad(request({
    freshTtlSeconds: 10,
    staleTtlSeconds: 10,
  })), /stale TTL/);
});
