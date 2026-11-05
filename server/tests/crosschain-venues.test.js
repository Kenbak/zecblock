'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createCrosschainVenuesRouter } = require('../api/routes/crosschain-venues');

async function serve(t, options) {
  const app = express();
  app.use(createCrosschainVenuesRouter(options));
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async query => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crosschain/venues${query}`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}
const page = (venue = 'maya') => ({ venue, source: 'midgard', transfers: [{ id: `${venue}-tx`, zecAmountZat: '9007199254740993', inputs: [], outputs: [], raw: { internal: true } }], nextCursor: 'opaque_next', coverage: { observedAt: '2026-10-29T10:00:00.000Z', historyComplete: false } });

test('venue route rejects unknown, repeated and out-of-range parameters before reading a provider', async t => {
  let calls = 0;
  const get = await serve(t, { createClient: () => ({ readPage: async () => { calls++; return page(); } }) });
  for (const query of ['', '?venue=near', '?venue=maya&limit=0', '?venue=maya&limit=26', '?venue=maya&limit=1.5', '?venue=maya&limit=01&limit=2', '?venue=maya&cursor=https://example.com', '?venue=maya&secret=x']) {
    const result = await get(query);
    assert.equal(result.status, 400, query);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls, 0);
});

test('concurrent reads coalesce, retain exact amounts and cache each venue independently', async t => {
  let calls = 0;
  const get = await serve(t, { createClient: ({ venue }) => ({ readPage: async ({ limit, cursor }) => {
    calls++;
    assert.equal(limit, 10);
    assert.equal(cursor, undefined);
    await new Promise(resolve => setTimeout(resolve, 15));
    return page(venue);
  } }) });
  const results = await Promise.all([get('?venue=maya'), get('?venue=maya')]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.transfers[0].zecAmountZat, '9007199254740993');
    assert.equal(Object.hasOwn(result.body.transfers[0], 'raw'), false);
    assert.equal(result.body.freshness.status, 'fresh');
    assert.equal(result.body.nextCursor, 'opaque_next');
  }
  assert.equal((await get('?venue=maya')).headers.get('x-cipherscan-cache'), 'hit');
  assert.equal((await get('?venue=thorchain')).body.venue, 'thorchain');
  assert.equal(calls, 2);
});

test('provider failures use an explicit bounded stale page, then 503 without zero activity', async t => {
  let at = 0, failed = false;
  const get = await serve(t, { now: () => at, createClient: () => ({ readPage: async () => {
    if (failed) throw new Error('private provider diagnostics');
    return page();
  } }) });
  assert.equal((await get('?venue=maya')).status, 200);
  failed = true;
  at = 61_000;
  const stale = await get('?venue=maya');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.freshness.status, 'stale');
  assert.equal(stale.body.freshness.ageSeconds, 61);
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  at = 301_000;
  const unavailable = await get('?venue=maya');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.success, false);
  assert.equal(Object.hasOwn(unavailable.body, 'transfers'), false);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /private provider diagnostics/);
});

test('venue-bound cursor rejection remains a client error rather than stale provider data', async t => {
  const get = await serve(t, { createClient: () => ({ readPage: async () => { const error = new Error('wrong venue'); error.code = 'INVALID_CURSOR'; throw error; } }) });
  assert.equal((await get('?venue=maya&cursor=wrong_venue')).status, 400);
});

test('public v1 venue contract preserves exact records and rejects unknown queries before dispatch', async t => {
  const createV1Router = require('../api/v1');
  let calls = 0;
  const app = express();
  app.use(createCrosschainVenuesRouter({ createClient: ({ venue }) => ({ readPage: async () => { calls++; return page(venue); } }) }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const router = createV1Router({ API_V1_ENABLED: 'true', API_V1_LAUNCHED: 'true', NEXT_PUBLIC_NETWORK: 'mainnet', V1_INTERNAL_API_BASE_URL: base, V1_INTERNAL_TIMEOUT_MS: '1000' });
  app.use('/v1', router);
  t.after(async () => { router.__stopRateLimiters(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`${base}/v1/crosschain/venues?venue=maya`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.transfers[0].zecAmountZat, '9007199254740993');
  assert.equal(body.data.coverage.historyComplete, false);
  assert.equal(body.meta.network, 'mainnet');
  assert.equal(body.meta.units.authoritativeEncoding, 'decimal-string');
  const invalid = await fetch(`${base}/v1/crosschain/venues?venue=maya&unknown=x`);
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get('content-type'), /application\/problem\+json/);
  assert.equal(calls, 1);
});

test('non-mainnet deployments do not expose native-ZEC venue observations', async t => {
  const prior = process.env.NETWORK;
  process.env.NETWORK = 'testnet';
  t.after(() => { if (prior === undefined) delete process.env.NETWORK; else process.env.NETWORK = prior; });
  const get = await serve(t, { createClient: () => { throw new Error('must not create provider client'); } });
  const result = await get('?venue=maya');
  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'FEATURE_UNAVAILABLE_ON_NETWORK');
});
