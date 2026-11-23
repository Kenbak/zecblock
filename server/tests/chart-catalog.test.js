const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
function load(file){const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,name=>load(path.resolve(path.dirname(file),name+'.ts')));return m.exports;}
const {CHART_CATALOG,catalogRows,latestCatalogObservation,formatCatalogValue}=load('lib/chart-catalog.ts');const chart=id=>CHART_CATALOG.find(c=>c.id===id);
test('pool balances require verified balance history; flow responses cannot become pool balances',()=>{
 assert.deepEqual(catalogRows(chart('pool-balances'),{points:[{date:'2026-01-01',shield:50}]}),[]);
 const rows=catalogRows(chart('pool-balances'),{hasVerifiedPerPoolBreakdown:true,points:[{date:'2026-01-01',orchard:100,ironwood:0,sapling:null}]});
 assert.equal(rows[0].orchard,null);assert.equal(rows[0].ironwood,null);assert.equal(rows[0].sapling,null);
});
test('gaps are not zero; dates sort chronologically and retain elapsed time',()=>{
 const rows=catalogRows(chart('network-hashrate'),{points:[{date:'2026-01-05',hashrate:25e9},{date:'2026-01-01',hashrate:null}]});
 assert.equal(rows.at(-1).hashrate,25);assert.equal(rows[0].hashrate,null);assert.equal(rows.at(-1).x-rows[0].x,4*86400000);assert.equal(rows[1].hashrate,null);assert.equal(rows[1].x-rows[0].x,86400000);
 assert.deepEqual(catalogRows(chart('network-hashrate'),{success:false,points:[{date:'2026-01-01',hashrate:1}]}),[]);
});
test('fee percentiles convert zatoshis to mZEC, rewards convert zatoshis to ZEC',()=>{
 assert.equal(catalogRows(chart('fees'),{daily:[{date:'2026-01-01',median:10000}]})[0].median,.1);
 assert.equal(catalogRows(chart('miner-rewards'),{series:[{date:'2026-01-01',earnedZat:'156250000'}]})[0].earnedZat,1.5625);
 assert.notEqual(formatCatalogValue(.00001,'ZEC',true),'0');
});
test('SOPR requires transparent-spend authority, never the legacy proxy',()=>{
 const rows=catalogRows(chart('sopr'),{points:[{date:'2026-01-01',sopr:3},{date:'2026-01-02',sopr:1.1,soprSource:'transparent_spends'}]});
 assert.equal(rows[0].sopr,null);assert.equal(rows[1].sopr,1.1);
});
test('block intervals preserve negative values, outliers and missing predecessors',()=>{
 const rows=catalogRows(chart('block-time'),{blocks:[{height:1,timestamp:1000},{height:2,timestamp:900},{height:3,timestamp:1800},{height:5,timestamp:1900}]});
 assert.deepEqual(rows.map(r=>r.seconds),[-100,900,null]);
});
test('search attention excludes incomplete weeks and never combines snapshots',()=>{
 const rows=catalogRows(chart('search-interest'),{snapshot:{points:[{date:'2026-01-01',value:50,partial:false},{date:'2026-01-08',value:70,partial:false},{date:'2026-01-15',value:100,partial:true}]}});
 assert.equal(rows.length,2);assert.equal(rows[0].value,50);assert.equal(rows[1].value,70);
});
test('leading pool shares are fractions; derived rows do not mutate shared responses',()=>{
 const response={series:[{date:'2026-01-01',pools:{A:.3,B:.7}},{date:'2026-01-02',pools:{}}]};
 const rows=catalogRows(chart('pool-share'),response);assert.equal(rows[0].largestShare,70);assert.equal(rows[1].largestShare,null);assert.equal(response.series[0].largestShare,undefined);
});
test('catalogue identifiers are unique and all entries have source contracts',()=>{
 assert.equal(new Set(CHART_CATALOG.map(c=>c.id)).size,CHART_CATALOG.length);
 for(const c of CHART_CATALOG){assert.ok(c.endpoint.startsWith('/v1/'));assert.ok(c.unit&&c.description&&c.window&&c.series.length);}
});

test('partial final pool points are gaps instead of a false supply crash; real declines remain',()=>{
 const rows=catalogRows(chart('pool-balances'),{hasVerifiedPerPoolBreakdown:true,points:[
 {date:'2026-09-25',sprout:1,sapling:2,orchard:3,ironwood:94,shielded:100,hasPoolBreakdown:true},
 {date:'2026-09-26',sprout:1,sapling:2,orchard:3,ironwood:90,shielded:96,hasPoolBreakdown:true},
 {date:'2026-09-27',sprout:1,sapling:2,orchard:3,ironwood:0,shielded:96,hasPoolBreakdown:true}
 ]});
 assert.equal(rows[0].ironwood,94);assert.equal(rows[1].ironwood,90);
 assert.equal(rows[2].ironwood,null);assert.equal(rows[2].orchard,null);
});

test('latest observation ignores null-only dates and follows the displayed series',()=>{
 const rows=[{x:1,sopr:0,other:null},{x:2,sopr:null,other:10},{x:3,sopr:null,other:null}];
 assert.equal(latestCatalogObservation(rows,chart('sopr').series).x,1);
 assert.equal(latestCatalogObservation(rows,[{key:'other'}]).x,2);
 assert.equal(latestCatalogObservation(rows,[{key:'missing'}]),undefined);
});
test('compact chart payloads keep every field each chart reads and drop the rest',()=>{
 const {compactCatalogPayload}=load('lib/chart-catalog.ts');
 for(const c of CHART_CATALOG){
  const row=i=>{const r={unused:'x'.repeat(50),[c.x]:c.axis==='height'?1000+i:c.axis==='category'?`cat-${i}`:`2026-01-0${i+1}`,shielded:6,hasPoolBreakdown:true,pools:{a:.4,b:.2},partial:false,soprSource:'transparent_spends',height:i+1,timestamp:1000+i*75};for(const s of c.series)r[s.field??s.key]=i+1;if(c.requireVerifiedPools){for(const s of c.series)r[s.key]=1.5;}return r;};
  const rows=[row(0),row(1),row(2)];
  const path=c.rows.split('.');let payload={success:true,generatedAt:'2026-01-03T00:00:00Z',hasVerifiedPerPoolBreakdown:true,extra:{big:[1,2,3]}};
  let node=payload;path.forEach((k,i)=>{node[k]=i===path.length-1?rows:{other:[1,2]};node=node[k];});
  const compact=compactCatalogPayload(c,payload);
  assert.deepEqual(catalogRows(c,compact),catalogRows(c,payload),c.id);
  assert.ok(JSON.stringify(compact).length<JSON.stringify(payload).length,c.id);
  assert.ok(!JSON.stringify(compact).includes('unused'),c.id);
  assert.equal(compact.generatedAt,payload.generatedAt);
 }
});
test('a range-limited compact payload draws the same rows for that range, gap markers included',()=>{
 const {compactCatalogPayload}=load('lib/chart-catalog.ts');const {chartRangeRows}=load('lib/chart-sharing.ts');
 const c=chart('mvrv');const day=i=>new Date(Date.UTC(2025,0,1)+i*86400000).toISOString().slice(0,10);
 // 400 days with gaps straddling each range edge (latest is day 399).
 const missing=new Set([368,369,370,309,310,308,34,35]);
 const points=[];for(let i=0;i<400;i++)if(!missing.has(i))points.push({date:day(i),mvrv:1+i/1000,priceUsd:100,computedAt:'x'});
 const full={generatedAt:'2026-01-01T00:00:00Z',points};
 for(const [range,days] of [['7d',7],['30d',30],['90d',90],['1y',365]]){
  const compact=compactCatalogPayload(c,full,days);
  assert.deepEqual(chartRangeRows(c,catalogRows(c,compact),range),chartRangeRows(c,catalogRows(c,full),range),range);
  assert.ok(compact.points.length<=days+3,range);
 }
 assert.equal(compactCatalogPayload(c,full).points.length,points.length);
});
