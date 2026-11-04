'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {draftDiagnostics,compileResearchDraft}=require('../../v1/lib/ask-research-plan-quality');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const question='Use SQL research. For September 2026, show public boundary record counts, missing source amounts and total ZEC by pool and direction. Explain the leader without claiming complete private activity.';
const bounds="date>=DATE '2026-09-01' AND date<DATE '2026-10-01'";
const bad=`SELECT pool,direction,count(*) AS boundary_records,sum(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) AS missing_amounts,sum(amount)::numeric/100000000 AS amount_zec FROM flow_daily WHERE ${bounds} GROUP BY pool,direction ORDER BY boundary_records DESC LIMIT 20`;
const fixed=`SELECT pool,direction,sum(records) AS boundary_records,sum(missing_amounts) AS missing_amounts,CASE WHEN sum(missing_amounts)>0 THEN NULL ELSE sum(amount)::numeric/100000000 END AS amount_zec FROM flow_daily WHERE ${bounds} GROUP BY pool,direction ORDER BY boundary_records DESC LIMIT 20`;
const signal=/COUNT counts aggregate rows/;
const options={extended:true,question};

test('explicit public record-count intent diagnoses source-event versus aggregate-row grain',async()=>{
 const issues=await draftDiagnostics(bad,options);assert.equal(issues.length,1);assert.match(issues[0],signal);
 assert.match(issues[0],/SUM\(records\)/);assert.match(issues[0],/SUM\(missing_amounts\)/);assert.match(issues[0],/totals NULL/);
 const compiled=await compileResearchSQL({version:3,sql:bad,limit:100},{extended:true});
 assert.match((await draftDiagnostics(compiled.request.sql,options)).join('\n'),signal,'canonical qualified source retains the same fixed diagnosis');
});

test('optional question context never turns a row-count SQL pattern into a general restriction',async()=>{
 for(const question of [undefined,null,{},'', 'Show September public flow totals in ZEC.','Show counts of transactions and public pool balances.'])assert.deepEqual(await draftDiagnostics(bad,{extended:true,question}),[]);
 assert.deepEqual(await draftDiagnostics(bad),[]);
});

test('COUNT variants and named event aliases remain local to the resolved daily source',async()=>{
 for(const expression of ['count(*)','count(amount)','count(DISTINCT date)','count(*) FILTER(WHERE amount IS NOT NULL)','round(count(*)::numeric,0)','CASE WHEN count(*)>0 THEN count(*) ELSE 0 END']){
  for(const alias of ['boundary_records','flow_event_count','public_records','public_flow_events','boundaryRecordCount']){
   const sql=`SELECT ${expression} AS "${alias}" FROM analytics_public.flow_daily_query AS f WHERE ${bounds}`;
   assert.match((await draftDiagnostics(sql,options)).join('\n'),signal,expression+' '+alias);
  }
 }
 for(const alternate of ['Count public flow events in September 2026.','What is the number of public boundary-flow records during September 2026?','How many flow records are observed by pool?'])assert.match((await draftDiagnostics(bad,{extended:true,question:alternate})).join('\n'),signal);
});

test('SUM record counts and explicitly named daily rows, days or observations are preserved',async()=>{
 assert.deepEqual(await draftDiagnostics(fixed,options),[]);
 for(const alias of ['daily_rows','summary_row_count','observed_days','flow_observations','boundary_records_per_day','coverage_count','records']){
  const sql=`SELECT count(*) AS ${alias} FROM flow_daily WHERE ${bounds}`;
  assert.deepEqual(await draftDiagnostics(sql,options),[],alias);
 }
 const mixed=`SELECT sum(records) AS boundary_records,count(*) AS summary_rows,count(DISTINCT date) AS observed_days FROM flow_daily WHERE ${bounds}`;
 assert.deepEqual(await draftDiagnostics(mixed,options),[]);
});

test('a COUNT denominator in a local SUM(records) average does not become a row-grain repair',async()=>{
 const question='Count public boundary records by pool, and include the average public boundary records per observed day.';
 for(const expression of ['sum(records)::numeric/nullif(count(DISTINCT date),0)','round(sum(f.records::numeric)/nullif(count(*),0),2)']){
  const sql=`SELECT pool,sum(records) AS boundary_records,${expression} AS average_boundary_records FROM flow_daily f WHERE ${bounds} GROUP BY pool`;
  assert.deepEqual(await draftDiagnostics(sql,{extended:true,question}),[]);
  const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true});
  assert.deepEqual(await draftDiagnostics(compiled.request.sql,{extended:true,question}),[],'canonical aliases retain the rate numerator and denominator');
  const query=await compileResearchDraft(sql,{question},()=>assert.fail('A valid record average needs no paid repair'),{extended:true});
  assert.equal(query.sql,compiled.request.sql);
 }
 // A valid rate elsewhere in the projection must not hide a wrong total count.
 const wrong=`SELECT pool,count(*) AS boundary_records,sum(records)::numeric/nullif(count(DISTINCT date),0) AS average_boundary_records FROM flow_daily WHERE ${bounds} GROUP BY pool`;
 assert.match((await draftDiagnostics(wrong,{extended:true,question})).join('\n'),signal);
 for(const expression of ['count(*)/nullif(sum(records),0)','sum(records)+count(*)','sum(records)::numeric/nullif(count(*),0)+count(*)']){
  assert.match((await draftDiagnostics(`SELECT ${expression} AS boundary_records FROM flow_daily WHERE ${bounds}`,options)).join('\n'),signal);
 }
});

test('explicit coverage-row questions remain valid even when labels mention boundary records',async()=>{
 for(const question of [
  'Count daily aggregate rows in flow_daily covering public boundary records.',
  'For public flow events, how many observed days are represented? This is a coverage analysis.',
  'For public boundary records, show the summary row count, not source event totals.',
  'Count observations for coverage of public flow events, not individual events.',
 ]){
  assert.deepEqual(await draftDiagnostics(bad,{extended:true,question}),[],question);
  await compileResearchDraft(bad,{question},()=>assert.fail('Explicit coverage counts require no repair'),{extended:true});
 }
});

test('raw records, other datasets, joins and unresolved lineage do not acquire summary semantics',async()=>{
 const accepted=[
  `SELECT count(*) AS boundary_records FROM flows WHERE height>=3500000 AND height<3500100`,
  `SELECT count(*) AS public_flow_events FROM transactions WHERE height>=3500000 AND height<3500100`,
  `SELECT count(*) AS boundary_records FROM unavailable_source`,
  `SELECT count(*) AS boundary_records FROM private_schema.flow_daily`,
  `SELECT count(*) AS boundary_records FROM flow_daily f JOIN flow_daily g ON f.date=g.date WHERE f.${bounds}`,
  `WITH projected AS(SELECT date,records FROM flow_daily WHERE ${bounds}) SELECT count(*) AS boundary_records FROM projected`,
  `SELECT count(*) AS boundary_records FROM(SELECT date,records FROM flow_daily WHERE ${bounds}) projected`,
  `SELECT (SELECT count(*) FROM transactions WHERE height>=3500000 AND height<3500100) AS boundary_records FROM flow_daily WHERE ${bounds} LIMIT 1`,
  `SELECT sum(records) AS boundary_records FROM flow_daily WHERE ${bounds} AND records>(SELECT count(*) FROM transactions WHERE height>=3500000 AND height<3500100)`,
 ];
 for(const sql of accepted)assert.deepEqual(await draftDiagnostics(sql,options),[],sql);
});

test('a local daily-source aggregate in a composable CTE still receives the specific hint',async()=>{
 const sql=`WITH measured_flows AS(${bad}) SELECT pool,direction,boundary_records,missing_amounts,amount_zec FROM measured_flows ORDER BY boundary_records DESC LIMIT 20`;
 assert.match((await draftDiagnostics(sql,options)).join('\n'),signal);
 const direct=await compileResearchSQL({version:3,sql,limit:100},{extended:true});assert.ok(direct.features.includes('cte'));
});

test('explicit public record-count draft gets one repair with unchanged SQL scope and security',async()=>{
 let calls=0;
 const query=await compileResearchDraft(bad,{question},async(input,task)=>{
  calls++;assert.equal(input.question,question);assert.equal(input.sql,bad);assert.match(input.diagnostics.join('\n'),signal);assert.equal(task.name,'research_sql');return {sql:fixed};
 },{extended:true});
 assert.equal(calls,1);assert.match(query.sql,/sum\(records\)/);assert.match(query.sql,/sum\(missing_amounts\)/);
 assert.match(query.sql,/2026-09-01/);assert.match(query.sql,/2026-10-01/);assert.match(query.sql,/NULL/);
 calls=0;await assert.rejects(compileResearchDraft(bad,{question},async()=>{calls++;return {sql:bad};},{extended:true}),error=>error.askKind==='answer');assert.equal(calls,1);
 calls=0;await assert.rejects(compileResearchDraft(bad,{question},async()=>{calls++;return {sql:null};},{extended:true}),error=>error.askKind==='answer');assert.equal(calls,1);
 calls=0;await assert.rejects(compileResearchDraft(bad,{question},async()=>{calls++;return {sql:'DELETE FROM flow_daily'};},{extended:true}));assert.equal(calls,1);
});

test('correct summaries consume no repair and handwritten row counts remain independently admitted',async()=>{
 const unchanged=await compileResearchSQL({version:3,sql:bad,limit:100},{extended:true});
 assert.match(unchanged.request.sql,/count\(\*\)/);assert.deepEqual(unchanged.datasets,['flow_daily']);
 const query=await compileResearchDraft(fixed,{question},()=>assert.fail('Correct SUM already matches requested grain'),{extended:true});
 assert.equal(query.sql,(await compileResearchSQL({version:3,sql:fixed,limit:100},{extended:true})).request.sql);
});
