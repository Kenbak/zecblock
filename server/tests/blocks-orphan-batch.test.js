const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const blocksRouter = require('../api/routes/blocks');

const ORPHAN_HASH = 'a'.repeat(64);

function createFakePool() {
  const calls = { orphanInputQueries: 0, orphanOutputQueries: 0 };
  return {
    calls,
    async query(sql, params) {
      // Main canonical lookup by hash — not found, falls through to orphan lookup.
      if (sql.includes('FROM blocks') && sql.includes('WHERE hash = $1')) {
        return { rows: [] };
      }
      if (sql.includes('FROM orphaned_blocks WHERE hash = $1')) {
        return {
          rows: [{
            height: 100,
            hash: params[0],
            timestamp: 1700000000,
            transaction_count: 2,
            size: 4000,
            difficulty: '1',
            miner_address: 't1UnknownMinerAddress',
            previous_block_hash: 'b'.repeat(64),
            source: 'fork-monitor',
            detected_at: '2026-01-01T00:00:00.000Z',
          }],
        };
      }
      // fetchCanonicalBlockSummary — no canonical replacement recorded.
      if (sql.includes('FROM blocks WHERE height = $1')) {
        return { rows: [] };
      }
      if (sql.includes('FROM orphaned_transactions')) {
        return {
          rows: [
            {
              txid: 'tx1', block_height: 100, tx_index: 0, version: 4, size: 200, fee: 1000,
              is_coinbase: false, vin_count: 1, vout_count: 1, total_input: 100000, total_output: 99000,
              has_sapling: false, has_orchard: false, has_sprout: false, has_ironwood: false, has_shielded_data: false,
              sapling_spend_count: 0, sapling_output_count: 0, orchard_actions: 0, ironwood_actions: 0,
              sprout_joinsplit_count: 0, value_balance: 0, value_balance_sapling: 0, value_balance_orchard: 0,
              value_balance_ironwood: 0, flow_type: null, privacy_score: null, timestamp: 1700000000, expiry_height: 0,
            },
            {
              txid: 'tx2', block_height: 100, tx_index: 1, version: 4, size: 250, fee: 2000,
              is_coinbase: false, vin_count: 1, vout_count: 1, total_input: 200000, total_output: 198000,
              has_sapling: false, has_orchard: false, has_sprout: false, has_ironwood: false, has_shielded_data: false,
              sapling_spend_count: 0, sapling_output_count: 0, orchard_actions: 0, ironwood_actions: 0,
              sprout_joinsplit_count: 0, value_balance: 0, value_balance_sapling: 0, value_balance_orchard: 0,
              value_balance_ironwood: 0, flow_type: null, privacy_score: null, timestamp: 1700000001, expiry_height: 0,
            },
          ],
        };
      }
      if (sql.includes('FROM orphaned_transaction_inputs')) {
        calls.orphanInputQueries++;
        assert.ok(Array.isArray(params[1]), 'inputs query must batch txids via a single array param');
        assert.deepEqual(params[1].sort(), ['tx1', 'tx2']);
        return {
          rows: [
            { txid: 'tx1', vout_index: 0, prev_txid: 'p1', prev_vout: 0, address: 'addrA', value: 100000, coinbase: null },
            { txid: 'tx2', vout_index: 0, prev_txid: 'p2', prev_vout: 0, address: 'addrB', value: 200000, coinbase: null },
          ],
        };
      }
      if (sql.includes('FROM orphaned_transaction_outputs')) {
        calls.orphanOutputQueries++;
        assert.ok(Array.isArray(params[1]), 'outputs query must batch txids via a single array param');
        return {
          rows: [
            { txid: 'tx1', vout_index: 0, value: 99000, address: 'addrC', script_type: 'p2pkh' },
            { txid: 'tx2', vout_index: 0, value: 198000, address: 'addrD', script_type: 'p2pkh' },
          ],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

async function requestOrphanBlock(pool) {
  const app = express();
  app.locals.pool = pool;
  app.locals.redisClient = null;
  app.locals.callZebraRPC = async () => null;
  app.use(blocksRouter);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/block/${ORPHAN_HASH}`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('orphaned block detail batches input/output I/O into one query each, regardless of tx count', async () => {
  const pool = createFakePool();
  const result = await requestOrphanBlock(pool);

  assert.equal(result.status, 200);
  assert.equal(result.body.isOrphaned, true);
  assert.equal(result.body.transactions.length, 2);

  // The core regression guard: 2 orphaned transactions must cost exactly one
  // inputs query and one outputs query — not one pair per transaction.
  assert.equal(pool.calls.orphanInputQueries, 1);
  assert.equal(pool.calls.orphanOutputQueries, 1);

  const tx1 = result.body.transactions.find((t) => t.txid === 'tx1');
  const tx2 = result.body.transactions.find((t) => t.txid === 'tx2');
  assert.equal(tx1.vin.length, 1);
  assert.equal(tx1.vin[0].address, 'addrA');
  assert.equal(tx1.vout[0].address, 'addrC');
  assert.equal(tx2.vin[0].address, 'addrB');
  assert.equal(tx2.vout[0].address, 'addrD');
});

test('orphaned block detail sets a bounded, revalidating Cache-Control header', async () => {
  const pool = createFakePool();
  const result = await requestOrphanBlock(pool);

  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'public, s-maxage=300, stale-while-revalidate=3600');
});

test('orphan metadata and archive coverage are explicit; query failures are not empty archives', async () => {
  const pool = createFakePool();
  const query = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    const result = await query(sql, params);
    if (sql.includes('FROM orphaned_blocks WHERE hash = $1')) Object.assign(result.rows[0], {
      first_seen_at: '2026-09-23T11:22:33.456Z',
      block_metadata: { version: 4, merkle_root: 'c'.repeat(64), final_ironwood_root: 'd'.repeat(64), bits: '1f07ffff' },
      raw_block_available: true,
    });
    return result;
  };
  const result = await requestOrphanBlock(pool);
  assert.equal(result.body.firstSeenAt, '2026-09-23T11:22:33.456Z');
  assert.equal(result.body.merkle_root, 'c'.repeat(64));
  assert.equal(result.body.final_ironwood_root, 'd'.repeat(64));
  assert.equal(result.body.rawBlockAvailable, true);
  assert.equal(result.body.archivedTransactionCount, 2);
  assert.equal(result.body.transactionArchiveComplete, true);
  pool.query = async (sql, params) => {
    if (sql.includes('FROM orphaned_transactions')) throw new Error('archive query unavailable');
    return query(sql, params);
  };
  assert.equal((await requestOrphanBlock(pool)).status, 500);
});

function observerPool({ captured, canonicalAtHeight = true }) {
  return {
    async query(sql, params) {
      if (sql.includes('FROM blocks') && sql.includes('WHERE hash = $1')) return { rows: [] };
      if (sql.includes('FROM orphaned_blocks WHERE hash = $1')) return { rows: [] };
      if (sql.includes('FROM captured_blocks c')) {
        assert.equal(params[0], ORPHAN_HASH);
        return { rows: captured ? [captured] : [] };
      }
      if (sql.includes('FROM blocks WHERE height = $1')) {
        return { rows: canonicalAtHeight ? [{ height: 100, hash: 'e'.repeat(64), timestamp: 1700000000, transaction_count: 3, size: 5000, miner_address: 't1Winner', coinbase_hex: null, first_seen_at: null }] : [] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

function rawPrefix(txCount) {
  // 140-byte header, CompactSize(1344) solution, then CompactSize tx count.
  return Buffer.concat([Buffer.alloc(140), Buffer.from([0xfd, 0x40, 0x05]), Buffer.alloc(1344), Buffer.from([txCount])]);
}

test('observer-only orphan resolves by hash with header facts and an explicit source', async () => {
  const result = await requestOrphanBlock(observerPool({ captured: {
    height: 100, hash: ORPHAN_HASH, timestamp: 1700000000, first_seen_at: '2026-11-13T14:24:08.181Z',
    miner_address: 't1Loser', coinbase_hex: null, previous_block_hash: 'b'.repeat(64),
    raw_size: 1629, raw_prefix: rawPrefix(1), observer_count: 9,
  } }));
  assert.equal(result.status, 200);
  assert.equal(result.body.isOrphaned, true);
  assert.equal(result.body.orphanSource, 'observers');
  assert.equal(result.body.observerCount, 9);
  assert.equal(result.body.transactionCount, 1);
  assert.equal(result.body.size, 1629);
  assert.equal(result.body.canonicalBlock.hash, 'e'.repeat(64));
  assert.deepEqual(result.body.transactions, []);
});

test('observer-only orphan with a pruned raw block reports unknown count and size, not zero', async () => {
  const result = await requestOrphanBlock(observerPool({ captured: {
    height: 100, hash: ORPHAN_HASH, timestamp: 1700000000, first_seen_at: null,
    miner_address: null, coinbase_hex: null, previous_block_hash: 'b'.repeat(64),
    raw_size: null, raw_prefix: null, observer_count: 2,
  } }));
  assert.equal(result.status, 200);
  assert.equal(result.body.transactionCount, null);
  assert.equal(result.body.size, null);
});

test('hash absent from blocks, orphans and observer captures is still 404', async () => {
  const result = await requestOrphanBlock(observerPool({ captured: null }));
  assert.equal(result.status, 404);
});

test('raw block transaction count parser handles short and multi-byte counts', () => {
  const { rawBlockTransactionCount } = blocksRouter;
  assert.equal(rawBlockTransactionCount(rawPrefix(4)), 4);
  assert.equal(rawBlockTransactionCount(Buffer.alloc(100)), null);
  assert.equal(rawBlockTransactionCount(null), null);
  const wide = Buffer.concat([Buffer.alloc(140), Buffer.from([0xfd, 0x40, 0x05]), Buffer.alloc(1344), Buffer.from([0xfd, 0x2c, 0x01])]);
  assert.equal(rawBlockTransactionCount(wide), 300);
});
