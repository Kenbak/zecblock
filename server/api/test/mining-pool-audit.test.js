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
  // Luxor payout rotation: blocks 3522962 (old) and 3544044 (new), same tag bytes.
  ['t1XQZdZMnzXBcL8yx2PR27dSNrqctgwLgux', '04f09f8cb8102f4d696e6564206279204c75786f722f', 'Luxor'],
  ['t1TVdjqU1APVQmCRRnzbqfjz6wR2qtBnnoc', '04f09f8cb8102f4d696e6564206279204c75786f722f', 'Luxor'],
  [null, '04f09f8cb8102f4d696e6564206279204c75786f722f', 'Luxor'],
  // Print Crypto: payout and tag agree on blocks 3547300 and 3599314.
  ['t1W9ciLkpeRiXt8VXhcbyrppa3Un7Ka3n8t', '14f09fa6933a202f5072696e742043727970746f2f', 'Print Crypto'],
  [null, '14f09fa6933a202f5072696e742043727970746f2f', 'Print Crypto'],
  // miners.science solo blocks 3587184 and 3592285 (the latter with AuxPoW data after the tag).
  // Solo payouts go to each finder's own address, so only the tag names the pool.
  [null, '102f6d696e6572732e736369656e63652f', 'miners.science'],
  [null, '102f6d696e6572732e736369656e63652ffabe6d6d337d975dfcbc2fe9449ce721aebf28c8a1a261fb0821ef7d44aad55c4348253c01000000000000', 'miners.science'],
  // A bare CTRL tag (block 3597677) is not yet an established pool identity.
  ['t1QEksYGWyTaPVL3oV2hpW8PYnVu2ZdqySA', '0af09fa6933a204354524c', null],
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
    ['/Mined by Luxor/', 'luxor', 'Luxor'],
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

test('brands of one company share an operator and count once', () => {
  const { getPoolOperator, summarizeOperators } = require('../mining-pools');
  assert.equal(getPoolOperator('ViaBTC-Solo'), 'ViaBTC');
  assert.equal(getPoolOperator('ViaBTC'), 'ViaBTC');
  assert.equal(getPoolOperator('Foundry USA'), 'Foundry USA');
  assert.equal(getPoolOperator('Unknown'), null);
  // 7d mainnet shape from 22 Nov 2026: Foundry is the largest pool label,
  // ViaBTC's two labels together are the largest company.
  const pools = [
    { name: 'Foundry USA', blocks: 5114 }, { name: 'ViaBTC', blocks: 4447 },
    { name: 'F2Pool', blocks: 3671 }, { name: 'ViaBTC-Solo', blocks: 3259 },
    { name: 'Luxor', blocks: 2995 }, { name: 'Unknown', blocks: 290 },
  ];
  const total = 24190;
  const s = summarizeOperators(pools, total);
  assert.deepEqual(s.operators[0], { name: 'ViaBTC', blocks: 7706, pools: ['ViaBTC', 'ViaBTC-Solo'], share: 7706 / total });
  assert.equal(s.operators[1].name, 'Foundry USA');
  assert.equal(s.operators.length, 4);
  assert.equal(s.unattributedBlocks, 290);
  assert.equal(s.nakamotoCoefficient, 2, 'ViaBTC + Foundry = 12,820 of 24,190 blocks');
  // Unknown blocks never count towards a majority.
  assert.equal(summarizeOperators([{ name: 'Unknown', blocks: 90 }, { name: 'Luxor', blocks: 10 }], 100).nakamotoCoefficient, null);
  // Exactly half is not more than half.
  assert.equal(summarizeOperators([{ name: 'Luxor', blocks: 50 }, { name: 'F2Pool', blocks: 50 }], 100).nakamotoCoefficient, 2);
  assert.equal(summarizeOperators([], 0).nakamotoCoefficient, null);
});

test('distribution and ranking responses carry operators', async t => {
  const express = require('express');
  const app = express();
  app.locals.pool = { query: async () => ({ rows: [
    {miner_address:'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7',pool_tag:null,block_count:'4',total_fees_zat:'40',first_block_ts:'1',last_block_ts:'4'},
    {miner_address:'t1SqwRAAdSig6dE4EBPLonAait219VmkUjP',pool_tag:null,block_count:'5',total_fees_zat:'50',first_block_ts:'1',last_block_ts:'5'},
    {miner_address:'t1SEgZvXCu3ceE42qrq5pCeSq7HbLjX8NJv',pool_tag:null,block_count:'3',total_fees_zat:'30',first_block_ts:'1',last_block_ts:'3'},
    {miner_address:'unknown-other',pool_tag:null,block_count:'1',total_fees_zat:'10',first_block_ts:'2',last_block_ts:'2'},
  ] }) };
  app.use(require('../routes/mining'));
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/mining`;
  const dist = await (await fetch(`${base}/pool-distribution?period=24h`)).json();
  assert.equal(dist.pools[0].name, 'Foundry USA', 'pool rows stay per label');
  assert.equal(dist.pools.find(p => p.name === 'ViaBTC-Solo').operator, 'ViaBTC');
  assert.deepEqual(dist.operators.map(o => [o.name, o.blocks]), [['ViaBTC', 7], ['Foundry USA', 5]]);
  assert.equal(dist.unattributedBlocks, 1);
  assert.equal(dist.nakamotoCoefficient, 1, '7 of 13 blocks');
  const rank = await (await fetch(`${base}/pool-ranking?period=24h`)).json();
  assert.equal(rank.ranking.find(p => p.name === 'ViaBTC-Solo').operator, 'ViaBTC');
  assert.equal(rank.ranking.find(p => p.name === 'Unknown').operator, null);
});
