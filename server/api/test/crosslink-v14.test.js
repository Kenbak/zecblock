const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const network = require('../../../lib/crosslink-network.json');
const { computeStakingDay, attachLocals, ANCHOR_HEIGHTS, KNOWN_REFERENCE_HASHES } = require('../routes/crosslink/_helpers');

test('v14 staking opens only at activation and respects window boundaries', () => {
  for (const height of [0, 10368, 20735]) {
    const day = computeStakingDay(height);
    assert.equal(day.isStakingOpen, false);
    assert.equal(day.blocksUntilNextWindow, 20736 - height);
  }
  assert.equal(computeStakingDay(20736).isStakingOpen, true);
  assert.equal(computeStakingDay(24191).blocksRemaining, 1);
  assert.equal(computeStakingDay(24192).isStakingOpen, false);
  assert.equal(computeStakingDay(31104).isStakingOpen, true);
});

test('fork comparison uses new genesis and cannot reuse old-network checkpoints', () => {
  assert.deepEqual(ANCHOR_HEIGHTS.map(a => a.height), [0]);
  assert.equal(KNOWN_REFERENCE_HASHES[0], network.genesisHash);
  assert.equal(KNOWN_REFERENCE_HASHES[655357], undefined);
});

test('PoW phase exposes unavailable finality; activation distinguishes missing and measured RPC finality', async () => {
  let height = 15000;
  let finality = { height: 0 };
  const app = express();
  app.locals.callZebraRPC = async method => method === 'getblockcount' ? height
    : method === 'get_tfl_final_block_height_and_hash' ? finality
      : method === 'get_tfl_recency_status' ? null : [];
  app.use(attachLocals, require('../routes/crosslink/stats'));
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async () => (await fetch(base+'/api/crosslink')).json();
    let body = await get();
    assert.equal(body.crosslinkActive, false);
    assert.equal(body.finalizedHeight, null);
    assert.equal(body.finalityGap, null);
    assert.equal(body.stakingDay.isStakingOpen, false);
    const tip = await (await fetch(base+'/api/crosslink/bft-tip')).json();
    assert.equal(tip.votedBlockHash, null);
    height = 36288; finality = null; body = await get();
    assert.equal(body.crosslinkActive, true);
    assert.equal(body.finalizedHeight, null);
    finality = { height: 36284 }; body = await get();
    assert.equal(body.finalizedHeight, 36284);
    assert.equal(body.finalityGap, 4);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('Crosslink deep health requires a fresh caught-up durable tip', async () => {
  const previous = process.env.NETWORK;
  process.env.NETWORK = 'crosslink';
  let durable = { height: '14900', age: '1' };
  const app = express();
  app.locals.pool = { query: async sql => ({ rows: sql.includes('last_seen_state_tip') ? (durable ? [durable] : []) : [] }) };
  app.locals.chainTip = { height: 14900 };
  app.locals.callZebraRPC = async () => 15000;
  app.use(require('../routes/blocks'));
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  try {
    const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/health/deep`)).json();
    assert.equal((await get()).status, 'healthy');
    durable.age = '61'; assert.equal((await get()).status, 'degraded');
    durable = { height: '14800', age: '1' }; assert.equal((await get()).status, 'degraded');
    durable = null; assert.equal((await get()).status, 'degraded');
    process.env.NETWORK = 'mainnet'; assert.equal((await get()).status, 'degraded');
  } finally {
    if (previous === undefined) delete process.env.NETWORK; else process.env.NETWORK=previous;
    await new Promise(resolve=>server.close(resolve));
  }
});
