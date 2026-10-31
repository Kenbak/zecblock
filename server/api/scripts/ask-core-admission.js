'use strict';
// Trusted operator process only; never imported by HTTP/model/query workers.
const {Pool}=require('pg');
const SETTINGS="SET LOCAL lock_timeout='500ms'; SET LOCAL idle_in_transaction_session_timeout='15s'; SET LOCAL timezone='UTC'; SET LOCAL search_path=pg_catalog; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off";
async function replicationErrorsAcknowledged(client) {
 const installed=(await client.query("SELECT to_regprocedure('analytics_meta.replication_errors_acknowledged()') IS NOT NULL AS installed")).rows[0]?.installed;
 if(typeof installed!=='boolean')throw Error('Recovery helper availability unknown');
 // Older fixtures/stores retain the original zero-errors rule. A failed helper
 // query is never converted into a pass or a fallback that ignores its ledger.
 const sql=installed===true ? 'SELECT analytics_meta.replication_errors_acknowledged() AS acknowledged' : 'SELECT coalesce(sum(apply_error_count+sync_error_count),0)=0 AS acknowledged FROM pg_stat_subscription_stats';
 return (await client.query(sql)).rows[0]?.acknowledged===true;
}
async function refreshAdmission(pool) {
 const client=await pool.connect();let broken=false;
 try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query(SETTINGS);
  const identity=(await client.query("SELECT current_database()='ask_analytics' AND NOT pg_is_in_recovery() AND current_setting('server_version_num')::int BETWEEN 160000 AND 169999 AND (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS operator, (SELECT store_kind FROM analytics_meta.identity WHERE singleton) AS kind")).rows[0];
  if(!identity?.operator || identity.kind!=='logical_public_core')throw Error('Operator store boundary failed');
  const s=(await client.query('SELECT * FROM analytics_meta.sync_state WHERE singleton FOR UPDATE')).rows[0];
  const c=(await client.query('SELECT * FROM analytics_meta.admission_control WHERE singleton FOR UPDATE')).rows[0];
  if(s.state==='quarantined'){await client.query('ROLLBACK');return {state:'quarantined'};}
  const m=(await client.query('SELECT *,sampled_at<=statement_timestamp() AND sampled_at>statement_timestamp()-interval \'120 seconds\' AS fresh FROM analytics_feed_meta.signal WHERE singleton')).rows[0];
  const status=(await client.query("SELECT (SELECT count(*)=1 AND bool_and(subenabled AND subdisableonerr AND NOT subrunasowner AND subname='ask_public_core_v1') FROM pg_subscription) AS enabled,(SELECT count(*)=4 AND bool_and(srsubstate='r') FROM pg_subscription_rel WHERE srrelid IN('public.blocks'::regclass,'public.transactions'::regclass,'public.shielded_flows'::regclass,'analytics_feed_meta.signal'::regclass)) AS copied,(SELECT count(*)=1 FROM pg_stat_subscription WHERE relid IS NULL AND pid IS NOT NULL AND subname='ask_public_core_v1') AS running,(SELECT remote_lsn FROM pg_replication_origin_status WHERE external_id='pg_'||(SELECT oid::text FROM pg_subscription WHERE subname='ask_public_core_v1')) AS applied_lsn")).rows[0];
  status.error_free=await replicationErrorsAcknowledged(client);
  const fail=async state=>{await client.query('UPDATE analytics_meta.sync_state SET state=$1,verified_at=NULL WHERE singleton',[state]);if(state==='quarantined')await client.query('UPDATE analytics_meta.admission_control SET baseline_verified=false WHERE singleton');await client.query('COMMIT');return {state};};
  if(m && (m.generation!==s.source_id || m.system_identifier!==s.source_system_identifier || m.timeline!==c.expected_timeline))return await fail('quarantined');
  if(!m?.fresh || !status.enabled || !status.copied || !status.running || !status.error_free || !status.applied_lsn)return await fail('stale');
  const checkpoint=(await client.query('SELECT $1::pg_lsn >= $2::pg_lsn AS applied',[status.applied_lsn,m.before_lsn])).rows[0];
  if(!checkpoint.applied)return await fail('stale');
  const tip=(await client.query('SELECT hash FROM public.blocks WHERE height=$1',[m.tip_height])).rows[0];
  if(!tip || tip.hash!==m.tip_hash)return await fail('stale');
  await client.query(c.baseline_verified ? "SET LOCAL statement_timeout='3s'; SET LOCAL work_mem='4MB'; SET LOCAL temp_file_limit='16MB'" : "SET LOCAL statement_timeout='60s'; SET LOCAL work_mem='256MB'; SET LOCAL temp_file_limit='2GB'");
  const dirty=c.baseline_verified ? (await client.query('SELECT height FROM analytics_meta.dirty_heights WHERE height<=$1 ORDER BY height LIMIT 200',[m.tip_height])).rows.map(r=>r.height) : null;
  const params=[m.tip_height,...(dirty ? [dirty] : [])];
  const range=alias=>dirty ? `${alias}.height<=$1 AND ${alias}.height=ANY($2::bigint[])` : `${alias}.height BETWEEN 0 AND $1`;
  const txRange=alias=>dirty ? `${alias}.block_height<=$1 AND ${alias}.block_height=ANY($2::bigint[])` : `${alias}.block_height BETWEEN 0 AND $1`;
  const chain=(await client.query(`SELECT count(*)::int AS bad FROM public.blocks b LEFT JOIN public.blocks prior ON prior.height=b.height-1 WHERE ${range('b')} AND (b.hash IS NULL OR b.hash!~'^[0-9a-f]{64}$' OR b.timestamp IS NULL OR (b.height>0 AND (prior.height IS NULL OR b.previous_block_hash IS DISTINCT FROM prior.hash)))`,params)).rows[0].bad;
  const counts=(await client.query(`SELECT count(*)::int AS bad FROM public.blocks b LEFT JOIN (SELECT block_height,count(*)::int n,count(*) FILTER(WHERE is_coinbase)::int coinbase FROM public.transactions t WHERE ${txRange('t')} GROUP BY block_height) t ON t.block_height=b.height WHERE ${range('b')} AND (b.transaction_count IS DISTINCT FROM t.n OR t.coinbase IS DISTINCT FROM 1)`,params)).rows[0].bad;
  const tx=(await client.query(`SELECT count(*)::int AS bad FROM public.transactions t LEFT JOIN public.blocks b ON b.height=t.block_height WHERE ${txRange('t')} AND (b.height IS NULL OR t.block_hash IS DISTINCT FROM b.hash OR t.block_time IS DISTINCT FROM b.timestamp)`,params)).rows[0].bad;
  const flows=(await client.query(`SELECT count(*)::int AS bad FROM public.shielded_flows f LEFT JOIN public.transactions t ON t.txid=f.txid WHERE ${txRange('f')} AND (t.txid IS NULL OR f.block_height IS DISTINCT FROM t.block_height OR f.block_time IS DISTINCT FROM t.block_time OR f.amount_zat IS NULL OR f.amount_zat<0 OR f.flow_type IS NULL OR f.pool IS NULL OR f.flow_type NOT IN ('shield','deshield') OR f.pool NOT IN ('sapling','orchard','ironwood','mixed'))`,params)).rows[0].bad;
  const missing=dirty && (await client.query('SELECT EXISTS(SELECT FROM unnest($1::bigint[]) d(height) WHERE NOT EXISTS(SELECT FROM public.blocks b WHERE b.height=d.height)) AS bad',[dirty])).rows[0].bad;
  if(chain||counts||tx||flows||missing)return await fail('quarantined');
  if(!c.baseline_verified){
   const span=(await client.query('SELECT count(*)::text AS n,min(height)::text AS first,max(height)::text AS last FROM public.blocks WHERE height BETWEEN 0 AND $1',[m.tip_height])).rows[0];
   if(span.first!=='0' || span.last!==m.tip_height || BigInt(span.n)!==BigInt(m.tip_height)+1n)return await fail('quarantined');
   await client.query('UPDATE analytics_meta.admission_control SET baseline_verified=true,baseline_through=$1,baseline_at=clock_timestamp() WHERE singleton',[m.tip_height]);
  }
  if(dirty)await client.query('DELETE FROM analytics_meta.dirty_heights WHERE height=ANY($1::bigint[])',[dirty]);
  else await client.query('DELETE FROM analytics_meta.dirty_heights WHERE height<=$1',[m.tip_height]);
  // A source tip retreat is allowed only with no residual old-chain rows above it.
  const retreat=s.covered_through!==null && BigInt(m.tip_height)<BigInt(s.covered_through);
  if(retreat && (await client.query('SELECT EXISTS(SELECT FROM public.blocks WHERE height>$1) AS residual',[m.tip_height])).rows[0].residual)return await fail('stale');
  await client.query("UPDATE analytics_meta.sync_state SET state='ready',covered_from=0,covered_through=$1,tip_hash=$2,applied_lsn=$3,verified_at=clock_timestamp() WHERE singleton",[m.tip_height,m.tip_hash,m.before_lsn]);
  if((await client.query("SELECT to_regclass('analytics_meta.dataset_state') IS NOT NULL AS present")).rows[0].present){
   await client.query(`UPDATE analytics_meta.dataset_state d SET ready=coalesce((SELECT bool_and(EXISTS(SELECT FROM pg_subscription_rel r JOIN pg_subscription sub ON sub.oid=r.srsubid WHERE sub.subname='ask_public_core_v1' AND r.srsubstate='r' AND r.srrelid=to_regclass(t))) FROM unnest(CASE d.dataset WHEN 'daily' THEN ARRAY['public.privacy_trends_daily'] WHEN 'swaps' THEN ARRAY['public.cross_chain_swaps'] WHEN 'addresses' THEN ARRAY['public.addresses'] WHEN 'address_activity' THEN ARRAY['public.address_transactions'] WHEN 'supply_daily' THEN ARRAY['public.chain_supply_daily'] WHEN 'mining_daily' THEN ARRAY['public.analytics_history_daily'] WHEN 'software_daily' THEN ARRAY['public.block_software_daily'] WHEN 'issuance_daily' THEN ARRAY['public.chain_supply_daily'] WHEN 'block_timing' THEN ARRAY['public.block_observations','public.captured_blocks'] END) t),false),generation=$1::text,verified_at=clock_timestamp(),source_through=to_timestamp($2::bigint) WHERE d.dataset IN('daily','swaps','addresses','address_activity','supply_daily','mining_daily','software_daily','issuance_daily','block_timing')`,[status.applied_lsn,(await client.query('SELECT timestamp FROM public.blocks WHERE height=$1',[m.tip_height])).rows[0].timestamp]);
  }
  await client.query('COMMIT');return {state:'verified',checked_heights:dirty?.length ?? 'baseline',through:m.tip_height};
 }catch(error){try{await client.query('ROLLBACK');}catch{broken=true;}throw error;}
 finally{client.release(broken);}
}
async function main(){
 if(process.getuid?.()===0)throw Error('Run as trusted postgres operator');
 const pool=new Pool({host:'/var/run/postgresql',user:'postgres',database:'ask_analytics',max:1,connectionTimeoutMillis:2000});pool.on('error',()=>{});
 try{console.log(JSON.stringify(await refreshAdmission(pool)));}finally{await pool.end();}
}
if(require.main===module)main().catch(()=>{console.error(JSON.stringify({state:'probe-failed'}));process.exitCode=1;});
module.exports={refreshAdmission,replicationErrorsAcknowledged};
