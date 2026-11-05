'use strict';
// Operator-only evaluation process. Never mount behind public ingress.
const http=require('node:http');
const {randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const ENDPOINTS=new Set(['https://api.openai.com/v1/chat/completions','https://api.anthropic.com/v1/messages']);
function providerGuard(config,limit,fetchImpl=fetch){
 if(!Number.isInteger(limit)||limit<1||limit>12)throw Error('Evaluation attempt cap must be 1–12');
 let attempts=0;const statuses={};
 return {
  get attempts(){return attempts;},
  get statuses(){return {...statuses};},
  async fetch(url,options){
   if(!ENDPOINTS.has(String(url))||options?.method!=='POST'||options.redirect!=='error')throw Error('Unexpected evaluation provider request');
   const body=JSON.parse(options.body);
   if(body.model!==config.model||(body.reasoning_effort??null)!==config.reasoningEffort)throw Error('Evaluation model changed');
   if(attempts>=limit)throw Error('Evaluation provider attempt limit reached');
   attempts++; // Count before dispatch, including failed/uncertain requests.
   // Pin Standard pricing for this isolated comparison; never inherit Project Auto/Fast.
   const outgoing=String(url).startsWith('https://api.openai.com/')?{...options,body:JSON.stringify({...body,service_tier:'default'})}:options;
   const response=await fetchImpl(url,outgoing);
   if(Number.isInteger(response.status))statuses[response.status]=(statuses[response.status]||0)+1;
   return response;
  },
 };
}
function sourceDigest(){
 const paths=['ask-eval-preview.js','evaluate-ask-research.js','../../../lib/ask/research-catalogue.js','../v1/lib/ask-research-eval-cases.js','../v1/lib/ask-research-eval.js','../v1/lib/ask-model-profile.js','../ask-preview-api.js','../v1/routes/ask.js','../v1/lib/ask-chat.js','../v1/lib/ask-explanation.js','../v1/lib/ask-research-plan-quality.js','../v1/lib/ask-research-projection.js','../v1/lib/ask-research-address-performance.js','../v1/lib/ask-research-period-grain.js','../v1/lib/ask-research-share-denominator.js','../v1/lib/ask-research-null-ranking.js','../v1/lib/ask-research-reply.js','../v1/lib/ask-research-sql.js'];
 const hash=createHash('sha256');for(const file of paths)hash.update(file).update(fs.readFileSync(path.join(__dirname,file)));return hash.digest('hex');
}
function createEvaluation(env,{redis,fetchImpl=fetch,previewFactory}={}){
 const {createPrivatePreview,DUMMY_SITE_KEY}=require('../ask-preview-api');
 const {createAskRouter,providerConfig}=require('../v1/routes/ask');
 const {modelProfile}=require('../v1/lib/ask-model-profile');
 previewFactory??=createPrivatePreview;
 if(env.ASK_EVAL_ISOLATED!=='true'||env.ASK_PRIVATE_PREVIEW!=='true'||!redis)throw Error('Explicit isolated evaluation required');
 const profile=modelProfile(env.ASK_EVAL_PROFILE),config=providerConfig({...env,ASK_TURNSTILE_SITE_KEY:DUMMY_SITE_KEY});
 if(!config||config.provider!==profile.provider||config.model!==profile.model||config.reasoningEffort!==profile.reasoningEffort)throw Error('Evaluation profile does not match serving configuration');
 if(config.inputRate<profile.minimumInputReservationRate||config.outputRate<profile.minimumOutputReservationRate)throw Error('Evaluation reservations below reviewed profile bounds');
 const revision=env.ASK_EVAL_REVISION;
 if(!/^[a-f0-9]{7,40}$/.test(revision||''))throw Error('Verified revision required');
 const limit=Number(env.ASK_EVAL_PROVIDER_ATTEMPT_LIMIT),guard=providerGuard(config,limit,fetchImpl),runId=randomUUID(),digest=sourceDigest();
 const preview=previewFactory(env,{redis,routerFactory:(config,dependencies)=>createAskRouter(config,{...dependencies,fetch:guard.fetch})});
 const handler=(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');
  if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!['127.0.0.1:3007','localhost:3007'].includes(req.headers.host)||req.headers.origin){res.writeHead(403);res.end();return;}
  if(req.method==='GET'&&req.url==='/__ask_eval/runtime'){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({isolated:true,provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort,runId,revision,sourceDigest:digest,providerAttemptLimit:limit,providerAttempts:guard.attempts,providerStatuses:guard.statuses}));return;
  }
  req.headers.host='127.0.0.1:3004';preview.app(req,res);
 };
 return {handler,stop:preview.stop};
}
async function main(){
 if(process.getuid?.()===0)throw Error('Evaluation API must run as a non-root account');
 const env=process.env;if(!env.ASK_ANALYTICS_REDIS_URL)throw Error('Existing private Redis required');
 const {createClient}=require('redis');
 const redis=createClient({url:env.ASK_ANALYTICS_REDIS_URL});redis.on('error',()=>{});await redis.connect();
 const evaluation=createEvaluation(env,{redis}),server=http.createServer(evaluation.handler);
 server.requestTimeout=40000;server.headersTimeout=20000;server.maxConnections=16;
 server.listen(3007,'127.0.0.1',()=>console.log('Isolated Ask evaluation listening on loopback:3007'));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close(async()=>{await evaluation.stop();await redis.quit();});server.closeAllConnections();});
}
if(require.main===module)main().catch(()=>{console.error('Isolated Ask evaluation unavailable');process.exitCode=1;});
module.exports={providerGuard,createEvaluation};
