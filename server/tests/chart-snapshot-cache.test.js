const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('next/dist/server/node-environment');
const { unstable_cache } = require('next/cache');
const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external');
const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external');

function load(file, dependencies = {}, globals = {}) {
  const filename = path.resolve(file);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, URL, URLSearchParams, Request, Response, Error, DOMException, TextDecoder, setTimeout, clearTimeout, Date,
    require: name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name === 'server-only') return {};
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name + '.ts'), dependencies, globals);
      return require(name);
    },
    ...globals,
  });
  return exports;
}

const chart = { id: 'network-hashrate', rows: 'points', x: 'date', series: [{ key: 'hashrate', scale: 1e-9 }] };
const generatedAt = Date.parse('2026-10-27T12:00:00.000Z');
function response({ network = 'mainnet', data = { points: [{ date: '2026-10-27', hashrate: 12e9 }] }, status = 200, timestamp = generatedAt, freshness = { status: 'fresh', ageSeconds: 0 } } = {}) {
  return Response.json({ data, meta: { requestId: 'test', network, generatedAt: new Date(timestamp).toISOString(), freshness } }, { status });
}

function harness(t) {
  let clock = generatedAt;
  let network = 'mainnet';
  let apiUrl = 'https://api.example.test';
  let origin = async () => response();
  const requests = [];
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const afterTasks = [];
  const entries = new Map();
  const stores = [];
  const incrementalCache = {
    generateSimpleCacheKey: async key => key,
    async get(key) {
      const entry = entries.get(key);
      return entry ? { value: entry.value, isStale: clock - entry.savedAt > entry.value.revalidate * 1000 } : null;
    },
    async set(key, value) { entries.set(key, { value, savedAt: clock }); },
  };
  const server = load('lib/chart-share-server.ts', {
    react: { cache: fn => fn },
    'next/cache': { unstable_cache },
    'next/server': { after: callback => afterTasks.push(callback) },
    './bounded-json': require('../../lib/bounded-json'),
    './seo': { getNetwork: () => network, getApiUrl: () => apiUrl },
    './chart-sharing': { chartEndpoint: () => '/v1/mining/hashrate-history?period=all' },
    './server-fetch': { fetchWithDeadline: async (url, init, timeoutMs) => {
      requests.push({ url, init, timeoutMs });
      return origin();
    } },
  }, { Date: class extends Date { static now() { return clock; } }, console: { error: (...args) => errors.push(args) } });
  const run = async callback => {
    const store = { route: '/charts/network-hashrate', incrementalCache, isStaticGeneration: false, pendingRevalidates: {} };
    stores.push(store);
    return workAsyncStorage.run(store, () => workUnitAsyncStorage.run({ type: 'request', url: { pathname: store.route, search: '' } }, callback));
  };
  return {
    ...server, requests, errors, entries, afterTasks, run,
    setOrigin: value => { origin = value; },
    advance: ms => { clock += ms; },
    setNetwork: value => { network = value; },
    setApiUrl: value => { apiUrl = value; },
    settle: async () => {
      await Promise.all(afterTasks.splice(0).map(callback => callback()));
      for (const store of stores) await Promise.all(Object.values(store.pendingRevalidates));
    },
  };
}

test('cold chart pages return inside their short budget while after() retains and fills the durable cache', async t => {
  const api = harness(t);
  let release;
  api.setOrigin(() => new Promise(resolve => { release = resolve; }));
  const started = performance.now();
  const missing = await api.run(() => api.loadShareChart(chart, 15));
  assert.equal(missing, null);
  assert.ok(performance.now() - started < 250);
  assert.equal(api.afterTasks.length, 1, 'serverless work must be retained after the response');
  assert.equal(api.requests[0].timeoutMs, 10_000);
  assert.equal(api.requests[0].init.cache, 'no-store', 'the validated snapshot owns the cache');
  release(response());
  await api.settle();
  const loaded = await api.run(() => api.loadShareChart(chart));
  assert.equal(loaded.rows[0].hashrate, 12);
  assert.equal(loaded.fetchedAt, generatedAt);
  assert.equal(api.requests.length, 1, 'the next request must reuse the populated cache');
  const cached = JSON.parse([...api.entries.values()][0].value.data.body);
  assert.equal(cached.rows, undefined, 'do not duplicate all-history rows in the cache');
  assert.equal(api.errors.length, 0, 'expected foreground deferral is not an origin failure');
});

test('concurrent cold page and social-image reads coalesce the upstream refresh', async t => {
  const api = harness(t);
  let release;
  api.setOrigin(() => new Promise(resolve => { release = resolve; }));
  const page = api.run(() => api.loadShareChart(chart, 5));
  const image = api.run(() => api.loadShareChart(chart, 10_000));
  await page;
  assert.equal(api.requests.length, 1);
  release(response());
  assert.equal((await image).rows[0].hashrate, 12);
  await api.settle();
});

test('actual Next stale-while-revalidate preserves valid observations and their timestamp when refresh fails', async t => {
  const api = harness(t);
  const first = await api.run(() => api.loadShareChart(chart));
  await api.settle();
  api.advance(301_000);
  api.setOrigin(async () => { throw new Error('Origin unavailable'); });
  const stale = await api.run(() => api.loadShareChart(chart));
  assert.deepEqual(stale, first);
  await api.settle();
  assert.equal((await api.run(() => api.loadShareChart(chart))).fetchedAt, generatedAt);
  assert.match(api.delayedChartSnapshotLabel(stale.fetchedAt), /2026-10-27 12:00:00 UTC.*refresh delayed/);
  assert.equal(api.delayedChartSnapshotLabel(generatedAt, undefined, generatedAt + 300_000), undefined);
  await api.settle();
});

test('invalid observations, network mismatches and HTTP failures cannot replace last-good snapshots', async t => {
  const api = harness(t);
  await api.run(() => api.loadShareChart(chart));
  await api.settle();
  for (const bad of [
    () => response({ data: { points: [] } }),
    () => response({ network: 'testnet' }),
    () => response({ status: 503 }),
    () => response({ freshness: { status: 'unavailable', ageSeconds: null } }),
  ]) {
    api.advance(301_000);
    api.setOrigin(async () => bad());
    const stale = await api.run(() => api.loadShareChart(chart));
    assert.equal(stale.rows[0].hashrate, 12);
    await api.settle();
    assert.equal(JSON.parse([...api.entries.values()][0].value.data.body).fetchedAt, generatedAt);
  }
});

test('a successful background refresh replaces the snapshot only after validation completes', async t => {
  const api = harness(t);
  await api.run(() => api.loadShareChart(chart));
  await api.settle();
  api.advance(301_000);
  api.setOrigin(async () => response({ timestamp: generatedAt + 301_000, data: { points: [{ date: '2026-10-27', hashrate: 13e9 }] } }));
  const stale = await api.run(() => api.loadShareChart(chart));
  assert.equal(stale.rows[0].hashrate, 12);
  await api.settle();
  const refreshed = await api.run(() => api.loadShareChart(chart));
  assert.equal(refreshed.rows[0].hashrate, 13);
  assert.equal(refreshed.fetchedAt, generatedAt + 301_000);
  assert.equal(api.requests.length, 2);
});

test('upstream problem-detail text cannot leak into cold or Next background refresh logs', async t => {
  const api = harness(t);
  api.setOrigin(async () => Response.json({ detail: 'upstream-private-detail-'.repeat(500) }, { status: 503 }));
  assert.equal(await api.run(() => api.loadShareChart(chart)), null);
  assert.match(String(api.errors.at(-1)), /HTTP 503/);
  api.setOrigin(async () => response());
  await api.run(() => api.loadShareChart(chart));
  await api.settle();
  api.advance(301_000);
  api.setOrigin(async () => Response.json({ detail: 'upstream-private-detail-'.repeat(500) }, { status: 503 }));
  await api.run(() => api.loadShareChart(chart));
  await api.settle();
  assert.ok(api.errors.every(args => !String(args).includes('upstream-private-detail')));
});

test('snapshot caches are isolated by network and API origin', async t => {
  const api = harness(t);
  await api.run(() => api.loadShareChart(chart));
  await api.settle();
  api.setNetwork('testnet');
  api.setOrigin(async () => response({ network: 'testnet' }));
  assert.equal((await api.run(() => api.loadShareChart(chart))).meta.network, 'testnet');
  await api.settle();
  api.setApiUrl('https://another-api.example.test');
  await api.run(() => api.loadShareChart(chart));
  await api.settle();
  assert.equal(api.requests.length, 3);
  assert.equal(api.entries.size, 3);
});

test('the ten-second refresh budget includes body reading and bounds decoded response bytes', async t => {
  const api = harness(t);
  let cancelled = false;
  api.setOrigin(async () => {
    api.advance(9_990);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  const started = performance.now();
  assert.equal(await api.run(() => api.loadShareChart(chart)), null);
  assert.ok(performance.now() - started < 250, 'header time must be subtracted from the body budget');
  assert.equal(cancelled, true);
  assert.equal(api.entries.size, 0);
  api.setOrigin(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  assert.equal(await api.run(() => api.loadShareChart(chart)), null);
  assert.equal(api.entries.size, 0);
  assert.ok(api.errors.some(args => String(args).includes('byte limit')));
});

test('measured zero observations remain valid cached data', async t => {
  const api = harness(t);
  api.setOrigin(async () => response({ data: { points: [{ date: '2026-10-27', hashrate: 0 }] } }));
  const snapshot = await api.run(() => api.loadShareChart(chart));
  assert.equal(snapshot.rows[0].hashrate, 0);
  await api.settle();
  assert.equal(api.entries.size, 1);
});

test('explicit source staleness remains visible even when the API envelope was generated recently', async t => {
  const api = harness(t);
  api.setOrigin(async () => response({ freshness: { status: 'stale', ageSeconds: 600 } }));
  const snapshot = await api.run(() => api.loadShareChart(chart));
  assert.match(api.delayedChartSnapshotLabel(snapshot.fetchedAt, snapshot.meta.freshness), /refresh delayed/);
  await api.settle();
});

test('the initial delayed-snapshot notice clears after a successful browser refresh and survives a failed refresh', () => {
  const catalog = load('lib/chart-catalog.ts');
  const sharing = load('lib/chart-sharing.ts');
  const snapshot = { points: [{ date: '2026-10-27', hashrate: 12e9 }] };
  let data = snapshot;
  let error = null;
  const component = load('app/charts/ChartsClient.tsx', {
    react: { useEffect: () => {}, useMemo: callback => callback(), useRef: current => ({ current }), useState: value => [value, () => {}] },
    'next/link': { default: () => null }, recharts: {},
    '@/lib/chart-catalog': catalog,
    '@/lib/chart-sharing': sharing,
    '@/lib/pool-display': { poolDateAxis: () => ({ ticks: [], format: String }) },
    '@/lib/chart-theme': { getChartColors: () => ({}) },
    '@/contexts/ThemeContext': { useTheme: () => ({ theme: 'dark' }) },
    '@/hooks/useApiQuery': { useApiQuery: () => ({ data, error, loading: false }) },
    '@/components/charts/ChartTooltip': {}, '@/components/ShareableCard': {},
    '@/lib/api-config': { NETWORK: 'mainnet' }, '@/components/ui/Skeleton': {},
  });
  const props = { chart: catalog.CHART_CATALOG.find(chart => chart.id === 'network-hashrate'), initialData: snapshot, initialSnapshotNotice: 'API snapshot delayed', standalone: true };
  const text = element => {
    if (element == null || typeof element === 'boolean') return '';
    if (typeof element !== 'object') return String(element);
    if (Array.isArray(element)) return element.map(text).join(' ');
    return text(element.props?.children);
  };
  assert.match(text(component.CatalogCard(props)), /API snapshot delayed/);
  error = 'Request timed out';
  assert.match(text(component.CatalogCard(props)), /API snapshot delayed/);
  data = { points: [{ date: '2026-10-27', hashrate: 13e9 }] };
  error = null;
  assert.doesNotMatch(text(component.CatalogCard(props)), /API snapshot delayed/);
});
