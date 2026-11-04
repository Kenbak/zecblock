'use strict';
// Dedicated private worker HTTP pool. Native fetch can open extra sockets as
// submissions transition to polls; SQL concurrency and admission stay separate.
const http=require('node:http');
const {askError}=require('./ask-errors');
function createWorkerTransport(){
 const agent=new http.Agent({keepAlive:true,maxSockets:6,maxTotalSockets:6,maxFreeSockets:1});let closed=false;
 return {
  async fetch(input,options){
   const url=new URL(input);
   if(closed||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||!['/query','/jobs/submit','/jobs/status','/jobs/cancel'].includes(url.pathname)||options?.method!=='POST'||options.redirect!=='error'||typeof options.body!=='string'||Buffer.byteLength(options.body)>16384)throw askError('source');
   options.signal?.throwIfAborted();
   return new Promise((resolve,reject)=>{
    const request=http.request(url,{method:'POST',headers:options.headers,agent,signal:options.signal},response=>{
     const chunks=[];let bytes=0;
     response.on('data',chunk=>{bytes+=chunk.length;if(bytes>270000){response.destroy(askError('source'));request.destroy();}else chunks.push(chunk);});
     response.once('error',reject);
     response.once('end',()=>{try{resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:{'Content-Type':response.headers['content-type']||'application/json'}}));}catch{reject(askError('source'));}});
    });
    request.once('error',reject);request.end(options.body);
   });
  },
  close(){closed=true;agent.destroy();},
 };
}
module.exports={createWorkerTransport};
