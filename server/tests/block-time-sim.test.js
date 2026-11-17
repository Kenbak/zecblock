'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const code = ts.transpileModule(fs.readFileSync(path.resolve('lib/block-time-sim.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = { exports: {} };
new Function('module', 'exports', 'require', code)(m, m.exports, require);
const sim = m.exports;

test('the random-arrival model reproduces every measured era within a point', () => {
  for (const era of sim.SIM_ERAS) {
    const t = era.meanSeconds;
    assert.ok(Math.abs(sim.shareAtLeast(t, 60) - era.shareAtLeast60) < 0.01, `${era.label} ≥60s`);
    assert.ok(Math.abs(sim.shareAtLeast(t, 120) - era.shareAtLeast120) < 0.01, `${era.label} ≥120s`);
    assert.ok(Math.abs(sim.shareAtLeast(t, 300) - era.shareAtLeast300) < 0.01, `${era.label} ≥300s`);
    // Daily longest gaps run a little above the model at slower targets; keep them within 10%.
    assert.ok(Math.abs(sim.typicalDailyLongest(t) / era.dailyLongestSeconds - 1) < 0.1, `${era.label} daily longest`);
  }
});

test('simulate gives the published 25s and 20s figures', () => {
  const now = sim.simulate(25, 10);
  assert.equal(now.spendableMean, 250);
  assert.equal(Math.round(now.spendableP90), 355);
  assert.equal(now.blocksPerDay, 3456);
  assert.deepEqual(now.orphans, { kind: 'measured', rate: 225 / (31096 + 225) });
  assert.equal(Math.round(now.orphansPerDay), 25);
  const proposed = sim.simulate(20, 10);
  assert.equal(sim.formatDuration(proposed.spendableMean), '3.3 min');
  assert.equal(sim.formatDuration(proposed.spendableP90), '4.7 min');
  assert.equal(sim.formatShare(proposed.shareAtLeast120), '1 in 403');
  assert.equal(proposed.orphans.kind, 'estimate');
  assert.ok(Math.abs(proposed.orphans.rate - 0.0090) < 0.0002);
  // Default depth is 3 blocks; unknown depths fall back to it.
  assert.equal(sim.simulate(25).spendableMean, 75);
  assert.equal(sim.simulate(20, 4).spendableMean, 80);
  assert.deepEqual(sim.DEPTH_OPTIONS.map(o => o.blocks), [2, 3, 4, 6, 10]);
  assert.equal(sim.simulate(20, 5).depth, 3);
  assert.equal(sim.simulate(20, 7).depth, 3);
  assert.equal(proposed.zone, 'extrapolated');
});

test('orphans: measured only at 25s, estimated 10–24s, no comparable data above, unknown below 10s', () => {
  assert.deepEqual(sim.orphanView(75), { kind: 'none', reason: 'unobserved' });
  assert.deepEqual(sim.orphanView(50), { kind: 'none', reason: 'unobserved' });
  assert.deepEqual(sim.orphanView(9), { kind: 'none', reason: 'beyond' });
  assert.deepEqual(sim.orphanView(150), { kind: 'none', reason: 'unobserved' });
  assert.equal(sim.simulate(5).orphansPerDay, null);
});

test('inputs are clamped to whole seconds in range', () => {
  assert.equal(sim.clampSeconds('abc'), 25);
  assert.equal(sim.clampSeconds('2'), 5);
  assert.equal(sim.clampSeconds(999), 150);
  assert.equal(sim.clampSeconds('19.6'), 20);
  assert.equal(sim.simZone(25), 'measured');
  assert.equal(sim.simZone(10), 'extrapolated');
  assert.equal(sim.simZone(9), 'beyond');
});
