'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchReply}=require('../../v1/lib/ask-research-reply');
const {answerTaskFor}=require('../../v1/lib/ask-chat');
function result(months,label='month'){
 return {query:{version:3,sql:"SELECT date_trunc('month',date::timestamp) AS month,sum(shielded_transactions) AS shielded_transactions FROM activity_daily GROUP BY 1",limit:100},columns:[{key:'c0',label,type:'text'},{key:'c1',label:'shielded_transactions',type:'number'}],rows:months.map(month=>[month,'100']),truncated:false,datasets:['activity_daily'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-15T07:11:06Z',indexedThrough:'2026-10-15T00:00:00Z',coverage:'verified canonical records',units:'exact'};
}
test('wholly wrong monthly years fail before paid explanation for one explicit requested year',async()=>{
 for(const question of ['Compare monthly counts during 2025.','Monthly counts in 2025','Monthly counts for calendar year 2025']){
  await assert.rejects(researchReply(result(['2020-01-01 00:00:00+00','2022-12-01 00:00:00+00']),{question},()=>assert.fail('Do not pay to explain the wrong requested year'),'en',answerTaskFor),e=>e.askKind==='answer');
 }
});
test('scope sanity check preserves direct SQL, lookback rows, multiple years and unresolved dates',async()=>{
 const reply=async(value,question)=>researchReply(value,{question},async()=>({summary:'The returned count is {{row_a_b}}.',observations:[],limitation:''}),'en',answerTaskFor);
 for(const [value,question] of [[result(['2025-01-01','2025-12-01']),'Monthly counts during 2025'],[result(['2024-12-01','2025-01-01']),'Monthly counts during 2025'],[result(['2020-01-01']),undefined],[result(['2020-01-01']),'Compare 2020 with 2025'],[result(['2020-01-01']),'Monthly counts in 2025 versus 2020'],[result(['2020-01-01']),'Use a threshold of 2025 transactions'],[result(['unknown']),'Monthly counts during 2025'],[result(['2020-01-01'],'baseline_month'),'Monthly counts during 2025']]){
  const actual=await reply(value,question);assert.deepEqual(actual.research.rows,value.rows);assert.match(actual.answer,/100/);
 }
});
