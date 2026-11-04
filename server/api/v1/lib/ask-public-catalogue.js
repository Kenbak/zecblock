'use strict';

// Operator/planning catalogue only. This does not extend runtime reader grants,
// the model's v2 contract, or the HTTP API's accepted datasets.
const field = (type, unit, meaning) => ({ type, unit, meaning });
const epoch = meaning => field('integer', 'unix_seconds', meaning);
const zat = meaning => field('integer_or_numeric', 'zatoshi', meaning);
const count = meaning => field('integer', 'count', meaning);
const text = meaning => field('text', 'identifier_or_category', meaning);
const bool = meaning => field('boolean', 'boolean', meaning);
const catalogue = {
  version: 1,
  status: 'operator_inventory_not_public_query_contract',
  network: 'mainnet',
  money: 'Preserve integer/decimal storage values; format 100000000 zatoshis as 1 ZEC only at display boundaries.',
  sources: [
    { id: 'blocks', relation: 'public.blocks', grain: 'one current canonical block', key: ['height'], currentView: 'ask_public.blocks_v2', coverage: 'audit_required', fields: {
      height: count('Canonical chain height'), hash: text('Canonical block hash'), timestamp: epoch('Block header timestamp'), transaction_count: count('Block transactions including coinbase'), size: field('integer', 'bytes', 'Block size'), total_fees: zat('Public transaction fees'), miner_address: text('Attributed miner payout address; not a mining-pool name'),
    } },
    { id: 'transactions', relation: 'public.transactions', grain: 'one confirmed transaction', key: ['txid'], currentView: 'ask_public.transactions_v2', coverage: 'audit_required', fields: {
      txid: text('Transaction hash'), block_height: count('Block height'), block_hash: text('Block hash; match height and hash to canonical blocks'), block_time: epoch('Indexed block timestamp'), is_coinbase: bool('Coinbase flag; current Ask view excludes coinbase'), fee: zat('Transaction fee, counted once per transaction'), size: field('integer', 'bytes', 'Transaction size'), has_sapling: bool('Contains Sapling component'), has_orchard: bool('Contains Orchard component'), has_ironwood: bool('Contains Ironwood component'), has_sprout: bool('Contains Sprout component'), value_balance_orchard: zat('Signed public Orchard value balance; not a private payment amount'), value_balance_ironwood: zat('Signed public Ironwood value balance; not a private payment amount'),
    } },
    { id: 'flows', relation: 'public.shielded_flows', grain: 'one transaction/direction public boundary observation', key: ['txid', 'flow_type'], currentView: 'ask_public.flows_v2', coverage: 'historical_backfill_unverified', fields: {
      txid: text('Transaction hash'), block_height: count('Block height'), block_time: epoch('Boundary observation block timestamp'), flow_type: text('shield or deshield'), pool: text('Pool classification; mixed is possible'), amount_zat: zat('Public boundary amount; not shielded internal transfer volume'),
    } },
    { id: 'daily', relation: 'public.privacy_trends_daily', grain: 'one maintained UTC day', key: ['date'], currentView: 'ask_public.daily_v2', coverage: 'audit_required', fields: {
      date: field('date', 'utc_day', 'Completed UTC day for Ask'), shielded_count: count('Non-coinbase shielded-component transaction count'), transparent_count: count('Non-coinbase transparent-only transaction count'), orchard_pool_size: zat('Orchard closing observation; stock, never sum over dates'), ironwood_pool_size: zat('Ironwood closing observation; stock, never sum over dates'), sapling_pool_size: zat('Sapling closing observation; stock, never sum over dates'), sprout_pool_size: zat('Sprout closing observation; stock, never sum over dates'),
    } },
    { id: 'swaps', relation: 'public.cross_chain_swaps', grain: 'one tracked provider swap record', key: null, currentView: 'ask_public.swaps_v2', coverage: 'provider_completeness_unverified', fields: {
      status: text('Only SUCCESS enters current Ask'), source_chain: text('Source chain'), dest_chain: text('Destination chain'), source_token: text('Source token'), dest_token: text('Destination token'), source_amount_usd: field('numeric', 'usd', 'Reported source valuation; legacy zero sentinel is unavailable'), dest_amount_usd: field('numeric', 'usd', 'Reported destination valuation; legacy zero sentinel is unavailable'), swap_created_at: field('timestamptz', 'utc_instant', 'Provider creation time; not an observed execution time'),
    } },
    { id: 'inputs', relation: 'public.transaction_inputs', grain: 'one transparent transaction input', key: ['txid', 'vout_index'], currentView: null, coverage: 'audit_required', fields: {
      txid: text('Spending transaction hash'), vout_index: count('Input position, despite legacy column name'), prev_txid: text('Previous output transaction hash; nullable for coinbase'), prev_vout: count('Previous output index'), address: text('Derived transparent address, possibly NULL'), value: zat('Public input amount, possibly NULL'),
    } },
    { id: 'outputs', relation: 'public.transaction_outputs', grain: 'one transparent transaction output', key: ['txid', 'vout_index'], currentView: null, coverage: 'audit_required', fields: {
      txid: text('Creating transaction hash'), vout_index: count('Output position'), address: text('Derived transparent address; some script outputs are addressless'), value: zat('Public output amount, possibly NULL'), script_type: text('Decoded public output script category'), spent: bool('Maintained spend status; validate before publishing'), spent_txid: text('Spending transaction hash, if observed'),
    } },
    { id: 'address_activity', relation: 'public.address_transactions', grain: 'one address/transaction incidence', key: ['address', 'block_height', 'tx_index', 'txid'], currentView: null, coverage: 'canonical_reconciliation_audit_required', fields: {
      address: text('Transparent address; not a user'), txid: text('Transaction hash'), block_height: count('Block height'), tx_index: count('Transaction position'), block_time: epoch('Indexed block timestamp'), is_input: bool('Address appears in transaction inputs'), is_output: bool('Address appears in transaction outputs'), value_in: zat('Amount spent from address'), value_out: zat('Amount received by address'),
    } },
    { id: 'addresses', relation: 'public.addresses', grain: 'one maintained address summary', key: ['address'], currentView: null, coverage: 'summary_reconciliation_audit_required', fields: {
      address: text('Address identifier; not a person'), address_type: text('Filter to transparent; chain cannot enumerate shielded addresses'), balance: zat('Maintained current balance; not historical balance'), first_seen: epoch('Earliest indexed activity; not necessarily first funding'), last_seen: epoch('Latest indexed activity'), tx_count: count('Maintained transaction incidence count'), total_received: zat('Maintained public receipts'), total_sent: zat('Maintained public spends'),
    } },
  ],
  joins: [
    { from: 'transactions', to: 'blocks', cardinality: 'many_to_one', pairs: [['block_height', 'height'], ['block_hash', 'hash']], rule: 'Both comparisons required for canonical membership.' },
    { from: 'flows', to: 'transactions', cardinality: 'many_to_one', pairs: [['txid', 'txid'], ['block_height', 'block_height']], rule: 'Also validate canonical block and matching block timestamp. Aggregate/select direction before counting transactions or fees.' },
    { from: 'inputs', to: 'transactions', cardinality: 'many_to_one', pairs: [['txid', 'txid']], rule: 'Preserve input grain; include coinbase explicitly when required.' },
    { from: 'outputs', to: 'transactions', cardinality: 'many_to_one', pairs: [['txid', 'txid']], rule: 'Preserve output grain; do not multiply values through an input/output fanout.' },
    { from: 'inputs', to: 'outputs', cardinality: 'many_to_one', pairs: [['prev_txid', 'txid'], ['prev_vout', 'vout_index']], rule: 'Nullable previous output means unavailable, never invented zero.' },
    { from: 'address_activity', to: 'transactions', cardinality: 'many_to_one', pairs: [['txid', 'txid'], ['block_height', 'block_height']], rule: 'Prove canonical membership through transactions/blocks; one transaction may affect several addresses.' },
    { from: 'address_activity', to: 'addresses', cardinality: 'many_to_one', pairs: [['address', 'address']], rule: 'Summary freshness and history reconciliation must be verified separately.' },
  ],
  excluded: ['operational/account tables', 'provider payloads and secrets', 'private shielded contents', 'unreviewed address labels or linkage claims'],
};

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
module.exports = freeze(catalogue);
