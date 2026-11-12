'use strict';
// Preserve the existing public-flow model, including its zero clamps. These
// are modeled USD amounts, not private note cost basis or owner profit.
function average(state) {
  return state.balance_zat > 0 ? state.realized_cap_usd / (state.balance_zat / 1e8) : 0;
}
function applyFlow(pools, row, price) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('Missing or invalid daily price');
  const amount = Number(row.amount_zat);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid shielded flow amount');
  const state = name => {
    if (typeof name !== 'string' || !/^[a-z]+$/.test(name)) throw new Error('Missing or invalid flow pool');
    if (!Object.hasOwn(pools, name)) pools[name] = { balance_zat: 0, realized_cap_usd: 0 };
    return pools[name];
  };
  const debit = pool => {
    pool.realized_cap_usd = Math.max(0, pool.realized_cap_usd - amount / 1e8 * average(pool));
    pool.balance_zat = Math.max(0, pool.balance_zat - amount);
  };
  if (row.is_pool_migration && row.migration_from_pool && row.migration_to_pool) {
    const source = state(row.migration_from_pool);
    const destination = state(row.migration_to_pool);
    const cost = amount / 1e8 * average(source);
    debit(source);
    destination.balance_zat += amount;
    destination.realized_cap_usd += cost;
  } else if (row.flow_type === 'shield') {
    const pool = state(row.pool);
    pool.balance_zat += amount;
    pool.realized_cap_usd += amount / 1e8 * price;
  } else if (row.flow_type === 'deshield') debit(state(row.pool));
  else throw new Error('Unknown shielded flow type');
  for (const pool of Object.values(pools)) {
    if (!Number.isSafeInteger(pool.balance_zat) || pool.balance_zat < 0 || !Number.isFinite(pool.realized_cap_usd) || pool.realized_cap_usd < 0) throw new Error('Invalid pool model state');
  }
}
module.exports = { average, applyFlow };
