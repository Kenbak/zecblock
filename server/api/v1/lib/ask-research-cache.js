'use strict';
const {createHash}=require('node:crypto');
const {researchResultSchema}=require('../../../../lib/ask/research-contract');
const PREFIX='ask:{mainnet}:research-cache:v1:';
const SAVE=`
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1])
redis.call('SET',KEYS[2],ARGV[3],'EX',30)
redis.call('ZADD',KEYS[1],ARGV[2],KEYS[2])
while redis.call('ZCARD',KEYS[1])>24 do local oldest=redis.call('ZPOPMIN',KEYS[1],1);redis.call('DEL',oldest[1]) end
redis.call('EXPIRE',KEYS[1],30);return 1`;
function cacheKey(compiled,checkpoint){
 // Never cache time-dependent SQL or a checkpoint missing canonical identity.
 if(/\b(?:current_date|current_timestamp|localtimestamp|now)\b/i.test(compiled.request.sql)||!/^([a-f0-9]{64})$/.test(checkpoint?.tip_hash||'')||!Number.isFinite(Date.parse(checkpoint?.verified_at))||checkpoint.covered_from==null||checkpoint.covered_through==null)return null;
 return PREFIX+createHash('sha256').update(JSON.stringify([compiled.fingerprint,compiled.request.limit,checkpoint.covered_from,checkpoint.covered_through,checkpoint.tip_hash,new Date(checkpoint.verified_at).toISOString(),checkpoint.datasetCheckpoints||[]])).digest('hex');
}
async function readCached(redis,key,compiled){
 if(!key)return null;
 const raw=await redis.get(key);if(!raw||Buffer.byteLength(raw)>262144)return null;
 try{const result=researchResultSchema.parse(JSON.parse(raw));if(result.fingerprint!==compiled.fingerprint||result.query.sql!==compiled.request.sql||result.query.limit!==compiled.request.limit||JSON.stringify(result.datasets)!==JSON.stringify(compiled.datasets))return null;return result;}catch{return null;}
}
async function saveCached(redis,key,result){
 if(!key)return;
 const data=JSON.stringify(researchResultSchema.parse(result));if(Buffer.byteLength(data)>262144)return;
 const now=Date.now();await redis.eval(SAVE,{keys:[PREFIX+'index',key],arguments:[String(now),String(now+30000),data]});
}
module.exports={cacheKey,readCached,saveCached,SAVE,PREFIX};
