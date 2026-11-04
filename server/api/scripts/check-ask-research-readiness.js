'use strict';
// Fixed operator cases only. Never accept visitor SQL or persist result rows,
// query text, tokens or raw errors. Exercise the same private queued runner.
const {benchmarks}=require('../v1/lib/ask-research-benchmarks');
const {jobTicketSchema,jobStatusSchema}=require('../../../lib/ask/research-job-contract');
function options(args,env){
 let concurrency=1,rounds=1;const ids=[];
 for(const arg of args){if(/^--concurrency=[1-6]$/.test(arg))concurrency=Number(arg.at(-1));else if(/^--rounds=[12]$/.test(arg))rounds=Number(arg.at(-1));else if(arg.startsWith('--'))throw Error('Unknown readiness option');else ids.push(arg);}
 const cases=ids.length?ids.map(id=>benchmarks.find(item=>item.id===id)):benchmarks;
 if(cases.some(item=>!item)||new Set(ids).size!==ids.length||cases.length*rounds>22)throw Error('Reviewed case selection required');
 const url=new URL(env.ASK_ANALYTICS_URL||'http://127.0.0.1:3015');
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!env.ASK_ANALYTICS_SERVICE_KEY||env.ASK_ANALYTICS_SERVICE_KEY.length<32)throw Error('Private loopback worker required');
 return {concurrency,rounds,cases,url};
}
function percentile(values,p){const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]:null;}
async function run(args,env,{request,emit=record=>console.log(JSON.stringify(record)),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}={}){
 const transport=request?null:require('../v1/lib/ask-worker-transport').createWorkerTransport();
 request ||= transport.fetch;
 const config=options(args,env),work=Array.from({length:config.rounds},(_,round)=>config.cases.map(item=>({item,round:round+1}))).flat(),results=[];let next=0;
 async function post(path,body){const response=await request(new URL(path,config.url),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.ASK_ANALYTICS_SERVICE_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});if(!response.ok)throw Object.assign(Error('Private request refused'),{kind:response.status===429?'quota':response.status===401?'authentication':response.status===400?'policy':'unavailable',status:response.status});return response.json();}
 async function execute({item,round}){
  const started=now();let ticket,state;
  try{
   ticket=jobTicketSchema.parse(await post('/jobs/submit',{version:3,sql:item.sql,limit:100}));
   for(let attempt=0;attempt<840;attempt++){
    state=jobStatusSchema.parse(await post('/jobs/status',ticket));
    if(!['queued','running'].includes(state.state))break;
    await pause(250);
   }
   if(!state||['queued','running'].includes(state.state)){await post('/jobs/cancel',ticket);throw Object.assign(Error('Bounded poll expired'),{kind:'poll-timeout'});}
   const record={case:item.id,round,state:state.state,error:state.error||null,elapsedMs:now()-started,queueMs:state.startedAt?Date.parse(state.startedAt)-Date.parse(state.createdAt):null,executionMs:state.finishedAt&&state.startedAt?Date.parse(state.finishedAt)-Date.parse(state.startedAt):null,rows:state.result?.rows.length||0,indexedThrough:state.result?.indexedThrough||null};
   results.push(record);emit(record);
  }catch(error){if(ticket)try{await post('/jobs/cancel',ticket);}catch{/* No raw response/token is logged. */}const record={case:item.id,round,state:'unavailable',error:['quota','authentication','poll-timeout','policy'].includes(error.kind)?error.kind:'unavailable',httpStatus:Number.isInteger(error.status)?error.status:null,networkCode:['UND_ERR_SOCKET','ECONNRESET','ETIMEDOUT','EPIPE'].includes(error.cause?.code)?error.cause.code:null,failureType:['ZodError','TypeError','SyntaxError','TimeoutError','AbortError'].includes(error.name)?error.name:null,elapsedMs:now()-started};results.push(record);emit(record);}
 }
 try{await Promise.all(Array.from({length:Math.min(config.concurrency,work.length)},async()=>{while(next<work.length){const index=next++;await execute(work[index]);}}));}finally{transport?.close();}
 const successful=results.filter(record=>record.state==='succeeded');
 const summary={kind:'reviewed-research-readiness',observedAt:new Date(now()).toISOString(),concurrency:config.concurrency,samples:results.length,succeeded:successful.length,failed:results.length-successful.length,endToEndP50Ms:percentile(successful.map(record=>record.elapsedMs),.5),endToEndP95Ms:percentile(successful.map(record=>record.elapsedMs),.95),executionP95Ms:percentile(successful.map(record=>record.executionMs).filter(value=>value!==null),.95),meaning:'Fixed private workload sample, including transport/queue; not a capacity or universal query guarantee.'};emit(summary);return summary;
}
if(require.main===module)run(process.argv.slice(2),process.env).then(summary=>{if(summary.failed)process.exitCode=1;}).catch(()=>{console.error('Private research readiness configuration unavailable');process.exitCode=1;});
module.exports={options,percentile,run};
