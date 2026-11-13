'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../bot/lib/animated-card');
const { FPS, TEXT_STEP_FRAMES } = cards;

const NOW = new Date('2027-06-01T12:00:00Z');
const day = i => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const series = (count, row) => Array.from({ length: count }, (_, i) => ({ date: day(i), ...row(i) }));
const last = model => model.dates.length - 1;

const pools = (count = 400) => series(count, i => ({ sprout: 10, sapling: i, orchard: i >= 100 ? 5 : 0, ironwood: i >= 300 ? 1000 : 0, chainSupply: 100_000, hasPoolBreakdown: true }));

test('the replay shows real points in order and ends on the latest one', () => {
  const model = cards.poolGrowthModel({ data: { points: pools().reverse() } }, { seconds: 10, holdSeconds: 2 });
  const motion = 10 * FPS;
  assert.equal(model.frames.length, 12 * FPS);
  assert.equal(model.frames[0], 0);
  assert.ok(model.frames.every(Number.isInteger));
  assert.ok(model.frames.every((value, i) => i === 0 || value >= model.frames[i - 1]), 'time never runs backwards');
  assert.deepEqual([...new Set(model.frames.slice(motion - 1))], [399], 'the hold stays on the latest day');
  const changes = model.text.slice(0, motion - 1).filter((value, i, all) => i > 0 && value !== all[i - 1]).length;
  assert.ok(changes <= Math.ceil(motion / TEXT_STEP_FRAMES), 'numbers step slowly enough to read');
  assert.ok(model.text.every((value, i) => value <= model.frames[i]), 'text never runs ahead of the chart');
  assert.ok(model.text.slice(motion - 1).every(value => value === 399));
  assert.deepEqual([248_397, 999_499, 999_500, 2_543_971, 42_512_345, 742_512_345, 1_230_000_000, 812].map(cards.compact), ['248K', '999K', '1.00M', '2.54M', '42.5M', '743M', '1.23B', '812']);
});

test('pool growth states one day at a time and refuses incomplete history', () => {
  const model = cards.poolGrowthModel({ data: { points: pools() } });
  assert.equal(model.headline(399, true), '1,414 ZEC');
  assert.equal(model.caption(399, true), 'shielded · 1.4% of supply');
  assert.deepEqual(model.legend(50, false).map(item => item.label), ['Sprout', 'Sapling'], 'a pool joins the legend once it holds a balance');
  assert.deepEqual(model.legend(399, true).map(item => [item.label, item.value]), [['Sprout', '10'], ['Sapling', '399'], ['Orchard', '5'], ['Ironwood', '1,000']]);
  assert.equal(cards.poolGrowthModel({ points: pools() }, { network: 'testnet' }).headline(399, true), '1,414 TAZ');
  const full = pools();
  assert.equal(cards.poolGrowthModel({ data: { points: full.filter((_, i) => i !== 200) } }), null, 'a missing day');
  assert.equal(cards.poolGrowthModel({ data: { points: full.map((p, i) => i === 5 ? { ...p, hasPoolBreakdown: false } : p) } }), null);
  assert.equal(cards.poolGrowthModel({ data: { points: full.map((p, i) => i === 5 ? { ...p, orchard: null } : p) } }), null);
  assert.equal(cards.poolGrowthModel({ data: { points: full.slice(0, 10) } }), null);
  assert.equal(cards.poolGrowthModel({ success: false }), null);
  assert.equal(cards.poolGrowthModel(null), null);
});

test('software share is a 7-day share that names the tagged leader', () => {
  const history = series(100, i => ({ total: 100, counts: { zebra: i < 50 ? 60 : 20, zakura: i < 50 ? 0 : 70, other: 0, unknown: i < 50 ? 40 : 10, conflicting: 0, missing: 0 } }));
  const model = cards.softwareShareModel({ data: { bucket: 'day', history } }, {}, NOW);
  assert.equal(model.dates[0], day(20), 'the replay starts 30 days before the first Zakura tag');
  assert.equal(model.headline(0, true), '60.0%');
  assert.equal(model.caption(0), 'of blocks are tagged Zebra · 7-day share');
  assert.equal(model.headline(last(model), true), '70.0%');
  assert.equal(model.caption(last(model)), 'of blocks are tagged Zakura · 7-day share');
  assert.deepEqual(model.chart.series.map(s => s.key), ['zakura', 'zebra', 'other'], 'untagged blocks are not drawn as a series');
  assert.deepEqual(model.legend(last(model), true).map(item => [item.label, item.value]), [['Zakura', '70.0%'], ['Zebra', '20.0%'], ['No tag', '10.0%']]);
  assert.deepEqual(model.legend(0, false).map(item => item.label), ['Zebra', 'No tag']);
  const missing = history.map((row, i) => i === 80 ? { ...row, counts: { ...row.counts, missing: 3 } } : row);
  assert.equal(cards.softwareShareModel({ data: { bucket: 'day', history: missing } }, {}, NOW), null);
  assert.equal(cards.softwareShareModel({ data: { bucket: 'week', history } }, {}, NOW), null);
  // Today's partial day is left out.
  assert.equal(cards.softwareShareModel({ data: { bucket: 'day', history } }, {}, new Date(`${day(99)}T10:00:00Z`)).dates.at(-1), day(98));
});

test('swap flow is one venue, a running sum, and refuses a stale index', () => {
  const trends = series(60, i => ({ bucket: `${day(i)}T00:00:00.000Z`, inflow_usd: '1000000.5', outflow_usd: '2000000' })).filter((_, i) => i !== 20).map(row => { delete row.date; return row; });
  const payload = { data: { coverage: { stale: false }, trends } };
  const model = cards.swapFlowModel(payload, {}, NOW);
  assert.equal(model.eyebrow, 'Cross-chain · NEAR Intents');
  assert.equal(model.dates.length, 60, 'a day without swaps is a real zero');
  assert.equal(model.days[20].into, 0);
  assert.equal(model.headline(last(model), true), '$59.0M');
  assert.deepEqual(model.legend(last(model), true).map(item => item.value), ['$59.0M', '$118.0M']);
  assert.equal(model.caption(), 'swapped into ZEC via NEAR Intents');
  assert.equal(cards.swapFlowModel({ data: { coverage: { stale: true }, trends } }, {}, NOW), null);
  assert.equal(cards.swapFlowModel({ data: { coverage: { stale: false }, trends: trends.map((row, i) => i === 3 ? { ...row, inflow_usd: null } : row) } }, {}, NOW), null);
  assert.deepEqual(cards.ANIMATIONS.swaps.networks, ['mainnet']);
});

test('supply never falls and stays under the cap', () => {
  const supplyHistory = series(100, i => ({ date: `${day(i)}T23:59:59.000Z`, circulatingZat: (1_000_000 + i * 1000) * 1e8 }));
  const model = cards.supplyModel({ data: { supplyHistory } });
  assert.equal(model.headline(99, true), '1,099,000 ZEC');
  assert.equal(model.caption(99, true), 'issued · 5.2% of the 21M cap');
  assert.equal(model.chart.max, 21_000_000);
  assert.equal(cards.supplyModel({ data: { supplyHistory: supplyHistory.map((row, i) => i === 50 ? { ...row, circulatingZat: 1 } : row) } }), null, 'a drop is a source error');
  assert.equal(cards.supplyModel({ data: { supplyHistory: supplyHistory.map((row, i) => i === 99 ? { ...row, circulatingZat: 22_000_000 * 1e8 } : row) } }), null);
  assert.equal(cards.supplyModel({ data: { supplyHistory: supplyHistory.map((row, i) => i === 50 ? { ...row, circulatingZat: 1.5 } : row) } }), null);
});

test('shielded share and hashrate use trailing windows over closed days', () => {
  const daily = series(200, i => ({ shielded: i < 100 ? 10 : 30, transparent: i < 100 ? 90 : 70 }));
  const share = cards.shieldedShareModel({ data: { trends: { daily } } }, {}, NOW);
  assert.equal(share.dates[0], day(29));
  assert.equal(share.headline(0, true), '10.0%');
  assert.equal(share.headline(last(share), true), '30.0%');
  assert.equal(cards.shieldedShareModel({ data: { trends: { daily: daily.filter((_, i) => i !== 60) } } }, {}, NOW), null);

  const points = series(100, i => ({ windowStart: `${day(i)}T00:00:00.000Z`, windowEnd: `${day(i + 1)}T00:00:00.000Z`, hashrate: 2e9, unavailableReason: null })).map(row => { delete row.date; return row; });
  const hashrate = cards.hashrateModel({ data: { points } }, {}, NOW);
  assert.equal(hashrate.headline(last(hashrate)), '2.00 GSol/s');
  assert.equal(hashrate.dates[0], day(6));
  assert.equal(cards.hashrateModel({ data: { points } }, {}, new Date(`${day(99)}T12:00:00Z`)).dates.at(-1), day(98), 'an open window is left out');
  assert.equal(cards.hashrateModel({ data: { points: points.map((p, i) => i === 40 ? { ...p, unavailableReason: 'gap' } : p) } }, {}, NOW), null);
});

test('the pool race weights days by blocks and never ranks Unknown', () => {
  const rows = series(200, i => ({ totalBlocks: i < 100 ? 100 : 300, pools: i < 20 ? { Unknown: 1 } : { Unknown: 0.5, ViaBTC: i < 150 ? 0.3 : 0.1, F2Pool: i < 150 ? 0.2 : 0.4 } }));
  const model = cards.poolRaceModel({ data: { series: rows } }, {}, NOW);
  assert.ok(model.days.every(row => row.every(pool => pool.name !== 'Unknown')));
  assert.equal(model.dates[0], day(29), 'the replay starts once a pool is identified');
  assert.equal(model.headline(last(model)), 'F2Pool');
  assert.equal(model.caption(last(model), true), 'mines the most blocks · 40.0% over 30 days');
  // Day 100–129 mixes 100-block and 300-block days: the share follows blocks, not a mean of daily shares.
  const mixed = model.days[model.dates.indexOf(day(104))].find(pool => pool.name === 'ViaBTC');
  assert.ok(Math.abs(mixed.share - 30) < 1e-9);
  assert.equal(cards.poolRaceModel({ data: { series: rows.filter((_, i) => i !== 70) } }, {}, NOW), null);
});

test('every animation declares its source and networks', () => {
  for (const [id, animation] of Object.entries(cards.ANIMATIONS)) {
    assert.match(animation.path, /^\/v1\//, id);
    assert.equal(typeof animation.build, 'function', id);
    assert.ok(animation.networks.includes('mainnet'), id);
  }
});
