const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../scripts/perf/load-test-lib.mjs');

test('parseStages reads concurrency:seconds lists and rejects bad input', async () => {
  const { parseStages } = await load();
  assert.deepEqual(parseStages('1:30, 4:20'), [{ concurrency: 1, seconds: 30 }, { concurrency: 4, seconds: 20 }]);
  assert.throws(() => parseStages('4'), TypeError);
  assert.throws(() => parseStages('0:10'), RangeError);
  assert.throws(() => parseStages('1:0'), RangeError);
  assert.throws(() => parseStages(''), TypeError);
});

test('guardTarget refuses production hosts unless explicitly allowed', async () => {
  const { guardTarget, PRODUCTION_KEYLESS_MAX_RPS } = await load();
  assert.equal(guardTarget({ baseUrl: 'https://api.zecblock.com' }).ok, false);
  assert.equal(guardTarget({ baseUrl: 'https://API.ZECBLOCK.COM' }).ok, false);
  assert.equal(guardTarget({ baseUrl: 'ftp://127.0.0.1' }).ok, false);
  assert.equal(guardTarget({ baseUrl: 'not a url' }).ok, false);

  const local = guardTarget({ baseUrl: 'http://127.0.0.1:3001' });
  assert.deepEqual([local.ok, local.production, local.maxRps], [true, false, null]);

  const keyless = guardTarget({ baseUrl: 'https://api.zecblock.com', allowProduction: true, maxRps: 100 });
  assert.equal(keyless.ok, true);
  assert.equal(keyless.maxRps, PRODUCTION_KEYLESS_MAX_RPS);
  assert.ok(PRODUCTION_KEYLESS_MAX_RPS * 60 < 600, 'keyless cap stays below the per-IP limit');

  const lower = guardTarget({ baseUrl: 'https://api.zecblock.com', allowProduction: true, maxRps: 2 });
  assert.equal(lower.maxRps, 2);

  const keyed = guardTarget({ baseUrl: 'https://api.zecblock.com', allowProduction: true, hasServiceKey: true, maxRps: 50 });
  assert.equal(keyed.maxRps, 50);
});

test('percentile uses nearest rank and handles empty input', async () => {
  const { percentile } = await load();
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile(values, 99), 99);
  assert.equal(percentile(values, 100), 100);
  assert.equal(percentile([7], 99), 7);
  assert.equal(percentile([], 50), null);
});

test('summarize separates failures, 429s, timeouts and cache states', async () => {
  const { summarize, shouldAbort } = await load();
  const summary = summarize([
    { endpoint: 'a', status: 200, ms: 10, bytes: 100, cache: 'HIT' },
    { endpoint: 'a', status: 200, ms: 30, bytes: 100, cache: 'MISS' },
    { endpoint: 'b', status: 429, ms: 5, bytes: 10 },
    { endpoint: 'b', status: 0, ms: 10_000, bytes: 0, error: 'timeout' },
  ], 2);
  assert.equal(summary.requests, 4);
  assert.equal(summary.rps, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.failedPct, 50);
  assert.equal(summary.rateLimited, 1);
  assert.deepEqual(summary.statuses, { 200: 2, 429: 1, timeout: 1 });
  assert.deepEqual(summary.cache, { HIT: 1, MISS: 1 });
  // Timeouts are failures but are excluded from the latency distribution.
  assert.equal(summary.latencyMs.max, 30);
  assert.equal(shouldAbort(summary, 5), true);
  assert.equal(shouldAbort(summarize([], 1), 5), false);
});

test('seeded picker and path resolution are reproducible and stay in range', async () => {
  const { createRandom, createPicker, resolvePath, DEFAULT_SCENARIO } = await load();
  const fixture = { tip: 1000, minHeight: 900, txids: ['aa', 'bb'] };
  const sequence = (seed) => {
    const random = createRandom(seed);
    const pick = createPicker(DEFAULT_SCENARIO, random);
    return Array.from({ length: 50 }, () => resolvePath(pick().path, fixture, random));
  };
  assert.deepEqual(sequence(7), sequence(7));
  for (const pathname of sequence(3)) {
    assert.ok(!pathname.includes('{'), pathname);
    const height = /^\/api\/block\/(\d+)$/.exec(pathname);
    if (height) assert.ok(Number(height[1]) >= 900 && Number(height[1]) <= 1000, pathname);
    const tx = /^\/api\/tx\/(\w+)$/.exec(pathname);
    if (tx) assert.ok(['aa', 'bb'].includes(tx[1]), pathname);
  }
  assert.throws(() => createPicker([{ name: 'x', path: '/', weight: 0 }], Math.random), RangeError);
});

test('stagesTable renders one Markdown row per stage', async () => {
  const { stagesTable, summarize } = await load();
  const table = stagesTable([{ concurrency: 2, seconds: 10, summary: summarize([{ endpoint: 'a', status: 200, ms: 12, bytes: 1 }], 10) }]);
  const lines = table.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^\| 2 \| 10 \| 1 \| 0\.1 \| 12 \| 12 \| 12 \| 12 \| 0% \| 0 \|$/);
});
