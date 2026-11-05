const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { readBoundedJson } = require('../../lib/bounded-json');

function load(file, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    module, module.exports, ...Object.values(globals),
  );
  return module.exports;
}

const model = load('lib/zec-btc.ts');
const cache = load('lib/refresh-cache.ts');
const source = load('lib/zec-btc-source.ts', {
  'server-only': {}, './zec-btc': model, './refresh-cache': cache, './bounded-json': { readBoundedJson },
}, { process: { env: {} } });
const DAY = model.ZEC_BTC_DAY_MS;
const midnight = Date.parse('2026-10-27T00:00:00Z');
const now = midnight + 12 * 3_600_000;
const quotePayload = time => ({ zcash: { btc: 0.01626741, last_updated_at: Math.floor(time / 1000) } });
const historyPayload = () => ({ prices: Array.from({ length: 366 }, (_, i) => [midnight - (365 - i) * DAY, 0.01 + i * 0.00001]) });

test('the percentage quote is distinct from signed performance and missing endpoints', () => {
  assert.equal(model.btcPercentage(0.01626741), 1.626741);
  for (const value of [0, -1, NaN, Infinity, null, undefined]) assert.equal(model.btcPercentage(value), null);
  assert.equal(model.periodChange([{ timestamp: 0, btcPerZec: 0.01 }, { timestamp: DAY, btcPerZec: 0.02 }]), 100);
  assert.equal(model.periodChange([{ timestamp: 0, btcPerZec: 0.02 }, { timestamp: DAY, btcPerZec: 0.01 }]), -50);
  assert.equal(model.periodChange([{ timestamp: 0, btcPerZec: null }, { timestamp: DAY, btcPerZec: 0.01 }]), null);
  for (const timestamp of [0, -DAY, NaN, Infinity]) {
    assert.equal(model.periodChange([{ timestamp: 0, btcPerZec: 0.01 }, { timestamp, btcPerZec: 0.02 }]), null);
  }
  assert.equal(model.periodChange([]), null);
});

test('quote validation preserves unknown observation time without fabricating one', () => {
  assert.deepEqual(source.parseZecBtcQuote(quotePayload(now), now), { btcPerZec: 0.01626741, observedAt: now, fetchedAt: now });
  for (const value of [undefined, null, '123', NaN, Infinity, 0, -1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(source.parseZecBtcQuote({ zcash: { btc: 0.01, last_updated_at: value } }, now).observedAt, null);
  }
  for (const payload of [{}, { zcash: { btc: '0.01' } }, { zcash: { btc: 0 } }, { zcash: { btc: Infinity } }, { zcash: { btc: Number.MAX_VALUE } }]) {
    assert.throws(() => source.parseZecBtcQuote(payload, now), /Invalid/);
  }
});

test('daily normalization excludes partial, future and out-of-coverage prices and preserves invalid gaps', () => {
  const payload = { prices: [
    [midnight - 2 * DAY, 0.01], [midnight - DAY, 0.02], [midnight, 0.03],
    [midnight - DAY, 0.02], [now - 1_000, 0.9], [midnight + DAY, 0.9],
    [midnight - 366 * DAY, 0.9], [midnight - 3 * DAY, -1],
    [midnight - 4 * DAY, '0.9'], [midnight - 5 * DAY, 0.5], [midnight - 5 * DAY, 0.6],
  ] };
  const normalized = source.parseZecBtcHistory(payload, now);
  assert.deepEqual(normalized.points, [
    { timestamp: midnight - 5 * DAY, btcPerZec: null },
    { timestamp: midnight - 4 * DAY, btcPerZec: null },
    { timestamp: midnight - 3 * DAY, btcPerZec: null },
    { timestamp: midnight - 2 * DAY, btcPerZec: 0.01 },
    { timestamp: midnight - DAY, btcPerZec: 0.02 },
    { timestamp: midnight, btcPerZec: 0.03 },
  ]);
  for (const payload of [{}, { prices: [] }, { prices: [[now, 0.2]] }, { prices: [[midnight, Number.MAX_VALUE]] }, { prices: Array(1_001).fill([midnight, 0.01]) }]) {
    assert.throws(() => source.parseZecBtcHistory(payload, now));
  }
});

test('calendar windows contain elapsed days plus the baseline and fill gaps with null', () => {
  const history = source.parseZecBtcHistory(historyPayload(), now);
  for (const [period, days] of [['7d', 7], ['30d', 30], ['90d', 90], ['1y', 365]]) {
    const snapshot = model.buildZecBtcSnapshot(period, null, history, now);
    assert.equal(snapshot.history.points.length, days + 1);
    assert.equal(snapshot.history.startAt, midnight - days * DAY);
    assert.equal(snapshot.history.endAt, midnight);
    assert.equal(snapshot.history.observedAt, midnight);
    assert.equal(snapshot.history.delayed, false);
  }
  const missing = { ...history, points: history.points.filter(point => point.timestamp !== midnight - 3 * DAY) };
  const snapshot = model.buildZecBtcSnapshot('7d', null, missing, now);
  assert.equal(snapshot.history.points[4].btcPerZec, null);
  assert.equal(snapshot.history.points.length, 8);
  assert.equal(snapshot.quote, null, 'daily prices never manufacture a spot quote');
  assert.equal(model.buildZecBtcSnapshot('7d', null, { points: [{ timestamp: midnight - 20 * DAY, btcPerZec: 1 }], fetchedAt: now }, now).history, null);
});

test('daily freshness honors the UTC provider release window and does not carry missing samples forward', () => {
  const history = { points: [{ timestamp: midnight - DAY, btcPerZec: 0.01 }], fetchedAt: midnight + 599_999 };
  const early = model.buildZecBtcSnapshot('7d', null, history, midnight + 599_999);
  assert.equal(early.history.endAt, midnight - DAY);
  assert.equal(early.history.delayed, false);
  const afterRelease = model.buildZecBtcSnapshot('7d', null, { ...history, fetchedAt: midnight + 600_000 }, midnight + 600_000);
  assert.equal(afterRelease.history.endAt, midnight);
  assert.equal(afterRelease.history.observedAt, midnight - DAY);
  assert.equal(afterRelease.history.points.at(-1).btcPerZec, null);
  assert.equal(afterRelease.history.delayed, true);
});

test('quote and history freshness age their original fetch and provider timestamps independently', () => {
  const quote = source.parseZecBtcQuote(quotePayload(now), now);
  assert.equal(model.buildZecBtcSnapshot('7d', quote, null, now).quote.delayed, false);
  for (const changed of [
    { observedAt: null }, { observedAt: now - 300_001 }, { observedAt: now + 60_001 },
    { fetchedAt: now - 60_001 }, { fetchedAt: now + 60_001 },
  ]) {
    assert.equal(model.buildZecBtcSnapshot('7d', { ...quote, ...changed }, null, now).quote.delayed, true);
  }
  const history = source.parseZecBtcHistory(historyPayload(), now - 300_001);
  assert.equal(model.buildZecBtcSnapshot('7d', quote, history, now).history.delayed, true);
});

test('source coalesces callers across periods, retains last good timestamps, and backs off failed refreshes', async () => {
  let time = now;
  let fail = false;
  const calls = [];
  const get = source.createZecBtcSource({ now: () => time, fetch: async (url, options) => {
    calls.push({ url, options });
    if (fail) throw new Error('provider failure with private details');
    return Response.json(url.includes('simple/price') ? quotePayload(time) : historyPayload());
  } });
  const first = await Promise.all([get('7d'), get('30d'), get('90d')]);
  assert.equal(calls.length, 2);
  assert.deepEqual(first.map(snapshot => snapshot.history.points.length), [8, 31, 91]);
  for (const { options } of calls) {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
  fail = true;
  time += 60_001;
  const retained = await get('30d');
  assert.equal(calls.length, 3);
  assert.equal(retained.quote.observedAt, now);
  assert.equal(retained.quote.fetchedAt, now);
  assert.equal(retained.quote.delayed, true);
  assert.equal(retained.history.fetchedAt, now);
  assert.equal(retained.history.delayed, false);
  time += 1;
  await get('7d');
  assert.equal(calls.length, 3);
  time = now + 300_001;
  const stale = await get('1y');
  assert.equal(stale.history.fetchedAt, now);
  assert.equal(stale.history.delayed, true);
  assert.equal(stale.quote.delayed, true);
});

test('source failures are independent, initial outages retry with backoff, and oversized JSON is rejected', async () => {
  let time = now;
  let calls = 0;
  const failed = source.createZecBtcSource({ now: () => time, fetch: async () => { calls++; throw new Error('unavailable'); } });
  assert.deepEqual(await failed('30d'), { period: '30d', source: 'CoinGecko', quote: null, history: null });
  await failed('7d');
  assert.equal(calls, 2);
  time += 30_000;
  await failed('7d');
  assert.equal(calls, 4);
  for (const failQuote of [true, false]) {
    const partial = source.createZecBtcSource({ now: () => now, fetch: async url => {
      const isQuote = url.includes('simple/price');
      if (isQuote === failQuote) return new Response('rate limited', { status: 429 });
      return Response.json(isQuote ? quotePayload(now) : historyPayload());
    } });
    const snapshot = await partial('30d');
    assert.equal(snapshot.quote === null, failQuote);
    assert.equal(snapshot.history === null, !failQuote);
  }
  const oversized = source.createZecBtcSource({ now: () => now, fetch: async () => Response.json({ padding: 'x'.repeat(300_000) }) });
  const snapshot = await oversized('30d');
  assert.equal(snapshot.quote, null);
  assert.equal(snapshot.history, null);
});

test('provider credentials use only fixed origins and headers and never enter returned data', async () => {
  for (const options of [{ demoApiKey: 'private-demo' }, { proApiKey: 'private-pro', demoApiKey: 'private-demo' }]) {
    const calls = [];
    const get = source.createZecBtcSource({ ...options, now: () => now, fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json(url.includes('simple/price') ? quotePayload(now) : historyPayload());
    } });
    const snapshot = await get('30d');
    for (const call of calls) {
      assert.equal(new URL(call.url).origin, options.proApiKey ? 'https://pro-api.coingecko.com' : 'https://api.coingecko.com');
      assert.equal(call.init.headers[options.proApiKey ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'], options.proApiKey || options.demoApiKey);
      assert.doesNotMatch(call.url, /private-/);
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /private-/);
  }
});

test('quote-only callers do not request history and share the full chart quote cache and refresh', async () => {
  let time = now;
  const calls = [];
  const get = source.createZecBtcSource({ now: () => time, fetch: async url => {
    calls.push(url);
    return Response.json(url.includes('simple/price') ? quotePayload(time) : historyPayload());
  } });
  const compact = await get('30d', false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /simple\/price/);
  assert.equal(compact.history, null);
  assert.equal(compact.quote.delayed, false);
  const full = await get('7d');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /market_chart/);
  assert.deepEqual(full.quote, compact.quote);
  time += 60_001;
  const [freshCompact, freshFull] = await Promise.all([get('30d', false), get('1y')]);
  assert.equal(calls.length, 3, 'one shared quote refresh, cached history');
  assert.equal(freshCompact.history, null);
  assert.equal(freshFull.history.points.length, 366);
  assert.deepEqual(freshFull.quote, freshCompact.quote);
  assert.equal(freshCompact.quote.fetchedAt, time);
});

test('the exported compact loader returns only source and quote using the same singleton as the full chart', async () => {
  const calls = [];
  const Clock = class extends Date { static now() { return now; } };
  const loaders = load('lib/zec-btc-source.ts', {
    'server-only': {}, './zec-btc': model, './refresh-cache': cache, './bounded-json': { readBoundedJson },
  }, {
    process: { env: {} }, Date: Clock,
    fetch: async url => {
      calls.push(url);
      return Response.json(url.includes('simple/price') ? quotePayload(now) : historyPayload());
    },
  });
  const compact = await loaders.getZecBtcQuote();
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(compact).sort(), ['quote', 'source']);
  assert.equal(compact.source, 'CoinGecko');
  const full = await loaders.getZecBtcSnapshot('7d');
  assert.equal(calls.length, 2);
  assert.deepEqual(compact.quote, full.quote);
});

function route(network = 'mainnet', snapshot = { period: '30d', source: 'CoinGecko', quote: null, history: null }) {
  const periods = [];
  const handler = load('app/api/market/zec-btc/route.ts', {
    '@/lib/seo': { getNetwork: () => network }, '@/lib/zec-btc': model,
    '@/lib/zec-btc-source': { getZecBtcSnapshot: async period => { periods.push(period); return { ...snapshot, period }; } },
  }).GET;
  return { get: query => handler(new Request(`https://zecblock.com/api/market/zec-btc${query}`)), periods };
}

function assertPrivateApi(response) {
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) assert.equal(response.headers.get(header), 'no-store');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, follow');
}

test('route validates every query before provider access and defaults to the 30-day window', async () => {
  const api = route('mainnet', { quote: { btcPerZec: 0.01 }, history: null });
  for (const query of ['?period=all', '?period=', '?period=30D', '?period=7d&period=7d', '?period=7d&url=https://example.com', '?foo=bar']) {
    const response = await api.get(query);
    assert.equal(response.status, 400);
    assertPrivateApi(response);
  }
  assert.equal(api.periods.length, 0);
  for (const query of ['', '?period=7d', '?period=30d', '?period=90d', '?period=1y']) {
    const response = await api.get(query);
    assert.equal(response.status, 200);
    assertPrivateApi(response);
  }
  assert.deepEqual(api.periods, ['30d', '7d', '30d', '90d', '1y']);
});

test('testnet and Crosslink return 404 without fetching mainnet data; only total outages return 503', async () => {
  for (const network of ['testnet', 'crosslink-testnet']) {
    const api = route(network);
    const response = await api.get('?period=7d');
    assert.equal(response.status, 404);
    assert.equal(api.periods.length, 0);
    assertPrivateApi(response);
  }
  const unavailable = await route().get('');
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).source, 'CoinGecko');
  assertPrivateApi(unavailable);
  for (const snapshot of [{ quote: { btcPerZec: 0.01 }, history: null }, { quote: null, history: { points: [] } }]) {
    assert.equal((await route('mainnet', snapshot).get('')).status, 200);
  }
});

function quoteRoute(network = 'mainnet', quote = null) {
  let calls = 0;
  const handler = load('app/api/market/zec-btc/quote/route.ts', {
    '@/lib/seo': { getNetwork: () => network },
    '@/lib/zec-btc-source': { getZecBtcQuote: async () => { calls++; return { source: 'CoinGecko', quote }; } },
  }).GET;
  return { get: query => handler(new Request(`https://zecblock.com/api/market/zec-btc/quote${query}`)), calls: () => calls };
}

test('compact route rejects query input and other networks before accessing the source', async () => {
  const api = quoteRoute();
  for (const query of ['?period=30d', '?url=https://example.com', '?x=', '?x=1&x=2', '?&']) {
    const response = await api.get(query);
    assert.equal(response.status, 400);
    assertPrivateApi(response);
  }
  assert.equal(api.calls(), 0);
  for (const network of ['testnet', 'crosslink-testnet']) {
    const other = quoteRoute(network);
    const response = await other.get('');
    assert.equal(response.status, 404);
    assertPrivateApi(response);
    assert.equal(other.calls(), 0);
  }
});

test('compact route exposes only quote and source with explicit unavailable and delayed semantics', async () => {
  const unavailable = quoteRoute();
  const response = await unavailable.get('');
  assert.equal(response.status, 503);
  assertPrivateApi(response);
  assert.deepEqual(await response.json(), { source: 'CoinGecko', quote: null });
  assert.equal(unavailable.calls(), 1);
  for (const delayed of [false, true]) {
    const quote = { btcPerZec: 0.01626741, observedAt: now, fetchedAt: now, delayed };
    const available = await quoteRoute('mainnet', quote).get('');
    assert.equal(available.status, 200);
    assertPrivateApi(available);
    assert.deepEqual(await available.json(), { source: 'CoinGecko', quote });
  }
});
