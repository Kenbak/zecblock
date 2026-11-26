'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../lib/pool-sources');

const MINER = 't1MKn34KBa8Xh4g8qU8psibBXvURafphVn7'; // ViaBTC in the registry
const FUNDING = 't3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow';
const BINANCE = 't1SzbuFRuPa5upV6c9ZgKb9V7fxn2b8NAKg';
const USER = 't1ejN4MbrPtM8TSJ1aaj1aXnoaANFUZt3hv';
const ctx = { labels: new Map([[BINANCE, 'binance'], ['t1OtherExchangeHot', 'other:somex']]), funding: new Set(ps.FUNDING_ADDRESSES) };

const vb = (o = {}) => ({ sprout: 0n, sapling: 0n, orchard: 0n, ironwood: 0n, ...o });
const tx = (o) => ({ txid: 'a'.repeat(64), time: 1795598530, isCoinbase: false, fee: 10_000n, inputs: [], outputs: [], ...o, vb: vb(o.vb) });
const rowsOf = r => r.rows.map(x => [x.pool, x.direction, x.category, x.detail, x.amount]);

function poolNet(rows) {
  const net = {};
  for (const r of rows) net[r.pool] = (net[r.pool] || 0n) + (r.direction === 'in' ? r.amount : -r.amount);
  return net;
}

test('apportion is exact, proportional and breaks ties by entry order', () => {
  const split = ps.apportion(10n, [{ key: 'a', weight: 1n }, { key: 'b', weight: 1n }, { key: 'c', weight: 1n }]);
  assert.deepEqual([...split], [['a', 4n], ['b', 3n], ['c', 3n]]);
  assert.deepEqual([...ps.apportion(7n, [{ key: 'x', weight: 3n }, { key: 'y', weight: 0n }, { key: 'z', weight: 1n }])], [['x', 5n], ['z', 2n]]);
  assert.equal(ps.apportion(5n, [{ key: 'a', weight: 0n }]), null);
  assert.deepEqual([...ps.apportion(0n, [{ key: 'a', weight: 2n }])], [['a', 0n]]);
});

test('fillMatrix keeps both margins exactly', () => {
  const cells = ps.fillMatrix([{ key: 'r1', amount: 7n }, { key: 'r2', amount: 4n }], [{ key: 'c1', amount: 5n }, { key: 'c2', amount: 6n }]);
  const sum = (pick, key) => cells.filter(c => c[pick] === key).reduce((a, c) => a + c.amount, 0n);
  assert.equal(sum('row', 'r1'), 7n); assert.equal(sum('row', 'r2'), 4n);
  assert.equal(sum('col', 'c1'), 5n); assert.equal(sum('col', 'c2'), 6n);
});

test('a mining pool sweeping block rewards into Sapling is mining, attributed to the payout address', () => {
  const inputs = [0, 1, 2].map(() => ({ address: MINER, value: 41_666_668n, fromCoinbase: true, minerAddress: MINER }));
  const shielded = 3n * 41_666_668n - 10_000n;
  const r = ps.classify(tx({ inputs, vb: { sapling: -shielded } }), ctx);
  assert.deepEqual(rowsOf(r), [['sapling', 'in', 'mining', MINER, shielded]]);
  assert.equal(ps.detailLabel('mining', MINER), 'ViaBTC');
});

test('funding-stream rewards, other reward outputs, exchanges and plain transparent inputs are separate sources', () => {
  const inputs = [
    { address: FUNDING, value: 3_000n, fromCoinbase: true, minerAddress: FUNDING }, // registry wins over miner_address
    { address: 't3FoundersRewardAddr', value: 1_000n, fromCoinbase: true, minerAddress: MINER },
    { address: BINANCE, value: 4_000n, fromCoinbase: false },
    { address: 't1OtherExchangeHot', value: 1_000n, fromCoinbase: false },
    { address: USER, value: 1_000n, fromCoinbase: false },
  ];
  const r = ps.classify(tx({ fee: 0n, inputs, vb: { orchard: -10_000n } }), ctx);
  assert.deepEqual(rowsOf(r).sort(), [
    ['orchard', 'in', 'exchange', 'binance', 4_000n],
    ['orchard', 'in', 'exchange', 'other', 1_000n],
    ['orchard', 'in', 'funding', FUNDING, 3_000n],
    ['orchard', 'in', 'other_coinbase', 't3FoundersRewardAddr', 1_000n],
    ['orchard', 'in', 'transparent', '', 1_000n],
  ].sort());
});

test('mixed inputs with transparent change split the shielded amount by input value, exactly', () => {
  const inputs = [{ address: MINER, value: 300n, fromCoinbase: true, minerAddress: MINER }, { address: USER, value: 700n, fromCoinbase: false }];
  const r = ps.classify(tx({ fee: 1n, inputs, outputs: [{ address: USER, value: 499n }], vb: { sapling: -500n } }), ctx);
  assert.deepEqual(rowsOf(r), [['sapling', 'in', 'mining', MINER, 150n], ['sapling', 'in', 'transparent', '', 350n]]);
});

test('a Sapling to Ironwood migration is migration on both sides; the fee is a Sapling destination', () => {
  const r = ps.classify(tx({ vb: { sapling: 4_127_653_145_147n, ironwood: -4_127_653_135_147n } }), ctx);
  assert.deepEqual(rowsOf(r), [
    ['ironwood', 'in', 'migration', 'sapling', 4_127_653_135_147n],
    ['sapling', 'out', 'migration', 'ironwood', 4_127_653_135_147n],
    ['sapling', 'out', 'fee', '', 10_000n],
  ]);
});

test('deshielding splits the non-fee value across transparent outputs by destination', () => {
  const outputs = [{ address: BINANCE, value: 6_000n }, { address: USER, value: 3_990n }];
  const r = ps.classify(tx({ vb: { ironwood: 20_000n } , outputs, fee: 10_010n }), ctx);
  assert.deepEqual(rowsOf(r), [['ironwood', 'out', 'fee', '', 10_010n], ['ironwood', 'out', 'exchange', 'binance', 6_000n], ['ironwood', 'out', 'transparent', '', 3_990n]]);
});

test('a fully shielded same-pool transaction leaves only its fee', () => {
  const r = ps.classify(tx({ vb: { orchard: 15_000n }, fee: 15_000n }), ctx);
  assert.deepEqual(rowsOf(r), [['orchard', 'out', 'fee', '', 15_000n]]);
});

test('a shielded coinbase is coinbase; unresolved legs and fees are unknown; unknown balances are skipped', () => {
  assert.deepEqual(rowsOf(ps.classify(tx({ isCoinbase: true, fee: null, vb: { orchard: -156_250_000n } }), ctx)),
    [['orchard', 'in', 'coinbase', '', 156_250_000n]]);
  assert.deepEqual(rowsOf(ps.classify(tx({ inputs: [{ address: USER, value: null }], vb: { sapling: -9n } }), ctx)),
    [['sapling', 'in', 'unknown', '', 9n]]);
  assert.deepEqual(rowsOf(ps.classify(tx({ fee: null, vb: { sapling: 9n } }), ctx)), [['sapling', 'out', 'unknown', '', 9n]]);
  assert.deepEqual(ps.classify(tx({ vb: { sprout: null, sapling: -9n } }), ctx), { rows: [], skipped: 'unknown-value-balance' });
});

test('per pool, in minus out always equals the exact negated value balance', () => {
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 2000; i++) {
    const balances = {};
    for (const p of ps.POOLS) balances[p] = rand(3) === 0 ? BigInt(rand(2_000_000) - 1_000_000) : 0n;
    const inputs = Array.from({ length: rand(4) }, () => ({ address: [MINER, FUNDING, BINANCE, USER][rand(4)], value: BigInt(rand(500_000)), fromCoinbase: rand(2) === 0, minerAddress: MINER }));
    const outputs = Array.from({ length: rand(3) }, () => ({ address: [BINANCE, USER][rand(2)], value: BigInt(rand(500_000)) }));
    const t = tx({ isCoinbase: rand(10) === 0, fee: rand(5) === 0 ? null : BigInt(rand(20_000)), inputs, outputs, vb: balances });
    const r = ps.classify(t, ctx);
    const net = poolNet(r.rows);
    for (const p of ps.POOLS) assert.equal(net[p] || 0n, -balances[p], `pool ${p} case ${i}`);
    for (const row of r.rows) {
      assert.ok(row.amount > 0n);
      assert.ok((row.direction === 'in' ? ps.IN_CATEGORIES : ps.OUT_CATEGORIES).includes(row.category), row.category);
    }
  }
});

test('queries: periods are completed UTC days plus today so far; ranges, pools and granularity are validated', () => {
  const now = Date.parse('2026-11-26T11:00:00Z');
  assert.deepEqual(ps.parseQuery({ pool: 'sapling', period: '7d' }, now), { pool: 'sapling', period: '7d', from: '2026-11-19', to: '2026-11-26', granularity: 'day' });
  assert.equal(ps.parseQuery({ pool: 'ironwood', period: '1y' }, now).granularity, 'week');
  assert.deepEqual(ps.parseQuery({ pool: 'ironwood', period: 'all' }, now), { pool: 'ironwood', period: 'all', from: null, to: '2026-11-26', granularity: 'month' });
  assert.equal(ps.parseQuery({ pool: 'orchard', from: '2026-11-20', to: '2026-11-26' }, now).to, '2026-11-26');
  for (const bad of [{}, { pool: 'mixed' }, { pool: 'sapling', period: '24h' }, { pool: 'sapling', period: '7d', from: '2026-01-01' },
    { pool: 'sapling', from: '2026-02-30' }, { pool: 'sapling', to: '2026-01-01' }, { pool: 'sapling', granularity: 'hour' }, { pool: 'sapling', extra: '1' }]) {
    assert.throws(() => ps.parseQuery(bad, now), ps.PoolSourceQueryError, JSON.stringify(bad));
  }
  assert.equal(ps.bucketOf('2026-11-26', 'week'), '2026-11-23');
  assert.equal(ps.bucketOf('2026-11-26', 'month'), '2026-11-01');
});

test('real mainnet transactions: ViaBTC reward sweep into Sapling and a Sapling to Ironwood migration', () => {
  // 03e6b9a8…31ae (height 3,609,879): 50 ViaBTC block-reward outputs, no transparent outputs.
  const values = [41666668, 41715468, 41724948, 41716999, ...Array(9).fill(41666668), 41684926, ...Array(16).fill(41666668), 41677068,
    41666668, 42068232, ...Array(10).fill(41666668), 41674668, ...Array(5).fill(41666668), 41728668];
  assert.equal(values.length, 50);
  const inputs = values.map(v => ({ address: MINER, value: BigInt(v), fromCoinbase: true, minerAddress: MINER }));
  assert.equal(inputs.reduce((a, i) => a + i.value, 0n), 2_083_991_033n);
  assert.deepEqual(rowsOf(ps.classify(tx({ fee: 260_000n, inputs, vb: { sapling: -2_083_731_033n } }), ctx)),
    [['sapling', 'in', 'mining', MINER, 2_083_731_033n]]);
  // e7487b11…e8a (height 3,612,470): 1 ZEC Sapling -> Ironwood, fee 4,000 zat from Sapling.
  assert.deepEqual(rowsOf(ps.classify(tx({ fee: 4_000n, vb: { sapling: 100_004_000n, ironwood: -100_000_000n } }), ctx)), [
    ['ironwood', 'in', 'migration', 'sapling', 100_000_000n],
    ['sapling', 'out', 'migration', 'ironwood', 100_000_000n],
    ['sapling', 'out', 'fee', '', 4_000n],
  ]);
});
