const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { isTestnet, isNonMainnet, networkName, mainnetOnly } = require('../lib/network-features');

test('network identity uses explicit deployment setting, then database/RPC fallback', () => {
  assert.equal(isTestnet({ NETWORK: 'testnet' }), true);
  assert.equal(isTestnet({ NETWORK: 'mainnet', DB_NAME: 'testnet' }), false);
  assert.equal(isTestnet({ DB_NAME: 'zcash_explorer_testnet' }), true);
  assert.equal(isTestnet({ ZEBRA_RPC_URL: 'http://127.0.0.1:18232/' }), true);
  assert.equal(isTestnet({ NETWORK: 'mainnet' }), false);
  assert.equal(isNonMainnet({ NETWORK: 'crosslink' }), true);
  assert.equal(networkName({ DB_NAME: 'zcash_crosslink' }), 'crosslink-testnet');
  assert.equal(isNonMainnet({ NETWORK: 'unexpected' }), true);
});

test('mainnet middleware preserves downstream behavior', () => {
  const old = process.env.NETWORK;
  process.env.NETWORK = 'mainnet';
  try {
    let called = false;
    mainnetOnly('NEAR Intents')({}, { status() { throw new Error('unexpected response'); } }, () => { called = true; });
    assert.equal(called, true);
  } finally {
    if (old === undefined) delete process.env.NETWORK; else process.env.NETWORK = old;
  }
});

for (const deployment of ['testnet', 'crosslink', 'crosslink-testnet']) test(`${deployment} unsupported features return explicit availability without database or upstream calls`, async () => {
  const old = process.env.NETWORK;
  process.env.NETWORK = deployment;
  const app = express();
  app.locals.pool = { query() { throw new Error('Non-mainnet must not query unsupported analytics tables'); } };
  for (const route of ['crosschain', 'privacy', 'pulse', 'valuation', 'network']) app.use(require(`../routes/${route}`));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    for (const path of ['/api/crosschain/stats', '/api/crosschain/history', '/api/privacy/risks',
      '/api/privacy/graph/' + 'a'.repeat(64), '/api/privacy/recommended-swap-amounts',
      '/api/privacy/common-amounts?chain=eth', '/api/pulse', '/api/pulse/summary', '/api/valuation/history']) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      assert.equal(res.status, 404, path);
      const body = await res.json();
      assert.equal(body.available, false, path);
      assert.equal(body.code, 'FEATURE_UNAVAILABLE_ON_NETWORK', path);
      assert.equal(body.network, deployment === 'crosslink' ? 'crosslink-testnet' : deployment);
    }
    for (const path of ['/api/price', '/api/price/at?date=2026-09-29']) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      assert.equal(res.status, 200, path);
      const body = await res.json();
      assert.equal(body.available, false);
      assert.equal(body.network, deployment === 'crosslink' ? 'crosslink-testnet' : deployment);
      assert.equal(path === '/api/price' ? body.price : body.price_usd, null);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (old === undefined) delete process.env.NETWORK; else process.env.NETWORK = old;
  }
});
