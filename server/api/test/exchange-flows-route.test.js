'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const router = require('../routes/exchange-flows');

async function get(pool, query) {
  const app = express();
  app.locals.pool = pool;
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/exchange-flows/daily${query}`);
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
  } finally { server.close(); }
}

test('exchange flows route: invalid queries are 400 and never touch the database', async () => {
  const pool = { query: async () => { throw new Error('should not query'); } };
  for (const q of ['?entity=other:x', '?from=2026-02-30', '?from=2026-11-03&to=2026-11-02']) {
    const r = await get(pool, q);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.success, false);
  }
});

test('exchange flows route: missing migration or rebuild is 503 with a reason, never zeros', async () => {
  const missing = { query: async () => { const e = new Error('relation "exchange_flow_state" does not exist'); e.code = '42P01'; throw e; } };
  let r = await get(missing, '');
  assert.deepEqual([r.status, r.retryAfter, r.body.reason, r.body.days], [503, '300', 'not-built', undefined]);
  const building = { query: async () => ({ rows: [{ ready: false, rebuild_label_version: 'c1:abc', rebuild_next_height: 5 }] }) };
  r = await get(building, '?entity=kraken');
  assert.deepEqual([r.status, r.body.reason], [503, 'rebuild-in-progress']);
  const broken = { query: async () => { throw new Error('connection reset'); } };
  r = await get(broken, '');
  assert.deepEqual([r.status, r.body.error], [500, 'Exchange flow history unavailable']);
});
