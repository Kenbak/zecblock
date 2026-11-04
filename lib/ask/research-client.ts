import {getAskApiUrl} from './api-base';
import {readApiResponse} from '@/lib/api-client';
import {ApiError} from '@/lib/api-client';
import type {AskReply} from './chat';
import {jobTicketSchema,jobStatusSchema} from './research-job-contract';
import type {ResearchJobTicket,ResearchJobStatus} from './research-job-contract';
import {researchResultSchema,sqlQuerySchema} from './research-contract';
import type {ResearchQuery,ResearchResult} from './research-contract';
async function request<T = {result?:ResearchResult;query?:ResearchQuery|null}>(path:string,body:unknown,signal:AbortSignal){
 const response=await fetch(`${getAskApiUrl()}/research/${path}`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 const {data,meta}=await readApiResponse<T>(response);
 if(meta.network!=='mainnet')throw Error('Wrong network');return data;
}
export async function planResearch(question:string,challenge:string,signal:AbortSignal,execute=false){
 const data=await request('plan',{question,challenge,execute},signal);
 return {query:data.query===null?null:sqlQuerySchema.parse(data.query),result:data.result?researchResultSchema.parse(data.result):null};
}
export async function runResearch(query:ResearchQuery,challenge:string,signal:AbortSignal){const data=await request('query',{...query,challenge},signal);return researchResultSchema.parse(data.result);}

export async function submitResearch(query:ResearchQuery,challenge:string,signal:AbortSignal){const data=await request<{job:ResearchJobTicket}>('jobs',{...query,challenge},signal);return jobTicketSchema.parse(data.job);}
export async function cancelResearch(ticket:ResearchJobTicket){return request('jobs/cancel',jobTicketSchema.parse(ticket),AbortSignal.timeout(5000));}
export async function explainResearch(ticket:ResearchJobTicket,question:string,locale:string,signal:AbortSignal){return request<AskReply>('jobs/explain',{...ticket,question,locale},signal);}
export async function waitResearch(ticket:ResearchJobTicket,signal:AbortSignal,onStatus:(status:ResearchJobStatus)=>void){
 ticket=jobTicketSchema.parse(ticket);
 const abort=()=>{void cancelResearch(ticket).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{
  signal.throwIfAborted();
  while(true){
   const status=jobStatusSchema.parse(await request<ResearchJobStatus>('jobs/status',ticket,AbortSignal.any([signal,AbortSignal.timeout(7000)])));onStatus(status);
   if(status.state==='succeeded')return researchResultSchema.parse(status.result);
   if(status.state==='cancelled')throw new DOMException('Research cancelled','AbortError');
   if(status.state==='failed')throw new ApiError('Research stopped',status.quota?429:status.error==='timeout'?504:status.error==='resource'?422:503,'upstream-error',undefined,status.quota?String(status.quota.retryAfter):undefined,status.quota?.code||'ask-'+status.error,status.sql?{sql:status.sql}:undefined);
   await new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},2000);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
  }
 }finally{signal.removeEventListener('abort',abort);}
}
