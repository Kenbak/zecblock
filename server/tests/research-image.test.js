'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const image=require('../../lib/ask/research-image');
const {chartLegend}=require('../../lib/ask/research-display');
const when='2026-11-15T04:00:00Z';
const days=['2026-11-08','2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14'];
// Pure Ironwood vs pure transparent transactions per UTC day (the post that prompted this export).
const daily={query:{version:3,sql:'SELECT day, ironwood_txs, transparent_txs FROM t',limit:100},columns:[{key:'c0',label:'day',type:'text'},{key:'c1',label:'ironwood_txs',type:'number'},{key:'c2',label:'transparent_txs',type:'number'}],rows:days.map((d,i)=>[d,String(1200+i*40),String(9000-i*100)]),truncated:false,datasets:['transactions'],fingerprint:'a'.repeat(64),retrievedAt:when,indexedThrough:when,coverage:'fixture',units:'counts'};
const plot={width:720,height:280,markup:'<g class="recharts-layer"><text fill="var(--color-text-muted)" font-size="12">Nov 8</text><path stroke="var(--color-gold)" d="M0 0L10 10"/><stop style="stop-color: var(--color-purple); stop-opacity: 0.32;"/><line stroke="var(--color-unknown, #123456)"/></g>'};

test('the card is always dark: the palette matches the dark :root tokens in globals.css',()=>{
 const css=fs.readFileSync(path.resolve(__dirname,'../../app/globals.css'),'utf8');
 const root=css.slice(css.indexOf(':root {'),css.indexOf('}',css.indexOf(':root {')));
 for(const [name,value] of Object.entries(image.DARK)){
  const own=new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(root),alias=new RegExp(`${name}:\\s*var\\((--[\\w-]+)\\)`).exec(root);
  const resolved=own?own[1]:alias?new RegExp(`${alias[1]}:\\s*(#[0-9A-Fa-f]{6})`).exec(root)?.[1]:null;
  assert.equal(resolved?.toUpperCase(),value.toUpperCase(),name);
 }
});
test('CSS variables in the drawn chart become fixed dark colours, including inline styles and fallbacks',()=>{
 const out=image.resolveColors(plot.markup);
 assert.doesNotMatch(out,/var\(/);assert.match(out,/fill="#9CA4B0"/);assert.match(out,/stroke="#F8BC21"/);assert.match(out,/stop-color: #B6A0E0/);assert.match(out,/stroke="#123456"/);
 assert.equal(image.resolveColors('fill="var(--color-nope)"'),'fill="#9CA4B0"');
});
test('the data window names the UTC days the chart covers, whatever the row order',()=>{
 const chart={view:'line',x:0,y:1,series:[2]};
 assert.equal(image.dataWindow(daily,chart),'Nov 8 – Nov 14, 2026 · UTC');
 assert.equal(image.dataWindow({...daily,rows:[...daily.rows].reverse()},chart),'Nov 8 – Nov 14, 2026 · UTC');
 const years={...daily,rows:[['2025-12-30','1','2'],['2026-01-02','3','4']]};assert.equal(image.dataWindow(years,chart),'Dec 30, 2025 – Jan 2, 2026 · UTC');
 const months={...daily,columns:[{key:'c0',label:'month',type:'text'},...daily.columns.slice(1)],rows:[['2026-09-01','1','2'],['2026-10-01','3','4']]};assert.equal(image.dataWindow(months,chart),'Sep 2026 – Oct 2026 · UTC');
 const ranking={...daily,columns:[{key:'c0',label:'pool',type:'text'},{key:'c1',label:'zec',type:'number'}],rows:[['orchard','5'],['sapling','3']]};
 assert.equal(image.dataWindow(ranking,{view:'bar',x:0,y:1}),'Indexed through Nov 15, 2026 04:00 UTC');
});
test('title: the question or saved name, else the values drawn; long titles wrap to two lines',()=>{
 const chart={view:'line',x:0,y:1,series:[2]};
 assert.equal(image.cardTitle(daily,chart,'Ironwood vs transparent, daily'),'Ironwood vs transparent, daily');
 assert.equal(image.cardTitle(daily,chart,'My Zcash analysis'),'ironwood txs, transparent txs by day');
 assert.equal(image.cardTitle(daily,chart,''),'ironwood txs, transparent txs by day');
 const lines=image.titleLines('How many pure Ironwood transactions versus pure transparent transactions were mined each day last week on Zcash mainnet?');
 assert.equal(lines.length,2);assert.ok(lines.every(line=>line.length<=48),lines.join('|'));assert.match(lines[1],/…$/);
 assert.deepEqual(image.titleLines('Short title'),['Short title']);
});
test('legend follows the chart: one entry per value column, a right axis is named, one value names its column',()=>{
 const chart={view:'line',x:0,y:1,series:[2]};
 assert.deepEqual(chartLegend(daily,chart).map(i=>i.value),['ironwood txs','transparent txs']);
 assert.deepEqual(image.cardLegend(daily,chart),[{value:'ironwood txs',color:'#F8BC21'},{value:'transparent txs',color:'#B6A0E0'}]);
 const apart={...daily,rows:days.map(d=>[d,'10','900000'])};assert.deepEqual(chartLegend(apart,chart).map(i=>i.value),['ironwood txs','transparent txs (right axis)']);
 assert.deepEqual(chartLegend(apart,{...chart,view:'area',stacked:true}).map(i=>i.value),['ironwood txs','transparent txs']);
 assert.deepEqual(image.cardLegend(daily,{view:'area',x:0,y:1}),[{value:'ironwood txs',color:'#F8BC21'}]);
 const flows={...daily,columns:[{key:'c0',label:'direction',type:'text'},{key:'c1',label:'zec',type:'number'}],rows:[['shield','5'],['deshield','3']]};
 assert.deepEqual(image.cardLegend(flows,{view:'bar',x:0,y:1}),[{value:'shield',color:'#65C79A'},{value:'deshield',color:'#E2A66E'}]);
});
test('the card is a 1200×675 (2×) dark SVG with title, window, legend, chart and a small footer; no external hosts',()=>{
 const svg=image.researchCard(daily,{view:'line',x:0,y:1,series:[2]},'Ironwood <vs> "transparent" & more',plot);
 assert.equal(image.WIDTH/image.HEIGHT,16/9);assert.match(svg,/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="2400" height="1350" viewBox="0 0 1200 675"/);
 assert.match(svg,/<rect width="1200" height="675" fill="#0B0C0E"\/>/);
 assert.match(svg,/Ironwood &lt;vs&gt; &quot;transparent&quot; &amp; more/);assert.match(svg,/Nov 8 – Nov 14, 2026 · UTC/);
 assert.match(svg,/>ironwood txs<\/text>/);assert.match(svg,/>transparent txs<\/text>/);
 assert.match(svg,/viewBox="0 0 720 280" preserveAspectRatio="xMidYMid meet"/);assert.match(svg,/>Nov 8<\/text>/);
 assert.match(svg,/ZecBlock <tspan[^>]*>·<\/tspan> <tspan[^>]*>Zift<\/tspan>/);assert.match(svg,/>zecblock\.com\/zift<\/text>/);
 assert.doesNotMatch(svg,/var\(/);assert.deepEqual(svg.match(/https?:\/\/[^\s"']+/g),['http://www.w3.org/2000/svg']);
 assert.doesNotMatch(svg,/<image|href=/,'no linked resources; the canvas stays untainted');
 const crowded=image.cardSVG({title:'x',window:null,legend:Array.from({length:5},(_,k)=>({value:'a very long value column name '+k,color:'#fff'})),plot});
 assert.ok((crowded.match(/a very long[^<]*…<\/text>/g)||[]).length===5,'long legend entries are shortened to fit one row');
});
test('file names are short, readable and safe',()=>{
 assert.equal(image.imageName('Ironwood vs transparent: Nov 8–14!'),'zecblock-zift-ironwood-vs-transparent-nov-8-14.png');
 assert.equal(image.imageName(''),'zecblock-zift-chart.png');assert.equal(image.imageName('../../etc'),'zecblock-zift-etc.png');
});
