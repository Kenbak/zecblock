'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {options,percentile,run}=require('../../scripts/check-ask-research-readiness');
const env={ASK_ANALYTICS_SERVICE_KEY:'x'.repeat(32)};
test('readiness workload is bounded, fixed and loopback only',()=>{
 assert.equal(options(['--concurrency=6','--rounds=2','annual_activity'],env).cases.length,1);
 for(const args of [['--concurrency=7'],['--rounds=3'],['DROP TABLE blocks'],['annual_activity','annual_activity']])assert.throws(()=>options(args,env));
 for(const url of ['https://127.0.0.1','http://primary','http://user:secret@localhost','http://localhost/x','http://localhost/?key=secret'])assert.throws(()=>options([],{...env,ASK_ANALYTICS_URL:url}));
 assert.throws(()=>options([],{}));assert.equal(percentile([20,10,30],.95),30);assert.equal(percentile([], .5),null);
});
test('concurrent fixed cases report timing/counts without retained SQL, rows or bearer tokens',async()=>{
 const emitted=[];let submissions=0,active=0,peak=0;
 const request=async(url,init)=>{
  const body=JSON.parse(init.body);assert.equal(init.redirect,'error');
  if(url.pathname==='/jobs/submit'){submissions++;active++;peak=Math.max(peak,active);return{ok:true,json:async()=>({id:'00000000-0000-4000-8000-'+String(submissions).padStart(12,'0'),token:'b'.repeat(64)})};}
  await new Promise(resolve=>setImmediate(resolve));active--;
  return{ok:true,json:async()=>({id:body.id,state:'succeeded',createdAt:'2026-10-12T00:00:00Z',startedAt:'2026-10-12T00:00:01Z',finishedAt:'2026-10-12T00:00:02Z',queuePosition:0,maxRunSeconds:30,error:null,result:{query:{version:3,sql:'SELECT height FROM blocks',limit:100},columns:[{key:'c0',label:'height',type:'number'}],rows:[['123456789']],truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-12T00:00:02Z',indexedThrough:'2026-10-12T00:00:00Z',coverage:'verified canonical records',units:'exact'}})};
 };
 const summary=await run(['--concurrency=2','--rounds=2','annual_activity','pool_closing'],env,{request,emit:r=>emitted.push(r)});
 assert.equal(summary.samples,4);assert.equal(summary.failed,0);assert.equal(peak,2);assert.equal(summary.executionP95Ms,1000);
 const output=JSON.stringify(emitted);for(const forbidden of ['SELECT','123456789','b'.repeat(64),'fingerprint','secret'])assert.ok(!output.includes(forbidden));
});
test('readiness refuses quota and never hides a failed dataset as empty success',async()=>{
 const emitted=[];const request=async()=>({ok:false,status:429});
 const summary=await run(['annual_activity'],env,{request,emit:r=>emitted.push(r)});assert.equal(summary.failed,1);assert.equal(emitted[0].error,'quota');
});
