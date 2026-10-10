const assert = require('node:assert/strict');
const test = require('node:test');
const { getPoolName, getPoolTag } = require('../mining-pools');
const { pools } = require('../lib/mining-software');
const hex = text => Buffer.from(text).toString('hex');
const fixtures = [
  ['t1Y2tYgDJnH4m1uQPDXxvXQSh1Jbun3AP22', '15f09f8cb83a206d696e6564206279204b75506f6f6c', 'KuPool'],
  ['t1cQA9Rxn31tqHcgZzydrpDjgsQGmjpBgpB', '04f09f8cb8', 'Mining Dutch'],
  ['t1MqmXugaf5VSQvAVBhshK28S2kW762kNNH', '14f09fa6933a202f6d6f6c65706f6f6c2e636f6d2f', 'Molepool'],
  [null, '04f09f8cb87a65636d696e696e67706f6f6c2e636f6d', 'ZEC Mining Pool'],
  ['t1Na7ykQ6vE4CbxBPuUDUQx5n6aEWXu1VQq', '', null],
  ['t1egMFNkP7EfkK25y8s4GeiMkEGnqcMnTb1', '', 'Binance Pool'],
  ['tmTwLU5Y855hfBZ25ZaWuTvcrqjrCMFAZR9', hex('Foundry Zcash Pool #PrivacyMatters'), 'Foundry USA'],
];

test('node-checked October audit payouts and markers retain distinct identities', () => {
  for (const [address, tag, expected] of fixtures) assert.equal(getPoolName(address, tag), expected, address);
  assert.deepEqual(require('../../../lib/generated/mining-pools.json'), pools);
});

test('new markers require complete bytes and retain known-address precedence', () => {
  for (const [marker, tag, name] of [
    ['mined by KuPool', 'kupool', 'KuPool'],
    ['/molepool.com/', 'molepool', 'Molepool'],
    ['zecminingpool.com', 'zecminingpool', 'ZEC Mining Pool'],
    ['Foundry Zcash Pool #PrivacyMatters', 'foundry', 'Foundry USA'],
  ]) {
    const value = hex(marker);
    assert.equal(getPoolTag(`04${value.toUpperCase()}00`), tag);
    assert.equal(getPoolName(null, value), name);
    assert.equal(getPoolName('t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7', value), 'ViaBTC');
    for (const bad of [`0${value}0`, `${value}z`, value.slice(0,-2)]) assert.equal(getPoolTag(bad), null);
  }
  for (const text of ['KuPool', 'molepool.com', 'Mined by worker', '🌸', '🦓', 'zkcodexcoder']) {
    assert.equal(getPoolName(null, hex(text)), null, text);
  }
  assert.equal(getPoolName(null, hex('Mysolopool.com')), 'MySoloPool');
  assert.equal(getPoolName(null, hex('solopool.org')), null);
});

test('both snapshot jobs write corrected pool names and preserve exact tracked amounts', async () => {
  const { computeDay } = require('../../jobs/snapshot-mining-behavior');
  const { readDay } = require('../../jobs/snapshot-miner-destinations');
  const payoutFixtures = fixtures.filter(([address]) => address);
  const amount = '9007199254740993';
  const reader = { query: async sql => ({ rows: payoutFixtures.map(([address]) =>
    sql.includes('output_count')
      ? { miner_address:address,output_count:'1',total_earned:amount,total_spent:'1',spent_count:'1' }
      : sql.includes('COUNT(*) as blocks')
        ? { miner_address:address,blocks:'1' }
        : { miner_address:address,shielded:amount,exchange:'1',bridge:'2',other:'3' }) }) };
  const writes = [];
  await computeDay({ query: async (sql,args) => { if (sql.includes('INSERT')) writes.push(args); } }, '2026-10-09', reader);
  const destinations = await readDay(reader,'2026-10-09');
  for (const [address,,name] of payoutFixtures) {
    const expected = getPoolName(address) || 'Other';
    const count = BigInt(payoutFixtures.filter(([a]) => (getPoolName(a) || 'Other') === expected).length);
    const row = writes.find(r => r[1] === expected);
    assert.ok(row, expected);
    assert.equal(row[3],(BigInt(amount)*count).toString());
    assert.equal(row[5],((BigInt(amount)-1n)*count).toString());
    assert.equal(destinations[expected].shielded,BigInt(amount)*count);
    assert.equal(expected, name || 'Other');
  }
});

test('unknown distribution and ranking totals cannot masquerade as one payout address', async t => {
  const express = require('express');
  const app = express();
  app.locals.pool = { query: async () => ({ rows: [
    {miner_address:'t1Na7ykQ6vE4CbxBPuUDUQx5n6aEWXu1VQq',pool_tag:null,block_count:'2',total_fees_zat:'20',first_block_ts:'1',last_block_ts:'3'},
    {miner_address:'unknown-other',pool_tag:null,block_count:'1',total_fees_zat:'10',first_block_ts:'2',last_block_ts:'2'},
    {miner_address:null,pool_tag:'zecminingpool',block_count:'1',total_fees_zat:'10',first_block_ts:'3',last_block_ts:'3'},
  ] }) };
  app.use(require('../routes/mining'));
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
  for (const endpoint of ['pool-distribution','pool-ranking']) {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/mining/${endpoint}?period=7d`);
    assert.equal(response.status,200);
    const body=await response.json();
    const rows=body.pools || body.ranking;
    const unknown=rows.find(p=>p.name==='Unknown');
    assert.equal(unknown.blocks,3);
    assert.equal(unknown.address,null);
    assert.equal(unknown.totalFeesZat,'30');
    assert.equal(rows.find(p=>p.name==='ZEC Mining Pool').address,null);
  }
});
