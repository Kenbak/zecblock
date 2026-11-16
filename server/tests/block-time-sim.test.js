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
  const now = sim.simulate(25);
  assert.equal(now.spendableMean, 250);
  assert.equal(Math.round(now.spendableP90), 355);
  assert.equal(now.blocksPerDay, 3456);
  assert.deepEqual(now.orphans, { kind: 'measured', rate: 76 / 36040 });
  const proposed = sim.simulate(20);
  assert.equal(sim.formatDuration(proposed.spendableMean), '3.3 min');
  assert.equal(sim.formatDuration(proposed.spendableP90), '4.7 min');
  assert.equal(sim.formatShare(proposed.shareAtLeast120), '1 in 403');
  assert.equal(proposed.orphans.kind, 'estimate');
  assert.ok(Math.abs(proposed.orphans.rate - 0.00265) < 0.0001);
  assert.equal(proposed.zone, 'extrapolated');
});

test('orphans: measured at eras, nothing between them, nothing below 10s, unobserved at 150s', () => {
  assert.equal(sim.orphanView(75).kind, 'measured');
  assert.deepEqual(sim.orphanView(50), { kind: 'none', reason: 'between' });
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
