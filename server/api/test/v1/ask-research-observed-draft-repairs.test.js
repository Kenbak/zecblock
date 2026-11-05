'use strict';
// Fixed operator-authored staging probes, not visitor logs or provider traces.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {parse}=require('pgsql-parser');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {compileResearchDraft,draftDiagnostics}=require('../../v1/lib/ask-research-plan-quality');
const {cases}=require('../../v1/lib/ask-research-eval-cases');
const fixture=name=>fs.readFileSync(path.join(__dirname,'../fixtures',name),'utf8').trim();
const badFlow=fixture('ask-fixed-flow-projection.sql');
const badAddress=fixture('ask-fixed-address-distinct.sql');
const flowCase=cases.find(item=>item.id==='flow_pool_direction_totals');
const addressCase=cases.find(item=>item.id==='daily_address_incidences');
const repairedFlow=badFlow.replace(/pool,\s+direction,\s+amount\s+FROM analytics_public\.flow_daily_query/,'pool,\n  direction,\n  amount,\n  records,\n  missing_amounts\nFROM analytics_public.flow_daily_query');
const repairedAddress=require('../../v1/lib/ask-research-benchmarks').benchmarks.find(item=>item.id==='address_incidence').sql;
const flowSignal=/not projected by its fully resolved CTE source/;
const addressSignal=/month-wide DISTINCT\/address sort/;
const options={extended:true};
function columns(select){return select.targetList.map(item=>{const target=item.ResTarget;return target.name||target.val.ColumnRef?.fields.at(-1)?.String?.sval;});}

test('observed missing flow projection receives one repair, retaining required source columns and full scope',async()=>{
 assert.notEqual(repairedFlow,badFlow);
 const diagnostics=await draftDiagnostics(badFlow,{...options,question:flowCase.question});
 assert.match(diagnostics.join('\n'),flowSignal);assert.match(diagnostics.join('\n'),/missing_amounts, records/);
 let calls=0;
 const query=await compileResearchDraft(badFlow,{question:flowCase.question},async(input,task)=>{
  calls++;assert.equal(input.question,flowCase.question);assert.equal(input.sql,badFlow);
  assert.equal(task.name,'research_sql');assert.match(input.diagnostics.join('\n'),flowSignal);
  assert.match(input.diagnostics.join('\n'),/do not remove required measures/);
  return {sql:repairedFlow};
 },options);
 assert.equal(calls,1);assert.equal(query.limit,100);
 const statement=(await parse(query.sql)).stmts[0].stmt.SelectStmt;
 const first=statement.withClause.ctes[0].CommonTableExpr.ctequery.SelectStmt;
 assert.deepEqual(columns(first),['pool','direction','amount','records','missing_amounts']);
 assert.deepEqual(columns(statement),['pool','direction','boundary_records','missing_amounts','total_zec','most_boundary_records']);
 assert.match(query.sql,/2026-09-01/);assert.match(query.sql,/2026-10-01/);
 assert.match(query.sql,/sum\(records\)/);assert.match(query.sql,/sum\(missing_amounts\)/);
 assert.match(query.sql,/WHEN[^\n]*sum\(missing_amounts\)[^\n]*> 0 THEN NULL/);
 assert.match(query.sql,/row_number\(\) OVER/);assert.match(query.sql,/100000000/);
 assert.deepEqual(await draftDiagnostics(query.sql,{...options,question:flowCase.question}),[]);
});

test('observed address sort receives one per-day repair retaining the whole month and incidence semantics',async()=>{
 const diagnostics=await draftDiagnostics(badAddress,{...options,question:addressCase.question});
 assert.match(diagnostics.join('\n'),addressSignal);
 let calls=0;
 const query=await compileResearchDraft(badAddress,{question:addressCase.question},async(input,task)=>{
  calls++;assert.equal(input.question,addressCase.question);assert.equal(input.sql,badAddress);
  assert.equal(task.name,'research_sql');assert.match(input.diagnostics.join('\n'),addressSignal);
  assert.match(input.diagnostics.join('\n'),/complete requested month/);
  assert.match(input.diagnostics.join('\n'),/coinbase incidences/);
  assert.match(input.diagnostics.join('\n'),/Do not shorten the period/);
  return {sql:repairedAddress};
 },options);
 assert.equal(calls,1);assert.equal(query.limit,100);
 assert.match(query.sql,/activity_daily_query/);assert.match(query.sql,/address_activity_query/);
 assert.match(query.sql,/2026-09-01/);assert.match(query.sql,/2026-10-01/);
 assert.match(query.sql,/count\(DISTINCT a\.address\)/);assert.match(query.sql,/count\(\*\)/);
 assert.match(query.sql,/EXTRACT\(EPOCH FROM d\.date\)/);
 assert.match(query.sql,/EXTRACT\(EPOCH FROM d\.date \+ 1\)/);
 assert.match(query.sql,/address_transaction_incidences/);
 const statement=(await parse(query.sql)).stmts[0].stmt.SelectStmt;
 assert.deepEqual(columns(statement),['date','active_addresses','address_transaction_incidences']);
 assert.deepEqual(await draftDiagnostics(query.sql,{...options,question:addressCase.question}),[]);
});

for(const [name,bad,question,signal] of [
 ['flow',badFlow,flowCase.question,flowSignal],
 ['address',badAddress,addressCase.question,addressSignal],
]){
 test(name+' cannot receive a second repair call or a third draft attempt',async()=>{
  let calls=0;
  await assert.rejects(compileResearchDraft(bad,{question},async(input)=>{
   calls++;assert.equal(calls,1,'only the existing single repair is permitted');
   assert.match(input.diagnostics.join('\n'),signal);return {sql:bad};
  },options),error=>error.askKind==='answer');assert.equal(calls,1);
 });
 test(name+' repair cannot replace SQL with a write',async()=>{
  let calls=0;
  await assert.rejects(compileResearchDraft(bad,{question},async()=>{calls++;return {sql:'DELETE FROM blocks'};},options),error=>error.message==='One read-only SELECT is required');
  assert.equal(calls,1);
 });
 test(name+' unavailable repair ends without an execution or retry loop',async()=>{
  let calls=0;
  await assert.rejects(compileResearchDraft(bad,{question},async()=>{calls++;return {sql:null};},options),error=>error.askKind==='answer');assert.equal(calls,1);
 });
 test(name+' original handwritten SQL remains independently compiler-admitted',async()=>{
  const compiled=await compileResearchSQL({version:3,sql:bad,limit:100},options);
  assert.equal(compiled.request.version,3);assert.equal(compiled.request.limit,100);
  assert.match(compiled.request.sql,/2026-09-01/);assert.match(compiled.request.sql,/2026-10-01/);
  assert.ok(compiled.features.includes('cte'));
 });
}

test('multiple model-quality families still share one repair allowance',async()=>{
 let calls=0;
 await assert.rejects(compileResearchDraft(badFlow,{question:flowCase.question},async()=>{calls++;return {sql:badAddress};},options),error=>error.askKind==='answer');
 assert.equal(calls,1,'the second diagnostic family must not start another repair loop');
});
for(const [name,sql,question] of [['flow',repairedFlow,flowCase.question],['address',repairedAddress,addressCase.question]]){
 test('already-correct '+name+' consumes no provider repair',async()=>{
  const query=await compileResearchDraft(sql,{question},()=>assert.fail('Valid draft must not request a repair'),options);
  assert.equal(query.sql,(await compileResearchSQL({version:3,sql,limit:100},options)).request.sql);
 });
}
