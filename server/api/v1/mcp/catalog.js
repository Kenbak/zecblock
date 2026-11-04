'use strict';

const { z } = require('zod');

const cursor = z.string().min(1).max(4096).optional();
const limit = z.number().int().min(1).max(25).default(10);
const period = z.enum(['7d', '30d', '90d', '1y', 'all']).optional();
const hash = z.string().regex(/^[a-fA-F0-9]{64}$/);
/** @type {Array<[string, string, string, Record<string, import('zod').ZodType>, boolean?]>} */
const tools = [
  ['chain_info', '/v1/network/info', 'Current indexed chain height.', {}],
  ['blocks', '/v1/blocks', 'Recent canonical blocks. Continue with meta.page cursors.', { limit, cursor }],
  ['block', '/v1/blocks/:heightOrHash', 'One block by height or full hash, including canonical/orphan context.', { heightOrHash: z.union([z.number().int().min(0).max(999999999), hash]) }],
  ['transactions', '/v1/transactions', 'Recent public transaction records. Encrypted fields remain unavailable.', { limit, cursor }],
  ['transaction', '/v1/transactions/:txid', 'One transaction by its complete hash. Public facts do not reveal encrypted recipients or amounts.', { txid: hash }],
  ['mempool', '/v1/mempool', 'Observed pending transactions. This is a transient node observation.', {}],
  ['address', '/v1/addresses/:address', 'Public activity of a transparent address. Does not accept private or viewing keys.', { address: z.string().regex(/^t[123mn][1-9A-HJ-NP-Za-km-z]{33}$/), limit, cursor }],
  ['network_supply', '/v1/network/supply', 'Supply accounting with the source response units and availability.', {}],
  ['network_accounting', '/v1/network/accounting', 'Observed protocol fee, reserve and supply accounting. Unknown is not zero.', {}],
  ['network_fees', '/v1/network/fees', 'Observed network fees and their source-defined periods.', {}],
  ['network_halving', '/v1/network/halving', 'Network subsidy and halving schedule. Estimates are not confirmed activation times.', {}],
  ['pool_overview', '/v1/shielded-pools/overview', 'Public aggregate shielded-pool balances, not individual shielded balances.', {}],
  ['pool_history', '/v1/shielded-pools/history', 'Historical aggregate pool balances with source coverage.', { period }],
  ['pool_activity', '/v1/shielded-pools/activity', 'Pool involvement counts and shares. A transaction may involve multiple pools.', { period }],
  ['crosschain_analytics', '/v1/crosschain/analytics', 'Indexed NEAR 1Click analytics only; retain coverage and status exclusions.', { period }, true],
  ['crosschain_swaps', '/v1/crosschain/swaps', 'Indexed NEAR 1Click swaps; provider-observed outcomes are not a census of all venues.', { period, limit, cursor, direction: z.enum(['inflow', 'outflow']).optional() }, true],
  ['crosschain_venues', '/v1/crosschain/venues', 'Recent native-ZEC Maya or THORChain actions. A bounded provider feed, not complete indexed history or NEAR totals.', { venue: z.enum(['maya', 'thorchain']), limit, cursor: z.string().min(1).max(2048).optional() }, true],
  ['crosschain_venue_analytics', '/v1/crosschain/venues/analytics', 'Indexed Maya or THORChain history, flows, rankings and outcomes. Preserve traversal coverage and valuation basis.', { venue: z.enum(['maya', 'thorchain']), period }, true],
  ['crosschain_venue_swaps', '/v1/crosschain/venues/swaps', 'Indexed Maya or THORChain swap/refund actions with venue-bound pagination and exact full legs.', { venue: z.enum(['maya', 'thorchain']), period, limit, cursor, direction: z.enum(['inflow', 'outflow', 'internal']).optional() }, true],
  ['reorg_summary', '/v1/uncles/stats', 'Locally observed reorg and orphan statistics; retain observer/coverage limits.', {}],
];

function getTools(network) {
  return tools.filter(tool => !tool[4] || network === 'mainnet').map(([name, path, description, shape]) => ({
    name, path, description, schema: z.object(shape).strict(),
  }));
}

module.exports = { getTools };
