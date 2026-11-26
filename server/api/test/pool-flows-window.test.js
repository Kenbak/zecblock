'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowWindowStart } = require('../routes/pools');

test('flow windows start at 00:00 UTC: N completed days plus today; today is since midnight', () => {
  const now = Date.parse('2026-11-26T18:30:00Z');
  const iso = p => new Date(flowWindowStart(p, now) * 1000).toISOString();
  assert.equal(iso('today'), '2026-11-26T00:00:00.000Z');
  assert.equal(iso('7d'), '2026-11-19T00:00:00.000Z');
  assert.equal(iso('30d'), '2026-10-27T00:00:00.000Z');
  assert.equal(iso('unknown'), '2026-10-27T00:00:00.000Z');
  assert.equal(flowWindowStart('all', now), 0);
  // Exactly at midnight, today starts now.
  assert.equal(new Date(flowWindowStart('today', Date.parse('2026-11-27T00:00:00Z')) * 1000).toISOString(), '2026-11-27T00:00:00.000Z');
});
