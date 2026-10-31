'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {parse}=require('pgsql-parser');
const {shareDenominatorDiagnostics}=require('../../v1/lib/ask-research-share-denominator');
const {draftDiagnostics,compileResearchDraft}=require('../../v1/lib/ask-research-plan-quality');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {cases}=require('../../v1/lib/ask-research-eval-cases');
const item=cases.find(c=>c.id==='shielded_baseline');
const actual=fs.readFileSync(path.join(__dirname,'../fixtures/ask-fixed-share-denominator.sql'),'utf8').trim();
const question='For September 2026 show shielded share of all transactions, including unclassified.';
const base="SELECT date,100*shielded_transactions::numeric/nullif(shielded_transactions+transparent_transactions,0) AS share FROM activity_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01'";
const diagnose=async(sql=base,q=question)=>shareDenominatorDiagnostics(await parse(sql),{question:q});
const signal=/denominator at the same grain/;

test('actual rolling-baseline draft diagnoses classified-only share despite matching a zero-unclassified sample',async()=>{
 const hints=await diagnose(actual,item.question);assert.equal(hints.length,1);assert.match(hints[0],signal);
 assert.match(hints[0],/carry that source count through required CTE projections/);
 assert.match(hints[0],/date\/lookback windows/);assert.match(hints[0],/ranking/);
});
for(const sql of [
 base,
 base.replace('shielded_transactions+transparent_transactions','transparent_transactions+shielded_transactions'),
 base.replace('100*shielded_transactions::numeric/nullif','shielded_transactions::numeric/nullif'),
 "WITH observed AS(SELECT date,shielded_transactions AS a,transparent_transactions AS b FROM activity_daily) SELECT date,round(100*a::numeric/nullif(a+b,0),2) AS custom FROM observed",
 "WITH observed(x,a,b) AS(SELECT date,shielded_transactions,transparent_transactions FROM activity_daily) SELECT x,a::numeric/nullif(a+b,0)*100 AS custom FROM observed",
 "SELECT 100*sum(shielded_transactions)::numeric/nullif(sum(shielded_transactions)+sum(transparent_transactions),0) AS pct FROM activity_daily",
 "SELECT 100*sum(shielded_transactions)::numeric/nullif(sum(shielded_transactions+transparent_transactions),0) AS pct FROM activity_daily",
 "WITH observed AS(SELECT sum(shielded_transactions) AS a,sum(transparent_transactions) AS b FROM activity_daily) SELECT a*100.0/nullif(a+b,0) FROM observed",
])test('recognizes only source-proven row/sum classified denominators: '+sql.slice(0,65),async()=>assert.equal((await diagnose(sql)).length,1));
for(const q of [
 'Show the shielded share among classified transactions only.',
 'Show shielded percentage of classified transactions, excluding unclassified.',
 'Show classified-only shielded share, not share of all transactions.',
 'Do not show shielded share of all transactions; use classified transactions only.',
 'Show shielded share of all transactions and a separate classified-only comparison.',
 'Show shielded share of all transactions, excluding unclassified.',
 'Show shielded share of all transactions but do not include unclassified.',
 'Show shielded share with unclassified transactions excluded.',
 'Show shielded share.',
 'Show transparent share of all transactions.',
])test('preserves explicit classified-only or unresolved question intent: '+q,async()=>assert.deepEqual(await diagnose(base,q),[]));
test('a negated classified-only alternative does not erase affirmative ALL intent',async()=>{
 assert.equal((await diagnose(base,'Show shielded percentage of all transactions including unclassified, not a share of classified transactions only.')).length,1);
});
for(const sql of [
 base.replace('shielded_transactions+transparent_transactions','transactions'),
 base.replace('shielded_transactions+transparent_transactions','shielded_transactions+transparent_transactions+unclassified_transactions'),
 base.replace('100*shielded_transactions','100*transparent_transactions'),
 base.replace('shielded_transactions+transparent_transactions','shielded_transactions+bytes'),
 base.replace('shielded_transactions+transparent_transactions','coalesce(shielded_transactions+transparent_transactions,0)'),
 base.replace('activity_daily','daily'),
 "SELECT 100*a.shielded_transactions::numeric/nullif(a.shielded_transactions+b.transparent_transactions,0) FROM activity_daily a JOIN activity_daily b ON a.date=b.date",
 "SELECT 100*shielded_transactions::numeric/nullif(shielded_transactions+transparent_transactions,0) FROM (SELECT * FROM activity_daily) observed",
 "WITH observed AS(SELECT transparent_transactions AS shielded_transactions,shielded_transactions AS transparent_transactions FROM activity_daily) SELECT shielded_transactions::numeric/nullif(shielded_transactions+transparent_transactions,0) FROM observed",
 "SELECT 100*sum(shielded_transactions) FILTER(WHERE date>=DATE '2026-09-01')/nullif(sum(shielded_transactions)+sum(transparent_transactions),0) FROM activity_daily",
 "SELECT 100*sum(shielded_transactions) OVER()/nullif(sum(shielded_transactions) OVER()+sum(transparent_transactions) OVER(),0) FROM activity_daily",
 "SELECT 100*(shielded_transactions-transparent_transactions)/nullif(shielded_transactions+transparent_transactions,0) FROM activity_daily",
])test('correct denominators and unknown expressions gain no invented meaning: '+sql.slice(0,65),async()=>assert.deepEqual(await diagnose(sql),[]));

test('nonzero unclassified counterexample distinguishes ALL from classified denominator exactly',()=>{
 // Mirrors the independently executed native fixture contract, not current chain data.
 // Matching today's zero-unclassified table must never establish formula equivalence.
 const row={transactions:300n,shielded:100n,transparent:180n,unclassified:20n};
 assert.equal(row.transactions,row.shielded+row.transparent+row.unclassified);
 const hundredths=denominator=>(row.shielded*10000n+denominator/2n)/denominator;
 assert.equal(hundredths(row.transactions),3333n);
 assert.equal(hundredths(row.shielded+row.transparent),3571n);
 assert.notEqual(hundredths(row.transactions),hundredths(row.shielded+row.transparent));
});

test('one model-only repair carries transactions through full rolling windows; direct SQL remains admitted',async()=>{
 const options={extended:true};let calls=0;
 const compiled=await compileResearchDraft(actual,{question:item.question},async(input,task)=>{
  calls++;assert.equal(input.sql,actual);assert.equal(input.question,item.question);assert.equal(task.name,'research_sql');
  assert.match(input.diagnostics.join('\n'),signal);return {sql:item.referenceSQL};
 },options);
 assert.equal(calls,1);assert.match(compiled.sql,/nullif\s*\(transactions,\s*0\)/i);assert.match(compiled.sql,/30 PRECEDING/);
 assert.match(compiled.sql,/2026-08-02/);assert.match(compiled.sql,/2026-09-01/);assert.match(compiled.sql,/2026-10-01/);
 assert.match(compiled.sql,/NULLS LAST/);assert.match(compiled.sql,/LIMIT 10/);
 calls=0;await assert.rejects(compileResearchDraft(actual,{question:item.question},async()=>{calls++;return {sql:actual};},options),error=>error.askKind==='answer');assert.equal(calls,1);
 const manual=await compileResearchSQL({version:3,sql:actual,limit:100},options);assert.match(manual.request.sql,/shielded_transactions \+ transparent_transactions/);
 assert.deepEqual(await draftDiagnostics(item.referenceSQL,{...options,question:item.question}),[]);
});

test('existing reference catalogue remains free of denominator diagnostics',async()=>{
 let checked=0;for(const entry of cases.filter(c=>c.kind==='research')){checked++;assert.deepEqual(await diagnose(entry.referenceSQL,entry.question),[],entry.id);}assert.equal(checked,34);
});

for(const q of [
 'Show shielded share of all transactions and the share among shielded plus transparent transactions.',
 'Show shielded share of all transactions and a separate share using only shielded and transparent transactions.',
 "Don't use all transactions as the denominator; show shielded share.",
 "Don't show shielded share of all transactions; use the classified proportion instead.",
 'Don’t show shielded share of all transactions; use the classified proportion instead.',
 'Show shielded share of all transactions, but not including unclassified.',
])test('preserves mixed and contracted subset intent: '+q,async()=>assert.deepEqual(await diagnose(base,q),[]));

test('unselected classified-share columns and unused CTEs do not contaminate correct final output',async()=>{
 const wrong='shielded_transactions::numeric/nullif(shielded_transactions+transparent_transactions,0)';
 const right='shielded_transactions::numeric/nullif(transactions,0)';
 const unused=`WITH unused AS(SELECT ${wrong} AS ignored FROM activity_daily) SELECT ${right} AS all_share FROM activity_daily`;
 const used=`WITH observed AS(SELECT date,transactions,shielded_transactions,transparent_transactions,${wrong} AS classified_share FROM activity_daily) SELECT date,${right} AS all_share FROM observed`;
 assert.deepEqual(await diagnose(unused),[]);assert.deepEqual(await diagnose(used),[]);
 assert.equal((await diagnose(`WITH observed AS(SELECT ${wrong} AS a FROM activity_daily) SELECT round(100*a,2) FROM observed`)).length,1);
});

test('symbolic count lineage is bounded before repeated CTE expansion',async()=>{
 const ctes=['a0 AS(SELECT shielded_transactions AS a,transparent_transactions AS b FROM activity_daily)'];
 for(let i=1;i<60;i++)ctes.push(`a${i} AS(SELECT a+a AS a,b+b AS b FROM a${i-1})`);
 const sql='WITH '+ctes.join(',')+' SELECT a::numeric/nullif(a+b,0) FROM a59';
 assert.deepEqual(await diagnose(sql),[]);
});
