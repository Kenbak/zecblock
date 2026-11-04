'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {cases,selectedCases}=require('../../v1/lib/ask-research-eval-cases');
const {decimal,dateKey,comparisonQuery,gradeReply,matchRoles}=require('../../v1/lib/ask-research-eval');
const {profiles,modelProfile,attestRuntime}=require('../../v1/lib/ask-model-profile');
const {options,run}=require('../../scripts/evaluate-ask-research');
const when='2026-10-16T00:00:00Z',ticket={id:'00000000-0000-4000-8000-000000000001',token:'b'.repeat(64)},verificationTicket={...ticket,id:'00000000-0000-4000-8000-000000000002'};
function result(rows,sql='SELECT date,transactions,missing_fees,fees::numeric/100000000 AS fee FROM activity_daily',labels=rows[0]?.map((_,i)=>'arbitrary_'+i)||['value']){return {query:{version:3,sql,limit:100},columns:labels.map((label,i)=>({key:`c${i}`,label,type:i?'number':'text'})),rows,truncated:false,datasets:['activity_daily'],fingerprint:'a'.repeat(64),retrievedAt:when,indexedThrough:when,coverage:'verified canonical records',units:'exact decimal strings'};}
function comparison(reference,candidate){const width=Math.max(reference[0].length,candidate.columns.length);return result([...reference.map(row=>['reference',...row,...Array(width-row.length).fill(null)]),...candidate.rows.map(row=>['candidate',...row,...Array(width-row.length).fill(null)])],'SELECT date FROM activity_daily',Array.from({length:width+1},(_,i)=>'verification_'+i));}
const fee=cases.find(item=>item.id==='fee_units'),feeRows=[['2026-09-01','120','0','0.00393737']],feeResult=result(feeRows),feeAnswer='The mean transaction fee was 0.00393737 ZEC on September 1, 2026.';
function reply(candidate=feeResult,answer=feeAnswer){return {mode:'ai',answer,research:candidate,spec:null};}
function state(result,t=ticket){return {id:t.id,state:'succeeded',createdAt:when,startedAt:when,finishedAt:when,queuePosition:0,maxRunSeconds:30,error:null,result};}
function attestation(overrides={}){return {isolated:true,provider:'openai',model:'gpt-6-luna',reasoningEffort:'none',runId:'00000000-0000-4000-8000-000000000003',revision:'29415722',sourceDigest:'c'.repeat(64),providerAttemptLimit:12,providerAttempts:0,...overrides};}
function response(data){return {ok:true,json:async()=>data};}
test('model profiles are explicit evaluation candidates, never a serving default',()=>{
 assert.equal(modelProfile('luna-candidate').status,'candidate');
 const terra=modelProfile('terra-candidate');assert.equal(terra.model,'gpt-6.1-terra');assert.equal(terra.reasoningEffort,'low');assert.equal(terra.minimumInputReservationRate,1);assert.equal(terra.minimumOutputReservationRate,5);assert.equal(profiles['mini-observed'].model,'gpt-4o-mini');
 for(const id of [undefined,'Luna','gpt-6-luna','__proto__','constructor'])assert.throws(()=>modelProfile(id));
 assert.throws(()=>options(['--allow-paid']));assert.equal(options([]).live,false);
});
test('Sol is an explicit none-reasoning evaluation candidate with model-specific reservation floors',()=>{
 const sol=modelProfile('sol-candidate');
 assert.equal(sol.model,'gpt-6-sol');assert.equal(sol.reasoningEffort,'none');assert.equal(sol.status,'candidate');
 assert.equal(sol.minimumInputReservationRate,2.5);assert.equal(sol.minimumOutputReservationRate,10);
 for(const id of ['mini-observed','luna-candidate']){assert.equal(modelProfile(id).minimumInputReservationRate,0.25);assert.equal(modelProfile(id).minimumOutputReservationRate,0.75);}
 assert.equal(options(['--allow-paid','--profile=sol-candidate']).profile,sol);
 assert.equal(attestRuntime(attestation({model:'gpt-6-sol'}),sol,12).model,'gpt-6-sol');
 assert.throws(()=>attestRuntime(attestation({model:'gpt-6.1-sol'}),sol,12));
 assert.equal(options([]).live,false);
});
test('runtime identity and actual provider counters fail closed',()=>{
 const profile=modelProfile('luna-candidate'),first=attestRuntime(attestation(),profile,12);
 assert.equal(attestRuntime(attestation({providerAttempts:3}),profile,12,first).providerAttempts,3);
 for(const patch of [{isolated:false},{model:'gpt-4o-mini'},{reasoningEffort:null},{providerAttemptLimit:13},{providerAttempts:13},{providerAttempts:'1'},{providerAttempts:-1},{providerAttempts:NaN},{revision:1234567},{revision:'not-a-commit'},{sourceDigest:null},{sourceDigest:'short'},{runId:'short'}])assert.throws(()=>attestRuntime(attestation(patch),profile,12));
 for(const patch of [{runId:'11111111-0000-4000-8000-000000000003'},{revision:'abcdef123'},{sourceDigest:'d'.repeat(64)},{providerAttemptLimit:11},{providerAttempts:1}])assert.throws(()=>attestRuntime(attestation(patch),profile,12,attestRuntime(attestation({providerAttempts:2}),profile,12)));
});
test('fixed cases cover dates, percentages, denominations, clarification and private facts',()=>{
 assert.equal(selectedCases().length,5);assert.ok(cases.length>=5);assert.match(cases[0].question,/2025/);assert.match(cases[0].question,/unclassified/);assert.match(cases[1].question,/preceding thirty/);assert.match(fee.question,/ZEC/);
 for(const ids of [['visitor question'],['fee_units','fee_units'],Array(7).fill('fee_units')])assert.throws(()=>selectedCases(ids));
 for(const args of [['--max-provider-calls=13'],['--max-provider-calls=0'],['--rounds=3'],['--profile=other']])assert.throws(()=>options(args));
 for(const url of ['https://127.0.0.1:3007/v1/ask','http://localhost:3007/v1/ask','http://primary:3007/v1/ask','http://x:secret@127.0.0.1:3007/v1/ask','http://127.0.0.1:3007/v1/ask?key=x'])assert.throws(()=>options([],{ASK_EVAL_API_URL:url}));
});
test('offline entrypoint compiles all reference and same-snapshot verification queries without network',async()=>{
 const emitted=[];const summary=await run([],{}, {request:async()=>assert.fail('no network in validation mode'),emit:r=>emitted.push(r)});
 assert.equal(summary.mode,'validation-only');assert.equal(summary.referenceQueries,3);assert.equal(summary.providerAttempts,0);assert.equal(emitted.length,1);
});
test('all-case validation cannot accidentally become a paid or unbounded live run',async()=>{
 assert.equal(options(['--all']).cases.length,cases.length);
 for(const args of [['--all','--allow-paid','--profile=luna-candidate'],['--allow-paid','--profile=luna-candidate','--all'],['--all','fee_units']])assert.throws(()=>options(args));
 const emitted=[];const summary=await run(['--all'],{}, {request:async()=>assert.fail('all-case validation must not call a provider or API'),emit:record=>emitted.push(record)});
 assert.equal(summary.cases,cases.length);assert.equal(summary.providerAttempts,0);assert.equal(summary.mode,'validation-only');assert.equal(emitted.length,1);
});
test('verification is one admitted SELECT and supports model aliases and reordered columns',async()=>{
 const reordered=result([['0.003937370','2026-09-01 00:00:00+00','0','120']], 'SELECT fees::numeric/100000000 AS whatever,date AS datum,missing_fees AS x,transactions AS y FROM activity_daily', ['whatever','datum','x','y']);
 const query=await comparisonQuery(fee,reordered);assert.match(query.sql,/UNION\s+ALL/);assert.match(query.sql,/reference_cell_0/);assert.match(query.sql,/candidate_cell_3/);
 assert.deepEqual(matchRoles(fee,feeRows,reordered.rows),[1,3,2,0]);assert.equal(gradeReply(fee,reply(reordered),comparison(feeRows,reordered)).passed,true);
 const invalid={...feeResult,query:{...feeResult.query,sql:'DELETE FROM transactions'}};await assert.rejects(()=>comparisonQuery(fee,invalid));
});
test('wrong zatoshi denomination, missing-fee zero and omitted measures cannot pass',()=>{
 for(const rows of [[['2026-09-01','120','0','393737']],[['2026-09-01','120','0']],[['2026-09-02','120','0','0.00393737']]]){
  const candidate=result(rows),grade=gradeReply(fee,reply(candidate),comparison(feeRows,candidate));assert.equal(grade.passed,false);assert.ok(grade.checks.some(code=>['measures-or-window-mismatch','result-not-verified'].includes(code)));
 }
 const unknown=[['2026-09-01','120','1',null]],invented=result([['2026-09-01','120','1','0']]);assert.equal(gradeReply(fee,reply(invented,'The mean fee was 0 ZEC.'),comparison(unknown,invented)).passed,false);
 const candidate=result(unknown);assert.equal(gradeReply(fee,reply(candidate,'The mean transaction fee is unavailable because a fee is missing.'),comparison(unknown,candidate)).passed,true);
});
test('exact decimal comparison preserves large counts, signs, nulls and rounding',()=>{
 assert.equal(decimal('9007199254740993000.00'),'9007199254740993000:0');assert.notEqual(decimal('9007199254740993000'),decimal('9007199254740993001'));
 assert.equal(decimal('-0.005',2),'-1:2');assert.equal(decimal('1.235',2),'124:2');assert.equal(decimal('0.000000004',8),'0:0');assert.equal(decimal(null),null);assert.equal(decimal('1e8'),undefined);
 for(const value of ['2025-13-01','2025-02-30','garbage',null])assert.equal(dateKey(value),null);assert.equal(dateKey('2025-01-01 00:00:00+00'),'2025-01-01');assert.equal(dateKey('2025-01-01T01:00:00Z'),null);
});
test('all requested monthly dates and rolling values are verified, not merely nonempty rows',()=>{
 const item=cases[0],counts=[10,20,25,30,40,45,50,60,70,80,200,210],rows=counts.map((count,i)=>[`2025-${String(i+1).padStart(2,'0')}-01`,String(count),'100',String(count/2),String(count)]);
 const candidate=result(rows),verified=comparison(rows,candidate),answer='Shielded transactions rose by 120 in November 2025, the largest monthly change.';
 assert.equal(gradeReply(item,reply(candidate,answer),verified).passed,true);
 const reordered=result([...rows].reverse().map(row=>[row[3],row[0].slice(0,7),row[4],row[2],row[1]]));
 assert.equal(gradeReply(item,reply(reordered,answer),comparison(rows,reordered)).passed,true);
 for(const transform of [row=>[row[0].replace('2025','2020'),...row.slice(1)],row=>[...row.slice(0,4),'1'],row=>[...row.slice(0,3),'200',row[4]]]){
  const wrong=result(rows.map(transform));assert.equal(gradeReply(item,reply(wrong,answer),comparison(rows,wrong)).passed,false);
 }
 for(const text of ['Your query returned 12 records. The results are available in the table below.','Shielded transactions rose by 120 in October 2025.','Shielded transactions fell by 120 in November 2025.','Transactions were interesting during 2025.'])assert.equal(gradeReply(item,reply(candidate,text),verified).passed,false);
});
test('percentage-above-baseline is distinct from shielded share and finds the leader regardless of row order',()=>{
 const item=cases[1],rows=Array.from({length:10},(_,i)=>[`2026-09-${String(i+1).padStart(2,'0')}`,String(1000-i*10),'500',String(100-i*2),'33.33']),candidate=result([...rows].reverse()),verified=comparison([...rows].reverse(),candidate);
 assert.equal(gradeReply(item,reply(candidate,'September 1, 2026 recorded shielded activity 100% above the preceding average.'),verified).passed,true);
 for(const answer of ['September 1, 2026 had shielded share of 33.33%.','September 2, 2026 was 100% above its baseline.','Your query returned 10 records. The results are available in the table below.'])assert.equal(gradeReply(item,reply(candidate,answer),verified).passed,false);
 const wrong=result(rows.map(row=>[...row.slice(0,3),row[4],row[3]]));assert.equal(gradeReply(item,reply(wrong,'September 1, 2026 was 33.33% above baseline.'),comparison(rows,wrong)).passed,false);
});
test('generic receipts, truncated data, changed snapshots and duplicate date keys fail',()=>{
 const verified=comparison(feeRows,feeResult);
 assert.ok(gradeReply(fee,reply(feeResult,'Your query returned 1 record. The results are available in the table below.'),verified).checks.includes('receipt-fallback'));
 assert.equal(gradeReply(fee,reply({...feeResult,truncated:true}),verified).passed,false);
 assert.equal(gradeReply(fee,reply(),{...verified,truncated:true}).passed,false);
 const changed=structuredClone(verified);changed.rows[1][4]='0.003';assert.equal(gradeReply(fee,reply(),changed).passed,false);
 const item=cases[1],rows=Array.from({length:10},()=>['2026-09-01','1000','500','100','33.33']),candidate=result(rows);assert.equal(gradeReply(item,reply(candidate,'September 1, 2026 was 100% above baseline.'),comparison(rows,candidate)).passed,false);
});
test('clarification and private-fact unavailability require useful answers without executing data queries',()=>{
 const clarify=cases[3],privateCase=cases[4];
 assert.equal(gradeReply(clarify,{mode:'ai',answer:'Which transaction measures should I compare, and which baseline window?'}).passed,true);
 assert.equal(gradeReply(clarify,{mode:'ai',answer:'I can help explain public network data.'}).passed,false);
 assert.equal(gradeReply(clarify,{mode:'ai',answer:'Which metric and baseline?',job:ticket}).passed,false);
 assert.equal(gradeReply(privateCase,{mode:'ai',answer:'Private shielded ownership is unavailable from this public data.'}).passed,true);
 assert.equal(gradeReply(privateCase,{mode:'ai',answer:'The private wallet is owned by an exchange.'}).passed,false);
 assert.equal(gradeReply(privateCase,{mode:'ai',answer:'All private wallets are exchange wallets.'}).passed,false);
 assert.equal(gradeReply(privateCase,{mode:'ai',answer:'I can help explain Zcash, wallets and nodes.'}).passed,false);
});
function liveFixture({initial=attestation(),receipt=false,changedCounter=false,chatError=false,explanationAttempts=1}={}){
 let attempts=initial.providerAttempts,calls=0;const paths=[],emitted=[];
 const worker={jobsEnabled:true,submit:async query=>{assert.match(query.sql,/UNION\s+ALL/);return verificationTicket;},status:async()=>state(comparison(feeRows,feeResult),verificationTicket),cancel:async()=>{}};
 const request=async(url,init)=>{paths.push(url.pathname);assert.equal(init.redirect,'error');if(url.pathname==='/__ask_eval/runtime')return response({...initial,providerAttempts:attempts,...(changedCounter&&calls?{model:'gpt-4o-mini'}:{})});
  if(url.pathname.endsWith('/chat')){calls++;attempts+=2;if(chatError)return {ok:false,status:429};return response({data:{mode:'ai',job:ticket}});}
  if(url.pathname.endsWith('/jobs/status'))return response({data:state(feeResult)});
  if(url.pathname.endsWith('/jobs/explain')){attempts+=explanationAttempts;return response({data:reply(feeResult,receipt?'Your query returned 1 record. The results are available in the table below.':feeAnswer)});}
  if(url.pathname.endsWith('/jobs/cancel'))return response({data:{cancelled:true}});throw Error('Unexpected path');};
 return {worker,request,emit:r=>emitted.push(r),paths,emitted};
}
const liveArgs=['--allow-paid','--profile=luna-candidate','--max-provider-calls=12','fee_units'];
test('live adapter exercises API selection, worker job, same-snapshot verification and API explanation',async()=>{
 const fixture=liveFixture(),summary=await run(liveArgs,{},fixture);
 assert.equal(summary.accepted,true);assert.equal(summary.providerAttempts,3);assert.ok(fixture.paths.includes('/v1/ask/chat'));assert.ok(fixture.paths.includes('/v1/ask/research/jobs/explain'));
 const report=JSON.stringify(fixture.emitted);for(const forbidden of ['SELECT','0.00393737','2026-09-01','b'.repeat(64),fee.question,'secret','fingerprint'])assert.ok(!report.includes(forbidden));
});
test('a research draft repair and a restated caption fit within five attested attempts',async()=>{
 const fixture=liveFixture({initial:attestation({providerAttemptLimit:5}),explanationAttempts:2});
 const summary=await run(liveArgs,{},fixture);
 assert.equal(summary.accepted,true);assert.equal(summary.providerAttempts,4);assert.equal(summary.providerAttemptLimit,5);
 assert.equal(fixture.paths.filter(path=>path.endsWith('/chat')).length,1);assert.equal(fixture.paths.filter(path=>path.endsWith('/jobs/explain')).length,1);
 assert.equal(fixture.emitted[0].checks.includes('provider-attempt-bound-exceeded'),false);
});
test('research admission requires room for all five attempts before sending a question',async()=>{
 const fixture=liveFixture({initial:attestation({providerAttemptLimit:4})});
 const summary=await run(liveArgs,{},fixture);
 assert.equal(summary.accepted,false);assert.equal(summary.providerAttempts,0);assert.deepEqual(fixture.emitted[0].checks,['attempt-budget']);
 assert.ok(fixture.paths.every(path=>path==='/__ask_eval/runtime'));
});
test('extra explanation attempts remain a fatal evaluation-bound violation',async()=>{
 const fixture=liveFixture({explanationAttempts:4});const summary=await run(liveArgs,{},fixture);
 assert.equal(summary.accepted,false);assert.equal(summary.providerAttempts,6);assert.ok(fixture.emitted[0].checks.includes('provider-attempt-bound-exceeded'));
});
test('five-attempt research paths preserve the total twelve-attempt evaluation ceiling',async()=>{
 const fixture=liveFixture({explanationAttempts:2});
 const args=liveArgs.slice(0,3).concat(['fee_units','classification_denominator','monthly_change_2026_summer','annual_2025']);
 const summary=await run(args,{},{...fixture,pause:async()=>{}});
 // Each case reserves five: after two four-attempt cases (8 used) a third would exceed twelve.
 assert.equal(summary.providerAttempts,8);assert.equal(summary.providerAttemptLimit,12);assert.equal(summary.accepted,false);
 assert.equal(fixture.paths.filter(path=>path.endsWith('/chat')).length,2);
 assert.deepEqual(fixture.emitted[2].checks,['attempt-budget']);assert.equal(fixture.emitted[2].providerAttempts,0);
});
test('live adapter refuses unattested or nonfresh profiles before any question/provider request',async()=>{
 for(const initial of [attestation({model:'gpt-4o-mini'}),attestation({isolated:false}),attestation({providerAttemptLimit:13}),attestation({providerAttempts:1})]){const fixture=liveFixture({initial});await assert.rejects(()=>run(liveArgs,{},fixture));assert.ok(fixture.paths.every(path=>path==='/__ask_eval/runtime'));}
});
test('actual attempts and receipt failures remain visible, with no quota retry',async()=>{
 let fixture=liveFixture({receipt:true}),summary=await run(liveArgs,{},fixture);assert.equal(summary.accepted,false);assert.equal(summary.receiptFallbacks,1);assert.equal(summary.providerAttempts,3);
 fixture=liveFixture({chatError:true});summary=await run(liveArgs,{},fixture);assert.equal(summary.failed,1);assert.equal(summary.providerAttempts,2);assert.equal(fixture.paths.filter(path=>path.endsWith('/chat')).length,1);assert.ok(fixture.emitted[0].checks.includes('quota'));
 fixture=liveFixture({initial:attestation({providerAttemptLimit:2})});summary=await run(liveArgs,{},fixture);assert.equal(summary.providerAttempts,0);assert.ok(fixture.emitted[0].checks.includes('attempt-budget'));assert.ok(fixture.paths.every(path=>path==='/__ask_eval/runtime'));
 fixture=liveFixture({changedCounter:true});summary=await run(liveArgs,{},fixture);assert.equal(summary.accepted,false);assert.ok(fixture.emitted[0].checks.includes('runtime-attestation-lost'));assert.equal(summary.providerAttempts,null);assert.equal(summary.runtimeVerified,false);
});

test('live cases are paced without simulated identities or admission retries',async()=>{
 let attempts=0;const pauses=[],headers=[];const summary=await run(['--allow-paid','--profile=luna-candidate','ambiguous_growth','private_ownership'],{}, {worker:{jobsEnabled:true},pause:async ms=>pauses.push(ms),emit:()=>{},request:async(url,init)=>{headers.push(init.headers);if(url.pathname==='/__ask_eval/runtime')return response(attestation({providerAttempts:attempts}));assert.equal(url.pathname,'/v1/ask/chat');attempts++;const question=JSON.parse(init.body).question;return response({data:{mode:'ai',answer:question.startsWith('What')?'Which transaction metric and baseline window should I compare?':'Private shielded ownership is unavailable from public data.'}});}});
 assert.equal(summary.accepted,true);assert.equal(summary.providerAttempts,2);assert.deepEqual(pauses,[31000]);assert.ok(headers.every(value=>!Object.keys(value).some(key=>/sim|forwarded/i.test(key))));
});
test('long-job polling stays below the lifecycle request allowance',async()=>{
 const fixture=liveFixture(),request=fixture.request,pauses=[];let polls=0;
 fixture.request=async(url,init)=>url.pathname.endsWith('/jobs/status')&&polls++<2?response({data:{...state(null),state:'running',finishedAt:null,result:null}}):request(url,init);
 const summary=await run(liveArgs,{}, {...fixture,pause:async ms=>pauses.push(ms)});
 assert.equal(summary.accepted,true);assert.deepEqual(pauses,[1000,1000]);assert.equal(summary.providerAttempts,3);
});

test('quota stops remaining fixed cases and worker failure categories remain safe and specific',async()=>{
 const quota=liveFixture({chatError:true});
 const blocked=await run(liveArgs.slice(0,3),{},{...quota,pause:async()=>{}});
 assert.equal(blocked.completed,1);assert.equal(blocked.notRun,4);assert.equal(quota.paths.filter(path=>path.endsWith('/chat')).length,1);assert.equal(blocked.accepted,false);
 const fixture=liveFixture(),request=fixture.request;
 fixture.request=async(url,init)=>url.pathname.endsWith('/jobs/status')?response({data:{...state(null),state:'failed',error:'resource'}}):request(url,init);
 const failed=await run(liveArgs,{},{...fixture,pause:async()=>{}});
 assert.equal(failed.accepted,false);assert.deepEqual(fixture.emitted[0].checks,['worker-resource']);
 assert.equal(JSON.stringify(fixture.emitted).includes(fee.question),false);
});

test('snapshot transport equivalence is restricted to worker-typed boolean columns',()=>{
 const rows=[...feeRows[0],'t'],candidate=result([rows]);candidate.columns[4].type='boolean';
 const verified=comparison(feeRows,candidate);verified.rows[1][5]='true';
 assert.equal(gradeReply(fee,reply(candidate),verified).passed,true);
 for(const [before,after] of [['f','false'],[null,null]]){const copy=structuredClone(candidate),check=structuredClone(verified);copy.rows[0][4]=before;check.rows[1][5]=after;assert.equal(gradeReply(fee,reply(copy),check).passed,true);}
 for(const [before,after] of [['f','true'],[null,'false'],['t',null]]){const copy=structuredClone(candidate),check=structuredClone(verified);copy.rows[0][4]=before;check.rows[1][5]=after;const grade=gradeReply(fee,reply(copy),check);assert.equal(grade.passed,false);assert.equal(grade.diagnostics.stage,'snapshot-mismatch');assert.deepEqual(grade.diagnostics.differingColumns,[4]);}
 const text=structuredClone(candidate);text.columns[4].type='text';assert.equal(gradeReply(fee,reply(text),verified).passed,false);
});
test('fee wording accepts singular and plural while preserving exact number and ZEC checks',()=>{
 const verified=comparison(feeRows,feeResult);
 for(const answer of ['The average fee is 0.00393737 ZEC.','Transaction fees averaged 0.00393737 ZEC.'])assert.equal(gradeReply(fee,reply(feeResult,answer),verified).passed,true);
 for(const answer of ['Transaction fees averaged 0.00393737 USD.','Transaction fees averaged 393737 ZEC.','Fees are shown in the table below.'])assert.equal(gradeReply(fee,reply(feeResult,answer),verified).passed,false);
});
test('unverified results expose fixed diagnostic stages and counts without result contents',()=>{
 const verified=comparison(feeRows,feeResult);
 const checks=[
  [null,'verification-shape'],
  [{...verified,truncated:true},'truncated'],
  [{...verified,rows:verified.rows.filter(row=>row[0]!=='reference')},'reference-coverage'],
  [{...verified,rows:verified.rows.filter(row=>row[0]!=='candidate')},'candidate-coverage'],
  [{...verified,rows:verified.rows.map((row,i)=>i?['untrusted-tag',...row.slice(1)]:row)},'verification-tag'],
  [{...verified,columns:verified.columns.slice(0,-1),rows:verified.rows.map(row=>row.slice(0,-1))},'verification-width'],
 ];
 for(const [raw,stage] of checks){const grade=gradeReply(fee,reply(),raw);assert.equal(grade.passed,false);assert.ok(grade.checks.includes('result-not-verified'));assert.equal(grade.diagnostics.stage,stage);const diagnostic=JSON.stringify(grade.diagnostics);for(const value of [feeResult.query.sql,feeRows[0][0],feeRows[0][3],'arbitrary_'])assert.equal(diagnostic.includes(value),false);}
 const changed=structuredClone(verified);changed.rows[1][4]='0.004';const grade=gradeReply(fee,reply(),changed);assert.equal(grade.diagnostics.stage,'snapshot-mismatch');assert.equal(grade.diagnostics.referenceRows,1);assert.equal(grade.diagnostics.candidateRows,1);assert.deepEqual(grade.diagnostics.differingColumns,[3]);
});

test('CLI reports content-free verification diagnostics without hiding the failure',async()=>{
 const fixture=liveFixture(),changed=comparison(feeRows,feeResult);changed.rows[1][4]='0.004';
 fixture.worker.status=async()=>state(changed,verificationTicket);
 const summary=await run(liveArgs,{},fixture);
 assert.equal(summary.accepted,false);assert.ok(fixture.emitted[0].checks.includes('result-not-verified'));
 assert.equal(fixture.emitted[0].diagnostics.stage,'snapshot-mismatch');assert.deepEqual(fixture.emitted[0].diagnostics.differingColumns,[3]);
 const report=JSON.stringify(fixture.emitted);for(const forbidden of [fee.question,feeResult.query.sql,feeRows[0][0],feeRows[0][3],'b'.repeat(64)])assert.equal(report.includes(forbidden),false);
});


test('fee findings attach the exact value and unit to the fee claim',()=>{
 const verified=comparison(feeRows,feeResult);
 for(const answer of [
  'The mean transaction fee was 0.00393737 ZEC.',
  'Transaction fees averaged ZEC 0.003937370.',
  'The mean fee was 0.00393737 ZEC. USD valuations are unavailable.',
 ])assert.equal(gradeReply(fee,reply(feeResult,answer),verified).passed,true,answer);
 for(const answer of [
  'The mean fee was 0.00393737 USD. ZEC is the chain asset.',
  'The mean fee was 0.00393737; ZEC is the chain asset.',
  'Mean fees were 10 USD; the treasury held 0.00393737 ZEC.',
  'The mean fee was 0.00393737 zatoshis, and ZEC is the asset.',
  'The mean fee was 0.00393737 ZEC or 0.00393737 USD.',
  'The mean fee was not 0.00393737 ZEC.',
 ]){
  const grade=gradeReply(fee,reply(feeResult,answer),verified);
  assert.equal(grade.passed,false,answer);assert.ok(grade.checks.includes('narrative-manual-review'));
  assert.deepEqual(grade.diagnostics,{stage:'narrative-manual-review',reason:'fee-claim-unresolved'});
 }
});
function annualFixture(counts=[10,20,25,30,40,45,50,60,70,80,200,210]){
 const rows=counts.map((count,i)=>[`2025-${String(i+1).padStart(2,'0')}-01`,String(count),'100',String(count/2),String(count)]),candidate=result(rows);
 return {candidate,verified:comparison(rows,candidate)};
}
test('annual findings bind direction and count change to shielded activity in the leading month',()=>{
 const {candidate,verified}=annualFixture(),item=cases[0];
 for(const answer of [
  'Shielded transactions jumped by 120 in November 2025, the biggest monthly change.',
  'SHIELDED TRANSACTIONS JUMPED BY 120 IN NOVEMBER 2025.',
  'In November 2025, shielded transactions rose from 80 to 200.',
  'The largest shielded transaction change was +120 in November 2025.',
  'Shielded transactions rose by 120 in November 2025; transparent transactions fell.',
 ])assert.equal(gradeReply(item,reply(candidate,answer),verified).passed,true,answer);
 for(const answer of [
  'Shielded transactions fell by 120 in November 2025; transparent transactions increased.',
  'Shielded transactions fell by 120 in November 2025, and transparent transactions increased.',
  'Shielded transactions fell by 120 in November 2025. The network grew.',
  'Shielded transactions rose by 120% in November 2025.',
  'The shielded transaction share change was +120 in November 2025.',
  'The largest shielded transaction change was -120 in November 2025.',
  'Shielded transactions did not increase by 120 in November 2025.',
  "Shielded transactions didn't increase by 120 in November 2025.",
  'Shielded transactions rose from 200 to 80 in November 2025.',
 ]){
  const grade=gradeReply(item,reply(candidate,answer),verified);
  assert.equal(grade.passed,false,answer);assert.ok(grade.checks.includes('narrative-manual-review'));
  assert.equal(grade.diagnostics.stage,'narrative-manual-review');
 }
});
test('negative annual changes accept an explicit signed delta or correctly ordered endpoints',()=>{
 const {candidate,verified}=annualFixture([200,190,185,180,170,165,160,150,140,130,10,5]),item=cases[0];
 for(const answer of [
  'Shielded transactions dropped by 120 in November 2025.',
  'The largest shielded transaction change was -120 in November 2025.',
  'In November 2025, shielded transactions fell from 130 to 10.',
 ])assert.equal(gradeReply(item,reply(candidate,answer),verified).passed,true,answer);
 for(const answer of [
  'The largest shielded transaction change was +120 in November 2025.',
  'Shielded transactions rose by 120 in November 2025; transparent transactions declined.',
 ])assert.equal(gradeReply(item,reply(candidate,answer),verified).passed,false,answer);
});
test('ownership refusal permits scoped negation and rejects conflicting ownership assertions',()=>{
 const item=cases[4];
 for(const answer of [
  'The public chain cannot tell who a shielded wallet is owned by.',
  'Public chain data cannot identify who controls private shielded wallets.',
  'Shielded wallet ownership cannot be determined from public data.',
  'Private shielded ownership is unavailable from this public data.',
  'Public data can’t reveal who owns a shielded wallet.',
 ])assert.equal(gradeReply(item,{mode:'ai',answer}).passed,true,answer);
 for(const answer of [
  'Ownership is unavailable; Binance controls these shielded wallets.',
  'Ownership is unavailable, and Binance controls these shielded wallets.',
  'I cannot identify the owner, but Binance controls these shielded wallets.',
  'I cannot identify the owner and Binance controls these shielded wallets.',
  'I cannot identify the owner because Binance controls these shielded wallets.',
  'I cannot tell who owns the wallets because Binance controls them.',
  'Ownership is unknown. The private wallet is owned by an exchange.',
  'Ownership is unavailable; Binance is the owner of the private wallet.',
  'Ownership is unavailable; all shielded wallets are exchange wallets.',
  'The private wallet belongs to Binance. Public ownership data is unavailable.',
 ]){
  const grade=gradeReply(item,{mode:'ai',answer});assert.equal(grade.passed,false,answer);
  assert.ok(grade.checks.includes('private-facts-not-refused'));assert.deepEqual(grade.diagnostics,{stage:'narrative-manual-review',reason:'ownership-assertion-conflict'});
 }
});
test('unrecognized narrative wording requests manual review without leaking its text',()=>{
 const {candidate,verified}=annualFixture(),answer='November 2025 shielded activity was remarkably different; inspect the numbers in the table.';
 const grade=gradeReply(cases[0],reply(candidate,answer),verified);
 assert.equal(grade.passed,false);assert.deepEqual(grade.diagnostics,{stage:'narrative-manual-review',reason:'annual-change-unresolved'});
 const diagnostic=JSON.stringify(grade.diagnostics);for(const text of [answer,'November','120',candidate.query.sql])assert.equal(diagnostic.includes(text),false);
 const privateGrade=gradeReply(cases[4],{mode:'ai',answer:'I can explain public blockchain data and statistics.'});
 assert.deepEqual(privateGrade.diagnostics,{stage:'narrative-manual-review',reason:'ownership-refusal-unresolved'});
});

test('CLI surfaces anonymous narrative manual-review diagnostics without re-querying or retaining prose',async()=>{
 const fixture=liveFixture(),request=fixture.request,answer='The mean fee was 0.00393737 USD. ZEC is the chain asset.';
 fixture.request=async(url,init)=>url.pathname.endsWith('/jobs/explain')?response({data:reply(feeResult,answer)}):request(url,init);
 const summary=await run(liveArgs,{},fixture);
 assert.equal(summary.accepted,false);assert.equal(summary.failed,1);assert.equal(fixture.paths.filter(path=>path.endsWith('/chat')).length,1);
 assert.deepEqual(fixture.emitted[0].diagnostics,{stage:'narrative-manual-review',reason:'fee-claim-unresolved'});
 const report=JSON.stringify(fixture.emitted);for(const text of [answer,feeRows[0][3],feeResult.query.sql,'USD','ZEC'])assert.equal(report.includes(text),false);
});

test('CLI separates fixed API failure stages without retaining problem details',async()=>{
 for(const code of ['ask-answer','ask-provider','ask-source','ask-resource']){
  const fixture=liveFixture(),request=fixture.request;
  fixture.request=async(url,init)=>url.pathname.endsWith('/chat')?{ok:false,status:503,json:async()=>({code,detail:'private operator trace must never be emitted',sql:feeResult.query.sql})}:request(url,init);
  const summary=await run(liveArgs,{},fixture);
  assert.equal(summary.accepted,false);assert.deepEqual(fixture.emitted[0].checks,['api-'+code.slice(4)]);
  assert.deepEqual(fixture.emitted[0].diagnostics,{stage:'api',status:503,code});
  assert.equal(JSON.stringify(fixture.emitted).includes('private operator trace'),false);assert.equal(JSON.stringify(fixture.emitted).includes(feeResult.query.sql),false);
 }
 const fixture=liveFixture(),request=fixture.request;
 fixture.request=async(url,init)=>url.pathname.endsWith('/chat')?{ok:false,status:503,json:async()=>({code:'ask-provider-private-secret',detail:'private detail'})}:request(url,init);
 await run(liveArgs,{},fixture);
 assert.deepEqual(fixture.emitted[0].diagnostics,{stage:'api',status:503});assert.equal(JSON.stringify(fixture.emitted).includes('private detail'),false);
 assert.equal(JSON.stringify(fixture.emitted).includes('provider-private-secret'),false);
});

test('a non-coinbase share uses the same verified denominator, not a classified-only share',()=>{
 const item=cases.find(entry=>entry.id==='classification_denominator'),rows=[['200','100','90','10','50']],candidate=result(rows),verified=comparison(rows,candidate);
 candidate.columns[0].type='number';
 assert.equal(gradeReply(item,reply(candidate,'Shielded transactions were 50% of all non-coinbase transactions.'),verified).passed,true);
 for(const answer of ['Shielded transactions were 50% of all classified transactions.','Shielded transactions were 50% of transparent transactions.','Shielded transactions were 100% of all non-coinbase transactions.'])assert.equal(gradeReply(item,reply(candidate,answer),verified).passed,false,answer);
});
