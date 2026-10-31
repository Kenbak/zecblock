'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {createMemoryPressure,CGROUP,TTL_MS,EVENT_HOLD_MS,CACHE_FLOOR}=require('../../v1/lib/ask-memory-pressure');
const {askError}=require('../../v1/lib/ask-errors');
function fixture(overrides={}){
 const values={'memory.current':'100','memory.high':'1000','memory.max':'2000','memory.events':'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n','memory.pressure':'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n','memory.stat':'anon 50\nfile 50\ninactive_file 0\nactive_file 50\n',...overrides};
 let time=0,reads=0;
 const guard=createMemoryPressure({ASK_POSTGRES_CGROUP_PATH:CGROUP},{read:async path=>{reads++;assert.ok(path.startsWith(CGROUP+'/'));return values[path.slice(CGROUP.length+1)];},now:()=>time});
 return {guard,values,advance:ms=>{time+=ms;},reads:()=>reads};
}
test('unset legacy guard performs no filesystem work; configured invalid paths/thresholds fail resource closed',async()=>{
 await createMemoryPressure({},{read:()=>{throw Error('must not read');}}).assertAvailable();
 for(const env of [{ASK_POSTGRES_CGROUP_PATH:'/etc/private'},{ASK_POSTGRES_CGROUP_PATH:CGROUP+'/../other'},{ASK_POSTGRES_PRESSURE_PERCENT:'85'},{ASK_POSTGRES_CGROUP_PATH:CGROUP,ASK_POSTGRES_PRESSURE_PERCENT:'100'},{ASK_POSTGRES_CGROUP_PATH:CGROUP,ASK_POSTGRES_PSI_AVG10_PERCENT:'NaN'}])await assert.rejects(createMemoryPressure(env,{read:()=>{throw Error('private-fixture-secret');}}).assertAvailable(),e=>e.askKind==='resource'&&!e.message.includes('private'));
 await assert.rejects(createMemoryPressure({ASK_POSTGRES_CGROUP_PATH:CGROUP},{read:async()=>{throw Error('unreadable');}}).assertAvailable(),e=>e.askKind==='resource');
});
test('cgroup reads are shared, cached briefly and deny pressure before high/max; no reset or kill operations',async()=>{
 const f=fixture();await Promise.all(Array.from({length:20},()=>f.guard.assertAvailable()));assert.equal(f.reads(),6);
 f.values['memory.current']='850';await f.guard.assertAvailable();assert.equal(f.reads(),6);f.advance(TTL_MS);
 await assert.rejects(f.guard.assertAvailable(),e=>e.askKind==='resource');
 f.values['memory.current']='100';f.values['memory.pressure']=f.values['memory.pressure'].replace('some avg10=0.00','some avg10=5.00');f.advance(TTL_MS);await assert.rejects(f.guard.assertAvailable(),e=>e.askKind==='resource');
 for(const [file,value] of [['memory.stat','anon 1'],['memory.high','max'],['memory.max','1000'],['memory.current','-1'],['memory.events','high 0'],['memory.pressure','some avg10=NaN']]){
  const bad=fixture({[file]:value});await assert.rejects(bad.guard.assertAvailable(),e=>e.askKind==='resource');
 }
});
test('reclaimable inactive file cache does not count toward the admission threshold',async()=>{
 // Warm table cache keeps memory.current near memory.high; only the working set counts.
 const f=fixture({'memory.current':'990','memory.stat':'anon 40\nfile 950\ninactive_file 700\nactive_file 250\n'});
 await f.guard.assertAvailable();
 f.values['memory.stat']='anon 40\nfile 950\ninactive_file 100\nactive_file 850\n';f.advance(TTL_MS);
 await assert.rejects(f.guard.assertAvailable(),e=>e.askKind==='resource','active memory near memory.high still refuses');
});
test('new pressure events and counter rewind hold admission closed before later healthy sampling',async()=>{
 for(const counter of ['high','max','oom','oom_kill']){
  const f=fixture();await f.guard.assertAvailable();f.values['memory.events']=f.values['memory.events'].replace(counter+' 0',counter+' 1');f.advance(TTL_MS);
  await assert.rejects(f.guard.assertAvailable(),e=>e.askKind==='resource');f.advance(EVENT_HOLD_MS);await f.guard.assertAvailable();
  f.values['memory.events']=f.values['memory.events'].replace(counter+' 1',counter+' 0');f.advance(TTL_MS);await assert.rejects(f.guard.assertAvailable(),e=>e.askKind==='resource');
 }
});
test('high events from routine cache reclaim do not hold admission; scarce cache still does',async()=>{
 // Production 2026-10-31: current 25.76 GB of high 25.77 GB, 13.3 GB inactive
 // file cache, PSI 0. Each small query's reads raised memory.events high and
 // held every research query for 30 s.
 const warm='anon 40\nfile 950\ninactive_file 500\nactive_file 450\n';
 const f=fixture({'memory.current':'990','memory.stat':warm});await f.guard.assertAvailable();
 for(let n=1;n<=5;n++){f.values['memory.events']=f.values['memory.events'].replace(/high \d+/,'high '+n);f.advance(TTL_MS);await f.guard.assertAvailable();}
 // Cache below the floor: the kernel is reclaiming beyond spare cache, so hold.
 f.values['memory.stat']=`anon 40\nfile 950\ninactive_file ${1000*CACHE_FLOOR-1}\nactive_file 700\n`;f.values['memory.current']='300';
 f.values['memory.events']=f.values['memory.events'].replace(/high \d+/,'high 6');f.advance(TTL_MS);
 await assert.rejects(f.guard.assertAvailable(),e=>e.askKind==='resource');f.advance(EVENT_HOLD_MS);await f.guard.assertAvailable();
 // max/oom/oom_kill increments and any counter rewind still hold regardless of cache.
 for(const counter of ['max','oom','oom_kill']){
  const g=fixture({'memory.current':'990','memory.stat':warm});await g.guard.assertAvailable();
  g.values['memory.events']=g.values['memory.events'].replace(counter+' 0',counter+' 1');g.advance(TTL_MS);
  await assert.rejects(g.guard.assertAvailable(),e=>e.askKind==='resource',counter);
 }
 const r=fixture({'memory.current':'990','memory.stat':warm,'memory.events':'low 0\nhigh 9\nmax 0\noom 0\noom_kill 0\n'});await r.guard.assertAvailable();
 r.values['memory.events']=r.values['memory.events'].replace('high 9','high 8');r.advance(TTL_MS);await assert.rejects(r.guard.assertAvailable(),e=>e.askKind==='resource');
});
test('pressure refuses new quick/queued execution, keeps status/cancel and leaves active execution alone',async t=>{
 const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createClient}=require('redis');
 const {createWorker}=require('../../ask-analytics-worker'),{createAnalyticsClient}=require('../../v1/lib/ask-analytics-client');
 const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ask-pressure-')),socket=path.join(root,'redis.sock');
 const child=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Redis startup')),5000);child.once('error',reject);child.stdout.on('data',chunk=>{if(/ready to accept connections/i.test(String(chunk))){clearTimeout(timeout);resolve();}});});
 const redis=createClient({socket:{path:socket}});redis.on('error',()=>{});await redis.connect();
 t.after(async()=>{await redis.quit();child.kill();await once(child,'exit');await fs.rm(root,{force:true,recursive:true});});
 const env={ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:'private-fixture-service-key-of-at-least-thirty-two-characters',ASK_RESEARCH_ENABLED:'true',ASK_RESEARCH_EXTENDED:'true',ASK_RESEARCH_JOBS_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core'};
 const query={version:3,sql:'SELECT height FROM blocks ORDER BY height DESC LIMIT 1',limit:1};
 let pressure=false,calls=0,activeAborted=false,release;const blocked=new Promise(resolve=>{release=resolve;});
 const analytics={execute:async(input,{signal})=>{calls++;signal.addEventListener('abort',()=>{activeAborted=true;});await blocked;return {result:researchEvidence(await compileResearchSQL(input,{extended:true}),[['1']],[{name:'height',dataTypeID:20}],{indexed_through:'2026-10-16T00:00:00Z'},'2026-10-16T00:00:01Z')};}};
 const app=createWorker(env,{redis,analytics,memoryPressure:{assertAvailable:async()=>{if(pressure)throw askError('resource');}}});
 t.after(()=>app.locals.jobs.stop());const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const client=createAnalyticsClient({...env,ASK_ANALYTICS_SERVICE_URL:`http://127.0.0.1:${server.address().port}/`});
 const queued=await client.submit(query),cancel=await client.submit(query);const active=client.execute(query);
 const until=Date.now()+3000;while(calls===0){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,5));}
 pressure=true;await assert.rejects(client.submit(query),e=>e.askKind==='resource');await assert.rejects(client.execute(query),e=>e.askKind==='resource');
 assert.equal((await client.status(queued)).state,'queued');assert.equal((await client.cancel(cancel)).state,'cancelled');
 await app.locals.jobs.tick();assert.equal((await client.status(queued)).error,'resource');assert.equal(calls,1);assert.equal(activeAborted,false);
 release();await active;assert.equal(activeAborted,false);assert.equal(calls,1);
 // Exercise the new fixed operator wrapper through the real HTTP/Redis queue.
 pressure=false;app.locals.jobs.start();const output=[];
 const {runLoad}=require('../../../deploy/ask-analytics/query-load-worker.cjs');
 const result=await runLoad(['overlap'],{...env,ASK_ANALYTICS_URL:`http://127.0.0.1:${server.address().port}/`},{emit:record=>output.push(record)});
 assert.equal(result.queuedSamples,11);assert.equal(result.queuedFailed,0);assert.equal(result.quickFailed,0);assert.ok(result.quickSamples>0&&result.quickSamples<=4);
 assert.doesNotMatch(JSON.stringify(output),/SELECT|private-fixture|token|Authorization/);
});
test('operator wrapper accepts only fixed profiles and pre-abort submits no SQL or tickets',async()=>{
 const {profile,runLoad}=require('../../../deploy/ask-analytics/query-load-worker.cjs');
 for(const input of [[],['--sql=SELECT'],['overlap','extra'],['stress']])assert.throws(()=>profile(input));
 const controller=new AbortController();controller.abort();let accepted=0,closed=false;
 const result=await runLoad(['serial'],{ASK_ANALYTICS_SERVICE_KEY:'fixture-key-at-least-thirty-two-characters'},{signal:controller.signal,emit:()=>{},transport:{fetch:async(url,options)=>{options.signal.throwIfAborted();accepted++;throw Error('unexpected request');},close:()=>{closed=true;}}});
 assert.equal(accepted,0);assert.equal(closed,true);assert.equal(result.aborted,true);assert.equal(result.queuedFailed,11);
});
