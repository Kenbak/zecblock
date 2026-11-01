'use strict';
// Starter queries for the SQL workbench. Each one must pass the research SQL
// policy (tested) and illustrate a data rule: zatoshi units, bounded scans,
// missing values kept as NULL, or stocks that are never summed.
const sqlExamples=Object.freeze([
 {id:'monthly-fees',title:'Fees and transactions per month',extended:false,description:'Block-level totals for the last 12 months. Fees are zatoshis; divide by 100000000 for ZEC.',
  sql:`SELECT date_trunc('month', to_timestamp(timestamp)) AS month,
  sum(transactions) AS transactions,
  round(sum(fees)::numeric / 100000000, 4) AS fees_zec
FROM blocks
WHERE timestamp >= EXTRACT(EPOCH FROM date_trunc('month', current_date) - INTERVAL '12 months')::bigint
GROUP BY 1
ORDER BY 1`},
 {id:'payout-share',title:'Payout-address share of the last 1,000 blocks',extended:false,description:'Payout addresses are public coinbase recipients, not verified pool identities.',
  sql:`WITH recent AS (
  SELECT miner FROM blocks ORDER BY height DESC LIMIT 1000
)
SELECT miner,
  count(*) AS blocks,
  round(100.0 * count(*) / 1000, 2) AS share_pct
FROM recent
GROUP BY miner
ORDER BY blocks DESC
LIMIT 10`},
 {id:'pool-components',title:'Shielded components used per month',extended:false,description:'Counts transactions carrying each pool component. One transaction can use several.',
  sql:`SELECT date_trunc('month', to_timestamp(timestamp)) AS month,
  count(*) FILTER (WHERE orchard) AS orchard_txs,
  count(*) FILTER (WHERE ironwood) AS ironwood_txs,
  count(*) FILTER (WHERE sapling) AS sapling_txs,
  count(*) AS all_txs
FROM transactions
WHERE timestamp >= EXTRACT(EPOCH FROM date_trunc('month', current_date) - INTERVAL '6 months')::bigint
GROUP BY 1
ORDER BY 1`},
 {id:'largest-deshields',title:'Largest public deshields this week',extended:false,description:'Public boundary amounts only. Flow-history completeness is unverified.',
  sql:`SELECT txid, height,
  to_timestamp(timestamp) AS time,
  pool,
  amount::numeric / 100000000 AS zec
FROM flows
WHERE direction = 'deshield'
  AND timestamp >= EXTRACT(EPOCH FROM current_date - 7)::bigint
ORDER BY amount DESC NULLS LAST
LIMIT 20`},
 {id:'shielded-share',title:'Shielded share of daily activity',extended:true,description:'Weekly share from completed UTC days. Unclassified transactions stay in the total.',
  sql:`SELECT date_trunc('week', date::timestamp) AS week,
  sum(shielded_transactions) AS shielded,
  sum(transactions) AS total,
  round(100.0 * sum(shielded_transactions) / nullif(sum(transactions), 0), 2) AS shielded_pct
FROM activity_daily
WHERE date >= current_date - 90
GROUP BY 1
ORDER BY 1`},
 {id:'weekly-flows',title:'Weekly shielding vs deshielding',extended:true,description:'Amount is NULL for any week with a missing amount instead of an undercount.',
  sql:`SELECT date_trunc('week', date::timestamp) AS week,
  direction,
  sum(records) AS records,
  CASE WHEN sum(missing_amounts) > 0 THEN NULL
       ELSE round(sum(amount) / 100000000, 2) END AS zec
FROM flow_daily
WHERE date >= current_date - 84
GROUP BY 1, 2
ORDER BY 1, 2`},
 {id:'pool-close',title:'Month-end pool balances',extended:true,description:'Balances are stocks: take the last observed day per month, never a sum.',
  sql:`WITH ranked AS (
  SELECT date, orchard, ironwood, sapling,
    row_number() OVER (PARTITION BY date_trunc('month', date::timestamp) ORDER BY date DESC) AS position
  FROM daily
  WHERE date >= current_date - 365
)
SELECT date AS observed,
  round(orchard::numeric / 100000000, 2) AS orchard_zec,
  round(ironwood::numeric / 100000000, 2) AS ironwood_zec,
  round(sapling::numeric / 100000000, 2) AS sapling_zec
FROM ranked
WHERE position = 1
ORDER BY observed`},
 {id:'swap-chains',title:'Swap inflows by source chain, last 30 days',extended:true,description:'Tracked external swaps only. USD is NULL when any swap lacks a valuation.',
  sql:`SELECT chain,
  count(*) AS swaps,
  count(*) FILTER (WHERE usd IS NULL) AS unvalued,
  CASE WHEN count(*) FILTER (WHERE usd IS NULL) > 0 THEN NULL
       ELSE round(sum(usd), 2) END AS usd
FROM swaps
WHERE direction = 'inflow'
  AND timestamp >= current_date - 30
GROUP BY chain
ORDER BY swaps DESC
LIMIT 15`},
 {id:'supply-now',title:'Total and circulating supply',extended:true,datasets:['supply_daily'],description:'Latest completed UTC date. Supply columns are stocks: take a date, never a sum.',
  sql:`SELECT date,
  round(chain_supply::numeric / 100000000, 2) AS total_supply_zec,
  round(circulating_supply::numeric / 100000000, 2) AS circulating_supply_zec,
  round(lockbox::numeric / 100000000, 2) AS lockbox_zec
FROM supply_daily
ORDER BY date DESC
LIMIT 1`},
 {id:'issuance-split',title:'Yearly issuance split',extended:true,datasets:['issuance'],description:'Consensus block subsidy by recipient, current and previous three years. Bound issuance by timestamp: full history exceeds the interactive time limit. Sums are NULL after NU7, where issuance depends on chain state.',
  sql:`SELECT date_trunc('year', to_timestamp(timestamp)) AS year,
  round(sum(subsidy)::numeric / 100000000, 2) AS issued_zec,
  round(sum(miner_subsidy)::numeric / 100000000, 2) AS miner_zec,
  round(sum(founders + funding_streams)::numeric / 100000000, 2) AS dev_fund_zec,
  round(sum(lockbox)::numeric / 100000000, 2) AS lockbox_zec
FROM issuance
WHERE timestamp >= EXTRACT(EPOCH FROM date_trunc('year', current_date) - INTERVAL '3 years')::bigint
GROUP BY 1
ORDER BY 1`},
 {id:'pool-share-30d',title:'Mining pool shares, last 30 days',extended:true,datasets:['mining_daily'],description:'Blocks per attributed pool over completed UTC days. Unknown stays in the denominator; pool names are registry labels, not verified ownership.',
  sql:`WITH day_totals AS (
  SELECT date, max(day_blocks) AS day_blocks
  FROM mining_daily
  WHERE date >= current_date - 30
  GROUP BY date
), pool_totals AS (
  SELECT pool, sum(blocks) AS blocks
  FROM mining_daily
  WHERE date >= current_date - 30
  GROUP BY pool
)
SELECT pool, blocks,
  round(100.0 * blocks / (SELECT sum(day_blocks) FROM day_totals), 2) AS share_pct
FROM pool_totals
ORDER BY blocks DESC
LIMIT 15`},
 {id:'software-share-monthly',title:'Node software markers per month',extended:true,datasets:['software_daily'],description:'Share of blocks carrying each self-reported marker. unknown is no marker, not proof of zcashd.',
  sql:`SELECT date_trunc('month', date::timestamp) AS month,
  software,
  sum(blocks) AS blocks,
  round(100.0 * sum(blocks) / sum(sum(blocks)) OVER (PARTITION BY date_trunc('month', date::timestamp)), 2) AS share_pct
FROM software_daily
WHERE date >= current_date - 180
GROUP BY 1, 2
ORDER BY 1, blocks DESC`},
 {id:'timestamp-vs-first-seen',title:'Header time vs first seen, by payout address',extended:true,datasets:['block_timing'],description:'Last 7 completed UTC days. Lag mixes miner clock offset with propagation to ZecBlock; negative means the header time is ahead of the receipt.',
  sql:`SELECT miner,
  count(*) AS blocks,
  round(avg(lag_seconds), 1) AS avg_lag_s,
  min(lag_seconds) AS min_lag_s,
  max(lag_seconds) AS max_lag_s,
  count(*) FILTER (WHERE lag_seconds < 0) AS header_ahead
FROM block_timing
WHERE timestamp >= EXTRACT(EPOCH FROM current_date - 7)::bigint
  AND timestamp < EXTRACT(EPOCH FROM current_date)::bigint
GROUP BY miner
HAVING count(*) >= 10
ORDER BY abs(avg(lag_seconds)) DESC
LIMIT 15`},
 {id:'issuance-history',title:'Issuance split since launch',extended:true,datasets:['issuance_daily'],description:'Full-history yearly subsidy by recipient from one row per date. Sums are NULL after NU7, where issuance depends on chain state.',
  sql:`SELECT date_trunc('year', date::timestamp) AS year,
  round(sum(subsidy)::numeric / 100000000, 2) AS issued_zec,
  round(sum(miner_subsidy)::numeric / 100000000, 2) AS miner_zec,
  round(sum(founders + funding_streams)::numeric / 100000000, 2) AS dev_fund_zec,
  round(sum(lockbox)::numeric / 100000000, 2) AS lockbox_zec
FROM issuance_daily
GROUP BY 1
ORDER BY 1`},
 {id:'reorgs-weekly',title:'Reorgs per week',extended:true,datasets:['reorgs'],description:'Detected reorganisations and replaced blocks per week since logging began on 2026-07-17.',
  sql:`SELECT date_trunc('week', to_timestamp(detected_at)) AS week,
  count(*) AS reorgs,
  max(depth) AS max_depth,
  sum(orphans) AS orphaned_blocks
FROM reorgs
GROUP BY 1
ORDER BY 1`},
 {id:'orphan-rate-by-miner',title:'Orphan rate by payout address, last 30 days',extended:true,datasets:['blocks','orphaned_blocks'],description:'Orphaned over canonical plus orphaned blocks per payout address. Payout addresses are not verified pools.',
  sql:`WITH orphans AS (
  SELECT miner, count(*) AS orphaned
  FROM orphaned_blocks
  WHERE timestamp >= EXTRACT(EPOCH FROM current_date - 30)::bigint AND NOT canonical_now
  GROUP BY miner
), canonical AS (
  SELECT miner, count(*) AS canonical
  FROM blocks
  WHERE timestamp >= EXTRACT(EPOCH FROM current_date - 30)::bigint
  GROUP BY miner
)
SELECT o.miner, o.orphaned, coalesce(c.canonical, 0) AS canonical,
  round(100.0 * o.orphaned / (o.orphaned + coalesce(c.canonical, 0)), 2) AS orphan_rate_pct
FROM orphans o LEFT JOIN canonical c ON c.miner = o.miner
ORDER BY o.orphaned DESC
LIMIT 15`},
 {id:'swap-volume-by-venue',title:'Monthly swap volume by venue',extended:true,datasets:['swap_daily'],description:'Successful ZEC swaps per month, venue and direction, in whole ZEC and provider-reported USD.',
  sql:`SELECT date_trunc('month', date)::date AS month,
  venue,
  direction,
  sum(swaps) AS swaps,
  sum(zec) AS zec,
  sum(usd) AS usd,
  sum(missing_zec) AS missing_zec
FROM swap_daily
WHERE date >= DATE '2026-01-01'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3`},
 {id:'swap-top-chains-30d',title:'Top counterparty chains, last 30 days',extended:true,datasets:['swap_daily'],description:'Net ZEC flow (inflow minus outflow) per counterparty chain across tracked venues. Small groups appear as other.',
  sql:`SELECT chain,
  sum(swaps) AS swaps,
  sum(zec) FILTER (WHERE direction = 'inflow') AS zec_in,
  sum(zec) FILTER (WHERE direction = 'outflow') AS zec_out,
  sum(CASE direction WHEN 'inflow' THEN zec WHEN 'outflow' THEN -zec END) AS net_zec_in
FROM swap_daily
WHERE date >= current_date - 30
GROUP BY chain
ORDER BY swaps DESC
LIMIT 15`},
].map(Object.freeze));
// Examples for unpublished datasets wait with their dataset (research-catalogue).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {isPublished}=require('./research-catalogue');
const examplesFor=(extended,options)=>sqlExamples.filter(example=>(extended||!example.extended)&&(example.datasets||[]).every(id=>isPublished(id,options)));
module.exports={sqlExamples,examplesFor};
