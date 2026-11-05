const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
function load(file){const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,name=>load(path.resolve(path.dirname(file),name+'.ts')));return m.exports;}
const {CHART_CATALOG}=load('lib/chart-catalog.ts');
const sharing=load('lib/chart-sharing.ts');const {chartGeometry,chartMarkerIndices}=load('lib/chart-geometry.ts');
const chart=CHART_CATALOG.find(c=>c.id==='shielded-supply');
test('every catalog chart has one base sitemap URL and no range variants',()=>{
 const source=fs.readFileSync('lib/sitemaps.ts','utf8');
 for(const chart of CHART_CATALOG) assert.ok(source.includes(`'/charts/${chart.id}'`),chart.id);
 assert.doesNotMatch(source,/['"]\/charts\/[^'"\n]+\?/);
 assert.equal(sharing.findShareChart('../secrets'),undefined);
});
test('share selections are allowlisted, canonical path independent of filters',()=>{
 assert.equal(sharing.normalizeChartRange('https://evil.test'),'30d');
 assert.equal(sharing.chartSharePath('shielded-supply','1y'),'/charts/shielded-supply?range=1y');
 assert.equal(sharing.chartImagePath('/charts/supply?range=1y'),'/charts/supply/image?range=1y');
 const source=CHART_CATALOG.find(c=>c.id==='supply');
 assert.deepEqual(sharing.selectedChartSeries(source,'shielded,other').series.map(s=>s.key),['shielded']);
 assert.equal(sharing.selectedChartSeries(source,'other'),source);
});
test('shared charts default to 30 days while explicit all-history selections round-trip',()=>{
 for (const value of [undefined,null,'']) assert.equal(sharing.normalizeChartRange(value),'30d');
 assert.equal(sharing.chartSharePath('supply'),'/charts/supply?range=30d');
 for (const range of ['30d','all']) {
  const path=sharing.chartSharePath('supply',range,['shielded']);
  assert.equal(path,`/charts/supply?range=${range}&series=shielded`);
  for (const target of [path,sharing.chartImagePath(path)]) {
   const query=new URL(target,'https://zecblock.com').searchParams;
   assert.equal(sharing.normalizeChartRange(query.get('range')),range);
   assert.equal(query.get('series'),'shielded');
  }
 }
});
test('range filtering follows observations, retaining zero and missing values',()=>{
 const rows=[{x:Date.parse('2026-01-01'),shieldedSupplyPct:5},{x:Date.parse('2026-01-24'),shieldedSupplyPct:0},{x:Date.parse('2026-01-30'),shieldedSupplyPct:null}];
 assert.deepEqual(sharing.chartRangeRows(chart,rows,'7d'),rows.slice(1));
 assert.equal(sharing.chartRangeRows(chart,rows,'all'),rows);
});
test('line and area geometry leave missing points as gaps, with isolated observations visible',()=>{
 const rows=[{x:1,shieldedSupplyPct:0},{x:2,shieldedSupplyPct:null},{x:3,shieldedSupplyPct:5}];
 const g=chartGeometry(chart,rows);
 assert.equal(g.paths[0].segments.length,2);assert.equal(g.paths[0].segments[0][0].top,310);
 assert.equal(g.paths[0].segments[1].length,1);assert.equal(g.paths[0].line.includes('L'),false);
});
test('stacked incomplete rows do not look like a sudden collapse',()=>{
 const c=CHART_CATALOG.find(c=>c.id==='supply');
 const g=chartGeometry(c,[{x:1,shielded:5,transparent:10},{x:2,shielded:null,transparent:10}]);
 assert.equal(g.paths[0].segments[0].length,1);assert.equal(g.paths[1].segments[0].length,1);
});
test('diamond sampling retains the last valid and isolated observations without bridging gaps',()=>{
 const c={...chart,percent:false,series:[{key:'ironwood',label:'Ironwood',color:'ironwood',marker:'diamond',strokeWidth:3}]};
 const rows=Array.from({length:365},(_,i)=>({x:i,ironwood:i}));
 const indices=chartMarkerIndices(rows,'ironwood');
 assert.ok(indices.size<=25);assert.ok(indices.has(364));
 rows[6].ironwood=null;rows[8].ironwood=null;rows[364].ironwood=null;
 const sampled=chartMarkerIndices(rows,'ironwood');
 assert.ok(sampled.has(7),'isolated observations remain visible outside the regular stride');
 assert.ok(sampled.has(363),'the last valid observation is retained when trailing data is missing');
 assert.ok(!sampled.has(6));assert.ok(!sampled.has(8));assert.ok(!sampled.has(364));
 const g=chartGeometry(c,rows,300,120);
 assert.deepEqual(g.paths[0].markers.map(point=>point.index).sort((a,b)=>a-b),[...sampled].sort((a,b)=>a-b));
 assert.ok(g.paths[0].segments.some(segment=>segment.length===1 && segment[0].index===7));
 assert.ok(g.paths[0].markers.every(point=>point.top>=5 && point.top<=115),'full markers fit inside the plot');
 assert.equal(chartGeometry(c,[{x:1,ironwood:null}]).paths[0].markers.length,0);
});
test('exported diamond line styling follows selected pools and preserves isolated observations',()=>{
 const {renderToStaticMarkup}=require('react-dom/server');
 const {ChartExport}=loadRoute('components/charts/ChartExport.tsx');
 const ironwood={key:'ironwood',label:'Ironwood',color:'ironwood',marker:'diamond',strokeWidth:3};
 const sapling={key:'sapling',label:'Sapling',color:'sapling',strokeWidth:2};
 const data={chart:{...chart,percent:false,series:[ironwood,sapling]},rows:[{x:1,ironwood:100,sapling:3},{x:2,ironwood:null,sapling:2},{x:3,ironwood:0,sapling:1}]};
 const markup=renderToStaticMarkup(ChartExport({data}));
 assert.equal((markup.match(/data-marker="diamond"/g)||[]).length,2,'both isolated points are diamonds');
 assert.match(markup,/stroke-width="3"/);assert.match(markup,/stroke-width="2"/);
 assert.match(markup,/data-marker="diamond"[^>]+fill="#0B0C0E"/);
 const selected={...data,chart:{...data.chart,series:[sapling]}};
 assert.doesNotMatch(renderToStaticMarkup(ChartExport({data:selected})),/data-marker="diamond"/);
 assert.equal(chartGeometry(selected.chart,selected.rows).max,3,'hidden pool data cannot inflate the axis');
 const missing={...data,rows:[{x:1,ironwood:null,sapling:3}]};
 assert.doesNotMatch(renderToStaticMarkup(ChartExport({data:missing})),/data-marker="diamond"/);
});
test('exported summaries retain selected pool totals and the complementary transaction share',()=>{
 const {renderToStaticMarkup}=require('react-dom/server');
 const {ChartExport}=loadRoute('components/charts/ChartExport.tsx');
 const ironwood={key:'ironwood',label:'Ironwood',color:'ironwood',marker:'diamond',summary:{primary:'119,492',secondary:'54.21%'}};
 const sapling={key:'sapling',label:'Sapling',color:'sapling',summary:{primary:'6,355',secondary:'2.88%'}};
 const data={chart:{...chart,percent:false,unit:'Transactions',series:[ironwood,sapling]},rows:[{x:1,ironwood:100,sapling:3}]};
 const markup=renderToStaticMarkup(ChartExport({data}));
 for(const value of ['119,492','(54.21%)','6,355','(2.88%)']) assert.ok(markup.includes(value),value);
 assert.equal((markup.match(/data-series-summary=/g)||[]).length,2);
 assert.match(markup,/<svg width="1020" height="294"/);
 const selected={...data,chart:{...data.chart,series:[sapling]}};
 const selectedMarkup=renderToStaticMarkup(ChartExport({data:selected}));
 assert.ok(selectedMarkup.includes('6,355'));assert.ok(selectedMarkup.includes('(2.88%)'));
 assert.doesNotMatch(selectedMarkup,/119,492|54\.21%|data-marker="diamond"/);
 const percentage={...data,chart:{...data.chart,unit:'%',series:[{...ironwood,summary:{primary:'54.21%',secondary:'119,492 txs'}}]}};
 const percentageMarkup=renderToStaticMarkup(ChartExport({data:percentage}));
 assert.ok(percentageMarkup.includes('54.21%'));assert.ok(percentageMarkup.includes('(119,492 txs)'));
});
test('ordinary exports keep their compact legend and unavailable summaries remain unavailable',()=>{
 const {renderToStaticMarkup}=require('react-dom/server');
 const {ChartExport}=loadRoute('components/charts/ChartExport.tsx');
 const ordinary=renderToStaticMarkup(ChartExport({data:{chart,rows:[{x:1,shieldedSupplyPct:5}]}}));
 assert.doesNotMatch(ordinary,/data-series-summary=/);assert.match(ordinary,/<svg width="1020" height="310"/);
 const missing={...chart,series:[{...chart.series[0],summary:{primary:'—',secondary:'—'}}]};
 const unavailable=renderToStaticMarkup(ChartExport({data:{chart:missing,rows:[]}}));
 assert.match(unavailable,/data-series-summary="shieldedSupplyPct"/);
 assert.ok(unavailable.includes('—'));assert.ok(unavailable.includes('Observations unavailable'));
});
test('native social-image rendering produces real PNGs for ordinary, delayed and summary charts',async()=>{
 const {ImageResponse}=require('next/og');
 const {createElement}=require('react');
 const {ChartExport}=loadRoute('components/charts/ChartExport.tsx');
 const ordinary=CHART_CATALOG.find(chart=>chart.id==='network-hashrate');
 const summary={...chart,series:[{...chart.series[0],summary:{primary:'56%',secondary:'123 ZEC'}}]};
 const font=fs.readFileSync('public/fonts/chart-export/Geist-Regular.ttf');
 const logo=`data:image/png;base64,${fs.readFileSync('public/brand/zecblock-logotype.png').toString('base64')}`;
 for(const [source,asOf] of [[ordinary,undefined],[ordinary,'API snapshot · 2026-10-27 12:00:00 UTC · refresh delayed'],[summary,undefined]]){
  const data={chart:source,rows:[{x:Date.parse('2026-10-26'),[source.series[0].key]:12},{x:Date.parse('2026-10-27'),[source.series[0].key]:13}],network:'mainnet',asOf};
  const response=new ImageResponse(createElement(ChartExport,{data,logo}),{width:1200,height:675,fonts:[{name:'ZecBlock Export',data:font,weight:400,style:'normal'}]});
  const png=Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),675);
 }
});
test('CSV retains numeric precision, quotes values, distinguishes missing, neutralizes formulas',()=>{
 const c={...chart,axis:'category',series:[{key:'value',label:'Value',color:'gold'}]};
 const csv=sharing.chartCsv({chart:c,rows:[{x:'=HYPERLINK("evil")',value:0},{x:'missing',value:null},{x:'exact',value:.00000001}]});
 assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));assert.ok(csv.includes('"missing",""'));assert.ok(csv.includes('"exact","1e-8"'));assert.ok(csv.includes('"0"'));
});
test('turnstile all-history requests are stable and include the entire retained series',()=>{
 const chart=sharing.findShareChart('turnstile');
 assert.equal(sharing.chartEndpoint(chart),'/v1/shielded-pools/turnstile?since=2016-10-28');
});

test('category snapshot labels use the source timestamp, never the current time',()=>{
 assert.equal(sharing.chartSnapshotLabel({generatedAt:'2026-01-01T12:34:56.789Z'}),'Source snapshot · 2026-01-01 12:34:56 UTC');
 assert.equal(sharing.chartSnapshotLabel({generatedAt:'invalid'}),undefined);
 assert.equal(sharing.chartSource(CHART_CATALOG.find(c=>c.id==='search-interest')),'Google Trends CSV · imported by ZecBlock');
});

function loadRoute(file, overrides={}) {
 const {createRequire}=require('node:module');const filename=path.resolve(file);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,name=>{
  if(name in overrides)return overrides[name];
  if(name==='server-only')return {};
  if(name.startsWith('@/components/')||name==='../ChartsClient')return new Proxy({},{get:()=>()=>null});
  if(name.startsWith('@/')||name.startsWith('.')){const base=name.startsWith('@/')?path.resolve(name.slice(2)):path.resolve(path.dirname(filename),name);return loadRoute(base+(fs.existsSync(base+'.ts')?'.ts':'.tsx'),overrides);}
  return createRequire(filename)(name);
 });return m.exports;
}
test('range and series social URLs retain the variant while canonical and robots follow network policy',async()=>{
 const previous=process.env.NEXT_PUBLIC_NETWORK;
 try {
  for(const network of ['mainnet','testnet','crosslink-testnet']) {
   process.env.NEXT_PUBLIC_NETWORK=network;
   const page=loadRoute('app/charts/[slug]/page.tsx',{'@/lib/chart-share-server':{loadShareChart:async()=>null}});
   const metadata=await page.generateMetadata({params:Promise.resolve({slug:'supply'}),searchParams:Promise.resolve({range:'1y',series:'shielded'})});
   assert.ok(String(metadata.alternates.canonical).endsWith('/charts/supply'));assert.equal(String(metadata.alternates.canonical).includes('?'),false);
   assert.ok(metadata.openGraph.images[0].url.endsWith('/charts/supply/image?range=1y&series=shielded'));
   assert.equal(metadata.robots.index,network==='mainnet');assert.equal(metadata.robots.follow,true);
   assert.equal(metadata.openGraph.images[0].height,675);
  }
 } finally {if(previous===undefined)delete process.env.NEXT_PUBLIC_NETWORK;else process.env.NEXT_PUBLIC_NETWORK=previous;}
});
test('image route returns real 404 and uncached 503 for invalid or unavailable charts',async()=>{
 let waitMs;
 const route=loadRoute('app/charts/[slug]/image/route.tsx',{'next/og':{ImageResponse:class{}},'@/lib/chart-share-server':{loadShareChart:async(_chart,wait)=>{waitMs=wait;return null;}}});
 const unknown=await route.GET(new Request('http://localhost/charts/unknown/image'),{params:Promise.resolve({slug:'unknown'})});assert.equal(unknown.status,404);
 const unavailable=await route.GET(new Request('http://localhost/charts/supply/image'),{params:Promise.resolve({slug:'supply'})});assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('Cache-Control'),'no-store');
 assert.equal(waitMs,10_000,'social crawlers use the full bounded refresh without delaying the page');
});
test('unknown chart pages return 404 before a loading boundary can stream',async()=>{
 const vm=require('node:vm');const exports={};const {NextRequest,NextResponse}=require('next/server');
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('proxy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL,process:{env:{NODE_ENV:'development'}},setInterval:()=>{},require:name=>({'next/server':{NextResponse},'./lib/chart-catalog':{CHART_CATALOG},'./lib/governance-request':{},'./lib/network':{}})[name]});
 assert.ok(exports.config.matcher.includes('/charts/:slug'));
 const missing=await exports.proxy(new NextRequest('http://localhost/charts/not-a-chart'));
 assert.equal(missing.status,404);assert.equal(missing.headers.get('X-Robots-Tag'),'noindex, follow');
 for(const chart of CHART_CATALOG)assert.equal((await exports.proxy(new NextRequest('http://localhost/charts/'+chart.id))).status,200);
});


test('all shared chart titles include Zcash once without changing catalog labels', async () => {
 const page=loadRoute('app/charts/[slug]/page.tsx',{'@/lib/chart-share-server':{loadShareChart:async()=>null}});
 for (const chart of CHART_CATALOG) {
  const title=sharing.chartPublicTitle(chart);
  assert.equal((title.match(/Zcash/gi)||[]).length,1,chart.id);
  assert.ok(title.includes(chart.title));
  const metadata=await page.generateMetadata({params:Promise.resolve({slug:chart.id}),searchParams:Promise.resolve({range:'1y'})});
  assert.ok(String(metadata.title).includes(title));
  assert.match(metadata.openGraph.images[0].alt,/Zcash/i);
  assert.ok(sharing.chartCsv({chart,rows:[]}).includes(title));
 }
});

test('proxy recovery pages retain HTTP semantics and current branding', async () => {
 const vm=require('node:vm'); const exports={}; const {NextRequest,NextResponse}=require('next/server');
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('proxy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
  exports,URL,process:{env:{NODE_ENV:'development'}},setInterval:()=>{},
  require:name=>({'next/server':{NextResponse},'./lib/chart-catalog':{CHART_CATALOG},'./lib/network':{getConfiguredNetwork:()=> 'mainnet'},'./lib/governance-request':{resolveGovernanceRequest:async path=>({status:path.endsWith('/unavailable')?503:404})}})[name]
 });
 for (const [path,status] of [['/block/not-a-block',404],['/charts/not-a-chart',404],['/governance/unknown',404],['/governance/unavailable',503]]) {
  const result=await exports.proxy(new NextRequest('http://localhost'+path));
  assert.equal(result.status,status); assert.equal(result.headers.get('Cache-Control'),'no-store');
  assert.equal(result.headers.get('X-Robots-Tag'),'noindex, follow');
  const html=await result.text(); assert.match(html,/ZecBlock/); assert.doesNotMatch(html,/CipherScan/i);
  assert.equal((html.match(/<h1>/g)||[]).length,1); assert.match(html,/name="viewport"/);
  if(status===503)assert.equal(result.headers.get('Retry-After'),'60');
 }
});
