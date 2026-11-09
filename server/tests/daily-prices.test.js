'use strict';
const databaseUrl = process.env.TEST_ANALYTICS_DATABASE_URL || process.env.TEST_UTXO_DATABASE_URL;
const test = require('node:test');
const assert = require('node:assert/strict');
const { options, retryAfterMs, fetchHistory, dailyRows, collectPrices } = require('../lib/daily-prices');
const now = Date.parse('2026-10-08T01:00:00Z');
const ts = date => Date.parse(`${date}T00:00:00Z`);
const data = { prices: [['2026-10-04', 10], ['2026-10-05', 11], ['2026-10-06', 12], ['2026-10-07', 13]].map(([date, price]) => [ts(date), price]) };
const ok = body => ({ ok: true, status: 200, json: async () => body });
const deps = { now: () => now, env: {}, log: () => {}, random: () => 0 };
test('daily collection is the safe default; backfill is explicit', () => {
  assert.deepEqual(options([]), { backfill: false });
  assert.deepEqual(options(['--daily']), { backfill: false });
  assert.deepEqual(options(['--backfill']), { backfill: true });
  assert.throws(() => options(['--days=365']));
  assert.throws(() => options(['--daily', '--backfill']));
});
test('429 honors Retry-After then retries with a bounded exponential delay', async () => {
  let calls = 0;
  const waits = [];
  const result = await fetchHistory(7, { ...deps, sleep: async ms => waits.push(ms), fetchImpl: async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 429, headers: { get: () => '90' } } : ok(data);
  } });
  assert.equal(result, data); assert.equal(calls, 2); assert.deepEqual(waits, [90000]);
  assert.equal(retryAfterMs('Thu, 08 Oct 2026 01:02:00 GMT', now), 120000);
});
test('persistent failures stop after four attempts; long cooldowns defer without hammering', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(fetchHistory(7, { ...deps, sleep: async ms => waits.push(ms), fetchImpl: async () => { calls++; return { ok: false, status: 503 }; } }), /retry budget exhausted/);
  assert.equal(calls, 4); assert.deepEqual(waits, [60000, 120000, 240000]);
  calls = 0;
  await assert.rejects(fetchHistory(7, { ...deps, sleep: async () => assert.fail(), fetchImpl: async () => { calls++; return { ok: false, status: 429, headers: { get: () => '3600' } }; } }), /deferred/);
  assert.equal(calls, 1);
});
test('transport failures retry without exposing credentials; authentication errors do not retry', async () => {
  const messages = [];
  await assert.rejects(fetchHistory(7, { ...deps, env: { COINGECKO_DEMO_API_KEY: 'secret' }, sleep: async () => {}, log: text => messages.push(text), fetchImpl: async () => { throw Error('secret'); } }), error => !error.message.includes('secret'));
  assert.ok(messages.every(message => !message.includes('secret')));
  await assert.rejects(fetchHistory(7, { ...deps, sleep: async () => assert.fail(), fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
});
test('keys use the matching host and header, never query-string credentials', async () => {
  for (const pro of [false, true]) {
    const env = { [pro ? 'COINGECKO_PRO_API_KEY' : 'COINGECKO_DEMO_API_KEY']: 'secret' };
    await fetchHistory(7, { ...deps, env, fetchImpl: async (url, request) => {
      assert.equal(new URL(url).hostname, pro ? 'pro-api.coingecko.com' : 'api.coingecko.com');
      assert.ok(!url.includes('secret'));
      assert.equal(request.headers[pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'], 'secret');
      assert.ok(request.signal); return ok(data);
    } });
  }
});
test('only completed UTC midnight observations are stored; auxiliaries match by timestamp', () => {
  const rows = dailyRows({ ...data, prices: [...data.prices, [now, 999]], market_caps: [[ts('2026-10-07'), 123.6]] }, '2026-10-08');
  assert.equal(rows.size, 4); assert.equal(rows.get('2026-10-04').cap, null);
  assert.equal(rows.get('2026-10-07').cap, 124); assert.equal(rows.get('2026-10-07').price, '13.0000');
  for (const prices of [[], [[ts('2026-10-07') + 1, 10]], [[ts('2026-10-07'), 0]], [[ts('2026-10-07'), Infinity]], [data.prices[0], data.prices[0]]]) assert.throws(() => dailyRows({ prices }, '2026-10-08'));
});
function fakeDb(missing) {
  const calls = [];
  return { calls, query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('generate_series')) return { rows: missing.map(date => ({ date })) };
    return { rows: [], rowCount: sql.includes('INSERT') ? 1 : 0 };
  } };
}
test('current collections make no provider call; overlap makes no writes', async () => {
  const db = fakeDb([]);
  const result = await collectPrices(db, {}, { ...deps, fetchImpl: async () => assert.fail() });
  assert.match(result.skipped, /current/);
  const busy = { query: async () => ({ rows: [{ acquired: false }] }) };
  assert.match((await collectPrices(busy)).skipped, /already running/);
});
test('incomplete provider coverage fails before the write transaction and releases lock', async () => {
  const db = fakeDb(['2026-10-05', '2026-10-06', '2026-10-07']);
  await assert.rejects(collectPrices(db, {}, { ...deps, fetchImpl: async () => ok({ prices: data.prices.slice(0, 2) }) }), /required daily prices/);
  assert.ok(!db.calls.some(([sql]) => sql === 'BEGIN'));
  assert.ok(db.calls.at(-1)[0].includes('pg_advisory_unlock'));
});
test('missing dates are inserted atomically without rewriting stored prices', async () => {
  const db = fakeDb(['2026-10-05', '2026-10-06', '2026-10-07']);
  const result = await collectPrices(db, {}, { ...deps, fetchImpl: async url => { assert.equal(new URL(url).searchParams.get('days'), '7'); return ok(data); } });
  assert.equal(result.requestedDays, 7);
  assert.ok(db.calls.filter(([sql]) => sql.includes('INSERT')).every(([sql]) => sql.includes('ON CONFLICT(date) DO NOTHING')));
  assert.ok(db.calls.some(([sql]) => sql === 'COMMIT'));
});
test('database failures roll back and release the collector lock', async () => {
  const db = fakeDb(['2026-10-07']); const query = db.query;
  db.query = async (sql, args) => { if (sql.includes('INSERT')) throw Error('write failed'); return query(sql, args); };
  await assert.rejects(collectPrices(db, {}, { ...deps, fetchImpl: async () => ok(data) }), /write failed/);
  assert.ok(db.calls.some(([sql]) => sql === 'ROLLBACK'));
  assert.ok(db.calls.at(-1)[0].includes('pg_advisory_unlock'));
});
test('PostgreSQL missing-day repair preserves history and is idempotent', { skip: !databaseUrl }, async () => {
  const { Client } = require('pg'); const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query(`CREATE TEMP TABLE zec_price_daily(date DATE PRIMARY KEY,price_usd NUMERIC(12,4) NOT NULL,market_cap_usd bigint,volume_usd bigint,source varchar(50),created_at timestamp DEFAULT now());
      INSERT INTO zec_price_daily(date,price_usd,source) VALUES('2026-10-04',99,'existing')`);
    const result = await collectPrices(db, {}, { ...deps, fetchImpl: async () => ok(data) });
    assert.equal(result.inserted, 3);
    assert.deepEqual((await db.query('SELECT price_usd::text,source FROM zec_price_daily WHERE date=$1', ['2026-10-04'])).rows[0], { price_usd: '99.0000', source: 'existing' });
    assert.match((await collectPrices(db, {}, { ...deps, fetchImpl: async () => assert.fail() })).skipped, /current/);
    assert.equal((await db.query('SELECT COUNT(*)::int count FROM zec_price_daily')).rows[0].count, 4);
  } finally { await db.end(); }
});
