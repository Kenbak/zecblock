'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {createAnalytics}=require('../../v1/lib/ask-analytics');
const {createAnalyticsClient}=require('../../v1/lib/ask-analytics-client');
const {createWorker}=require('../../ask-analytics-worker');
const {sqlQuotaError,sqlQuotaDetails}=require('../../v1/lib/ask-sql-quota');
const {jobStatusSchema}=require('../../../../lib/ask/research-job-contract');
const {randomUUID}=require('node:crypto');
const query={version:3,sql:'SELECT height FROM blocks ORDER BY height DESC LIMIT 1',limit:1};
const serviceKey='fixture-worker-secret-at-least-thirty-two-characters';
const flags={ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core',ASK_RESEARCH_ENABLED:'true',ASK_RESEARCH_JOBS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:serviceKey};
const reader={...flags,ASK_ANALYTICS_DATABASE_URL:'peer-only',ASK_ANALYTICS_SOCKET:'/run/ask-public-db',ASK_ANALYTICS_DAILY_QUERY_LIMIT:'200'};
const clientEnv={...flags,ASK_ANALYTICS_SERVICE_URL:'http://127.0.0.1:3015/'};

test('daily SQL exhaustion and capacity denial are distinct and happen before pool checkout',async()=>{
 const now=Date.parse('2026-10-27T23:59:30Z');
 for(const [reply,code,retryAfter] of [[-2,'ask-sql-global-day',30],[[-1,12],'ask-sql-busy',12]]){
  let checked=0;const analytics=createAnalytics(reader,{pool:{on(){},end(){},connect(){checked++;throw Error('must not connect');}}});
  await assert.rejects(analytics.execute(query,{now,redis:{isReady:true,eval:async()=>reply}}),error=>error.quota===true&&error.quotaCode===code&&error.retryAfter===retryAfter);
  assert.equal(checked,0);await analytics.close();
 }
});
test('private worker failures forward only bounded fixed SQL categories',async()=>{
 for(const [payload,code] of [
  [{quota:{code:'ask-sql-global-day',retryAfter:30}},'ask-sql-global-day'],
  [{quota:{code:'ask-sql-busy',retryAfter:2}},'ask-sql-busy'],
  [{quota:{code:'ask-ai-budget-month',retryAfter:30},error:'private-password'},undefined],
  [{quota:{code:'ask-sql-global-day',retryAfter:86401},error:'private-password'},undefined],
  [{quota:{code:'ask-sql-busy',retryAfter:2,secret:'private-password'}},undefined],
  ['x'.repeat(2048),undefined],
 ]){
  const client=createAnalyticsClient(clientEnv,async()=>typeof payload==='string'?new Response(payload,{status:429}):Response.json(payload,{status:429}));
  for(const request of [()=>client.execute(query),()=>client.submit(query)])await assert.rejects(request(),error=>error.quota===true&&error.quotaCode===code&&!error.message.includes('private-password'));
  await client.close();
 }
});
test('worker query and full queue return the checked category with Retry-After only',async t=>{
 const app=createWorker(flags,{redis:{isReady:true,eval:async()=>0},analytics:{execute:async()=>{throw Object.assign(sqlQuotaError('ask-sql-global-day',30),{message:'private-password'});}},memoryPressure:{assertAvailable:async()=>{}}});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await app.locals.jobs.stop();server.closeAllConnections();server.close();});
 for(const [path,code,retry] of [['query','ask-sql-global-day','30'],['jobs/submit','ask-sql-queue','5']]){
  const response=await fetch(`http://127.0.0.1:${server.address().port}/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+serviceKey},body:JSON.stringify(query)});
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),retry);const body=await response.json();
  assert.deepEqual(body,{error:'allowance',quota:{code,retryAfter:Number(retry)}});assert.doesNotMatch(JSON.stringify(body),/private-password|stack/);
 }
});
test('job quota metadata is optional for old workers and accepted only on a quota failure',()=>{
 const base={id:randomUUID(),state:'failed',createdAt:'2026-10-27T00:00:00Z',startedAt:'2026-10-27T00:00:01Z',finishedAt:'2026-10-27T00:00:02Z',queuePosition:0,maxRunSeconds:30,error:'quota',result:null};
 assert.equal(jobStatusSchema.safeParse(base).success,true);
 const quota={code:'ask-sql-global-day',retryAfter:30};assert.equal(jobStatusSchema.safeParse({...base,quota}).success,true);
 for(const extra of [{quota:{code:'ask-ai-budget-day',retryAfter:30}},{quota:{...quota,retryAfter:0}},{error:'source',quota},{state:'queued',quota}])assert.equal(jobStatusSchema.safeParse({...base,...extra}).success,false);
 assert.deepEqual(sqlQuotaDetails(sqlQuotaError('ask-sql-busy',2)),{code:'ask-sql-busy',retryAfter:2});
 assert.equal(sqlQuotaDetails({quota:true,quotaCode:'secret',retryAfter:1}),undefined);
});
