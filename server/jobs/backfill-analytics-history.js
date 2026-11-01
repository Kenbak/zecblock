#!/usr/bin/env node
'use strict';
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { loadEnv,log } = require('../lib/job-utils');
const { DAY,METHOD,BUCKETS,dateOf,advance,usd,CREATIONS_SQL,SPENDS_SQL } = require('../lib/analytics-history');
const { parseDay } = require('../lib/utxo-age');
const destinations = require('./snapshot-miner-destinations');
const {getPoolTagSql,getPoolName,POOL_BY_TAG}=require('../api/mining-pools');
const {REBUILD_SQL} = require('../signals/compute-mvrv');
function options(args) {
 const result={maxDays:1,pauseMs:30000,apply:false,refresh:false};
 for(const arg of args) {
  if(arg==='--apply') result.apply=true;
  else if(arg==='--refresh') result.refresh=true;
  else if(/^--max-days=\d+$/.test(arg)) result.maxDays=Number(arg.split('=')[1]);
  else if(/^--pause-ms=\d+$/.test(arg)) result.pauseMs=Number(arg.split('=')[1]);
  else throw new Error('Use --apply, --refresh, --max-days=1..366 or --pause-ms=1000..60000');
 }
 if(result.maxDays<1||result.maxDays>366||result.pauseMs<1000||result.pauseMs>60000) throw new Error('Unsafe batch bounds');
 return result;
}
async function health(writer,reader) {
 if(os.loadavg()[0]/os.cpus().length>0.5) throw new Error('PAUSE: host load exceeds 0.5 per CPU');
 const tip=(await writer.query('SELECT height,hash,timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
 if(!tip || Date.now()/1000-Number(tip.timestamp)>600) throw new Error('PAUSE: indexed tip older than 10 minutes');
 const state=Object.fromEntries((await writer.query("SELECT key,value FROM indexer_state WHERE key IN ('last_indexed_height','last_seen_rpc_tip','last_success_at')")).rows.map(r=>[r.key,Number(r.value)]));
 if(!Number.isFinite(state.last_seen_rpc_tip) || state.last_seen_rpc_tip-Number(tip.height)>3 || !state.last_success_at || Date.now()/1000-state.last_success_at>600) throw new Error('PAUSE: indexer lag or heartbeat');
 const replica=(await reader.query('SELECT pg_is_in_recovery() recovery,pg_last_wal_replay_lsn() lsn')).rows[0];
 if(!replica.recovery || !replica.lsn) throw new Error('PAUSE: historical reads require the physical replica');
 const lag=(await writer.query('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::text bytes',[replica.lsn])).rows[0];
 if(Number(lag.bytes)>16*1024*1024) throw new Error('PAUSE: replication lag exceeds 16 MiB');
 const replayTip=(await reader.query('SELECT height FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
 if(Number(tip.height)-Number(replayTip?.height)>5) throw new Error('PAUSE: replica more than five indexed blocks behind');
 return {tipHeight:Number(tip.height),tipAgeSeconds:Date.now()/1000-Number(tip.timestamp),replicaLagBytes:Number(lag.bytes),loadPerCpu:os.loadavg()[0]/os.cpus().length};
}
async function writeResult(writer,result,anchor,fees,destinationRows,miningPools={}) {
 const r=result;
 await writer.query(`INSERT INTO analytics_history_daily(date,anchor_height,anchor_hash,method,cohorts,transparent_supply_zat,transparent_realized_cap_usd,spent_value_zat,spent_creation_value_usd,sopr,fees,mining_pool_blocks)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(date) DO UPDATE SET
 anchor_height=excluded.anchor_height,anchor_hash=excluded.anchor_hash,method=excluded.method,cohorts=excluded.cohorts,
 transparent_supply_zat=excluded.transparent_supply_zat,transparent_realized_cap_usd=excluded.transparent_realized_cap_usd,
 spent_value_zat=excluded.spent_value_zat,spent_creation_value_usd=excluded.spent_creation_value_usd,sopr=excluded.sopr,fees=excluded.fees,mining_pool_blocks=excluded.mining_pool_blocks,computed_at=now()`,
 [r.date,anchor.height,anchor.hash,METHOD,JSON.stringify(r.cohorts),r.total.toString(),usd(r.cap),r.spentValue.toString(),usd(r.spentBasis),r.sopr,JSON.stringify(fees),JSON.stringify(miningPools)]);
 await writer.query(`INSERT INTO utxo_age_daily(date,lt_1m_zat,b_1_3m_zat,b_3_6m_zat,b_6_12m_zat,b_1_2y_zat,gt_2y_zat,total_unspent_zat,utxo_count,cdd,avg_dormancy_days,spent_count)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(date) DO UPDATE SET
 lt_1m_zat=excluded.lt_1m_zat,b_1_3m_zat=excluded.b_1_3m_zat,b_3_6m_zat=excluded.b_3_6m_zat,b_6_12m_zat=excluded.b_6_12m_zat,
 b_1_2y_zat=excluded.b_1_2y_zat,gt_2y_zat=excluded.gt_2y_zat,total_unspent_zat=excluded.total_unspent_zat,utxo_count=excluded.utxo_count,
 cdd=excluded.cdd,avg_dormancy_days=excluded.avg_dormancy_days,spent_count=excluded.spent_count,created_at=now()`,
 [r.date,...BUCKETS.map(b=>r[b].toString()),r.total.toString(),r.count.toString(),r.cdd,r.avgDormancy,r.spentCount.toString()]);
 await writer.query(`INSERT INTO transparent_realized_cap_daily(date,realized_cap_usd,unspent_count,avg_cost_basis_usd)
 VALUES($1,$2,$3,$4) ON CONFLICT(date) DO UPDATE SET realized_cap_usd=excluded.realized_cap_usd,unspent_count=excluded.unspent_count,avg_cost_basis_usd=excluded.avg_cost_basis_usd`,
 [r.date,usd(r.cap),r.count.toString(),r.total?Number(r.cap)/Number(r.total)/10000:null]);
 // Preserve the existing shielded model component; never invent a missing one.
 await writer.query(`UPDATE mvrv_daily m SET transparent_realized_cap_usd=a.transparent_realized_cap_usd,
 realized_cap_usd=a.transparent_realized_cap_usd+m.shielded_realized_cap_usd,
 mvrv=m.market_cap_usd/NULLIF(a.transparent_realized_cap_usd+m.shielded_realized_cap_usd,0),
 realized_price=(a.transparent_realized_cap_usd+m.shielded_realized_cap_usd)/NULLIF(p.chain_supply::numeric/1e8,0),
 nupl=1-(a.transparent_realized_cap_usd+m.shielded_realized_cap_usd)/NULLIF(m.market_cap_usd,0),sopr=a.sopr
 FROM analytics_history_daily a,privacy_trends_daily p
 WHERE m.date=$1 AND a.date=m.date AND p.date=m.date AND m.shielded_realized_cap_usd IS NOT NULL`,[r.date]);
 await destinations.writeDay(writer,r.date,destinationRows);
}
// Busy historical days subdivide on a server-side statement timeout. Savepoints
// keep the same repeatable-read snapshot; only a complete day is published.
async function readSources(reader,start,end) {
 await reader.query('SAVEPOINT analytics_sources');
 try {
  const creation=(await reader.query(CREATIONS_SQL,[start,end])).rows[0];
  const spends=(await reader.query(SPENDS_SQL,[start,end])).rows;
  await reader.query('RELEASE SAVEPOINT analytics_sources');
  return {creation,spends};
 } catch(error) {
  await reader.query('ROLLBACK TO SAVEPOINT analytics_sources');
  await reader.query('RELEASE SAVEPOINT analytics_sources');
  if(error.code!=='57014' || !/statement timeout/i.test(error.message) || end-start<=3600) throw error;
  const middle=Math.floor((start+end)/2);
  log(`Subdividing historical source window ${start}..${end}`);
  const left=await readSources(reader,start,middle);
  await delay(1000);
  const right=await readSources(reader,middle,end);
  const creation={invalid:left.creation.invalid+right.creation.invalid};
  for(const key of ['value_zat','output_count']) creation[key]=(BigInt(left.creation[key])+BigInt(right.creation[key])).toString();
  return {creation,spends:[...left.spends,...right.spends]};
 }
}
async function replayDay(writer,reader,date,apply) {
 const started=Date.now(),start=parseDay(date)*DAY,end=start+DAY;
 let result,anchor,fees,destinationRows,previous,readTip,miningPools;
 await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try {
  await reader.query("SET LOCAL statement_timeout='20s'; SET LOCAL work_mem='16MB'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL TIME ZONE 'UTC'");
  readTip=(await reader.query('SELECT height,hash,timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
  if(!readTip || Number(readTip.timestamp)<end) throw new Error('Source has not reached completed day');
  const genesis=(await reader.query('SELECT timestamp FROM blocks ORDER BY height LIMIT 1')).rows[0];
  // Previous checkpoint must be read from primary (replication may lag this run).
  previous=(await writer.query('SELECT * FROM analytics_history_daily WHERE date=$1',[dateOf(parseDay(date)-1)])).rows[0];
  if(!previous && parseDay(date)!==Math.floor(Number(genesis.timestamp)/DAY)) throw new Error('Missing previous daily checkpoint');
  if(previous?.method && previous.method !== METHOD) throw new Error('Checkpoint methodology mismatch');
  if(previous && !(await reader.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2',[previous.anchor_height,previous.anchor_hash])).rowCount) throw new Error('Checkpoint anchor changed; rebuild from last canonical checkpoint');
  const bounds=(await reader.query(`SELECT COUNT(*)::int blocks,COALESCE(SUM(transaction_count),0)::text expected_txs,MAX(height) height FROM blocks WHERE timestamp >= $1 AND timestamp < $2`,[start,end])).rows[0];
  const observed=(await reader.query('SELECT COUNT(*)::text count FROM transactions WHERE block_time >= $1 AND block_time < $2',[start,end])).rows[0];
  if(bounds.expected_txs!==observed.count) throw new Error('Incomplete daily transaction coverage');
  // Anchor all source data to a canonical tip past the completed day. For old
  // checkpoints use that day's highest block, so ordinary tip reorgs do not
  // invalidate genesis. Validate both in the write transaction.
  anchor=(await reader.query('SELECT height,hash FROM blocks WHERE height=$1',[bounds.height??previous?.anchor_height])).rows[0];
  if(!anchor) throw new Error('No canonical daily anchor');
  const {creation,spends}=await readSources(reader,start,end);
  // A spending block may carry a timestamp before its origin block. SOPR
  // still uses each output's actual creation-day price, including that day.
  const lastPriceDay=dateOf(Math.max(parseDay(date),...spends.filter(s=>s.created_day!==null).map(s=>Number(s.created_day))));
  const prices=(await reader.query('SELECT date::text date,price_usd::text FROM zec_price_daily WHERE date <= $1',[lastPriceDay])).rows;
  result=advance(previous?.cohorts||[],date,creation,spends,new Map(prices.map(p=>[p.date,p.price_usd])));
  fees=(await reader.query(`SELECT percentile_cont(0.1) WITHIN GROUP(ORDER BY fee) p10,percentile_cont(0.25) WITHIN GROUP(ORDER BY fee) p25,
 percentile_cont(0.5) WITHIN GROUP(ORDER BY fee) median,percentile_cont(0.75) WITHIN GROUP(ORDER BY fee) p75,percentile_cont(0.9) WITHIN GROUP(ORDER BY fee) p90,
 AVG(fee) "avgFee",COUNT(*)::int "txCount" FROM transactions WHERE block_time >= $1 AND block_time < $2 AND NOT is_coinbase AND fee>0`,[start,end])).rows[0];
  destinationRows=await destinations.readDay(reader,date);
  fees.minerDestinationRows=Object.keys(destinationRows).length;
  const mined=(await reader.query(`SELECT miner_address,${getPoolTagSql()} pool_tag,COUNT(*)::int blocks
   FROM blocks WHERE timestamp >= $1 AND timestamp < $2 GROUP BY miner_address,pool_tag`,[start,end])).rows;
  fees.blockCount=bounds.blocks;
  miningPools={};
  for(const row of mined){const name=getPoolName(row.miner_address)||POOL_BY_TAG[row.pool_tag]?.name||'Unknown';miningPools[name]=(miningPools[name]||0)+row.blocks;}
  if(Object.values(miningPools).reduce((sum,n)=>sum+n,0)!==bounds.blocks)throw new Error('Incomplete mining block rollup');
  await reader.query('COMMIT');
 } catch(error) { await reader.query('ROLLBACK'); throw error; }
 const stats=await health(writer,reader);
 if(apply) {
  await writer.query('BEGIN');
  try {
   await writer.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'");
   if(!(await writer.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2',[readTip.height,readTip.hash])).rowCount) throw new Error('Source tip changed before apply');
   if(!(await writer.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2',[anchor.height,anchor.hash])).rowCount) throw new Error('Source chain changed before apply');
   if(previous && !(await writer.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2',[previous.anchor_height,previous.anchor_hash])).rowCount) throw new Error('Previous anchor changed');
   await writeResult(writer,result,anchor,fees,destinationRows,miningPools);
   await writer.query('COMMIT');
  } catch(error) {await writer.query('ROLLBACK');throw error;}
 }
 return {date,applied:apply,elapsedMs:Date.now()-started,unspentZat:result.total.toString(),outputs:result.count.toString(),sopr:result.sopr,cohortBytes:Buffer.byteLength(JSON.stringify(result.cohorts)),...stats};
}
async function run(args=process.argv.slice(2)) {
 const opt=options(args);loadEnv(__dirname);
 const {getPool,getReadPool,hasReadReplica}=require('../lib/db-pool');
 if(!hasReadReplica()) throw new Error('Configure REPLICA_DB_HOST; no heavy-read fallback to primary');
 const primary=getPool({max:1,statement_timeout:5000,query_timeout:6000,application_name:'analytics-history-writer'});
 const replica=getReadPool({max:1,statement_timeout:20000,query_timeout:21000,application_name:'analytics-history-reader'});
 const writer=await primary.connect(),reader=await replica.connect();
 const locks=[839302,839276,839303];const held=[];
 try {
  for(const lock of locks) {
   if(!(await writer.query('SELECT pg_try_advisory_lock($1) acquired',[lock])).rows[0].acquired) throw new Error('PAUSE: another analytics job is running');
   held.push(lock);
  }
  log(JSON.stringify({health:await health(writer,reader)}));
  const yesterday=dateOf(Math.floor(Date.now()/1000/DAY)-1);
  const genesis=dateOf(Math.floor(Number((await reader.query('SELECT timestamp FROM blocks ORDER BY height LIMIT 1')).rows[0].timestamp)/DAY));
  // Missing checkpoints identify resumable progress, including interior holes.
  const dates=(await writer.query(`WITH expected AS (
 SELECT d::date date FROM generate_series($1::date,$2::date,interval '1 day') d
 ), first_gap AS (
 SELECT MIN(e.date) date FROM expected e
 LEFT JOIN analytics_history_daily a ON a.date=e.date
 LEFT JOIN analytics_history_daily prev ON prev.date=e.date-1
 LEFT JOIN utxo_age_daily u ON u.date=e.date
 LEFT JOIN transparent_realized_cap_daily t ON t.date=e.date
 LEFT JOIN blocks b ON b.height=a.anchor_height AND b.hash=a.anchor_hash
 LEFT JOIN (SELECT date,COUNT(*) rows FROM miner_destination_daily GROUP BY date) md ON md.date=e.date
 WHERE a.date IS NULL OR u.date IS NULL OR t.date IS NULL OR b.height IS NULL
 OR prev.computed_at>a.computed_at OR NOT (a.fees ? 'blockCount')
 OR (a.fees->>'minerDestinationRows')::int IS DISTINCT FROM COALESCE(md.rows,0)
 ) SELECT e.date::text FROM expected e,first_gap g WHERE e.date>=g.date ORDER BY e.date LIMIT $3`,[genesis,yesterday,opt.maxDays])).rows.map(r=>r.date);
  if(!dates.length && opt.refresh) for(let day=Math.max(parseDay(genesis),parseDay(yesterday)-Math.min(7,opt.maxDays)+1);day<=parseDay(yesterday);day++) dates.push(dateOf(day));
  for(let i=0;i<dates.length;i++) {
   await health(writer,reader);
   log(JSON.stringify(await replayDay(writer,reader,dates[i],opt.apply)));
   if(!opt.apply) break;
   if(i<dates.length-1) await delay(opt.pauseMs);
  }
  if(opt.apply && dates.length) await writer.query(REBUILD_SQL,[null,dates[0],dates.at(-1)]);
  if(opt.apply && dates.length) {
   const {createClient}=require('redis');
   const cache=createClient({url:process.env.REDIS_URL||'redis://127.0.0.1:6379',socket:{connectTimeout:2000,reconnectStrategy:false}});
   cache.on('error',()=>{});
   try {
    await cache.connect();
    // Only these small, namespaced chart families; never flush the cache.
    for(const pattern of ['zcash:valuation:*','mining:*miner-behavior:*','mining:*zodl:*','mining:*hashrate-share:*','analytics:fee-dist:v2:*']) {
     for await(const keys of cache.scanIterator({MATCH:pattern,COUNT:100})) if(keys.length) await cache.unlink(keys);
    }
   } catch(error) {log(`Cache invalidation deferred: ${error.name}`);}
   finally {if(cache.isOpen)await cache.quit();}
  }
  log(JSON.stringify({completed:!dates.length,applied:opt.apply}));
 } finally {
  for(const lock of held.reverse()) await writer.query('SELECT pg_advisory_unlock($1)',[lock]).catch(()=>{});
  writer.release();reader.release();await primary.end();await replica.end();
 }
}
if(require.main===module) run().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={options,advance,health,replayDay,writeResult,readSources,run};
