const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const createV1Router = require('../../v1');
const { createWalletServersRouter } = require('../../routes/wallet-servers');

test('v1 preserves wallet server observations, the unavailable state and no-store', async (t) => {
  const observation = { checkedAt: '2026-11-19T12:00:00.000Z', reachable: true, height: 3591214, hash: '0000000000e631c94fe7b859a8ef133fceea3cf28a1631f6cc1b28dbe5cf3347', responseMs: 42, chain: 'canonical', tipDelta: 0, chainName: 'main', vendor: 'Ztreamer', version: '0.1.0', nodeSubversion: '/Zakura:1.8.9/' };
  let snapshot = null;
  const legacy = express();
  legacy.get('/api/info', (_req, res) => res.json({ blocks: 42 }));
  legacy.use(createWalletServersRouter({ network: 'mainnet', monitor: { read: async () => snapshot } }));
  const source = legacy.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const router = createV1Router({ API_V1_ENABLED: 'true', API_V1_LAUNCHED: 'true', NEXT_PUBLIC_NETWORK: 'mainnet', V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${source.address().port}`, V1_INTERNAL_SERVICE_KEY: '' });
  const app = express(); app.use('/v1', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    router.__stopRateLimiters?.();
    server.closeAllConnections(); source.closeAllConnections();
    await Promise.all([server, source].map(s => new Promise(resolve => s.close(resolve))));
  });
  const url = `http://127.0.0.1:${server.address().port}/v1/network/wallet-servers`;
  const empty = await fetch(url);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  const unavailable = await empty.json();
  assert.equal(unavailable.meta.network, 'mainnet');
  assert.equal(unavailable.data.available, false);
  assert.ok(unavailable.data.operators.some((operator) => operator.id === 'fastz'));

  snapshot = { checkedAtMs: 1, checkedAt: observation.checkedAt, referenceHeight: 3591214, observations: { 'fastz-rpc': observation } };
  const body = await (await fetch(url)).json();
  assert.equal(body.data.available, true);
  assert.equal(body.data.reference.height, 3591214);
  const rpc = body.data.operators.flatMap((operator) => operator.endpoints).find((endpoint) => endpoint.id === 'fastz-rpc');
  assert.deepEqual(rpc.latest, observation);
  assert.equal(rpc.host, 'rpc.fastz.cash');

  const rejected = await fetch(`${url}?host=evil.example`);
  assert.equal(rejected.status, 400);
});
