'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {researchDocumentSchema,researchNarrativeSchema}=require('../../lib/ask/research-contract');
const {STORAGE_KEY,MAX_BYTES,emptyLibrary,readLibrary,writeLibrary,readPortable,mergePortable,markdownReport,csvReport}=require('../../lib/ask/research-library');
const {queryShare,dashboardShare,researchLink,readResearchLink}=require('../../lib/ask/research-share');
function document(version=2){
 const query={version:3,sql:'SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 2',limit:2};
 const result={query:{...query},columns:[{key:'c0',label:'height',type:'number'},{key:'c1',label:'fee_zec',type:'number'}],rows:[['9007199254740993','0.00000001'],['9007199254740992',null]],truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-29T12:00:00Z',indexedThrough:'2026-10-29T11:59:00Z',coverage:'Verified canonical records; saved snapshot',units:'ZEC'};
 const base={format:'zecblock-research',version,id:randomUUID(),title:'Saved block research',notes:'My notes',query,chart:{view:'table',x:0,y:1},result,savedAt:'2026-10-29T12:01:00Z'};
 return version===2?{...base,narrative:{question:'What are the latest two block fees?',answer:'The known fee is 0.00000001 ZEC. The other fee is unavailable.',fingerprint:result.fingerprint,inputMode:'ask',locale:'en'}}:base;
}
function storage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};}

test('strict legacy v1 and optional-narrative v2 documents remain portable without implicit migration',()=>{
 const legacy=document(1),current=document();
 assert.deepEqual(readPortable(JSON.stringify(legacy)),legacy);
 assert.deepEqual(readPortable(JSON.stringify(current)),current);
 assert.equal(readPortable(JSON.stringify(legacy)).version,1);
 assert.equal(researchDocumentSchema.safeParse({...legacy,narrative:current.narrative}).success,false);
 assert.equal(researchDocumentSchema.safeParse({...current,version:3}).success,false);
 const {narrative,...draft}=current;draft.result=null;
 assert.deepEqual(researchDocumentSchema.parse(draft),draft);
 assert.equal(researchDocumentSchema.safeParse({...draft,narrative}).success,false);
});

test('mixed-version localStorage/library roundtrip preserves exact questions, answers, results and dashboard references',()=>{
 const s=storage(),legacy=document(1),current=document();
 current.narrative.question='Question with Unicode 🛡️, quotes " and\na new line.';
 current.narrative.answer='Answer: 9,007,199,254,740,993 and 0.00000001 ZEC.\nUnavailable is not zero.';
 const library={...emptyLibrary(),documents:[legacy,current],dashboards:[{id:randomUUID(),title:'Mixed research',items:[legacy.id,current.id]}]};
 const raw=writeLibrary(s,library,null);
 assert.equal(STORAGE_KEY,'zecblock.research.v1');assert.equal(s.getItem(STORAGE_KEY),raw);
 assert.deepEqual(readLibrary(s),{raw,library});
 const exported=readPortable(raw),imported=mergePortable(emptyLibrary(),exported,randomUUID);
 assert.equal(imported.version,1);assert.deepEqual(imported.documents.map(d=>d.version),[1,2]);
 assert.notEqual(imported.documents[0].id,legacy.id);assert.notEqual(imported.documents[1].id,current.id);
 assert.deepEqual(imported.documents[1].narrative,current.narrative);assert.deepEqual(imported.documents[1].result,current.result);
 assert.deepEqual(imported.dashboards[0].items,imported.documents.map(d=>d.id));
 const second=writeLibrary(s,imported,raw);assert.deepEqual(readPortable(second),imported);
});

test('narrative requires matching result fingerprint and existing exact query/row bindings',()=>{
 const d=document();
 for(const value of [
  {...d,narrative:{...d.narrative,fingerprint:'b'.repeat(64)}},
  {...d,result:null},
  {...d,query:{...d.query,sql:'SELECT height FROM blocks'}},
  {...d,query:{...d.query,limit:100}},
  {...d,chart:{...d.chart,y:2}},
  {...d,narrative:{...d.narrative,apiKey:'not allowed'}},
  {...d,narrative:{...d.narrative,inputMode:'auto'}},
 ])assert.equal(researchDocumentSchema.safeParse(value).success,false);
 assert.deepEqual(researchDocumentSchema.parse(d),d);
 const sql={...d,narrative:{...d.narrative,question:d.query.sql,inputMode:'sql'}};
 assert.deepEqual(readPortable(JSON.stringify(sql)),sql);
});

test('narrative field and existing row/document/byte limits remain bounded',()=>{
 const d=document(),n=d.narrative;
 assert.equal(researchNarrativeSchema.safeParse({...n,question:'x'.repeat(8192),answer:'x'.repeat(12000),locale:'x'.repeat(35)}).success,true);
 for(const value of [{...n,question:''},{...n,question:'x'.repeat(8193)},{...n,answer:''},{...n,answer:'x'.repeat(12001)},{...n,locale:'x'.repeat(36)}])assert.equal(researchNarrativeSchema.safeParse(value).success,false);
 assert.throws(()=>readPortable(' '.repeat(MAX_BYTES+1)));
 assert.equal(researchDocumentSchema.safeParse({...d,result:{...d.result,rows:Array.from({length:201},()=>['1','2'])}}).success,false);
 const l={...emptyLibrary(),documents:Array.from({length:26},document)};
 assert.throws(()=>writeLibrary(storage(),l,null));
 const wide={...d,result:{...d.result,columns:Array.from({length:12},(_,i)=>({key:'c'+i,label:'value_'+i,type:'text'})),rows:Array.from({length:200},()=>Array.from({length:12},()=> 'x'.repeat(1024)))}};
 assert.equal(researchDocumentSchema.safeParse(wide).success,true);
 assert.throws(()=>markdownReport(wide),/2 MB/);assert.throws(()=>csvReport(wide),/2 MB/);
});

test('Markdown includes natural question/answer, notes, exact result strings and safely fenced SQL',()=>{
 const d=document();d.query.sql="SELECT '````' AS text_value FROM blocks";d.result.query.sql=d.query.sql;
 d.narrative.question='Is **this** safe? ![image](https://example.invalid/leak) <script>alert(1)</script>\n# fake heading';
 d.narrative.answer='[run](javascript:alert(1)) <img src=x onerror=alert(1)>\nThe fee remains 0.00000001 ZEC.';
 d.notes='Keep [a link](https://example.invalid) and `ticks` as plain notes.';
 const report=markdownReport(d);
 assert.match(report,/## Question\n\n/);assert.match(report,/## Answer\n\n/);assert.match(report,/## Query\n\n`````sql\n/);
 assert.match(report,/9007199254740993/);assert.match(report,/0\.00000001/);assert.match(report,/Unavailable/);
 assert.doesNotMatch(report,/<script|<img|!\[|\[run\]\(javascript:|\n# fake heading/);
 assert.match(report,/&lt;script&gt;/);assert.match(report,/\\\*\\\*this\\\*\\\*/);assert.match(report,/\\\[run\\\]/);
 assert.ok(report.includes(d.query.sql));assert.match(report,/not signed evidence/);
 assert.ok(report.indexOf('## Question')<report.indexOf('## Answer'));assert.ok(report.indexOf('## Answer')<report.indexOf('## Results'));
});

test('legacy and draft Markdown remains usable without inventing a narrative',()=>{
 const old=document(1);const report=markdownReport(old);assert.doesNotMatch(report,/## Question|## Answer/);assert.match(report,/## Results/);
 old.result=null;assert.match(markdownReport(old),/No result snapshot saved/);assert.throws(()=>csvReport(old),/Run this query/);
});

test('CSV preserves exact numeric strings and RFC quoting/newlines without exporting narrative',()=>{
 const d=document();d.result.columns=[{key:'c0',label:'count',type:'number'},{key:'c1',label:'zec',type:'number'},{key:'c2',label:'note,quoted',type:'text'},{key:'c3',label:'missing',type:'text'}];
 d.result.rows=[['9007199254740993','0.00000001','say "hello",\nnext',null],['9007199254740992','-0.0000000100','ordinary','']];
 const csv=csvReport(d);
 assert.equal(csv,'count,zec,"note,quoted",missing\r\n9007199254740993,0.00000001,"say ""hello"",\nnext",\r\n9007199254740992,-0.0000000100,ordinary,\r\n');
 assert.ok(!csv.includes(d.narrative.question));assert.ok(!csv.includes(d.narrative.answer));assert.ok(!csv.includes(d.notes));
 const exact=readPortable(JSON.stringify(d));assert.equal(exact.result.rows[0][3],null);assert.equal(exact.result.rows[1][3],'','JSON retains NULL versus empty text types');
});

test('CSV formula safeguards apply to text, headers, hidden prefixes and forged numeric tags',()=>{
 const d=document();d.chart={view:'table',x:0,y:0};d.result.columns=[{key:'c0',label:'=header',type:'text'},{key:'c1',label:'number',type:'number'}];
 d.result.rows=[['=1+1','-0.00000001'],['+SUM(A1)','+2.50'],['@SUM(A1)','1e-8'],['-malicious','=1+1'],['\t=HYPERLINK("x")','2'],[' \uFEFF=1+1','3']];
 const csv=csvReport(d);
 assert.ok(csv.startsWith("'=header,number\r\n"));
 assert.ok(csv.includes("'=1+1,-0.00000001\r\n"));assert.ok(csv.includes("'+SUM(A1),+2.50\r\n"));
 assert.ok(csv.includes("'@SUM(A1),1e-8\r\n"));assert.ok(csv.includes("'-malicious,'=1+1\r\n"));
 assert.ok(csv.includes('"\'\t=HYPERLINK(""x"")",2\r\n'));assert.ok(csv.includes("' \uFEFF=1+1,3\r\n"));
});

test('v2 query/dashboard share links retain old privacy contract and no result/narrative payload',()=>{
 const d=document(),library={...emptyLibrary(),documents:[d],dashboards:[{id:randomUUID(),title:'Query drafts',items:[d.id]}]};
 for(const share of [queryShare(d),dashboardShare(library,library.dashboards[0].id)]){
  const link=researchLink(share,'https://zecblock.com'),decoded=readResearchLink(new URL(link).hash),serialized=JSON.stringify(decoded);
  assert.ok(!serialized.includes(d.narrative.question));assert.ok(!serialized.includes(d.narrative.answer));
  assert.ok(!serialized.includes(d.result.fingerprint));assert.ok(!serialized.includes('narrative'));assert.ok(!serialized.includes('result'));
  assert.equal(decoded.queries[0].query.sql,d.query.sql);
 }
});

test('save/import/reports have no automatic network or query execution',()=>{
 const original=global.fetch;let network=0;global.fetch=()=>{network++;throw Error('No network permitted for portable saves');};
 try{
  const d=document(),s=storage(),raw=writeLibrary(s,{...emptyLibrary(),documents:[d]},null);
  readLibrary(s);readPortable(raw);mergePortable(emptyLibrary(),readPortable(JSON.stringify(d)),randomUUID);
  markdownReport(d);csvReport(d);assert.equal(network,0);
  const draft={...d,result:null};delete draft.narrative;draft.query.sql='DELETE FROM blocks';
  assert.equal(readPortable(JSON.stringify(draft)).query.sql,'DELETE FROM blocks');assert.equal(network,0,'untrusted imported SQL is only a draft');
 }finally{global.fetch=original;}
});
