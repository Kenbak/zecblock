#!/usr/bin/env node
'use strict';
const {loadEnv}=require('../lib/job-utils');
const {getPool}=require('../lib/db-pool');
// Small aggregate tables only; no full-chain scan in a health check.
const TABLES=['privacy_trends_daily','zec_price_daily','utxo_age_daily','miner_destination_daily','mvrv_daily','analytics_history_daily','transparent_realized_cap_daily','pool_realized_cap_daily'];
function freshnessHealthy(datasets) {
 return TABLES.every(table=>{const d=datasets[table];return d&&d.count>0&&d.interior_missing===0&&Number.isInteger(d.stale_days)&&d.stale_days>=0&&d.stale_days<=1;});
}
async function report(db) {
 const result={checkedAt:new Date().toISOString(),datasets:{}};
 for(const table of TABLES) {
  const {rows:[r]}=await db.query(`WITH clock AS (SELECT (now() AT TIME ZONE 'UTC')::date today), days AS (SELECT DISTINCT date FROM ${table},clock WHERE date<today), bounds AS (SELECT MIN(date) first,MAX(date) last,COUNT(*) count FROM days)
 SELECT first::text,last::text,count::int,(last-first+1-count)::int AS interior_missing,
 (today-1-last)::int AS stale_days FROM bounds,clock`);
  result.datasets[table]=r;
 }
 const {rows:[replay]}=await db.query(`SELECT COUNT(*)::int days,MIN(a.date)::text first,MAX(a.date)::text last,
 COUNT(*) FILTER(WHERE b.height IS NULL)::int noncanonical,
 COUNT(*) FILTER(WHERE u.date IS NULL OR t.date IS NULL)::int missing_derivatives,
 COUNT(*) FILTER(WHERE (a.fees->>'minerDestinationRows')::int IS DISTINCT FROM COALESCE(md.rows,0))::int inconsistent_destinations,
 COUNT(*) FILTER(WHERE prev.computed_at>a.computed_at)::int stale_dependencies,
 COUNT(*) FILTER(WHERE (SELECT COALESCE(SUM(value::bigint),0) FROM jsonb_each_text(a.mining_pool_blocks)) IS DISTINCT FROM (a.fees->>'blockCount')::bigint)::int inconsistent_mining,
 COUNT(*) FILTER(WHERE u.total_unspent_zat IS DISTINCT FROM a.transparent_supply_zat OR
 (u.lt_1m_zat+u.b_1_3m_zat+u.b_3_6m_zat+u.b_6_12m_zat+u.b_1_2y_zat+u.gt_2y_zat) IS DISTINCT FROM a.transparent_supply_zat)::int inconsistent_ages
 FROM analytics_history_daily a LEFT JOIN blocks b ON b.height=a.anchor_height AND b.hash=a.anchor_hash
 LEFT JOIN utxo_age_daily u USING(date) LEFT JOIN transparent_realized_cap_daily t USING(date)
 LEFT JOIN analytics_history_daily prev ON prev.date=a.date-1
 LEFT JOIN (SELECT date,COUNT(*) rows FROM miner_destination_daily GROUP BY date) md ON md.date=a.date`);
 result.replay=replay;
 result.replayHealthy=!replay.noncanonical&&!replay.missing_derivatives&&!replay.inconsistent_ages&&!replay.inconsistent_destinations&&!replay.stale_dependencies&&!replay.inconsistent_mining;
 result.sourcesHealthy=['privacy_trends_daily','zec_price_daily'].every(table=>{const d=result.datasets[table];return d.count>0&&!d.interior_missing&&d.stale_days<=1;});
 result.freshnessHealthy=freshnessHealthy(result.datasets);
 return result;
}
async function run() {
 loadEnv(__dirname);const db=getPool({max:1,statement_timeout:5000,query_timeout:6000,application_name:'analytics-completeness'});
 try {const result=await report(db);console.log(JSON.stringify(result));if(!result.replayHealthy||!result.sourcesHealthy||!result.freshnessHealthy)process.exitCode=1;}
 finally{await db.end();}
}
if(require.main===module)run().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={report,TABLES,freshnessHealthy};
