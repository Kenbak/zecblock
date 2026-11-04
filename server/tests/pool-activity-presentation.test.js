const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

const compiled = ts.transpileModule(fs.readFileSync('components/pools/pool-activity.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', compiled)(loaded.exports);
const { activityValue, poolActivityRows, activityNumber, selectedActivityPools, toggleActivityPool, poolActivitySummary } = loaded.exports;

const point = {
  date: '2026-10-25', totalTransactions: 10,
  sapling: 7, orchard: 0, ironwood: 8, sprout: 0, complete: true,
};

test('pool shares use all non-coinbase transactions and preserve overlap', () => {
  const [row] = poolActivityRows([point], 'share');
  assert.equal(row.sapling, 70);
  assert.equal(row.ironwood, 80);
  assert.equal(row.orchard, 0);
  assert.equal(row.sapling + row.ironwood, 150);
  assert.equal(poolActivityRows([point], 'count')[0].sapling, 7);
});

test('period percentage is a weighted share of period totals, not the average daily percentage', () => {
  const periodShare = activityValue(1 + 9, 2 + 90, 'share');
  assert.equal(periodShare, 10 / 92 * 100);
  assert.notEqual(periodShare, (50 + 10) / 2);
});

test('unavailable days remain gaps; zero transactions do not manufacture a zero percent', () => {
  const [missing] = poolActivityRows([{ ...point, complete: false }], 'count');
  assert.equal(missing.sapling, null);
  assert.equal(missing.ironwood, null);
  assert.equal(activityValue(0, 0, 'share'), null);
  assert.equal(activityValue(0, 0, 'count'), 0);
  assert.equal(activityValue(null, 10, 'count'), null);
  assert.equal(activityNumber(null, 'share'), '—');
  assert.equal(activityNumber(0, 'share'), '0%');
});

test('invalid observations cannot become plausible percentages or UTC dates', () => {
  for (const value of [-1, 11, NaN, Infinity, 0.5, '3']) assert.equal(activityValue(value, 10, 'share'), null);
  assert.deepEqual(poolActivityRows([{ ...point, date: 'invalid' }], 'count'), []);
  assert.equal(poolActivityRows([point], 'count')[0].x, Date.UTC(2026, 9, 25));
});

test('pool selection retains at least one series and restores canonical legend order', () => {
  const all = ['ironwood', 'orchard', 'sapling', 'sprout'];
  assert.deepEqual(toggleActivityPool(all, 'ironwood'), ['orchard', 'sapling', 'sprout']);
  const last = ['sapling'];
  assert.equal(toggleActivityPool(last, 'sapling'), last);
  assert.deepEqual(toggleActivityPool(last, 'ironwood'), ['ironwood', 'sapling']);
});

test('selected export series retain the original percentage denominator and only Ironwood carries recovery metadata', () => {
  const rows = poolActivityRows([point], 'share');
  const withoutIronwood = selectedActivityPools(['orchard', 'sapling', 'sprout']);
  assert.deepEqual(withoutIronwood.map(pool => pool.key), ['orchard', 'sapling', 'sprout']);
  assert.ok(withoutIronwood.every(pool => pool.marker === undefined && pool.strokeWidth === 2));
  assert.equal(rows[0].sapling, 70);
  assert.equal(rows[0].ironwood, 80);
  assert.equal(selectedActivityPools(['ironwood'])[0].marker, 'diamond');
  assert.equal(selectedActivityPools(['ironwood'])[0].strokeWidth, 3);
});

test('period summaries show count and network share in both modes without treating unavailable shares as zero', () => {
  assert.deepEqual(poolActivitySummary(6355, 220427, 'count'), { primary: '6,355', secondary: '2.88%' });
  assert.deepEqual(poolActivitySummary(6355, 220427, 'share'), { primary: '2.88%', secondary: '6,355 txs' });
  assert.deepEqual(poolActivitySummary(0, 100, 'count'), { primary: '0', secondary: '0%' });
  assert.deepEqual(poolActivitySummary(0, 0, 'count'), { primary: '0', secondary: '—' });
  assert.deepEqual(poolActivitySummary(0, 0, 'share'), { primary: '—', secondary: '0 txs' });
  assert.deepEqual(poolActivitySummary(null, null, 'count'), { primary: '—', secondary: '—' });
});
