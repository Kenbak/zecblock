'use strict';
// Operator-only fixed cases. LIVE requires an isolated serving wrapper which
// counts and caps actual outbound attempts BEFORE contacting the provider.
const {cases:catalogue,selectedCases}=require('../v1/lib/ask-research-eval-cases');
const {modelProfile,attestRuntime}=require('../v1/lib/ask-model-profile');
const {comparisonQuery,gradeReply}=require('../v1/lib/ask-research-eval');
const {compileResearchSQL}=require('../v1/lib/ask-research-sql');
const {jobTicketSchema,jobStatusSchema}=require('../../../lib/ask/research-job-contract');
const {researchResultSchema}=require('../../../lib/ask/research-contract');
const apiCodes=new Set(['ask-resource','ask-query','ask-verification','ask-dataset','ask-source','ask-provider','ask-answer','ask-timeout','ask-unavailable','ask-quota','ask-quota-minute','ask-quota-day','ask-request-attempts','ask-request-minute','ask-request-day','ask-request-global-hour','ask-request-global-day','ask-ai-minute','ask-ai-day','ask-ai-calls-day','ask-ai-budget-day','ask-ai-budget-month','ask-ai-busy','ask-sql-minute','ask-sql-day','ask-sql-global-day','ask-sql-busy','ask-sql-queue','ask-sql-status-minute']);
const apiFailures=new Set(['api-resource','api-query','api-verification','api-dataset','api-source','api-provider','api-answer','api-timeout','api-unavailable']);
function options(args,env={}){
 let live=false,all=false,profile=null,limit=12;const ids=[];
 for(const arg of args){if(arg==='--allow-paid')live=true;else if(arg==='--all')all=true;else if(arg.startsWith('--profile='))profile=modelProfile(arg.slice(10));else if(/^--max-provider-calls=(?:[1-9]|1[0-2])$/.test(arg))limit=Number(arg.split('=')[1]);else if(arg.startsWith('--'))throw Error('Unknown evaluation option');else ids.push(arg);}
 if(all&&(live||ids.length))throw Error('All-case validation is offline only; live runs require a bounded selection');
 const cases=all?catalogue:selectedCases(ids);if(live&&!profile)throw Error('Explicit candidate/comparison profile required');
 if(live&&cases.some(item=>item.fixtureOnly))throw Error('Synthetic fixture cases cannot be used as live data acceptance');
 const url=new URL(env.ASK_EVAL_API_URL||'http://127.0.0.1:3004/v1/ask');
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/v1/ask'||url.search||url.hash)throw Error('Private loopback API required');
 return {live,all,profile,limit,cases,url};
}
async function validateCases(cases){
 for(const item of cases){if(item.kind!=='research')continue;const query=(await compileResearchSQL({version:3,sql:item.referenceSQL,limit:100},{extended:true})).request;
  await comparisonQuery(item,{query,columns:item.roles.map((role,i)=>({key:`c${i}`,label:`role_${i}`,type:['date','month'].includes(role)?'text':'number'})),rows:[],truncated:false,datasets:['activity_daily'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-16T00:00:00Z',indexedThrough:'2026-10-16T00:00:00Z',coverage:'validation only',units:'validation only'});
 }
}
async function run(args,env,{request=fetch,worker=null,emit=record=>console.log(JSON.stringify(record)),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}={}){
 const config=options(args,env);await validateCases(config.cases);
 if(!config.live){const summary={kind:'ask-ai-evaluation',mode:'validation-only',cases:config.cases.length,referenceQueries:config.cases.filter(item=>item.kind==='research').length,providerAttempts:0,meaning:'Reviewed cases and verification SQL compile; no AI quality or live data claim.'};emit(summary);return summary;}
 let identity=null,client=worker,ownedClient=false,attestationLost=false;const records=[];
 async function readJSON(response){
  const reader=response.body?.getReader();if(!reader)return typeof response.json==='function'?response.json():{};
  const chunks=[];let bytes=0;try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>280000)throw Error('Evaluation response too large');chunks.push(Buffer.from(part.value));}}finally{await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }
 async function json(url,init={}){
  const response=await request(url,{...init,redirect:'error',signal:AbortSignal.timeout(45000),headers:{'Content-Type':'application/json',...init.headers}});
  if(!response.ok){
   let problem;try{problem=await readJSON(response);}catch{/* Raw errors never enter the report. */}
   const code=apiCodes.has(problem?.code)?problem.code:null;
   const kind=response.status===429?'quota':response.status===401||response.status===403?'authentication':code&&apiFailures.has('api-'+code.slice(4))?'api-'+code.slice(4):'api-unavailable';
   throw Object.assign(Error('Evaluation request refused'),{kind,verificationDiagnostic:{stage:'api',status:response.status,...(code?{code}:{})}});
  }
  return readJSON(response);
 }
 async function attest(){const next=attestRuntime(await json(new URL('/__ask_eval/runtime',config.url)),config.profile,config.limit,identity);identity=next;return next;}
 async function post(path,body){return (await json(new URL(config.url.pathname+path,config.url),{method:'POST',body:JSON.stringify(body)})).data;}
 async function poll(ticket,status,cancel){
  // Keep long jobs within the existing 90/minute lifecycle guard. Polling at
  // four times per second could make the harness exhaust that guard itself.
  const until=now()+210000;
  try{for(let i=0;i<210&&now()<until;i++){const state=jobStatusSchema.parse(await status(ticket));if(state.id!==ticket.id)throw Error('Mismatched evaluation ticket');if(!['queued','running'].includes(state.state)){if(state.state!=='succeeded'||!state.result)throw Object.assign(Error('Evaluation job failed'),{kind:'worker-'+(state.error||state.state)});return state.result;}await pause(1000);}throw Object.assign(Error('Bounded evaluation poll expired'),{kind:'poll-timeout'});}catch(error){try{await cancel(ticket);}catch{/* Never emit capabilities or raw errors. */}throw error;}
 }
 try{
  await attest();if(identity.providerAttempts!==0)throw Error('Fresh isolated evaluation required');
  if(!client){client=require('../v1/lib/ask-analytics-client').createAnalyticsClient(env);ownedClient=true;}
  if(!client?.jobsEnabled)throw Error('Private verification worker required');
  for(const item of config.cases){
   const started=now(),maximumProviderAttempts=item.kind==='research'?4:3;let ticket=null,checks=[],passed=false,before=null,fatal=false,diagnostics=null,dimensions={result:item.kind==='research'?'not-checked':'not-applicable',narrative:'not-checked',expectedOutcome:item.kind==='research'?'not-applicable':'not-checked'};
   try{
    await attest();before=identity.providerAttempts;
    // /chat selection includes the SQL draft and at most one SQL repair.
    // Research explanation can also need its one budgeted format repair.
    // Reserve the whole possible path inside the unchanged 12-attempt cap.
    // Wrongly routed nonresearch jobs are cancelled.
    // With ASK_AGENT=true a decline or clarification can follow two repaired
    // steps, so nonresearch cases allow three; research stays at three steps
    // plus the caption.
    if(before+maximumProviderAttempts>identity.providerAttemptLimit)throw Object.assign(Error('Provider attempt budget insufficient'),{kind:'attempt-budget'});
    let reply=await post('/chat',{page:'ask',question:item.question,context:null,history:[],locale:'en',challenge:env.ASK_EVAL_CHALLENGE||'operator-fixed-evaluation'});
    if(item.kind==='research'){
     ticket=jobTicketSchema.parse(reply?.job);
     const candidate=await poll(ticket,t=>post('/research/jobs/status',t),t=>post('/research/jobs/cancel',t));
     let combined;
     try{combined=await comparisonQuery(item,candidate);}catch{throw Object.assign(Error('Bounded verification could not be compiled'),{kind:'verification-unavailable',verificationDiagnostic:{stage:'verification-compile'}});}
     const verificationTicket=jobTicketSchema.parse(await client.submit(combined));
     const verification=await poll(verificationTicket,t=>client.status(t),t=>client.cancel(t));
     reply=await post('/research/jobs/explain',{...ticket,question:item.question,locale:'en'});
     if(JSON.stringify(researchResultSchema.parse(reply?.research))!==JSON.stringify(candidate))throw Object.assign(Error('Explanation result changed'),{kind:'result-changed'});
     ({passed,checks,diagnostics,dimensions}=gradeReply(item,reply,verification));
    }else{
     if(reply?.job){ticket=jobTicketSchema.parse(reply.job);await post('/research/jobs/cancel',ticket);}
     ({passed,checks,diagnostics,dimensions}=gradeReply(item,reply));
    }
   }catch(error){checks=[['quota','authentication','attempt-budget','poll-timeout','result-changed','verification-unavailable'].includes(error.kind)||apiFailures.has(error.kind)?error.kind:['worker-timeout','worker-resource','worker-query','worker-source','worker-dataset','worker-quota','worker-unavailable','worker-interrupted','worker-cancelled'].includes(error.kind)?error.kind:'evaluation-unavailable'];diagnostics=error.verificationDiagnostic||null;}
   finally{
    try{await attest();}catch{checks.push('runtime-attestation-lost');passed=false;fatal=true;attestationLost=true;}
    if(ticket&&!passed)try{await post('/research/jobs/cancel',ticket);}catch{/* No raw response logging. */}
   }
   if(before!==null&&identity&&identity.providerAttempts-before>maximumProviderAttempts){checks.push('provider-attempt-bound-exceeded');passed=false;fatal=true;}
   const record={kind:'ask-ai-case',case:item.id,passed,checks,elapsedMs:now()-started,providerAttempts:before===null||attestationLost?null:identity?.providerAttempts-before,...(diagnostics?{diagnostics}:{}),...(dimensions?{dimensions}:{})};records.push(record);emit(record);
   if(fatal||checks.some(code=>['quota','authentication','attempt-budget','worker-quota'].includes(code)))break;
   if(item!==config.cases.at(-1))await pause(31000); // Preserve existing per-IP admission; no simulated identities.
  }
 }finally{if(ownedClient)await client?.close();}
 const research=records.filter(record=>config.cases.find(item=>item.id===record.case)?.kind==='research');
 const dimensions=Object.fromEntries(['result','narrative','expectedOutcome'].map(name=>[name,Object.fromEntries(['passed','failed','not-applicable','not-checked'].map(status=>[status,records.filter(record=>(record.dimensions?.[name]||'not-checked')===status).length]))]));
 const summary={kind:'ask-ai-evaluation',mode:'live-private',profile:config.profile.id,model:identity.model,reasoningEffort:identity.reasoningEffort,revision:identity.revision,sourceDigest:identity.sourceDigest,cases:config.cases.length,completed:records.length,notRun:config.cases.length-records.length,passed:records.filter(record=>record.passed).length,failed:records.filter(record=>!record.passed).length,providerAttempts:attestationLost?null:identity.providerAttempts,runtimeVerified:!attestationLost,providerAttemptLimit:identity.providerAttemptLimit,receiptFallbacks:research.filter(record=>record.checks.includes('receipt-fallback')).length,dimensions,accepted:records.length===config.cases.length&&records.every(record=>record.passed),meaning:'Fixed-case result equivalence and finding checks, not general SQL accuracy, causal proof or public launch readiness.'};emit(summary);return summary;
}
if(require.main===module)run(process.argv.slice(2),process.env).then(summary=>{if(summary.mode==='live-private'&&!summary.accepted)process.exitCode=1;}).catch(()=>{console.error('Private AI evaluation unavailable; no raw question, SQL, row or credential logged');process.exitCode=1;});
module.exports={options,validateCases,run};
