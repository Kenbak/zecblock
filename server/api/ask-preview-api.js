'use strict';
// PRIVATE TEST FIXTURE ONLY. Never mount this entry point behind public ingress.
// CAPTCHA verification is simulated, with Cloudflare's published dummy site key.
const express=require('express');
const {randomUUID}=require('node:crypto');
const {isIP}=require('node:net');
const {createClient}=require('redis');
const {createAskRouter}=require('./v1/routes/ask');
const DUMMY_SITE_KEY='1x00000000000000000000AA';
function createPrivatePreview(env,{redis,routerFactory=createAskRouter}={}){
 if(env.ASK_PRIVATE_PREVIEW!=='true'||!redis)throw Error('Explicit private preview required');
 // Known credential aliases only: this catches accidental shared DB/RPC config,
 // not every possible inherited secret. Provider/worker/Redis credentials belong here.
 if(['DATABASE_URL','REPLICA_DATABASE_URL','DB_PASSWORD','PGPASSWORD','ASK_ANALYTICS_DATABASE_URL','ZCASH_RPC_PASSWORD'].some(key=>env[key]))throw Error('Database/RPC credentials must not enter the private Ask API');
 const config={...env,ASK_TURNSTILE_SITE_KEY:DUMMY_SITE_KEY};
 const challengeFetch=async()=>({ok:true,json:async()=>({success:true,action:'ask',hostname:config.ASK_TURNSTILE_HOSTNAME})});
 const internalClient={dispatch:async()=>{throw Error('Indexed record source is not configured in the private preview');}};
 const router=routerFactory(config,{redis,challengeFetch,internalClient,fetch});
 const app=express();app.disable('x-powered-by');
 app.use((req,res,next)=>{
  res.set('Cache-Control','private, no-store');res.set('X-Robots-Tag','noindex, nofollow');
  const hosts=new Set(['127.0.0.1:3004','localhost:3004']);
  const origins=new Set(['http://127.0.0.1:3003','http://localhost:3003']);
  if(!hosts.has(req.headers.host)||(req.headers.origin&&!origins.has(req.headers.origin)))return res.status(403).json({error:'private-preview-only'});
  const controller=new AbortController();
  const abort=()=>{if(!res.writableEnded)controller.abort();};
  req.once('aborted',abort);res.once('close',abort);
  res.once('finish',()=>{req.off('aborted',abort);res.off('close',abort);});
  const requestId=randomUUID();res.set('X-Request-Id',requestId);
  req.v1={network:'mainnet',requestId,abortSignal:controller.signal};
  // Explicit operator fixture switch; never trust this header on a public API.
  if(env.ASK_PREVIEW_SIMULATE_IPS==='true'&&typeof req.headers['x-sim-ip']==='string'&&isIP(req.headers['x-sim-ip'])===4&&req.headers['x-sim-ip'].startsWith('198.18.'))Object.defineProperty(req,'ip',{value:req.headers['x-sim-ip'],configurable:true});
  next();
 });
 app.use('/v1/ask',express.json({limit:'16kb'}),router);
 app.use((req,res)=>res.status(404).json({error:'not-found'}));
 // eslint-disable-next-line @typescript-eslint/no-unused-vars
 app.use((error,req,res,next)=>res.status(error.type==='entity.too.large'?413:400).json({error:'invalid-request'}));
 return {app,stop:()=>router.stop?.()};
}
async function main(){
 if(process.getuid?.()===0)throw Error('Private API must run as a non-root account');
 const env=process.env;
 if(env.ASK_PRIVATE_PREVIEW!=='true'||!env.ASK_ANALYTICS_REDIS_URL)throw Error('Private preview is not configured');
 const redis=createClient({url:env.ASK_ANALYTICS_REDIS_URL});redis.on('error',()=>{});
 await redis.connect();
 const preview=createPrivatePreview(env,{redis});
 const server=preview.app.listen(3004,'127.0.0.1',()=>console.log('Private Ask API listening on loopback:3004'));
 server.requestTimeout=40000;server.headersTimeout=20000;server.maxConnections=32;
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  server.close(async()=>{await preview.stop();await redis.quit();});server.closeAllConnections();
 });
}
if(require.main===module)main().catch(()=>{console.error('Private Ask API failed');process.exitCode=1;});
module.exports={createPrivatePreview,DUMMY_SITE_KEY};
