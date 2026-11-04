'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const contract=require('../../lib/ask/research-contract');
const when='2026-10-29T04:00:00Z';
const result={query:{version:3,sql:'SELECT height FROM blocks LIMIT 1',limit:100},columns:[{key:'c0',label:'height',type:'number'}],rows:[['3534000']],truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:when,indexedThrough:when,coverage:'fixed public operator fixture',units:'exact decimal strings'};
const context={question:'Show the latest canonical block height.',answer:'The returned block height is 3,534,000.',fingerprint:result.fingerprint,inputMode:'ask',locale:'en'};
function load({hooks,capture}={}){
 const filename=path.resolve(__dirname,'../../app/ask/ResearchWorkbench.tsx'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m),runtime=require('react/jsx-runtime');
 const wrap=fn=>(type,props,...rest)=>{capture?.push({type,props});return fn(type,props,...rest);};
 const imports={'react':hooks?{...React,...hooks}:React,'react/jsx-runtime':capture?{...runtime,jsx:wrap(runtime.jsx),jsxs:wrap(runtime.jsxs)}:runtime,'next/dynamic':{default:()=>()=>null},'next/link':{default:({children,...props})=>React.createElement('a',props,children)},'@/lib/ask/research-display':require('../../lib/ask/research-display'),'@/lib/ask/research-contract':contract,'@/lib/ask/research-library':require('../../lib/ask/research-library'),'@/lib/ask/research-share':require('../../lib/ask/research-share')};
 m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?{default:new Proxy({},{get:(_,key)=>key})}:base(name);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);return m.exports;
}
// Minimal hook scheduler exercises callback/ref binding before and after a
// batched render. Real browser interaction is verified separately by staging.
function toolsFixture(initial=result,narrative=context){
 let cursor=0;const cells=[],effects=[];
 const hooks={useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return[cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value;}];},useRef(initial){const i=cursor++;if(!(i in cells))cells[i]={current:initial};return cells[i];},useEffect(fn){const i=cursor++;if(!(i in cells)){cells[i]=true;effects.push(fn);}}};
 const {useResearchTools}=load({hooks}),storage=new Map(),savedWindow=global.window,savedFetch=global.fetch;
 global.window={localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},location:{origin:'https://fixture.example'},confirm:()=>true};global.fetch=()=>assert.fail('opening, saving and importing local research must not issue a request');
 const HookFrame=()=>{cursor=0;return useResearchTools(initial,'Latest block',narrative);};let tools=HookFrame();for(const fn of effects.splice(0))fn();tools=HookFrame();return{render:HookFrame,tools,storage,cleanup(){if(savedWindow===undefined)delete global.window;else global.window=savedWindow;global.fetch=savedFetch;}};
}
function panel(overrides={},panelProps={}){
 const capture=[],calls=[],exports=load({capture});const tools={ready:true,importing:false,id:null,dirty:true,title:'Latest block',notes:'',library:{documents:[],dashboards:[]},notice:'',error:'',result,sql:result.query.sql,limit:100,chart:{view:'table',x:0,y:0},setTitle:value=>calls.push(['title',value]),setNotes:()=>{},setChart:value=>calls.push(['chart',value]),save:()=>{calls.push(['save']);return 'saved';},copyLink:()=>calls.push(['share']),exportCSV:()=>calls.push(['csv']),exportFile:()=>{},toggleDashboard:()=>null,createDashboard:()=>null,renameDocument:()=>true,updateNotes:()=>{},removeDocument:()=>{},...overrides};
 const props={tools,result,busy:false,embedded:true,actions:React.createElement('button',null,'Expand results'),editAction:React.createElement('button',null,'Edit SQL'),sources:React.createElement('a',{href:'/learn/blocks'},'Reading a block'),...panelProps};return{html:renderToStaticMarkup(React.createElement(exports.ResearchPanel,props)),capture,calls};
}

test('one view switch and direct actions: Edit SQL, Save, Add to dashboard, Share, Expand',()=>{
 const {html,capture,calls}=panel();assert.equal(capture.filter(e=>e.type==='div'&&e.props['aria-label']==='Result view').length,1,'one view switch');
 assert.match(html,/aria-label="Result view"><button[^>]*aria-pressed="true"[^>]*>Table<\/button>/);assert.doesNotMatch(html,/<summary>More<\/summary>/);assert.match(html,/<summary>Share<\/summary>/);assert.match(html,/<summary aria-label="Add to dashboard"><span class="wideOnly">Add to dashboard<\/span>/);assert.match(html,/>Expand results<\/button>/);assert.match(html,/>Edit SQL<\/button>/);
 for(const label of ['Copy query link','Results as CSV','Report (Markdown)','Research file (JSON)','No dashboards yet.','New dashboard name'])assert.ok(html.includes(label),label);
 assert.doesNotMatch(html,/role="(?:menu|menuitem)"|<summary>Exact data<\/summary>|<summary>Notes &amp; downloads<\/summary>/);
 capture.find(e=>e.type==='button'&&e.props.children==='Bar'&&'aria-pressed' in e.props).props.onClick();
 capture.find(e=>e.type==='button'&&e.props.children==='Save').props.onClick();capture.find(e=>e.type==='button'&&e.props.children==='Copy query link').props.onClick();
 assert.deepEqual(calls,[['chart',{view:'bar',x:0,y:0}],['save'],['share']]);
});
test('table mode is direct and Sources & details contains guide, exact query and provenance together',()=>{
 const {html}=panel();assert.equal((html.match(/<summary>Sources &amp; details<\/summary>/g)||[]).length,1);assert.match(html,/Reading a block/);assert.match(html,/SQL behind this result/);assert.match(html,/SELECT height FROM blocks LIMIT 1/);assert.match(html,/Query fingerprint/);assert.match(html,/3,534,000/);assert.doesNotMatch(html,/<summary>View data<\/summary>/);
 const capture=[],exports=load({capture});const chart=renderToStaticMarkup(React.createElement(exports.ResearchData,{result,chart:{view:'bar',x:0,y:0},showDetails:false}));assert.match(chart,/<summary>View data · 1 row<\/summary>/);assert.doesNotMatch(chart,/Sources &amp; details|Query fingerprint/);
});
test('share menu describes a reusable draft and CSV is disabled for an edited SQL snapshot',()=>{
 const {html,capture}=panel({shareURL:'https://fixture.example/ask#research=example',sql:'SELECT height FROM blocks LIMIT 2'});assert.match(html,/name="research-link"/);assert.match(html,/Shares the SQL, name and chart settings, not results\. It never runs automatically\./);assert.equal(capture.find(e=>e.type==='button'&&e.props.children==='Results as CSV').props.disabled,true);
});
test('initial narrative and same-event accept plus annotate are bound to the current result',()=>{
 const fixture=toolsFixture();try{let tools=fixture.tools;assert.deepEqual(tools.document().narrative,context);const newer={...result,query:{...result.query,sql:'SELECT height FROM blocks ORDER BY height DESC LIMIT 1'},fingerprint:'b'.repeat(64)},next={...context,fingerprint:newer.fingerprint,answer:'A newer checked answer.'};
 tools.accept(newer,'New result');assert.equal(tools.annotate(next),true);tools=fixture.render();assert.deepEqual(tools.document().narrative,next);assert.deepEqual(tools.narrative,next);
 assert.equal(tools.annotate(context),false);tools=fixture.render();assert.deepEqual(tools.document().narrative,next);
 tools.accept({...newer,rows:[['3534001']]},'Fresh run');tools=fixture.render();assert.equal(tools.document().narrative,undefined,'new result must clear old prose even with the same query fingerprint');
 }finally{fixture.cleanup();}
});
test('edited SQL or row limit excludes both the old result and its narrative from portable saves',()=>{
 const fixture=toolsFixture();try{let tools=fixture.tools;tools.setSQL('SELECT height FROM blocks LIMIT 2');tools=fixture.render();const draft=tools.document();assert.equal(draft.version,2);assert.equal(draft.result,null);assert.equal(draft.narrative,undefined);
 tools.setSQL(result.query.sql);tools.setLimit(50);tools=fixture.render();assert.equal(tools.document().result,null);assert.equal(tools.document().narrative,undefined);
 tools.reset();tools=fixture.render();assert.equal(tools.result,null);assert.equal(tools.narrative,null);assert.equal(tools.annotate(context),false);
 }finally{fixture.cleanup();}
});
test('save and reopen retain version-two narrative, legacy files upgrade, and no local action runs SQL',async()=>{
 const fixture=toolsFixture();try{let tools=fixture.tools;tools.save();tools=fixture.render();const doc=tools.library.documents[0];assert.equal(doc.version,2);assert.deepEqual(doc.narrative,context);assert.equal(tools.notice,'Saved in this browser.');
 tools.reset();tools=fixture.render();tools.open(doc);tools=fixture.render();assert.deepEqual(tools.narrative,context);assert.deepEqual(tools.document().narrative,context);assert.equal(tools.notice,'','snapshot provenance is not an action notification');
 const legacy={...doc,version:1};delete legacy.narrative;tools.open(legacy);tools=fixture.render();assert.equal(tools.narrative,null);assert.equal(tools.document().version,2);assert.equal(tools.document().narrative,undefined);
 await tools.importFile({size:JSON.stringify(doc).length,text:async()=>JSON.stringify(doc)});tools=fixture.render();assert.equal(tools.library.documents.length,2);assert.equal(tools.result.fingerprint,legacy.result.fingerprint,'import does not replace or run the open query');
 }finally{fixture.cleanup();}
});


test('snapshot status and indexed/retrieved provenance stay inside closed Sources & details',()=>{
 const {html}=panel({id:'saved-analysis'}, {saved:true});
 const summary=html.indexOf('<summary>Sources &amp; details</summary>'),start=html.lastIndexOf('<details',summary),end=html.indexOf('</details>',summary)+10;
 assert.ok(summary>0);assert.doesNotMatch(html.slice(start,summary),/\bopen(?:=|\s|>)/);
 const details=html.slice(start,end),outside=html.slice(0,start)+html.slice(end);
 for(const text of ['Saved snapshot. Run the query to refresh its data.','Indexed through','Retrieved','Query fingerprint','SELECT height FROM blocks LIMIT 1','Reading a block']){assert.ok(details.includes(text),text+' belongs in provenance');assert.ok(!outside.includes(text),text+' is not repeated outside');}
 assert.match(outside,/>1 row<\/p>/);
 const fresh=panel({id:'saved-analysis'},{saved:false}).html;
 assert.doesNotMatch(fresh,/Saved snapshot/,'a retained document id does not turn a new run into a saved snapshot');
});
test('result counts and truncation remain visible while optional provenance stays hidden',()=>{
 const exports=load();
 for(const [rows,truncated,label] of [[[],false,'0 rows'],[[['1']],false,'1 row'],[[['1'],['2']],true,'2 rows (limited)']]){
  const data={...result,rows,truncated};const html=renderToStaticMarkup(React.createElement(exports.ResearchData,{result:data,chart:{view:'table',x:0,y:0},savedSnapshot:true,showDetails:false}));
  assert.ok(html.includes('>'+label+'</p>'));assert.doesNotMatch(html,/Saved snapshot|Indexed through|Retrieved|Query fingerprint|Sources &amp; details/);
 }
});
test('action feedback and errors remain outside the provenance disclosure',()=>{
 for(const notice of ['Saved in this browser.','Query draft link copied.','Imported saved analyses. Open one and run its query to refresh the data.']){
  const {html}=panel({notice,error:'Browser storage is full.'},{saved:true});const details=html.indexOf('<summary>Sources &amp; details');
  assert.ok(html.indexOf(notice)<details);assert.match(html,/<p[^>]*role="status"[^>]*>/);assert.match(html,/<p[^>]*role="alert"[^>]*>Browser storage is full\.<\/p>/);
 }
});
test('library edits: rename, dashboard add/remove/create saves first, delete keeps analyses',()=>{
 const fixture=toolsFixture();try{let tools=fixture.tools;
  assert.equal(tools.dirty,true);
  const created=tools.createDashboard('  Fee watch  ');tools=fixture.render();
  assert.ok(created);assert.equal(tools.library.documents.length,1,'creating a dashboard saved the analysis');assert.equal(tools.id,created);assert.equal(tools.dirty,false);
  const board=tools.library.dashboards[0];assert.equal(board.title,'Fee watch');assert.deepEqual(board.items,[created]);
  assert.equal(tools.toggleDashboard(board.id),created);tools=fixture.render();assert.deepEqual(tools.library.dashboards[0].items,[],'toggling a member removes it');assert.match(tools.notice,/Removed from “Fee watch”/);
  tools.toggleDashboard(board.id);tools=fixture.render();assert.deepEqual(tools.library.dashboards[0].items,[created]);
  assert.equal(tools.renameDocument(created,'Renamed fees'),true);tools=fixture.render();assert.equal(tools.library.documents[0].title,'Renamed fees');assert.equal(tools.title,'Renamed fees');assert.equal(tools.dirty,false);
  assert.equal(tools.renameDocument(created,'   '),false);
  tools.renameDashboard(board.id,'Fees');tools.removeFromDashboard(board.id,created);tools=fixture.render();assert.equal(tools.library.dashboards[0].title,'Fees');assert.deepEqual(tools.library.dashboards[0].items,[]);
  tools.setBoardId(board.id);tools=fixture.render();tools.deleteDashboard(board.id);tools=fixture.render();assert.equal(tools.library.dashboards.length,0);assert.equal(tools.boardId,null);assert.equal(tools.library.documents.length,1,'deleting a dashboard keeps its analyses');
  tools.setTitle('Edited title');tools=fixture.render();assert.equal(tools.dirty,true,'an edit marks the save as changed');
  tools.removeDocument(created);tools=fixture.render();assert.equal(tools.library.documents.length,0);assert.equal(tools.id,null);
 }finally{fixture.cleanup();}
});
test('UTC-midnight timestamps read as dates and first-of-month columns as months',()=>{
 const {dateFormatter}=require('../../lib/ask/research-display');
 const months={columns:[{key:'c0',label:'month',type:'text'}],rows:[['2025-10-01 00:00:00+00'],['2025-11-01 00:00:00+00']]};
 assert.equal(dateFormatter(months,0)('2025-10-01 00:00:00+00'),'Oct 2025');
 const days={columns:[{key:'c0',label:'day',type:'text'}],rows:[['2025-10-01 00:00:00+00'],['2025-10-02 00:00:00+00']]};
 assert.equal(dateFormatter(days,0)('2025-10-02 00:00:00+00'),'2025-10-02');
 assert.equal(dateFormatter({columns:[{key:'c0',label:'t',type:'text'}],rows:[['2025-10-01 12:30:00+00']]},0),null,'a real time of day is left exact');
 assert.equal(dateFormatter({columns:[{key:'c0',label:'n',type:'number'}],rows:[['1']]},0),null);
});
test('charts draw up to five distinct value columns and put very different sizes on a second axis',()=>{
 const {chartValues,axisFor}=require('../../lib/ask/research-display');
 const r={columns:[{key:'c0',label:'month',type:'text'},{key:'c1',label:'transactions',type:'number'},{key:'c2',label:'fees_zec',type:'number'},{key:'c3',label:'blocks',type:'number'}],rows:[['2025-10-01','225385','165.36','8900'],['2025-11-01','507979','414.27','8600']]};
 assert.deepEqual(chartValues(r,{view:'line',x:0,y:1}),[1]);
 assert.deepEqual(chartValues(r,{view:'line',x:0,y:1,series:[2,3]}),[1,2,3]);
 assert.deepEqual(chartValues(r,{view:'line',x:0,y:1,series:[0]}),[1],'a text column is never drawn as a value');
 assert.deepEqual(axisFor(r,[1,2,3]),['left','right','right'],'fees in ZEC do not flatten against transaction counts');
 assert.deepEqual(axisFor(r,[1,1]),['left','left']);
 const chart=contract.chartSchema;
 assert.ok(chart.safeParse({view:'line',x:0,y:1,series:[2,3]}).success);
 assert.ok(chart.safeParse({view:'line',x:0,y:1}).success,'older single-value charts stay valid');
 assert.equal(chart.safeParse({view:'line',x:0,y:1,series:[1]}).success,false,'a value is drawn once');
 assert.equal(chart.safeParse({view:'line',x:0,y:1,series:[2,3,4,5,6]}).success,false,'at most five values');
});
