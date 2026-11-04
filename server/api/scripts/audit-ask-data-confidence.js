'use strict';
// Trusted operator audit only. Fixed SELECTs, no grants/backfills/provider calls.
const {createHash}=require('node:crypto');
const MAX_BLOCKS=1024,ROW_LIMIT=10000,ADDRESS_LIMIT=128;
const TABLES=Object.freeze(['blocks','transactions','shielded_flows','address_transactions','addresses']);
const SETTINGS="SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='200ms'; SET LOCAL idle_in_transaction_session_timeout='5s'; SET LOCAL work_mem='1MB'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL jit=off; SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'";
const IDENTITY="SELECT current_database() AS database,pg_is_in_recovery() AS recovery,current_setting('server_version_num')::int AS version,pg_size_bytes(current_setting('temp_file_limit'))::text AS temp_bytes,extract(epoch FROM clock_timestamp()-pg_last_xact_replay_timestamp()) AS replay_age,clock_timestamp() AS observed_at";
const RELATIONS="SELECT n.nspname AS schema,c.relname AS relation,c.reltuples::text AS estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])";
const GATES=Object.freeze([
 'Independent node/raw-transaction reconstruction of every claimed flow segment remains required.',
 'Independent input/output reconstruction of address incidences and complete historical summary reconciliation remain required.',
 'A bounded source-table consistency result is not proof that the indexer captured all chain history.',
 'View-only checks cannot discover rows hidden by canonical/freshness/publication filters; coinbase incidences cannot be checked against the non-coinbase transaction view.',
 'Rows with an absent or incorrect recorded height outside the selected interval are outside this audit scope.',
]);
function options(input={}){
 const keys=new Set(['mode','sourceKind','fromHeight','toHeight','execute']);
 if(Object.keys(input).some(k=>!keys.has(k))||!['source','analytics'].includes(input.mode)||typeof input.execute!=='undefined'&&typeof input.execute!=='boolean')throw Error('Invalid audit options');
 const number=value=>{if(!['string','number'].includes(typeof value))throw Error('Invalid height');if(typeof value==='string'&&!/^\d{1,10}$/.test(value))throw Error('Invalid height');const n=Number(value);if(!Number.isSafeInteger(n)||n<0||n>2147483647)throw Error('Invalid height');return n;};
 const fromHeight=number(input.fromHeight),toHeight=number(input.toHeight);
 if(toHeight<fromHeight||toHeight-fromHeight+1>MAX_BLOCKS)throw Error('Choose at most 1024 heights');
 if(input.mode==='source'&&!['primary','standby'].includes(input.sourceKind)||input.mode==='analytics'&&input.sourceKind!==undefined)throw Error('Choose explicit source primary/standby');
 return{mode:input.mode,...(input.mode==='source'?{sourceKind:input.sourceKind}:{}),fromHeight,toHeight,execute:input.execute===true};
}
function probes(input){
 const o=options(input),raw=o.mode==='source',lo=o.fromHeight,hi=o.toHeight;
 const b=raw?'public.blocks':'analytics_public.blocks_query',tx=raw?'public.transactions':'analytics_public.transactions_query',f=raw?'public.shielded_flows':'analytics_public.flows_query',a=raw?'public.address_transactions':'analytics_public.address_activity_query',s=raw?'public.addresses':'analytics_public.addresses_query';
 const height=raw?'block_height':'height',timestamp=raw?'block_time':'timestamp',fees=raw?'fee':'fees',bytes=raw?'size':'bytes',direction=raw?'flow_type':'direction',amount=raw?'amount_zat':'amount';
 const sampled=(relation,select,filter='')=>`sampled AS MATERIALIZED (SELECT ${select} FROM ${relation} WHERE ${height} BETWEEN ${lo} AND ${hi}${filter} LIMIT ${ROW_LIMIT+1}), observed AS MATERIALIZED (SELECT * FROM sampled LIMIT ${ROW_LIMIT})`;
 const cap=`(SELECT count(*)>${ROW_LIMIT} FROM sampled) AS truncated`;
 const sourceTx=raw?`,count(*) FILTER(WHERE b.height IS NULL)::text AS missing_block,count(*) FILTER(WHERE b.height IS NOT NULL AND t.block_hash IS DISTINCT FROM b.hash)::text AS block_hash_mismatches,count(*) FILTER(WHERE b.height IS NOT NULL AND t.block_time IS DISTINCT FROM b.timestamp)::text AS timestamp_mismatches,count(*) FILTER(WHERE t.is_coinbase IS NULL)::text AS missing_coinbase_flags`:'';
 const sourceFlow=raw?`,count(*) FILTER(WHERE t.txid IS NULL)::text AS missing_transaction,count(*) FILTER(WHERE t.txid IS NOT NULL AND f.block_height IS DISTINCT FROM t.block_height)::text AS transaction_height_mismatches,count(*) FILTER(WHERE b.height IS NULL)::text AS missing_block,count(*) FILTER(WHERE b.height IS NOT NULL AND (t.block_hash IS DISTINCT FROM b.hash OR f.block_time IS DISTINCT FROM b.timestamp OR t.block_time IS DISTINCT FROM b.timestamp))::text AS canonical_mismatches`:'';
 const incidence=sampled(a,`address,txid,${height} AS height,${timestamp} AS timestamp,tx_index,is_input,is_output,${raw?'value_out':'received'} AS received,${raw?'value_in':'sent'} AS sent`,raw?" AND (address LIKE 't1%' OR address LIKE 't3%')":'');
 return[
  {id:'block_window',checks:['missing_heights','missing_timestamps',...(raw?['parent_mismatches']:[])],text:`WITH observed AS MATERIALIZED (SELECT * FROM ${b} WHERE height BETWEEN ${lo} AND ${hi}) SELECT count(*)::text AS records,(${hi-lo+1}-count(*))::text AS missing_heights,min(height)::text AS first_height,max(height)::text AS last_height,(SELECT hash FROM observed ORDER BY height LIMIT 1) AS first_block_hash,(SELECT hash FROM observed ORDER BY height DESC LIMIT 1) AS last_block_hash,count(*) FILTER(WHERE timestamp IS NULL)::text AS missing_timestamps,${raw?`(SELECT count(*) FROM observed c LEFT JOIN public.blocks p ON p.height=c.height-1 WHERE c.height>0 AND (p.height IS NULL OR c.previous_block_hash IS DISTINCT FROM p.hash))::text AS parent_mismatches`:'NULL::text AS parent_mismatches'},false AS truncated FROM observed`},
  {id:'transaction_window',checks:['missing_fees','missing_bytes',...(raw?['missing_block','block_hash_mismatches','timestamp_mismatches','missing_coinbase_flags']:[])],text:`WITH ${sampled(tx,'*')} SELECT count(*)::text AS records,count(*) FILTER(WHERE t.${fees} IS NULL)::text AS missing_fees,count(*) FILTER(WHERE t.${bytes} IS NULL)::text AS missing_bytes${sourceTx},${cap} FROM observed t ${raw?'LEFT JOIN public.blocks b ON b.height=t.block_height':''}`},
  {id:'flow_window',checks:['missing_amounts','negative_amounts','unknown_direction','unknown_pool','duplicate_groups',...(raw?['missing_transaction','transaction_height_mismatches','missing_block','canonical_mismatches']:[])],text:`WITH ${sampled(f,'*')} SELECT count(*)::text AS records,count(*) FILTER(WHERE f.${amount} IS NULL)::text AS missing_amounts,count(*) FILTER(WHERE f.${amount}<0)::text AS negative_amounts,count(*) FILTER(WHERE f.${direction} IS NULL OR f.${direction} NOT IN('shield','deshield'))::text AS unknown_direction,count(*) FILTER(WHERE f.pool IS NULL OR f.pool NOT IN('sapling','orchard','ironwood','sprout','mixed'))::text AS unknown_pool,(SELECT count(*) FROM (SELECT txid,${direction} FROM observed GROUP BY txid,${direction} HAVING count(*)>1) d)::text AS duplicate_groups,CASE WHEN count(*) FILTER(WHERE f.${amount} IS NULL)>0 THEN NULL ELSE sum(f.${amount}::numeric)::text END AS recorded_amount_zat${sourceFlow},${cap} FROM observed f ${raw?'LEFT JOIN public.transactions t ON t.txid=f.txid LEFT JOIN public.blocks b ON b.height=f.block_height':''}`},
  {id:'address_activity_window',checks:['missing_values','negative_values','missing_flags','empty_flags','duplicate_groups',...(raw?['missing_transaction','canonical_mismatches']:[])],text:`WITH ${incidence} SELECT count(*)::text AS records,count(*) FILTER(WHERE a.received IS NULL OR a.sent IS NULL)::text AS missing_values,count(*) FILTER(WHERE a.received<0 OR a.sent<0)::text AS negative_values,count(*) FILTER(WHERE a.is_input IS NULL OR a.is_output IS NULL)::text AS missing_flags,count(*) FILTER(WHERE NOT a.is_input AND NOT a.is_output)::text AS empty_flags,(SELECT count(*) FROM (SELECT address,txid FROM observed GROUP BY address,txid HAVING count(*)>1) d)::text AS duplicate_groups${raw?`,count(*) FILTER(WHERE t.txid IS NULL)::text AS missing_transaction,count(*) FILTER(WHERE t.txid IS NOT NULL AND (t.block_height IS DISTINCT FROM a.height OR t.block_time IS DISTINCT FROM a.timestamp OR b.height IS NULL OR t.block_hash IS DISTINCT FROM b.hash OR b.timestamp IS DISTINCT FROM a.timestamp))::text AS canonical_mismatches`:''},${cap} FROM observed a ${raw?'LEFT JOIN public.transactions t ON t.txid=a.txid LEFT JOIN public.blocks b ON b.height=a.height':''}`},
  {id:'address_summary_sample',checks:['missing_summary','missing_summary_values','first_seen_after_observation','last_seen_before_observation','incidence_count_below_sample'],text:`WITH ${incidence}, candidates AS MATERIALIZED (SELECT address,min(timestamp) AS first_observation,max(timestamp) AS last_observation,count(*) AS incidences FROM observed GROUP BY address ORDER BY address LIMIT ${ADDRESS_LIMIT+1}), chosen AS MATERIALIZED (SELECT * FROM candidates ORDER BY address LIMIT ${ADDRESS_LIMIT}) SELECT count(*)::text AS records,count(*) FILTER(WHERE s.address IS NULL)::text AS missing_summary,count(*) FILTER(WHERE s.address IS NOT NULL AND (s.first_seen IS NULL OR s.last_seen IS NULL OR s.${raw?'tx_count':'transactions'} IS NULL OR s.${raw?'total_received':'received'} IS NULL OR s.${raw?'total_sent':'sent'} IS NULL OR s.balance IS NULL))::text AS missing_summary_values,count(*) FILTER(WHERE s.first_seen>c.first_observation)::text AS first_seen_after_observation,count(*) FILTER(WHERE s.last_seen<c.last_observation)::text AS last_seen_before_observation,count(*) FILTER(WHERE s.${raw?'tx_count':'transactions'}<c.incidences)::text AS incidence_count_below_sample,((SELECT count(*)>${ROW_LIMIT} FROM sampled) OR (SELECT count(*)>${ADDRESS_LIMIT} FROM candidates)) AS truncated FROM chosen c LEFT JOIN ${s} s ON s.address=c.address`},
 ].map(p=>({...p,fingerprint:createHash('sha256').update(p.text).digest('hex')}));
}
function assessPlan(explanation,relations){
 const root=Array.isArray(explanation)?explanation[0]?.Plan:explanation?.Plan;
 const reasons=new Set();let nodes=0;
 if(!root)return{allowed:false,reasons:['missing_plan']};
 const walk=node=>{
  if(++nodes>2000||!node||typeof node!=='object'){reasons.add('invalid_plan');return;}
  if(!Number.isFinite(node['Total Cost'])||node['Total Cost']>100000)reasons.add('estimated_cost_budget');
  const name=node['Relation Name'];
  if(TABLES.includes(name)&&/^(?:(?:Parallel )?Seq Scan|(?:Parallel )?Index(?: Only)? Scan)$/.test(node['Node Type']||'')){
   const value=relations.find(r=>r.schema==='public'&&r.relation===name)?.estimated_rows;
   const estimate=['string','number'].includes(typeof value)?Number(value):NaN;
   if(!Number.isFinite(estimate)||estimate<0||estimate>5000){
    if(/Seq Scan/.test(node['Node Type']))reasons.add('large_or_unknown_sequential_scan:'+name);
    else if(typeof node['Index Cond']!=='string'||!node['Index Cond'].trim())reasons.add('large_or_unknown_unbounded_index_scan:'+name);
   }
  }
  for(const child of node.Plans||[])walk(child);
 };
 walk(root);return{allowed:!reasons.size,reasons:[...reasons].sort(),estimated_cost:root['Total Cost']};
}
function assertIdentity(identity,o){
 if(!identity||!Number.isInteger(identity.version)||identity.version<160000||identity.version>=170000||!/^\d+$/.test(identity.temp_bytes||'')||BigInt(identity.temp_bytes)>16777216n)throw Error('Audit database boundary failed');
 if(o.mode==='analytics'&&(identity.database!=='ask_analytics'||identity.recovery!==false))throw Error('Audit database boundary failed');
 if(o.mode==='source'&&(identity.database!=='zcash_explorer_mainnet'||identity.recovery!==(o.sourceKind==='standby')||identity.recovery&&(!['string','number'].includes(typeof identity.replay_age)||!(Number(identity.replay_age)>=0&&Number(identity.replay_age)<=120))))throw Error('Audit database boundary failed');
}
function summarize(probe,row){
 if(!row||typeof row.truncated!=='boolean'||!/^\d+$/.test(row.records||''))throw Error('Invalid bounded result');
 const findings=[];
 for(const metric of probe.checks){if(typeof row[metric]!=='string'||!/^\d+$/.test(row[metric]))throw Error('Invalid audit measure');if(BigInt(row[metric])>0n)findings.push({metric,count:row[metric]});}
 return{status:row.truncated?'incomplete_row_budget':'measured',metrics:row,findings,scope_consistent:!row.truncated&&!findings.length};
}
async function runAudit(client,input){
 const o=options(input),report={version:1,kind:'ask_data_confidence',authority:o.mode==='source'?'bounded_source_index_consistency':'bounded_published_view_observation',window:{from_height:o.fromHeight,to_height:o.toHeight},execution:o.execute?'plan_gated_read_only':'plan_only',row_limit:ROW_LIMIT,address_summary_sample_limit:ADDRESS_LIMIT,chain_history_completeness:'unverified',limitations:GATES,probes:[]};
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query(SETTINGS);
  if(o.mode==='source')await client.query("SET LOCAL temp_file_limit='16MB'");
  const identity=(await client.query(IDENTITY)).rows[0];assertIdentity(identity,o);report.observed_at=identity.observed_at;
  if(o.mode==='analytics'){
   const coverage=(await client.query('SELECT ready,covered_from::text,covered_through::text FROM analytics_public.coverage')).rows;
   const extra=(await client.query("SELECT dataset,ready FROM analytics_public.dataset_coverage WHERE dataset IN('addresses','address_activity')")).rows;
   if(coverage.length!==1||coverage[0].ready!==true||BigInt(coverage[0].covered_from)>BigInt(o.fromHeight)||BigInt(coverage[0].covered_through)<BigInt(o.toHeight)||extra.length!==2||extra.some(r=>r.ready!==true))throw Error('Admitted coverage unavailable');
  }
  const relations=(await client.query(RELATIONS,[TABLES])).rows;
  for(const probe of probes(o)){
   const result={id:probe.id,fingerprint:probe.fingerprint};report.probes.push(result);
   await client.query('SAVEPOINT confidence_probe');
   try{
    const plan=(await client.query('EXPLAIN (FORMAT JSON, COSTS TRUE) '+probe.text)).rows[0]?.['QUERY PLAN'];
    result.plan=assessPlan(plan,relations);
    if(!result.plan.allowed)result.status='blocked_plan';
    else if(!o.execute)result.status='planned';
    else Object.assign(result,summarize(probe,(await client.query(probe.text)).rows[0]));
   }catch(error){await client.query('ROLLBACK TO SAVEPOINT confidence_probe');result.status='unavailable';result.sqlstate=/^[0-9A-Z]{5}$/.test(error.code||'')?error.code:null;}
   await client.query('RELEASE SAVEPOINT confidence_probe');
  }
  report.complete=o.execute&&report.probes.every(p=>p.status==='measured');
  report.scope_consistent=report.complete&&report.probes.every(p=>p.scope_consistent===true);
  return report;
 }finally{await client.query('ROLLBACK');}
}
function parseArgs(args){
 const parsed={};
 for(let i=0;i<args.length;i++){
  const flag=args[i];
  if(flag==='--execute'){if(parsed.execute!==undefined)throw Error('Duplicate option');parsed.execute=true;continue;}
  const key={'--mode':'mode','--source-kind':'sourceKind','--from-height':'fromHeight','--to-height':'toHeight'}[flag];
  if(!key||parsed[key]!==undefined||args[i+1]===undefined)throw Error('Unknown or missing option');parsed[key]=args[++i];
 }
 return options(parsed);
}
async function main(){
 const o=parseArgs(process.argv.slice(2));
 const {Pool}=require('pg');
 // Standard private PG* operator environment only; never accept a DSN argument.
 const pool=new Pool({max:1,connectionTimeoutMillis:1500,query_timeout:3500,options:'-c default_transaction_read_only=on'});pool.on('error',()=>{});
 let client;
 try{client=await pool.connect();const report=await runAudit(client,o);process.stdout.write(JSON.stringify(report)+'\n');if(report.probes.some(p=>['blocked_plan','unavailable'].includes(p.status))||o.execute&&!report.complete)process.exitCode=1;else if(o.execute&&!report.scope_consistent)process.exitCode=2;}
 finally{client?.release();await pool.end();}
}
if(require.main===module)main().catch(()=>{process.stderr.write(JSON.stringify({kind:'ask_data_confidence',status:'unavailable',reason:'invalid_options_or_database_boundary'})+'\n');process.exitCode=1;});
module.exports={MAX_BLOCKS,ROW_LIMIT,ADDRESS_LIMIT,TABLES,SETTINGS,IDENTITY,RELATIONS,GATES,options,probes,assessPlan,assertIdentity,summarize,runAudit,parseArgs};
