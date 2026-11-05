'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = path.resolve(__dirname,'../../components/ask/AskAnalytics.tsx');
const compiled = new Module(filename,module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);
const {AskAnalytics} = compiled.exports;
const result = {label:'Shielded transactions',unit:'transactions',kind:'count',plan:{version:1,metric:'shielded_transactions',start:'2026-09-01',end:'2026-09-30',bucket:'week',order:'highest',limit:5},rows:[{date:'2026-09-07',value:'6000',formatted:'6,000 transactions',observedDays:7,observedThrough:'2026-09-13'}],coverage:{expectedDays:30,observedDays:29,missingDays:1},retrievedAt:'2026-10-02T00:00:00Z',methodology:'Counts sum observed days only.'};
test('shared native analytics table renders exact data, actual snapshot dates and incomplete coverage safely',()=>{
  const html=renderToStaticMarkup(React.createElement(AskAnalytics,{result}));
  assert.match(html,/6,000 transactions/); assert.match(html,/7\s*–\s*13 Sept 2026/); assert.match(html,/Highest first/); assert.match(html,/>Rank</); assert.match(html,/Rankings cover the available data/); assert.match(html,/<caption/); assert.match(html,/scope="row"/);
  const unsafe=renderToStaticMarkup(React.createElement(AskAnalytics,{result:{...result,label:'<script>bad()</script>',methodology:'<img src=x onerror=bad()>'}}));
  assert.doesNotMatch(unsafe,/<script|<img/); assert.match(unsafe,/&lt;script&gt;/);
  const empty=renderToStaticMarkup(React.createElement(AskAnalytics,{result:{...result,rows:[]}}));assert.match(empty,/No observations were returned/);assert.doesNotMatch(empty,/zero activity/);
});
test('calendar labels never make a partial September week appear to include August',()=>{
  const html=renderToStaticMarkup(React.createElement(AskAnalytics,{result:{...result,rows:[{date:'2026-08-31',value:'48158',formatted:'48,158 transactions',observedDays:6,observedThrough:'2026-09-06'}]}}));
  assert.match(html,/1\s*–\s*6 Sept 2026/); assert.match(html,/Partial week/); assert.match(html,/6 days/); assert.doesNotMatch(html,/Aug/);
  const snapshot=renderToStaticMarkup(React.createElement(AskAnalytics,{result:{...result,kind:'snapshot',rows:[{...result.rows[0],observedThrough:'2026-09-11'}]}}));
  assert.match(snapshot,/Snapshot date/); assert.match(snapshot,/dateTime="2026-09-11"/); assert.match(snapshot,/11 Sept 2026/);
});

test('relational results render multiple exact measures, clipped dates and public record links without injecting row text',()=>{
 const custom={label:'Public flows',plan:{version:2,dataset:'flows',start:'2026-09-01',end:'2026-09-30',bucket:'week',order:{column:1,direction:'desc'}},columns:[{key:'d0',type:'date',label:'Period'},{key:'m0',type:'number',label:'Total amount',unit:'ZEC'}],rows:[{d0:{value:'2026-08-31',formatted:'2026-08-31'},m0:{value:'9007199254740993',formatted:'90,071,992.54740993 ZEC'}}],coverage:{missingDays:null,indexedThrough:'2026-10-02T00:00:00Z'},methodology:'Reviewed public boundary flows.'};
 const html=renderToStaticMarkup(React.createElement(AskAnalytics,{result:custom}));assert.match(html,/90,071,992.54740993 ZEC/);assert.match(html,/1.*6 Sept/);assert.match(html,/Partial week/);assert.match(html,/Source and query/);assert.doesNotMatch(html,/Aug|undefined|missing database/);
});
