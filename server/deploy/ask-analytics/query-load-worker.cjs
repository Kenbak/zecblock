'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- operator Node CommonJS entry */
// Fixed reviewed read-only cases only. No visitor SQL, rows or credentials in output.
const {run}=require('../../api/scripts/check-ask-research-readiness');
const {createWorkerTransport}=require('../../api/v1/lib/ask-worker-transport');
const QUICK_SQL='SELECT height, fees FROM blocks ORDER BY height DESC LIMIT 10';
function profile(args){
 if(args.length!==1||!['serial','overlap'].includes(args[0]))throw Error('Reviewed profile required');
 return {name:args[0],concurrency:args[0]==='serial'?1:6,quickSamples:4};
}
async function runLoad(args,env,{transport=createWorkerTransport(),emit=record=>console.log(JSON.stringify(record)),signal,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const config=profile(args),controller=new AbortController();
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const request=(url,options)=>transport.fetch(url,{...options,signal:new URL(url).pathname==='/jobs/cancel'?AbortSignal.timeout(5000):AbortSignal.any([options.signal,controller.signal])});
 let running=true;const quick=[];
 async function quickLane(){
  for(let i=0;i<config.quickSamples&&running&&!controller.signal.aborted;i++){
   const start=Date.now();let state='unavailable';
   try{
    const response=await request(new URL('/query',env.ASK_ANALYTICS_URL||'http://127.0.0.1:3015'),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.ASK_ANALYTICS_SERVICE_KEY},body:JSON.stringify({version:3,sql:QUICK_SQL,limit:10}),signal:AbortSignal.timeout(6000)});
    if(response.ok){const result=await response.json();if(result&&Array.isArray(result.research?.rows)&&result.research.rows.length<=10)state='succeeded';}
   }catch{/* Sanitized outcome only. */}
   const record={kind:'quick-sample',sample:i+1,state,elapsedMs:Date.now()-start};quick.push(record);emit(record);
   if(i+1<config.quickSamples&&running&&!controller.signal.aborted)await pause(1500);
  }
 }
 try{
  const quickPromise=quickLane();
  const summary=await run(['--concurrency='+config.concurrency,'--rounds=1'],env,{request,emit,pause});
  running=false;await quickPromise;
  const result={kind:'bounded-load-summary',profile:config.name,queuedSamples:summary.samples,queuedFailed:summary.failed,quickSamples:quick.length,quickFailed:quick.filter(x=>x.state!=='succeeded').length,aborted:controller.signal.aborted};
  emit(result);return result;
 }finally{running=false;signal?.removeEventListener('abort',abort);transport.close();}
}
if(require.main===module){
 const controller=new AbortController();for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>controller.abort());
 runLoad(process.argv.slice(2),process.env,{signal:controller.signal}).then(result=>{if(result.aborted||result.queuedFailed||result.quickFailed)process.exitCode=1;}).catch(()=>{console.error(JSON.stringify({kind:'bounded-load-failure',error:'configuration-or-transport'}));process.exitCode=1;});
}
module.exports={profile,runLoad,QUICK_SQL};
