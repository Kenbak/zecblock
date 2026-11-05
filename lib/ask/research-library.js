/* eslint-disable @typescript-eslint/no-require-imports */
const {researchDocumentSchema,researchLibrarySchema}=require('./research-contract');
const STORAGE_KEY='zecblock.research.v1';
const MAX_BYTES=2*1024*1024;
const emptyLibrary=()=>({format:'zecblock-library',version:1,documents:[],dashboards:[]});
function bounded(text){if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX_BYTES)throw Error('Research files must be under 2 MB');return text;}
function readLibrary(storage){const raw=storage.getItem(STORAGE_KEY);return {raw,library:raw===null?emptyLibrary():researchLibrarySchema.parse(JSON.parse(bounded(raw)))};}
function writeLibrary(storage,library,previous){
 const text=bounded(JSON.stringify(researchLibrarySchema.parse(library)));
 if(storage.getItem(STORAGE_KEY)!==previous)throw Error('Your library changed in another tab. Reload before saving.');
 storage.setItem(STORAGE_KEY,text);return text;
}
function readPortable(text){const value=JSON.parse(bounded(text));return value?.format==='zecblock-research'?researchDocumentSchema.parse(value):researchLibrarySchema.parse(value);}
function mergePortable(current,incoming,uuid){
 researchLibrarySchema.parse(current);
 const library=incoming.format==='zecblock-research'?{...emptyLibrary(),documents:[researchDocumentSchema.parse(incoming)]}:researchLibrarySchema.parse(incoming);
 const ids=new Map(library.documents.map(d=>[d.id,uuid()]));
 const merged={...current,documents:[...current.documents,...library.documents.map(d=>({...d,id:ids.get(d.id)}))],dashboards:[...current.dashboards,...library.dashboards.map(d=>({...d,id:uuid(),items:d.items.map(id=>ids.get(id))}))]};
 bounded(JSON.stringify(merged));return researchLibrarySchema.parse(merged);
}
const plain=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
// Narrative/notes are plain text, not executable Markdown or HTML. Escape link,
// image, fence and heading syntax while preserving readable paragraph breaks.
const markdownText=s=>plain(s).replace(/\r\n?/g,'\n').replace(/([\\`*_{}\[\]()#+\-=!|])/g,'\\$1').replace(/^(\s*\d+)\./gm,'$1\\.');
function checkedDocument(input){const d=researchDocumentSchema.parse(input);bounded(JSON.stringify(d));return d;}
function markdownReport(input){
 const d=checkedDocument(input),r=d.result;
 const ticks=Math.max(3,...[...d.query.sql.matchAll(/`+/g)].map(m=>m[0].length+1));const fence='`'.repeat(ticks);
 const cell=s=>markdownText(s===null?'Unavailable':s).replace(/\n/g,'\\n').replace(/\t/g,'\\t');
 const narrative=d.narrative?`## Question\n\n${markdownText(d.narrative.question)}\n\n## Answer\n\n${markdownText(d.narrative.answer)}\n\n`:'';
 return `# ${markdownText(d.title)}\n\n${markdownText(d.notes)}\n\nSaved: ${d.savedAt}\n\n${narrative}## Query\n\n${fence}sql\n${d.query.sql}\n${fence}\n\n${r?`## Results\n\nRetrieved: ${r.retrievedAt}\nIndexed through: ${r.indexedThrough}\nCoverage: ${markdownText(r.coverage)}\n${markdownText(r.units)}\n\n| ${r.columns.map(c=>cell(c.label)).join(' | ')} |\n| ${r.columns.map(()=>'---').join(' | ')} |\n${r.rows.map(row=>'| '+row.map(cell).join(' | ')+' |').join('\n')}\n\n${r.truncated?'Result truncated to the selected row limit.':'All returned rows included.'}`:'No result snapshot saved.'}\n\nSaved files are editable snapshots, not signed evidence. Rerun the query to verify current data.\n`;
}
function csvReport(input){
 const d=checkedDocument(input),r=d.result;if(!r)throw Error('Run this query before downloading CSV.');
 const numeric=/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
 function cell(value,type='text'){
  if(value===null)return ''; // CSV cannot distinguish NULL from empty TEXT; JSON can.
  let text=String(value);
  // Only a validated numeric cell bypasses formula handling. Imported files
  // are editable: a forged number tag must not activate spreadsheet formulas.
  if(!(type==='number'&&numeric.test(text))&&(/^[\s\uFEFF\u200B-\u200F\u202A-\u202E\u2060-\u206F]*[=+\-@]/u.test(text)||/^[\t\r\n]/.test(text)))text="'"+text;
  return /[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;
 }
 return [r.columns.map(column=>cell(column.label)).join(','),...r.rows.map(row=>row.map((value,i)=>cell(value,r.columns[i].type)).join(','))].join('\r\n')+'\r\n';
}
module.exports={STORAGE_KEY,MAX_BYTES,emptyLibrary,readLibrary,writeLibrary,readPortable,mergePortable,markdownReport,csvReport};
