'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const router = require('../routes/pool-sources');

async function get(pool, query) {
  const app = express();
  app.locals.pool = pool;
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/pools/sources${query}`);
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
  } finally { server.close(); }
}

test('pool sources route: invalid queries are 400 and never touch the database', async () => {
  const pool = { query: async () => { throw new Error('should not query'); } };
  for (const q of ['', '?pool=mixed', '?pool=sapling&period=24h', '?pool=sapling&from=2026-02-30', '?pool=sapling&period=7d&from=2026-11-01',
    '?pool=sapling&granularity=hour', '?pool=sapling&limit=5']) {
    const r = await get(pool, q);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.success, false);
  }
});

test('pool sources route: missing migration or rebuild is 503 with a reason, never zeros', async () => {
  const missing = { query: async () => { const e = new Error('relation "shielded_pool_source_state" does not exist'); e.code = '42P01'; throw e; } };
  let r = await get(missing, '?pool=sapling');
  assert.deepEqual([r.status, r.retryAfter, r.body.reason, r.body.series], [503, '300', 'not-built', undefined]);
  const building = { query: async () => ({ rows: [{ ready: false, rebuild_version: 'c1:abc:def', rebuild_next_day: '2019-01-01' }] }) };
  r = await get(building, '?pool=ironwood&period=7d');
  assert.deepEqual([r.status, r.body.reason], [503, 'rebuild-in-progress']);
  const broken = { query: async () => { throw new Error('connection reset'); } };
  r = await get(broken, '?pool=orchard');
  assert.deepEqual([r.status, r.body.error], [500, 'Pool source history unavailable']);
});
