'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {parse}=require('pgsql-parser');
const {periodGrainDiagnostics}=require('../../v1/lib/ask-research-period-grain');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {cases}=require('../../v1/lib/ask-research-eval-cases');
const item=cases.find(item=>item.id==='classification_denominator');
const question=item.question;
const bad=fs.readFileSync(path.join(__dirname,'../fixtures/ask-fixed-period-grain.sql'),'utf8').trim();
const fixed=item.referenceSQL;
const diagnose=async(sql=bad,q=question)=>periodGrainDiagnostics(await parse(sql),{question:q});
const signal=/whole-period total or share/;
const bounds="date>=DATE '2026-09-01' AND date<DATE '2026-10-01'";

test('actual fixed operator wrong-grain draft receives a full-period aggregate hint',async()=>{
 const hints=await diagnose();assert.equal(hints.length,1);assert.match(hints[0],signal);
 assert.match(hints[0],/SUM\(numerator\).*SUM\(denominator\)/);
 assert.match(hints[0],/never average daily percentages/);assert.match(hints[0],/null\/missing-value meaning/);
 assert.match(hints[0],/including unclassified/);
 assert.match(hints[0],/Omit an unnecessary daily date column/);
});

test('direct source aliases and output aliases do not hide raw date/count grain',async()=>{
 const sql="SELECT d.date AS observed_day,d.transactions AS arbitrary_label,d.shielded_transactions AS another_label FROM activity_daily d WHERE d.date>=DATE '2026-09-01' AND d.date<DATE '2026-10-01' ORDER BY observed_day";
 assert.equal((await diagnose(sql)).length,1);
 const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true});assert.equal((await diagnose(compiled.request.sql)).length,1);
});

for(const q of [
 'For September 2026 show total transactions and the shielded percentage.',
 'During September 2026 show the overall shielded share.',
 'In Sep 2026 show total shielded and transparent counts.',
 'For the UTC calendar month of September 2026 show total transactions.',
 'For Sept 2026 show total shielded transactions.',
])test('recognizes one explicit completed-month total/share request: '+q,async()=>assert.equal((await diagnose(bad,q)).length,1));

for(const q of [
 question+' Show daily rows.',
 question+' Break it down by day.',
 question+' Show each date.',
 question+' Show every observation.',
 question+' Include a rolling baseline.',
 question+' Explain the trend.',
 question+' Rank the highest days.',
 question+' Include the mean.',
 question+' Compare August and September.',
 'For September 2026 and September 2025 show total transactions.',
 'For September 2099 show total transactions.',
 'Show total shielded transactions.',
 'For September 15, 2026 show total transactions.',
 'For 2026-09-01 through 2026-09-30 show total transactions.',
])test('abstains from daily/ambiguous/multi-period/incomplete requests: '+q,async()=>{
 assert.deepEqual(await diagnose(bad,q),[]);
});

for(const q of [
 'For September 2026 show total transaction counts as a time series.',
 'For September 2026 show total transaction counts as a time-series.',
 'For September 2026 show total transaction counts over time.',
 'For September 2026 show total transaction counts as raw rows.',
 'For September 2026 show total transaction counts and raw data.',
 'For September 2026 show total transaction counts for individual observations.',
 'For September 2026 show total transaction counts as unaggregated data.',
])test('preserves explicit time-series or unaggregated research without an AI repair: '+q,async()=>{
 const {compileResearchDraft}=require('../../v1/lib/ask-research-plan-quality');
 assert.deepEqual(await diagnose(bad,q),[]);
 let calls=0;
 const query=await compileResearchDraft(bad,{question:q},async()=>{calls++;assert.fail('explicit unaggregated research must not request whole-period repair');},{extended:true});
 assert.equal(calls,0);
 assert.equal(query.sql,(await compileResearchSQL({version:3,sql:bad,limit:100},{extended:true})).request.sql);
});

test('period proof requires exactly one parsed statement',async()=>{
 assert.deepEqual(await diagnose(bad+'; SELECT 1'),[]);
});

for(const [name,sql] of [
 ['correct scalar SUM',fixed],
 ['explicit month grouping',`SELECT date_trunc('month',date::timestamp)::date AS month,sum(transactions) FROM activity_daily WHERE ${bounds} GROUP BY 1`],
 ['extra raw filter',bad.replace("AND date < '2026-10-01'::date","AND date < '2026-10-01'::date AND fees>0")],
 ['shortened SQL bounds',bad.replace("2026-09-01","2026-09-02")],
 ['wrong SQL month',bad.replaceAll('2026-09-01','2026-08-01').replaceAll('2026-10-01','2026-09-01')],
 ['explicit limit',bad+' LIMIT 100'],
 ['CTE lineage',`WITH observed AS(SELECT date,transactions FROM activity_daily WHERE ${bounds}) SELECT date,transactions FROM observed`],
 ['FROM subquery',`SELECT date,transactions FROM(SELECT date,transactions FROM activity_daily WHERE ${bounds}) observed`],
 ['join',`SELECT d.date,d.transactions FROM activity_daily d JOIN daily p ON p.date=d.date WHERE d.date>=DATE '2026-09-01' AND d.date<DATE '2026-10-01'`],
 ['window',`SELECT date,transactions,sum(transactions) OVER() FROM activity_daily WHERE ${bounds}`],
 ['unknown source',`SELECT date,transactions FROM daily WHERE ${bounds}`],
 ['no raw date target',`SELECT transactions,shielded_transactions FROM activity_daily WHERE ${bounds}`],
 ['only derived count targets',`SELECT date,transactions+1 AS total FROM activity_daily WHERE ${bounds}`],
])test('does not impose a new grain restriction on '+name,async()=>{
 assert.deepEqual(await diagnose(sql),[]);await compileResearchSQL({version:3,sql,limit:100},{extended:true});
});

test('original manual daily SQL remains compiler-admitted and unchanged by the model-only helper',async()=>{
 const compiled=await compileResearchSQL({version:3,sql:bad,limit:100},{extended:true});
 assert.deepEqual(compiled.datasets,['activity_daily']);assert.match(compiled.request.sql,/shielded_transactions/);
 assert.match(compiled.request.sql,/ORDER BY/);assert.match(compiled.request.sql,/date/);
});

test('all existing research references avoid the wrong-grain hint',async()=>{
 let checked=0;
 for(const reference of cases.filter(entry=>entry.kind==='research')){checked++;assert.deepEqual(await diagnose(reference.referenceSQL,reference.question),[],reference.id);}
 assert.equal(checked,38);
});

test('the existing model draft repair gets one chance to aggregate the entire requested month',async()=>{
 const {compileResearchDraft}=require('../../v1/lib/ask-research-plan-quality');let calls=0;
 const query=await compileResearchDraft(bad,{question},async(input,task)=>{
  calls++;assert.equal(input.question,question);assert.equal(input.sql,bad);assert.equal(task.name,'research_sql');
  assert.match(input.diagnostics.join('\n'),signal);return {sql:fixed};
 },{extended:true});
 assert.equal(calls,1);assert.match(query.sql,/sum\(transactions\)/);assert.match(query.sql,/sum\(shielded_transactions\)/);
 assert.match(query.sql,/sum\(unclassified_transactions\)/);assert.match(query.sql,/2026-09-01/);assert.match(query.sql,/2026-10-01/);
 calls=0;
 await assert.rejects(compileResearchDraft(bad,{question},async()=>{calls++;return {sql:bad};},{extended:true}),error=>error.askKind==='answer');
 assert.equal(calls,1,'persistent wrong grain must not start another repair loop');
});

test('unambiguous ISO literals compared to the proven DATE source also retain the month proof',async()=>{
 const sql="SELECT date,transactions FROM activity_daily WHERE date>='2026-09-01' AND date<'2026-10-01'";
 assert.equal((await diagnose(sql)).length,1);
});
