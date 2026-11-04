'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {providerGuard}=require('../../scripts/ask-eval-preview');
const config={model:'fixture',reasoningEffort:'none'};
const request={method:'POST',redirect:'error',body:JSON.stringify({model:'fixture',reasoning_effort:'none'})};
test('operator guard counts actual outbound attempts atomically and never dispatches beyond its hard cap',async()=>{
 let calls=0;const guard=providerGuard(config,2,async(url,options)=>{calls++;assert.equal(JSON.parse(options.body).service_tier,'default');return {ok:true};});
 const result=await Promise.allSettled(Array.from({length:5},()=>guard.fetch('https://api.openai.com/v1/chat/completions',request)));
 assert.equal(calls,2);assert.equal(guard.attempts,2);assert.equal(result.filter(r=>r.status==='fulfilled').length,2);
});
test('failed provider attempts remain charged and model changes/redirect endpoints fail before dispatch',async()=>{
 let calls=0;const guard=providerGuard(config,2,async()=>{calls++;throw Error('fixture transport failure');});
 await assert.rejects(guard.fetch('https://api.openai.com/v1/chat/completions',request));assert.equal(guard.attempts,1);
 for(const [url,options] of [['https://elsewhere.test',request],['https://api.openai.com/v1/chat/completions',{...request,redirect:'follow'}],['https://api.openai.com/v1/chat/completions',{...request,body:'{"model":"other"}'}]])await assert.rejects(guard.fetch(url,options));
 assert.equal(guard.attempts,1);assert.equal(calls,1);
 for(const limit of [0,13,1.5,NaN])assert.throws(()=>providerGuard(config,limit));
});

test('operator runtime attests the actual profile and blocks browser origins, wrong hosts and nonloopback callers',()=>{
 const {createEvaluation}=require('../../scripts/ask-eval-preview');
 const env={ASK_EVAL_ISOLATED:'true',ASK_PRIVATE_PREVIEW:'true',ASK_EVAL_PROFILE:'luna-candidate',ASK_EVAL_REVISION:'2941572',ASK_EVAL_PROVIDER_ATTEMPT_LIMIT:'2',ASK_ENABLED:'true',ASK_PROVIDER:'openai',ASK_MODEL:'gpt-6-luna',ASK_REASONING_EFFORT:'none',ASK_API_KEY:'fixture-only',ASK_DAILY_CALL_LIMIT:'10',ASK_DAILY_BUDGET_USD:'1',ASK_MONTHLY_BUDGET_USD:'2',ASK_MAX_INPUT_USD_PER_MILLION:'0.25',ASK_MAX_OUTPUT_USD_PER_MILLION:'0.75',ASK_ABUSE_SECRET:'x'.repeat(32),ASK_TURNSTILE_SECRET:'fixture-only',ASK_TURNSTILE_HOSTNAME:'localhost'};
 let calls=0;const fixture=createEvaluation(env,{redis:{isReady:true},previewFactory:()=>({app:(req,res)=>{calls++;assert.equal(req.headers.host,'127.0.0.1:3004');res.end('{}');},stop(){}})});
 const call=(headers={},remoteAddress='127.0.0.1',url='/__ask_eval/runtime')=>{let status=200,body='',responseHeaders={};fixture.handler({method:'GET',url,headers:{host:'127.0.0.1:3007',...headers},socket:{remoteAddress}},{setHeader:(k,v)=>{responseHeaders[k]=v;},writeHead:s=>{status=s;},end:value=>{body=value||'';}});return {status,body,responseHeaders};};
 const runtime=JSON.parse(call().body);assert.equal(runtime.model,env.ASK_MODEL);assert.equal(runtime.reasoningEffort,'none');assert.match(runtime.sourceDigest,/^[a-f0-9]{64}$/);assert.equal(runtime.providerAttempts,0);assert.equal(JSON.stringify(runtime).includes('fixture-only'),false);
 for(const response of [call({origin:'http://127.0.0.1:3003'}),call({host:'example.test'}),call({},'203.0.113.1')])assert.equal(response.status,403);
 call({},'127.0.0.1','/v1/ask');assert.equal(calls,1);
 assert.throws(()=>createEvaluation({...env,ASK_MODEL:'other'},{redis:{}}),/does not match/);
 assert.throws(()=>createEvaluation({...env,ASK_EVAL_PROFILE:'sol-candidate',ASK_MODEL:'gpt-6-sol'},{redis:{}}),/reservations/);
 assert.throws(()=>createEvaluation({...env,ASK_MAX_OUTPUT_USD_PER_MILLION:'0.5'},{redis:{}}),/reservations/);
});
