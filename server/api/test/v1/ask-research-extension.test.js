'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor}=require('../../../../lib/ask/research-catalogue');
const {metricFields,recordMetrics}=require('../../v1/lib/ask-research-metrics');
const {cacheKey}=require('../../v1/lib/ask-research-cache');
test('extended schemas remain explicit opt-in at every compiler boundary',async()=>{
 for(const d of catalogueFor(true).slice(3)){const q={version:3,sql:'SELECT * FROM '+d.id,limit:10};await assert.rejects(compileResearchSQL(q));const c=await compileResearchSQL(q,{extended:true});assert.deepEqual(c.datasets,[d.id]);assert.match(c.text,d.id==='labels'?/FROM \( VALUES/:new RegExp('analytics_public.'+d.id+'_query'));}
 assert.match(instructionsFor(true),/Prefer activity_daily/);assert.match(instructionsFor(true),/Never pass a date or timestamp into to_timestamp/);assert.match(instructionsFor(true),/array_agg, arrays and subscripting are not enabled/);assert.match(instructionsFor(true),/unfinished\/stale dataset fails/);assert.doesNotMatch(instructionsFor(false),/Additional published schemas/);
});
test('extension never permits dangerous constructs or raw/metadata access',async()=>{
 for(const sql of ["DELETE FROM addresses","SELECT * FROM public.addresses","SELECT * FROM analytics_meta.dataset_state","SELECT pg_read_file('/etc/passwd') FROM swaps","SELECT subconninfo FROM pg_subscription","SELECT pg_sleep(10) FROM daily","WITH address_activity AS(SELECT height FROM blocks) SELECT * FROM address_activity","SELECT * INTO broken FROM activity_daily"]){await assert.rejects(compileResearchSQL({version:3,sql,limit:1},{extended:true}));}
});
test('anonymous telemetry accepts only fixed categories and contains no input or identifiers',async()=>{
 const fields=metricFields({outcome:'success',datasets:['swaps','daily','swaps'],elapsedMs:1250,question:'private',sql:'secret',ip:'1.2.3.4',address:'t1private'});
 assert.deepEqual(fields,['requests','outcome:success','duration:1_5s','dataset:daily','dataset:swaps']);
 for(const record of [{outcome:'secret',elapsedMs:1},{outcome:'success',datasets:['t1private'],elapsedMs:1},{outcome:'success',elapsedMs:NaN}])assert.throws(()=>metricFields(record));
 let request;await recordMetrics({isReady:true,eval:async(_,value)=>{request=value;}},{outcome:'timeout',datasets:['flows'],elapsedMs:31000},Date.UTC(2026,9,7));
 assert.deepEqual(request,{keys:['ask:{mainnet}:research-counts:v1:2026-10-07'],arguments:['requests','outcome:timeout','duration:30s_plus','dataset:flows']});
 await recordMetrics({isReady:true,eval:async()=>{throw Error('Redis failed');}},{outcome:'success',elapsedMs:10});
});
test('independent refresh generations invalidate cached joined results',async()=>{
 const c=await compileResearchSQL({version:3,sql:'SELECT * FROM swaps',limit:10},{extended:true});const checkpoint={tip_hash:'a'.repeat(64),verified_at:'2026-10-07T00:00:00Z',covered_from:0,covered_through:100,datasetCheckpoints:[{dataset:'swaps',generation:'0/10'}]};
 assert.notEqual(cacheKey(c,checkpoint),cacheKey(c,{...checkpoint,datasetCheckpoints:[{dataset:'swaps',generation:'0/11'}]}));
});

test('reviewed research benchmark recipes compile against their declared datasets',async()=>{
 const {benchmarks}=require('../../v1/lib/ask-research-benchmarks');
 for(const b of benchmarks){const c=await compileResearchSQL({version:3,sql:b.sql,limit:100},{extended:true});assert.deepEqual(c.datasets,[...b.datasets].sort());}
});

