const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const createV1Router = require('../../v1');

test('native names preserve normalization, boundary pagination, missing names and errors', async t => {
  const calls = [];
  let hasPricing = true;
  const rows = Array.from({ length: 501 }, (_, i) => ({ name: `name${i}`, block_height: i, nested: { tx_id: 'x' } }));
  const source = express(); source.use(express.json());
  source.post('/', (req, res) => {
    const { method, params } = req.body; calls.push(req.body);
    if (params.query === 'broken') return res.status(503).json({ error: 'internal secret' });
    let result;
    if (method === 'status') result = hasPricing
      ? { registered_count: 501, pricing: { base_price: 100 } }
      : { synced_height: 3500000, synced: true, treasury_address: 'u1registry' };
    else if (method === 'events') result = [{ block_height: 42, event_type: 'registered' }];
    else if (params.query === '') result = rows.slice(params.offset, params.offset + Math.min(params.limit, 500));
    else result = rows.find(r => r.name === params.query) || null;
    res.json({ jsonrpc: '2.0', id: 1, result });
  });
  const upstream = source.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const router = createV1Router({ API_V1_ENABLED: 'true', API_V1_LAUNCHED: 'true', NEXT_PUBLIC_NETWORK: 'mainnet', ZNS_MAINNET_URL: `http://127.0.0.1:${upstream.address().port}` });
  const app = express(); app.use('/v1', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const get = path => fetch(`http://127.0.0.1:${server.address().port}/v1/names${path}`);
  t.after(() => { router.__stopRateLimiters(); server.closeAllConnections(); upstream.closeAllConnections(); server.close(); upstream.close(); });
  const status = await (await get('/status')).json();
  assert.equal(status.data.registeredCount, 501);
  assert.equal(status.meta.freshness.status, 'unknown');
  const first = await (await get('?limit=500')).json();
  assert.equal(first.data.length, 500); assert.equal(first.meta.page.hasNext, true);
  const last = await (await get(`?limit=500&cursor=${first.meta.page.nextCursor}`)).json();
  assert.equal(last.data[0].name, 'name500'); assert.equal(last.meta.page.hasNext, false);
  const prev = await (await get(`?limit=500&cursor=${last.meta.page.prevCursor}`)).json();
  assert.deepEqual(prev.data, first.data);
  assert(calls.some(c => c.params.offset === 500 && c.params.limit === 1));
  const name = await (await get('/NAME1.zec')).json();
  assert.equal(name.data.blockHeight, 1); assert.deepEqual(name.data.nested, { txId: 'x' });
  assert.deepEqual((await (await get('/missing')).json()).data, { pricing: { basePrice: 100 } });
  hasPricing = false;
  assert.equal((await (await get('/status')).json()).data.registeredCount, undefined);
  assert.deepEqual((await (await get('/missing')).json()).data, { pricing: null }, 'current resolver status has no pricing; availability remains explicit');
  assert.equal((await (await get('/name1/events')).json()).data[0].eventType, 'registered');
  for (const path of ['?limit=501', '?limit=1&limit=2', '?cursor=invalid', '/bad-name']) assert.equal((await get(path)).status, 400);
  const failed = await get('/broken'); assert.equal(failed.status, 502);
  assert.equal(failed.headers.get('cache-control'), 'no-store'); assert(!JSON.stringify(await failed.json()).includes('secret'));
});
