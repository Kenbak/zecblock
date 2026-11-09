'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {once}=require('node:events');
const {createAskRouter}=require('../../v1/routes/ask');
const {createWorker}=require('../../ask-analytics-worker');
const {createAnalyticsClient}=require('../../v1/lib/ask-analytics-client');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const {ADMIT,ADMIT_WORK,RESERVE}=require('../../v1/lib/ask-budget');
const settings={ASK_RESEARCH_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core',ASK_ENABLED:'false',ASK_DAILY_BUDGET_USD:'1',ASK_MONTHLY_BUDGET_USD:'10',ASK_MAX_INPUT_USD_PER_MILLION:'0.2',ASK_MAX_OUTPUT_USD_PER_MILLION:'0.75',ASK_ABUSE_SECRET:'x'.repeat(32),ASK_TURNSTILE_SECRET:'fixture-secret',ASK_TURNSTILE_HOSTNAME:'example.test',ASK_TURNSTILE_SITE_KEY:'fixture-site'};
const query={version:3,sql:'SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 5',limit:5};
async function server(t,app){const s=app.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
const post=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
async function evidence(input){const c=await compileResearchSQL(input);return {result:researchEvidence(c,[['9007199254740993',null]],[{name:'height',dataTypeID:20},{name:'fees',dataTypeID:1700}],{indexed_through:'2026-10-06T00:00:00Z'},'2026-10-06T00:00:01Z')};}
test('manual SQL enforces verification and separate request/SQL admission without a provider reservation',async t=>{
 let count=0,paid=0,admitted=0,sqlWork=0;const redis={isReady:true,eval:async(script,options)=>{if(script===RESERVE){paid++;throw Error('must not charge');}if(script===ADMIT)admitted++;else{assert.equal(script,ADMIT_WORK);assert.match(options.keys[0],/:work:sql:/);sqlWork++;}return 1;}};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.v1={network:'mainnet',requestId:'fixture',abortSignal:new AbortController().signal};next();});const router=createAskRouter(settings,{redis,analytics:{execute:async input=>{count++;return evidence(input);}},challengeFetch:async()=>Response.json({success:true,action:'ask',hostname:'example.test'}),fetch:async()=>{throw Error('must not call AI');}});t.after(()=>router.stop());app.use('/ask',router);const url=await server(t,app);
 assert.equal((await (await fetch(url+'/ask')).json()).data.researchEnabled,true);
 const response=await post(url+'/ask/research/query',{...query,challenge:'fixture'});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);const body=await response.json();assert.equal(body.data.result.rows[0][0],'9007199254740993');assert.equal(body.data.mode,'research');assert.equal(paid,0);assert.equal(count,1);assert.equal(admitted,1);assert.equal(sqlWork,1);
 for(const sql of ['DELETE FROM blocks',"SELECT pg_read_file('/etc/passwd') FROM blocks",'SELECT * FROM pg_subscription'])assert.equal((await post(url+'/ask/research/query',{...query,sql,challenge:'fixture'})).status,400);
 assert.equal(count,1);assert.equal(admitted,1);assert.equal(sqlWork,1);
 assert.equal((await post(url+'/ask/research/query',query)).status,400);assert.equal((await post(url+'/ask/research/plan',{question:'Latest blocks',challenge:'fixture'})).status,503);assert.equal(count,1);
 redis.isReady=false;assert.equal((await post(url+'/ask/research/query',{...query,challenge:'fixture'})).status,503);assert.equal(count,1);
});
test('worker/client validate research fingerprint, reject writes before execute and fail closed on malformed evidence',async t=>{
 const key='private-test-worker-key-at-least-32-characters';let calls=0;
 const app=createWorker({...settings,ASK_ANALYTICS_SERVICE_KEY:key},{redis:{isReady:true},analytics:{execute:async input=>{calls++;return evidence(input);}}});const url=await server(t,app);
 const clientEnv={...settings,ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:key,ASK_ANALYTICS_SERVICE_URL:url+'/'};
 const client=createAnalyticsClient(clientEnv);const result=await client.execute(query);assert.equal(result.result.rows[0][0],'9007199254740993');assert.equal(calls,1);
 assert.equal((await post(url+'/query',{...query,sql:'DELETE FROM blocks'},{Authorization:'Bearer '+key})).status,400);assert.equal(calls,1);assert.equal((await post(url+'/query',query)).status,401);
 const valid=await evidence(query);for(const changed of [{...valid.result,fingerprint:'a'.repeat(64)},{...valid.result,query:{...valid.result.query,sql:'SELECT secret FROM private'}},{...valid.result,credentials:'secret'},{...valid.result,rows:[['width mismatch']]},{...valid.result,datasets:['transactions']}]){const bad=createAnalyticsClient(clientEnv,async()=>Response.json({research:changed}));await assert.rejects(bad.execute(query));}
 const disabled=createAnalyticsClient({...clientEnv,ASK_RESEARCH_ENABLED:'false'});await assert.rejects(disabled.execute(query));assert.equal(calls,1);
});


test('natural language executes only a validated draft, with one challenge and one paid reservation',async t=>{
 let paid=0,verified=0,admitted=0,calls=0,executed=0;const work={ai:0,sql:0};
 let sql='SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 5';
 const redis={isReady:true,eval:async(script,options)=>{if(script===RESERVE)paid++;else if(script===ADMIT)admitted++;else{assert.equal(script,ADMIT_WORK);const kind=/:work:(ai|sql):/.exec(options.keys[0])?.[1];assert.ok(kind);work[kind]++;}return 1;},zRem:async()=>{}};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.v1={network:'mainnet',requestId:'fixture',abortSignal:new AbortController().signal};next();});
 const router=createAskRouter({...settings,ASK_ENABLED:'true',ASK_PROVIDER:'openai',ASK_MODEL:'fixture-model',ASK_API_KEY:'fixture-provider-key',ASK_DAILY_CALL_LIMIT:'10'},
 {redis,analytics:{execute:async input=>{executed++;return evidence(input);}},challengeFetch:async()=>{verified++;return Response.json({success:true,action:'ask',hostname:'example.test'});},fetch:async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/chat/completions');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.doesNotMatch(JSON.stringify(body),/fixture-provider-key|fixture-secret|fixture-challenge/);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({sql})}}]});}});
 t.after(()=>router.stop());app.use('/ask',router);const url=await server(t,app);
 const submit=execute=>post(url+'/ask/research/plan',{question:'Show latest blocks',challenge:'fixture-challenge',execute});
 let response=await submit(true);assert.equal(response.status,200);let body=await response.json();assert.equal(body.data.result.rows[0][0],'9007199254740993');assert.equal(body.data.query.sql,body.data.result.query.sql);assert.equal(executed,1);assert.equal(verified,1);assert.equal(admitted,1);assert.equal(paid,1);assert.equal(calls,1);assert.deepEqual(work,{ai:1,sql:1});
 response=await submit(false);assert.equal(response.status,200);body=await response.json();assert.equal(body.data.result,undefined);assert.equal(executed,1);
 sql='DELETE FROM blocks';response=await submit(true);assert.equal(response.status,503);assert.equal(executed,1);assert.doesNotMatch(await response.text(),/DELETE/);
 sql=null;response=await submit(true);assert.equal(response.status,200);assert.equal((await response.json()).data.query,null);assert.equal(executed,1);
 assert.equal((await submit('yes')).status,400);assert.equal(verified,4);assert.equal(paid,4);assert.equal(admitted,4);assert.deepEqual(work,{ai:4,sql:1});
});

test('research SQL reports fixed timeout/validation categories without leaking PostgreSQL diagnostics',async()=>{
 const {createAnalytics,CORE_GUARD}=require('../../v1/lib/ask-analytics');
 for(const [code,kind]of [['57014','timeout'],['53400','resource'],['42703','query'],['XX000','source']]){
  const releases=[];
  const client={release:value=>releases.push(value),query:async statement=>{
   if(statement===CORE_GUARD)return{rows:[Object.fromEntries(['dedicated','identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers'].map(key=>[key,true]))]};
   if(statement==='SELECT * FROM analytics_public.coverage')return{rows:[{schema_version:1,authority:'logical_public_core',network:'mainnet',ready:true}]};
   if(typeof statement==='string'&&statement.startsWith('SELECT NULL::int'))return{rows:[{indexed_through:'2026-10-06T00:00:00Z'}]};
   if(typeof statement==='object')throw Object.assign(Error('private DSN and SQL diagnostic'),{code});
   return{rows:[]};
  }};
  const service=createAnalytics({...settings,ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_DATABASE_URL:'peer-only',ASK_ANALYTICS_SOCKET:'/run/ask-public-db',ASK_ANALYTICS_DAILY_QUERY_LIMIT:'100'},{pool:{on(){},end(){},connect:async()=>client}});
  await assert.rejects(service.execute(query,{redis:{isReady:true,eval:async()=>1,zRem:async()=>{} }}),error=>error.askKind===kind&&!error.message.includes('private')&&(kind==='source'?error.code===undefined:error.code===code));
  assert.deepEqual(releases,[true]);await service.close();
 }
});

test('the Ask chat routes custom research and follow-ups through SQL without a second workspace',async()=>{
 const {chat}=require('../../v1/lib/ask-chat');
 const {coreCatalogue}=require('../../v1/lib/ask-core-catalogue');
 const input={question:'Which recent blocks collected the highest fees?',page:'ask',context:null,locale:'auto',history:['Show latest blocks'],challenge:'secret-challenge',currentResearch:query};
 let stages=0,executions=0;
 const analytics={researchEnabled:true,catalogue:coreCatalogue,execute:async compiled=>{executions++;return evidence(compiled);}};
 const reply=await chat(input,async(body,task)=>{
  assert.doesNotMatch(JSON.stringify(body),/secret-challenge/);
  if(++stages===1){assert.deepEqual(body.currentResearch,query);assert.match(task.instruction,/three public tables/);return task.validator.parse({intent:'research',sql:query.sql,spec:null,blockQuery:null,transactionQuery:null,flowQuery:null,topics:['block'],locale:'en'});}
  assert.equal(body.evidence.facts.row_a_a,'9,007,199,254,740,993');
  assert.equal(body.evidence.facts.row_a_b,'unavailable');
  // Findings are written freely and every number is verified afterwards.
  assert.equal(task.validator.safeParse({finding:'Block 123 collected lots of fees.'}).success,true);
  return task.validator.parse({finding:'The first returned block is {{row_a_a}}; its fee value is {{row_a_b}}.'});
 },null,new AbortController().signal,'fixed chart instructions',{},analytics);
 assert.equal(stages,2);assert.equal(executions,1);assert.equal(reply.research.rows[0][0],'9007199254740993');assert.match(reply.answer,/9,007,199,254,740,993/);assert.equal(reply.spec,null);
 for(const selection of [{intent:'research',sql:'DELETE FROM blocks'}, {intent:'unsupported',sql:null}]){
  let calls=0;const pending=chat({...input,question:'Make cupcakes',history:[]},async(body,task)=>{calls++;return task.validator.parse({...selection,spec:null,blockQuery:null,transactionQuery:null,flowQuery:null,topics:[],locale:'en'});},null,new AbortController().signal,'',{},analytics);
  if(selection.intent==='research')await assert.rejects(pending,error=>error.askKind==='answer');else assert.match((await pending).answer,/Zcash/);
  assert.equal(calls,1);assert.equal(executions,1);
 }
});

test('long results supply leading rows plus extremes over every returned row, not a misleading preview',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const result={query:{version:3,sql:'SELECT height FROM blocks',limit:100},columns:[{key:'c0',label:'day',type:'text'},{key:'c1',label:'count',type:'number'}],rows:Array.from({length:30},(_,i)=>['2026-09-'+String(i+1).padStart(2,'0'),String(i)]),truncated:false,datasets:['transactions'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-07T01:43:06Z',indexedThrough:'2026-10-07T01:43:05Z',coverage:'verified canonical records',units:'exact'};
 let captured;
 const reply=await researchReply(result,{question:'Daily counts',history:[]},async(input,task)=>{captured=input;assert.match(task.instruction,/exact server calculations over the returned rows/);return{finding:'The highest count is {{max_b}} on {{max_b_at}}.'};},'en');
 assert.equal(captured.evidence.facts.row_count,'30');assert.equal(captured.evidence.facts.max_b,'29');assert.equal(captured.evidence.facts.min_b,'0');
 assert.equal(captured.evidence.facts.row_d_b,undefined);assert.equal(captured.evidence.rows,undefined);
 assert.equal(reply.answer,'The highest count is 29 on Sep 30, 2026.');
 for(const rows of [Array.from({length:41},()=>['date','1']),Array.from({length:30},()=>['x'.repeat(1000),'1'])]){
  await researchReply({...result,rows},{question:'Counts',history:[]},async(input)=>{captured=input;return{finding:'The leading count is {{row_a_b}}.'};},'en');
  assert.equal(captured.evidence.facts.row_count,String(rows.length));assert.ok(captured.evidence.facts.row_a_a.length<=160);
 }
});

test('a fragmented prose table cannot replace a complete SQL result',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const result={query:{version:3,sql:'SELECT height FROM blocks',limit:100},columns:[{key:'c0',label:'height',type:'number'}],rows:[['100'],['101']],truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-07T01:43:06Z',indexedThrough:'2026-10-07T01:43:05Z',coverage:'verified canonical records',units:'exact'};
 const template='The first of 2 returned rows has height 100. Across all returned rows, height ranges from 100 to 101.';
 const reply=await researchReply(result,{question:'Show the table',history:[]},async()=>({finding:'Height | Count\n{{row_a_a}} |'}),'en');
 assert.equal(reply.answer,template);
 assert.deepEqual(reply.research.rows,result.rows);
 assert.equal(reply.evidenceKey,result.fingerprint);
 // Numerical provenance remains mandatory: an unvalidated figure is never published.
 const literal=await researchReply(result,{question:'Show the table',history:[]},async()=>({finding:'Height | Count\n999 |'}),'en');
 assert.equal(literal.answer,template);assert.doesNotMatch(literal.answer,/999/);
});

test('row counts and figures without placeholders cannot surface as misleading numbers',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const result={query:{version:3,sql:'SELECT height FROM blocks',limit:100},columns:[{key:'c0',label:'block_count',type:'number'}],rows:[['59']],truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-07T01:43:06Z',indexedThrough:'2026-10-07T01:43:05Z',coverage:'verified canonical records',units:'exact'};
 const question={question:'How many blocks had fees above 50000 zatoshis?',history:[]};
 const reply=await researchReply(result,question,async(input,task)=>{
  assert.equal(input.evidence.facts.row_count,'1');assert.equal(input.evidence.facts.row_a_a,'59');
  assert.match(task.instruction,/checked against the evidence/);
  return {finding:'There were  {{row_a_a}}  blocks with fees above the threshold you specified.'};
 },'en');
 assert.equal(reply.answer,'There were 59 blocks with fees above the threshold you specified.');
 const template='The result has block count 59.';
 // Observed live: the count was reused as the threshold, and strict decoding
 // replaced unavailable figures with a stray letter or punctuation glyph.
 for(const summary of ['Among recent blocks, {{row_a_a}} had fees above {{row_a_a}} zatoshis.','Among recent blocks, {{row_a_a}} had fees above 59 zatoshis.','Among the last {{returned_rows}} blocks, {{row_a_a}} had high fees.','There were 73 blocks with high fees.','There were {{row_a_a}} blocks with fees greater than ɯ.','Among the last \u{1104D} blocks, {{row_a_a}} had high fees.']){
  const fallback=await researchReply(result,question,async()=>({finding:summary}),'en');
  assert.equal(fallback.answer,template,summary);assert.deepEqual(fallback.research.rows,result.rows);
 }
 const french=await researchReply(result,{question:'Combien de blocs ?',history:[]},async()=>({finding:'Il y a eu {{row_a_a}} blocs aux frais élevés.'}),'fr');
 assert.equal(french.answer,'Il y a eu 59 blocs aux frais élevés.');
});

test('prose artifacts reject period runs and unattached marks while retaining normal Unicode',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const result={query:{version:3,sql:'SELECT count(*) AS total FROM transactions',limit:100},columns:[{key:'c0',label:'total',type:'number'}],rows:[['542746']],truncated:false,datasets:['transactions'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-15T00:00:00Z',indexedThrough:'2026-10-15T00:00:00Z',coverage:'verified canonical records',units:'exact'};
 const answer=async(summary,evidence=result)=>{
  const reply=await researchReply(evidence,{question:'Explain the count',history:[]},async(_,task)=>task.validator.parse({finding:summary}),'en');
  assert.deepEqual(reply.research,evidence);assert.equal(reply.evidenceKey,evidence.fingerprint);return reply.answer;
 };
 const fallback='The result has total 542,746.';
 for(const summary of ['In ťhis analysis the count was {{row_a_a}} in \u0305 ǣ ........','The count is {{row_a_a}}....','\u0305The count is {{row_a_a}}.','The count is {{row_a_a}} in \u0305 currency.','The count is {{row_a_a}}.\n\u0305A fragment.']){
  const text=await answer(summary);assert.equal(text,fallback,summary);assert.doesNotMatch(text,/\p{M}|\.{4,}|ťhis|fragment/iu);
 }
 for(const summary of ['José reports {{row_a_a}} transactions.','Jose\u0301 reports {{row_a_a}} transactions.','The count is {{row_a_a}}... The window is complete.','The count is {{row_a_a}} … within the completed window.','The count {{row_a_a}} is ≥ the benchmark; x\u0305 names the average.'])assert.equal(await answer(summary),summary.replace('{{row_a_a}}','542,746'),summary);
 // Exact evidence stays outside this prose-only check, including an accent
 // attached directly to a fact placeholder rather than a literal base letter.
 const labelled={...result,query:{...result.query,sql:"SELECT 'label' AS label,count(*) AS total FROM transactions"},columns:[{key:'c0',label:'label',type:'text'},{key:'c1',label:'total',type:'number'}],rows:[['\u0305 ......','542746']]};
 assert.equal(await answer('The label {{row_a_a}} accompanies {{row_a_b}} transactions.',labelled),'The label \u0305 ...... accompanies 542,746 transactions.');
 assert.equal(await answer('{{row_a_a}}\u0301 reports {{row_a_b}} transactions.',{...labelled,rows:[['Jose','542746']]}),'Jose\u0301 reports 542,746 transactions.');
});

test('a unit attached to a research value must match its column conversion',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const base={query:{version:3,sql:'SELECT avg(fees) AS average_fee_per_block FROM blocks',limit:100},truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-07T01:43:06Z',indexedThrough:'2026-10-07T01:43:05Z',coverage:'verified canonical records',units:'exact'};
 const zatoshis={...base,columns:[{key:'c0',label:'average_fee_per_block',type:'number'}],rows:[['225510.400000000000']]};
 const zec={...base,query:{...base.query,sql:'SELECT avg(fees)::numeric/100000000 AS average_fee_zec FROM blocks'},columns:[{key:'c0',label:'average_fee_zec',type:'number'}],rows:[['0.002255104']]};
 const answer=async(result,summary)=>{
  const reply=await researchReply(result,{question:'Average fee?',history:[]},async()=>({finding:summary}),'en');
  assert.deepEqual(reply.research,result);assert.equal(reply.evidenceKey,result.fingerprint);return reply.answer;
 };
 const zatoshiFallback='The result has average fee per block 225,510.4 zatoshis.';
 const zecFallback='The result has average fee 0.002255104 ZEC.';
 // Observed live: a zatoshi average was published as 225,510.4 ZEC.
 const wrongZEC=await answer(zatoshis,'The average fee per block is {{row_a_a}} ZEC.');
 assert.equal(wrongZEC,zatoshiFallback);assert.doesNotMatch(wrongZEC,/225,510\.4 ZEC|average fee per block is/i);
 assert.equal(await answer(zatoshis,'The average fee per block is {{row_a_a}} zatoshis.'),'The average fee per block is 225,510.4 zatoshis.');
 assert.equal(await answer(zatoshis,'The average fee per block is {{row_a_a}}.'),'The average fee per block is 225,510.4 zatoshis.');
 assert.equal(await answer(zec,'The average fee per block is {{row_a_a}} ZEC.'),'The average fee per block is 0.002255104 ZEC.');
 const wrongZatoshis=await answer(zec,'The average fee per block is {{row_a_a}} zatoshis.');
 assert.equal(wrongZatoshis,zecFallback);assert.doesNotMatch(wrongZatoshis,/0\.002255104 zatoshis|average fee per block is/i);
 // Observed live: "in ZEC" echoed from the question over an unconverted
 // max(fees), and masked figures standing in for unavailable numbers.
 const largest={...base,columns:[{key:'c0',label:'largest_block_fee',type:'number'}],rows:[['1174068']]};
 assert.equal(await answer(largest,'The largest single block fee in ZEC is {{row_a_a}}.'),'The result has largest block fee 1,174,068 zatoshis.');
 assert.equal(await answer(largest,'The largest single block fee is {{row_a_a}} zatoshis.'),'The largest single block fee is 1,174,068 zatoshis.');
 const artifact=await answer(zec,'Over the last ******* blocks the average fee is {{row_a_a}} ZEC.');
 assert.equal(artifact,zecFallback);assert.doesNotMatch(artifact,/\*|Over the last|average fee is/);
 // ZEC as an asset name stays valid for counts and USD-denominated swaps.
 const count={...base,query:{...base.query,sql:'SELECT count(fees) AS transaction_count FROM transactions'},datasets:['transactions'],columns:[{key:'c0',label:'transaction_count',type:'number'}],rows:[['42']]};
 assert.equal(await answer(count,'There were {{row_a_a}} ZEC transactions.'),'There were 42 ZEC transactions.');
 assert.equal(await answer(count,'There were {{row_a_a}} ZEC.'),'The result has transaction count 42.');
 const swaps={...base,query:{...base.query,sql:'SELECT chain,sum(usd) AS usd_volume FROM swaps GROUP BY chain'},datasets:['swaps'],columns:[{key:'c0',label:'chain',type:'text'},{key:'c1',label:'usd_volume',type:'number'}],rows:[['ethereum','5000']]};
 assert.equal(await answer(swaps,'{{row_a_a}} led swaps into ZEC with {{row_a_b}} USD.'),'ethereum led swaps into ZEC with 5,000 USD.');
 // Observed live: degraded decoding produced fluent text citing no value.
 const uncited=await answer(count,'In the last ized to igrate zatoshis.');
 assert.equal(uncited,'The result has transaction count 42.');assert.doesNotMatch(uncited,/ized|igrate|zatoshis/);
 assert.match(await answer({...count,rows:[]},'No transactions matched the requested window.'),/returned no matching rows/);
});

test('research facts preserve exact figures and legitimate ranks, dates and repeated values',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const base={query:{version:3,sql:'SELECT count(*) AS total FROM transactions',limit:100},columns:[{key:'c0',label:'total',type:'number'}],rows:[['542746']],truncated:false,datasets:['transactions'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-15T00:00:00Z',indexedThrough:'2026-10-15T00:00:00Z',coverage:'verified canonical records',units:'exact'};
 const answer=async(result,summary,locale='en')=>(await researchReply(result,{question:'Explain the result',history:[]},async()=>{
  return {finding:summary};
 },locale)).answer;
 assert.equal(await answer(base,'Transactions amounted to {{row_a_a}}.'),'Transactions amounted to 542,746.');
 assert.equal(await answer({...base,rows:[['1']]},'There was {{row_a_a}} transaction.'),'There was 1 transaction.');
 assert.equal(await answer({...base,rows:[['9007199254740993.123400']]},'The exact result is {{row_a_a}}.'),'The exact result is 9,007,199,254,740,993.1234.');
 assert.equal(await answer({...base,rows:[['542746'],['123']]},'The leading count is {{row_a_a}}.'),'The leading count is 542,746.');
 assert.equal(await answer(base,'There were {{row_a_a}} transactions. The total remains {{row_a_a}} transactions.'),'There were 542,746 transactions. The total remains 542,746 transactions.');
 const rank={...base,query:{...base.query,sql:'SELECT row_number() OVER(ORDER BY height) AS rank,transactions FROM blocks'},datasets:['blocks'],columns:[{key:'c0',label:'rank',type:'number'},{key:'c1',label:'transactions',type:'number'}],rows:[['1','542746']]};
 assert.equal(await answer(rank,'Rank {{row_a_a}} has {{row_a_b}} transactions.'),'Rank 1 has 542,746 transactions.');
 const fused=await answer(rank,'Transactions amounted to {{row_a_a}} {{row_a_b}}.');
 assert.equal(fused,'The result has rank 1 and transactions 542,746.');assert.doesNotMatch(fused,/Transactions amounted to|1 542,746/);
 const pools={...base,query:{...base.query,sql:'SELECT pool,sum(amount) AS amount FROM flows GROUP BY pool'},datasets:['flows'],columns:[{key:'c0',label:'pool',type:'text'},{key:'c1',label:'amount',type:'number'}],rows:[['Orchard','100']]};
 assert.equal(await answer(pools,'{{row_a_a}} leads with {{row_a_b}} zatoshis. {{row_a_a}} is the leading returned pool.'),'Orchard leads with 100 zatoshis. Orchard is the leading returned pool.');
 const dated={...base,query:{...base.query,sql:'SELECT date,transactions FROM activity_daily'},datasets:['activity_daily'],columns:[{key:'c0',label:'date',type:'text'},{key:'c1',label:'transactions',type:'number'}],rows:[['2026-09-03','22283']]};
 for(const locale of ['en','de','fr']){
  const date=new Date('2026-09-03T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
  assert.equal(await answer(dated,'On {{row_a_a}}, the count is {{row_a_b}}. The observation on {{row_a_a}} leads.',locale),`On ${date}, the count is 22,283. The observation on ${date} leads.`);
 }
 assert.equal(await answer(base,'The result is {{row_a_a}}; the comparison uses ≥ as its boundary.'),'The result is 542,746; the comparison uses ≥ as its boundary.');
});

test('research monetary units follow expressions through aliases and mixed datasets',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const base={query:{version:3,sql:'SELECT b.fees::numeric/100000000 AS fee_2026 FROM blocks b',limit:100},columns:[{key:'c0',label:'fee_2026',type:'number'}],rows:[['0.002255104']],truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-15T00:00:00Z',indexedThrough:'2026-10-15T00:00:00Z',coverage:'verified canonical records',units:'exact'};
 const answer=async(result,summary)=>{
  const reply=await researchReply(result,{question:'Explain the result',history:[]},async()=>({finding:summary}),'en');
  assert.deepEqual(reply.research,result);assert.equal(reply.evidenceKey,result.fingerprint);return reply.answer;
 };
 const template=label=>`The result has ${label} 0.002255104.`;
 assert.equal(await answer(base,'The fee is {{row_a_a}} ZEC.'),'The fee is 0.002255104 ZEC.');
 const wrongZatoshis=await answer(base,'The fee is {{row_a_a}} zatoshis.');
 assert.equal(wrongZatoshis,'The result has fee 2026 0.002255104 ZEC.');assert.doesNotMatch(wrongZatoshis,/zatoshis|The fee is/);
 assert.equal(await answer(base,'The fee in ZEC is {{row_a_a}}.'),'The fee in ZEC is 0.002255104 ZEC.');
 const mixed={...base,query:{...base.query,sql:'SELECT avg(b.fees) AS fee_2026,(SELECT sum(s.usd) FROM swaps s) AS usd FROM blocks b'},datasets:['blocks','swaps'],columns:[{key:'c0',label:'fee_2026',type:'number'},{key:'c1',label:'usd',type:'number'}],rows:[['225510.4','5000']]};
 const wrongZEC=await answer(mixed,'The average block fee is {{row_a_a}} ZEC.');
 assert.equal(wrongZEC,'The result has fee 2026 225,510.4 zatoshis and usd 5,000 USD.');assert.doesNotMatch(wrongZEC,/225,510\.4 ZEC|average block fee is/i);
 assert.equal(await answer(mixed,'The average block fee is {{row_a_a}} zatoshis, while tracked swaps total {{row_a_b}} USD.'),'The average block fee is 225,510.4 zatoshis, while tracked swaps total 5,000 USD.');
 const share={...base,query:{...base.query,sql:"SELECT 100*sum(amount) FILTER(WHERE pool='orchard')/nullif(sum(amount),0) AS orchard_share_percent FROM flows"},datasets:['flows'],columns:[{key:'c0',label:'orchard_share_percent',type:'number'}],rows:[['42']]};
 assert.equal(await answer(share,'The Orchard share of public ZEC flow is {{row_a_a}} percent.'),'The Orchard share of public ZEC flow is 42%.');
 // Unproven or contradicted lineage leaves the value unlabelled, whatever its alias says.
 const unknown={...base,query:{...base.query,sql:'SELECT sqrt(avg(fees)) AS fee_zec FROM blocks'},columns:[{key:'c0',label:'fee_zec',type:'number'}]};
 assert.equal(await answer(unknown,'The fee is {{row_a_a}} ZEC.'),template('fee_zec'));
 assert.equal(await answer({...unknown,query:{...unknown.query,sql:'SELECT sqrt(avg(fees))::text AS fee_zec FROM blocks'},columns:[{key:'c0',label:'fee_zec',type:'text'}]},'The fee is {{row_a_a}} ZEC.'),'The result is 0.002255104.');
 assert.equal(await answer(unknown,'The expression returned {{row_a_a}}.'),'The expression returned 0.002255104.');
 const falseConversion={...unknown,query:{...base.query,sql:'SELECT sum(fees)+sum(fees)/100000000 AS fee_zec FROM blocks'}};
 assert.equal(await answer(falseConversion,'The fee is {{row_a_a}} ZEC.'),template('fee_zec'));
 const falseAlias={...unknown,query:{...base.query,sql:'SELECT avg(fees) AS fee_zec FROM blocks'},rows:[['225510.4']]};
 assert.equal(await answer(falseAlias,'The fee is {{row_a_a}} ZEC.'),'The result has fee_zec 225,510.4.');
 const cte={...base,query:{...base.query,sql:'WITH converted AS(SELECT fees::numeric/100000000 AS fee FROM blocks) SELECT avg(c.fee) AS average_fee_2026 FROM converted c'}};
 assert.equal(await answer(cte,'The average fee is {{row_a_a}} ZEC.'),'The average fee is 0.002255104 ZEC.');
});

test('paired pool aliases cannot relabel stored zatoshis as ZEC',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const result={query:{version:3,sql:'SELECT date,orchard AS orchard_zec,ironwood AS ironwood_zec FROM daily',limit:100},columns:[{key:'c0',label:'date',type:'text'},{key:'c1',label:'orchard_zec',type:'number'},{key:'c2',label:'ironwood_zec',type:'number'}],rows:[['2026-09-03','100000000','200000000']],truncated:false,datasets:['daily'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-15T00:00:00Z',indexedThrough:'2026-10-15T00:00:00Z',coverage:'source-defined coverage',units:'exact'};
 let calls=0;
 const reply=await researchReply(result,{question:'Compare the pools',history:[]},async(input)=>{
  calls++;assert.equal(input.evidence.columns[1].unit,'unlabelled');assert.equal(input.evidence.facts.row_a_b,'100,000,000');
  return {finding:'Orchard holds {{row_a_b}} ZEC.'};
 },'en');
 // The unit conflict is restated once, then the template keeps the bare figures.
 assert.equal(calls,2);assert.doesNotMatch(reply.answer,/ZEC/);
 assert.equal(reply.answer,'The result is Sep 3, 2026, with 100,000,000 orchard_zec and 200,000,000 ironwood_zec.');
});

test('ambiguous growth discovery asks for measures and a baseline without querying data',async()=>{
 const {chat,selectionTask}=require('../../v1/lib/ask-chat');
 const {coreCatalogue}=require('../../v1/lib/ask-core-catalogue');
 const input={question:'What is the fastest growing metrics for zcash in the past year?',page:'ask',context:null,locale:'auto',history:[]};
 let selected=0,executed=0;
 const analytics={researchEnabled:true,catalogue:coreCatalogue,execute:async()=>{executed++;throw Error('Clarification must not query data');}};
 const clarification={intent:'clarify_growth',sql:null,spec:null,blockQuery:null,transactionQuery:null,flowQuery:null,topics:[],locale:'en'};
 const reply=await chat(input,async(body,task)=>{selected++;assert.equal(body.question,input.question);assert.match(task.instruction,/explicit available metric are supported research/);assert.match(task.instruction,/measures and growth baseline unspecified/);return task.validator.parse(clarification);},null,new AbortController().signal,'',{},analytics);
 assert.equal(selected,1);assert.equal(executed,0);assert.match(reply.answer,/transaction counts/);assert.match(reply.answer,/percentage changes/);assert.doesNotMatch(reply.answer,/Try a question about this page/);assert.deepEqual(reply.sources,[]);assert.equal(reply.spec,null);
 for(const locale of ['fr','es','de','pt','ja','zh','ko','ar','ru']){
  const translated=await chat({...input,locale},async(body,task)=>task.validator.parse({...clarification,locale}),null,new AbortController().signal,'',{},analytics);
  assert.equal(translated.locale,locale);assert.ok(translated.answer);assert.notEqual(translated.answer,reply.answer);
 }
 // Even a clarification carrying SQL or a chart must fail before source access.
 for(const invalid of [{sql:'DELETE FROM blocks'},{sql:'SELECT height FROM blocks'},{blockQuery:{mode:'latest',identifier:null}}])await assert.rejects(chat(input,async()=>({...clarification,...invalid}),null,new AbortController().signal,'',{},analytics),e=>e.askKind==='answer');
 await assert.rejects(chat(input,async()=>clarification,null,new AbortController().signal,'',{},null),e=>e.askKind==='answer');
 assert.equal(executed,0);
 assert.equal(selectionTask('',null).validator.safeParse(clarification).success,false);
});

test('wide growth results preserve final values and percentages in bounded narrative evidence',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const labels=['growth_rank','metric','baseline_start','baseline_end_exclusive','baseline_count','final_start','final_end_exclusive','final_count','growth_percent'];
 const result={query:{version:3,sql:'SELECT height FROM blocks',limit:100},columns:labels.map((label,i)=>({key:'c'+i,label,type:[0,4,7,8].includes(i)?'number':'text'})),rows:[['1','Shielded transactions','2025-10-07','2025-11-06','55094','2026-09-07','2026-10-07','176694','220.71']],truncated:false,datasets:['transactions'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-07T01:43:06Z',indexedThrough:'2026-10-07T01:43:05Z',coverage:'verified canonical records',units:'exact'};
 const reply=await researchReply(result,{question:'Compare yearly growth',history:[]},async(input,task)=>{
  assert.equal(input.evidence.columns.length,9);
  assert.equal(input.evidence.facts.row_a_h,'176,694');assert.equal(input.evidence.facts.row_a_i,'220.71%');assert.match(task.instruction,/Do not calculate or estimate any number yourself/);
  return {finding:'Shielded transactions grew from {{row_a_e}} to {{row_a_h}}, a change of {{row_a_i}} percent.'};
 },'en');
 assert.match(reply.answer,/55,094 to 176,694/);assert.match(reply.answer,/220\.71%/);assert.deepEqual(reply.research,result);
 const wide={...result,columns:Array.from({length:24},(_,i)=>({key:'c'+i,label:'measure_'+i,type:'text'})),rows:Array.from({length:40},()=>Array(24).fill('x'.repeat(200)))};
 await researchReply(wide,{question:'Explain results',history:[]},async(input)=>{
  assert.ok(input.evidence.columns.length<=12);assert.ok(Buffer.byteLength(JSON.stringify(input.evidence))<=20000);
  return {finding:'The leading measure is {{row_a_a}}.'};
 },'en');
});

