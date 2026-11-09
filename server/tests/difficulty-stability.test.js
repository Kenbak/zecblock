const test = require('node:test');
const assert = require('node:assert/strict');
const { METHOD, compareEras, deviations, loadDifficultyStability, typicalDailyRange } = require('../api/lib/difficulty-stability');

const HOUR = 3600;
const DAY = 24 * HOUR;
const blocks = (count, spacing, difficulty, start = DAY * 10, height = 1000) => Array.from({ length: count }, (_, i) => (
  { height: height + i, timestamp: start + i * spacing, difficulty: typeof difficulty === 'function' ? difficulty(i) : difficulty }
));

test('deviation is measured against the exact centered 24-hour median', () => {
  const rows = blocks(4 * 48 + 1, 900, i => (i === 96 ? 150 : 100));
  const out = deviations(rows);
  const spike = out.find(row => row.height === 1096);
  assert.equal(spike.deviation, 50);
  assert.ok(out.filter(row => row.height !== 1096).every(row => row.deviation === 0));
});

test('blocks without a full 12 hours on each side are not evaluated', () => {
  const rows = blocks(4 * 24 + 1, 900, 100);
  const out = deviations(rows);
  assert.deepEqual(out.map(row => row.height), [1048]);
  assert.deepEqual(deviations([]), []);
});

test('non-monotonic header times stay inside the sliding window', () => {
  const rows = blocks(4 * 48 + 1, 900, 100);
  rows[50].timestamp -= 1800;
  const out = deviations(rows);
  assert.ok(out.length > 0);
  assert.ok(out.every(row => row.deviation === 0));
});

test('daily range uses only complete UTC days', () => {
  const partial = blocks(30, HOUR, 100, DAY * 10 + 12 * HOUR);
  assert.equal(typicalDailyRange(partial), null);
  const rows = blocks(3 * 24 + 1, HOUR, i => (i < 24 ? (i === 5 ? 200 : 100) : (i === 30 ? 110 : 100)), DAY * 10);
  assert.equal(typicalDailyRange(rows), 10);
});

function eras({ beforeValue = i => 100 + 40 * Math.sin(i / 6), afterValue = i => 100 + 10 * Math.sin(i / 6) } = {}) {
  const activationTimestamp = DAY * 30;
  const activationHeight = 100000;
  const beforeRows = blocks(14 * 96, 900, beforeValue, activationTimestamp - 14 * DAY, activationHeight - 14 * 96);
  const afterRows = blocks(4 * 96, 900, afterValue, activationTimestamp, activationHeight);
  return { beforeRows, afterRows, activationHeight, activationTimestamp, tipTimestamp: activationTimestamp + 4 * DAY - 900 };
}

test('eras stay separate and report the swing reduction', () => {
  const out = compareEras(eras());
  assert.equal(out.before.blocks > 0 && out.after.blocks > 0, true);
  assert.ok(out.before.lastHeight < 100000);
  assert.ok(out.after.firstHeight >= 100000);
  assert.ok(out.before.typicalSwingPct > out.after.typicalSwingPct);
  assert.equal(out.swingReduction, Math.round(out.before.typicalSwingPct / out.after.typicalSwingPct * 100) / 100);
  assert.ok(out.points.every(point => point.lowPct <= point.highPct));
  assert.deepEqual([...new Set(out.points.map(point => point.era))], ['before', 'after']);
});

test('the settling period after activation is excluded', () => {
  const out = compareEras(eras({ afterValue: i => (i < 24 ? 500 : 100) }));
  assert.equal(out.after.largestRisePct, 0);
  assert.equal(out.after.typicalSwingPct, 0);
  assert.ok(out.after.firstHeight >= 100000 + 72);
});

test('a flat after-era has no finite reduction factor', () => {
  assert.equal(compareEras(eras({ afterValue: () => 100 })).swingReduction, null);
});

test('missing and non-positive difficulty are counted rather than treated as zero', () => {
  const input = eras();
  input.afterRows[100].difficulty = null;
  input.afterRows[101].difficulty = 0;
  const out = compareEras(input);
  assert.equal(out.after.missingBlocks, 2);
  assert.equal(out.before.missingBlocks, 0);
});

test('too little post-activation history is unavailable', () => {
  const input = eras();
  input.afterRows = input.afterRows.slice(0, 30 * 4);
  input.tipTimestamp = input.activationTimestamp + 30 * HOUR;
  assert.equal(compareEras(input), null);
});

function fakePool(input) {
  return { query: async (sql, params) => {
    if (sql.includes('ORDER BY height DESC LIMIT 1')) return { rows: input.tip ? [input.tip] : [] };
    if (sql.includes('WHERE height = $1')) return { rows: input.activation ? [input.activation] : [] };
    return { rows: params[1] < input.activationHeight ? input.beforeRows : input.afterRows };
  } };
}
const mainSchedule = { network: 'main', nu7Height: 100000, eras: [{ height: 0, seconds: 75 }, { height: 100000, seconds: 25 }] };

test('testnet and schedules without NU7 are never compared', async () => {
  assert.deepEqual(await loadDifficultyStability({ pool: fakePool({}), schedule: { network: 'test', nu7Height: 5 } }), { available: false, reason: 'network-not-comparable', method: METHOD });
  assert.equal((await loadDifficultyStability({ pool: fakePool({}), schedule: { ...mainSchedule, nu7Height: null } })).reason, 'nu7-not-active');
  const tip = { height: '99999', timestamp: '1' };
  assert.equal((await loadDifficultyStability({ pool: fakePool({ tip }), schedule: mainSchedule })).reason, 'nu7-not-active');
});

test('string database values load into a mainnet comparison', async () => {
  const input = eras();
  const asStrings = rows => rows.map(row => ({ height: String(row.height), timestamp: String(row.timestamp), difficulty: String(row.difficulty) }));
  const last = input.afterRows[input.afterRows.length - 1];
  const out = await loadDifficultyStability({
    pool: fakePool({ ...input, beforeRows: asStrings(input.beforeRows), afterRows: asStrings(input.afterRows), tip: { height: String(last.height), timestamp: String(last.timestamp) }, activation: { timestamp: String(input.activationTimestamp) } }),
    schedule: mainSchedule, now: () => 0,
  });
  assert.equal(out.available, true);
  assert.equal(out.method, METHOD);
  assert.equal(out.network, 'mainnet');
  assert.deepEqual(out.activation, { height: 100000, timestamp: input.activationTimestamp });
  assert.equal(out.asOf, '1970-01-01T00:00:00.000Z');
});
