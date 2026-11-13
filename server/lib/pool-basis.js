'use strict';
// Modeled shielded cost basis, one state per real shielded pool. Every
// transaction's per-pool value balances (positive = value leaving that pool,
// negative = value entering it, in zatoshis) are applied in chain order:
// - value leaving a pool takes that pool's average modeled cost with it;
// - value entering a pool is funded first by value leaving other pools in the
//   same transaction (pool-to-pool migrations keep their modeled cost), and
//   any remainder (transparent inputs, shielded coinbase) costs the UTC day
//   price. Leaving value that does not re-enter a pool (deshields, fees)
//   removes its modeled cost.
// These are modeled USD amounts, not private note cost basis or owner profit.
const POOLS = Object.freeze(['sprout', 'sapling', 'orchard', 'ironwood']);

function average(state) {
  return state.balance_zat > 0 ? state.realized_cap_usd / (state.balance_zat / 1e8) : 0;
}

function zat(value, column) {
  if (value === null || value === undefined) throw new Error(`Unknown ${column}`);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error(`Invalid ${column}`);
  return amount;
}

// Returns the zatoshis that left a pool beyond its modeled balance. With
// complete, canonical source data this is always zero; a positive value
// means the source is incomplete or out of order, and is reported upstream.
function applyTransaction(pools, row, price) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('Missing or invalid daily price');
  const changes = POOLS.map(pool => [pool, zat(row[`value_balance_${pool}`], `value_balance_${pool}`)]);
  const state = pool => {
    if (!Object.hasOwn(pools, pool)) pools[pool] = { balance_zat: 0, realized_cap_usd: 0 };
    return pools[pool];
  };
  let leftZat = 0, leftCost = 0, enteredZat = 0, shortfall = 0;
  for (const [pool, change] of changes) {
    if (change <= 0) continue;
    const current = state(pool);
    const amount = Math.min(change, current.balance_zat);
    shortfall += change - amount;
    const cost = current.balance_zat > 0 ? current.realized_cap_usd * (amount / current.balance_zat) : 0;
    current.balance_zat -= amount;
    current.realized_cap_usd = current.balance_zat > 0 ? Math.max(0, current.realized_cap_usd - cost) : 0;
    leftZat += change;
    leftCost += cost;
  }
  for (const [, change] of changes) if (change < 0) enteredZat -= change;
  if (enteredZat > 0) {
    const carriedZat = Math.min(enteredZat, leftZat);
    const carriedCost = leftZat > 0 ? leftCost * (carriedZat / leftZat) : 0;
    const totalCost = carriedCost + (enteredZat - carriedZat) / 1e8 * price;
    for (const [pool, change] of changes) {
      if (change >= 0) continue;
      const current = state(pool);
      current.balance_zat += -change;
      current.realized_cap_usd += totalCost * (-change / enteredZat);
    }
  }
  for (const current of Object.values(pools)) {
    if (!Number.isSafeInteger(current.balance_zat) || current.balance_zat < 0
      || !Number.isFinite(current.realized_cap_usd) || current.realized_cap_usd < 0) throw new Error('Invalid pool model state');
  }
  return shortfall;
}

module.exports = { POOLS, average, applyTransaction };
