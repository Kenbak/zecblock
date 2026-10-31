'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {draftDiagnostics,compileResearchDraft}=require('../../v1/lib/ask-research-plan-quality');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {cases}=require('../../v1/lib/ask-research-eval-cases');
const item=cases.find(c=>c.id==='shielded_baseline'),options={extended:true,question:item.question};
const actual=fs.readFileSync(path.join(__dirname,'../fixtures/ask-fixed-short-lookback.sql'),'utf8').trim();
const signal=/window input is too short/;
const narrow="WITH raw_days AS(SELECT date,shielded_transactions FROM activity_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01'),with_count AS(SELECT date,shielded_transactions,count(*) OVER(ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS prior_days FROM raw_days),qualified AS(SELECT date,shielded_transactions,prior_days FROM with_count WHERE prior_days=30) SELECT * FROM qualified";
async function hints(sql){return (await draftDiagnostics(sql,options)).filter(hint=>signal.test(hint));}

test('actual downstream full-count requirement finds impossible upstream month-only baseline',async()=>{
 const diagnoses=await hints(actual);assert.equal(diagnoses.length,1);assert.match(diagnoses[0],/lookback dates/);
 let calls=0;const query=await compileResearchDraft(actual,{question:item.question},async(input,task)=>{
  calls++;assert.equal(input.sql,actual);assert.equal(input.question,item.question);assert.equal(task.name,'research_sql');
  assert.match(input.diagnostics.join('\n'),signal);return {sql:item.referenceSQL};
 },{extended:true});
 assert.equal(calls,1);assert.match(query.sql,/2026-08-02/);assert.match(query.sql,/30 PRECEDING/);
 assert.match(query.sql,/2026-09-01/);assert.match(query.sql,/NULLS LAST/);assert.match(query.sql,/LIMIT 10/);
 assert.deepEqual(await hints(query.sql),[]);
 calls=0;await assert.rejects(compileResearchDraft(actual,{question:item.question},async()=>{calls++;return {sql:actual};},{extended:true}),error=>error.askKind==='answer');assert.equal(calls,1);
});

test('simple date-preserving CTE chains retain the proved available date span',async()=>{
 assert.equal((await hints(narrow)).length,1);
 assert.equal((await hints(narrow.replace('FROM raw_days),qualified','FROM raw_days),forwarded AS(SELECT date,shielded_transactions,prior_days FROM with_count),qualified').replace('FROM with_count WHERE prior_days=30','FROM forwarded WHERE prior_days=30'))).length,1);
 assert.equal((await hints(narrow.replace('activity_daily','daily'))).length,1);
 assert.equal((await hints(narrow.replace('SELECT date,shielded_transactions,count(*)','SELECT d.date,d.shielded_transactions,count(*)').replace('FROM raw_days),qualified','FROM raw_days d),qualified'))).length,1);
});

test('correct lookback and partial windows require no new repair',async()=>{
 assert.deepEqual(await hints(narrow.replace("2026-09-01","2026-08-02")),[]);
 assert.deepEqual(await hints(narrow.replace('WHERE prior_days=30','')),[]);
 assert.deepEqual(await hints(narrow.replace('WHERE prior_days=30','WHERE prior_days=29')),[]);
 assert.deepEqual(await hints(narrow.replace('WHERE prior_days=30','WHERE prior_days>=1')),[]);
 assert.deepEqual(await hints(narrow.replace('30 PRECEDING','29 PRECEDING').replace('prior_days=30','prior_days=29')),[],'30 unique dates can contain 29 prior dates');
});

test('date-bound intersections propagate, without treating a bounded input as expanded',async()=>{
 const expanded=narrow.replace("2026-09-01","2026-08-02");
 const narrowed=expanded.replace('FROM raw_days),qualified',"FROM raw_days WHERE date>=DATE '2026-09-01'),qualified");
 assert.equal((await hints(narrowed)).length,1);
 assert.deepEqual(await hints(narrow.replace("date>=DATE '2026-09-01' AND date<DATE '2026-10-01'","date>=DATE '2026-09-01'")),[],'one-sided bounds do not prove input too short');
});

test('joins, groups, renamed/derived dates and count transformations do not acquire new proof',async()=>{
 const examples=[
  narrow.replace('FROM raw_days),qualified','FROM raw_days d JOIN daily p ON p.date=d.date),qualified'),
  narrow.replace('SELECT date,shielded_transactions FROM activity_daily','SELECT date,max(shielded_transactions) AS shielded_transactions FROM activity_daily').replace("date<DATE '2026-10-01'),with_count","date<DATE '2026-10-01' GROUP BY date),with_count"),
  narrow.replace('SELECT date,shielded_transactions FROM activity_daily','SELECT date AS observed_date,shielded_transactions FROM activity_daily'),
  narrow.replace('SELECT date,shielded_transactions FROM activity_daily','SELECT date+1 AS date,shielded_transactions FROM activity_daily'),
  narrow.replace('SELECT date,shielded_transactions,prior_days FROM with_count WHERE prior_days=30','SELECT date,shielded_transactions,prior_days+1 AS prior_days FROM with_count').replace('SELECT * FROM qualified','SELECT * FROM qualified WHERE prior_days=30'),
  narrow.replace('SELECT date,shielded_transactions,prior_days FROM with_count WHERE prior_days=30','SELECT date,shielded_transactions,prior_days AS renamed_count FROM with_count').replace('SELECT * FROM qualified','SELECT * FROM qualified WHERE renamed_count=30'),
 ];
 for(const sql of examples)assert.deepEqual(await hints(sql),[],sql);
});

test('ordinary nonnumeric comparisons on forwarded dates are not counter requirements',async()=>{
 const sql="WITH observed AS(SELECT date,transactions FROM activity_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01') SELECT date,transactions FROM observed WHERE date=DATE '2026-09-03'";
 assert.deepEqual(await hints(sql),[]);
});

test('all reviewed reference queries remain free of the impossible-baseline hint',async()=>{
 let checked=0;for(const entry of cases.filter(c=>c.kind==='research')){checked++;assert.deepEqual((await draftDiagnostics(entry.referenceSQL,{extended:true,question:entry.question})).filter(hint=>signal.test(hint)),[],entry.id);}assert.equal(checked,34);
});

test('original complex handwritten SQL remains compiler-admitted despite model quality diagnosis',async()=>{
 const compiled=await compileResearchSQL({version:3,sql:actual,limit:100},{extended:true});
 assert.equal(compiled.request.version,3);assert.ok(compiled.features.includes('cte'));assert.ok(compiled.features.includes('window'));
 assert.match(compiled.request.sql,/preceding_observations = 30/);assert.match(compiled.request.sql,/2026-09-01/);
});

test('positional CTE aliases suppress inherited bounds, counter names and backwards requirements',async()=>{
 const ctes="WITH raw_days AS(SELECT date,shielded_transactions FROM activity_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01'),with_count(date,prior_days,actual_prior_days) AS(SELECT date,shielded_transactions,count(*) OVER(ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS prior_days FROM raw_days) ";
 assert.deepEqual(await hints(ctes+'SELECT date,prior_days FROM with_count WHERE prior_days=30'),[],'prior_days is the shielded count after positional renaming');
 const intermediate=ctes.replace(/\) $/,') ,forwarded AS(SELECT date,prior_days,actual_prior_days FROM with_count) ');
 assert.deepEqual(await hints(intermediate+'SELECT date,prior_days FROM forwarded WHERE prior_days=30'),[]);
 // A date renamed into another field cannot inherit unique-day bounds either.
 const renamed=narrow.replace('with_count AS','with_count(actual_date,date,actual_prior_days) AS');
 assert.deepEqual(await hints(renamed),[]);
});

test('unused CTE full-count consumers cannot activate the new window advice',async()=>{
 const sql="WITH raw_days AS(SELECT date,shielded_transactions FROM activity_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01'),with_count AS(SELECT date,shielded_transactions,count(*) OVER(ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS prior_days FROM raw_days),unused AS(SELECT date FROM with_count WHERE prior_days=30) SELECT date,shielded_transactions FROM raw_days";
 assert.deepEqual(await hints(sql),[]);
 assert.equal((await hints(sql.replace('SELECT date,shielded_transactions FROM raw_days','SELECT date FROM unused'))).length,1,'using that exact consumer still exposes the impossible requirement');
});
