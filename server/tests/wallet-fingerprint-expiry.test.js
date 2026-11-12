const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const privacyRouter = require('../api/routes/privacy');
const { SDK_EXPIRY_WINDOWS, SDK_EXPIRY_MATCH } = require('../api/lib/wallet-expiry-fingerprint');

const NU7_HEIGHT = 3_543_405;
const chainInfo = {
  chain: 'main',
  upgrades: {
    a: { name: 'Blossom', activationheight: 653_600 },
    b: { name: 'NU7', activationheight: NU7_HEIGHT },
  },
};

async function request(locals) {
  const app = express();
  Object.assign(app.locals, locals);
  app.use(privacyRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/privacy/wallet-fingerprints?period=7d`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function recordingPool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [new Proxy({}, { get: () => '7' })] };
    },
  };
}

test('SDK expiry windows cover the 40-block and 120-block defaults without overlapping other wallets', () => {
  assert.deepEqual({ ...SDK_EXPIRY_WINDOWS.beforeNu7 }, { min: 36, max: 40 });
  assert.deepEqual({ ...SDK_EXPIRY_WINDOWS.sinceNu7 }, { min: 106, max: 120 });
  assert.match(SDK_EXPIRY_MATCH, /BETWEEN 36 AND 40 AND \(\$2::integer IS NULL OR block_height < \$2::integer\)/);
  assert.match(SDK_EXPIRY_MATCH, /BETWEEN 106 AND 120 AND block_height >= \$2::integer/);
});

test('fingerprint counts use the serving node NU7 height and report the current SDK expiry', async () => {
  const pool = recordingPool();
  const { status, body } = await request({ pool, callZebraRPC: async () => chainInfo });

  assert.equal(status, 200);
  assert.equal(pool.calls[0].params[1], NU7_HEIGHT);
  assert.equal(pool.calls[0].sql.split(SDK_EXPIRY_MATCH).length - 1, 4);

  const sends = body.wallets.find(wallet => wallet.name === 'ZODL / Vizor (Ironwood sends)');
  assert.equal(sends.signals.expiry.value, '+120 blocks (+40 before NU7)');
  assert.equal(sends.signals.expiry.confidence, 'medium');
  assert.equal(sends.signals.expiry.matchCount, 7);
});

test('fingerprint counts are withheld when the node schedule is not authoritative', async () => {
  const pool = recordingPool();
  const { status, body } = await request({ pool, callZebraRPC: async () => ({ chain: 'main', upgrades: { a: { name: 'NU9', activationheight: 1 } } }) });

  assert.equal(status, 503);
  assert.equal(body.success, false);
  assert.equal(pool.calls.length, 0);
});

test('Crosslink keeps the pre-NU7 window without needing a node schedule', async () => {
  const previous = process.env.NETWORK;
  process.env.NETWORK = 'crosslink';
  try {
    const pool = recordingPool();
    const { status } = await request({ pool, callZebraRPC: async () => { throw new Error('must not be called'); } });
    assert.equal(status, 200);
    assert.equal(pool.calls[0].params[1], null);
  } finally {
    if (previous === undefined) delete process.env.NETWORK; else process.env.NETWORK = previous;
  }
});
