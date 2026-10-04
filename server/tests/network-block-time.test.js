const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { isTestnet } = require('../api/lib/network-features');

async function requestStats(env) {
  const filename = path.resolve(__dirname, '../api/routes/network.js');
  const realRequire = createRequire(filename);
  const routes = new Map();
  const middleware = [];
  const router = { use: handler => middleware.push(handler), get: (url, handler) => routes.set(url, handler) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: { exports: {} }, process: { env }, console,
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name === '../lib/network-features') return { isTestnet: () => isTestnet(env) };
      if (name === './network-analytics') return { registerNetworkAnalyticsRoutes() {} };
      if (name === '../lib/hashrate') return {
        loadHashrateSnapshot: async () => ({ windows: { '24h': { hashrate: null } } }),
        formatHashrate: () => 'Unavailable',
      };
      return realRequire(name);
    },
  }, { filename });
  const queried = [];
  const cacheReads = [];
  const cacheWrites = [];
  let body;
  let status = 200;
  const req = { app: { locals: {
    pool: { async query(sql) {
      queried.push(sql);
      return { rows: [{ height: 4465135, timestamp: 1800000000, difficulty: 1,
        blocks_24h: 13335, tx_24h: 16000, tx_24h_excl_coinbase: 2665,
        avg_block_fee_zat: 12404, rolling_block_time_secs: 25.04 }] };
    } },
    callZebraRPC: async () => null,
    redisClient: { isOpen: true,
      async get(key) {
        cacheReads.push(key);
        // A pre-release testnet average must not leak out of the old cache.
        if (isTestnet(env) && key === 'zcash:network_stats:nu7-v1') {
          return JSON.stringify({ mining: { avgBlockTime: 6.5 } });
        }
        return null;
      },
      async setEx(...args) { cacheWrites.push(args); },
    },
  } } };
  const res = { json(value) { body = value; return this; }, status(value) { status = value; return this; } };
  for (const handler of middleware) handler(req, res, () => {});
  await routes.get('/api/network/stats')(req, res);
  return { body, status, queried, cacheReads, cacheWrites };
}

test('testnet averages its latest 500 blocks and bypasses cached 1000-block averages', async () => {
  // Exercise explicit deployment identity and the existing legacy fallbacks.
  for (const env of [{ NETWORK: 'testnet' }, { DB_NAME: 'zcash_testnet' }, { ZEBRA_RPC_URL: 'http://localhost:18232' }]) {
    const result = await requestStats(env);
    assert.equal(result.status, 200);
    assert.match(result.queried[0], /FROM \(SELECT timestamp FROM blocks ORDER BY height DESC LIMIT 500\) sub/);
    assert.match(result.queried[0], /NULLIF\(COUNT\(\*\) - 1, 0\)/, '500 blocks contain 499 intervals');
    assert.equal(result.body.mining.avgBlockTime, 25, 'seconds retain one-decimal rounding');
    assert.deepEqual(result.cacheReads, ['zcash:network_stats:nu7-v1:testnet-500']);
    assert.equal(result.cacheWrites[0][0], result.cacheReads[0]);
    assert.equal(result.cacheWrites[0][1], 120);
  }
});

test('mainnet retains its 1000-block average and existing cache identity', async () => {
  const result = await requestStats({ NETWORK: 'mainnet', DB_NAME: 'zcash_testnet' });
  assert.equal(result.status, 200);
  assert.match(result.queried[0], /FROM \(SELECT timestamp FROM blocks ORDER BY height DESC LIMIT 1000\) sub/);
  assert.equal(result.body.mining.avgBlockTime, 25);
  assert.deepEqual(result.cacheReads, ['zcash:network_stats:nu7-v1']);
  assert.equal(result.cacheWrites[0][0], result.cacheReads[0]);
});
