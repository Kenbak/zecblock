'use strict';
const {researchIds}=require('../../../../lib/ask/research-catalogue');
const KEY='ask:{mainnet}:research-counts:v1:';
const fieldsAllowed=new Set(['requests',...['success','timeout','resource','query','source','dataset','quota','unavailable','cancelled'].map(x=>'outcome:'+x),...['under_1s','1_5s','5_15s','15_30s','30s_plus'].map(x=>'duration:'+x),...researchIds.map(x=>'dataset:'+x),...['cte','group','join','window'].map(x=>'feature:'+x)]);
const INCREMENT="for i=1,#ARGV do redis.call('HINCRBY',KEYS[1],ARGV[i],1) end;redis.call('EXPIRE',KEYS[1],2592000);return 1";
const outcomes=new Set(['success','timeout','resource','query','source','dataset','quota','unavailable','cancelled']);
function metricFields({outcome,datasets=[],features=[],elapsedMs}={}){
 if(!outcomes.has(outcome)||!Number.isFinite(elapsedMs)||elapsedMs<0||!Array.isArray(datasets)||datasets.some(d=>!researchIds.includes(d))||!Array.isArray(features)||features.some(f=>!['cte','group','join','window'].includes(f)))throw Error('Invalid anonymous metric');
 const bucket=elapsedMs<1000?'under_1s':elapsedMs<5000?'1_5s':elapsedMs<15000?'5_15s':elapsedMs<30000?'15_30s':'30s_plus';
 return ['requests','outcome:'+outcome,'duration:'+bucket,...[...new Set(datasets)].sort().map(d=>'dataset:'+d),...[...new Set(features)].sort().map(f=>'feature:'+f)];
}
async function recordMetrics(redis,record,now=Date.now()){
 try{if(!redis?.isReady)return;const fields=metricFields(record);let timer;await Promise.race([redis.eval(INCREMENT,{keys:[KEY+new Date(now).toISOString().slice(0,10)],arguments:fields}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Metric timeout')),250);timer.unref();})]).finally(()=>clearTimeout(timer));}catch{/* Metrics never grant admission, block results or expose inputs. */}
}
async function readMetrics(redis,day){
 if(!/^20\d{2}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw Error('Invalid UTC day');
 const value=await redis.hGetAll(KEY+day);const counts={};
 for(const [key,count] of Object.entries(value)){if(!fieldsAllowed.has(key)||!/^\d{1,12}$/.test(count))throw Error('Invalid anonymous counts');counts[key]=Number(count);}
 return {day,counts};
}
module.exports={readMetrics,KEY,INCREMENT,metricFields,recordMetrics};
