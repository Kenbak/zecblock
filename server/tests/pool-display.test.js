const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', code)(m, m.exports, name => load(path.resolve(path.dirname(file), name + '.ts')));
  return m.exports;
}
const { poolAmount, formatPoolAmount, formatSupplySegmentAmount, poolDateAxis } = load('lib/pool-display.ts');
const { supplyMilestoneMarkers } = load('lib/zcash-milestones.ts');
const { buildTopLevelSegments, MAX_SUPPLY_ZAT } = load('components/pools/supply-treemap-layout.ts');
test('supply map values only issued ZEC while preserving the cap partition', () => {
  const segments = buildTopLevelSegments({
    transparent: 12_060_000 * 1e8, shielded: 4_955_000 * 1e8,
    chainSupply: 17_015_000 * 1e8,
    colors: { transparent: '', shielded: '', unmined: '' },
  });
  const [publicSupply, shielded, unmined] = segments;
  assert.equal(segments.reduce((sum, segment) => sum + segment.zat, 0), MAX_SUPPLY_ZAT);
  assert.equal(publicSupply.zat + shielded.zat, 17_015_000 * 1e8);
  assert.equal(formatSupplySegmentAmount(publicSupply, 'usd', 1317.10), '$15.88B');
  assert.equal(formatSupplySegmentAmount(shielded, 'usd', 1317.10), '$6.53B');
  for (const price of [1317.10, null, 0, NaN]) {
    assert.equal(formatSupplySegmentAmount(unmined, 'usd', price), 'Not issued');
  }
  assert.equal(formatSupplySegmentAmount(unmined, 'zec', null), '3.98M ZEC');
  assert.equal(formatSupplySegmentAmount(publicSupply, 'usd', null), '—');
  assert.equal(formatSupplySegmentAmount({ key: 'sprout', zat: 0 }, 'usd', 1317.10), '$0');
});
test('USD uses the same current rate for any balance; unavailable quotes never become zero or ZEC', () => {
  assert.equal(poolAmount(100, 'usd', 25), 2500);
  assert.equal(poolAmount(100, 'usd', 30), 3000);
  assert.equal(poolAmount(100, 'zec', null), 100);
  assert.equal(poolAmount(0, 'usd', 25), 0);
  for (const price of [null, 0, -1, Infinity, NaN]) {
    assert.equal(poolAmount(100, 'usd', price), null);
    assert.equal(formatPoolAmount(100, 'usd', price), '—');
  }
  assert.equal(formatPoolAmount(-15000, 'zec', null), '-15.0K ZEC');
  assert.equal(formatPoolAmount(1e6, 'usd', 1000), '$1B');
});
test('decade view uses sparse, unique calendar years at desktop and mobile widths', () => {
  const dates = ['2016-10-28', '2026-09-06'];
  const desktop = poolDateAxis(dates, 1100);
  const mobile = poolDateAxis(dates, 240);
  assert.ok(desktop.ticks.length >= 5 && desktop.ticks.length <= 12);
  assert.ok(mobile.ticks.length <= 3);
  assert.ok(mobile.ticks.length < desktop.ticks.length);
  assert.ok(desktop.ticks.every(t => /^20\d\d$/.test(desktop.format(t))));
  assert.equal(new Set(desktop.ticks.map(desktop.format)).size, desktop.ticks.length);
});
test('short ranges retain day/month; annual ranges include year; missing data has no ticks', () => {
  const short = poolDateAxis(['2026-08-01', '2026-08-30'], 800);
  assert.match(short.format(short.ticks[0]), /Aug/);
  assert.ok(short.ticks.length <= 9);
  const annual = poolDateAxis(['2025-09-01', '2026-09-01'], 800);
  assert.match(annual.format(annual.ticks[0]), /25/);
  assert.deepEqual(poolDateAxis([], 500).ticks, []);
});
test('activation markers use sample positions, skip out-of-range milestones and preserve exact dates', () => {
  const dates = ['2016-10-28', '2018-10-28', '2018-10-31', '2022-05-31', '2026-07-29'];
  const markers = supplyMilestoneMarkers(dates);
  const sapling = markers.find(m => m.id === 'sapling');
  assert.equal(sapling.date, '2018-10-29');
  assert.equal(sapling.index, 2);
  assert.equal(sapling.percent, 50);
  assert.equal(markers.find(m => m.id === 'ironwood').height, 3428143);
  assert.equal(markers.at(-1).index, 4);
  assert.deepEqual(supplyMilestoneMarkers(['2025-01-01', '2025-02-01']), []);
  assert.deepEqual(supplyMilestoneMarkers([]), []);
});
