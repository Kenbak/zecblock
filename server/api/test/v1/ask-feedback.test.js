'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {once}=require('node:events');
const {randomUUID}=require('node:crypto');
const {createAskRouter}=require('../../v1/routes/ask');
const {readFeedback,COUNT_KEY,SHARED_KEY,TTL,SHARED_PER_DAY}=require('../../v1/lib/ask-feedback');
const {readMetrics}=require('../../v1/lib/ask-research-metrics');
const env={ASK_ENABLED:'true',ASK_PROVIDER:'openai',ASK_MODEL:'fixture',ASK_API_KEY:'fixture',ASK_DAILY_CALL_LIMIT:'200',ASK_DAILY_BUDGET_USD:'1',ASK_MONTHLY_BUDGET_USD:'5',ASK_MAX_INPUT_USD_PER_MILLION:'0.25',ASK_MAX_OUTPUT_USD_PER_MILLION:'0.75',ASK_ABUSE_SECRET:'a'.repeat(32),ASK_TURNSTILE_SECRET:'fixture',ASK_TURNSTILE_HOSTNAME:'example.test',ASK_TURNSTILE_SITE_KEY:'fixture'};
// Executes the two feedback scripts with Redis semantics; anything else fails the test.
function fakeRedis(){
 const hashes=new Map(),expiry=new Map(),calls=[];
 const hash=key=>{if(!hashes.has(key))hashes.set(key,new Map());return hashes.get(key);};
 return {isReady:true,hashes,expiry,calls,
  async eval(script,{keys,arguments:args}){
   calls.push({script,keys,args});const [key]=keys,h=hash(key);
   if(script.startsWith('local n=tonumber(ARGV[1])')){
    const n=Number(args[0]);for(const f of args.slice(1,n+1))h.set(f,String(Number(h.get(f)||0)+1));
    for(const f of args.slice(n+1)){const v=Number(h.get(f)||0)-1;if(v<=0)h.delete(f);else h.set(f,String(v));}
    expiry.set(key,Number(/EXPIRE',KEYS\[1\],(\d+)/.exec(script)[1]));return 1;
   }
   if(script.startsWith("if ARGV[2]==''")){
    const [id,json,cap]=args;if(json==='')return h.delete(id)?1:0;
    if(!h.has(id)&&h.size>=Number(cap))return 0;h.set(id,json);expiry.set(key,Number(/EXPIRE',KEYS\[1\],(\d+)/.exec(script)[1]));return 1;
   }
   assert.fail('Unexpected Redis script');
  },
  async hGetAll(key){return Object.fromEntries(hash(key));},
 };
}
async function serve(t,redis=fakeRedis()){
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{req.v1={network:'mainnet',requestId:'fixture',abortSignal:new AbortController().signal};next();});
 const router=createAskRouter(env,{redis,fetch:()=>assert.fail('No provider call'),challengeFetch:()=>assert.fail('No verification')});
 app.use('/ask',router);const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{router.stop();server.closeAllConnections();server.close();});
 return {redis,post:(body,path='/feedback')=>fetch(`http://127.0.0.1:${server.address().port}/ask${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};
}
const today=()=>new Date().toISOString().slice(0,10);
const base={vote:'down',reason:'wrong_number',route:'run_sql',template:true,locale:'en',page:'ask'};

test('a vote increments only enum counters that expire after 30 days and stores no text',async t=>{
 const api=await serve(t),response=await api.post(base);
 assert.equal(response.status,200);assert.deepEqual((await response.json()).data,{recorded:true,shared:false});
 const key=COUNT_KEY+today();
 assert.deepEqual(Object.fromEntries(api.redis.hashes.get(key)),{'vote:down':'1','route:run_sql:down':'1','locale:en:down':'1','page:ask:down':'1','template:down':'1','reason:wrong_number':'1','route:run_sql:reason:wrong_number':'1'});
 assert.equal(api.redis.expiry.get(key),TTL);assert.equal(TTL,30*86400);
 assert.equal(api.redis.hashes.has(SHARED_KEY+today()),false);
 // Only fixed field names reach Redis: no IP, user agent or free text.
 assert.doesNotMatch(JSON.stringify(api.redis.calls),/127\.0\.0\.1|node|fetch/i);
});

test('validation rejects free text, unknown enums, extra fields and reasons on thumbs up',async t=>{
 const api=await serve(t);
 for(const body of [{...base,question:'How much ZEC moved?'},{...base,reason:'something else'},{...base,route:'free text'},{...base,locale:'xx'},{...base,page:'nowhere'},{...base,vote:'up'},{...base,template:'yes'},{...base,ip:'1.2.3.4'},{...base,shared:{question:'q',answer:'a'}},{...base,shareId:'not-a-uuid'},{...base,shareId:randomUUID(),shared:{question:'q',answer:'a',rows:[]}},{vote:'down'},null]){
  const response=await api.post(body);assert.equal(response.status,400,JSON.stringify(body));
 }
 assert.equal(api.redis.calls.length,0);
});

test('changing a vote moves the count instead of adding one',async t=>{
 const api=await serve(t);
 await api.post({...base,reason:undefined,vote:'up'});
 await api.post({...base,replaces:{vote:'up'}});
 await api.post({...base,reason:'misunderstood',replaces:{vote:'down',reason:'wrong_number'}});
 const summary=await readFeedback(api.redis,today());
 assert.deepEqual(summary.votes,{up:0,down:1});
 assert.deepEqual(summary.reasons,{misunderstood:1});
 assert.deepEqual(summary.routes,{run_sql:{up:0,down:1,reasons:{misunderstood:1}}});
 assert.deepEqual(summary.templateFallback,{up:0,down:1});
 assert.equal('shared' in summary,false);
});

test('question and answer are kept only when shared, can be withdrawn and are capped per day',async t=>{
 const api=await serve(t),shareId=randomUUID(),shared={question:'How much ZEC was shielded last week?',answer:'About 1,200 ZEC.',sql:'SELECT 1'};
 assert.deepEqual((await (await api.post({...base,shareId,shared})).json()).data,{recorded:true,shared:true});
 const key=SHARED_KEY+today();assert.equal(api.redis.expiry.get(key),TTL);
 const {shared:samples}=await readFeedback(api.redis,today(),{shared:true});
 assert.deepEqual(samples,[{day:today(),vote:'down',reason:'wrong_number',route:'run_sql',template:true,locale:'en',page:'ask',...shared}]);
 // Unticking withdraws the copy; the vote is unchanged.
 await api.post({...base,shareId,replaces:{vote:'down',reason:'wrong_number'}});
 assert.equal(api.redis.hashes.get(key).size,0);
 assert.deepEqual((await readFeedback(api.redis,today())).votes,{up:0,down:1});
 for(let i=0;i<SHARED_PER_DAY;i++)api.redis.hashes.get(key).set(randomUUID(),'{}');
 assert.deepEqual((await (await api.post({...base,shareId:randomUUID(),shared})).json()).data,{recorded:true,shared:false});
 assert.equal(api.redis.hashes.get(key).size,SHARED_PER_DAY);
});

test('feedback is rate-limited per IP without AI, SQL or verification',async t=>{
 const api=await serve(t);
 for(let i=0;i<30;i++)assert.equal((await api.post(base)).status,200);
 const response=await api.post(base);assert.equal(response.status,429);
 assert.equal((await response.json()).code,'ask-feedback-minute');assert.ok(Number(response.headers.get('retry-after'))<=60);
});

test('feedback is unavailable without Redis and the reader rejects unexpected fields',async t=>{
 const api=await serve(t,{isReady:false});assert.equal((await api.post(base)).status,503);
 await assert.rejects(readFeedback({hGetAll:async()=>({'question:hello':'1'})},'2026-10-30'),/Invalid anonymous counts/);
 await assert.rejects(readFeedback({hGetAll:async()=>({})},'2026-02-30'),/Invalid UTC day/);
 // Research counters keep their own key and allow-list.
 assert.notEqual(COUNT_KEY,require('../../v1/lib/ask-research-metrics').KEY);assert.equal(typeof readMetrics,'function');
});
