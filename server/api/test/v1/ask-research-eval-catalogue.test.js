'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('pgsql-parser');
const {cases,selectedCases,defaultCaseIds,liveCaseLimit}=require('../../v1/lib/ask-research-eval-cases');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const {comparisonQuery}=require('../../v1/lib/ask-research-eval');
const {publishedIds}=require('../../../../lib/ask/research-catalogue');
const firstFive=['annual_2025','shielded_baseline','fee_units','ambiguous_growth','private_ownership'];
const numericRoles=new Set(['count','height','number','numeric','average','percent','zec','usd','zatoshi']);
const roleNames=new Set([...numericRoles,'text','date','month','boolean']);
const when='2026-10-28T00:00:00Z';
const byId=id=>{const item=cases.find(entry=>entry.id===id);assert.ok(item,id);return item;};
function walk(value,visit){if(!value||typeof value!=='object')return;visit(value);for(const child of Object.values(value))walk(child,visit);}

test('operator catalogue expands coverage while preserving the five-case live default',()=>{
 assert.equal(cases.length,41);assert.deepEqual(cases.slice(0,5).map(item=>item.id),firstFive);
 assert.deepEqual(defaultCaseIds,firstFive);assert.deepEqual(selectedCases().map(item=>item.id),firstFive);
 assert.equal(liveCaseLimit,6);assert.equal(cases.filter(item=>item.kind==='research').length,34);
 assert.equal(cases.filter(item=>item.fixtureOnly).length,5);
 assert.deepEqual(new Set(cases.map(item=>item.kind)),new Set(['research','clarify','unavailable']));
 assert.equal(new Set(cases.map(item=>item.id)).size,cases.length);
});

test('explicit batches cannot turn the offline catalogue into an unbounded paid run',()=>{
 const six=cases.filter(item=>!item.fixtureOnly).slice(0,6).map(item=>item.id);
 assert.equal(selectedCases(six).length,6);
 for(const ids of [[...six,'september_partial_weeks'],['unknown-visitor-question'],['fee_units','fee_units'],['__proto__'],[null],null,'fee_units',{}])assert.throws(()=>selectedCases(ids),/Fixed evaluation cases required/);
 for(const item of cases.filter(item=>item.fixtureOnly))assert.throws(()=>selectedCases([item.id]),/Fixed evaluation cases required/);
 assert.equal(cases.filter(item=>item.fixtureOnly).length,5,'offline fixture coverage remains available through exported cases');
});

test('fixed questions, nested requirements and exact fixture cells are immutable',()=>{
 assert.ok(Object.isFrozen(cases));assert.ok(Object.isFrozen(defaultCaseIds));
 for(const item of cases){assert.ok(Object.isFrozen(item));assert.ok(Object.isFrozen(item.coverage));assert.ok(item.question.length>20&&item.question.length<=1000);assert.match(item.id,/^[a-z][a-z0-9_]+$/);if(item.roles)assert.ok(Object.isFrozen(item.roles));if(item.answerCheck)assert.ok(Object.isFrozen(item.answerCheck));}
 const fixture=byId('fixture_exact_large_count');assert.ok(Object.isFrozen(fixture.fixtureRows[0]));
 assert.throws(()=>{fixture.fixtureRows[0][1]='9007199254740992';},TypeError);
 assert.throws(()=>{byId('classification_denominator').answerCheck.denominator.push('only classified');},TypeError);
});

test('historical, current and synthetic coverage have explicit different meanings',()=>{
 assert.deepEqual(new Set(cases.map(item=>item.coverage.basis)),new Set(['historical','synthetic','current']));
 for(const item of cases){assert.ok(item.coverage.description.length>=20);if(item.fixtureOnly){assert.equal(item.kind,'research');assert.equal(item.coverage.basis,'synthetic');assert.ok(Array.isArray(item.fixtureRows));assert.ok(item.fixtureRows.every(row=>row.length===item.roles.length&&row.every(cell=>cell===null||typeof cell==='string')));}}
 assert.equal(byId('current_address_balance_rank').coverage.basis,'current');
 assert.match(byId('current_address_balance_rank').question,/CURRENT/);
 assert.equal(byId('latest_ten_block_fees').coverage.basis,'current');
 assert.match(byId('flow_pool_direction_totals').coverage.description,/completeness unverified/);
 assert.match(byId('historical_address_balance_unavailable').coverage.description,/cannot establish historical/);
});

test('fixed answer requirements bind columns, keys, quantities and denominators',()=>{
 for(const item of cases.slice(5)){
  const check=item.answerCheck;assert.ok(check,item.id);
  assert.ok(['value','leader','change','unavailable','empty','clarify','refusal'].includes(check.type),item.id);
  if(item.kind==='research'){
   assert.ok(item.roles.every(role=>roleNames.has(role)),item.id);
   assert.ok(Number.isInteger(item.minRows)&&Number.isInteger(item.maxRows)&&item.minRows>=0&&item.minRows<=item.maxRows&&item.maxRows<=100,item.id);
   assert.ok(Array.isArray(item.resultCheck.keyColumns));assert.equal(new Set(item.resultCheck.keyColumns).size,item.resultCheck.keyColumns.length);
   for(const index of item.resultCheck.keyColumns)assert.ok(Number.isInteger(index)&&index>=0&&index<item.roles.length,item.id);
   for(const name of ['column','valueColumn','baseColumn','deltaColumn','percentColumn'])if(check[name]!==undefined)assert.ok(Number.isInteger(check[name])&&check[name]>=0&&check[name]<item.roles.length,item.id+':'+name);
   if(check.row!==undefined)assert.ok(Number.isInteger(check.row)&&check.row>=0&&check.row<item.maxRows,item.id);
   if(check.keyColumns)for(const index of check.keyColumns)assert.ok(Number.isInteger(index)&&index>=0&&index<item.roles.length,item.id);
  }else assert.equal(item.referenceSQL,undefined,'clarification/refusal must not carry executable SQL');
 }
 assert.deepEqual(byId('classification_denominator').answerCheck.denominator,['all transactions','total transactions','all non-coinbase transactions','total non-coinbase transactions']);
 assert.ok(byId('ironwood_combined_share').answerCheck.denominator.includes('Orchard plus Ironwood'));
 assert.equal(byId('fixture_zero_baseline').answerCheck.percentColumn,4);
 assert.equal(byId('fixture_boolean_unknown').answerCheck.type,'unavailable');
});

for(const item of cases.filter(entry=>entry.kind==='research'))test('unchanged compiler and same-snapshot composition accept '+item.id,async()=>{
 const request={version:3,sql:item.referenceSQL,limit:100};
 const compiled=await compileResearchSQL(request,{extended:true});
 assert.equal(compiled.request.limit,100);assert.deepEqual(compiled.values,[101]);assert.ok(compiled.datasets.length);
 assert.deepEqual(await compileResearchSQL(compiled.request,{extended:true}),compiled,'canonical recompilation stays identical');
 const tree=await parse(item.referenceSQL),statement=tree.stmts[0].stmt.SelectStmt;
 assert.equal(tree.stmts.length,1);assert.equal(statement.targetList.length,item.roles.length,'declared role count equals SELECT output width');
 walk(tree,node=>{if(node.SelectStmt?.limitCount){const value=node.SelectStmt.limitCount.A_Const?.ival?.ival;if(value!==undefined)assert.ok(value>=0&&value<=100,'explicit literal result limits stay <=100');}});
 const candidate={query:compiled.request,columns:item.roles.map((role,i)=>({key:'c'+i,label:'fixed_'+i,type:role==='boolean'?'boolean':numericRoles.has(role)?'number':'text'})),rows:[],truncated:false,datasets:compiled.datasets,fingerprint:compiled.fingerprint,retrievedAt:when,indexedThrough:when,coverage:'offline compilation only',units:'exact string cells'};
 const combined=await comparisonQuery(item,candidate);
 assert.equal(combined.limit,200,'two bounded <=100-row sides share one admitted snapshot');
 assert.equal((await compileResearchSQL(combined,{extended:true})).request.sql,combined.sql);
});

// labels is an inlined constant table, covered by ask-research-question-scope.test.js.
test('references exercise every published dataset and retain complex relational shapes',async()=>{
 const datasets=new Set(),features=new Set();
 for(const item of cases.filter(entry=>entry.kind==='research')){const compiled=await compileResearchSQL({version:3,sql:item.referenceSQL,limit:100},{extended:true});for(const name of compiled.datasets)datasets.add(name);for(const feature of compiled.features)features.add(feature);}
 assert.deepEqual([...datasets].sort(),publishedIds.filter(id=>id!=='labels').sort());
 for(const feature of ['cte','window','join','group'])assert.ok(features.has(feature),feature);
 for(const id of ['bounded_block_transaction_join','bounded_transaction_flow_join']){
  const tree=await parse(byId(id).referenceSQL);let independentlyBound=0;
  walk(tree,node=>{if(node.SelectStmt?.fromClause?.some(from=>['blocks','transactions','flows'].includes(from.RangeVar?.relname))){assert.ok(node.SelectStmt.whereClause,id+' raw input must remain independently bounded');independentlyBound++;}});
  assert.equal(independentlyBound,2);
 }
});

test('synthetic oracles distinguish zero, unavailable, exact counts and empty sets',()=>{
 // These are independently calculated fixture expectations, not native PG proof.
 const nullFees=byId('fixture_null_fee_average').fixtureRows[0];
 const known=[100n,0n],mean=(known[0]+known[1])/BigInt(known.length);
 assert.deepEqual(nullFees.slice(0,3),['3','2','1']);
 assert.equal(BigInt(nullFees[3].replace('.','')),mean,'eight-place ZEC average retains known zero and excludes missing');
 const zero=byId('fixture_zero_baseline').fixtureRows[0];assert.equal(BigInt(zero[2])-BigInt(zero[1]),BigInt(zero[3]));assert.equal(zero[4],null);
 assert.equal(byId('fixture_exact_large_count').fixtureRows[0][1],(2n**53n+1n).toString());
 assert.deepEqual(byId('fixture_boolean_unknown').fixtureRows[0].slice(1),['true','false',null]);
 assert.deepEqual(byId('fixture_empty_interval').fixtureRows,[]);assert.equal(byId('fixture_empty_interval').maxRows,0);
});
