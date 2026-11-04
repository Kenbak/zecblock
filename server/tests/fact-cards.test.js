'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file) {
  const filename = path.resolve(file);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  const local = name => {
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name);
    const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(filename), name);
    if (fs.existsSync(`${base}.ts`)) return load(`${base}.ts`);
    return require(base);
  };
  new Function('module', 'exports', 'require', code)(m, m.exports, local);
  return m.exports;
}

const cards = load('lib/fact-cards.ts');
const NOW = new Date('2026-11-04T13:00:00Z');

test('every card is unique, categorized, searchable and links to a live page', () => {
  const ids = cards.FACT_CARDS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const card of cards.FACT_CARDS) {
    assert.ok(cards.CARD_CATEGORIES.includes(card.category), card.id);
    assert.match(card.href, /^\//);
    assert.ok(card.tags.length > 0 && card.description.endsWith('.'), card.id);
  }
  // Cross-chain indexes are mainnet only.
  assert.ok(cards.factCardsFor('testnet').every(c => c.category !== 'Cross-chain'));
  assert.deepEqual(cards.searchFactCards(cards.FACT_CARDS, 'thorchain', 'All').map(c => c.id).sort(), ['swap-venues', 'thorchain']);
  assert.deepEqual(cards.searchFactCards(cards.FACT_CARDS, 'HALVING countdown', 'Supply').map(c => c.id), ['halving']);
  assert.equal(cards.searchFactCards(cards.FACT_CARDS, 'privacy', 'Mining').length, 0);
});

test('zatoshi formatting stays exact and never reads unknown as zero', () => {
  assert.equal(cards.toZat(null), null);
  assert.equal(cards.toZat(1.5), null);
  assert.equal(cards.toZat('170233907905448').toString(), '170233907905448');
  assert.equal(cards.formatWholeCoins(BigInt('170233907905448'), 'ZEC'), '1,702,339 ZEC');
  assert.equal(cards.formatExactCoins(BigInt(10000), 'ZEC'), '0.0001 ZEC');
  assert.equal(cards.formatExactCoins(BigInt(156250000), 'TAZ'), '1.5625 TAZ');
});

test('shielded supply needs every pool balance and states the share exactly', () => {
  const current = { sprout: 1226669590712, sapling: 42148205158434, orchard: 32436166998613, ironwood: 421965171007932, transparent: 1197152753798789, shielded: 497776212755691, chainSupply: 1702339079054480 };
  const card = cards.shieldedSupplyCard('mainnet', { data: { current } });
  assert.equal(card.headline, '29.24%');
  assert.equal(card.visual.kind, 'split');
  assert.deepEqual(card.visual.rows.map(r => r.label), ['Ironwood', 'Orchard', 'Sapling', 'Sprout', 'Transparent']);
  assert.equal(cards.shieldedSupplyCard('mainnet', { data: { current: { ...current, ironwood: null } } }), null);
  assert.equal(cards.shieldedSupplyCard('mainnet', { success: false }), null);
});

test('shielded transaction share uses seven closed UTC days', () => {
  const daily = Array.from({ length: 9 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 26 + i)).toISOString().slice(0, 10), shielded: 1, transparent: 1 }));
  daily.push({ date: '2026-11-04', shielded: 1000, transparent: 0 });
  const card = cards.shieldedTransactionsCard('mainnet', { data: { trends: { daily } } }, NOW);
  assert.equal(card.headline, '50.0%', 'today’s partial day is excluded');
  assert.equal(card.visual.bars.filter(b => b.highlight).length, 7);
  assert.equal(cards.shieldedTransactionsCard('mainnet', { data: { trends: { daily: daily.slice(0, 3) } } }, NOW), null);
});

test('issued supply requires every monitored pool', () => {
  const pools = [{ id: 'transparent', chainValueZat: 1197038484126889, monitored: true }, { id: 'lockbox', chainValueZat: 7410581250000, monitored: true }];
  const card = cards.issuedSupplyCard('mainnet', { data: pools });
  assert.equal(card.headline, '12,044,491 ZEC');
  assert.match(card.detail, /74,106 ZEC in the development lockbox/);
  assert.equal(cards.issuedSupplyCard('mainnet', { data: [{ ...pools[0], monitored: false }] }), null);
});

test('fees state only a closed day and convert with the spot price', () => {
  const fees = { data: { daily: [{ date: '2026-11-02T23:00:00Z', median: 10000, txCount: 9000 }, { date: '2026-11-03T23:00:00Z', median: 50000, txCount: 10 }] } };
  const card = cards.feesCard('mainnet', fees, { data: { price: 1286.07 } });
  assert.equal(card.headline, '0.0001 ZEC');
  assert.match(card.caption, /\$0\.13/);
  assert.equal(cards.feesCard('mainnet', fees, null).caption, 'median fee paid');
});

const venue = (overrides = {}) => ({
  success: true, start: '2026-10-05T00:00:00Z', end: '2026-11-04T00:00:00Z',
  coverage: { stale: false, earliest: '2025-05-21T00:00:00Z' },
  summary: { swaps: 1876, volume_usd: '85108992.61', inflow_usd: '64270721.96', outflow_usd: '20838270.65', inflow_zec: '52332.07500783', outflow_zec: '16688.93651917' },
  ...overrides,
});

test('venue cards refuse stale indexes and flag partial coverage', () => {
  const card = cards.venueCard('maya', venue());
  assert.equal(card.headline, '$85.1M');
  assert.match(card.detail, /1,876 successful swaps · 52,332 ZEC swapped in · 16,689 ZEC swapped out\.$/);
  assert.equal(cards.venueCard('maya', venue({ coverage: { stale: true } })), null);
  assert.match(cards.venueCard('thorchain', venue({ coverage: { stale: false, earliest: '2026-10-20T00:00:00Z' } })).detail, /indexed from Oct 20, 2026/);
});

test('swap venues are ranked side by side and never summed', () => {
  const near = { data: venue({ summary: { ...venue().summary, volume_usd: '239111061.26', swaps: 25467 } }) };
  const thor = venue({ summary: { ...venue().summary, volume_usd: '1501296.95', swaps: 436 }, coverage: { stale: false, earliest: '2026-10-20T00:00:00Z' } });
  const card = cards.swapVenuesCard({ 'near-intents': near, maya: venue(), thorchain: thor });
  assert.equal(card.headline, 'NEAR Intents');
  assert.deepEqual(card.visual.rows.map(r => r.label), ['NEAR Intents', 'Maya', 'THORChain']);
  assert.match(card.detail, /not added together/);
  assert.match(card.detail, /THORChain indexed from Oct 20, 2026/);
  assert.doesNotMatch(JSON.stringify(card), /\$325/, 'no combined total');
  // Without the largest venue, "Maya led" would be false.
  assert.equal(cards.swapVenuesCard({ maya: venue(), thorchain: thor }), null);
});

test('mining and hashrate ignore unknown leaders and open windows', () => {
  const pools = cards.miningPoolsCard('mainnet', { data: { totalBlocks: 100, pools: [{ name: 'Unknown', blocks: 40 }, { name: 'ViaBTC', blocks: 30 }] } });
  assert.equal(pools.headline, '30.0%');
  assert.match(pools.caption, /ViaBTC/);
  const points = [{ hashrate: 30e9, windowEnd: '2026-11-03T00:00:00Z' }, { hashrate: 1e9, windowEnd: '2026-11-05T00:00:00Z' }];
  assert.equal(cards.hashrateCard('mainnet', { data: { points } }, NOW).headline, '30.0 GSol/s');
});

test('the halving card uses the schedule estimate', () => {
  const card = cards.halvingCard('mainnet', { data: { halvingStatus: 'available', halvingBlock: 6132390, blocksRemaining: 2590760, eraStartBlock: 2726400, eraProgress: 48.5, estimatedSeconds: 73505450, estimatedDate: '2029-03-04T07:47:50Z' } });
  assert.equal(card.headline, '851 days');
  assert.match(card.detail, /2,590,760 blocks to go · block #6,132,390 · around Mar 4, 2029/);
  assert.equal(cards.halvingCard('mainnet', { data: { halvingStatus: 'unavailable' } }), null);
});
