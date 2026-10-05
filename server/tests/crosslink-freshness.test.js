const test = require('node:test');
const assert = require('node:assert/strict');
const { isCurrentCrosslinkBlockList } = require('../../lib/crosslink-freshness');
const healthy = { status: 'healthy', checks: { node: { status: 'up', db_height: 19620,
  durable_state_height: 19620, durable_observation_age_seconds: 1, rpc_to_durable_gap: 100 } } };
test('saved-state delay is expected only when the displayed list matches fresh indexing evidence', () => {
  assert.equal(isCurrentCrosslinkBlockList(healthy, 19620), true);
  assert.equal(isCurrentCrosslinkBlockList(healthy, 19000), false);
  assert.equal(isCurrentCrosslinkBlockList({ status: 'healthy' }, 19620), false);
  assert.equal(isCurrentCrosslinkBlockList({ ...healthy, status: 'degraded' }, 19620), false);
  for (const delta of [{ durable_observation_age_seconds: 61 }, { durable_observation_age_seconds: -1 },
    { durable_observation_age_seconds: null }, { rpc_to_durable_gap: 111 }, { rpc_to_durable_gap: -1 },
    { durable_state_height: 19720 }, { db_height: null }]) {
    assert.equal(isCurrentCrosslinkBlockList({ ...healthy, checks: { node: { ...healthy.checks.node, ...delta } } }, 19620), false);
  }
});
