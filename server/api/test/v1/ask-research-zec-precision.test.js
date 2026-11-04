'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {draftDiagnostics,compileResearchDraft,researchUnitsFor}=require('../../v1/lib/ask-research-plan-quality');
const question='For September 2026 return public boundary record counts, total ZEC and missing amounts by pool and direction. Explain which pair has the most records.';
const draft="WITH monthly_flows AS(SELECT pool,direction,sum(records) AS records,sum(missing_amounts) AS missing_amounts,CASE WHEN sum(missing_amounts)>0 THEN NULL ELSE sum(amount) END AS summed_zatoshis FROM flow_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01' GROUP BY pool,direction),ranked_results AS(SELECT pool,direction,records,missing_amounts,round(summed_zatoshis::numeric/100000000,2) AS total_zec FROM monthly_flows) SELECT * FROM ranked_results ORDER BY records DESC,pool,direction LIMIT 100";
const precision=issues=>issues.filter(issue=>/fewer than 8 decimal places/.test(issue));
async function diagnose(sql,q=question){const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true});return {compiled,issues:await draftDiagnostics(compiled.request.sql,{extended:true,question:q})};}
test('source-proven ZEC rounding below zatoshi precision triggers one fixed quality diagnostic',async()=>{
 for(const statement of [draft,'SELECT round(sum(amount)::numeric/100000000,2) AS measurement FROM flows','SELECT round(avg(fees)::numeric/100000000) AS fee FROM blocks','SELECT round(orchard::numeric/100000000,0) AS arbitrary FROM daily','SELECT round(balance::numeric/100000000,-2) AS arbitrary FROM addresses','SELECT round(sum(amount)::numeric*0.00000001,7) AS arbitrary FROM flows']){
  const {issues}=await diagnose(statement);assert.equal(precision(issues).length,1,statement);assert.match(precision(issues)[0],/preserving.*null\/missing semantics/);
 }
});
test('no question or explicit or ambiguously scoped rounding requests preserve the chosen SQL precision',async()=>{
 assert.deepEqual(precision(await draftDiagnostics(draft,{extended:true})),[],'missing question');
 for(const q of [null,'','  ','Round ZEC totals to two decimal places.','Return approximate ZEC amounts.','Give roughly the ZEC total.','Show ZEC totals and round percentages to two decimals.','Return eight significant digits.','Keep full precision.','Round the total to the nearest ZEC.'])assert.deepEqual(precision((await diagnose(draft,q)).issues),[],String(q));
});
test('correct precision and nonmonetary or unresolved lineage do not acquire ZEC meaning from aliases',async()=>{
 const good=[draft.replace('/100000000,2','/100000000,8'),draft.replace('/100000000,2','/100000000,12'),'SELECT round(count(*),2) AS total_zec FROM flows','SELECT round(sum(records)::numeric,2) AS total_zec FROM flow_daily','SELECT round(sum(usd),2) AS total_zec FROM swaps','SELECT round(sqrt(fees::numeric)/100000000,2) AS total_zec FROM blocks','WITH x AS(SELECT height AS fees FROM blocks) SELECT round(fees::numeric/100000000,2) AS amount FROM x'];
 for(const statement of good)assert.deepEqual(precision((await diagnose(statement)).issues),[],statement);
 // The public units API has no question/diagnostic side effects.
 assert.equal((await researchUnitsFor('SELECT round(fees::numeric/100000000,2) AS amount FROM blocks')).columns[0].unit,'zec');
});
test('harmless CTE and positional aliases carry proven monetary lineage independently of output names',async()=>{
 const statement='WITH source(a,b) AS(SELECT fees,height FROM blocks),converted(value) AS(SELECT a::numeric/100000000 FROM source) SELECT round(value,2) AS unrelated_label FROM converted';
 assert.equal(precision((await diagnose(statement)).issues).length,1);
 assert.deepEqual(precision(await draftDiagnostics('SELECT round(fees::numeric/100000000,2) FROM unknown_relation',{extended:true,question})),[]);
 assert.deepEqual(precision(await draftDiagnostics('SELECT round(fees::numeric/100000000,2) FROM blocks b JOIN transactions t ON t.height=b.height',{extended:true,question})),[],'ambiguous fees cannot prove denomination');
});
test('AI repair preserves exact amounts in one attempt while manual rounded SQL remains admitted',async()=>{
 const original=await compileResearchSQL({version:3,sql:draft,limit:100},{extended:true});assert.match(original.request.sql,/, 2\)/);let calls=0;
 const fixed=draft.replace('/100000000,2','/100000000,8');
 const result=await compileResearchDraft(draft,{question},async(input)=>{calls++;assert.equal(input.sql,draft);assert.equal(input.question,question);assert.equal(precision(input.diagnostics).length,1);return {sql:fixed};},{extended:true});
 assert.equal(calls,1);assert.match(result.sql,/, 8\)/);assert.match(result.sql,/missing_amounts/);assert.match(result.sql,/2026-09-01/);assert.match(result.sql,/2026-10-01/);assert.match(result.sql,/ORDER BY/);assert.match(result.sql,/LIMIT 100/);
 calls=0;await assert.rejects(compileResearchDraft(draft,{question},async()=>{calls++;return {sql:draft};},{extended:true}),error=>error.askKind==='answer');assert.equal(calls,1);
 calls=0;const explicit=await compileResearchDraft(draft,{question:'Round all ZEC totals to two decimals.'},async()=>{calls++;assert.fail('explicit rounding must not request precision repair');},{extended:true});assert.equal(calls,0);assert.equal(explicit.sql,original.request.sql);
});

test('research selection guidance preserves exact ZEC totals, necessary CTE fields and full-period address research',()=>{
 const {selectionTask}=require('../../v1/lib/ask-chat');const task=selectionTask('',{researchEnabled:true,researchExtended:true});
 assert.match(task.instruction,/at least eight decimal places unless the user explicitly requests another rounding precision/);
 assert.match(task.instruction,/Carry every input column needed by later expressions through each CTE projection/);
 assert.match(task.instruction,/observed activity_daily dates with correlated per-day raw address_activity counts/);
 assert.match(task.instruction,/Do not add filters the user did not request/);
 assert.match(task.instruction,/preserving unchanged filters and dates/);
});

test('explicit whole-ZEC precision and balance buckets remain free research rather than an amount-precision repair',async()=>{
 const sql='SELECT round(balance::numeric/100000000) AS whole_zec,count(*) AS addresses FROM addresses GROUP BY 1';
 for(const question of ['Group addresses by their balance in whole ZEC.','Show an integer ZEC balance distribution.','Group addresses in hundreds of ZEC.','Create a ZEC balance histogram.','Count addresses in ZEC balance bands.']){
  let calls=0;const query=await compileResearchDraft(sql,{question},async()=>{calls++;assert.fail('requested balance buckets must remain unchanged');},{extended:true});
  assert.equal(calls,0);assert.match(query.sql,/round\(balance::numeric \/ 100000000\)/);assert.match(query.sql,/GROUP BY/);
 }
});
