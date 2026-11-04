'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {once}=require('node:events');
const {randomUUID}=require('node:crypto');
const {createAskRouter}=require('../../v1/routes/ask');
const env={ASK_ENABLED:'true',ASK_PROVIDER:'openai',ASK_MODEL:'fixture',ASK_API_KEY:'fixture',ASK_DAILY_CALL_LIMIT:'200',ASK_DAILY_BUDGET_USD:'1',ASK_MONTHLY_BUDGET_USD:'5',ASK_MAX_INPUT_USD_PER_MILLION:'0.25',ASK_MAX_OUTPUT_USD_PER_MILLION:'0.75',ASK_ABUSE_SECRET:'a'.repeat(32),ASK_TURNSTILE_SECRET:'fixture',ASK_TURNSTILE_HOSTNAME:'example.test',ASK_TURNSTILE_SITE_KEY:'fixture',ASK_RESEARCH_ENABLED:'true',ASK_RESEARCH_JOBS_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core'};
async function serve(t){
 let admissions=0,statusCalls=0;const app=express();app.use(express.json());
 app.use((req,res,next)=>{req.v1={network:'mainnet',requestId:'fixture',abortSignal:new AbortController().signal};next();});
 const router=createAskRouter(env,{redis:{isReady:true,eval:async()=>{admissions++;return 1;}},analytics:{jobsEnabled:true,status:async ticket=>{statusCalls++;return {id:ticket.id,state:'queued'};}},fetch:()=>assert.fail('No provider call'),challengeFetch:async()=>Response.json({success:true,action:'ask',hostname:'example.test'})});
 app.use('/ask',router);const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{router.stop();server.closeAllConnections();server.close();});
 return {admissions:()=>admissions,statusCalls:()=>statusCalls,post:(path,body)=>fetch(`http://127.0.0.1:${server.address().port}/ask${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};
}
test('the pre-verification attempt guard identifies its own limit without using provider or distributed allowance',async t=>{
 const api=await serve(t),body={page:'ask',question:'What is a viewing key?',context:null,history:[],locale:'en'};
 for(let i=0;i<20;i++)assert.equal((await api.post('/chat',body)).status,403);
 const response=await api.post('/chat',body);assert.equal(response.status,429);assert.ok(Number(response.headers.get('retry-after'))>0);assert.ok(Number(response.headers.get('retry-after'))<=60);
 assert.equal((await response.json()).code,'ask-request-attempts');assert.equal(api.admissions(),0);
});
test('the job lifecycle limit is explicit and does not exhaust ordinary direct answers',async t=>{
 const api=await serve(t),ticket={id:randomUUID(),token:'a'.repeat(64)};
 for(let i=0;i<120;i++)assert.equal((await api.post('/research/jobs/status',ticket)).status,200);
 const response=await api.post('/research/jobs/status',ticket);assert.equal(response.status,429);assert.equal((await response.json()).code,'ask-sql-status-minute');assert.equal(api.statusCalls(),120);assert.equal(api.admissions(),0);
 const direct=await api.post('/chat',{page:'ask',question:'What is a viewing key?',context:null,history:[],locale:'en',challenge:'fixture'});assert.equal(direct.status,200);assert.equal((await direct.json()).data.mode,'guided');assert.equal(api.admissions(),1);
});
