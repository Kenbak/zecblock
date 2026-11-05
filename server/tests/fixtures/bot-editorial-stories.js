'use strict';
const p = require('../../bot/lib/editorial-policy');
const { addDays } = require('../../lib/transaction-activity');
const target = '2026-09-30';
const rows = (prior, latest) => Array.from({ length: 31 }, (_, i) => ({ date: addDays(target, i - 30), value: i === 30 ? latest : prior }));
const flow = { amount_zat: '89999975000', sample_count: 10000, greater_count: 4, equal_count: 2, pool: 'ironwood', txid: 'a'.repeat(64),
  block_time: 1790812800, price_usd: 1483.2445, pool_zat: '406127848872798', transparent_zat: '1195344324374285' };
// 100 days of closes; the last day is the first at or above 4.25M ZEC in Ironwood.
const trend = Array.from({ length: 100 }, (_, i) => ({ date: addDays(target, i - 99), pool_size: String(Math.round((4.9e6 + i * 1000) * 1e8)),
  chain_supply: '1700000000000000', ironwood_pool_size: String(Math.round((i === 99 ? 4.26e6 : 3.9e6 + i * 2000) * 1e8)), price_usd: 1400 }));
const stories = [
  p.flowStory({ ...flow, flow_type: 'shield' }),
  p.flowStory({ ...flow, flow_type: 'deshield', pool: 'mixed', price_usd: null, pool_zat: null }),
  p.swapStory({ id: 1, source_amount_usd: 1500000, source_chain: 'zec', dest_chain: 'sol', sample_count: 10000, greater_count: 2, equal_count: 1, zec_txid: 'b'.repeat(64), swap_created_at: '2026-09-30T10:00:00Z' }),
  // Indexed venue swaps carry their own native-ZEC legs; the longest venue name stresses copy and card bounds.
  p.swapStory({ id: 'maya-swap-' + 'd'.repeat(64), venue: 'maya', source_amount_usd: '412345.67', source_chain: 'btc', dest_chain: 'zec',
    sample_count: 1900, greater_count: 3, equal_count: 0, canonical_identity: 'zec-abc', partial_return: false, direction: 'inflow',
    zec_legs: [{ side: 'out', txid: 'e'.repeat(64), address: 't1x', amountZat: '100000000000' }], swap_created_at: '2026-09-30T10:00:00Z' }),
  p.swapStory({ id: 'thorchain-swap-' + 'f'.repeat(64), venue: 'thorchain', source_amount_usd: '999999999', source_chain: 'zec', dest_chain: 'gaia',
    sample_count: 436, greater_count: 0, equal_count: 0, canonical_identity: 'zec-def', partial_return: false, direction: 'outflow',
    zec_legs: [{ side: 'in', txid: '1'.repeat(64), address: 't1y', amountZat: '100000000000' }], swap_created_at: '2026-09-30T10:00:00Z' }),
  p.dailyActivity({ days: rows(0,0).map((r,i) => ({ date:r.date, shielded:i===30?90:50, transparent:i===30?10:50, fully_shielded:20 })) }, target),
  p.weeklyActivity({ week: '2026-09-21', metadata: { period: { start: '2026-09-21', endExclusive: '2026-09-28' }, metrics: [{ noteworthy: true, metric: 'fully_shielded', value: 140321, rank: 12, tied: true, changePct: 102.3, weeksSince: 3, lastAtLeast: '2026-08-31' }] } }),
  p.hashStory({ method: 'target-work-v1', window: '7d', points: Array.from({ length: 31 }, (_, i) => ({ date: `${addDays('2026-10-01', i-30)}T00:00:00.000Z`, method: 'target-work-v1', windowSeconds: 604800, unavailableReason: null, hashrate: i===30?3e10:2e10 })) }, { target, genesisComplete: false }),
  ...['mvrv', 'exchange_deposit_zat', 'daily_fees_zat', 'shield_volume_zat', 'deshield_volume_zat'].map(metric => p.signalStory(metric, rows(metric==='mvrv'?2:1e11, metric==='mvrv'?3:3e11), target)),
  p.migrationStory({ txid: 'c'.repeat(64), amount_zat: '1000000000000', block_time: 1790812800, price_usd: 1420.17, ironwood_zat: '406127848872798', orchard_zat: '37893720330597' }),
  p.reorgStory({ id: 1, depth: 2, fork_height: 3500000, detected_at: '2026-09-30T10:00:00Z' }),
  p.crosschainStory({ inflow: '2000000', outflow: '3000000', largest: '1500000', top_route: 'zec -> sol', count: '40' }, target),
  ...p.milestoneStories(trend, target),
];
module.exports = stories;
