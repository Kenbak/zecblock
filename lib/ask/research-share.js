/* eslint-disable @typescript-eslint/no-require-imports */
const {z}=require('zod');
const {sqlQuerySchema,chartSchema,researchDocumentSchema,researchLibrarySchema}=require('./research-contract');
const {displaySQL}=require('./sql-display');
const PREFIX='#research=';
const MAX_LINK_BYTES=16384;
const item=z.object({title:z.string().trim().min(1).max(120),query:sqlQuerySchema,chart:chartSchema}).strict();
const shareSchema=z.object({format:z.literal('zecblock-research-link'),version:z.literal(1),kind:z.enum(['query','dashboard']),title:z.string().trim().min(1).max(120),queries:z.array(item).min(1).max(12)}).strict().refine(s=>s.kind==='dashboard'||s.queries.length===1);
function encode(text){return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
// Links carry drafts without results, so the readable form of the SQL is shared.
const readable=query=>({...query,sql:displaySQL(query.sql)});
function queryShare(input){const d=researchDocumentSchema.parse(input);return shareSchema.parse({format:'zecblock-research-link',version:1,kind:'query',title:d.title,queries:[{title:d.title,query:readable(d.query),chart:d.chart}]});}
function dashboardShare(input,id){const l=researchLibrarySchema.parse(input),b=l.dashboards.find(d=>d.id===id);if(!b)throw Error('Choose a saved dashboard first.');return shareSchema.parse({format:'zecblock-research-link',version:1,kind:'dashboard',title:b.title,queries:b.items.map(id=>{const d=l.documents.find(d=>d.id===id);return {title:d.title,query:readable(d.query),chart:d.chart};})});}
function researchLink(share,origin){
 const checked=shareSchema.parse(share),url=new URL('/zift',origin);
 if(!['https:','http:'].includes(url.protocol))throw Error('A website address is required.');
 const serialized=JSON.stringify(checked);
 if(new TextEncoder().encode(serialized).length>Math.floor((MAX_LINK_BYTES-PREFIX.length)*3/4))throw Error('This research is too large for a link. Download a research file instead.');
 const fragment=PREFIX+encode(serialized);
 if(fragment.length>MAX_LINK_BYTES)throw Error('This research is too large for a link. Download a research file instead.');
 url.hash=fragment;return url.href;
}
function readResearchLink(fragment){
 if(typeof fragment!=='string'||!fragment.startsWith(PREFIX))return null;
 if(fragment.length>MAX_LINK_BYTES)throw Error('This research link is too large. Ask for a research file instead.');
 const encoded=fragment.slice(PREFIX.length);
 if(!encoded||!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('This research link is invalid.');
 try {
  const bytes=Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(encode(text)!==encoded)throw Error('Noncanonical encoding');
  return shareSchema.parse(JSON.parse(text));
 }catch{throw Error('This research link is invalid. Ask for a new link or a research file.');}
}
function sharedLibrary(input,uuid,now){
 const share=shareSchema.parse(input),documents=share.queries.map(q=>researchDocumentSchema.parse({format:'zecblock-research',version:1,id:uuid(),title:q.title,notes:'',query:q.query,chart:q.chart,result:null,savedAt:now}));
 return researchLibrarySchema.parse({format:'zecblock-library',version:1,documents,dashboards:share.kind==='dashboard'?[{id:uuid(),title:share.title,items:documents.map(d=>d.id)}]:[]});
}
// Compact links: the same share JSON, deflate-raw compressed, under #r=.
// Roughly halves typical links. Decompression is capped so a crafted link
// cannot expand into a large payload; older #research= links still open.
const COMPACT='#r=';
const MAX_SHARE_JSON=64*1024;
const bytesToBase64=bytes=>{let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
async function pipe(bytes,stream,limit=Infinity){
 const reader=new Blob([bytes]).stream().pipeThrough(stream).getReader(),chunks=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('Too large');}chunks.push(value);}
 const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out;
}
async function compactResearchLink(share,origin){
 const checked=shareSchema.parse(share),url=new URL('/zift',origin);
 if(typeof CompressionStream!=='function')return researchLink(checked,origin);
 const fragment=COMPACT+bytesToBase64(await pipe(new TextEncoder().encode(JSON.stringify(checked)),new CompressionStream('deflate-raw')));
 if(fragment.length>MAX_LINK_BYTES)throw Error('This research is too large for a link. Download a research file instead.');
 url.hash=fragment;return url.href;
}
async function readAnyResearchLink(fragment){
 if(typeof fragment!=='string'||!fragment.startsWith(COMPACT))return readResearchLink(fragment);
 if(fragment.length>MAX_LINK_BYTES)throw Error('This research link is too large. Ask for a research file instead.');
 const encoded=fragment.slice(COMPACT.length);
 if(!encoded||!/^[A-Za-z0-9_-]+$/.test(encoded)||typeof DecompressionStream!=='function')throw Error('This research link is invalid.');
 try{
  const bytes=Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  const text=new TextDecoder('utf-8',{fatal:true}).decode(await pipe(bytes,new DecompressionStream('deflate-raw'),MAX_SHARE_JSON));
  return shareSchema.parse(JSON.parse(text));
 }catch{throw Error('This research link is invalid. Ask for a new link or a research file.');}
}
module.exports={MAX_LINK_BYTES,shareSchema,queryShare,dashboardShare,researchLink,readResearchLink,compactResearchLink,readAnyResearchLink,sharedLibrary};
