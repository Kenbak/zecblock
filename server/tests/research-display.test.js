'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {defaultResearchChart,shortLabel,supportsLine,cellLink}=require('../../lib/ask/research-display');
const result={columns:[{key:'c0',label:'txid',type:'text'},{key:'c1',label:'height',type:'number'},{key:'c2',label:'miner',type:'text'},{key:'c3',label:'public_deshield_zec',type:'number'}],rows:[['a'.repeat(64),'3508500','Miner A','279.99975'],['b'.repeat(64),'3508499','Miner A','242.00015']]};
test('transaction rankings choose the returned amount rather than block height; display does not mutate source rows',()=>{
 const original=JSON.stringify(result);assert.deepEqual(defaultResearchChart(result),{view:'table',x:0,y:3});
 assert.equal(shortLabel(result.rows[0][0]),'aaaaaaaaaa…aaaaaa');assert.equal(JSON.stringify(result),original);
 assert.equal(defaultResearchChart({columns:[{key:'c0',label:'timestamp',type:'number'},{key:'c1',label:'fees_zec',type:'number'}]}).y,1);
 assert.equal(defaultResearchChart({columns:[{key:'c0',label:'miner',type:'text'}]}).y,0);
});
test('lines require an ordered numeric/date axis, never repeated categories or unordered rankings',()=>{
 assert.equal(supportsLine(result,0),false);assert.equal(supportsLine(result,2),false);assert.equal(supportsLine(result,1),true);
 for(const rows of [[['1'],['1']],[['1'],['3'],['2']],[['1'],[null]],[['1']]])assert.equal(supportsLine({columns:[{type:'number'}],rows},0),false);
 assert.equal(supportsLine({columns:[{type:'text'}],rows:[['2026-10-01'],['2026-10-02']]},0),true);
 assert.equal(supportsLine({columns:[{type:'text'}],rows:[['2026-10-01'],['invalid']]},0),false);
});
test('identifier links preserve complete values and never accept URLs or executable text',()=>{
 assert.equal(cellLink('txid','a'.repeat(64)),'/tx/'+'a'.repeat(64));assert.equal(cellLink('height','3508500'),'/block/3508500');assert.equal(cellLink('miner','t1'+'A'.repeat(33)),'/address/t1'+'A'.repeat(33));
 for(const value of ['javascript:alert(1)','https://evil.test','../secret',null,'0','1.5'])assert.equal(cellLink('txid',value),null);
 assert.equal(cellLink('miner','Unattributed'),null);assert.equal(shortLabel(null),'Unavailable');
});
test('result cells retain exact decimals and complete safe identifiers; numeric headers carry the same alignment type as cells',()=>{
 const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
 const filename=path.resolve(__dirname,'../../app/ask/ResearchWorkbench.tsx'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);
 const imports={'next/dynamic':{default:()=>()=>null},'next/link':{default:props=>React.createElement('a',props)},'@/lib/ask/research-display':require('../../lib/ask/research-display'),'@/lib/ask/research-contract':require('../../lib/ask/research-contract'),'@/lib/ask/research-library':require('../../lib/ask/research-library'),'@/lib/ask/research-share':require('../../lib/ask/research-share')};
 m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?new Proxy({},{get:(_,key)=>key}):base(name);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);
 const data={...result,rows:[result.rows[0],['<script>secret()</script>','3508499','Unattributed',null]],indexedThrough:'2026-10-07T00:00:00Z',retrievedAt:'2026-10-07T00:01:00Z',coverage:'Public data',units:'ZEC',fingerprint:'a'.repeat(64)};
 const html=require('react-dom/server').renderToStaticMarkup(React.createElement(m.exports.ResearchData,{result:data,chart:defaultResearchChart(data)}));
 assert.match(html,/<th scope="col" data-numeric="true">public deshield zec/);assert.match(html,/<td data-numeric="true"><span title="279.99975">279.99975/);
 assert.match(html,new RegExp('href="/tx/'+'a'.repeat(64)+'"'));assert.match(html,/Unavailable/);assert.doesNotMatch(html,/<script/i);assert.match(html,/&lt;script&gt;/);
});
test('Ask answers open as charts: an ordered series as an area on its latest value, a short ranking as bars on its peak',()=>{
 const {suggestResearchChart,chartHighlight}=require('../../lib/ask/research-display');
 const daily={columns:[{key:'c0',label:'date',type:'text'},{key:'c1',label:'orchard_zec',type:'number'}],rows:[['2026-10-03','9.5'],['2026-10-02','12'],['2026-10-01','10']]};
 assert.deepEqual(suggestResearchChart(daily),{view:'area',x:0,y:1,highlight:'latest'});
 // Descending dates: "latest" is the newest date, not the last row.
 assert.deepEqual(chartHighlight(daily,suggestResearchChart(daily)),{kind:'latest',row:0,value:'9.5',label:'2026-10-03'});
 const change=chartHighlight(daily,{view:'area',x:0,y:1,highlight:'change'});
 assert.equal(change.from.value,'10');assert.equal(change.value,'9.5');assert.equal(change.delta,-0.5);assert.equal(change.pct,-5);
 assert.deepEqual(suggestResearchChart(result),{view:'bar',x:0,y:3,highlight:'peak'});
 assert.deepEqual(chartHighlight(result,suggestResearchChart(result)),{kind:'peak',row:0,value:'279.99975',label:'a'.repeat(64)});
 // SQL results keep the table; a single row or no numeric column stays a table.
 assert.equal(defaultResearchChart(daily).view,'table');
 assert.equal(suggestResearchChart({...daily,rows:[daily.rows[0]]}).view,'table');
 assert.equal(suggestResearchChart({columns:[{key:'c0',label:'miner',type:'text'}],rows:[['a'],['b']]}).view,'table');
});
test('proposed charts are refitted to the rows: ordered axes for lines, same-axis same-unit stacks, highlights that exist',()=>{
 const {fitResearchChart}=require('../../lib/ask/research-display');
 const months={columns:[{key:'c0',label:'month',type:'text'},{key:'c1',label:'shielded',type:'number'},{key:'c2',label:'transparent',type:'number'},{key:'c3',label:'fees_zec',type:'number'}],rows:[['2026-08-01','100','80','0.5'],['2026-09-01','120','90','0.7'],['2026-10-01','130','70','0.6']]};
 assert.deepEqual(fitResearchChart(months,{view:'area',x:0,y:1,series:[2],stacked:true,highlight:'change'}),{view:'area',x:0,y:1,series:[2],stacked:true,highlight:'change'});
 // Values on different axes, or with different units, are never stacked.
 assert.equal(fitResearchChart(months,{view:'bar',x:0,y:1,series:[3],stacked:true}).stacked,undefined);
 assert.equal(fitResearchChart(months,{view:'bar',x:0,y:1,series:[2],stacked:true},['','records','ZEC']).stacked,undefined);
 assert.equal(fitResearchChart(months,{view:'line',x:0,y:1,series:[2],stacked:true}).stacked,undefined);
 // Unordered labels: lines become bars and time highlights are dropped.
 assert.deepEqual(fitResearchChart(result,{view:'line',x:0,y:3,highlight:'latest'}),{view:'bar',x:0,y:3});
 // Non-numeric, duplicate and label columns are removed; nothing drawable is null.
 assert.deepEqual(fitResearchChart(months,{view:'line',x:0,y:1,series:[1,0,2,2]}),{view:'line',x:0,y:1,series:[2]});
 assert.equal(fitResearchChart(months,{view:'bar',x:0,y:0}),null);
 assert.equal(fitResearchChart(months,{view:'pie',x:0,y:1}),null);
});
test('a latest period running past the indexed data is flagged, never the low or the end of a change',()=>{
 const {partialPeriod,chartHighlight}=require('../../lib/ask/research-display');
 const months={indexedThrough:'2026-10-29T22:55:02Z',columns:[{key:'c0',label:'month',type:'text'},{key:'c1',label:'transactions',type:'number'}],rows:[['2026-08-01 00:00:00+00','140215'],['2026-09-01 00:00:00+00','363162'],['2026-10-01 00:00:00+00','98000']]};
 assert.equal(partialPeriod(months,0),2);
 assert.equal(chartHighlight(months,{view:'line',x:0,y:1,highlight:'latest'}).partial,true);
 assert.equal(chartHighlight(months,{view:'line',x:0,y:1,highlight:'low'}).row,0);
 assert.equal(chartHighlight(months,{view:'line',x:0,y:1,highlight:'change'}).row,1);
 // Complete days, a single row, or no indexing time: nothing is partial.
 assert.equal(partialPeriod({...months,rows:[['2026-10-27','1'],['2026-10-28','2']]},0),-1);
 assert.equal(partialPeriod({...months,rows:[['2026-10-28','1'],['2026-10-29','2']]},0),1);
 assert.equal(partialPeriod({...months,rows:[months.rows[2]]},0),-1);
 assert.equal(partialPeriod({...months,indexedThrough:undefined},0),-1);
});
test('axis ticks shorten daily dates within one year so the last tick fits; other dates keep their format',()=>{
 const {axisDateFormatter}=require('../../lib/ask/research-display');
 const axis=values=>axisDateFormatter({columns:[{key:'c0',label:'date',type:'text'}],rows:values.map(v=>[v])},0);
 assert.equal(axis(['2026-09-29','2026-10-28'])('2026-10-28'),'Oct 28');
 assert.equal(axis(['2025-12-30','2026-01-02'])('2026-01-02'),'2026-01-02');
 assert.equal(axis(['2025-10-01 00:00:00+00','2025-11-01 00:00:00+00'])('2025-11-01 00:00:00+00'),'Nov 2025');
 assert.equal(axisDateFormatter({columns:[{key:'c0',label:'n',type:'number'}],rows:[['1'],['2']]},0),null);
});
