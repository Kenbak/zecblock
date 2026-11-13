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
  assert.equal(card.detail, '74,106 ZEC of it sits in the development lockbox.');
  assert.equal(cards.issuedSupplyCard('mainnet', { data: [{ ...pools[0], monitored: false }] }), null);
});

test('fees state only a closed day and convert with the spot price', () => {
  const fees = { data: { daily: [{ date: '2026-11-02T23:00:00Z', median: 10000, txCount: 9000 }, { date: '2026-11-03T23:00:00Z', median: 50000, txCount: 10 }] } };
  const card = cards.feesCard('mainnet', fees, { data: { price: 1286.07 } });
  assert.equal(card.headline, '0.0001 ZEC');
  assert.match(card.caption, /\$0\.13/);
  assert.equal(cards.feesCard('mainnet', fees, null).caption, 'median fee');
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
  assert.equal(card.detail, '1,876 swaps · 52,332 ZEC in · 16,689 ZEC out');
  assert.equal(cards.venueCard('maya', venue({ coverage: { stale: true } })), null);
  assert.match(cards.venueCard('thorchain', venue({ coverage: { stale: false, earliest: '2026-10-20T00:00:00Z' } })).detail, /since Oct 20, 2026$/);
});

test('swap venues are ranked side by side and never summed', () => {
  const near = { data: venue({ summary: { ...venue().summary, volume_usd: '239111061.26', swaps: 25467 } }) };
  const thor = venue({ summary: { ...venue().summary, volume_usd: '1501296.95', swaps: 436 }, coverage: { stale: false, earliest: '2026-10-20T00:00:00Z' } });
  const card = cards.swapVenuesCard({ 'near-intents': near, maya: venue(), thorchain: thor });
  assert.equal(card.headline, 'NEAR Intents');
  assert.deepEqual(card.visual.rows.map(r => r.label), ['NEAR Intents', 'Maya', 'THORChain']);
  assert.match(card.detail, /not added together/);
  assert.match(card.detail, /THORChain since Oct 20, 2026/);
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
  assert.equal(card.detail, '2,590,760 blocks to go · estimated Mar 4, 2029');
  assert.equal(cards.halvingCard('mainnet', { data: { halvingStatus: 'unavailable' } }), null);
});

const utcDays = (count, end, row) => Array.from({ length: count }, (_, i) => ({ date: new Date(Date.parse(`${end}T00:00:00Z`) - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10), ...row(i) }));

test('net shielding sums seven closed days exactly and names the direction', () => {
  const points = utcDays(8, '2026-11-04', () => ({ shield: 100.1, deshield: 300.2, shieldTx: 10, deshieldTx: 20 }));
  points.at(-1).shield = 1e6; // today, still filling
  const card = cards.netShieldingCard('mainnet', { data: { points } }, NOW);
  assert.equal(card.headline, '1,401 ZEC');
  assert.equal(card.caption, 'net out of shielded pools over 7 days');
  assert.equal(card.detail, 'Oct 28 – Nov 3 UTC · public amounts only');
  assert.deepEqual(card.visual.rows.map(r => r.display), ['701 ZEC', '2,101 ZEC']);
  assert.deepEqual(card.visual.rows.map(r => r.label), ['Shielded', 'Unshielded']);
  const inward = cards.netShieldingCard('testnet', { data: { points: points.map(p => ({ ...p, shield: 500 })) } }, NOW);
  assert.equal(inward.headline, '1,399 TAZ');
  assert.match(inward.caption, /^net into shielded pools/);
  // A missing day, a missing amount or an old window is unavailable, never a smaller total.
  assert.equal(cards.netShieldingCard('mainnet', { data: { points: points.filter((_, i) => i !== 3) } }, NOW), null);
  assert.equal(cards.netShieldingCard('mainnet', { data: { points: points.map((p, i) => i === 2 ? { ...p, deshield: null } : p) } }, NOW), null);
  assert.equal(cards.netShieldingCard('mainnet', { data: { points } }, new Date('2026-11-20T00:00:00Z')), null);
});

test('activity cards use complete days and never add overlapping pools', () => {
  const points = utcDays(30, '2026-11-03', () => ({ totalTransactions: 1000, sprout: 0, sapling: 50, orchard: 20, ironwood: 600, complete: true }));
  const daily = cards.dailyTransactionsCard('mainnet', { data: { points } }, NOW);
  assert.equal(daily.headline, '1,000');
  assert.equal(daily.visual.bars.length, 28);
  assert.equal(daily.visual.bars.filter(b => b.highlight).length, 7);
  const pools = cards.shieldedByPoolCard('mainnet', { data: { points } }, NOW);
  assert.equal(pools.headline, '60.0%');
  assert.match(pools.caption, /used Ironwood$/);
  assert.deepEqual(pools.visual.rows.map(r => r.label), ['Ironwood', 'Sapling', 'Orchard'], 'an unused pool is omitted');
  assert.equal(pools.visual.kind, 'ranking');
  assert.match(pools.detail, /a transaction can use several pools$/);
  assert.deepEqual(pools.visual.rows.map(r => r.display), ['60.0%', '5.0%', '2.0%']);
  const incomplete = points.map((p, i) => i === 27 ? { ...p, complete: false } : p);
  assert.equal(cards.dailyTransactionsCard('mainnet', { data: { points: incomplete } }, NOW), null);
  assert.equal(cards.shieldedByPoolCard('mainnet', { data: { points: incomplete } }, NOW), null);
});

test('valuation cards need a current snapshot and every input', () => {
  const point = { date: '2026-11-03', lt1m: 3000, b1_3m: 2000, b3_6m: 1000, b6_12m: 1000, b1_2y: 1000, gt2y: 2000, total: 10000 };
  const dormant = cards.dormantSupplyCard({ data: { points: [{ ...point, date: '2026-11-02', gt2y: 0 }, point] } }, NOW);
  assert.equal(dormant.headline, '30.0%');
  assert.equal(dormant.detail, '3,000 ZEC of 10,000 ZEC · shielded coins not counted');
  assert.deepEqual(dormant.visual.rows.map(r => [r.label, r.display]), [['Under 3 months', '50.0%'], ['3–12 months', '20.0%'], ['1–2 years', '10.0%'], ['Over 2 years', '20.0%']]);
  assert.equal(cards.dormantSupplyCard({ data: { points: [{ ...point, b1_2y: null }] } }, NOW), null);
  assert.equal(cards.dormantSupplyCard({ data: { points: [{ ...point, date: '2026-10-20' }] } }, NOW), null, 'a stale snapshot is not current');

  const snapshot = { date: '2026-11-03', priceUsd: 963.5875, realizedPrice: 674.957606455734, mvrv: 1.4276266994898965 };
  const mvrv = cards.mvrvCard({ data: snapshot }, NOW);
  assert.equal(mvrv.headline, '1.43');
  assert.equal(mvrv.detail, 'Nov 3, 2026 · shielded cost basis is modelled');
  assert.deepEqual(mvrv.visual.rows.map(r => r.display), ['$963.59', '$674.96']);
  assert.equal(cards.mvrvCard({ data: { ...snapshot, realizedPrice: null } }, NOW), null);
  assert.equal(cards.mvrvCard({ data: { ...snapshot, date: '2026-10-01' } }, NOW), null);
  assert.ok(cards.factCardsFor('testnet').every(c => c.category !== 'Valuation'));
});

test('swap sources rank NEAR Intents inflows only and refuse a stale index', () => {
  const flows = [{ chain: 'eth', inflow_usd: '15856615.14' }, { chain: 'btc', inflow_usd: '9666847.55' }, { chain: 'zzz', inflow_usd: '0' }];
  const card = cards.swapSourcesCard({ data: venue({ flows }) });
  assert.equal(card.headline, 'Ethereum');
  assert.deepEqual(card.visual.rows.map(r => r.label), ['Ethereum', 'Bitcoin']);
  assert.equal(card.detail, '$64.3M swapped in via NEAR Intents in 30 days');
  assert.deepEqual(card.visual.rows.map(r => [r.display, r.logo]), [['$15.9M', '/chains/eth.png'], ['$9.7M', '/chains/btc.png']]);
  assert.equal(cards.swapSourcesCard({ data: venue({ flows, coverage: { stale: true } }) }), null);
  assert.equal(cards.swapSourcesCard({ data: venue({ flows: [...flows, { chain: 'sol' }] }) }), null, 'an unreadable chain could hide the leader');
});

test('mining software names a tagged leader and keeps untagged blocks in the total', () => {
  const categories = [{ software: 'unknown', label: 'No software tag', blocks: 500 }, { software: 'zakura', label: 'Zakura', blocks: 400 }, { software: 'zebra', label: 'Zebra', blocks: 100 }, { software: 'other', label: 'zcashd', blocks: 0 }];
  const card = cards.miningSoftwareCard('mainnet', { data: { totalBlocks: 1000, from: '2026-10-29', to: '2026-11-04', categories } });
  assert.equal(card.headline, '40.0%');
  assert.match(card.caption, /ran Zakura$/);
  assert.deepEqual(card.visual.rows.map(r => [r.label, r.color]), [['No tag', 'muted'], ['Zakura', 'gold'], ['Zebra', 'gold']]);
  assert.equal(card.detail, '1,000 blocks · Oct 29 – Nov 4 UTC · self-reported tags');
  assert.equal(cards.miningSoftwareCard('mainnet', { data: { totalBlocks: 1000, categories: [...categories, { software: 'missing', label: 'Tag data unavailable', blocks: 3 }] } }), null);
  assert.equal(cards.miningSoftwareCard('mainnet', { data: { totalBlocks: 500, categories: categories.slice(0, 1) } }), null);
});

test('orphan rate counts orphans against all observed blocks on closed days', () => {
  const days = utcDays(10, '2026-11-04', () => ({ canonicalBlocks: 990, orphanedBlocks: 10, partial: false }));
  days.at(-1).partial = true;
  days.at(-1).orphanedBlocks = 900;
  const card = cards.orphanRateCard('mainnet', { data: { days } }, NOW);
  assert.equal(card.headline, '1.00%');
  assert.equal(card.detail, '70 of 7,000 blocks our observers saw · Oct 28 – Nov 3 UTC');
  assert.equal(card.visual.bars.length, 9);
  assert.equal(cards.orphanRateCard('mainnet', { data: { days: days.slice(-4) } }, NOW), null);
});

test('chain size states the latest sample only while it is fresh', () => {
  const GIB = 1024 ** 3;
  const points = [{ time: '2026-10-05T12:00:00Z', sizeBytes: 262 * GIB, height: 3517427 }, { time: '2026-11-04T12:00:00Z', sizeBytes: 265 * GIB + GIB / 2, height: 3568621 }];
  const card = cards.chainSizeCard('mainnet', { data: { available: true, points } }, NOW);
  assert.equal(card.headline, '265.5 GiB');
  assert.equal(card.detail, 'Up 3.50 GiB in 30 days · measured on our node');
  assert.equal(cards.chainSizeCard('mainnet', { data: { available: false, points } }, NOW), null);
  assert.equal(cards.chainSizeCard('mainnet', { data: { available: true, points } }, new Date('2026-11-07T00:00:00Z')), null);
});

test('cards stay short enough to read at a glance', () => {
  assert.equal(cards.formatDayRange('2026-11-06', '2026-11-12'), 'Nov 6–12');
  assert.equal(cards.formatDayRange('2026-10-28', '2026-11-03'), 'Oct 28 – Nov 3');
  const pools = Array.from({ length: 9 }, (_, i) => ({ name: i === 0 ? 'ViaBTC' : `Pool ${i}`, blocks: 20 - i }));
  const mining = cards.miningPoolsCard('mainnet', { data: { totalBlocks: 200, pools } });
  assert.equal(mining.visual.rows.length, 4, 'a ranking lists four rows at most');
  assert.equal(mining.visual.rows[0].logo, '/brands/mining/viabtc.png');
  assert.equal(mining.visual.rows[1].logo, undefined, 'an unknown pool gets no logo rather than a wrong one');
  for (const card of [mining, cards.mvrvCard({ data: { date: '2026-11-03', priceUsd: 963.5875, realizedPrice: 674.95, mvrv: 1.43 } }, NOW), cards.venueCard('maya', venue())]) {
    assert.ok(card.caption.length <= 48, card.caption);
    assert.ok(card.detail.length <= 80, card.detail);
  }
});

test('card pool logos match the app pool logos', () => {
  const entries = file => [...fs.readFileSync(file, 'utf8').matchAll(/^\s+'?([a-z0-9]+)'?: '(\/brands\/mining\/[a-z0-9.-]+)',$/gm)].map(m => `${m[1]}=${m[2]}`).sort();
  const app = entries('components/PoolLogo.tsx');
  assert.ok(app.length >= 10);
  assert.deepEqual(entries('lib/pool-logos.ts'), app);
  for (const entry of app) assert.ok(fs.existsSync(path.join('public', entry.split('=')[1])), entry);
});
