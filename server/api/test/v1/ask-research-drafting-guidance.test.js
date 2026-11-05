'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {instructionsFor,compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {selectionTask}=require('../../v1/lib/ask-chat');
test('AI drafts return the derived comparison and its baseline needed for a factual explanation',()=>{
 for(const extended of [false,true]){
  for(const instruction of [instructionsFor(extended),selectionTask('',{researchEnabled:true,researchExtended:extended}).instruction]){
   assert.match(instruction,/largest month-to-month change or a percentage comparison/);
   assert.match(instruction,/compute the needed delta or percentage in SQL/);
   assert.match(instruction,/clearly labeled column alongside the relevant observation date and baseline values/);
   assert.match(instruction,/cannot calculate an unreturned difference, percentage or other derived figure/);
  }
 }
});
test('derived-explanation guidance does not rewrite direct SQL or require extra result columns',async()=>{
 const request={version:3,sql:"SELECT date,shielded_transactions FROM activity_daily WHERE date>=DATE '2025-01-01' AND date<DATE '2026-01-01' ORDER BY date",limit:100};
 const first=await compileResearchSQL(request,{extended:true});
 const second=await compileResearchSQL(first.request,{extended:true});
 assert.deepEqual(second.request,first.request);assert.equal(first.request.limit,100);assert.deepEqual(first.datasets,['activity_daily']);
 assert.doesNotMatch(first.request.sql,/lag\(|lead\(|delta|percentage|baseline/i);
 await assert.rejects(()=>compileResearchSQL({version:3,sql:'DELETE FROM transactions',limit:100},{extended:true}));
});
