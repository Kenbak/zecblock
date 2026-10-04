/** Query constraints shared with the middleware that actually validates each source route. */
const { z } = require('zod');
const { schemas } = require('../../validation');
const routeSchemas = {
  '/v1/addresses/:address': 'addressById',
  '/v1/transactions/shielded-summary': 'shieldedTxs',
  '/v1/crosschain/trends': 'crosschainTrends',
  '/v1/crosschain/history': 'crosschainHistory',
  '/v1/crosschain/volume-by-chain': 'volumeByChain',
  '/v1/privacy/recommended-swap-amounts': 'recommendedAmounts',
  '/v1/privacy/risks': 'privacyRisks',
  '/v1/privacy/linkage-edges': 'privacyLinkageEdges',
  '/v1/privacy/batch-risks': 'privacyBatchRisks',
  '/v1/privacy/clusters': 'privacyBatchRisks',
  '/v1/transactions/:txid/linkability': 'txLinkability',
  '/v1/transparent/exposed': 'exposedAddresses',
};
const softwareFilters = {
  software: {type:'string',enum:['all','zebra','zakura','other','unknown','conflicting','missing'],default:'all',description:'Self-reported coinbase marker; unknown means unmarked, other means zcashd, missing means unavailable coinbase data.'},
  pool: {type:'string',enum:['all',...require('../../lib/mining-software').pools,'unattributed'],default:'all',description:'Mining-pool payout-address attribution, independent of software markers.'},
  order: {type:'string',enum:['newest','oldest','interval_asc','interval_desc','size_asc','size_desc','fees_asc','fees_desc','txs_asc','txs_desc'],default:'newest',description:'Sort the complete filtered dataset by height, parent interval, indexed size, fees or transaction count. Metric ties use height; unavailable values sort last. Cursor remains bound to every filter and order.'},
  from: {type:'string',format:'date',description:'Inclusive UTC date, YYYY-MM-DD. Mining software history requires period=custom.'},
  to: {type:'string',format:'date',description:'Inclusive UTC end date, YYYY-MM-DD. Mining software history requires period=custom.'},
  min_height: {type:'integer',minimum:0,maximum:2147483647,description:'Inclusive minimum canonical block height.'},
  max_height: {type:'integer',minimum:0,maximum:2147483647,description:'Inclusive maximum canonical block height.'},
  min_interval: {type:'integer',minimum:0,maximum:2147483647,description:'Inclusive minimum difference from the canonical parent timestamp in seconds.'},
  max_interval: {type:'integer',minimum:0,maximum:2147483647,description:'Inclusive maximum difference from the canonical parent timestamp in seconds.'},
  min_size: {type:'integer',minimum:0,maximum:2147483647,description:'Inclusive minimum indexed block size in bytes.'},
  max_size: {type:'integer',minimum:0,maximum:2147483647,description:'Inclusive maximum indexed block size in bytes.'},
  min_txs: {type:'integer',minimum:0,maximum:2147483647,description:'Inclusive minimum transaction count including coinbase.'},
  max_txs: {type:'integer',minimum:0,maximum:2147483647,description:'Inclusive maximum transaction count including coinbase.'},
  min_fees: {type:'number',minimum:0,maximum:21000000,description:'Inclusive minimum total transaction fees in ZEC (up to 8 decimal places).'},
  max_fees: {type:'number',minimum:0,maximum:21000000,description:'Inclusive maximum total transaction fees in ZEC (up to 8 decimal places).'},
  period: {type:'string',enum:['7d','30d','90d','1y','all','custom','since-zebra','since-zakura'],default:'30d',description:'UTC calendar-day range. Since presets begin on the first observed marker day, not the software launch.'},
  bucket: {type:'string',enum:['auto','day','week'],default:'auto',description:'Auto selects weekly for ranges longer than 121 days. Weekly buckets start Monday; boundary weeks contain only requested days.'},
};
function getQueryConstraint(route, name) {
  if (['/v1/crosschain/analytics','/v1/crosschain/swaps'].includes(route)) {
    const schemas = {
      period: {type:'string',enum:['24h','7d','30d','90d','1y','all'],default:'30d',description:'Trailing UTC window; all starts at the earliest indexed record. Coverage can be incomplete.'},
      granularity: {type:'string',enum:['hour','day'],description:'Defaults to hour for 24h/7d, day otherwise. Hour is only accepted for 24h/7d.'},
      direction: {type:'string',enum:['inflow','outflow','internal'],description:'Native ZEC asset acquired, exchanged or ZEC-to-ZEC. Asset direction does not prove an on-chain transfer.'},
      status: {type:'string',enum:['SUCCESS','FAILED','REFUNDED','PROCESSING','PENDING_DEPOSIT','INCOMPLETE_DEPOSIT']},
      chain: {type:'string',pattern:'^[a-z0-9_-]{1,32}$'}, token: {type:'string',maxLength:64},
      sourceAsset: {type:'string',maxLength:256,description:'Exact upstream originAsset identifier.'},
      destAsset: {type:'string',maxLength:256,description:'Exact upstream destinationAsset identifier.'},
      referral: {type:'string',maxLength:256,description:'Exact upstream referral value.'},
      search: {type:'string',maxLength:200,description:'Exact deposit, recipient or sender address, or source/destination transaction hash.'},
      minUsd: {type:'number',minimum:0,maximum:1e12,description:'Inclusive source-side USD minimum (up to 8 decimal places).'},
      maxUsd: {type:'number',minimum:0,maximum:1e12,description:'Inclusive source-side USD maximum (up to 8 decimal places).'},
      from: {type:'string',format:'date-time',description:'Inclusive UTC ISO timestamp, overrides the period start.'},
      to: {type:'string',format:'date-time',description:'Exclusive UTC ISO timestamp, fixes the end of the window.'},
      cursor: {type:'string',maxLength:8192,description:'Opaque data.nextCursor. Bound to filters and the original time window; do not construct or edit.'},
      limit: {type:'integer',minimum:1,maximum:100,default:25},
    };
    return schemas[name] ? {required:false,schema:schemas[name],description:schemas[name].description} : null;
  }
  if (route === '/v1/privacy/stats' && name === 'days') return { required: false, schema: { anyOf: [{type:'integer',minimum:7,maximum:1000},{type:'string',enum:['all']}], default:30 }, description:'All returns every retained daily observation without a row cap.' };
  if (route.startsWith('/v1/valuation/') && name === 'period') return { required:false, schema:{type:'string',enum:['30d','90d','180d','1y','2y','all'],default:'1y'}, description:'All returns the complete available daily history.' };

  if (route === '/v1/network/accounting/history') {
    if (name === 'period') return { required: false, schema: { type: 'string', enum: ['1d', '7d', '30d', 'all'] }, description: 'NU7-only UTC block-header periods; all means since activation. Cannot combine with limit/before. Returns aggregated buckets and exact period/since-activation totals; missing data is null.' };
    if (name === 'limit') return { required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 120 } };
    if (name === 'before') return { required: false, schema: { type: 'integer', minimum: 0, maximum: 499999999, description: 'Exclusive canonical block-height cursor.' } };
  }
  if (route === '/v1/network/block-time' && name === 'period') {
    const schema = { type: 'string', enum: ['6h', '24h', '7d'], default: '24h', description: 'Trailing block-header observation window.' };
    return { required: false, schema, description: schema.description };
  }
  if (route === '/v1/mining/hashrate-history') {
    const schema = name === 'window'
      ? { type: 'string', enum: ['24h', '7d'], default: '24h', description: 'Full trailing work-estimation window. Independent of chart range.' }
      : name === 'period' ? { type: 'string', enum: ['7d', '30d', '90d', '1y', 'all'], default: '90d', description: 'Range of historical samples ending at UTC midnight.' } : null;
    if (schema) return { required: false, schema, description: schema.description };
  }

  if(['/v1/blocks','/v1/mining/software'].includes(route) && softwareFilters[name]) return {required:false,schema:softwareFilters[name],description:softwareFilters[name].description};
  const field = schemas[routeSchemas[route]]?.query?.shape?.[name];
  if (!field) return null;
  const schema = z.toJSONSchema(field, { io: 'output', unrepresentable: 'any' });
  delete schema.$schema;
  return { required: !field.isOptional(), schema };
}
module.exports = { getQueryConstraint };
