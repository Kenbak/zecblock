const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function load(file,imports={}) {
  const filename=path.resolve(__dirname,'../../'+file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);
  m.require=name=>Object.hasOwn(imports,name)?imports[name]:base(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,filename);return m.exports;
}
const api=load('lib/api-client.ts',{'@/lib/api-config':{getApiUrl:()=>''}});
const client=load('lib/ask/client.ts',{'@/lib/api-client':api,'./api-base':{getAskApiUrl:()=>'https://api.test/v1/ask'}});
const envelope=data=>({data,meta:{requestId:'r',network:'mainnet'}});
const scope={version:1,kind:'sql',datasets:['daily'],measures:['orchard_balance'],pools:['orchard'],window:{start:'2026-07-01',end:'2026-08-01'},period:null,grain:'month',metric:null,subject:'orchard_balance'};
// Splits the body into awkward chunks so lines arrive across reads.
function ndjson(lines,headers={}){
  const text=lines.map(line=>JSON.stringify(line)).join('\n')+'\n',parts=[text.slice(0,7),text.slice(7,40),text.slice(40)];
  return new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close();}}),{status:200,headers:{'content-type':'application/x-ndjson; charset=utf-8',...headers}});
}
function stub(t,response){
  const original=global.fetch,calls=[];
  global.fetch=async(url,options)=>{calls.push({url,options});return typeof response==='function'?response():response;};
  t.after(()=>{global.fetch=original;});return calls;
}
const ask=(options)=>client.askChat('and in August?','ask',null,'auto',['Orchard balance in July?'],'token',AbortSignal.timeout(5000),undefined,undefined,undefined,undefined,options);

test('progress stages reach the page, then the final envelope is checked as usual',async t=>{
  const calls=stub(t,ndjson([{type:'progress',stage:'planning'},{type:'progress',stage:'checking'},{type:'progress',stage:'unknown_stage'},{type:'progress',stage:'running'},{type:'result',status:200,body:envelope({answer:'Done.',sources:[],spec:null,locale:'en',mode:'ai',turnScope:scope})}],{'x-request-id':'req-1'}));
  const stages=[];
  const reply=await ask({turnScope:scope,onProgress:stage=>stages.push(stage)});
  assert.deepEqual(stages,['planning','checking','running']);
  assert.equal(reply.answer,'Done.');assert.deepEqual(reply.turnScope,scope);
  assert.equal(calls[0].options.headers.Accept,'application/x-ndjson, application/json');
  // The previous reply's scope goes back with the question.
  assert.deepEqual(JSON.parse(calls[0].options.body).turnScope,scope);
});

test('a problem line becomes the same ApiError as a plain problem response',async t=>{
  stub(t,ndjson([{type:'progress',stage:'planning'},{type:'problem',status:429,retryAfter:'60',body:{type:'https://docs.cipherscan.app/errors/rate-limited',title:'Too Many Requests',status:429,detail:'Limit',code:'ask-ai-calls-day'}}]));
  await assert.rejects(ask({onProgress:()=>{}}),error=>error instanceof api.ApiError&&error.status===429&&error.code==='ask-ai-calls-day'&&error.retryAfter==='60');
});

test('a stream that ends without a final line is an error, not a silent empty reply',async t=>{
  stub(t,ndjson([{type:'progress',stage:'planning'}]));
  await assert.rejects(ask({onProgress:()=>{}}),error=>error instanceof api.ApiError&&error.status===502);
});

test('without onProgress the request and response stay plain JSON',async t=>{
  const calls=stub(t,()=>Response.json(envelope({answer:'Hi',sources:[],spec:null,locale:'en',mode:'ai'})));
  assert.equal((await ask()).answer,'Hi');
  assert.equal(calls[0].options.headers.Accept,undefined);
  assert.equal(JSON.parse(calls[0].options.body).turnScope,undefined);
});

test('a JSON reply to a progress request (direct answers, staging proxy) is read normally',async t=>{
  stub(t,()=>Response.json(envelope({answer:'Guide',sources:[],spec:null,locale:'en',mode:'guided'})));
  const stages=[];
  assert.equal((await ask({onProgress:stage=>stages.push(stage)})).answer,'Guide');
  assert.deepEqual(stages,[]);
});
