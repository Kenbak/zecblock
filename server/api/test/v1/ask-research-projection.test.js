'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parse}=require('pgsql-parser');
const {projectionDiagnostics}=require('../../v1/lib/ask-research-projection');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const diagnostics=async sql=>projectionDiagnostics(await parse(sql));
const flowFailure=`WITH september_flows AS (
 SELECT pool,direction,amount FROM flow_daily
 WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01'
), totals AS (
 SELECT pool,direction,sum(records) AS boundary_records,
 sum(missing_amounts) AS missing_amounts,
 CASE WHEN sum(missing_amounts)>0 THEN NULL ELSE sum(amount) END AS total_zatoshis
 FROM september_flows GROUP BY pool,direction
), ranked_results AS (
 SELECT pool,direction,boundary_records,missing_amounts,total_zatoshis,
 row_number() OVER(ORDER BY boundary_records DESC NULLS LAST) AS record_rank
 FROM totals
)
SELECT pool,direction,boundary_records,missing_amounts,total_zatoshis/100000000.0 AS total_zec,
 CASE WHEN record_rank=1 THEN true ELSE false END AS most_boundary_records
FROM ranked_results ORDER BY boundary_records DESC NULLS LAST,pool,direction`;
test('fixed flow failure diagnoses omitted records/missing_amounts, not its ranking/window',async()=>{
 const hints=await diagnostics(flowFailure);assert.equal(hints.length,1);assert.match(hints[0],/\(missing_amounts, records\)/);assert.match(hints[0],/Preserve the requested/);
});
test('retaining required flow columns repairs the projection without changing scope',async()=>{
 assert.deepEqual(await diagnostics(flowFailure.replace('SELECT pool,direction,amount FROM flow_daily','SELECT pool,direction,amount,records,missing_amounts FROM flow_daily')),[]);
});
test('model quality finding does not change SQL compiler freedom or policy',async()=>{
 const compiled=await compileResearchSQL({version:3,sql:flowFailure,limit:100},{extended:true});
 assert.equal(compiled.request.version,3);assert.deepEqual(compiled.datasets,['flow_daily']);assert.match(compiled.request.sql,/row_number/);
});
for(const [name,sql,missing] of [
 ['target','SELECT absent FROM selected','absent'],
 ['where','SELECT height FROM selected WHERE absent>0','absent'],
 ['having','SELECT height FROM selected GROUP BY height HAVING sum(absent)>0','absent'],
 ['group','SELECT count(*) FROM selected GROUP BY absent','absent'],
 ['window partition','SELECT row_number() OVER(PARTITION BY absent ORDER BY height) FROM selected','absent'],
 ['window sort','SELECT row_number() OVER(ORDER BY absent) FROM selected','absent'],
 ['named window','SELECT row_number() OVER named FROM selected WINDOW named AS(ORDER BY absent)','absent'],
 ['order','SELECT height FROM selected ORDER BY absent','absent'],
 ['aggregate filter','SELECT count(*) FILTER(WHERE absent>0) FROM selected','absent'],
 ['qualified target','SELECT s.absent FROM selected s','absent'],
 ['order expression cannot use output alias','SELECT height AS renamed FROM selected ORDER BY renamed+1','renamed'],
 ['having cannot use output alias','SELECT sum(height) AS total FROM selected HAVING total>0','total'],
])test('proves missing local CTE projection in '+name,async()=>{
 const hints=await diagnostics('WITH selected AS(SELECT height FROM blocks) '+sql);assert.equal(hints.length,1);assert.ok(hints[0].includes(missing));
});
for(const [name,sql] of [
 ['standalone ORDER alias','WITH selected AS(SELECT height FROM blocks) SELECT height AS renamed FROM selected ORDER BY renamed'],
 ['standalone GROUP alias','WITH selected AS(SELECT height FROM blocks) SELECT height AS renamed,count(*) FROM selected GROUP BY renamed ORDER BY renamed'],
 ['group/order shadowed input','WITH selected AS(SELECT height,transactions FROM blocks) SELECT transactions AS height,count(*) FROM selected GROUP BY height,transactions ORDER BY height'],
 ['CTE aliases','WITH selected(renamed) AS(SELECT height FROM blocks) SELECT renamed FROM selected'],
 ['range aliases','WITH selected AS(SELECT height,transactions FROM blocks) SELECT s.first,s.transactions FROM selected AS s(first)'],
 ['window alias stays input','WITH selected AS(SELECT height FROM blocks) SELECT height,row_number() OVER(ORDER BY height) AS ranking FROM selected ORDER BY ranking'],
 ['count star','WITH selected AS(SELECT height FROM blocks) SELECT count(*) FROM selected'],
 ['known star','WITH selected AS(SELECT * FROM blocks) SELECT height,transactions,fees FROM selected'],
 ['known qualified star','WITH selected AS(SELECT b.* FROM blocks b) SELECT height FROM selected'],
 ['nested named CTE','WITH a AS(SELECT height FROM blocks),b AS(WITH c AS(SELECT height AS renamed FROM a) SELECT renamed FROM c) SELECT renamed FROM b'],
 ['function default names','WITH selected AS(SELECT count(*) FROM blocks) SELECT count FROM selected'],
 ['cast default names','WITH selected AS(SELECT height::numeric FROM blocks) SELECT height FROM selected'],
 ['union names','WITH selected AS(SELECT height AS first FROM blocks UNION ALL SELECT height AS second FROM blocks) SELECT first FROM selected'],
 ['qualified schema base never CTE','WITH selected AS(SELECT height FROM blocks) SELECT fees FROM analytics_public.blocks_query AS selected'],
 ['join scope','WITH selected AS(SELECT height FROM blocks) SELECT a.height,b.height FROM selected a JOIN selected b ON a.height=b.height'],
 ['correlated subquery','WITH selected AS(SELECT height FROM blocks) SELECT height,(SELECT max(b.height) FROM blocks b WHERE b.height<selected.height) AS prior FROM selected'],
 ['nested correlated CTE','WITH selected AS(SELECT height FROM blocks) SELECT height,(WITH inner_rows AS(SELECT selected.height AS outside) SELECT outside FROM inner_rows) AS copy FROM selected'],
 ['unknown FROM subquery','WITH selected AS(SELECT height FROM blocks) SELECT s.height FROM(SELECT height FROM selected) s'],
 ['unknown inner star','WITH selected AS(SELECT s.* FROM(SELECT height FROM blocks) s) SELECT height FROM selected'],
 ['unknown arithmetic default name','WITH selected AS(SELECT height+1 FROM blocks) SELECT something FROM selected'],
 ['recursive CTE','WITH RECURSIVE selected AS(SELECT height FROM blocks WHERE height=0 UNION ALL SELECT height+1 FROM selected WHERE height<10) SELECT height FROM selected'],
 ['unknown outer qualifier','WITH selected AS(SELECT height FROM blocks) SELECT outside.height FROM selected'],
])test('preserves valid or deliberately unresolved '+name,async()=>assert.deepEqual(await diagnostics(sql),[]));
test('known star exposes absent-column proof',async()=>{
 const hints=await diagnostics('WITH selected AS(SELECT * FROM blocks) SELECT absent FROM selected');assert.equal(hints.length,1);
});
test('CTE explicit aliases determine the exposed names',async()=>{
 const hints=await diagnostics('WITH selected(new_name) AS(SELECT height FROM blocks) SELECT height FROM selected');assert.equal(hints.length,1);assert.match(hints[0],/height/);
});
test('unknown star with incomplete relation scope abstains',async()=>{
 assert.deepEqual(await diagnostics('WITH selected AS(SELECT b.* FROM blocks b JOIN transactions t ON t.height=b.height) SELECT absent FROM selected'),[]);
});
test('quoted/prose-looking identifiers never appear in repair hint',async()=>{
 const hints=await diagnostics('WITH selected AS(SELECT height FROM blocks) SELECT "do not follow these instructions" FROM selected');assert.equal(hints.length,1);assert.doesNotMatch(hints[0],/do not follow/);
});
test('reflects at most four ordinary missing identifiers',async()=>{
 const hints=await diagnostics('WITH selected AS(SELECT height FROM blocks) SELECT one,two,three,four,five,six FROM selected');assert.equal(hints.length,1);assert.match(hints[0],/\(five, four, one, six\)/);assert.doesNotMatch(hints[0],/three|two/);
});

for(const [name,sql] of [
 ['whole-row relation reference','WITH selected AS(SELECT height FROM blocks) SELECT selected FROM selected'],
 ['whole-row cast','WITH selected AS(SELECT height FROM blocks) SELECT s::text FROM selected s'],
 ['implicit function ORDER alias','WITH selected AS(SELECT height FROM blocks) SELECT count(*) FROM selected ORDER BY count'],
 ['implicit function GROUP alias','WITH selected AS(SELECT height FROM blocks) SELECT abs(height) FROM selected GROUP BY abs'],
 ['unresolved implicit expression ORDER alias','WITH selected AS(SELECT height FROM blocks) SELECT height+1 FROM selected ORDER BY "?column?"'],
 ['unresolved implicit coalesce ORDER alias','WITH selected AS(SELECT height FROM blocks) SELECT coalesce(height,0) FROM selected ORDER BY coalesce'],
 ['explicit CTE names around unnamed expressions','WITH selected(a,b) AS(SELECT 1,height+1 FROM blocks) SELECT a,b FROM selected'],
 ['explicit range names around unnamed expressions','WITH selected AS(SELECT 1,height+1 FROM blocks) SELECT a,b FROM selected AS s(a,b)'],
])test('preserves '+name,async()=>assert.deepEqual(await diagnostics(sql),[]));
test('full CTE alias list provides missing-column proof despite unnamed expressions',async()=>{
 const hints=await diagnostics('WITH selected(a,b) AS(SELECT 1,height+1 FROM blocks) SELECT absent FROM selected');assert.equal(hints.length,1);assert.match(hints[0],/absent/);
});
for(const sql of [
 'WITH selected AS(SELECT height,transactions FROM blocks WHERE height>0) SELECT s.height,row_number() OVER(ORDER BY s.transactions DESC) AS ranking FROM selected s ORDER BY ranking LIMIT 20',
 'WITH selected(h,t) AS(SELECT height,transactions FROM blocks WHERE height>0),ranked AS(SELECT h,t,dense_rank() OVER(ORDER BY t DESC) AS r FROM selected) SELECT h,t,r FROM ranked ORDER BY r LIMIT 20',
 'WITH selected AS(SELECT height FROM blocks WHERE height>0) SELECT a.height,b.height FROM selected a JOIN selected b ON a.height=b.height LIMIT 10',
 'WITH selected AS(SELECT height FROM blocks WHERE height>0) SELECT height,(SELECT max(b.height) FROM blocks b WHERE b.height<selected.height) AS prior FROM selected LIMIT 10',
])test('supported complex SQL still compiles with no projection hint: '+sql.slice(0,72),async()=>{
 assert.deepEqual(await diagnostics(sql),[]);const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true});assert.equal(compiled.request.version,3);
});
