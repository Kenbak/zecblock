'use strict';
// Operator-only cgroup v2 input, never a request parameter. Bounds the admission
// decision's age; it is not an allocator or a guarantee against a fast memory spike.
const {readFile}=require('node:fs/promises');
const {askError}=require('./ask-errors');
const CGROUP='/sys/fs/cgroup/system.slice/system-postgresql.slice/postgresql@16-main.service';
const TTL_MS=200,EVENT_HOLD_MS=30000;
// memory.events high also counts routine page-cache reclaim: a cgroup kept full
// by warm table cache crosses memory.high on almost any new read. Such a high
// event holds admission only while reclaimable cache is below this share of
// memory.high, i.e. when the kernel is reclaiming more than spare cache.
const CACHE_FLOOR=0.25;
function integer(value){if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw Error('Invalid counter');return Number(value);}
function eventCounters(raw){
 const entries=raw.trim().split('\n').map(line=>line.trim().split(/\s+/));
 const result=Object.fromEntries(entries.map(([key,value])=>[key,integer(value)]));
 for(const key of ['high','max','oom','oom_kill'])if(!Object.hasOwn(result,key))throw Error('Missing event');
 return result;
}
// The working set excludes inactive file cache, which the kernel reclaims on
// demand. Counting it would hold admission closed once table scans warm the
// cache, because reclaim keeps memory.current just under memory.high.
function inactiveFile(raw){
 const match=/^inactive_file (\d+)$/m.exec(raw);
 if(!match)throw Error('Missing inactive_file');return integer(match[1]);
}
function psi(raw){
 const values=[];
 for(const line of raw.trim().split('\n')){
  const match=/^(some|full) avg10=(\d+(?:\.\d+)?) avg60=\S+ avg300=\S+ total=\d+$/.exec(line);
  if(!match||Number(match[2])>100)throw Error('Invalid pressure');values.push(Number(match[2]));
 }
 if(values.length!==2||!/^some /.test(raw)||!raw.includes('\nfull '))throw Error('Missing pressure');return Math.max(...values);
}
function createMemoryPressure(env,{read=readFile,now=()=>performance.now()}={}){
 const path=env.ASK_POSTGRES_CGROUP_PATH;
 const extras=[env.ASK_POSTGRES_PRESSURE_PERCENT,env.ASK_POSTGRES_PSI_AVG10_PERCENT];
 if(!path&&!extras.some(value=>value!==undefined))return {configured:false,assertAvailable:async()=>{}};
 const percent=Number(env.ASK_POSTGRES_PRESSURE_PERCENT??85),psiPercent=Number(env.ASK_POSTGRES_PSI_AVG10_PERCENT??5);
 const valid=path===CGROUP&&Number.isInteger(percent)&&percent>=50&&percent<=90&&Number.isFinite(psiPercent)&&psiPercent>=0.1&&psiPercent<=5;
 let cachedAt=-Infinity,available=false,pending,previous,holdUntil=-Infinity;
 async function sample(){
  if(!valid)return false;
  try{
   const [current,high,max,events,pressure,stat]=await Promise.all(['memory.current','memory.high','memory.max','memory.events','memory.pressure','memory.stat'].map(name=>read(path+'/'+name,'utf8')));
   const cache=inactiveFile(stat),used=Math.max(0,integer(current.trim())-cache),soft=integer(high.trim()),hard=integer(max.trim()),counters=eventCounters(events);
   if(soft<=0||hard<=soft)return false;
   const cacheReclaim=cache>=soft*CACHE_FLOOR;
   if(previous&&['high','max','oom','oom_kill'].some(key=>counters[key]<previous[key]||counters[key]>previous[key]&&!(key==='high'&&cacheReclaim)))holdUntil=now()+EVENT_HOLD_MS;
   previous=counters;
   return used<soft*percent/100&&psi(pressure)<psiPercent&&now()>=holdUntil;
  }catch{return false;}
 }
 return {configured:true,async assertAvailable(){
  if(now()-cachedAt>=TTL_MS){
   pending ||= sample().then(value=>{available=value;cachedAt=now();}).finally(()=>{pending=undefined;});
   await pending;
  }
  if(!available)throw askError('resource');
 }};
}
module.exports={createMemoryPressure,CGROUP,TTL_MS,EVENT_HOLD_MS,CACHE_FLOOR};
