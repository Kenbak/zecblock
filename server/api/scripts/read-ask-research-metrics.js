'use strict';
// Operator CLI. Reads fixed aggregate day keys; no scans, questions or identifiers.
// Usage: read-ask-research-metrics.js [YYYY-MM-DD] | --days N (1-30) [--heavy]
const {createClient}=require('redis');
const {readMetrics,heavyShapes,checkDay}=require('../v1/lib/ask-research-metrics');
function daysFor(argv,now=Date.now()){
 const at=argv.indexOf('--days');
 if(at<0){const day=argv.find(a=>!a.startsWith('--'))||new Date(now).toISOString().slice(0,10);checkDay(day);return [day];}
 const count=Number(argv[at+1]);if(!Number.isInteger(count)||count<1||count>30)throw Error('Invalid day count');
 return Array.from({length:count},(_,i)=>new Date(now-i*86400000).toISOString().slice(0,10));
}
async function report(redis,argv,now){
 const days=[];for(const day of daysFor(argv,now))days.push(await readMetrics(redis,day));
 return argv.includes('--heavy')?{days:days.map(d=>d.day),overflow:days.reduce((n,d)=>n+d.overflow,0),shapes:heavyShapes(days)}:days.length===1?days[0]:{days};
}
async function main(){if(!process.env.ASK_ANALYTICS_REDIS_URL)throw Error('Metrics store unavailable');const redis=createClient({url:process.env.ASK_ANALYTICS_REDIS_URL});redis.on('error',()=>{});await redis.connect();try{console.log(JSON.stringify(await report(redis,process.argv.slice(2))));}finally{await redis.quit();}}
if(require.main===module)main().catch(()=>{console.error('Anonymous counts unavailable');process.exitCode=1;});
module.exports={daysFor,report};
