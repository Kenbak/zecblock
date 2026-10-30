'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const {queryShape}=require('../../v1/lib/ask-research-shape');
const metrics=require('../../v1/lib/ask-research-metrics');
const {daysFor,report}=require('../../scripts/read-ask-research-metrics');
const {parse}=require('pgsql-parser');
const now=Date.UTC(2026,9,30)/1000;
const shapeOf=async sql=>queryShape(await parse(sql),now);
const secretSQL="SELECT count(DISTINCT a.address) FROM address_activity a JOIN labels l ON l.address=a.address WHERE a.address='t1SecretAddressValue' AND a.timestamp>=extract(epoch FROM DATE '2026-09-01')::bigint AND a.timestamp<extract(epoch FROM DATE '2026-10-01')::bigint";

test('query shape keeps only fixed features and a coarse span bucket',async()=>{
 assert.deepEqual(await shapeOf("SELECT * FROM blocks ORDER BY height DESC LIMIT 5"),{features:[],span:'unbounded'});
 assert.deepEqual(await shapeOf("SELECT * FROM transactions WHERE height>=3500000 AND height<3500100"),{features:[],span:'height'});
 assert.deepEqual(await shapeOf("SELECT date FROM activity_daily WHERE date='2026-09-01'"),{features:[],span:'day'});
 assert.deepEqual(await shapeOf("SELECT * FROM swaps WHERE timestamp>=TIMESTAMPTZ '2026-09-01 00:00:00+00' AND timestamp<TIMESTAMPTZ '2026-09-08 00:00:00+00'"),{features:[],span:'week'});
 assert.deepEqual(await shapeOf(secretSQL),{features:['distinct','join'],span:'month'});
 assert.deepEqual(await shapeOf("SELECT * FROM blocks WHERE timestamp>=extract(epoch FROM current_date - interval '90 days')::bigint"),{features:[],span:'quarter'});
 assert.deepEqual(await shapeOf("SELECT date FROM activity_daily WHERE date BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'"),{features:[],span:'year'});
 assert.deepEqual(await shapeOf("WITH m AS (SELECT date_trunc('month',date::timestamp) AS month,sum(transactions) AS n FROM activity_daily WHERE date>=DATE '2019-01-01' GROUP BY 1) SELECT month,n,lag(n) OVER(ORDER BY month) FROM m WHERE month IN (SELECT month FROM m)"),{features:['cte','group','subquery','window'],span:'multi_year'});
 // An open upper bound runs to now; an open lower bound is unbounded.
 assert.equal((await shapeOf("SELECT * FROM blocks WHERE timestamp<1790812800")).span,'unbounded');
 assert.equal((await shapeOf("SELECT DISTINCT miner FROM blocks WHERE timestamp>=1790812800")).features[0],'distinct');
});

test('compiled research carries the shape without changing existing features or SQL',async()=>{
 const c=await compileResearchSQL({version:3,sql:secretSQL,limit:10},{extended:true});
 assert.deepEqual(c.features,['join']);assert.deepEqual(c.shape,{features:['distinct','join'],span:'month'});
 assert.deepEqual(Object.keys(c.shape).sort(),['features','span']);
 assert.doesNotMatch(JSON.stringify(c.shape),/t1Secret|2026|address|labels/);
});

test('joint shape fields contain fixed tokens only and never question, SQL, literals or identifiers',async()=>{
 const c=await compileResearchSQL({version:3,sql:secretSQL,limit:10},{extended:true});
 const record={outcome:'resource',datasets:c.datasets,features:c.shape.features,span:c.shape.span,mode:'queued',elapsedMs:31000,question:'who owns t1SecretAddressValue',sql:secretSQL,ip:'1.2.3.4',address:'t1SecretAddressValue'};
 assert.equal(metrics.shapeField(record),'address_activity+labels|distinct+join|month|queued|resource|30s_plus');
 assert.deepEqual(metrics.metricFields(record),['requests','outcome:resource','duration:30s_plus','dataset:address_activity','dataset:labels','feature:distinct','feature:join','span:month','mode:queued']);
 let request;await metrics.recordMetrics({isReady:true,eval:async(script,options)=>{assert.equal(script,metrics.INCREMENT_SHAPE);request=options;}},record,Date.UTC(2026,9,30));
 assert.deepEqual(request.keys,['ask:{mainnet}:research-counts:v1:2026-10-30','ask:{mainnet}:research-shapes:v1:2026-10-30']);
 assert.equal(request.arguments[0],String(metrics.MAX_SHAPES));assert.equal(request.arguments[1],metrics.shapeField(record));
 assert.doesNotMatch(JSON.stringify(request),/t1Secret|1\.2\.3\.4|owns|SELECT|2026-09|epoch/i);
 assert.equal(metrics.shapeField({...record,datasets:[],features:[]}).split('|').slice(0,2).join('|'),'none|plain');
 for(const bad of [{span:'2026-09'},{mode:'visitor'},{features:['t1SecretAddressValue']},{datasets:['public.addresses']},{outcome:'ok'},{elapsedMs:-1}])assert.throws(()=>metrics.shapeField({...record,...bad}),JSON.stringify(bad));
 // Records without a shape keep the original single-hash form.
 let legacy;await metrics.recordMetrics({isReady:true,eval:async(script,options)=>{assert.equal(script,metrics.INCREMENT);legacy=options;}},{outcome:'success',datasets:['blocks'],elapsedMs:5},Date.UTC(2026,9,30));
 assert.deepEqual(legacy.keys,['ask:{mainnet}:research-counts:v1:2026-10-30']);
});

test('both scripts expire every key after 30 days and cap new joint shapes',()=>{
 assert.match(metrics.INCREMENT,/EXPIRE',KEYS\[1\],2592000/);
 assert.match(metrics.INCREMENT_SHAPE,/EXPIRE',KEYS\[1\],2592000/);assert.match(metrics.INCREMENT_SHAPE,/EXPIRE',KEYS\[2\],2592000/);
 assert.match(metrics.INCREMENT_SHAPE,/HLEN',KEYS\[2\]\)<tonumber\(ARGV\[1\]\)/);assert.match(metrics.INCREMENT_SHAPE,/'overflow'/);
});

test('reading validates every stored category and aggregates heavy shapes',async()=>{
 const shapes={'address_activity|distinct+group|month|queued|resource|30s_plus':'4','address_activity|distinct+group|month|queued|success|15_30s':'1','activity_daily|group|year|quick|success|under_1s':'9','address_daily|plain|month|quick|success|under_1s':'3',overflow:'2'};
 const redis={hGetAll:async key=>key.includes('research-shapes')?shapes:{'requests':'17','outcome:resource':'4','span:month':'8','mode:quick':'12'}};
 const day=await metrics.readMetrics(redis,'2026-10-30');
 assert.equal(day.overflow,2);assert.equal(day.shapes.length,4);assert.equal(day.counts['span:month'],8);
 const ranked=metrics.heavyShapes([day,day]);
 assert.deepEqual(ranked[0],{datasets:['address_activity'],features:['distinct','group'],span:'month',mode:'queued',requests:10,heavy:8,outcomes:{resource:8,success:2},durations:{'30s_plus':8,'15_30s':2},heavyRate:0.8});
 assert.equal(ranked.find(r=>r.datasets[0]==='address_daily').heavy,0);
 for(const injected of [{'t1Secret|plain|month|quick|success|under_1s':'1'},{'blocks|plain|month|quick|success':'1'},{'blocks|join+cte|month|quick|success|under_1s':'1'},{'blocks|plain|month|quick|success|under_1s':'x'},{'SELECT 1':'1'}])
  await assert.rejects(metrics.readMetrics({hGetAll:async key=>key.includes('research-shapes')?injected:{}},'2026-10-30'),JSON.stringify(injected));
 await assert.rejects(metrics.readMetrics({hGetAll:async()=>({'dataset:t1Secret':'1'})},'2026-10-30'));
 await assert.rejects(metrics.readMetrics(redis,'2026-02-30'));
});

test('operator report reads fixed day keys only, never scans',async()=>{
 const at=Date.UTC(2026,9,30,12);
 assert.deepEqual(daysFor([],at),['2026-10-30']);assert.deepEqual(daysFor(['2026-10-01'],at),['2026-10-01']);
 assert.deepEqual(daysFor(['--days','3','--heavy'],at),['2026-10-30','2026-10-29','2026-10-28']);
 for(const bad of [['--days','31'],['--days','0'],['--days','x'],['2026-13-01']])assert.throws(()=>daysFor(bad,at));
 const keys=[];const redis={hGetAll:async key=>{keys.push(key);return key.includes('research-shapes')?{'flows|plain|week|queued|timeout|30s_plus':'1'}:{requests:'1'};},scan:()=>{throw Error('no scans');},keys:()=>{throw Error('no scans');}};
 const out=await report(redis,['--days','2','--heavy'],at);
 assert.deepEqual(out.days,['2026-10-30','2026-10-29']);assert.equal(out.shapes[0].heavy,2);assert.equal(keys.length,4);
 assert.ok(keys.every(k=>/^ask:\{mainnet\}:research-(counts|shapes):v1:2026-10-(29|30)$/.test(k)));
});

test('quick worker queries record anonymous shapes only when enabled',async t=>{
 const {createWorker}=require('../../ask-analytics-worker');
 const key='private-test-worker-key-at-least-32-characters',calls=[];
 const settings={ASK_RESEARCH_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core',ASK_RESEARCH_EXTENDED:'true',ASK_ANALYTICS_SERVICE_KEY:key};
 const redis={isReady:true,eval:async(script,options)=>{calls.push(options);return 1;}};
 let fail=null;
 const analytics={execute:async input=>{if(fail)throw fail;const c=await compileResearchSQL(input,{extended:true});return {result:researchEvidence(c,[['1']],[{name:'n',dataTypeID:20}],{indexed_through:'2026-10-30T00:00:00Z'},'2026-10-30T00:00:01Z')};}};
 const serve=async env=>{const s=createWorker(env,{analytics,redis,memoryPressure:{assertAvailable:async()=>{}}}).listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}/query`;};
 const post=(url,sql)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({version:3,sql,limit:10})});
 const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
 const off=await serve(settings);assert.equal((await post(off,secretSQL)).status,200);await settle();assert.equal(calls.length,0);
 const on=await serve({...settings,ASK_RESEARCH_METRICS_ENABLED:'true'});
 assert.equal((await post(on,secretSQL)).status,200);await settle();
 assert.equal(calls.at(-1).arguments[1],'address_activity+labels|distinct+join|month|quick|success|under_1s');
 fail=Object.assign(Error('canceling statement due to statement timeout'),{code:'57014'});
 assert.equal((await post(on,secretSQL)).status,504);await settle();assert.match(calls.at(-1).arguments[1],/\|quick\|timeout\|/);
 fail=Object.assign(Error('temp file limit'),{code:'53400'});
 assert.equal((await post(on,secretSQL)).status,422);await settle();assert.match(calls.at(-1).arguments[1],/\|quick\|resource\|/);
 // Policy rejections never reach execution or metrics.
 assert.equal((await post(on,'DELETE FROM blocks')).status,400);await settle();assert.equal(calls.length,3);
 assert.doesNotMatch(JSON.stringify(calls),/t1Secret|SELECT|2026-09/);
});

test('real Redis increments, caps and expires both day hashes',{skip:!process.env.TEST_REDIS_URL},async()=>{
 const {createClient}=require('redis');const redis=createClient({url:process.env.TEST_REDIS_URL});await redis.connect();
 const at=Date.UTC(2031,0,2),day='2031-01-02',keys=[metrics.KEY+day,metrics.SHAPE_KEY+day];
 try{
  await redis.del(keys);
  const record={outcome:'timeout',datasets:['address_activity'],features:['distinct','group'],span:'month',mode:'queued',elapsedMs:30500};
  await metrics.recordMetrics(redis,record,at);await metrics.recordMetrics(redis,record,at);
  const read=await metrics.readMetrics(redis,day);
  assert.equal(read.counts.requests,2);assert.equal(read.counts['outcome:timeout'],2);assert.deepEqual(read.shapes,[{...metrics.parseShape(metrics.shapeField(record)),count:2}]);
  for(const key of keys){const ttl=await redis.ttl(key);assert.ok(ttl>2591000&&ttl<=2592000,key+' '+ttl);}
  // Fill to the cap: an unseen shape then counts only as overflow; a seen one still increments.
  await redis.hSet(keys[1],Object.fromEntries(Array.from({length:metrics.MAX_SHAPES-1},(_,i)=>['fill-'+i,'1'])));
  await metrics.recordMetrics(redis,{...record,span:'year'},at);await metrics.recordMetrics(redis,record,at);
  assert.equal(await redis.hGet(keys[1],'overflow'),'1');assert.equal(await redis.hGet(keys[1],metrics.shapeField(record)),'3');
 }finally{await redis.del(keys);await redis.quit();}
});
