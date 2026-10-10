'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchSpotPrice } = require('../bot/lib/spot-price');
const { liveCandidates } = require('../bot/lib/editorial-data');
const { publish } = require('../bot/jobs/editorial');
const now = new Date('2026-10-09T14:00:00Z');
const seconds = now.getTime() / 1000;
const raw = { zcash: { usd: 1240, last_updated_at: seconds - 60 } };
const response = (body = raw) => ({ ok: true, json: async () => body });
const fetchPrice = fetchImpl => () => fetchSpotPrice({ fetchImpl, clock: () => now });

test('spot quote requests USD and provider time, and retains full price precision', async () => {
  const result = await fetchPrice(async (url, options) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('ids'), 'zcash');
    assert.equal(query.get('vs_currencies'), 'usd');
    assert.equal(query.get('include_last_updated_at'), 'true');
    assert.equal(query.get('precision'), 'full');
    assert.ok(options.signal instanceof AbortSignal);
    return response({ zcash: { usd: 1240.123456789, last_updated_at: seconds - 60 } });
  })();
  assert.deepEqual(result, { quote: { source: 'coingecko', currency: 'usd', usd: 1240.123456789,
    basis: 'spot-at-detection', sourceUpdatedAt: '2026-10-09T13:59:00.000Z',
    fetchedAt: now.toISOString() }, unavailable: null });
});

test('failed, malformed and stale quotes are unavailable without retries', async t => {
  const cases = [
    ['rate limit', async () => ({ ok: false, status: 429 }), 'http-429'],
    ['upstream error', async () => ({ ok: false, status: 502 }), 'http-502'],
    ['timeout', async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); }, 'timeout'],
    ['network error', async () => { throw new Error(); }, 'fetch-failed'],
    ['invalid JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }), 'fetch-failed'],
    ...[null, {}, { zcash: { usd: 1240 } }, ...[0, -1, NaN, Infinity, '1240'].map(usd => ({ zcash: { usd, last_updated_at: seconds } })),
      ...[null, 0, '1791554400', seconds + 0.1].map(last_updated_at => ({ zcash: { usd: 1240, last_updated_at } }))]
      .map((body, i) => [`invalid fields ${i}`, async () => response(body), body === null ? 'fetch-failed' : 'invalid-quote']),
    ['older than five minutes', async () => response({ zcash: { usd: 1240, last_updated_at: seconds - 301 } }), 'stale-or-future-quote'],
    ['future timestamp', async () => response({ zcash: { usd: 1240, last_updated_at: seconds + 61 } }), 'stale-or-future-quote'],
  ];
  for (const [name, impl, reason] of cases) await t.test(name, async () => {
    let calls = 0;
    const result = await fetchPrice(async (...args) => { calls++; return impl(...args); })();
    assert.deepEqual(result, { quote: null, unavailable: reason });
    assert.equal(calls, 1);
  });
  assert.ok((await fetchPrice(async () => response({ zcash: { usd: 1240, last_updated_at: seconds - 300 } }))()).quote);
});

const flow = { txid: 'a'.repeat(64), flow_type: 'deshield', amount_zat: '99000040000', pool: 'ironwood',
  sample_count: 89075, greater_count: 163, equal_count: 0, block_time: seconds - 240 };

function reader({ flows = [flow], migrations = [], missingPools = false } = {}) {
  const state = { released: false, queries: [] };
  const client = { release() { state.released = true; }, async query(sql) {
    state.queries.push(sql);
    if (sql.includes('current_database()')) return { rows: [{ name: 'zcash_explorer_mainnet', timestamp: seconds }] };
    if (sql.includes('WITH valid AS MATERIALIZED')) return { rows: flows };
    if (sql.includes('FROM privacy_stats')) {
      if (missingPools) throw Object.assign(new Error('missing table'), { code: '42P01' });
      return { rows: [{ ironwood_pool_size: '407366227799748', updated_at: now.toISOString() }] };
    }
    if (sql.includes('SELECT t.txid,t.block_time')) return { rows: migrations };
    return { rows: [] };
  } };
  return { state, connect: async () => client };
}

test('qualifying flows and migrations share one fresh quote after DB snapshot release', async () => {
  const db = reader({ migrations: [{ txid: 'b'.repeat(64), amount_zat: '1000000000000', block_time: seconds - 300 }] });
  let calls = 0;
  const result = await liveCandidates(db, now, { fetchPrice: fetchPrice(async () => {
    assert.ok(db.state.released);
    calls++;
    return response();
  }) });
  assert.equal(calls, 1);
  const priced = result.candidates.find(c => c.type === 'flow_deshield');
  assert.equal(priced.evidence.usd, 1227600.496);
  assert.match(priced.content, /990 ZEC \(\$1\.22M\)/);
  assert.match(priced.evidence.card.line, /≈ \$1\.22M/);
  // USD display deliberately floors; exact evidence includes the 0.0004 ZEC.
  assert.equal(priced.evidence.price_quote.sourceUpdatedAt, '2026-10-09T13:59:00.000Z');
  const migration = result.candidates.find(c => c.type === 'migration');
  assert.equal(migration.evidence.price_usd, 1240);
  assert.deepEqual(migration.evidence.price_quote, priced.evidence.price_quote);
  assert.match(migration.content, /\$12\.40M/);
  assert.ok(!db.state.queries.some(sql => sql.includes('zec_price_daily')));

  let stored;
  const outbox = { async query(sql, args) {
    if (sql.startsWith('INSERT')) { stored = JSON.parse(args[3]); return { rows: [{ id: 1 }] }; }
    return { rows: [] };
  } };
  await publish(outbox, { post: async () => ({ id: 'test-id' }) }, priced, { logger: { info() {} } });
  assert.deepEqual(stored.price_quote, priced.evidence.price_quote);
});

test('quote failure preserves ZEC alerts and balances, without USD in copy or card', async () => {
  const db = reader({ migrations: [{ txid: 'b'.repeat(64), amount_zat: '1000000000000', block_time: seconds - 300 }] });
  const result = await liveCandidates(db, now, { fetchPrice: fetchPrice(async () => ({ ok: false, status: 429 })) });
  assert.equal(result.candidates.length, 2);
  for (const story of result.candidates) {
    assert.equal(story.evidence.price_usd, null);
    assert.equal(story.evidence.price_quote, null);
    assert.equal(story.evidence.usd, null);
    assert.doesNotMatch(story.content + story.evidence.card.line, /\$/);
    assert.match(story.content, /Ironwood now holds 4\.07M ZEC/);
  }
  assert.ok(result.decisions.some(d => d.reason === 'price-unavailable' && d.detail === 'http-429'));
});

test('pool-context failure does not discard a fresh quote; unqualified scans do not fetch', async () => {
  const result = await liveCandidates(reader({ missingPools: true }), now, { fetchPrice: fetchPrice(async () => response()) });
  assert.equal(result.candidates[0].evidence.price_usd, 1240);
  assert.doesNotMatch(result.candidates[0].content, /now holds/);
  assert.ok(result.decisions.some(d => d.reason === 'context-unavailable'));
  for (const flows of [[], [{ ...flow, equal_count: 10000 }]]) {
    const empty = await liveCandidates(reader({ flows }), now, { fetchPrice: async () => { throw new Error('Unexpected price fetch'); } });
    assert.equal(empty.candidates.length, 0);
  }
});
