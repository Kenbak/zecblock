'use strict';
const {createInternalClient}=require('./internal-client');
const {askError}=require('./ask-errors');
const PUBLIC_ORIGIN='https://api.zecblock.com';
function createStagingSource({fetchImpl=fetch}={}){
 const client=createInternalClient({internalBaseUrl:PUBLIC_ORIGIN,internalTimeoutMs:8000,maxResponseBytes:1024*1024,internalServiceKey:''},{fetchImpl:async(url,options)=>{
  const target=new URL(url);
  if(target.origin!==PUBLIC_ORIGIN||target.username||target.password||options.method!=='GET')throw askError('source');
  return fetchImpl(target,{...options,redirect:'error'});
 }});
 return {dispatch:async(method,path,options={})=>{
  if(method!=='GET'||options.body!==undefined||options.nodeToken||options.paymentAuth)throw askError('source');
  return client.dispatch('GET',path,{query:options.query,parentSignal:options.parentSignal,useServiceKey:false});
 }};
}
module.exports={createStagingSource,PUBLIC_ORIGIN};
