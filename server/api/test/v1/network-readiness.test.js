const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const createV1Router = require('../../v1');
const { registerNetworkReadinessRoutes } = require('../../routes/network-readiness');

// Exercise the real source handlers through the redesign's v1 adapter. This
// catches missing query allowlists and monetary serialization at the boundary.
test('redesign network timing and accounting retain source semantics through v1', async t => {
  const source = express();
  const height = 3_600_001;
  const timestamp = Math.floor(Date.now() / 1000);
  const rows = Array.from({ length: 125 }, (_, i) => ({ height: height - i, timestamp: timestamp - i * 25 }));
  let unavailable = false;
  source.locals.pool = { query: async sql => ({ rows: sql.includes('WITH canonical AS MATERIALIZED') ? [{
    totals:{blocks:2,feeBlocks:2,feesPaidZat:'6',feesToNsmZat:'2',minerFeeAllocationZat:'4'},
    selected:{blocks:2,feeBlocks:2,feesPaidZat:'6',feesToNsmZat:'2',minerFeeAllocationZat:'4'},
    bucket_seconds:'300',points:[{timestamp,feesPaidZat:'6',feesToNsmZat:'2',minerFeeAllocationZat:'4',cumulativeRemovalZat:'2'}],
    baseline:{height:3600000-1,hash:'canonical',balance:'9007199254740993'},tip:{height,hash:'canonical',balance:'9007199254740995'},
  }] : sql.includes('WITH tip') ? [{
    height, hash: 'canonical', transaction_count: 3, tx_count: 3, coinbases: 1,
    invalid_fees: 0, fees: '3', coinbase_value: '100000004',
  }] : rows }) };
  source.locals.callZebraRPC = async method => {
    if (unavailable) throw new Error('fixture unavailable');
    if (method === 'getblockhash') return 'canonical';
    if (method === 'getblocksubsidy') return { miner: 0.8, founders: 0, fundingstreamstotal: 0.2 };
    assert.equal(method, 'getblockchaininfo');
    return { chain: 'main', blocks: height, bestblockhash: 'canonical', nsmValueBalanceZat: '-9223372036854775808',
      chainSupply: { chainValueZat: '1600000000000000' },
      upgrades: { b: { name: 'Blossom', activationheight: 653600 }, n: { name: 'NU7', activationheight: 3600000 } } };
  };
  source.get('/api/info', (_, res) => res.json({ blocks: height }));
  registerNetworkReadinessRoutes(source);
  const upstream = source.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const router = createV1Router({ API_V1_ENABLED: 'true', API_V1_LAUNCHED: 'true', NEXT_PUBLIC_NETWORK: 'mainnet',
    V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, V1_INTERNAL_SERVICE_KEY: '' });
  const app = express(); app.use('/v1', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    router.__stopRateLimiters?.();
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([server, upstream].map(s => new Promise(resolve => s.close(resolve))));
  });
  const base = `http://127.0.0.1:${server.address().port}/v1/network`;
  for (const period of ['6h', '24h', '7d']) {
    const response = await fetch(`${base}/block-time?period=${period}`);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.period, period);
    assert.equal(data.points.at(-1).targetSeconds, 25);
    assert.equal(data.points.at(-1).averageSeconds, 25);
  }
  assert.equal((await fetch(`${base}/block-time?period=invalid`)).status, 400);
  const response = await fetch(`${base}/accounting`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { data } = await response.json();
  assert.equal(data.nsmBalanceZat, '-9223372036854775808');
  assert.equal(data.block.feesToNsmZat, '1');
  assert.equal(data.block.minerFeeAllocationZat, '2');
  assert.equal(data.block.minerReceiptsZat, '80000004');
  assert.equal(data.block.reissuanceZat, null);
  for(const period of ['1d','7d','30d','all']) {
    const history = await fetch(`${base}/accounting/history?period=${period}`);
    assert.equal(history.status,200);
    const payload = await history.json();
    assert.equal(payload.data.period,period);
    assert.equal(payload.data.totals.feesToNsmZat,'2');
    assert.equal(payload.data.reserve.growthSinceNu7Zat,'2');
    assert.equal(payload.data.points[0].cumulativeRemovalZat,'2');
  }
  assert.equal((await fetch(`${base}/accounting/history?period=all&limit=120`)).status,400);
  unavailable = true;
  const failed = await fetch(`${base}/accounting`);
  assert.equal(failed.status, 503);
  assert.match(failed.headers.get('content-type'), /application\/problem\+json/);
});
