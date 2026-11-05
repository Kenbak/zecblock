'use strict';
// Separate protected staging entrypoint. Never imports the production monolith,
// dotenv, a database pool or the private preview's CAPTCHA/IP simulation.
const express=require('express');
const https=require('node:https');
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID,timingSafeEqual,X509Certificate,createPrivateKey}=require('node:crypto');
const {isIP}=require('node:net');
const {createClient}=require('redis');
const {createAskRouter,providerConfig}=require('./v1/routes/ask');
const {createStagingSource}=require('./v1/lib/ask-staging-source');

const HOST='135.181.17.198:8443';
const IP='135.181.17.198';
const MAX_RESPONSE_BYTES=270000;
const POSTS=new Set(['/v1/ask','/v1/ask/chat','/v1/ask/explain','/v1/ask/research/plan','/v1/ask/research/query','/v1/ask/research/jobs','/v1/ask/research/jobs/status','/v1/ask/research/jobs/cancel','/v1/ask/research/jobs/explain']);
const DENIED_CONFIG=['DATABASE_URL','REPLICA_DATABASE_URL','DB_PASSWORD','PGPASSWORD','ASK_ANALYTICS_DATABASE_URL','ZCASH_RPC_PASSWORD'];
function fingerprint(value){
 if(typeof value!=='string'||!(/^[a-f\d]{64}$/i.test(value)||/^(?:[a-f\d]{2}:){31}[a-f\d]{2}$/i.test(value)))throw Error('Pinned staging certificate required');
 return Buffer.from(value.replaceAll(':','').toLowerCase(),'hex');
}
function stagingConfig(env){
 if(env.ASK_STAGING_ENABLED!=='true')throw Error('Explicit authenticated staging required');
 if([env.ASK_PRIVATE_PREVIEW,env.ASK_PREVIEW_SIMULATE_IPS].some(value=>value!==undefined&&value!==''&&value!=='false'))throw Error('Preview simulation is forbidden in staging');
 if(DENIED_CONFIG.some(key=>env[key]))throw Error('Database/RPC credentials are forbidden in staging');
 return {fingerprint:fingerprint(env.ASK_STAGING_CLIENT_FINGERPRINT256)};
}
function peerAllowed(socket,pin){
 if(socket.encrypted!==true||socket.authorized!==true)return false;
 try{
  const raw=socket.getPeerCertificate().raw;
  if(!Buffer.isBuffer(raw)||raw.length===0||raw.length>16384)return false;
  return timingSafeEqual(createHash('sha256').update(raw).digest(),pin);
 }catch{return false;}
}
function createStagingAPI(env,{redis,routerFactory=createAskRouter,source=createStagingSource()}={}){
 const config=stagingConfig(env);
 if(!redis)throw Error('Dedicated quota connection required');
 const router=routerFactory(env,{redis,internalClient:source,authenticatedStaging:true});
 const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
 app.use((req,res,next)=>{
  res.set('Cache-Control','private, no-store');res.set('X-Robots-Tag','noindex, nofollow');
  if(!peerAllowed(req.socket,config.fingerprint))return res.status(403).json({error:'unauthorized'});
  // Only the authenticated server-to-server gateway may assert an IP. Client
  // cookies/auth/Origin and simulation/forwarding headers have no role here.
  const clientIP=req.headers['x-ask-staging-client-ip'];
  if(req.headers.host!==HOST||typeof clientIP!=='string'||clientIP.length>45||!isIP(clientIP)
   ||['origin','cookie','authorization','forwarded','x-forwarded-for','x-real-ip','x-sim-ip'].some(key=>req.headers[key]!==undefined))return res.status(403).json({error:'invalid-gateway-request'});
  if(req.method!=='GET'&&req.method!=='POST')return res.status(405).json({error:'method-not-allowed'});
  if((req.method==='GET'&&req.path!=='/v1/ask')||(req.method==='POST'&&!POSTS.has(req.path)))return res.status(404).json({error:'not-found'});
  if(req.method==='POST'&&(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')||req.headers['content-encoding']))return res.status(415).json({error:'invalid-request'});
  Object.defineProperty(req,'ip',{value:clientIP,configurable:false});
  const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort();};
  req.once('aborted',abort);res.once('close',abort);
  res.once('finish',()=>{req.off('aborted',abort);res.off('close',abort);});
  const requestId=randomUUID();res.set('X-Request-Id',requestId);
  req.v1={network:'mainnet',requestId,abortSignal:controller.signal};
  Object.defineProperty(req.v1,'authenticatedStaging',{value:true,enumerable:false});
  const json=res.json.bind(res);
  res.json=value=>{
   try{if(Buffer.byteLength(JSON.stringify(value))<=MAX_RESPONSE_BYTES)return json(value);}catch{/* Fixed refusal only. */}
   res.status(503);return json({error:'unavailable'});
  };
  next();
 });
 app.use('/v1/ask',express.json({limit:'16kb',inflate:false}),router);
 app.use((req,res)=>res.status(404).json({error:'not-found'}));
 // eslint-disable-next-line @typescript-eslint/no-unused-vars
 app.use((error,req,res,next)=>res.status(error?.type==='entity.too.large'?413:400).json({error:'invalid-request'}));
 return {app,stop:()=>router.stop?.()};
}
function tlsOptions(env){
 const read=(key,secret=false)=>{
  const filename=env[key];
  if(typeof filename!=='string'||!path.isAbsolute(filename))throw Error('Explicit staging TLS files required');
  const info=fs.statSync(filename);
  if(!info.isFile()||info.size<1||info.size>65536||secret&&(info.mode&0o027))throw Error('Protected staging TLS files required');
  return fs.readFileSync(filename);
 };
 const ca=read('ASK_STAGING_CA_FILE'),cert=read('ASK_STAGING_CERT_FILE'),key=read('ASK_STAGING_KEY_FILE',true);
 if(/PRIVATE KEY/.test(ca.toString())||/PRIVATE KEY/.test(cert.toString()))throw Error('CA private key must remain outside staging');
 const authority=new X509Certificate(ca),leaf=new X509Certificate(cert);
 const now=Date.now();
 if(!authority.ca||Date.parse(authority.validFrom)>now||Date.parse(authority.validTo)<=now||Date.parse(leaf.validFrom)>now||Date.parse(leaf.validTo)<=now
  ||leaf.checkIP(IP)!==IP||!leaf.checkPrivateKey(createPrivateKey(key)))throw Error('Valid pinned-IP staging TLS identity required');
 return {ca,cert,key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.3',handshakeTimeout:5000};
}
function createStagingServer(env,dependencies){
 stagingConfig(env);
 const options=tlsOptions(env),stage=createStagingAPI(env,dependencies);
 const server=https.createServer(options,stage.app);
 server.requestTimeout=40000;server.headersTimeout=10000;server.maxHeadersCount=32;
 server.maxConnections=16;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
 server.setTimeout(45000,socket=>socket.destroy());
 server.on('tlsClientError',()=>{}); // No peer certificates or TLS errors in logs.
 return {...stage,server};
}
async function main(){
 const env=process.env;
 if(process.getuid?.()===0)throw Error('Staging API must run as a non-root account');
 stagingConfig(env);
 if(!providerConfig(env,{authenticatedStaging:true})||!env.ASK_ANALYTICS_REDIS_URL)throw Error('Staging provider and quota configuration required');
 const redis=createClient({url:env.ASK_ANALYTICS_REDIS_URL});redis.on('error',()=>{});
 const stage=createStagingServer(env,{redis});await redis.connect();stage.server.listen(8443,'0.0.0.0');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  stage.server.close(async()=>{await stage.stop();await redis.quit();});stage.server.closeAllConnections();
 });
}
if(require.main===module)main().catch(()=>{console.error('Authenticated staging API failed');process.exitCode=1;});
module.exports={HOST,IP,MAX_RESPONSE_BYTES,fingerprint,stagingConfig,peerAllowed,createStagingAPI,tlsOptions,createStagingServer};
