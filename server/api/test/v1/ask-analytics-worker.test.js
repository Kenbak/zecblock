'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createWorker } = require('../../ask-analytics-worker');
const { createAnalyticsClient } = require('../../v1/lib/ask-analytics-client');
const { compilePlan } = require('../../v1/lib/ask-analytics-plan');
const { evidenceFor, ADMIT_QUERY } = require('../../v1/lib/ask-analytics');
const plan = {version:1,metric:'transactions',start:'2026-09-01',end:'2026-09-30',bucket:'week',order:'highest',limit:5};
const key = 'fixture-analytics-token-with-at-least-thirty-two-characters';
test('private worker authenticates before parsing, accepts only plans and exposes only public facts', async t => {
  let queries = 0; let fail = false;
  const analytics = {execute:async input => {queries++; if(fail) throw new Error('postgres://private-password'); return evidenceFor(compilePlan(input),[{bucket:'2026-09-07',value:'6000',observed_days:7,observed_through:'2026-09-13'}],{observed_days:30},new Date().toISOString());}};
  const app = createWorker({ASK_ANALYTICS_SERVICE_KEY:key},{analytics,redis:{isReady:true}});
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=> {server.closeAllConnections(); server.close();});
  const url = `http://127.0.0.1:${server.address().port}/`;
  const client = createAnalyticsClient({ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:key,ASK_ANALYTICS_SERVICE_URL:url});
  for (const auth of ['', 'Bearer guessed-token']) {
    const denied = await fetch(new URL('query',url),{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:'x'.repeat(5000)});
    assert.equal(denied.status,401); assert.doesNotMatch(await denied.text(),/password|stack/);
  }
  assert.equal(queries,0);
  for(const payload of [{...plan,sql:'DELETE FROM blocks'},{...plan,metric:'private_fixture'},{...plan,url:'http://internal/rpc'}]) {
    const denied = await fetch(new URL('query',url),{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    assert.equal(denied.status,400);
  }
  assert.equal(queries,0);
  const evidence = await client.execute(plan);
  assert.equal(evidence.facts.row_a_value,'6,000 transactions'); assert.equal(queries,1);
  fail=true;
  await assert.rejects(client.execute(plan),error=>error.askKind==='source' && !error.message.includes('password'));
  for(const address of ['https://public.example/','http://127.0.0.1:123/?override=1','http://localhost:123/','http://127.0.0.1:123/private','http://user:pass@127.0.0.1:123/']) assert.equal(createAnalyticsClient({ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:key,ASK_ANALYTICS_SERVICE_URL:address}),null);
});
test('actual Redis enforces shared query leases and daily limits atomically', async t => {
  const {spawn} = require('node:child_process'); const {mkdtemp,rm} = require('node:fs/promises'); const {tmpdir} = require('node:os'); const {join} = require('node:path'); const {createClient} = require('redis');
  const dir = await mkdtemp(join(tmpdir(),'ask-analytics-redis-')); const socket=join(dir,'redis.sock');
  const child=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=> {const timer=setTimeout(()=>reject(new Error('Redis start timeout')),5000);child.once('error',reject);child.stdout.on('data',chunk=>{if(chunk.toString().toLowerCase().includes('ready to accept connections')){clearTimeout(timer);resolve();}});});
  const redis=createClient({socket:{path:socket}});redis.on('error',()=>{});await redis.connect();
  t.after(async()=>{await redis.quit();child.kill();await once(child,'exit');await rm(dir,{recursive:true,force:true});});
  const keys=['ask:{mainnet}:analytics:active','ask:{mainnet}:analytics:queries:fixture'];
  const reserve=async(id,now=1000)=>redis.eval(ADMIT_QUERY,{keys,arguments:[String(now),String(now+30000),id,'3']});
  const results=await Promise.all(Array.from({length:15},(_,i)=>reserve(String(i))));assert.equal(results.filter(value=>value===1).length,2);
  for(const denied of results.filter(value=>value!==1))assert.deepEqual(denied,[-1,30]);
  assert.equal(await redis.get(keys[1]),'2');
  await redis.zRem(keys[0],results.findIndex(value=>value===1).toString());assert.equal(await reserve('next'),1);assert.equal(await reserve('daily-denied',40000),-2);
  assert.equal(await redis.get(keys[1]),'3');
  assert.equal(await redis.zCard(keys[0]),0);
});

test('relational worker/client preserve exact raw cells and missing-value evidence across the authenticated boundary',async t=>{
  const query={version:2,dataset:'flows',start:'2026-09-01',end:'2026-09-30',bucket:'week',dimensions:[],filters:[],measures:[{field:'amount',operation:'sum',filters:[]}],calculations:[],order:{column:1,direction:'desc'},limit:5};
  const analytics={execute:async input=>evidenceFor(compilePlan(input),[{d0:'2026-09-14',m0:'9007199254740993.000000',u0:'2'}],{observed_days:null,indexed_through:'2026-10-02T00:00:00Z'},new Date().toISOString())};
  const server=createWorker({ASK_ANALYTICS_SERVICE_KEY:key},{analytics,redis:{isReady:true}}).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const client=createAnalyticsClient({ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:key,ASK_ANALYTICS_SERVICE_URL:`http://127.0.0.1:${server.address().port}/`});
  const evidence=await client.execute(query);assert.equal(evidence.result.rows[0].m0.value,'9007199254740993.000000');assert.equal(evidence.result.rows[0].m0.missing,2);assert.equal(evidence.result.coverage.missingDays,null);assert.equal(evidence.facts.row_a_ma_missing,'2');
});
