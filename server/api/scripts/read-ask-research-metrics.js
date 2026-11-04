'use strict';
// Operator CLI. Reads one fixed aggregate key; no scans, questions or identifiers.
const {createClient}=require('redis');
const {readMetrics}=require('../v1/lib/ask-research-metrics');
async function main(){const day=process.argv[2]||new Date().toISOString().slice(0,10);if(!process.env.ASK_ANALYTICS_REDIS_URL)throw Error('Metrics store unavailable');const redis=createClient({url:process.env.ASK_ANALYTICS_REDIS_URL});redis.on('error',()=>{});await redis.connect();try{console.log(JSON.stringify(await readMetrics(redis,day)));}finally{await redis.quit();}}
if(require.main===module)main().catch(()=>{console.error('Anonymous counts unavailable');process.exitCode=1;});
