'use strict';
// Operator CLI: node read-ask-feedback.js [YYYY-MM-DD] [--shared]
// Uses the API's Redis (REDIS_HOST/REDIS_PORT, as server.js), where ratings
// are written. Reads one day's fixed answer-rating keys; no scans. Without --shared it
// prints counts only. --shared adds the answers visitors chose to share.
const {createClient}=require('redis');
const {readFeedback}=require('../v1/lib/ask-feedback');
async function main(){const args=process.argv.slice(2),shared=args.includes('--shared'),day=args.find(arg=>arg!=='--shared')||new Date().toISOString().slice(0,10);const redis=createClient({socket:{host:process.env.REDIS_HOST||'127.0.0.1',port:parseInt(process.env.REDIS_PORT||'6379')}});redis.on('error',()=>{});await redis.connect();try{console.log(JSON.stringify(await readFeedback(redis,day,{shared}),null,1));}finally{await redis.quit();}}
if(require.main===module)main().catch(()=>{console.error('Answer feedback unavailable');process.exitCode=1;});
