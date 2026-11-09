'use strict';
// Answer ratings. Every vote increments fixed daily counters built only from
// enums. Question, answer and SQL text are kept only when the visitor ticks
// "share" on that vote, in a capped daily hash with no IP or identifier other
// than a random per-answer id. Both keys expire 30 days after their last write.
const {z}=require('zod');
const {pageIds}=require('../../../../lib/ask/pages');
const COUNT_KEY='ask:{mainnet}:feedback-counts:v1:',SHARED_KEY='ask:{mainnet}:feedback-shared:v1:',TTL=2592000,SHARED_PER_DAY=500;
const votes=['up','down'];
const reasons=['wrong_number','misunderstood','should_answer','refused_wrongly','unclear','chart_not_useful'];
// The answer path, as the server reported it. 'sql' is visitor-written SQL.
const routes=['run_sql','decline','clarify','explain_topic','open_chart','get_block','get_transaction','needs_query','lookup','guide','classifier','sql','unknown'];
const locales=['auto','en','fr','es','de','pt','ja','zh','ko','ar','ru'];
const rating=z.object({vote:z.enum(votes),reason:z.enum(reasons).optional()}).strict().refine(value=>!value.reason||value.vote==='down',{message:'Reasons apply to thumbs down only'});
const feedbackSchema=z.object({
 vote:z.enum(votes),reason:z.enum(reasons).optional(),route:z.enum(routes),template:z.boolean(),locale:z.enum(locales),page:z.enum(pageIds),
 // The vote this one replaces, so a changed vote moves the count instead of adding one.
 replaces:rating.optional(),
 // A random id the browser generated for this answer; it only lets a later vote replace or withdraw the shared copy.
 shareId:z.string().uuid().optional(),
 shared:z.object({question:z.string().trim().min(1).max(1000),answer:z.string().max(4000),sql:z.string().max(6000).optional()}).strict().optional(),
}).strict().refine(value=>!value.reason||value.vote==='down',{message:'Reasons apply to thumbs down only'}).refine(value=>!value.shared||value.shareId,{message:'Shared text needs its answer id'});
function countFields({vote,reason,route,template,locale,page}){
 return ['vote:'+vote,`route:${route}:${vote}`,`locale:${locale}:${vote}`,`page:${page}:${vote}`,...(template?['template:'+vote]:[]),...(reason?['reason:'+reason,`route:${route}:reason:${reason}`]:[])];
}
const fieldsAllowed=new Set([...votes.flatMap(vote=>['vote:'+vote,'template:'+vote,...routes.map(route=>`route:${route}:${vote}`),...locales.map(locale=>`locale:${locale}:${vote}`),...pageIds.map(page=>`page:${page}:${vote}`)]),...reasons.flatMap(reason=>['reason:'+reason,...routes.map(route=>`route:${route}:reason:${reason}`)])]);
// KEYS[1] counts; ARGV[1] number of fields to add, then those fields, then fields to remove (floored at zero).
const COUNT="local n=tonumber(ARGV[1]) for i=2,n+1 do redis.call('HINCRBY',KEYS[1],ARGV[i],1) end for i=n+2,#ARGV do if redis.call('HINCRBY',KEYS[1],ARGV[i],-1)<=0 then redis.call('HDEL',KEYS[1],ARGV[i]) end end redis.call('EXPIRE',KEYS[1],"+TTL+") return 1";
// KEYS[1] shared; ARGV id, JSON or empty to withdraw, daily cap.
const SHARE="if ARGV[2]=='' then return redis.call('HDEL',KEYS[1],ARGV[1]) end if redis.call('HEXISTS',KEYS[1],ARGV[1])==0 and redis.call('HLEN',KEYS[1])>=tonumber(ARGV[3]) then return 0 end redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]) redis.call('EXPIRE',KEYS[1],"+TTL+") return 1";
const dayOf=now=>new Date(now).toISOString().slice(0,10);
async function recordFeedback(redis,input,now=Date.now()){
 const data=feedbackSchema.parse(input),day=dayOf(now);
 const added=countFields(data),removed=data.replaces?countFields({...data,...data.replaces,reason:data.replaces.reason}):[];
 // A vote replaced with itself (e.g. sharing after voting) changes no count.
 const net=added.filter(field=>!removed.includes(field)),gone=removed.filter(field=>!added.includes(field));
 await redis.eval(COUNT,{keys:[COUNT_KEY+day],arguments:[String(net.length),...net,...gone]});
 let shared=false;
 if(data.shareId){
  const record=data.shared?JSON.stringify({day,vote:data.vote,...(data.reason?{reason:data.reason}:{}),route:data.route,template:data.template,locale:data.locale,page:data.page,...data.shared}):'';
  const stored=await redis.eval(SHARE,{keys:[SHARED_KEY+day],arguments:[data.shareId,record,String(SHARED_PER_DAY)]});
  shared=!!data.shared&&stored===1;
  // A withdrawal also clears yesterday's copy when the vote spans midnight.
  if(!data.shared)await redis.eval(SHARE,{keys:[SHARED_KEY+dayOf(now-86400000)],arguments:[data.shareId,'',String(SHARED_PER_DAY)]});
 }
 return {recorded:true,shared};
}
function validDay(day){if(!/^20\d{2}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw Error('Invalid UTC day');}
async function readFeedback(redis,day,{shared=false}={}){
 validDay(day);
 const value=await redis.hGetAll(COUNT_KEY+day),counts={};
 for(const [key,count] of Object.entries(value)){if(!fieldsAllowed.has(key)||!/^\d{1,12}$/.test(count))throw Error('Invalid anonymous counts');counts[key]=Number(count);}
 const byRoute={};
 for(const [key,count] of Object.entries(counts)){
  const match=/^route:([a-z_]+):(?:(up|down)|reason:([a-z_]+))$/.exec(key);if(!match)continue;
  const entry=byRoute[match[1]]||={up:0,down:0,reasons:{}};
  if(match[2])entry[match[2]]=count;else entry.reasons[match[3]]=count;
 }
 const reasonCounts=Object.fromEntries(reasons.filter(reason=>counts['reason:'+reason]).map(reason=>[reason,counts['reason:'+reason]]));
 const summary={day,votes:{up:counts['vote:up']||0,down:counts['vote:down']||0},templateFallback:{up:counts['template:up']||0,down:counts['template:down']||0},reasons:reasonCounts,routes:byRoute,counts};
 if(!shared)return summary;
 const samples=Object.values(await redis.hGetAll(SHARED_KEY+day)).map(text=>JSON.parse(text));
 return {...summary,shared:samples};
}
module.exports={feedbackSchema,recordFeedback,readFeedback,countFields,votes,reasons,routes,COUNT_KEY,SHARED_KEY,TTL,SHARED_PER_DAY};
