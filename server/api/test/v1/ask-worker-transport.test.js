'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{once}=require('node:events');
const {createWorkerTransport}=require('../../v1/lib/ask-worker-transport');
const options=()=>({method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(2000)});
async function server(t,handler){const instance=http.createServer(handler);instance.maxConnections=8;instance.listen(0,'127.0.0.1');await once(instance,'listening');t.after(()=>{instance.closeAllConnections();instance.close();});return{instance,url:`http://127.0.0.1:${instance.address().port}`};}
test('six transitions from submit to poll use at most six private sockets',async t=>{
 const {instance,url}=await server(t,(req,res)=>{req.resume();setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end('{}');},5);});let connections=0;instance.on('connection',()=>connections++);
 const transport=createWorkerTransport();t.after(()=>transport.close());
 await Promise.all(Array.from({length:6},async()=>{for(let step=0;step<5;step++){const response=await transport.fetch(url+(step?'/jobs/status':'/jobs/submit'),options());assert.equal(response.status,200);assert.deepEqual(await response.json(),{});}}));
 assert.ok(connections<=6);transport.close();await assert.rejects(transport.fetch(url+'/query',options()));
});
test('transport rejects redirects, nonworker paths and external targets before networking',async()=>{
 const transport=createWorkerTransport();try{for(const url of ['https://127.0.0.1:3015/query','http://primary:3015/query','http://127.0.0.1:3015/credentials','http://key@127.0.0.1:3015/query','http://127.0.0.1:3015/query?secret=x'])await assert.rejects(transport.fetch(url,options()));await assert.rejects(transport.fetch('http://127.0.0.1:3015/query',{...options(),redirect:'follow'}));}finally{transport.close();}
});
test('oversized responses and caller cancellation do not continue a private read',async t=>{
 const {url}=await server(t,(req,res)=>{req.resume();res.writeHead(200);res.write('x'.repeat(270001));});
 const transport=createWorkerTransport();t.after(()=>transport.close());await assert.rejects(transport.fetch(url+'/query',options()));
 const controller=new AbortController();controller.abort();await assert.rejects(transport.fetch(url+'/query',{...options(),signal:controller.signal}));
});
