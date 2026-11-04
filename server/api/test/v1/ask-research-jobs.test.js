'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {createClient}=require('redis');
const {createResearchJobs,PREFIX}=require('../../v1/lib/ask-research-jobs');
const {createWorker}=require('../../ask-analytics-worker');
const {createAnalyticsClient}=require('../../v1/lib/ask-analytics-client');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const {cacheKey,readCached,saveCached,PREFIX:CACHE_PREFIX}=require('../../v1/lib/ask-research-cache');
const {askError}=require('../../v1/lib/ask-errors');
const env={ASK_RESEARCH_ENABLED:'true',ASK_RESEARCH_JOBS_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core',ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:'fixture-private-worker-key-at-least-thirty-two-characters'};
const query={version:3,sql:'SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 5',limit:5};
async function fixture(t,{spawnImpl,createClientImpl=createClient,startupTimeout=5000}={}){
 const {spawn}=require('node:child_process'),{mkdtemp,rm}=require('node:fs/promises'),{tmpdir}=require('node:os'),{join}=require('node:path');
 const dir=await mkdtemp(join(tmpdir(),'ask-jobs-redis-')),socket=join(dir,'redis.sock');
 let child,redis,cleanup;
 const exitedWithin=milliseconds=>new Promise(resolve=>{
  if(child.exitCode!==null||child.signalCode!==null)return resolve(true);
  const finish=value=>{clearTimeout(timer);child.off('exit',exited);resolve(value);},exited=()=>finish(true);
  const timer=setTimeout(()=>finish(false),milliseconds);child.once('exit',exited);
 });
 const close=()=>cleanup??=(async()=>{
  if(redis?.isOpen)redis.destroy();
  if(child?.pid&&child.exitCode===null&&child.signalCode===null){
   child.kill('SIGTERM');
   if(!await exitedWithin(1000)){child.kill('SIGKILL');if(!await exitedWithin(1000))throw Error('Redis fixture did not exit');}
  }
  await rm(dir,{recursive:true,force:true});
 })();
 // Register cleanup before startup or connection can fail. A readiness timeout
 // must not leave a live Redis child keeping the whole test process open.
 t.after(close);
 try{
  child=(spawnImpl||spawn)('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});
  child.on('error',()=>{});child.stderr.resume();
  await new Promise((resolve,reject)=>{
   let output='';
   const finish=error=>{clearTimeout(timer);child.off('error',failed);child.off('exit',exited);child.stdout.off('data',data);child.stdout.resume();if(error)reject(error);else resolve();};
   const failed=error=>finish(error),exited=()=>finish(Error('Redis exited before readiness'));
   const data=chunk=>{output=(output+chunk.toString()).slice(-2048);if(/ready to accept connections/i.test(output))finish();};
   const timer=setTimeout(()=>finish(Error('Redis start timeout')),startupTimeout);
   child.once('error',failed);child.once('exit',exited);child.stdout.on('data',data);
  });
  redis=createClientImpl({socket:{path:socket,connectTimeout:5000,reconnectStrategy:false}});redis.on('error',()=>{});await redis.connect();
  return redis;
 }catch(error){await close();throw error;}
}
test('Redis fixture accepts split Redis 7 Unix-socket readiness and releases its child',async t=>{
 const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path');let child,dir;
 const client={isOpen:false,on(){},async connect(){this.isOpen=true;},destroy(){this.isOpen=false;}};
 assert.equal(await fixture(t,{createClientImpl:()=>client,spawnImpl:(_command,args,options)=>{
  dir=path.dirname(args[args.indexOf('--unixsocket')+1]);
  child=spawn(process.execPath,['-e',"process.stdout.write('The server is now ready to accept con');setTimeout(()=>process.stdout.write('nections at /tmp/fixture\\n'),10);setInterval(()=>{},1000)"],options);return child;
 }}),client);
 t.after(async()=>{assert.equal(client.isOpen,false);assert.ok(child.exitCode!==null||child.signalCode!==null);await assert.rejects(fs.access(dir),{code:'ENOENT'});});
});
test('Redis fixture readiness timeout kills a never-ready child and removes its socket directory',async t=>{
 const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path');let child,dir;
 await assert.rejects(fixture(t,{startupTimeout:30,spawnImpl:(_command,args,options)=>{
  dir=path.dirname(args[args.indexOf('--unixsocket')+1]);child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);return child;
 }}),/Redis start timeout/);
 assert.ok(child.exitCode!==null||child.signalCode!==null);await assert.rejects(fs.access(dir),{code:'ENOENT'});
});
test('Redis fixture rejects child exit or spawn failure and removes its directory',async t=>{
 const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path');
 for(const missing of [false,true]){
  let dir;
  await assert.rejects(fixture(t,{spawnImpl:(_command,args,options)=>{
   dir=path.dirname(args[args.indexOf('--unixsocket')+1]);return missing?spawn(path.join(dir,'missing-redis'),[],options):spawn(process.execPath,['-e','process.exit(7)'],options);
  }}),missing?{code:'ENOENT'}:/Redis exited before readiness/);
  await assert.rejects(fs.access(dir),{code:'ENOENT'});
 }
});
async function evidence(input){const c=await compileResearchSQL(input);return{result:researchEvidence(c,[['9007199254740993',null]],[{name:'height',dataTypeID:20},{name:'fees',dataTypeID:1700}],{indexed_through:'2026-10-06T00:00:00Z'},'2026-10-06T00:00:01Z')};}
const wait=async(predicate)=>{const end=Date.now()+5000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture condition timed out');};
test('queue authenticates per job, bounds pending/retained records and never executes rejected SQL',async t=>{
 const redis=await fixture(t);let calls=0;
 const jobs=createResearchJobs(env,{redis,analytics:{execute:async input=>{calls++;return evidence(input);}}});t.after(()=>jobs.stop());
 const tickets=await Promise.all(Array.from({length:12},()=>jobs.submit(query).then(value=>value,()=>null)));
 assert.equal(tickets.filter(Boolean).length,6);assert.equal(calls,0);
 const ticket=tickets.find(Boolean);assert.equal((await jobs.status(ticket)).state,'queued');
 const record=await redis.hGet(PREFIX+ticket.id,'token');assert.notEqual(record,ticket.token);assert.equal(record.length,64);
 for(const operation of ['status','cancel'])await assert.rejects(jobs[operation]({...ticket,token:'0'.repeat(64)}),e=>e.askKind==='job');
 assert.equal((await jobs.status(ticket)).state,'queued');
 for(const sql of ['DELETE FROM blocks','DROP TABLE transactions',"SELECT pg_read_file('/etc/passwd') FROM blocks",'SELECT * FROM pg_subscription','SELECT * INTO copied FROM blocks','SELECT * FROM blocks; SELECT * FROM flows'])await assert.rejects(jobs.submit({...query,sql}));
 assert.equal(calls,0);assert.equal((await jobs.cancel(ticket)).state,'cancelled');
 const next=await jobs.submit(query);await jobs.tick();assert.equal(calls,1);
 const completed=tickets.filter(Boolean).find(x=>x.id!==ticket.id);assert.equal((await jobs.status(completed)).state,'succeeded');
 assert.equal((await jobs.status(completed)).result.rows[0][0],'9007199254740993');
 assert.equal((await jobs.cancel(completed)).state,'succeeded');assert.equal((await jobs.status(next)).state,'queued');
 // Retention is capped; the oldest terminal capability expires under pressure.
 // Finished reads must not consume every future admission slot for an hour.
 await redis.flushDb();
 const retained=[];for(let i=0;i<24;i++){retained.push(await jobs.submit(query));await jobs.tick();}
 const admitted=await jobs.submit(query);assert.equal(await redis.zCard(PREFIX+'index'),24);
 await assert.rejects(jobs.status(retained[0]),e=>e.askKind==='job');
 assert.equal((await jobs.status(retained[1])).state,'succeeded');assert.equal((await jobs.status(admitted)).state,'queued');
 assert.equal((await redis.keys(PREFIX+'*')).length,26,'twenty-four payloads plus index and sequence');
 // A full waiting queue must not retire results for a denied submission.
 for(let i=0;i<5;i++)await jobs.submit(query);
 const before=await redis.zRange(PREFIX+'index',0,-1);
 await assert.rejects(jobs.submit(query),e=>e.askKind==='quota');
 assert.deepEqual(await redis.zRange(PREFIX+'index',0,-1),before);
});
test('only one queue runner starts SQL; cancellation aborts it and preserves terminal state',async t=>{
 const redis=await fixture(t);let calls=0,aborted=0;
 const analytics={execute:async(input,{signal,execution})=>{assert.equal(execution,'background');calls++;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true}));return evidence(input);}};
 const first=createResearchJobs(env,{redis,analytics}),second=createResearchJobs(env,{redis,analytics});t.after(()=>Promise.all([first.stop(),second.stop()]));
 const a=await first.submit(query),b=await second.submit(query);
 const run=first.tick();await wait(async()=>(await first.status(a)).state==='running');
 await second.tick();assert.equal(calls,1);assert.equal((await second.status(b)).state,'queued');
 // Cross-process cancellation is observed by the Redis heartbeat.
 assert.equal((await second.cancel(a)).state,'cancelled');await run;assert.equal(aborted,1);
 assert.equal((await first.status(a)).result,null);assert.equal((await first.status(a)).state,'cancelled');
});
test('worker interruption is explicit, queued work resumes and expired capabilities cannot read results',async t=>{
 const redis=await fixture(t);let calls=0;
 const jobs=createResearchJobs(env,{redis,analytics:{execute:async input=>{calls++;return evidence(input);}}});t.after(()=>jobs.stop());
 const old=await jobs.submit(query),next=await jobs.submit(query);
 await redis.hSet(PREFIX+old.id,{state:'running',startedAt:new Date().toISOString()});
 await jobs.tick();assert.equal(calls,1);assert.equal((await jobs.status(old)).state,'failed');assert.equal((await jobs.status(old)).error,'interrupted');assert.equal((await jobs.status(next)).state,'succeeded');
 await redis.del(PREFIX+next.id);await assert.rejects(jobs.status(next),e=>e.askKind==='job');
 const ticket=await jobs.submit(query);const record=await redis.hGet(PREFIX+ticket.id,'query');assert.doesNotMatch(record,/token|provider|service-key/);
});
test('resource failures are safe; Redis loss cancels running work instead of allowing unfenced SQL',async t=>{
 const redis=await fixture(t);
 const jobs=createResearchJobs(env,{redis,analytics:{execute:async()=>{throw Object.assign(askError('resource'),{message:'postgres://private-secret'});}}});t.after(()=>jobs.stop());
 const ticket=await jobs.submit(query);await jobs.tick();const status=await jobs.status(ticket);assert.equal(status.error,'resource');assert.equal(status.state,'failed');assert.doesNotMatch(JSON.stringify(status),/private-secret|postgres/);
 let aborted=false;const proxied={isReady:true,eval:(...args)=>redis.eval(...args)};
 const running=createResearchJobs(env,{redis:proxied,analytics:{execute:async(input,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}))}});t.after(()=>running.stop());
 const pending=await running.submit(query),run=running.tick();await wait(async()=>await redis.hGet(PREFIX+pending.id,'state')==='running');
 proxied.eval=async()=>{throw Error('Redis offline');};await run;assert.equal(aborted,true);
 // Simulate natural owner-lease expiry after the old execution was aborted.
 await redis.pExpire(PREFIX+'runner',1);await new Promise(r=>setTimeout(r,5));
 await jobs.tick();assert.equal((await jobs.status(pending)).error,'interrupted');
});
test('checkpoint cache has bounded retention, preserves timestamps/exact values and invalidates identity changes',async t=>{
 const redis=await fixture(t),compiled=await compileResearchSQL(query),{result}=await evidence(query);
 const checkpoint={tip_hash:'a'.repeat(64),covered_from:'0',covered_through:'123',verified_at:'2026-10-06T00:00:00Z'};
 const key=cacheKey(compiled,checkpoint);await saveCached(redis,key,result);assert.deepEqual(await readCached(redis,key,compiled),result);
 assert.notEqual(cacheKey(compiled,{...checkpoint,tip_hash:'b'.repeat(64)}),key);
 assert.notEqual(cacheKey(compiled,{...checkpoint,verified_at:'2026-10-06T00:00:01Z'}),key);
 assert.equal(cacheKey(compiled,{}),null);
 assert.equal(cacheKey(await compileResearchSQL({...query,sql:'SELECT CURRENT_TIMESTAMP,height FROM blocks LIMIT 1'}),checkpoint),null);
 assert.equal(await readCached(redis,key,await compileResearchSQL({...query,limit:10})),null);
 for(let i=0;i<30;i++)await saveCached(redis,cacheKey(compiled,{...checkpoint,covered_through:String(i)}),result);
 assert.equal(await redis.zCard(CACHE_PREFIX+'index'),24);assert.equal((await redis.keys(CACHE_PREFIX+'*')).length,25);
 assert.equal(await readCached(redis,key,compiled),null);
});
test('authenticated worker/client validate jobs and cannot grant a browser an execution budget',async t=>{
 const redis=await fixture(t);let calls=0;
 const app=createWorker(env,{redis,analytics:{execute:async input=>{calls++;return evidence(input);}}});t.after(()=>app.locals.jobs.stop());
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}/`,client=createAnalyticsClient({...env,ASK_ANALYTICS_SERVICE_URL:url});
 const send=(path,body,auth=env.ASK_ANALYTICS_SERVICE_KEY)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},body:JSON.stringify(body)});
 assert.equal((await send('jobs/submit',query,'guessed')).status,401);
 assert.equal((await send('jobs/submit',{...query,execution:'background',timeout:999999})).status,400);
 assert.equal((await send('jobs/submit',{...query,sql:'DELETE FROM blocks'})).status,400);assert.equal(calls,0);
 const ticket=await client.submit(query);assert.equal((await client.status(ticket)).state,'queued');await app.locals.jobs.tick();assert.equal((await client.status(ticket)).state,'succeeded');assert.equal(calls,1);
 await assert.rejects(client.status({...ticket,token:'0'.repeat(64)}),e=>e.askKind==='job');
 const broken=createAnalyticsClient({...env,ASK_ANALYTICS_SERVICE_URL:url},async()=>Response.json({...await client.status(ticket),result:{...(await client.status(ticket)).result,fingerprint:'0'.repeat(64)}}));
 await assert.rejects(broken.status(ticket),e=>e.askKind==='source');
});

test('queued natural-language selection validates SQL and returns a capability without blocking on execution',async()=>{
 const {chat}=require('../../v1/lib/ask-chat'),{coreCatalogue}=require('../../v1/lib/ask-core-catalogue');
 let calls=0,submitted=0;
 const ticket={id:'810f1216-4f87-413c-9d1e-97c8d4bf5cac',token:'c'.repeat(64)};
 const analytics={researchEnabled:true,jobsEnabled:true,catalogue:coreCatalogue,submit:async input=>{submitted++;assert.deepEqual(input,(await compileResearchSQL({...query,limit:100})).request);return ticket;},execute:async()=>{throw Error('must queue');}};
 const input={question:'Rank recent blocks by fees',page:'ask',context:null,history:[],locale:'auto',challenge:'secret-challenge'};
 const run=async(body,task)=>{calls++;assert.doesNotMatch(JSON.stringify(body),/secret-challenge/);return task.validator.parse({intent:'research',sql:query.sql,spec:null,blockQuery:null,transactionQuery:null,flowQuery:null,topics:[],locale:'fr'});};
 const reply=await chat(input,run,null,new AbortController().signal,'',{},analytics);
 assert.equal(calls,1);assert.equal(submitted,1);assert.deepEqual(reply.job,ticket);assert.equal(reply.locale,'fr');assert.equal(reply.research,undefined);
 await assert.rejects(chat(input,async(body,task)=>task.validator.parse({intent:'research',sql:'DELETE FROM blocks',spec:null,blockQuery:null,transactionQuery:null,flowQuery:null,topics:[],locale:'en'}),null,new AbortController().signal,'',{},analytics),e=>e.askKind==='answer');assert.equal(submitted,1);
});
test('server-owned background profile changes time only; SQL cannot request a budget or bypass guards',async()=>{
 const {createAnalytics,CORE_GUARD}=require('../../v1/lib/ask-analytics');
 for(const enabled of [false,true])for(const execution of ['interactive','background']){
  const statements=[],releases=[];let records=0;
  const client={release:value=>releases.push(value),query:async statement=>{
   statements.push(statement);
   if(statement===CORE_GUARD)return {rows:[Object.fromEntries(['dedicated','identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers'].map(key=>[key,true]))]};
   if(statement==='SELECT * FROM analytics_public.coverage')return{rows:[{schema_version:1,authority:'logical_public_core',network:'mainnet',ready:true}]};
   if(typeof statement==='string'&&statement.startsWith('SELECT NULL::int'))return{rows:[{indexed_through:'2026-10-06T00:00:00Z'}]};
   if(typeof statement==='object'&&statement.text.startsWith('EXPLAIN'))return{rows:[{'QUERY PLAN':[{Plan:{'Total Cost':10}}]}]};
   if(typeof statement==='object'){records++;return{rows:[['1',null]],fields:[{name:'height',dataTypeID:20},{name:'fees',dataTypeID:1700}]};}
   return{rows:[]};
  }};
  const service=createAnalytics({...env,ASK_RESEARCH_JOBS_ENABLED:String(enabled),ASK_ANALYTICS_DATABASE_URL:'peer-only',ASK_ANALYTICS_SOCKET:'/run/ask-public-db',ASK_ANALYTICS_DAILY_QUERY_LIMIT:'20'},{pool:{on(){},end(){},connect:async()=>client}});
  const redis={isReady:true,eval:async()=>1,zRem:async()=>{}};
  await service.execute(query,{redis,execution});assert.equal(records,1);
  assert.match(statements[1],new RegExp("statement_timeout='"+(enabled&&execution==='background'?'30s':'3s')+"'"));
  assert.match(statements[1],/work_mem='1MB'/);assert.match(statements[0],/READ ONLY/);assert.deepEqual(releases,[undefined]);
  await assert.rejects(service.execute({...query,timeout:3600000},{redis,execution:'background'}));assert.equal(records,1);await service.close();
 }
});

test('public job lifecycle verifies once, rate-limits polling and reserves at most one paid explanation',async t=>{
 const redis=await fixture(t),express=require('express'),{createAskRouter}=require('../../v1/routes/ask'),{RESERVE,ADMIT,ADMIT_WORK}=require('../../v1/lib/ask-budget');
 let executions=0,paid=0,admissions=0,verification=0,modelCalls=0;const work={ai:0,sql:0};
 const privateApp=createWorker(env,{redis,analytics:{execute:async input=>{executions++;return evidence(input);}}});t.after(()=>privateApp.locals.jobs.stop());
 const worker=privateApp.listen(0,'127.0.0.1');await once(worker,'listening');t.after(()=>{worker.closeAllConnections();worker.close();});
 const analytics=createAnalyticsClient({...env,ASK_ANALYTICS_SERVICE_URL:`http://127.0.0.1:${worker.address().port}/`});
 const counted={get isReady(){return redis.isReady;},eval:(script,options)=>{if(script===RESERVE)paid++;else if(script===ADMIT)admissions++;else{assert.equal(script,ADMIT_WORK);const kind=/:work:(ai|sql):/.exec(options.keys[0])?.[1];assert.ok(kind);work[kind]++;}return redis.eval(script,options);},zRem:(...a)=>redis.zRem(...a),get:(...a)=>redis.get(...a),set:(...a)=>redis.set(...a)};
 const settings={...env,ASK_ENABLED:'true',ASK_PROVIDER:'openai',ASK_MODEL:'fixture-model',ASK_API_KEY:'fixture-provider-key',ASK_DAILY_CALL_LIMIT:'20',ASK_DAILY_BUDGET_USD:'1',ASK_MONTHLY_BUDGET_USD:'10',ASK_MAX_INPUT_USD_PER_MILLION:'0.2',ASK_MAX_OUTPUT_USD_PER_MILLION:'0.75',ASK_ABUSE_SECRET:'x'.repeat(32),ASK_TURNSTILE_SECRET:'fixture-secret',ASK_TURNSTILE_HOSTNAME:'example.test',ASK_TURNSTILE_SITE_KEY:'fixture-site'};
 const router=createAskRouter(settings,{redis:counted,analytics,challengeFetch:async()=>{verification++;return Response.json({success:true,action:'ask',hostname:'example.test'});},fetch:async(url,options)=>{
  modelCalls++;const body=JSON.parse(options.body);assert.equal(body.store,false);assert.doesNotMatch(JSON.stringify(body),/fixture-provider-key|fixture-challenge|fixture-private-worker-key/);
  const value=body.response_format.json_schema.name==='contextual_intent'?{intent:'research',sql:query.sql,spec:null,blockQuery:null,transactionQuery:null,flowQuery:null,topics:[],locale:'fr'}:{finding:'The leading returned height is {{row_a_a}}.',interpretation:''};
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
 }});t.after(()=>router.stop());
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.v1={network:'mainnet',requestId:'fixture',abortSignal:new AbortController().signal};next();});app.use('/ask',router);
 const publicServer=app.listen(0,'127.0.0.1');await once(publicServer,'listening');t.after(()=>{publicServer.closeAllConnections();publicServer.close();});const url=`http://127.0.0.1:${publicServer.address().port}/ask`;
 const post=(path,body)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await (await fetch(url)).json()).data.jobsEnabled,true);
 assert.equal((await post('/research/jobs',{...query,execution:'background',challenge:'fixture-challenge'})).status,400);assert.equal(admissions,0);
 const submitted=await post('/research/jobs',{...query,challenge:'fixture-challenge'});assert.equal(submitted.status,200);assert.match(submitted.headers.get('x-robots-tag'),/noindex/);assert.match(submitted.headers.get('cache-control'),/no-store/);
 const ticket=(await submitted.json()).data.job;assert.equal(paid,0);assert.equal(admissions,1);assert.equal(verification,1);assert.deepEqual(work,{ai:0,sql:1});
 for(let i=0;i<12;i++)assert.equal((await post('/research/jobs/status',ticket)).status,200);
 assert.equal(paid,0);assert.equal(admissions,1);assert.deepEqual(work,{ai:0,sql:1});
 const guessed={...ticket,token:'0'.repeat(64)};
 for(const op of ['status','cancel'])assert.equal((await post('/research/jobs/'+op,guessed)).status,404);
 assert.equal((await post('/research/jobs/explain',{...guessed,question:'Explain'})).status,404);assert.equal(modelCalls,0);
 assert.equal((await post('/research/jobs/explain',{...ticket,question:'Explain',result:{rows:[]}})).status,400);
 await privateApp.locals.jobs.tick();assert.equal(executions,1);
 const body={...ticket,question:'Explain the leading recent block',locale:'fr'};
 const replies=await Promise.all(Array.from({length:3},()=>post('/research/jobs/explain',body)));
 assert.equal(replies.filter(r=>r.status===200).length,1);assert.equal(paid,1);assert.equal(modelCalls,1);assert.deepEqual(work,{ai:1,sql:1});
 const success=await replies.find(r=>r.status===200).json();assert.equal(success.data.locale,'fr');assert.equal(success.data.research.rows[0][0],'9007199254740993');assert.match(success.data.answer,/9,007,199,254,740,993/);
 assert.equal((await post('/research/jobs/explain',body)).status,200);assert.equal(modelCalls,1);assert.equal(admissions,1);assert.deepEqual(work,{ai:1,sql:1});
 const response=await post('/chat',{question:'Rank recent blocks by fees',page:'ask',context:null,locale:'auto',history:[],challenge:'fixture-challenge'});assert.equal(response.status,200);
 const draft=(await response.json()).data;assert.ok(draft.job);assert.equal(draft.research,undefined);assert.equal(draft.locale,'fr');assert.equal(executions,1);assert.equal(modelCalls,2);assert.equal(paid,2);assert.equal(admissions,2);assert.deepEqual(work,{ai:2,sql:2});
 assert.equal((await post('/research/jobs/cancel',draft.job)).status,200);await privateApp.locals.jobs.tick();assert.equal(executions,1);
});
test('cached SQL still checks current admission and consumes query allowance; stale authority cannot return cached evidence',async()=>{
 const {createAnalytics,CORE_GUARD}=require('../../v1/lib/ask-analytics');
 let ready=true,rawQueries=0,cacheReads=0,admissions=0;const data=new Map();
 const checkpoint={schema_version:1,authority:'logical_public_core',network:'mainnet',ready:true,tip_hash:'a'.repeat(64),covered_from:'0',covered_through:'123',verified_at:'2026-10-06T00:00:00Z'};
 const client={release(){},query:async statement=>{
  if(statement===CORE_GUARD)return {rows:[Object.fromEntries(['dedicated','identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers'].map(k=>[k,true]))]};
  if(statement==='SELECT * FROM analytics_public.coverage')return{rows:[{...checkpoint,ready}]};
  if(typeof statement==='string'&&statement.startsWith('SELECT NULL::int'))return{rows:[{indexed_through:'2026-10-06T00:00:00Z'}]};
  if(typeof statement==='object'&&statement.text.startsWith('EXPLAIN'))return{rows:[{'QUERY PLAN':[{Plan:{'Total Cost':10}}]}]};
  if(typeof statement==='object'){rawQueries++;return{rows:[['9007199254740993',null]],fields:[{name:'height',dataTypeID:20},{name:'fees',dataTypeID:1700}]};}return{rows:[]};
 }};
 const {ADMIT_QUERY}=require('../../v1/lib/ask-analytics'),{SAVE}=require('../../v1/lib/ask-research-cache');
 const redis={isReady:true,zRem:async()=>{},get:async key=>{cacheReads++;return data.get(key)||null;},eval:async(script,options)=>{if(script===ADMIT_QUERY){admissions++;return 1;}assert.equal(script,SAVE);data.set(options.keys[1],options.arguments[2]);return 1;}};
 const service=createAnalytics({...env,ASK_RESEARCH_CACHE_ENABLED:'true',ASK_ANALYTICS_DATABASE_URL:'peer-only',ASK_ANALYTICS_SOCKET:'/run/ask-public-db',ASK_ANALYTICS_DAILY_QUERY_LIMIT:'20'},{pool:{on(){},end(){},connect:async()=>client}});
 const first=await service.execute(query,{redis});const second=await service.execute(query,{redis});assert.deepEqual(first,second);assert.equal(rawQueries,1);assert.equal(admissions,2);assert.equal(cacheReads,2);
 ready=false;await assert.rejects(service.execute(query,{redis}),e=>e.askKind==='source');assert.equal(rawQueries,1);assert.equal(cacheReads,2);
 ready=true;checkpoint.tip_hash='b'.repeat(64);await service.execute(query,{redis});assert.equal(rawQueries,2);assert.equal(admissions,4);await service.close();
});

test('real Redis work admission enforces explicit minute/day limits without incrementing denied or historical counters',async t=>{
 const redis=await fixture(t),{ADMIT_WORK}=require('../../v1/lib/ask-budget');
 const keys=['ask:{fixture}:work:ai:minute','ask:{fixture}:work:ai:day','ask:{fixture}:legacy:minute','ask:{fixture}:legacy:day'];
 await redis.set(keys[2],'0');await redis.set(keys[3],'0');
 for(let i=0;i<5;i++)assert.equal(Number(await redis.eval(ADMIT_WORK,{keys,arguments:['5','20']})),1);
 assert.equal(Number(await redis.eval(ADMIT_WORK,{keys,arguments:['5','20']})),-1);
 assert.equal(await redis.get(keys[0]),'5');assert.equal(await redis.get(keys[1]),'5');
 await redis.set(keys[1],'20');
 assert.equal(Number(await redis.eval(ADMIT_WORK,{keys,arguments:['5','20']})),-2);
 assert.equal(await redis.get(keys[0]),'5');assert.equal(await redis.get(keys[1]),'20');
 assert.deepEqual(await redis.mGet(keys.slice(2)),['0','0']);
});

test('real worker queue preserves safe SQL quota details through Redis and authenticated job status',async t=>{
 const redis=await fixture(t),{sqlQuotaError}=require('../../v1/lib/ask-sql-quota');let executions=0;
 const privateApp=createWorker(env,{redis,analytics:{execute:async(_input,{execution})=>{assert.equal(execution,'background');executions++;throw sqlQuotaError('ask-sql-global-day',3600);}}});
 t.after(()=>privateApp.locals.jobs.stop());
 const server=privateApp.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const client=createAnalyticsClient({...env,ASK_ANALYTICS_SERVICE_URL:`http://127.0.0.1:${server.address().port}/`});t.after(()=>client.close());
 const ticket=await client.submit(query);assert.equal((await client.status(ticket)).state,'queued');
 await privateApp.locals.jobs.tick();
 const status=await client.status(ticket);
 assert.equal(status.state,'failed');assert.equal(status.error,'quota');assert.equal(status.result,null);assert.equal(executions,1);
 assert.equal(status.quota.code,'ask-sql-global-day');assert.ok(status.quota.retryAfter>0&&status.quota.retryAfter<=3600);
 assert.equal(JSON.parse(await redis.hGet(PREFIX+ticket.id,'quota')).code,'ask-sql-global-day');
 assert.doesNotMatch(JSON.stringify(status),/fixture-private-worker-key|SELECT|Bearer/);
 // A replayed read and cancelling the terminal job retain its failure; no SQL
 // retry or fresh quota charge is created by either lifecycle operation.
 assert.equal((await client.status(ticket)).state,'failed');assert.equal((await client.cancel(ticket)).state,'failed');assert.equal(executions,1);
 for(let i=0;i<6;i++)await client.submit(query);
 await assert.rejects(client.submit(query),error=>error.quota===true&&error.quotaCode==='ask-sql-queue'&&error.retryAfter===5);
 assert.equal(executions,1);
});

test('six-request readiness burst uses the private HTTP queue with retained results bounded',async t=>{
 const redis=await fixture(t),{run}=require('../../scripts/check-ask-research-readiness');
 const settings={...env,ASK_RESEARCH_EXTENDED:'true'};
 const app=createWorker(settings,{redis,analytics:{execute:async input=>{
  const compiled=await compileResearchSQL(input,{extended:true});return {result:researchEvidence(compiled,[['1']],[{name:'value',dataTypeID:20}],{indexed_through:'2026-10-12T00:00:00Z'},'2026-10-12T00:00:01Z')};
 }}});app.locals.jobs.start();t.after(()=>app.locals.jobs.stop());
 const server=app.listen(0,'127.0.0.1');server.maxConnections=8;await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const output=[];const result=await run(['--concurrency=6','--rounds=2','annual_activity','flow_months','address_incidence'],{...settings,ASK_ANALYTICS_URL:`http://127.0.0.1:${server.address().port}/`},{emit:r=>output.push(r)});
 assert.equal(result.failed,0,JSON.stringify(output));assert.equal(result.succeeded,6);
});
test('parallel runner slots run separate jobs at once without interrupting each other',async t=>{
 const redis=await fixture(t);let running=0,peak=0;const release=[];
 const analytics={execute:async input=>{running++;peak=Math.max(peak,running);await new Promise(resolve=>release.push(resolve));running--;return evidence(input);}};
 const jobs=createResearchJobs({...env,ASK_RESEARCH_JOB_RUNNERS:'3'},{redis,analytics});t.after(()=>jobs.stop());
 const tickets=[];for(let i=0;i<4;i++)tickets.push(await jobs.submit(query));
 const run=jobs.tick();await wait(async()=>running===3);
 // A second tick while three slots are busy never fails their running jobs.
 const again=createResearchJobs({...env,ASK_RESEARCH_JOB_RUNNERS:'3'},{redis,analytics});t.after(()=>again.stop());await again.tick();
 assert.deepEqual(await Promise.all(tickets.map(async ticket=>(await jobs.status(ticket)).state)),['running','running','running','queued']);
 release.splice(0).forEach(resolve=>resolve());await run;
 assert.equal(peak,3);assert.deepEqual(await Promise.all(tickets.slice(0,3).map(async ticket=>(await jobs.status(ticket)).state)),['succeeded','succeeded','succeeded']);
});
test('a visitor may hold only a bounded number of queued or running jobs; the queue length is configurable',async t=>{
 const redis=await fixture(t);
 const jobs=createResearchJobs({...env,ASK_RESEARCH_JOBS_PER_VISITOR:'2',ASK_RESEARCH_JOB_QUEUE:'3'},{redis,analytics:{execute:async input=>evidence(input)}});t.after(()=>jobs.stop());
 const a='a'.repeat(64),b='b'.repeat(64);
 await jobs.submit(query,{owner:a});await jobs.submit(query,{owner:a});
 await assert.rejects(jobs.submit(query,{owner:a}),e=>e.quotaCode==='ask-sql-visitor');
 await jobs.submit(query,{owner:b});
 await assert.rejects(jobs.submit(query,{owner:'c'.repeat(64)}),e=>e.quotaCode==='ask-sql-queue','the shared queue still has a cap');
 await jobs.tick();await jobs.submit(query,{owner:a});
});
