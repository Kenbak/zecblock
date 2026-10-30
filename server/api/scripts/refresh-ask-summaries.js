'use strict';
// Trusted operator only. All SQL/identifiers are fixed; no HTTP/model imports.
const {Pool}=require('pg');
async function refreshSummaries(pool,{limit=100}={}){
 if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('Invalid refresh batch');
 const c=await pool.connect();let broken=false;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await c.query("SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='500ms';SET LOCAL idle_in_transaction_session_timeout='15s';SET LOCAL work_mem='32MB';SET LOCAL temp_file_limit='256MB';SET LOCAL max_parallel_workers_per_gather=0;SET LOCAL jit=off;SET LOCAL timezone='UTC'");
  const authority=(await c.query("SELECT current_database()='ask_analytics' AND NOT pg_is_in_recovery() AND (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AND EXISTS(SELECT FROM analytics_public.coverage WHERE ready) AS admitted")).rows[0];
  if(!authority?.admitted){await c.query('ROLLBACK');return {state:'source-unavailable'};}
  // Transaction-scoped advisory lock: one fixed trusted refresher, never readers.
  if(!(await c.query('SELECT pg_try_advisory_xact_lock(20261007,1) AS locked')).rows[0].locked){await c.query('ROLLBACK');return {state:'busy'};}
  const days=(await c.query('SELECT date::text,revision::text FROM analytics_meta.summary_dirty_days WHERE date<CURRENT_DATE ORDER BY date LIMIT $1',[limit])).rows;
  if(days.length){
   const dates=days.map(d=>d.date),from=Date.parse(dates[0])/1000,to=Date.parse(dates.at(-1))/1000+86400;
   const span=(await c.query('SELECT min(b.height)::text AS first,max(b.height)::text AS last FROM public.blocks b CROSS JOIN analytics_public.coverage core WHERE core.ready AND b.height BETWEEN core.covered_from AND core.covered_through AND b.timestamp>=$1 AND b.timestamp<$2',[from,to])).rows[0];
   const bounds=[dates,from,to,span.first,span.last];
   // Aggregate at each native grain before joining the tiny day aggregates.
   await c.query(`WITH block_days AS (
    SELECT (to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date AS date,count(*) AS blocks
    FROM public.blocks b CROSS JOIN analytics_public.coverage core WHERE core.ready AND b.height BETWEEN $4::bigint AND $5::bigint AND b.timestamp>=$2 AND b.timestamp<$3 GROUP BY 1
   ),tx_days AS (
    SELECT (to_timestamp(t.block_time) AT TIME ZONE 'UTC')::date AS date,count(*) AS transactions,
     count(*) FILTER(WHERE t.has_sapling OR t.has_orchard OR t.has_ironwood OR t.has_sprout) AS shielded_transactions,
     count(*) FILTER(WHERE NOT(t.has_sapling OR t.has_orchard OR t.has_ironwood OR t.has_sprout)) AS transparent_transactions,
     count(*) FILTER(WHERE (t.has_sapling OR t.has_orchard OR t.has_ironwood OR t.has_sprout) IS NULL) AS unclassified_transactions,
     CASE WHEN count(*) FILTER(WHERE t.size IS NULL)>0 THEN NULL ELSE sum(t.size::numeric) END AS bytes,
     CASE WHEN count(*) FILTER(WHERE t.fee IS NULL)>0 THEN NULL ELSE sum(t.fee::numeric) END AS fees,
     count(*) FILTER(WHERE t.fee IS NULL) AS missing_fees,count(*) FILTER(WHERE t.size IS NULL) AS missing_bytes
    FROM public.transactions t CROSS JOIN analytics_public.coverage core WHERE core.ready AND t.block_height BETWEEN $4::bigint AND $5::bigint AND t.is_coinbase=false AND t.block_time>=$2 AND t.block_time<$3 GROUP BY 1
   ) INSERT INTO analytics_meta.activity_daily SELECT b.date,b.blocks,coalesce(t.transactions,0),coalesce(t.shielded_transactions,0),coalesce(t.transparent_transactions,0),coalesce(t.unclassified_transactions,0),CASE WHEN t.transactions IS NULL THEN 0 ELSE t.bytes END,CASE WHEN t.transactions IS NULL THEN 0 ELSE t.fees END,coalesce(t.missing_fees,0),coalesce(t.missing_bytes,0) FROM block_days b LEFT JOIN tx_days t USING(date) WHERE b.date=ANY($1::date[])
   ON CONFLICT(date) DO UPDATE SET blocks=EXCLUDED.blocks,transactions=EXCLUDED.transactions,shielded_transactions=EXCLUDED.shielded_transactions,transparent_transactions=EXCLUDED.transparent_transactions,unclassified_transactions=EXCLUDED.unclassified_transactions,bytes=EXCLUDED.bytes,fees=EXCLUDED.fees,missing_fees=EXCLUDED.missing_fees,missing_bytes=EXCLUDED.missing_bytes`,bounds);
   // Remove dates whose canonical blocks vanished, rather than keeping ghosts.
   await c.query("WITH canonical_days AS MATERIALIZED (SELECT (to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date AS date FROM public.blocks b CROSS JOIN analytics_public.coverage core WHERE core.ready AND b.height BETWEEN $4::bigint AND $5::bigint AND b.timestamp>=$2 AND b.timestamp<$3 GROUP BY 1) DELETE FROM analytics_meta.activity_daily d WHERE date=ANY($1::date[]) AND NOT EXISTS(SELECT FROM canonical_days b WHERE b.date=d.date)",bounds);
   await c.query('DELETE FROM analytics_meta.flow_daily WHERE date=ANY($1::date[])',[dates]);
   await c.query(`INSERT INTO analytics_meta.flow_daily SELECT (to_timestamp(f.block_time) AT TIME ZONE 'UTC')::date AS date,f.pool,f.flow_type,count(*),CASE WHEN count(*) FILTER(WHERE amount_zat IS NULL)>0 THEN NULL ELSE sum(amount_zat::numeric) END,count(*) FILTER(WHERE amount_zat IS NULL) FROM public.shielded_flows f CROSS JOIN analytics_public.coverage core WHERE core.ready AND f.block_height BETWEEN $4::bigint AND $5::bigint AND f.block_time>=$2 AND f.block_time<$3 AND (to_timestamp(f.block_time) AT TIME ZONE 'UTC')::date=ANY($1::date[]) GROUP BY 1,2,3`,bounds);
   // A racing revision changes this comparison or aborts repeatable-read. A
   // concurrent historical correction cannot be erased by this refresh.
   await c.query('DELETE FROM analytics_meta.summary_dirty_days d USING unnest($1::date[],$2::bigint[]) AS old(date,revision) WHERE d.date=old.date AND d.revision=old.revision',[dates,days.map(d=>d.revision)]);
  }
  await c.query(`UPDATE analytics_meta.dataset_state SET ready=NOT EXISTS(SELECT FROM analytics_meta.summary_dirty_days WHERE date<CURRENT_DATE),generation=(SELECT applied_lsn::text FROM analytics_meta.sync_state)||':'||(SELECT coalesce(max(date)::text,'none') FROM analytics_meta.activity_daily),verified_at=clock_timestamp(),source_through=(SELECT (max(date)+1)::timestamp AT TIME ZONE 'UTC' FROM analytics_meta.activity_daily) WHERE dataset IN('activity_daily','flow_daily')`);
  const remaining=(await c.query('SELECT count(*)::int AS remaining FROM analytics_meta.summary_dirty_days WHERE date<CURRENT_DATE')).rows[0].remaining;
  await c.query('COMMIT');return {state:remaining?'warming':'ready',refreshed_days:days.length,remaining_days:remaining};
 }catch(e){try{await c.query('ROLLBACK');}catch{broken=true;}if(['40001','55P03'].includes(e.code))return {state:'retry'};throw e;}finally{c.release(broken);}
}
// Transparent address days use their own dirty set, lock and smaller batches,
// so an address-history backfill never hides the activity/flow summaries. One
// grouped (date,address) pass replaces several DISTINCT sorts; the canonical
// join matches address_activity_query. new_addresses probes the address primary
// key once per address for an earlier canonical incidence in covered history.
async function refreshAddressDaily(pool,{limit=7}={}){
 if(!Number.isInteger(limit)||limit<1||limit>31)throw Error('Invalid refresh batch');
 const c=await pool.connect();let broken=false;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await c.query("SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='500ms';SET LOCAL idle_in_transaction_session_timeout='15s';SET LOCAL work_mem='32MB';SET LOCAL temp_file_limit='256MB';SET LOCAL max_parallel_workers_per_gather=0;SET LOCAL jit=off;SET LOCAL timezone='UTC'");
  const authority=(await c.query("SELECT current_database()='ask_analytics' AND NOT pg_is_in_recovery() AND (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AND EXISTS(SELECT FROM analytics_public.coverage WHERE ready) AS admitted,to_regclass('analytics_meta.address_daily') IS NOT NULL AS installed")).rows[0];
  if(!authority?.installed){await c.query('ROLLBACK');return {state:'not-installed'};}
  // The native address copy must itself be admitted; a warming copy is not history.
  if(!authority.admitted||!(await c.query("SELECT EXISTS(SELECT FROM analytics_public.dataset_coverage WHERE dataset='address_activity' AND ready) AS ready")).rows[0].ready){await c.query('ROLLBACK');return {state:'source-unavailable'};}
  if(!(await c.query('SELECT pg_try_advisory_xact_lock(20261007,2) AS locked')).rows[0].locked){await c.query('ROLLBACK');return {state:'busy'};}
  // A batch is at most `limit` consecutive calendar days, so sparse historical
  // corrections never widen one scan across years of address history.
  const days=(await c.query('SELECT date::text,revision::text FROM analytics_meta.address_daily_dirty_days WHERE date<CURRENT_DATE AND date<(SELECT min(date)+$1::int FROM analytics_meta.address_daily_dirty_days WHERE date<CURRENT_DATE) ORDER BY date',[limit])).rows;
  if(days.length){
   const dates=days.map(d=>d.date),from=Date.parse(dates[0])/1000,to=Date.parse(dates.at(-1))/1000+86400;
   const span=(await c.query('SELECT min(b.height)::text AS first,max(b.height)::text AS last FROM public.blocks b CROSS JOIN analytics_public.coverage core WHERE core.ready AND b.height BETWEEN core.covered_from AND core.covered_through AND b.timestamp>=$1 AND b.timestamp<$2',[from,to])).rows[0];
   await c.query('DELETE FROM analytics_meta.address_daily WHERE date=ANY($1::date[])',[dates]);
   await c.query(`WITH block_days AS (
    SELECT DISTINCT (to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date AS date
    FROM public.blocks b CROSS JOIN analytics_public.coverage core WHERE core.ready AND b.height BETWEEN $4::bigint AND $5::bigint AND b.timestamp>=$2 AND b.timestamp<$3
   ),day_addresses AS (
    SELECT (to_timestamp(a.block_time) AT TIME ZONE 'UTC')::date AS date,a.address,min(a.block_height) AS first_height,
     bool_or(a.is_input IS TRUE) AS sent,bool_or(a.is_output IS TRUE) AS received,count(*) AS incidences,
     count(*) FILTER(WHERE a.is_input IS TRUE) AS input_incidences,count(*) FILTER(WHERE a.is_output IS TRUE) AS output_incidences
    FROM public.address_transactions a JOIN public.transactions t ON t.txid=a.txid AND t.block_height=a.block_height AND t.block_time=a.block_time
    JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash CROSS JOIN analytics_public.coverage core
    WHERE core.ready AND a.block_height BETWEEN $4::bigint AND $5::bigint AND a.block_height BETWEEN core.covered_from AND core.covered_through AND a.block_time>=$2 AND a.block_time<$3
     AND (to_timestamp(a.block_time) AT TIME ZONE 'UTC')::date=ANY($1::date[])
    GROUP BY 1,2
   ),address_days AS (
    SELECT d.date,count(*) AS active_addresses,count(*) FILTER(WHERE d.sent) AS sending_addresses,count(*) FILTER(WHERE d.received) AS receiving_addresses,
     count(*) FILTER(WHERE NOT EXISTS(SELECT FROM public.address_transactions p JOIN public.transactions pt ON pt.txid=p.txid AND pt.block_height=p.block_height AND pt.block_time=p.block_time JOIN public.blocks pb ON pb.height=pt.block_height AND pb.hash=pt.block_hash CROSS JOIN analytics_public.coverage core WHERE core.ready AND p.address=d.address AND p.block_height<d.first_height AND p.block_height>=core.covered_from)) AS new_addresses,
     sum(d.incidences) AS incidences,sum(d.input_incidences) AS input_incidences,sum(d.output_incidences) AS output_incidences
    FROM day_addresses d WHERE d.date=ANY($1::date[]) GROUP BY d.date
   ) INSERT INTO analytics_meta.address_daily SELECT b.date,coalesce(a.active_addresses,0),coalesce(a.sending_addresses,0),coalesce(a.receiving_addresses,0),coalesce(a.new_addresses,0),coalesce(a.incidences,0),coalesce(a.input_incidences,0),coalesce(a.output_incidences,0)
   FROM block_days b LEFT JOIN address_days a USING(date) WHERE b.date=ANY($1::date[])`,[dates,from,to,span.first,span.last]);
   await c.query('DELETE FROM analytics_meta.address_daily_dirty_days d USING unnest($1::date[],$2::bigint[]) AS old(date,revision) WHERE d.date=old.date AND d.revision=old.revision',[dates,days.map(d=>d.revision)]);
  }
  await c.query(`UPDATE analytics_meta.dataset_state SET ready=NOT EXISTS(SELECT FROM analytics_meta.address_daily_dirty_days WHERE date<CURRENT_DATE),generation=(SELECT applied_lsn::text FROM analytics_meta.sync_state)||':'||(SELECT coalesce(max(date)::text,'none') FROM analytics_meta.address_daily),verified_at=clock_timestamp(),source_through=(SELECT (max(date)+1)::timestamp AT TIME ZONE 'UTC' FROM analytics_meta.address_daily) WHERE dataset='address_daily'`);
  const remaining=(await c.query('SELECT count(*)::int AS remaining FROM analytics_meta.address_daily_dirty_days WHERE date<CURRENT_DATE')).rows[0].remaining;
  await c.query('COMMIT');return {state:remaining?'warming':'ready',refreshed_days:days.length,remaining_days:remaining};
 }catch(e){try{await c.query('ROLLBACK');}catch{broken=true;}if(['40001','55P03'].includes(e.code))return {state:'retry'};throw e;}finally{c.release(broken);}
}
async function main(){if(process.getuid?.()===0)throw Error('Run as trusted postgres operator');const pool=new Pool({host:'/var/run/postgresql',user:'postgres',database:'ask_analytics',max:1,connectionTimeoutMillis:2000});pool.on('error',()=>{});try{const summaries=await refreshSummaries(pool);console.log(JSON.stringify({...summaries,address_daily:await refreshAddressDaily(pool)}));}finally{await pool.end();}}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({state:'refresh-failed',code:/^[0-9A-Z]{5}$/.test(e?.code)?e.code:'unknown'}));process.exitCode=1;});
module.exports={refreshSummaries,refreshAddressDaily};
