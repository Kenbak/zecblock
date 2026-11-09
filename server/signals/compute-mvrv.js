#!/usr/bin/env node
'use strict';
// USD cost-basis model. Transparent holdings are reconstructed at each UTC
// day close; the shielded component remains the existing public-flow model.
// No current-holdings scaling and no shielded substitute for transparent SOPR.
const {loadEnv,withAdvisoryLock}=require('../lib/job-utils');
const {getPool}=require('../lib/db-pool');
const REBUILD_SQL=`WITH shielded AS (
 SELECT date,SUM(realized_cap_usd) cap,SUM(balance_zat) balance,COUNT(*) pools
 FROM pool_realized_cap_daily GROUP BY date
), model AS (
 SELECT a.date,a.transparent_realized_cap_usd transparent_cap,a.sopr,
 s.cap shielded_cap,p.price_usd*(d.chain_supply::numeric/1e8) market_cap,
 a.transparent_realized_cap_usd+s.cap realized_cap,d.chain_supply::numeric/1e8 supply,
 p.price_usd/NULLIF(s.cap/NULLIF(s.balance::numeric/1e8,0),0) shielded_ratio
 FROM analytics_history_daily a JOIN blocks b ON b.height=a.anchor_height AND b.hash=a.anchor_hash
 JOIN zec_price_daily p ON p.date=a.date JOIN privacy_trends_daily d ON d.date=a.date
 JOIN shielded s ON s.date=a.date
 WHERE a.date<(now() AT TIME ZONE 'UTC')::date AND ($1::int IS NULL OR a.date>=(now() AT TIME ZONE 'UTC')::date-$1::int)
 AND s.pools=(SELECT COUNT(DISTINCT pool) FROM pool_realized_cap_daily WHERE date<=a.date)
 AND ($2::date IS NULL OR a.date >= $2::date) AND ($3::date IS NULL OR a.date <= $3::date)
 AND d.chain_supply>0 AND p.price_usd>0
)
INSERT INTO mvrv_daily(date,market_cap_usd,realized_cap_usd,transparent_realized_cap_usd,shielded_realized_cap_usd,mvrv,realized_price,sopr,shielded_sopr,nupl)
SELECT date,market_cap,realized_cap,transparent_cap,shielded_cap,market_cap/NULLIF(realized_cap,0),realized_cap/supply,sopr,shielded_ratio,1-realized_cap/NULLIF(market_cap,0) FROM model
ON CONFLICT(date) DO UPDATE SET market_cap_usd=excluded.market_cap_usd,realized_cap_usd=excluded.realized_cap_usd,
transparent_realized_cap_usd=excluded.transparent_realized_cap_usd,shielded_realized_cap_usd=excluded.shielded_realized_cap_usd,
mvrv=excluded.mvrv,realized_price=excluded.realized_price,sopr=excluded.sopr,shielded_sopr=excluded.shielded_sopr,nupl=excluded.nupl`;
async function run(args=process.argv.slice(2)) {
 if(args.some(arg=>!['--today-only','--all'].includes(arg)))throw new Error('Use --today-only (last seven complete days) or --all');
 loadEnv(__dirname);const pool=getPool({max:1});const c=await pool.connect();
 try {await withAdvisoryLock(c,839303,async()=>{
  const result=await c.query(REBUILD_SQL,[args.includes('--all')?null:7,null,null]);
  console.log(JSON.stringify({updated:result.rowCount,transparentMethod:'transparent-utxo-day-close-v1',shieldedMethod:'modeled_pool_flow_basis'}));
 });}finally{c.release();await pool.end();}
}
if(require.main===module)run().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={REBUILD_SQL,run};
