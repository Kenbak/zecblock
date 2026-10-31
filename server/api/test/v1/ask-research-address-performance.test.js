'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('pgsql-parser');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {addressDistinctDiagnostics}=require('../../v1/lib/ask-research-address-performance');
const sql="WITH bounded_activity AS(SELECT address,txid,timestamp FROM address_activity WHERE timestamp>=EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-09-01 00:00:00+00')::bigint AND timestamp<EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-10-01 00:00:00+00')::bigint),daily_counts AS(SELECT to_char(to_timestamp(timestamp),'YYYY-MM-DD') AS utc_date,count(DISTINCT address) AS distinct_active_transparent_addresses,count(*) AS address_transaction_incidences FROM bounded_activity GROUP BY 1) SELECT *,max(address_transaction_incidences) OVER() AS most_daily_incidences FROM daily_counts ORDER BY utc_date";
async function diagnose(statement){const compiled=await compileResearchSQL({version:3,sql:statement,limit:100},{extended:true});return {compiled,issues:addressDistinctDiagnostics(await parse(compiled.request.sql))};}
test('bounded month-wide DISTINCT daily address draft gets a per-day range-scan hint without changing SQL',async()=>{const {compiled,issues}=await diagnose(sql);assert.equal(issues.length,1);assert.match(issues[0],/correlated per-day COUNT\(DISTINCT a.address\) and COUNT\(\*\)/);assert.match(issues[0],/complete requested month/);assert.match(issues[0],/coinbase/);assert.match(issues[0],/Do not shorten/);assert.match(compiled.request.sql,/count\(DISTINCT address\)/i);});
test('source aliases and equivalent UTC numeric bounds preserve only the proven raw incidence shape',async()=>{
 const renamed="WITH raw(d,a) AS(SELECT timestamp,address FROM address_activity WHERE timestamp>=1788220800 AND timestamp<1790812800) SELECT date_trunc('day',to_timestamp(d)) AS day,count(DISTINCT a) AS distinct_addresses,count(*) AS incidences FROM raw GROUP BY 1";
 assert.equal((await diagnose(renamed)).issues.length,1);
 assert.equal((await diagnose(sql.replace("GROUP BY 1)","GROUP BY utc_date)"))).issues.length,1);
});
test('the efficient fixed per-day references remain accepted without a repair diagnostic',async()=>{const {cases}=require('../../v1/lib/ask-research-eval-cases'),{benchmarks}=require('../../v1/lib/ask-research-benchmarks');for(const ref of [cases.find(c=>c.id==='daily_address_incidences').referenceSQL,benchmarks.find(b=>b.id==='address_incidence').sql])assert.deepEqual((await diagnose(ref)).issues,[]);});
test('one-day, custom-grain and unresolved source queries remain queryable without this hint',async()=>{
 const rejected=[sql.replace("2026-10-01 00:00:00+00","2026-09-02 00:00:00+00"),sql.replace("count(DISTINCT address)","count(address)"),sql.replace("count(*) AS address_transaction_incidences","count(txid) AS address_transaction_incidences").replace("::bigint),daily_counts", "::bigint LIMIT 100),daily_counts"),sql.replace("count(DISTINCT address)","count(DISTINCT txid)"),sql.replace("'YYYY-MM-DD'","'YYYY-MM'")];
 for(const statement of rejected){const {compiled,issues}=await diagnose(statement);assert.deepEqual(issues,[],statement);assert.ok(compiled.request.sql);}
});
test('CTE shadowing, joined sources and preaggregated inputs cannot acquire raw address lineage',async()=>{
 const examples=["WITH address_activity AS(SELECT address,last_seen AS timestamp FROM addresses) SELECT to_char(to_timestamp(timestamp),'YYYY-MM-DD') AS day,count(DISTINCT address),count(*) FROM address_activity WHERE timestamp>=1788220800 AND timestamp<1790812800 GROUP BY 1", "SELECT to_char(to_timestamp(a.timestamp),'YYYY-MM-DD') AS day,count(DISTINCT a.address),count(*) FROM address_activity a JOIN transactions t ON t.txid=a.txid WHERE a.timestamp>=1788220800 AND a.timestamp<1790812800 GROUP BY 1", "WITH input AS(SELECT address,min(timestamp) AS timestamp FROM address_activity WHERE timestamp>=1788220800 AND timestamp<1790812800 GROUP BY address) SELECT to_char(to_timestamp(timestamp),'YYYY-MM-DD') AS day,count(DISTINCT address),count(*) FROM input GROUP BY 1"];
 // Reserved-name shadowing is already rejected by the compiler. The helper
 // itself must also fail to attribute a fabricated source to raw incidences.
 assert.deepEqual(addressDistinctDiagnostics(await parse(examples[0])),[]);
 for(const statement of examples.slice(1))assert.deepEqual((await diagnose(statement)).issues,[]);
});

test('actual post-repair failure with input/output flags still receives a full-month per-day hint',async()=>{
 const fs=require('node:fs'),path=require('node:path');
 const actual=fs.readFileSync(path.join(__dirname,'../fixtures/ask-fixed-address-flags-distinct.sql'),'utf8');
 const {compiled,issues}=await diagnose(actual);
 assert.equal(issues.length,1);assert.match(issues[0],/month-wide DISTINCT\/address sort/);
 assert.match(issues[0],/Preserve every additional input predicate unchanged in BOTH/);
 assert.match(issues[0],/never assume a filter is redundant or drop it/);
 assert.match(compiled.request.sql,/is_input\s+OR is_output/);
 assert.match(compiled.request.sql,/2026-09-01/);assert.match(compiled.request.sql,/2026-10-01/);
});

test('source-proven boolean filters do not lose their time bounds or acquire redundancy claims',async()=>{
 for(const filter of ['is_input','is_output IS TRUE','is_input IS NOT FALSE','is_output IS UNKNOWN','is_input IS NOT NULL','NOT is_input','is_input OR is_output','is_input AND NOT is_output','is_input = false','true = is_output']){
  const filtered=sql.replace('WHERE timestamp>=','WHERE ('+filter+') AND timestamp>=');
  const {compiled,issues}=await diagnose(filtered);assert.equal(issues.length,1,filter);
  assert.match(issues[0],/predicate unchanged in BOTH/);assert.match(compiled.request.sql,/2026-09-01/);assert.match(compiled.request.sql,/2026-10-01/);
 }
 const renamed="WITH bounded(a,t,flag_in,flag_out) AS(SELECT address,timestamp,is_input,is_output FROM address_activity WHERE timestamp>=1788220800 AND timestamp<1790812800) SELECT to_char(to_timestamp(t),'YYYY-MM-DD') AS day,count(DISTINCT a),count(*) FROM bounded WHERE flag_in OR flag_out GROUP BY 1";
 assert.equal((await diagnose(renamed)).issues.length,1);
});

test('OR time bounds, missing bounds and unresolved custom filters remain outside the hint',async()=>{
 const base="SELECT to_char(to_timestamp(timestamp),'YYYY-MM-DD') AS day,count(DISTINCT address),count(*) FROM address_activity WHERE ";
 const bounds='timestamp>=1788220800 AND timestamp<1790812800';
 for(const predicate of [
  '(timestamp>=1788220800 OR is_input) AND timestamp<1790812800',
  'timestamp>=1788220800 AND (timestamp<1790812800 OR is_output)',
  'is_input OR ('+bounds+')',
  'is_input AND timestamp>=1788220800',
  'is_input OR is_output',
  bounds+' AND received>0',
  bounds+' AND coalesce(is_input,false)',
  bounds+' AND address IS NOT NULL',
  bounds+' AND (is_input OR received>0)',
 ])assert.deepEqual((await diagnose(base+predicate+' GROUP BY 1')).issues,[],predicate);
});

test('one model-only per-day repair carries requested flags into BOTH counts while direct SQL stays allowed',async()=>{
 const {compileResearchDraft}=require('../../v1/lib/ask-research-plan-quality');
 const {cases}=require('../../v1/lib/ask-research-eval-cases');
 const item=cases.find(item=>item.id==='daily_address_incidences');
 const filtered=sql.replace('WHERE timestamp>=','WHERE (is_input OR is_output) AND timestamp>=');
 // The filter rules out address_daily, so the repair is the raw per-day benchmark shape.
 const repaired=require('../../v1/lib/ask-research-benchmarks').benchmarks.find(b=>b.id==='address_incidence').sql.replaceAll('FROM address_activity a WHERE','FROM address_activity a WHERE (a.is_input OR a.is_output) AND');
 let calls=0;
 const query=await compileResearchDraft(filtered,{question:item.question+' Retain only published incidences where is_input OR is_output is true.'},async(input)=>{
  calls++;assert.match(input.diagnostics.join('\n'),/predicate unchanged in BOTH/);return {sql:repaired};
 },{extended:true});
 assert.equal(calls,1);assert.equal((query.sql.match(/a\.is_input\s+OR a\.is_output/g)||[]).length,2);
 assert.match(query.sql,/count\(DISTINCT a.address\)/);assert.match(query.sql,/count\(\*\)/);
 assert.match(query.sql,/2026-09-01/);assert.match(query.sql,/2026-10-01/);
 assert.deepEqual((await diagnose(repaired)).issues,[]);
 const manual=await compileResearchSQL({version:3,sql:filtered,limit:100},{extended:true});
 assert.match(manual.request.sql,/count\(DISTINCT address\)/);assert.match(manual.request.sql,/is_input\s+OR is_output/);
});
