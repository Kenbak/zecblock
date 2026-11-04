'use strict';
// Trusted operator: reviewed, fixed cases only. No visitor questions/results are
// retained. Calls the private loopback worker and emits counts/timing, not rows.
const {benchmarks}=require('../v1/lib/ask-research-benchmarks');
const {jobTicketSchema,jobStatusSchema}=require('../../../lib/ask/research-job-contract');
async function main(){
 const chosen=process.argv.slice(2),cases=chosen.length?chosen.map(id=>benchmarks.find(b=>b.id===id)):benchmarks;
 if(cases.some(b=>!b)||new Set(chosen).size!==chosen.length)throw Error('Invalid reviewed case');
 const base=new URL(process.env.ASK_ANALYTICS_URL||'http://127.0.0.1:3015');
 if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!process.env.ASK_ANALYTICS_SERVICE_KEY)throw Error('Private loopback worker required');
 async function post(path,body){
  const response=await fetch(new URL(path,base),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.ASK_ANALYTICS_SERVICE_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
  if(!response.ok)throw Error('Worker did not admit reviewed case');
  return response.json();
 }
 for(const item of cases){
  const started=Date.now();
  try{
   const ticket=jobTicketSchema.parse(await post('/jobs/submit',{version:3,sql:item.sql,limit:100}));let state;
   for(let i=0;i<160;i++){state=jobStatusSchema.parse(await post('/jobs/status',ticket));if(!['queued','running'].includes(state.state))break;await new Promise(resolve=>setTimeout(resolve,250));}
   console.log(JSON.stringify({case:item.id,state:state.state,elapsedMs:Date.now()-started,rows:state.result?.rows.length||0,indexedThrough:state.result?.indexedThrough||null,error:state.error||null}));
   if(state.state!=='succeeded')process.exitCode=1;
  }catch{console.log(JSON.stringify({case:item.id,state:'unavailable',elapsedMs:Date.now()-started}));process.exitCode=1;}
 }
}
if(require.main===module)main().catch(()=>{console.error('Reviewed research benchmark unavailable');process.exitCode=1;});
