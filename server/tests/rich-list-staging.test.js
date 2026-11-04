'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const root=path.resolve(__dirname,'../..');
function load(file,imports={}){
 const filename=path.join(root,file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);
 m.require=name=>Object.hasOwn(imports,name)?imports[name]:base(name);
 const source=fs.readFileSync(filename,'utf8');
 m._compile(/\.tsx?$/.test(file)?ts.transpileModule(source,{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText:source,filename);return m.exports;
}
const api=load('lib/api-client.ts');
const server=load('lib/server-fetch.ts',{'@/lib/api-client':api,'./api-config':{getApiUrl:()=> 'https://api.invalid'}});
const envelope=data=>Response.json({data,meta:{requestId:'fixed-test',network:'mainnet'}});
const entry={rank:1,address:'t1fixture',balance:12,totalReceived:20,totalSent:8,txCount:3,firstSeen:null,lastSeen:null,label:null,category:null,description:null,verified:false,logoUrl:null};
const data={addresses:[entry],concentration:{top10:12,top100:12,totalTransparent:24,totalAddressed:24,directAddressless:0,top10Pct:50,top100Pct:50},pagination:{total:1,limit:100,offset:0,totalPages:1,page:1,hasNext:false,hasPrev:false}};
function environment(t,patch){const prior={};for(const[key,value]of Object.entries(patch)){prior[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}t.after(()=>{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});}
function quiet(t){const original={warn:console.warn,error:console.error};console.warn=()=>{};console.error=()=>{};t.after(()=>Object.assign(console,original));}

test('v1 JSON consumption stays inside unchanged SSR budgets, including stalled bodies',async()=>{
 assert.equal(server.SERVER_RENDER_FETCH_TIMEOUT_MS,1000);assert.equal(server.SERVER_RENDER_BUILD_FETCH_TIMEOUT_MS,10000);
 assert.deepEqual(await server.fetchApiDataWithDeadline('https://api.invalid/ranking',{},100,async()=>envelope(data)),data);
 let cancelled=false;const started=performance.now();
 await assert.rejects(server.fetchApiDataWithDeadline('https://api.invalid/ranking',{},20,async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))),error=>error.name==='TimeoutError');
 assert.equal(cancelled,true);assert.ok(performance.now()-started<300);
 await assert.rejects(server.fetchApiDataWithDeadline('https://api.invalid/ranking',{},20,async()=>new Promise(()=>{})),error=>error.name==='TimeoutError');
});

test('JSON body caps and caller cancellation cancel consumption without treating errors as data',async()=>{
 let cancelled=false;
 await assert.rejects(server.fetchApiDataWithDeadline('https://api.invalid/ranking',{},100,async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'1048577'}})),/too large/);
 assert.equal(cancelled,true);
 await assert.rejects(server.fetchApiDataWithDeadline('https://api.invalid/ranking',{},100,async()=>envelope('x'.repeat(1048576))),/too large/);
 await assert.rejects(server.fetchApiDataWithDeadline('https://api.invalid/ranking',{},100,async()=>new Response('{malformed')) ,error=>error.name==='ApiError');
 const controller=new AbortController(),failure=new DOMException('Caller stopped','AbortError');let calls=0;
 controller.abort(failure);
 await assert.rejects(server.fetchApiDataWithDeadline('https://api.invalid/ranking',{signal:controller.signal},100,async()=>{calls++;return envelope(data);}),error=>error===failure);
 assert.equal(calls,0);
 let bodyCancelled=false;const active=new AbortController();
 const pending=server.fetchApiDataWithDeadline('https://api.invalid/ranking',{signal:active.signal},100,async()=>new Response(new ReadableStream({cancel(){bodyCancelled=true;}})));
 await new Promise(setImmediate);active.abort(failure);await assert.rejects(pending,error=>error===failure);assert.equal(bodyCancelled,true);
});

function page(fetchData,retain){return load('app/rich-list/page.tsx',{'@/lib/api-config':{getApiUrl:()=> 'https://api.invalid'},'@/lib/server-fetch':{fetchApiDataWithDeadline:fetchData,isServerRenderDeadlineError:server.isServerRenderDeadlineError},'@/lib/isr-fallback':{retainLastGoodOrBuildFallback:retain},'./RichListClient':{__esModule:true,default:()=>null}}).default;}
test('only protected preview render deadlines become explicit unavailable props',async t=>{
 environment(t,{VERCEL_ENV:'preview',ASK_STAGING_ENABLED:'true'});quiet(t);let retained=0;
 const component=page(async()=>{throw new DOMException('Slow origin','TimeoutError');},()=>{retained++;assert.fail();});
 const output=await component();assert.equal(retained,0);assert.equal(output.props.initialUnavailable,true);
 assert.deepEqual(output.props.initialAddresses,[]);assert.equal(output.props.initialConcentration,null);assert.equal(output.props.initialPagination,null);
});

test('production and unexpected preview failures retain the last-good ISR error contract',async t=>{
 environment(t,{VERCEL_ENV:undefined,ASK_STAGING_ENABLED:undefined});quiet(t);const deadline=new DOMException('Slow origin','TimeoutError'),invalid=Error('Malformed payload');let retained=0;
 for(const[env,error]of [[{VERCEL_ENV:'production',ASK_STAGING_ENABLED:'true'},deadline],[{VERCEL_ENV:'preview',ASK_STAGING_ENABLED:'false'},deadline],[{VERCEL_ENV:'preview',ASK_STAGING_ENABLED:'true'},invalid]]){
  process.env.VERCEL_ENV=env.VERCEL_ENV;process.env.ASK_STAGING_ENABLED=env.ASK_STAGING_ENABLED;
  await assert.rejects(page(async()=>{throw error;},(_fallback,observed)=>{retained++;throw observed;})(),observed=>observed===error);
 }
 assert.equal(retained,3);
 delete process.env.VERCEL_ENV;delete process.env.ASK_STAGING_ENABLED;
});

test('healthy SSR retains source rows, nulls and ISR settings unchanged',async()=>{
 const calls=[];const output=await page(async(url,init)=>{calls.push({url,init});return data;},()=>assert.fail())();
 assert.equal(output.props.initialAddresses,data.addresses);assert.equal(output.props.initialConcentration,data.concentration);assert.equal(output.props.initialPagination,data.pagination);assert.equal(output.props.initialUnavailable,false);
 assert.equal(calls[0].url,'https://api.invalid/v1/addresses/rich-list?limit=100&offset=0');assert.deepEqual(calls[0].init,{next:{revalidate:60}});
});

const {createStagingDataProxy}=load('lib/staging-data-proxy.js',{'server-only':{}}),enabled={VERCEL_ENV:'preview',ASK_STAGING_ENABLED:'true'};
const incoming=(suffix,method='GET')=>new Request('https://preview.invalid/api/staging-data'+suffix,{method});
test('preview recovery admits only exact rich-list GET with existing bounded paging parameters',async()=>{
 const requests=[],proxy=createStagingDataProxy(enabled,async(url,init)=>{requests.push({url,init});return envelope(data);});
 for(const query of ['', '?limit=100&offset=0','?limit=500&offset=100000'])assert.equal((await proxy(incoming('/v1/addresses/rich-list'+query))).status,200);
 assert.equal(requests.length,3);assert.equal(requests[0].url.origin,'https://api.zecblock.com');assert.equal(requests[0].url.pathname,'/v1/addresses/rich-list');
 assert.deepEqual(requests[0].init.headers,{accept:'application/json'});assert.equal(requests[0].init.redirect,'error');assert.equal(requests[0].init.credentials,'omit');
 for(const query of ['?limit=0','?limit=501','?offset=100001','?offset=-1','?limit=1e2','?limit=01','?limit=','?limit=100&limit=100','?offset=0&offset=0','?url=https://elsewhere.invalid','?address=t1fixture'])assert.equal((await proxy(incoming('/v1/addresses/rich-list'+query))).status,400,query);
 for(const path of ['/v1/addresses','/v1/addresses/rich-list/extra','/api/rich-list'])assert.equal((await proxy(incoming(path))).status,404);
 assert.equal((await proxy(incoming('/v1/addresses/rich-list','POST'))).status,405);assert.equal(requests.length,3);
});

const Link=({children,href})=>React.createElement('a',{href},children);
const {PageHeader}=load('components/ui/SectionHeader.tsx',{'next/link':{__esModule:true,default:Link}});
const Wrapper=({children})=>React.createElement('div',null,children);
const Table=({rows,loading})=>React.createElement('table',{'aria-busy':loading},React.createElement('tbody',null,rows.map(row=>React.createElement('tr',{key:row.address},React.createElement('td',null,row.address)))));
function client(react=React){return load('app/rich-list/RichListClient.tsx',{react,'@/lib/api-client':api,'next/link':{__esModule:true,default:Link},'@/lib/api-config':{getApiUrl:()=>'/api/staging-data'},'@/components/network/TransparentSupplyBreakdown':{TransparentSupplyBreakdown:()=>null},'@/components/ui':{PageHeader,DataTable:Table,HashLink:()=>null},'@/components/ui/Card':{Card:Wrapper,CardBody:Wrapper},'@/components/ui/Badge':{Badge:Wrapper},'@/components/Pagination':{Pagination:()=>null},'@/components/ExportButton':{ExportButton:()=>null}}).default;}
test('unavailable raw SSR markup has one H1, an alert/retry, and no fabricated ranking or concentration',()=>{
 const html=renderToStaticMarkup(React.createElement(client(),{initialUnavailable:true}));
 assert.equal((html.match(/<h1\b/g)||[]).length,1);assert.match(html,/Top Addresses/);assert.match(html,/role="alert"/);assert.match(html,/Rich List Unavailable/);assert.match(html,/>Retry</);
 assert.doesNotMatch(html,/<table|Top 10 Concentration|0 addresses with balance|0\.0%/);
 const healthy=renderToStaticMarkup(React.createElement(client(),{initialAddresses:data.addresses,initialConcentration:data.concentration,initialPagination:data.pagination}));
 assert.equal((healthy.match(/<h1\b/g)||[]).length,1);assert.match(healthy,/t1fixture/);assert.match(healthy,/50\.0%/);
});

test('rich-list canonical/index policy and protected-preview noindex headers are unchanged',async t=>{
 for(const network of ['mainnet','testnet']){
  const seo=load('lib/seo.ts',{'@/lib/api-client':api,react:{cache:fn=>fn},'@/lib/network':{getConfiguredNetwork:()=>network},'@/lib/api-config':{getApiUrlForNetwork:()=> 'https://api.invalid'},'@/lib/server-fetch':server});
  const {metadata}=load('app/rich-list/layout.tsx',{'@/lib/seo':seo});
  assert.equal(metadata.alternates.canonical,network==='mainnet'?'https://zecblock.com/rich-list':'https://testnet.zecblock.com/rich-list');
  assert.equal(metadata.robots.index,network==='mainnet');assert.equal(metadata.robots.follow,true);assert.match(metadata.title,/Rich List/);assert.ok(metadata.description);
 }
 environment(t,{VERCEL_ENV:'preview',ASK_STAGING_ENABLED:'true'});const config=load('next.config.ts').default,headers=(await config.headers())[0].headers;
 assert.equal(headers.find(header=>header.key==='X-Robots-Tag').value,'noindex, follow');assert.match(headers.find(header=>header.key==='Cache-Control').value,/no-store/);
});

function harness(t,fetchRanking){
 const states=[],effects=[],timers=new Map();let cursor=0,pending=[],sequence=0;const original=global.fetch,originalSetTimeout=global.setTimeout,originalClearTimeout=global.clearTimeout;
 global.setTimeout=(run,delay)=>{const id=++sequence;timers.set(id,{run,delay});return id;};global.clearTimeout=id=>timers.delete(id);
 global.fetch=async(url,init)=>url.includes('/network/price')?envelope({price:null}):fetchRanking(url,init);
 const hooks={...React,
  useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},
  useRef(initial){const i=cursor++;return states[i]||(states[i]={current:initial});},
  useEffect(run,deps){const i=cursor++,previous=effects[i];if(!previous||deps.some((value,j)=>!Object.is(value,previous.deps[j])))pending.push(()=>{previous?.cleanup?.();effects[i]={deps,cleanup:run()};});},
 };
 const Component=client(hooks);
 t.after(()=>{for(const effect of effects)effect?.cleanup?.();global.fetch=original;global.setTimeout=originalSetTimeout;global.clearTimeout=originalClearTimeout;});
 return {render(props={initialUnavailable:true}){cursor=0;pending=[];const tree=Component(props);for(const run of pending)run();return tree;},flush:()=>new Promise(setImmediate),expire(){assert.equal(timers.size,1);const[id,timer]=[...timers][0];assert.equal(timer.delay,9000);timers.delete(id);timer.run();},close(){for(const effect of effects)effect?.cleanup?.();}};
}
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const hit=find(child,predicate);if(hit)return hit;}return null;}
test('Retry at page one starts a new bounded request and recovers the actual ranking',async t=>{
 let calls=0;const h=harness(t,async()=>{calls++;if(calls===1)throw Error('Unavailable');return envelope(data);});
 h.render();await h.flush();const failure=h.render();const retry=find(failure,node=>node.type==='button');assert.ok(retry);
 retry.props.onClick();h.render();await h.flush();const recovered=h.render();assert.equal(calls,2);
 const table=find(recovered,node=>node.type===Table);assert.deepEqual(table.props.rows,data.addresses);assert.equal(table.props.loading,false);
});
test('abandoned ranking requests abort without publishing stale failure state',async t=>{
 let signal;const h=harness(t,async(_url,init)=>{signal=init.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 h.render();assert.equal(signal.aborted,false);h.close();await h.flush();assert.equal(signal.aborted,true);assert.equal(find(h.render(),node=>node.type==='button'),null,'abandoned failure cannot replace the next view with an error');
});

test('a ranking timeout leaves explicit unavailable UI inside the existing bridge deadline',async t=>{
 let signal;const h=harness(t,async(_url,init)=>{signal=init.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 h.render();h.expire();await h.flush();assert.equal(signal.aborted,true);assert.equal(signal.reason.name,'TimeoutError');assert.ok(find(h.render(),node=>node.type==='button'));
});
