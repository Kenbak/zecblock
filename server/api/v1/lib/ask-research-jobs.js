'use strict';
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {compileResearchSQL}=require('./ask-research-sql');
const {researchResultSchema}=require('../../../../lib/ask/research-contract');
const {jobTicketSchema,jobStatusSchema}=require('../../../../lib/ask/research-job-contract');
const {askError}=require('./ask-errors');
const {sqlQuotaError,sqlQuotaDetails}=require('./ask-sql-quota');
const {sqlFeedbackSchema}=require('../../../../lib/ask/sql-feedback');
const PREFIX='ask:{mainnet}:research-jobs:v1:';
const INDEX=PREFIX+'index', LOCK=PREFIX+'runner';
const TTL=3600, LEASE=90000;
const hash=token=>createHash('sha256').update(token).digest('hex');
// All transitions are atomic. A bearer capability authorizes one job only;
// never put it in a URL, log, provider prompt, or stored research document.
// ARGV[8] waiting cap, ARGV[9] retained results, ARGV[10] visitor (or ''),
// ARGV[11] queued+running jobs allowed per visitor. 0: queue full; -1: visitor busy.
const SUBMIT=`
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1])
local retained=tonumber(ARGV[9])
local ids=redis.call('ZRANGE',KEYS[1],0,retained-1)
local waiting=0;local mine=0
for _,id in ipairs(ids) do
 local state=redis.call('HGET',ARGV[6]..id,'state')
 if state=='queued' then waiting=waiting+1 end
 if ARGV[10]~='' and (state=='queued' or state=='running') and redis.call('HGET',ARGV[6]..id,'owner')==ARGV[10] then mine=mine+1 end
end
if ARGV[10]~='' and mine>=tonumber(ARGV[11]) then return -1 end
if waiting>=tonumber(ARGV[8]) then return 0 end
-- Bound retained results without turning 24 completed reads into an hourly
-- outage. Only retire the oldest terminal result; active work is never evicted.
if #ids>=retained then
 for _,id in ipairs(ids) do
  local key=ARGV[6]..id
  local state=redis.call('HGET',key,'state')
  if not state or state=='succeeded' or state=='failed' or state=='cancelled' then
   redis.call('DEL',key);redis.call('ZREM',KEYS[1],id);break
  end
 end
 if redis.call('ZCARD',KEYS[1])>=retained then return 0 end
end
local sequence=redis.call('INCR',KEYS[3]);redis.call('EXPIRE',KEYS[3],3600)
redis.call('HSET',KEYS[2],'order',sequence,'token',ARGV[3],'query',ARGV[4],'state','queued','createdAt',ARGV[5],'startedAt','','finishedAt','','error','','result','','owner',ARGV[10])
redis.call('EXPIRE',KEYS[2],3600)
redis.call('ZADD',KEYS[1],ARGV[2],ARGV[7])
redis.call('EXPIRE',KEYS[1],3600)
return 1`;
const ACCESS=`
if redis.call('HGET',KEYS[1],'token')~=ARGV[1] then return nil end
if ARGV[2]=='cancel' then
 local state=redis.call('HGET',KEYS[1],'state')
    if state=='queued' or state=='running' then redis.call('HSET',KEYS[1],'state','cancelled','finishedAt',ARGV[3],'result','','quota','') end
end
return redis.call('HGETALL',KEYS[1])`;
// KEYS[2] is this runner slot's lock. A running job records its slot and lease;
// it is interrupted only when that lease no longer holds its slot (the owner
// exited or lost Redis), so parallel runners never fail each other's work.
const CLAIM=`
if not redis.call('SET',KEYS[2],ARGV[1],'NX','PX',90000) then return nil end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[2])
local ids=redis.call('ZRANGE',KEYS[1],0,tonumber(ARGV[6])-1)
local selected=nil;local best=nil
for _,id in ipairs(ids) do
 local key=ARGV[4]..id
 local state=redis.call('HGET',key,'state')
 -- The previous owner lost its lease or exited. Never repeat an expensive read.
 if state=='running' then
  local slot=redis.call('HGET',key,'runner');if not slot or slot=='' then slot=ARGV[5] end
  if redis.call('GET',slot)~=(redis.call('HGET',key,'lease') or '') then redis.call('HSET',key,'state','failed','error','interrupted','finishedAt',ARGV[3],'result','','quota','') end
 end
 local order=tonumber(redis.call('HGET',key,'order'))
 if state=='queued' and order and (not best or order<best) then selected=id;best=order end
end
if not selected then redis.call('DEL',KEYS[2]); return nil end
local key=ARGV[4]..selected
redis.call('HSET',key,'state','running','startedAt',ARGV[3],'runner',KEYS[2],'lease',ARGV[1])
return {selected,redis.call('HGET',key,'query')}`;
const HEARTBEAT=`
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('PEXPIRE',KEYS[1],90000)
return redis.call('HGET',KEYS[2],'state')=='running' and 1 or 0`;
const FINISH=`
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
if redis.call('HGET',KEYS[2],'state')=='running' then redis.call('HSET',KEYS[2],'state',ARGV[2],'finishedAt',ARGV[3],'error',ARGV[4],'result',ARGV[5],'quota',ARGV[6],'sql',ARGV[7] or '') end
redis.call('DEL',KEYS[1]); return 1`;
const bounded=operation=>Promise.race([operation,new Promise((_,reject)=>{const t=setTimeout(()=>reject(askError('unavailable')),1500);t.unref();operation.finally(()=>clearTimeout(t)).catch(()=>{});})]);
function createResearchJobs(env,{analytics,redis}){
 if(env.ASK_RESEARCH_JOBS_ENABLED!=='true'||env.ASK_RESEARCH_ENABLED!=='true'||env.ASK_ANALYTICS_STORE!=='logical_public_core')return null;
 // Parallel runner slots share the worker's database admission (ASK_ANALYTICS_CONCURRENCY).
 const setting=(name,fallback,min,max)=>{const value=Number(env[name]);return Number.isInteger(value)&&value>=min&&value<=max?value:fallback;};
 const runners=setting('ASK_RESEARCH_JOB_RUNNERS',1,1,8),maxWaiting=setting('ASK_RESEARCH_JOB_QUEUE',6,1,64),retained=setting('ASK_RESEARCH_JOB_RETAINED',24,8,200),perVisitor=setting('ASK_RESEARCH_JOBS_PER_VISITOR',2,1,16);
 const slots=Array.from({length:runners},(_,i)=>({lock:i===0?LOCK:LOCK+':'+i,current:null,ticking:false}));
 let stopped=false,timer=null;
 const evaluate=(script,keys,args)=>bounded(redis.eval(script,{keys,arguments:args.map(String)}));
 const status=async(ticket,cancel=false)=>{
  ticket=jobTicketSchema.parse(ticket);
  const data=await evaluate(ACCESS,[PREFIX+ticket.id],[hash(ticket.token),cancel?'cancel':'read',new Date().toISOString()]);
  if(!data)throw askError('job');
  const record=Object.fromEntries(Array.from({length:data.length/2},(_,i)=>[data[i*2],data[i*2+1]]));
  let position=0;
  if(record.state==='queued'){
   const ids=await bounded(redis.zRange(INDEX,0,retained-1));
   for(const id of ids){const [state,order]=await bounded(redis.hmGet(PREFIX+id,['state','order']));if(state==='queued'&&Number(order)<=Number(record.order))position++;}
  }
  if(cancel)for(const slot of slots)if(slot.current?.id===ticket.id)slot.current.controller.abort();
  let quota;
  if(record.quota){quota=JSON.parse(record.quota);quota.retryAfter=Math.max(1,Math.ceil((Date.parse(record.finishedAt)+quota.retryAfter*1000-Date.now())/1000));}
  const sql=record.sql&&record.state==='failed'?sqlFeedbackSchema.safeParse(JSON.parse(record.sql)):null;
  return jobStatusSchema.parse({id:ticket.id,state:record.state,createdAt:record.createdAt,startedAt:record.startedAt||null,finishedAt:record.finishedAt||null,queuePosition:Math.min(position,6),maxRunSeconds:30,error:record.error||null,...(quota?{quota}:{}),...(sql?.success?{sql:sql.data}:{}),result:record.result?JSON.parse(record.result):null});
 };
 async function tick(){await Promise.all(slots.map(runSlot));}
 async function runSlot(slot){
  if(stopped||slot.ticking||!redis.isReady)return;
  slot.ticking=true;
  let claimed,owner,monitor;
  try{
   owner=randomUUID();
   claimed=await evaluate(CLAIM,[INDEX,slot.lock],[owner,Date.now(),new Date().toISOString(),PREFIX,LOCK,retained]);
   if(!claimed)return;
   const [id,raw]=claimed,controller=new AbortController();
   slot.current={id,controller};
   // Losing Redis or ownership cancels PostgreSQL; it cannot continue unfenced.
   let checking=false;
   monitor=setInterval(async()=>{if(checking)return;checking=true;try{if(!Number(await evaluate(HEARTBEAT,[slot.lock,PREFIX+id],[owner])))controller.abort();}catch{controller.abort();}finally{checking=false;}},500);monitor.unref();
   let state='succeeded',error='',result='',quota='',sql='',datasets=[],shape=null;const executionStarted=Date.now();
   try{
    const compiled=await compileResearchSQL(JSON.parse(raw),{extended:env.ASK_RESEARCH_EXTENDED==='true'});const query=compiled.request;datasets=compiled.datasets;shape=compiled.shape;
    const evidence=await analytics.execute(query,{redis,signal:controller.signal,execution:'background'});
    result=JSON.stringify(researchResultSchema.parse(evidence.result));
    if(Buffer.byteLength(result)>262144)throw askError('resource');
    controller.signal.throwIfAborted();
   }catch(cause){state='failed';result='';error=stopped?'interrupted':cause?.askKind&&['timeout','resource','query','source','dataset','quota','unavailable'].includes(cause.askKind)?cause.askKind:['AbortError','TimeoutError'].includes(cause?.name)?'timeout':'source';if(error==='quota'){const details=sqlQuotaDetails(cause);if(details)quota=JSON.stringify(details);}
    const feedback=['query','resource'].includes(error)?sqlFeedbackSchema.safeParse(cause?.sqlFeedback):null;if(feedback?.success)sql=JSON.stringify(feedback.data);}
   clearInterval(monitor);monitor=null;
   if(env.ASK_RESEARCH_METRICS_ENABLED==='true')await require('./ask-research-metrics').recordMetrics(redis,{outcome:controller.signal.aborted&&!stopped?'cancelled':state==='succeeded'?'success':error==='interrupted'?'unavailable':error,datasets,...(shape?{features:shape.features,span:shape.span}:{}),mode:'queued',elapsedMs:Date.now()-executionStarted});
   await evaluate(FINISH,[slot.lock,PREFIX+id],[owner,state,new Date().toISOString(),error,result,quota,sql]);
  }catch{/* No raw exceptions or SQL in logs. Lease expiry makes recovery safe. */}
  finally{clearInterval(monitor);slot.current=null;slot.ticking=false;}
 }
 return {
  async submit(input,{owner}={}){
   if(stopped||!redis.isReady)throw askError('unavailable');
   const query=(await compileResearchSQL(input,{extended:env.ASK_RESEARCH_EXTENDED==='true'})).request;
   const ticket={id:randomUUID(),token:randomBytes(32).toString('hex')},now=Date.now();
   const visitor=typeof owner==='string'&&/^[0-9a-f]{64}$/.test(owner)?owner:'';
   const admitted=Number(await evaluate(SUBMIT,[INDEX,PREFIX+ticket.id,PREFIX+'sequence'],[now,now+TTL*1000,hash(ticket.token),JSON.stringify(query),new Date(now).toISOString(),PREFIX,ticket.id,maxWaiting,retained,visitor,perVisitor]));
   if(admitted===-1)throw sqlQuotaError('ask-sql-visitor',5);
   if(admitted!==1)throw sqlQuotaError('ask-sql-queue',5);
   return ticket;
  },status,cancel:ticket=>status(ticket,true),
  start(){if(!timer&&!stopped){timer=setInterval(()=>void tick(),250);timer.unref();void tick();}},
  async stop(){stopped=true;clearInterval(timer);for(const slot of slots)slot.current?.controller.abort();while(slots.some(slot=>slot.ticking))await new Promise(resolve=>setTimeout(resolve,20));},
  tick,
 };
}
module.exports={createResearchJobs,PREFIX,SUBMIT,CLAIM,ACCESS,HEARTBEAT,FINISH,LEASE};
