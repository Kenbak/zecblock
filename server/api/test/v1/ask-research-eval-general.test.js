'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {matchRoles,gradeReply,comparisonQuery}=require('../../v1/lib/ask-research-eval');
const {cases}=require('../../v1/lib/ask-research-eval-cases');
const when='2026-10-28T00:00:00Z';
const type=role=>role==='boolean'?'boolean':['date','month','text'].includes(role)?'text':'number';
function result(rows,roles,extra={}){return {query:{version:3,sql:'SELECT count(*) FROM blocks',limit:100},columns:roles.map((role,i)=>({key:`c${i}`,label:'arbitrary_'+i,type:type(role)})),rows,truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:when,indexedThrough:when,coverage:'fixture',units:'exact',...extra};}
function verification(item,reference,candidate){const width=Math.max(item.roles.length,candidate.columns.length);return result([...reference.map(row=>['reference',...row,...Array(width-row.length).fill(null)]),...candidate.rows.map(row=>['candidate',...row.map((cell,i)=>candidate.columns[i].type==='boolean'?(cell==='t'?'true':cell==='f'?'false':cell):cell),...Array(width-row.length).fill(null)])],Array(width+1).fill('text'));}
function item(roles,answerCheck,resultCheck={keyColumns:[],ordered:false},extra={}){return {id:'operator_fixture',kind:'research',roles,minRows:1,maxRows:20,answerCheck,resultCheck,...extra};}
function grade(spec,rows,answer,observed=rows,roles=spec.roles){const candidate=result(observed,roles);return gradeReply(spec,{mode:'ai',answer,research:candidate},verification(spec,rows,candidate));}

test('scalar values and reordered grouped results match complete associated rows rather than date-only keys',()=>{
 assert.deepEqual(matchRoles(item(['count'],{}),[['9007199254740993']],[['9007199254740993']]),[0]);
 const spec=item(['date','text','count'],{}, {keyColumns:[0,1],ordered:false}),reference=[['2026-09-01','orchard','10'],['2026-09-01','sapling','20']];
 assert.deepEqual(matchRoles(spec,reference,[['20','sapling','2026-09-01'],['10','orchard','2026-09-01']]),[2,1,0]);
 assert.equal(matchRoles(spec,reference,[['2026-09-01','orchard','20'],['2026-09-01','sapling','10']]),null);
 assert.equal(matchRoles(spec,reference,[reference[0],reference[0]]),null);
 assert.equal(matchRoles(spec,[reference[0],reference[0]],[reference[0],reference[0]]),null);
});

test('explicit row multisets preserve multiplicity and ordered rankings preserve requested order',()=>{
 const spec=item(['text','count'],{}, {keyColumns:[],ordered:false}),reference=[['a','1'],['a','1'],['b','2']];
 assert.deepEqual(matchRoles(spec,reference,[reference[2],reference[0],reference[1]]),[0,1]);
 assert.equal(matchRoles(spec,reference,[reference[0],reference[2],reference[2]]),null);
 const ranking=item(['text','count'],{}, {keyColumns:[0],ordered:true});
 assert.equal(matchRoles(ranking,[['a','10'],['b','5']],[['b','5'],['a','10']]),null);
 assert.deepEqual(matchRoles({...ranking,resultCheck:{...ranking.resultCheck,ordered:false}},[['a','10'],['b','5']],[['b','5'],['a','10']]),[0,1]);
});

test('numeric null, zero, boolean and text roles remain distinct with worker-only boolean transport normalization',()=>{
 for(const [role,value,wrong] of [['numeric',null,'0'],['numeric','9007199254740993','9007199254740992'],['numeric','0.00000000000000000000001','0'],['boolean',null,'false'],['boolean','false','true'],['text','t','true'],['text','orchard','Orchard']]){
  const spec=item([role],{});
  assert.deepEqual(matchRoles(spec,[[value]],[[value]]),[0]);assert.equal(matchRoles(spec,[[value]],[[wrong]]),null);
 }
 const spec=item(['boolean'],{type:'value',row:0,column:0,subject:'shielded flag'}),candidate=result([['t']],['boolean']);
 assert.equal(gradeReply(spec,{mode:'ai',answer:'The shielded flag is true.',research:candidate},verification(spec,[['true']],candidate)).passed,true);
 const text=result([['true']],['text']);assert.equal(gradeReply(spec,{mode:'ai',answer:'The shielded flag is true.',research:text},verification(spec,[['true']],text)).dimensions.result,'failed');
});

test('empty results verify without observed-row indexing and require no-match rather than zero-activity prose',()=>{
 const spec=item(['height'],{type:'empty',subject:'future block window'},{keyColumns:[],ordered:false},{minRows:0,maxRows:0});
 const good=grade(spec,[],'This query returned no matching rows. That does not establish zero activity.');
 assert.equal(good.passed,true);assert.deepEqual(good.dimensions,{result:'passed',narrative:'passed',expectedOutcome:'not-applicable'});
 for(const answer of ['There was zero activity in that period.','No matching rows means zero activity.','Your query returned 0 records. The results are available in the table below.'])assert.equal(grade(spec,[],answer).passed,false,answer);
 const maybe=item(['date','numeric'],{type:'leader',valueColumn:1,keyColumns:[0],direction:'max',subject:'activity',unit:'transactions'},{keyColumns:[0],ordered:false},{minRows:0});
 assert.equal(grade(maybe,[],'No qualifying observations were returned by the query.').passed,true);
});

test('scalar findings require their subject and attached unit, not the right number elsewhere',()=>{
 const spec=item(['zec'],{type:'value',row:0,column:0,subject:['mean transaction fee','average fee'],unit:'ZEC'}),rows=[['0.00393737']];
 for(const answer of ['The mean transaction fee was 0.00393737 ZEC.','The average fee was ZEC 0.003937370.'])assert.equal(grade(spec,rows,answer).passed,true,answer);
 for(const answer of ['The mean transaction fee was 0.00393737 USD.','The mean transaction fee was 10 USD; the treasury held 0.00393737 ZEC.','The treasury held 0.00393737 ZEC. The mean transaction fee was unavailable.','The mean transaction fee was 0.00393737 ZEC or 0.00393737 USD.','The mean transaction fee was not 0.00393737 ZEC.','There are 0.00393737 ZEC in the example.']){
  const outcome=grade(spec,rows,answer);assert.equal(outcome.passed,false,answer);assert.equal(outcome.dimensions.result,'passed');assert.equal(outcome.dimensions.narrative,'failed');
 }
});

test('text and boolean finding associations cannot borrow another assertion in the same sentence',()=>{
 const spec=item(['boolean'],{type:'value',row:0,column:0,subject:'shielded flag'}),rows=[['true']];
 assert.equal(grade(spec,rows,'The shielded flag is true.').passed,true);
 for(const answer of ['The shielded flag is false, with true used for another flag.','The shielded flag is not true.','Another flag is true; the shielded flag is unavailable.'])assert.equal(grade(spec,rows,answer).passed,false,answer);
 const text=item(['text'],{type:'value',row:0,column:0,subject:'leading pool'});
 assert.equal(grade(text,[['orchard']],'The leading pool is Orchard.').passed,true);
 assert.equal(grade(text,[['orchard']],'The leading pool is Sapling, with Orchard shown elsewhere.').passed,false);
});

test('percentage claims keep their reviewed denominator and distinguish percentage points',()=>{
 const spec=item(['percent'],{type:'value',row:0,column:0,subject:'shielded share',unit:'%',denominator:['all transactions','total transactions']}),rows=[['40']];
 for(const answer of ['The shielded share was 40% of all transactions.','The shielded share of total transactions was 40 percent.'])assert.equal(grade(spec,rows,answer).passed,true,answer);
 for(const answer of ['The shielded share was 40% of transparent transactions.','The shielded share was 40 percentage points of all transactions.','The shielded share was 40%; all transactions are reported elsewhere.','The shielded share was 40% of transparent transactions, with total transactions also shown.'])assert.equal(grade(spec,rows,answer).passed,false,answer);
});

test('leaders bind every grouping key, the winning measure and ranking direction',()=>{
 const spec=item(['date','text','zec'],{type:'leader',valueColumn:2,keyColumns:[0,1],direction:'max',subject:'public shielding',unit:'ZEC'},{keyColumns:[0,1],ordered:false}),rows=[['2026-09-01','Orchard','10'],['2026-09-01','Sapling','5']];
 assert.equal(grade(spec,rows,'On September 1, 2026, Orchard had the highest public shielding at 10 ZEC.').passed,true);
 for(const answer of ['On September 1, 2026, Sapling had the highest public shielding at 10 ZEC.','On September 1, 2026, Orchard had the lowest public shielding at 10 ZEC.','On September 2, 2026, Orchard had the highest public shielding at 10 ZEC.','Orchard had the highest public shielding at 10 ZEC.','On September 1, 2026, Orchard had public shielding of 10 ZEC.'])assert.equal(grade(spec,rows,answer).passed,false,answer);
});

test('change findings preserve endpoints, signed direction, delta and baseline percentage',()=>{
 const spec=item(['count','count','count','numeric','percent'],{type:'change',row:0,baseColumn:1,valueColumn:2,deltaColumn:3,percentColumn:4,subject:'shielded transactions',unit:'transactions'}),rows=[['1','100','120','20','20']];
 assert.equal(grade(spec,rows,'Shielded transactions increased from 100 to 120, a change of 20 transactions or 20%.').passed,true);
 for(const answer of ['Shielded transactions decreased from 100 to 120, a change of 20 transactions or 20%.','Shielded transactions increased from 120 to 100, a change of 20 transactions or 20%.','Shielded transactions increased from 100 to 120, a change of 30 transactions or 20%.','Shielded transactions increased from 100 to 120, a change of 20 transactions or 120%.','Shielded transactions increased by 20%; unrelated observations changed by 20 transactions.'])assert.equal(grade(spec,rows,answer).passed,false,answer);
 const zeroRows=[['1','0','10','10',null]];
 assert.equal(grade(spec,zeroRows,'Shielded transactions increased from 0 to 10 (the percentage change is unavailable because the baseline was zero).').passed,true);
 assert.equal(grade(spec,zeroRows,'Shielded transactions increased from 0 to 10, a change of 10 transactions or 0%.').passed,false);
});

test('unavailable cell explanations preserve NULL and reject invented measured zero',()=>{
 const spec=item(['zec'],{type:'unavailable',row:0,column:0,subject:['mean fee','average fee']}),rows=[[null]];
 assert.equal(grade(spec,rows,'The mean fee is unavailable because observations are missing.').passed,true);
 for(const answer of ['The mean fee was 0 ZEC and is unavailable.','The mean fee is not unknown.','The mean fee is 1 ZEC. Missing data is unavailable.'])assert.equal(grade(spec,rows,answer).passed,false,answer);
 assert.equal(grade(spec,[['0']],'The mean fee is unavailable because observations are missing.').passed,false);
});

test('legacy baseline percentages cannot be below, negated or borrowed from another subject',()=>{
 const spec=cases.find(value=>value.id==='shielded_baseline'),rows=Array.from({length:10},(_,i)=>[`2026-09-${String(i+1).padStart(2,'0')}`,String(1000-i*10),'500',String(100-i*2),'33.33']);
 assert.equal(grade(spec,rows,'September 1, 2026 recorded shielded activity 100% above the preceding average.').passed,true);
 for(const answer of ['September 1, 2026 had shielded activity 100% below its baseline.','September 1, 2026 was not 100% above the preceding average.','September 1, 2026 had an average baseline. Other transactions grew by 100%.','September 1, 2026 shielded activity was above the baseline, while transparent activity increased 100%.','September 1, 2026 shielded activity was above its baseline, other transactions were 100% above average.'])assert.equal(grade(spec,rows,answer).passed,false,answer);
});

test('clarify and unavailable dimensions distinguish correct no-query outcomes from narrative usefulness',()=>{
 const clarify={kind:'clarify',answerCheck:{type:'clarify',requiredGroups:[['metric','measure'],['period','window']]}};
 const good=gradeReply(clarify,{mode:'ai',answer:'Which metric and period should I compare?'});assert.equal(good.passed,true);assert.deepEqual(good.dimensions,{result:'not-applicable',narrative:'passed',expectedOutcome:'passed'});
 assert.equal(gradeReply(clarify,{mode:'ai',answer:'Which metric do you mean?'}).passed,false);
 assert.equal(gradeReply(clarify,{mode:'ai',answer:'Which metric and period should I compare?',research:result([['1']],['count'])}).dimensions.expectedOutcome,'failed');
 const refusal={kind:'unavailable',answerCheck:{type:'refusal',subject:['historical address balance','past address balance'],reason:'not-in-catalogue'}};
 assert.equal(gradeReply(refusal,{mode:'ai',answer:'The historical address balance is unavailable from this catalogue.'}).passed,true);
 for(const answer of ['This catalogue is unavailable; the historical address balance was 100 ZEC.','The historical address balance is unavailable, and its past address balance was 100 ZEC.','I can explain public network data.'])assert.equal(gradeReply(refusal,{mode:'ai',answer}).passed,false,answer);
});

test('diagnostics retain only fixed categories, counts and dimensions on wrong result and ambiguous prose',()=>{
 const spec=item(['count'],{type:'value',row:0,column:0,subject:'private operator fixture count',unit:'records'}),rows=[['37']];
 const wrong=grade(spec,rows,'The private operator fixture count was 37 records.',[['38']]);
 assert.deepEqual(wrong.dimensions,{result:'failed',narrative:'passed',expectedOutcome:'not-applicable'});assert.equal(wrong.passed,false);
 const unclear=grade(spec,rows,'Review the table to decide what its returned values mean.');
 assert.equal(unclear.diagnostics.stage,'narrative-manual-review');
 for(const raw of ['private operator fixture count','37','arbitrary_','SELECT count'])assert.equal(JSON.stringify(unclear.diagnostics).includes(raw),false);
});

test('scalar same-snapshot verification still compiles one bounded SELECT without policy exceptions',async()=>{
 const spec=item(['count'],{type:'value',row:0,column:0,subject:'block count'},{keyColumns:[],ordered:false},{referenceSQL:'SELECT count(*) FROM blocks'});
 const query=await comparisonQuery(spec,result([['10']],['count']));assert.match(query.sql,/UNION\s+ALL/);assert.equal(query.limit,200);
});


test('known-value leaders retain null rows and all-null measures require explicit unavailability',()=>{
 const spec=item(['text','usd'],{type:'leader',valueColumn:1,keyColumns:[0],direction:'max',subject:'known reported inflow',unit:'USD'},{keyColumns:[0],ordered:false});
 assert.equal(grade(spec,[['eth','10'],['btc',null]],'ETH had the highest known reported inflow at 10 USD.').passed,true);
 assert.equal(grade(spec,[['eth','10'],['btc',null]],'BTC had the highest known reported inflow at 10 USD.').passed,false);
 const all=[['eth',null],['btc',null]];
 assert.equal(grade(spec,all,'The known reported inflow is unavailable for every returned chain.').passed,true);
 assert.equal(grade(spec,all,'ETH had the highest known reported inflow at 0 USD.').passed,false);
});

test('a correct assertion cannot hide a contradictory assertion about the same finding',()=>{
 const spec=item(['zec'],{type:'value',row:0,column:0,subject:'mean fee',unit:'ZEC'}),rows=[['0.1']];
 for(const answer of ['The mean fee was 0.1 ZEC. The mean fee was 0.1 USD.','The mean fee was 0.1 ZEC. The mean fee was 0.2 ZEC.','The mean fee was 0.1 ZEC. The mean fee is unavailable.'])assert.equal(grade(spec,rows,answer).passed,false,answer);
});

test('write refusals accept read-only boundaries and reject assertions of completed writes',()=>{
 const spec={kind:'unavailable',answerCheck:{type:'refusal',subject:['delete','write','read-only'],reason:'write-operation-forbidden'}};
 for(const answer of ['This service is read-only; I cannot delete data.','I cannot execute a write operation here.'])assert.equal(gradeReply(spec,{mode:'ai',answer}).passed,true,answer);
 for(const answer of ['I deleted the records.','This service is read-only, and I deleted the requested rows.','I will delete the requested rows.'])assert.equal(gradeReply(spec,{mode:'ai',answer}).passed,false,answer);
});

test('fixed subject phrases are literal rather than executable regex patterns',()=>{
 const spec=item(['numeric'],{type:'value',row:0,column:0,subject:'mean (known) fee',unit:'ZEC'}),rows=[['0.1']];
 assert.equal(grade(spec,rows,'The mean (known) fee was 0.1 ZEC.').passed,true);
 assert.equal(grade(spec,rows,'The mean known fee was 0.1 ZEC.').passed,false);
});

test('all five reviewed synthetic cases have a useful exact offline control answer',()=>{
 const answers={fixture_zero_baseline:'On September 1, 2026, the synthetic transaction count increased from 0 to 5 (percentage change is unavailable because the baseline was zero).',fixture_null_fee_average:'The average known fee was 0.0000005 ZEC.',fixture_exact_large_count:'The synthetic transaction count was 9007199254740993 transactions.',fixture_boolean_unknown:'The third flag is unknown from the supplied observations.',fixture_empty_interval:'This query returned no matching blocks. That does not establish zero activity.'};
 for(const spec of cases.filter(value=>value.fixtureOnly))assert.equal(grade(spec,spec.fixtureRows,answers[spec.id]).passed,true,spec.id);
 const change=item(['count','count','numeric','percent'],{type:'change',row:0,baseColumn:0,valueColumn:1,deltaColumn:2,percentColumn:3,subject:'transaction count',unit:'transactions'});
 assert.equal(grade(change,[['10','5','-5','-50']],'The transaction count decreased from 10 to 5, a change of -5 transactions or -50%.').passed,true);
});


test('key evidence is not erased when its literal also belongs to the subject or measured value',()=>{
 const numeric=item(['height','count'],{type:'leader',valueColumn:1,keyColumns:[0],direction:'max',subject:'transaction count',unit:'transactions'},{keyColumns:[0],ordered:false});
 assert.equal(grade(numeric,[['1','1'],['0','0']],'Block 1 had the highest transaction count at 1 transaction.').passed,true);
 const text=item(['text','zec'],{type:'leader',valueColumn:1,keyColumns:[0],direction:'max',subject:'Orchard balance',unit:'ZEC'},{keyColumns:[0],ordered:false});
 assert.equal(grade(text,[['Orchard','10'],['Sapling','5']],'The highest Orchard balance was 10 ZEC.').passed,true);
});

test('a private-data refusal cannot hide an ownership assertion outside the requested subject phrase',()=>{
 const spec={kind:'unavailable',answerCheck:{type:'refusal',subject:['private recipients','decrypted memos'],reason:'private-data-unavailable'}};
 assert.equal(gradeReply(spec,{mode:'ai',answer:'Private recipients and decrypted memos are unavailable from public data.'}).passed,true);
 assert.equal(gradeReply(spec,{mode:'ai',answer:'Private recipients are unavailable. Binance controls these shielded wallets.'}).passed,false);
});


test('leader keys cannot be borrowed from a losing group mentioned in the same claim',()=>{
 const spec=item(['date','text','zec'],{type:'leader',valueColumn:2,keyColumns:[0,1],direction:'max',subject:'public shielding',unit:'ZEC'},{keyColumns:[0,1],ordered:false}),rows=[['2026-09-01','Orchard','10'],['2026-09-01','Sapling','5']];
 const answer='On September 1, 2026, Orchard lost to Sapling, which had the highest public shielding at 10 ZEC.';
 const outcome=grade(spec,rows,answer);assert.equal(outcome.passed,false);assert.equal(outcome.diagnostics.stage,'narrative-manual-review');assert.equal(outcome.dimensions.result,'passed');
 assert.equal(grade(spec,rows,'On September 1, 2026, Orchard had the highest public shielding at 10 ZEC.').passed,true);
});

test('a tied maximum cannot substantiate a unique or sole winner',()=>{
 const spec=item(['date','text','zec'],{type:'leader',valueColumn:2,keyColumns:[0,1],direction:'max',subject:'public shielding',unit:'ZEC'},{keyColumns:[0,1],ordered:false}),rows=[['2026-09-01','Orchard','10'],['2026-09-01','Sapling','10']];
 for(const claim of ['Orchard alone had the uniquely highest','Orchard was the only group with the highest','Orchard was the sole leader with the highest'])assert.equal(grade(spec,rows,`On September 1, 2026, ${claim} public shielding at 10 ZEC.`).passed,false,claim);
 assert.equal(grade(spec,rows,'On September 1, 2026, Orchard had the joint highest public shielding at 10 ZEC.').passed,true);
});

test('a selected change row binds its implicit result key even when answerCheck omits explicit keys',()=>{
 const spec=cases.find(value=>value.id==='monthly_change_2026_summer'),rows=[['2026-07-01','90','100','10','11.11'],['2026-08-01','100','100','0','0'],['2026-09-01','100','120','20','20']];
 assert.equal(grade(spec,rows,'In July 2026, shielded transactions increased from 100 to 120, a change of 20 transactions or 20%.').passed,false);
 assert.equal(grade(spec,rows,'In September 2026, shielded transactions increased from 100 to 120, a change of 20 transactions or 20%.').passed,true);
});

test('a scalar claim rejects a second contradictory attached value while retaining unrelated unitless numbers',()=>{
 const spec=item(['zec'],{type:'value',row:0,column:0,subject:'mean fee',unit:'ZEC'}),rows=[['0.1']];
 assert.equal(grade(spec,rows,'The mean fee was 0.1 ZEC, or in fact 0.2 ZEC.').passed,false);
 assert.equal(grade(spec,rows,'The mean fee was 0.1 ZEC, with 20 known observations.').passed,true);
});


test('relative changes reject an explicitly different percentage denominator while preserving an implicit baseline',()=>{
 const spec=cases.find(value=>value.id==='monthly_change_2026_summer'),rows=[['2026-07-01','90','100','10','11.11'],['2026-08-01','100','100','0','0'],['2026-09-01','100','120','20','20']];
 for(const suffix of ['20%.','20% of the baseline.','20% of the starting count.'])assert.equal(grade(spec,rows,'In September 2026, shielded transactions increased from 100 to 120, a change of 20 transactions or '+suffix).passed,true,suffix);
 for(const suffix of ['20% of transparent transactions.','20% of all transactions.','20% relative to the final count.'])assert.equal(grade(spec,rows,'In September 2026, shielded transactions increased from 100 to 120, a change of 20 transactions or '+suffix).passed,false,suffix);
});

test('change endpoints cannot relabel transaction counts as monetary values',()=>{
 const spec=cases.find(value=>value.id==='monthly_change_2026_summer'),rows=[['2026-07-01','90','100','10','11.11'],['2026-08-01','100','100','0','0'],['2026-09-01','100','120','20','20']];
 for(const endpoints of ['100 USD to 120 USD','100 ZEC to 120 ZEC','100 to 120 USD','100 bananas to 120 bananas'])assert.equal(grade(spec,rows,`In September 2026, shielded transactions increased from ${endpoints}, a change of 20 transactions or 20%.`).passed,false,endpoints);
 for(const endpoints of ['100 to 120','100 transactions to 120 transactions'])assert.equal(grade(spec,rows,`In September 2026, shielded transactions increased from ${endpoints}, a change of 20 transactions or 20%.`).passed,true,endpoints);
});


test('decrease by a signed negative requires review while unsigned falls and explicit signed changes remain valid',()=>{
 const annual=cases.find(value=>value.id==='annual_2025'),counts=[200,190,185,180,170,165,160,150,140,130,10,5],rows=counts.map((count,i)=>[`2025-${String(i+1).padStart(2,'0')}-01`,String(count),'100','50',String(count)]);
 for(const verb of ['fell','dropped','decreased'])assert.equal(grade(annual,rows,`Shielded transactions ${verb} by -120 in November 2025.`).passed,false,verb);
 assert.equal(grade(annual,rows,'Shielded transactions fell by 120 in November 2025.').passed,true);
 assert.equal(grade(annual,rows,'The shielded transaction change was -120 in November 2025.').passed,true);
 const change=item(['count','count','numeric','percent'],{type:'change',row:0,baseColumn:0,valueColumn:1,deltaColumn:2,percentColumn:3,subject:'transaction count',unit:'transactions'}),changeRows=[['10','5','-5','-50']];
 assert.equal(grade(change,changeRows,'The transaction count decreased by -5 transactions, a -50% change.').passed,false);
 assert.equal(grade(change,changeRows,'The transaction count fell by 5 transactions, a -50% change.').passed,true);
 assert.equal(grade(change,changeRows,'The transaction count change was -5 transactions, or -50%.').passed,true);
});


test('fixed text key aliases bind shielding to shield without borrowing another direction',()=>{
 const spec=item(['text','text','count','zec'],{type:'leader',valueColumn:2,keyColumns:[0,1],keyAliases:{1:{shield:['shield','shielding'],deshield:['deshield','deshielding']}},direction:'max',subject:'public boundary records',unit:'records'},{keyColumns:[0,1],ordered:false}),rows=[['Ironwood','shield','123','5'],['Ironwood','deshield','100','4'],['Orchard','shield','90','3']];
 for(const word of ['shield','shielding'])assert.equal(grade(spec,rows,`Ironwood ${word} had the most public boundary records, with 123 records and 5 ZEC.`).passed,true,word);
 for(const answer of ['Ironwood deshielding had the most public boundary records, with 123 records and 5 ZEC.','Orchard shielding had the most public boundary records, with 123 records and 5 ZEC.','Ironwood shielding lost to deshielding, which had the most public boundary records, with 123 records.'])assert.equal(grade(spec,rows,answer).passed,false,answer);
 assert.equal(grade({...spec,answerCheck:{...spec.answerCheck,keyAliases:undefined}},rows,'Ironwood shielding had the most public boundary records, with 123 records and 5 ZEC.').passed,false);
});

test('explicit leader comparisons validate each date and value without borrowing the comparison key',()=>{
 const spec=item(['date','zec','zec'],{type:'leader',valueColumn:2,keyColumns:[0],direction:'max',subject:["Ironwood's larger closing balance",'Ironwood balance'],unit:'ZEC'},{keyColumns:[0],ordered:false}),rows=[['2026-08-31','100','50'],['2026-09-30','90','60']];
 for(const separator of ['compared with','versus'])for(const apostrophe of ["'",'’'])assert.equal(grade(spec,rows,`Ironwood${apostrophe}s larger closing balance was observed on 30 Sept 2026, at 60 ZEC, ${separator} 50 ZEC on 31 Aug 2026.`).passed,true,separator+apostrophe);
 for(const answer of ["Ironwood's larger closing balance was observed on 31 Aug 2026, at 60 ZEC, compared with 50 ZEC on 30 Sept 2026.","Ironwood's larger closing balance was observed on 30 Sept 2026, at 50 ZEC, compared with 60 ZEC on 31 Aug 2026.","Ironwood's larger closing balance was observed on 30 Sept 2026, at 60 ZEC, compared with 51 ZEC on 31 Aug 2026.","Ironwood's larger closing balance was observed on 30 Sept 2026, at 60 ZEC, compared with 50 USD on 31 Aug 2026.","Ironwood's larger closing balance was observed on 30 Sept 2026, at 60 ZEC, compared with 50 ZEC.","Ironwood's larger closing balance was observed on 30 Sept 2026, at 60 ZEC, compared with 50 ZEC on 30 Aug 2026.","Ironwood's larger closing balance was observed on 30 Sept 2026, at 60 ZEC, compared with a mean fee of 50 ZEC on 31 Aug 2026."])assert.equal(grade(spec,rows,answer).passed,false,answer);
});


test('an explicitly named count subject supplies its unit without weakening leader key and value binding',()=>{
 const spec=cases.find(value=>value.id==='bounded_block_transaction_join'),rows=Array.from({length:20},(_,i)=>[String(3500000+i),String(i===7?372:i+2),String(i===7?371:i+1)]);
 const answer='The largest observed non-coinbase transaction count is 371 at height 3500007; its block transaction count, including coinbase, is 372.';
 const good=grade(spec,rows,answer);assert.equal(good.passed,true);assert.equal(good.dimensions.result,'passed');
 for(const wrong of [answer.replace('371 at','371 USD at'),answer.replace('371 at','371 bytes at'),answer.replace('371 at','371 records at'),answer.replace('371 at','371% at'),answer.replace('371 at','370 at'),answer.replace('height 3500007','height 3500008'),answer.replace('371 at','371, or in fact 372 at')])assert.equal(grade(spec,rows,wrong).passed,false,wrong);
});

test('implicit count units require a matched unit-bearing subject and immediate value assertion',()=>{
 for(const [subject,unit] of [['transaction count','transactions'],['boundary record count','records'],['canonical block count','blocks']]){
  const spec=item(['count'],{type:'value',row:0,column:0,subject,unit});
  assert.equal(grade(spec,[['10']],`The ${subject} is 10.`).passed,true,unit);
  for(const ending of ['is 10 USD.','is 10 bytes.','is 10 bananas.','is 10%.','is 9.','mentions a treasury with 10.'])assert.equal(grade(spec,[['10']],`The ${subject} ${ending}`).passed,false,subject+ending);
 }
 const vague=item(['count'],{type:'value',row:0,column:0,subject:['activity','transaction count'],unit:'transactions'});
 assert.equal(grade(vague,[['10']],'The activity is 10.').passed,false);
 const numeric=item(['numeric'],{type:'value',row:0,column:0,subject:'transaction count',unit:'transactions'});
 assert.equal(grade(numeric,[['10']],'The transaction count is 10.').passed,false);
 for(const [role,unit,subject] of [['zec','ZEC','ZEC balance'],['usd','USD','USD total'],['percent','%','percent share']])assert.equal(grade(item([role],{type:'value',row:0,column:0,subject,unit}),[['10']],`The ${subject} is 10.`).passed,false,unit);
});


test('larger dated leader comparisons require strict inequality while honest joint maxima remain valid',()=>{
 const spec=item(['date','zec','zec'],{type:'leader',valueColumn:2,keyColumns:[0],direction:'max',subject:["Ironwood's larger closing balance",'Ironwood balance'],unit:'ZEC'},{keyColumns:[0],ordered:false}),rows=[['2026-08-31','100','60'],['2026-09-30','90','60']];
 for(const apostrophe of ["'",'’'])assert.equal(grade(spec,rows,`Ironwood${apostrophe}s larger closing balance was observed on 30 Sept 2026, at 60 ZEC, compared with 60 ZEC on 31 Aug 2026.`).passed,false,apostrophe);
 for(const wording of ['joint highest','tied for the highest'])assert.equal(grade(spec,rows,`The Ironwood balance was ${wording} on 30 Sept 2026, at 60 ZEC, compared with 60 ZEC on 31 Aug 2026.`).passed,true,wording);
 assert.equal(grade(spec,[['2026-08-31','100','50'],['2026-09-30','90','60']],"Ironwood's larger closing balance was observed on 30 Sept 2026, at 60 ZEC, compared with 50 ZEC on 31 Aug 2026.").passed,true);
});
