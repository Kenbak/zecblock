// The list must match a fresh durable-state observation. A healthy live RPC
// alone cannot establish that a cached block list is current.
function isCurrentCrosslinkBlockList(health, height) {
  const node = health?.checks?.node;
  const blockHeight = typeof height === 'string' && /^[0-9]+$/.test(height) ? Number(height) : height;
  return health?.status === 'healthy' && node?.status === 'up'
    && Number.isSafeInteger(blockHeight) && Number.isInteger(node.db_height)
    && Number.isInteger(node.durable_state_height)
    && Math.abs(node.db_height - blockHeight) <= 3
    && Math.abs(node.db_height - node.durable_state_height) <= 3
    && Number.isFinite(node.durable_observation_age_seconds)
    && node.durable_observation_age_seconds >= 0 && node.durable_observation_age_seconds <= 60
    && Number.isInteger(node.rpc_to_durable_gap)
    && node.rpc_to_durable_gap >= 0 && node.rpc_to_durable_gap <= 110;
}
module.exports = { isCurrentCrosslinkBlockList };
