const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { deps } = require('../api/routes/transactions/_helpers');
const txDetailRouter = require('../api/routes/transactions/tx-detail');

const TXID = 'c'.repeat(64);

function createFakePool({ txRow, bridgeThrows = false, venueRows = [], venueThrows = false }) {
  const calls = { tx: 0, inputs: 0, outputs: 0, height: 0, bridge: 0, venue: 0, staking: 0 };
  return {
    calls,
    async query(sql, params) {
      if (sql.includes('information_schema.columns')) {
        calls.staking++;
        return { rows: [] }; // no staking columns in this fixture
      }
      if (sql.includes('FROM transactions t') && sql.includes('LEFT JOIN blocks b')) {
        calls.tx++;
        return { rows: [txRow] };
      }
      if (sql.includes('FROM transaction_inputs')) {
        calls.inputs++;
        return { rows: [{ prev_txid: 'p1', prev_vout: 0, address: 'addrIn', value: 500000, vout_index: 0 }] };
      }
      if (sql.includes('FROM transaction_outputs')) {
        calls.outputs++;
        return { rows: [{ address: 'addrOut', value: 490000, vout_index: 0, spent: false }] };
      }
      if (sql.includes('SELECT MAX(height) as max_height FROM blocks')) {
        calls.height++;
        return { rows: [{ max_height: 1000000 }] };
      }
      if (sql.includes('FROM cross_chain_swaps')) {
        calls.bridge++;
        if (bridgeThrows) throw new Error('bridge table unavailable');
        return { rows: [] };
      }
      if (sql.includes('FROM crosschain_venue_actions')) {
        calls.venue++;
        assert.match(sql, /action_type = 'swap' AND status = 'SUCCESS'/);
        assert.deepEqual(params, [TXID]);
        if (venueThrows) throw new Error('venue table unavailable');
        return { rows: venueRows };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

async function requestTx(pool) {
  const app = express();
  deps.pool = pool;
  app.use(txDetailRouter);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/tx/${TXID}`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const baseTxRow = {
  txid: TXID,
  block_height: 999900,
  block_hash: 'b'.repeat(64),
  block_time: 1700000000,
  size: 300,
  version: 5,
  locktime: 0,
  vin_count: 1,
  vout_count: 1,
  value_balance: 0,
  value_balance_sapling: 0,
  value_balance_orchard: 0,
  value_balance_ironwood: 0,
  has_sapling: false,
  has_orchard: false,
  has_ironwood: false,
  has_sprout: false,
  orchard_actions: 0,
  ironwood_actions: 0,
  sapling_spend_count: 0,
  sapling_output_count: 0,
  tx_index: 1,
  fee: 1000,
  total_input: 500000,
  total_output: 490000,
  is_coinbase: false,
  expiry_height: 0,
  orchard_anchor: null,
  is_canonical: true,
};

test('runs the independent tx-detail lookups exactly once each (parallel batch, not N sequential retries)', async () => {
  const pool = createFakePool({ txRow: baseTxRow });
  const result = await requestTx(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.txid, TXID);
  assert.equal(result.body.inputs.length, 1);
  assert.equal(result.body.outputs.length, 1);
  assert.equal(result.body.feeZat, '1000');
  assert.equal(result.body.totalInputZat, '500000');
  assert.equal(result.body.totalOutputZat, '490000');
  assert.equal(result.body.valueBalanceZat, '0');
  assert.equal(pool.calls.tx, 1);
  assert.equal(pool.calls.inputs, 1);
  assert.equal(pool.calls.outputs, 1);
  assert.equal(pool.calls.height, 1);
  assert.equal(pool.calls.bridge, 1);
});

test('a bridge-table error does not fail the whole tx-detail request (bridge stays null)', async () => {
  const pool = createFakePool({ txRow: baseTxRow, bridgeThrows: true });
  const result = await requestTx(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.bridge, null);
});

test('preserves a valid zero fee instead of reporting it as unavailable', async () => {
  const pool = createFakePool({ txRow: { ...baseTxRow, fee: 0, total_input: 0, total_output: 0 } });
  const result = await requestTx(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.fee, 0);
  assert.equal(result.body.feeZat, '0');
  assert.equal(result.body.totalInput, 0);
  assert.equal(result.body.totalInputZat, '0');
  assert.equal(result.body.totalOutput, 0);
  assert.equal(result.body.totalOutputZat, '0');
});

test('does not invent zero-valued exact fields when indexed values are unavailable', async () => {
  const pool = createFakePool({
    txRow: {
      ...baseTxRow,
      fee: null,
      total_input: null,
      total_output: null,
      value_balance: null,
      value_balance_sapling: null,
      value_balance_orchard: null,
      value_balance_ironwood: null,
    },
  });
  const result = await requestTx(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.feeZat, null);
  assert.equal(result.body.totalInputZat, null);
  assert.equal(result.body.totalOutputZat, null);
  assert.equal(result.body.valueBalanceZat, null);
});

test('deep-confirmed transaction gets a long-lived but reorg-safe Cache-Control header', async () => {
  const pool = createFakePool({ txRow: { ...baseTxRow, block_height: 999900 } });
  const result = await requestTx(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.confirmations, 101); // 1000000 - 999900 + 1
  assert.equal(result.headers.get('cache-control'), 'public, s-maxage=3600, stale-while-revalidate=86400');
});

test('recently-confirmed transaction gets a short, revalidating Cache-Control header', async () => {
  const pool = createFakePool({ txRow: { ...baseTxRow, block_height: 999999 } });
  const result = await requestTx(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.confirmations, 2); // 1000000 - 999999 + 1
  assert.equal(result.headers.get('cache-control'), 'public, s-maxage=15, stale-while-revalidate=120');
});

test('a transaction with no recorded block (unknown status) is never cached', async () => {
  const pool = createFakePool({
    txRow: { ...baseTxRow, block_height: null, block_hash: null, is_canonical: false },
  });
  const result = await requestTx(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'unknown');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('an orphaned (stale) transaction gets a short, revalidating Cache-Control header', async () => {
  const pool = createFakePool({
    txRow: { ...baseTxRow, is_canonical: false }, // block_hash still set -> 'stale', not 'unknown'
  });
  const result = await requestTx(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'stale');
  assert.equal(result.headers.get('cache-control'), 'public, s-maxage=30, stale-while-revalidate=300');
});

test('testnet tx detail never queries the mainnet bridge table', async () => {
  const original = process.env.NETWORK;
  process.env.NETWORK = 'testnet';
  try {
    const pool = createFakePool({ txRow: baseTxRow, bridgeThrows: true });
    const result = await requestTx(pool);
    assert.equal(result.status, 200);
    assert.equal(result.body.bridge, null);
    assert.equal(pool.calls.bridge, 0);
    assert.equal(pool.calls.tx, 1);
  } finally {
    if (original === undefined) delete process.env.NETWORK;
    else process.env.NETWORK = original;
  }
});

const mayaExit = {
  venue: 'maya', source_chain: 'zec', source_token: 'ZEC', source_amount: '1', source_amount_usd: '1284.81',
  source_tx_hashes: [TXID], dest_chain: 'eth', dest_token: 'USDC', dest_amount: '1263.030664',
  dest_amount_usd: '1265.50', dest_tx_hashes: ['703ac088086d7680f5dcc448f34ab650499e46f2a39f1382646f2ac1801e5e72'],
  swap_created_at: '2026-10-22T04:34:48.000Z', zec_amount_zat: '100000000',
};
const thorEntry = {
  venue: 'thorchain', source_chain: 'btc', source_token: 'BTC', source_amount: '0.01306366', source_amount_usd: null,
  source_tx_hashes: ['d'.repeat(64)], dest_chain: 'zec', dest_token: 'ZEC', dest_amount: '0.80960151',
  dest_amount_usd: null, dest_tx_hashes: [TXID], swap_created_at: '2026-10-28T20:00:00.000Z', zec_amount_zat: '80960151',
};

async function withVenueReads(value, fn) {
  const original = process.env.CROSSCHAIN_VENUES_READ_ENABLED;
  if (value === undefined) delete process.env.CROSSCHAIN_VENUES_READ_ENABLED;
  else process.env.CROSSCHAIN_VENUES_READ_ENABLED = value;
  try { return await fn(); } finally {
    if (original === undefined) delete process.env.CROSSCHAIN_VENUES_READ_ENABLED;
    else process.env.CROSSCHAIN_VENUES_READ_ENABLED = original;
  }
}

test('Maya and THORChain swaps on the Zcash leg become venue-labelled bridges', async () => {
  await withVenueReads('1', async () => {
    const pool = createFakePool({ txRow: baseTxRow, venueRows: [mayaExit, thorEntry] });
    const { status, body } = await requestTx(pool);
    assert.equal(status, 200);
    assert.equal(pool.calls.venue, 1);
    assert.equal(body.bridges.length, 2);
    const [exit, entry] = body.bridges;
    assert.equal(exit.venue, 'maya');
    assert.equal(exit.direction, 'exit');
    assert.equal(exit.otherChain, 'eth');
    assert.equal(exit.otherToken, 'USDC');
    assert.equal(exit.otherAmount, 1263.030664);
    assert.equal(exit.zecAmount, 1);
    assert.equal(exit.explorerUrl, 'https://etherscan.io/tx/0x703ac088086d7680f5dcc448f34ab650499e46f2a39f1382646f2ac1801e5e72');
    assert.equal(entry.venue, 'thorchain');
    assert.equal(entry.direction, 'entry');
    assert.equal(entry.otherChain, 'btc');
    assert.equal(entry.zecAmount, 0.80960151);
    assert.equal(entry.otherAmountUsd, 0, 'missing USD stays unreported, not NaN');
    assert.equal(entry.explorerUrl, 'https://mempool.space/tx/' + 'd'.repeat(64));
    assert.equal(body.bridge.venue, 'maya');
  });
});

test('venue bridge lookup stays off without the read flag and never fails the request', async () => {
  await withVenueReads(undefined, async () => {
    const pool = createFakePool({ txRow: baseTxRow, venueRows: [mayaExit] });
    const { status, body } = await requestTx(pool);
    assert.equal(status, 200);
    assert.equal(pool.calls.venue, 0);
    assert.equal(body.bridges, undefined);
  });
  await withVenueReads('1', async () => {
    const pool = createFakePool({ txRow: baseTxRow, venueThrows: true });
    const { status, body } = await requestTx(pool);
    assert.equal(status, 200);
    assert.equal(body.bridge, null);
  });
});
