'use strict';
const {researchIds}=require('../../../../lib/ask/research-catalogue');
const {shapeFeatures,spans}=require('./ask-research-shape');
const KEY='ask:{mainnet}:research-counts:v1:';
// Joint day counts keyed only by fixed category tokens, so heavy shapes can be
// learned without storing questions, SQL, literals, aliases or identifiers.
const SHAPE_KEY='ask:{mainnet}:research-shapes:v1:';
const MAX_SHAPES=1000;
const outcomeList=['success','timeout','resource','query','source','dataset','quota','unavailable','cancelled'];
const durations=['under_1s','1_5s','5_15s','15_30s','30s_plus'];
const modes=['quick','queued'];
const featureList=['cte','group','join','window',...shapeFeatures.filter(f=>!['cte','group','join','window'].includes(f))];
const fieldsAllowed=new Set(['requests',...outcomeList.map(x=>'outcome:'+x),...durations.map(x=>'duration:'+x),...researchIds.map(x=>'dataset:'+x),...featureList.map(x=>'feature:'+x),...spans.map(x=>'span:'+x),...modes.map(x=>'mode:'+x)]);
const INCREMENT="for i=1,#ARGV do redis.call('HINCRBY',KEYS[1],ARGV[i],1) end;redis.call('EXPIRE',KEYS[1],2592000);return 1";
// The joint hash is capped: an unseen combination past the cap only counts as overflow.
const INCREMENT_SHAPE="for i=3,#ARGV do redis.call('HINCRBY',KEYS[1],ARGV[i],1) end;if redis.call('HEXISTS',KEYS[2],ARGV[2])==1 or redis.call('HLEN',KEYS[2])<tonumber(ARGV[1]) then redis.call('HINCRBY',KEYS[2],ARGV[2],1) else redis.call('HINCRBY',KEYS[2],'overflow',1) end;redis.call('EXPIRE',KEYS[1],2592000);redis.call('EXPIRE',KEYS[2],2592000);return 1";
const outcomes=new Set(outcomeList);
function durationBucket(elapsedMs){return elapsedMs<1000?'under_1s':elapsedMs<5000?'1_5s':elapsedMs<15000?'5_15s':elapsedMs<30000?'15_30s':'30s_plus';}
function metricFields({outcome,datasets=[],features=[],elapsedMs,span,mode}={}){
 if(!outcomes.has(outcome)||!Number.isFinite(elapsedMs)||elapsedMs<0||!Array.isArray(datasets)||datasets.some(d=>!researchIds.includes(d))||!Array.isArray(features)||features.some(f=>!featureList.includes(f))||span!==undefined&&!spans.includes(span)||mode!==undefined&&!modes.includes(mode))throw Error('Invalid anonymous metric');
 return ['requests','outcome:'+outcome,'duration:'+durationBucket(elapsedMs),...[...new Set(datasets)].sort().map(d=>'dataset:'+d),...[...new Set(features)].sort().map(f=>'feature:'+f),...(span?['span:'+span]:[]),...(mode?['mode:'+mode]:[])];
}
// datasets|features|span|mode|outcome|duration; '+' joins sorted fixed tokens.
function shapeField(record){
 metricFields(record);
 if(!record.span||!record.mode)throw Error('Invalid anonymous metric');
 const join=(values,empty)=>[...new Set(values)].sort().join('+')||empty;
 return [join(record.datasets||[],'none'),join(record.features||[],'plain'),record.span,record.mode,record.outcome,durationBucket(record.elapsedMs)].join('|');
}
function parseShape(field){
 const parts=field.split('|');if(parts.length!==6)return null;
 const [datasets,features,span,mode,outcome,duration]=parts,list=(value,empty,allowed)=>value===empty?[]:value.split('+').every((x,i,a)=>allowed.includes(x)&&(i===0||a[i-1]<x))?value.split('+'):null;
 const d=list(datasets,'none',researchIds),f=list(features,'plain',featureList);
 if(!d||!f||!spans.includes(span)||!modes.includes(mode)||!outcomes.has(outcome)||!durations.includes(duration))return null;
 return {datasets:d,features:f,span,mode,outcome,duration};
}
async function recordMetrics(redis,record,now=Date.now()){
 try{if(!redis?.isReady)return;const fields=metricFields(record),day=new Date(now).toISOString().slice(0,10);let timer;
  const call=record.span&&record.mode?redis.eval(INCREMENT_SHAPE,{keys:[KEY+day,SHAPE_KEY+day],arguments:[String(MAX_SHAPES),shapeField(record),...fields]}):redis.eval(INCREMENT,{keys:[KEY+day],arguments:fields});
  await Promise.race([call,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Metric timeout')),250);timer.unref();})]).finally(()=>clearTimeout(timer));}catch{/* Metrics never grant admission, block results or expose inputs. */}
}
function checkDay(day){if(typeof day!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw Error('Invalid UTC day');}
async function readMetrics(redis,day){
 checkDay(day);
 const [value,joint]=await Promise.all([redis.hGetAll(KEY+day),redis.hGetAll(SHAPE_KEY+day)]);const counts={},shapes=[];let overflow=0;
 for(const [key,count] of Object.entries(value)){if(!fieldsAllowed.has(key)||!/^\d{1,12}$/.test(count))throw Error('Invalid anonymous counts');counts[key]=Number(count);}
 for(const [key,count] of Object.entries(joint||{})){
  if(!/^\d{1,12}$/.test(count))throw Error('Invalid anonymous counts');
  if(key==='overflow'){overflow=Number(count);continue;}
  const shape=parseShape(key);if(!shape)throw Error('Invalid anonymous counts');shapes.push({...shape,count:Number(count)});
 }
 return {day,counts,shapes,overflow};
}
// Ranks query shapes by budget failures (timeout/resource) across days. Groups
// ignore outcome and duration so one row shows how often a shape exceeds the
// worker budget and how long it runs.
function heavyShapes(days){
 const groups=new Map();
 for(const {shapes=[]} of days)for(const s of shapes){
  const key=[s.datasets.join('+'),s.features.join('+'),s.span,s.mode].join('|');
  const g=groups.get(key)||{datasets:s.datasets,features:s.features,span:s.span,mode:s.mode,requests:0,heavy:0,outcomes:{},durations:{}};
  g.requests+=s.count;if(['timeout','resource'].includes(s.outcome))g.heavy+=s.count;
  g.outcomes[s.outcome]=(g.outcomes[s.outcome]||0)+s.count;g.durations[s.duration]=(g.durations[s.duration]||0)+s.count;groups.set(key,g);
 }
 return [...groups.values()].map(g=>({...g,heavyRate:Math.round(1000*g.heavy/g.requests)/1000})).sort((a,b)=>b.heavy-a.heavy||b.heavyRate-a.heavyRate||b.requests-a.requests);
}
module.exports={readMetrics,heavyShapes,KEY,SHAPE_KEY,MAX_SHAPES,INCREMENT,INCREMENT_SHAPE,metricFields,shapeField,parseShape,recordMetrics,checkDay};
