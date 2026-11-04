'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),https=require('node:https'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const {once}=require('node:events');
const {createHash,X509Certificate}=require('node:crypto');
const express=require('express');
const {HOST,stagingConfig,fingerprint,peerAllowed,tlsOptions,createStagingServer}=require('../../ask-staging-api');
const {createStagingSource}=require('../../v1/lib/ask-staging-source');
const {createInternalClient}=require('../../v1/lib/internal-client');
const {budgetConfig,admit,ADMIT,ADMIT_WORK,reserve,RESERVE,maximumCost}=require('../../v1/lib/ask-budget');
const {createAskRouter,providerConfig}=require('../../v1/routes/ask');

const stageEnv={ASK_STAGING_ENABLED:'true',ASK_STAGING_CLIENT_FINGERPRINT256:'a'.repeat(64)};
const paidEnv={ASK_ENABLED:'true',ASK_PROVIDER:'openai',ASK_MODEL:'fixture-model',ASK_API_KEY:'fixture-provider-key',ASK_DAILY_CALL_LIMIT:'30',ASK_DAILY_BUDGET_USD:'1',ASK_MONTHLY_BUDGET_USD:'5',ASK_MAX_INPUT_USD_PER_MILLION:'0.2',ASK_MAX_OUTPUT_USD_PER_MILLION:'0.75',ASK_ABUSE_SECRET:'a'.repeat(32)};
function certificates(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-staging-tls-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=args=>execFileSync('openssl',args,{stdio:'pipe',timeout:15000});
 fs.writeFileSync(path.join(root,'ca.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Ask staging disposable CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
 run(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',path.join(root,'ca.key'),'-out',path.join(root,'ca.pem'),'-config',path.join(root,'ca.cnf')]);
 const issue=(name,extension)=>{
  fs.writeFileSync(path.join(root,name+'.ext'),extension);
  run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',path.join(root,name+'.key'),'-out',path.join(root,name+'.csr'),'-subj','/CN=Ask disposable '+name]);
  run(['x509','-req','-in',path.join(root,name+'.csr'),'-CA',path.join(root,'ca.pem'),'-CAkey',path.join(root,'ca.key'),'-CAcreateserial','-days','1','-out',path.join(root,name+'.pem'),'-extfile',path.join(root,name+'.ext')]);
  fs.chmodSync(path.join(root,name+'.key'),0o600);
 };
 issue('server','basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,IP:135.181.17.198\n');
 issue('client','basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n');
 issue('other','basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n');
 run(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',path.join(root,'untrusted.key'),'-out',path.join(root,'untrusted.pem'),'-config',path.join(root,'ca.cnf')]);
 const read=name=>fs.readFileSync(path.join(root,name));
 return {root,read,env:{...stageEnv,ASK_STAGING_CLIENT_FINGERPRINT256:new X509Certificate(read('client.pem')).fingerprint256,ASK_STAGING_CA_FILE:path.join(root,'ca.pem'),ASK_STAGING_CERT_FILE:path.join(root,'server.pem'),ASK_STAGING_KEY_FILE:path.join(root,'server.key')}};
}
function request(url,fixture,{method='GET',headers={},body,client='client',servername}={}){
 const payload=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
 const options={method,agent:false,ca:fixture.read('ca.pem'),rejectUnauthorized:true,...(client?{cert:fixture.read(client+'.pem'),key:fixture.read(client+'.key')}:{}) ,headers:{Host:HOST,'x-ask-staging-client-ip':'203.0.113.9',...(payload===undefined?{}:{'Content-Type':'application/json'}),...headers},...(servername?{servername}:{})};
 return new Promise((resolve,reject)=>{
  const req=https.request(url,options,res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});res.once('error',reject);res.once('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)});}catch{reject(Error('Invalid fixture response'));}});});
  req.once('error',reject);req.setTimeout(5000,()=>req.destroy(Error('Fixture timeout')));req.end(payload);
 });
}
async function serve(t,fixture,{env={},routerFactory}={}){
 const stage=createStagingServer({...fixture.env,...env},{redis:{isReady:true},routerFactory});
 stage.server.listen(0,'127.0.0.1');await once(stage.server,'listening');
 t.after(async()=>{stage.server.closeAllConnections();await new Promise(resolve=>stage.server.close(resolve));await stage.stop();});
 return {url:'https://127.0.0.1:'+stage.server.address().port,stage};
}

test('staging needs explicit enable, exact leaf pin and no preview/known DB configuration',()=>{
 for(const flag of [undefined,'false','TRUE',true])assert.throws(()=>stagingConfig({...stageEnv,ASK_STAGING_ENABLED:flag}));
 for(const key of ['ASK_PRIVATE_PREVIEW','ASK_PREVIEW_SIMULATE_IPS','DATABASE_URL','REPLICA_DATABASE_URL','DB_PASSWORD','PGPASSWORD','ASK_ANALYTICS_DATABASE_URL','ZCASH_RPC_PASSWORD'])assert.throws(()=>stagingConfig({...stageEnv,[key]:'true'}));
 for(const pin of [undefined,'','a'.repeat(63),'a'.repeat(65),'a'.repeat(64)+',','zz'.repeat(32)])assert.throws(()=>fingerprint(pin));
 assert.equal(fingerprint('AA:'.repeat(31)+'AA').toString('hex'),'a'.repeat(64));
 assert.doesNotThrow(()=>stagingConfig({...stageEnv,ASK_PRIVATE_PREVIEW:'false',ASK_PREVIEW_SIMULATE_IPS:'false'}));
 const raw=Buffer.from('disposable certificate'),pin=createHash('sha256').update(raw).digest();
 assert.equal(peerAllowed({encrypted:true,authorized:true,getPeerCertificate:()=>({raw})},pin),true);
 for(const socket of [{encrypted:false,authorized:true},{encrypted:true,authorized:false},{encrypted:true,authorized:true,getPeerCertificate:()=>({raw:Buffer.from('wrong')})}])assert.equal(peerAllowed(socket,pin),false);
});

test('server-only staging mode preserves quota/cost reservations while production still verifies Turnstile',async()=>{
 const stage=budgetConfig({...paidEnv,...stageEnv},{authenticatedStaging:true});assert.ok(stage);assert.equal(stage.siteKey,null);
 assert.equal(budgetConfig({...paidEnv,...stageEnv}),null,'flag alone never opts into staging authentication');
 assert.equal(budgetConfig(paidEnv,{authenticatedStaging:true}),null,'factory option alone never opts in');
 const signal=new AbortController().signal,req={ip:'203.0.113.9',body:{},v1:{abortSignal:signal,authenticatedStaging:true}};
 const evaluations=[];let verification=0;
 const redis={eval:async(script,options)=>{evaluations.push({script,options});return 1;},zRem:async()=>{}};
 await admit(redis,stage,req,async()=>{verification++;throw Error('must not call CAPTCHA');});
 assert.equal(verification,0);assert.equal(evaluations[0].script,ADMIT);
 await assert.rejects(admit(redis,stage,{...req,v1:{abortSignal:signal},headers:{'x-authenticated-staging':'true'},body:{authenticatedStaging:true}},()=>assert.fail('must not fetch')),e=>e.askKind==='verification');
 const production=budgetConfig({...paidEnv,ASK_TURNSTILE_SECRET:'fixture-secret',ASK_TURNSTILE_HOSTNAME:'fixture.example',ASK_TURNSTILE_SITE_KEY:'fixture-site'});
 await assert.rejects(admit(redis,production,req,()=>assert.fail('no challenge provided')),e=>e.askKind==='verification');
 await admit(redis,production,{...req,body:{challenge:'real-protocol-token'}},async(url,options)=>{verification++;assert.match(url,/siteverify$/);assert.equal(JSON.parse(options.body).secret,'fixture-secret');return Response.json({success:true,action:'ask',hostname:'fixture.example'});});
 assert.equal(verification,1);
 const release=await reserve(redis,{...stage,dailyCalls:30},JSON.stringify({max_completion_tokens:1500}),Date.UTC(2026,9,17));await release();
 assert.equal(evaluations.at(-1).script,RESERVE);assert.equal(evaluations.at(-1).options.keys[3],'ask:{mainnet}:usd:2026-10');
 assert.equal(maximumCost(stage,'{}'),maximumCost(production,'{}'));
});

test('fixed public source is GET-only, has no credential forwarding and rejects redirects/oversized responses',async()=>{
 const calls=[];
 const source=createStagingSource({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({height:1});}});
 assert.equal((await source.dispatch('GET','/api/info',{query:{bounded:'1'},parentSignal:new AbortController().signal})).body.height,1);
 assert.equal(calls[0].url.origin,'https://api.zecblock.com');assert.equal(calls[0].options.redirect,'error');
 assert.deepEqual(Object.keys(calls[0].options.headers).sort(),['Accept','X-CipherScan-Internal']);
 for(const [method,target,options] of [['POST','/api/tx/broadcast',{}],['GET','https://attacker.invalid',{}],['GET','/api/info',{nodeToken:'secret'}],['GET','/api/info',{paymentAuth:{Authorization:'secret'}}],['GET','/api/info',{body:{}}]])await assert.rejects(source.dispatch(method,target,options));
 const oversized=createStagingSource({fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))});await assert.rejects(oversized.dispatch('GET','/api/info'),/size limit/);
 const redirect=createStagingSource({fetchImpl:async(url,options)=>{assert.equal(options.redirect,'error');throw TypeError('redirect refused');}});await assert.rejects(redirect.dispatch('GET','/api/info'),/Internal request failed/);
 // The shared client's default interface still works; optional fetch injection
 // retains its fixed timeout, body/header bounds and cancellation handling.
 const client=createInternalClient({internalBaseUrl:'https://fixture.invalid',internalTimeoutMs:100,maxResponseBytes:128,internalServiceKey:''},{fetchImpl:async(url,options)=>{assert.equal(options.redirect,undefined);return Response.json({ok:true});}});
 assert.deepEqual((await client.dispatch('GET','/api/info')).body,{ok:true});
});

test('real mTLS enforces chain+leaf pin+IP identity before HTTP; trusted request context cannot be forged',async t=>{
 const certs=certificates(t);let reached=0,entered;const seen=[],held=new Promise(resolve=>{entered=resolve;});
 const options=tlsOptions(certs.env);assert.equal(options.minVersion,'TLSv1.2');assert.equal(options.requestCert,true);assert.equal(options.rejectUnauthorized,true);
 for(const override of [{ASK_STAGING_CA_FILE:path.join(certs.root,'ca.key')},{ASK_STAGING_CA_FILE:path.join(certs.root,'client.pem')},{ASK_STAGING_KEY_FILE:path.join(certs.root,'other.key')},{ASK_STAGING_KEY_FILE:'relative.key'}])assert.throws(()=>tlsOptions({...certs.env,...override}));
 const {url,stage}=await serve(t,certs,{routerFactory:(env,dependencies)=>{
  assert.equal(dependencies.authenticatedStaging,true);assert.equal(dependencies.challengeFetch,undefined);
  const router=express.Router();router.all('/',(req,res)=>{reached++;seen.push(req.v1.abortSignal);if(req.body?.hold){entered(req.v1.abortSignal);return;}if(req.body?.large)return res.json({data:'x'.repeat(270001)});res.json({authenticated:req.v1.authenticatedStaging,ip:req.ip,requestId:req.v1.requestId,body:req.body??null});});return router;
 }});
 const allowed=await request(url+'/v1/ask',certs);assert.equal(allowed.status,200);assert.equal(allowed.body.authenticated,true);assert.equal(allowed.body.ip,'203.0.113.9');assert.match(allowed.body.requestId,/^[a-f\d-]{36}$/);
 assert.equal(allowed.headers['cache-control'],'private, no-store');assert.equal(allowed.headers['x-robots-tag'],'noindex, nofollow');assert.equal(allowed.headers['x-powered-by'],undefined);
 await assert.rejects(request(url+'/v1/ask',certs,{client:null}));
 await assert.rejects(request(url+'/v1/ask',certs,{client:'untrusted'}),'untrusted client CA is rejected before HTTP');
 await assert.rejects(request(url+'/v1/ask',certs,{client:'server'}),'server-purpose certificate cannot authenticate a client');
 assert.equal((await request(url+'/v1/ask',certs,{client:'other'})).status,403);
 await assert.rejects(request(url+'/v1/ask',certs,{servername:'wrong.example'}));
 for(const headers of [{'x-ask-staging-client-ip':''},{'x-ask-staging-client-ip':'203.0.113.9, 203.0.113.10'},{Host:'127.0.0.1:8443'},{Origin:'https://attacker.example'},{Cookie:'session=private'},{Authorization:'Bearer fixture'},{'x-forwarded-for':'198.18.0.1'},{'x-sim-ip':'198.18.0.1'}])assert.equal((await request(url+'/v1/ask',certs,{headers})).status,403);
 assert.equal(reached,1);assert.equal(stage.server.maxConnections,16);assert.equal(stage.server.requestTimeout,40000);
 const post=await request(url+'/v1/ask',certs,{method:'POST',body:{question:'fixture',authenticatedStaging:false}});assert.equal(post.body.authenticated,true,'visitor body cannot clear or grant server state');
 assert.equal((await request(url+'/v1/ask',certs,{method:'DELETE'})).status,405);
 assert.equal((await request(url+'/v1/ask/unknown',certs)).status,404);
 assert.equal((await request(url+'/v1/ask',certs,{method:'POST',body:'{'})).status,400);
 assert.equal((await request(url+'/v1/ask',certs,{method:'POST',body:{question:'x'.repeat(17000)}})).status,413);
 assert.equal((await request(url+'/v1/ask',certs,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
 const large=await request(url+'/v1/ask',certs,{method:'POST',body:{large:true}});assert.equal(large.status,503);assert.deepEqual(large.body,{error:'unavailable'});
 const plain=http.createServer(stage.app);plain.listen(0,'127.0.0.1');await once(plain,'listening');t.after(()=>{plain.closeAllConnections();plain.close();});
 assert.equal((await fetch('http://127.0.0.1:'+plain.address().port+'/v1/ask',{headers:{Host:HOST,'x-ask-staging-client-ip':'203.0.113.9'}})).status,403,'plaintext never grants staging auth');
 const pending=https.request(url+'/v1/ask',{method:'POST',agent:false,ca:certs.read('ca.pem'),cert:certs.read('client.pem'),key:certs.read('client.key'),headers:{Host:HOST,'x-ask-staging-client-ip':'203.0.113.9','Content-Type':'application/json'}});pending.on('error',()=>{});pending.end('{"hold":true}');
 const pendingSignal=await held;const cancelled=once(pendingSignal,'abort',{signal:AbortSignal.timeout(2000)});pending.destroy();await cancelled;assert.equal(pendingSignal.aborted,true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(seen[0].aborted,false,'completed connection does not cancel successful work');
});

test('authenticated HTTPS can submit without CAPTCHA; capability is explicit and unauthenticated spoofing stays closed',async t=>{
 const certs=certificates(t);let submitted=0,admitted=0,sqlWork=0;
 const env={...paidEnv,ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core',ASK_RESEARCH_ENABLED:'true',ASK_RESEARCH_EXTENDED:'true',ASK_RESEARCH_JOBS_ENABLED:'true'};
 const ticket={id:'c101ff56-a7df-4fa7-85db-cbe3220681ee',token:'a'.repeat(64)};
 const analytics={jobsEnabled:true,submit:async()=>{submitted++;return ticket;},close:async()=>{}};
 const {url}=await serve(t,certs,{env,routerFactory:(config,dependencies)=>createAskRouter(config,{...dependencies,redis:{isReady:true,eval:async(script,options)=>{if(script===ADMIT)admitted++;else{assert.equal(script,ADMIT_WORK);assert.match(options.keys[0],/:work:sql:/);sqlWork++;}return 1;}},analytics,fetch:()=>assert.fail('No provider calls in staging fixture'),challengeFetch:()=>assert.fail('No CAPTCHA in authenticated fixture')})});
 const capability=(await request(url+'/v1/ask',certs)).body;assert.equal(capability.data.authenticatedStaging,true);assert.equal(capability.data.siteKey,null);assert.equal(capability.meta.network,'mainnet');
 const query={version:3,sql:'SELECT height FROM blocks LIMIT 1',limit:1};
 const result=await request(url+'/v1/ask/research/jobs',certs,{method:'POST',body:query});assert.equal(result.status,200);assert.deepEqual(result.body.data.job,ticket);assert.equal(admitted,1);assert.equal(submitted,1);assert.equal(sqlWork,1);
 assert.equal((await request(url+'/v1/ask/research/jobs',certs,{method:'POST',body:{...query,authenticatedStaging:true}})).status,400);assert.equal(submitted,1);
 // Explicit stage option without server-authenticated req.v1 must fail even on
 // an in-process router; production configuration remains unchanged.
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.v1={network:'mainnet',requestId:'fixture',abortSignal:new AbortController().signal};next();});
 const router=createAskRouter({...env,...stageEnv},{authenticatedStaging:true,redis:{isReady:true,eval:async()=>assert.fail('unauthenticated staging must not reach admission')},analytics,fetch:()=>assert.fail('must not dispatch')});app.use('/v1/ask',router);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await router.stop();});
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/ask/research/jobs',{method:'POST',headers:{'Content-Type':'application/json','x-authenticated-staging':'true'},body:JSON.stringify(query)});assert.equal(response.status,403);assert.equal(submitted,1);
 assert.ok(providerConfig({...paidEnv,...stageEnv},{authenticatedStaging:true}));assert.equal(providerConfig({...paidEnv,...stageEnv}),null);
});
