'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {sqlDraft}=require('../../lib/ask/composer');
function load(file,imports={}){const filename=path.resolve(__dirname,'../../'+file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?new Proxy({},{get:(_,key)=>key}):base(name);m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);return m.exports;}
const {ApiError}=load('lib/api-client.ts');
const client=load('lib/ask/client.ts',{'@/lib/api-client':{ApiError},'./api-base':{getAskApiUrl:()=>'/v1/ask'}});
const {AskFeedback,AskFailureFeedback}=load('components/ask/AskFeedback.tsx',{'@/lib/ask/client':client});
test('SQL detection preserves full query and routes SQL fences/comments/CTEs away from AI; ordinary questions remain questions',()=>{
 const sql='-- notes\nWITH bounded AS (SELECT height FROM blocks LIMIT 100) SELECT * FROM bounded';
 assert.equal(sqlDraft(sql),sql);assert.equal(sqlDraft('WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x'),'WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x');assert.equal(sqlDraft('```sql\nSELECT 1\n```'),'SELECT 1');
 assert.equal(sqlDraft('/* read */ SELECT height FROM blocks'), '/* read */ SELECT height FROM blocks');
 const long='SELECT height FROM blocks -- '+ 'x'.repeat(1200);assert.equal(sqlDraft(long),long);
 for(const text of ['Compare pool balances','Select the busiest week for Zcash','With more details please','Explain this SQL: SELECT * FROM blocks'])assert.equal(sqlDraft(text),null);
 for(const text of ['DELETE FROM blocks','DROP TABLE blocks',"SELECT pg_read_file('/etc/passwd') FROM blocks"])assert.equal(sqlDraft(text),text);
});
test('legacy shared limits stay compatible without hard-coded allowances; unknown denials promise no reset',()=>{
 const now=Date.parse('2026-10-06T23:50:00Z');
 const daily=client.askFailure(new ApiError('untrusted secret',429,undefined,undefined,'600','ask-quota-day'),now);
 assert.equal(daily.retryAt,Date.parse('2026-10-07T00:00:00Z'));assert.match(daily.detail,/previous shared daily allowance/);assert.match(daily.detail,/legacy allowance/);assert.doesNotMatch(daily.detail,/secret|20 requests|5 requests/);
 assert.match(client.askErrorMessage(new ApiError('raw',429,undefined,undefined,'60','ask-quota-minute')),/previous shared per-minute allowance/);
 for(const [code,header] of [['ask-quota','60'],['ask-unknown','60'],['constructor','60'],['__proto__','60'],['ask-quota-day','Infinity'],['ask-quota-minute','999999'],['ask-quota-day','-1']])assert.equal(client.askFailure(new ApiError('raw',429,undefined,undefined,header,code),now).retryAt,undefined);
 assert.match(client.askErrorMessage(new ApiError('raw',400)),/syntax/);
});
test('precise admission, AI, SQL, capacity and global-budget failures explain the actual bucket',()=>{
 const now=Date.parse('2026-10-06T23:50:00Z');
 const cases=[
  ['ask-request-attempts','Request limit reached',/submission or verification attempts.*connection/],
  ['ask-request-minute','Request limit reached',/per-minute request allowance across all visitors/],
  ['ask-request-day','Request limit reached',/daily request allowance across all visitors/],
  ['ask-request-global-hour','Request limit reached',/site-wide hourly request/],
  ['ask-request-global-day','Request limit reached',/site-wide daily request/],
  ['ask-ai-minute','AI limit reached',/AI has reached its per-minute allowance across all visitors/],
  ['ask-ai-day','AI limit reached',/AI has reached its daily allowance across all visitors/],
  ['ask-sql-minute','SQL limit reached',/SQL has reached its per-minute allowance across all visitors/],
  ['ask-sql-day','SQL limit reached',/SQL has reached its daily allowance across all visitors/],
  ['ask-ai-calls-day','AI limit reached',/site-wide daily call limit/],
  ['ask-ai-budget-day','AI limit reached',/site-wide daily usage allowance/],
  ['ask-ai-budget-month','AI limit reached',/site-wide monthly usage allowance/],
  ['ask-ai-busy','AI busy',/simultaneous requests/],
  ['ask-sql-global-day','SQL limit reached',/site-wide daily query allowance/],
  ['ask-sql-busy','SQL busy',/simultaneous queries/],
  ['ask-sql-queue','SQL busy',/SQL queue is full/],
  ['ask-sql-status-minute','Research updates limited',/research status, cancellation or explanation requests/],
 ];
 for(const [code,title,copy] of cases){
  const seconds=['ask-request-attempts','ask-sql-status-minute'].includes(code)?60:600;
  const failure=client.askFailure(new ApiError('postgres://secret',429,undefined,undefined,String(seconds),code),now);
  assert.equal(failure.title,title);assert.match(failure.detail,copy);assert.equal(failure.retryAt,now+seconds*1000);assert.equal(failure.retryable,false);assert.equal(failure.scope,code.startsWith('ask-ai-')?'ai':code.startsWith('ask-sql-')?'sql':'request');assert.doesNotMatch(failure.detail,/secret|postgres|\$|20 requests|5 requests/);
  if(code.startsWith('ask-ai-'))assert.match(failure.detail,/SQL directly or use starter charts, subject to their own limits/);
  if(code.startsWith('ask-sql-'))assert.match(failure.detail,/query and current results are kept/);
  if(code.startsWith('ask-request-'))assert.match(failure.detail,/Ask and SQL/);
 }
 const monthly=client.askFailure(new ApiError('raw',429,undefined,undefined,'2678400','ask-ai-budget-month'),now);
 assert.equal(monthly.retryAt,now+2678400000);assert.doesNotMatch(monthly.detail,/your connection|you.*spent/i);
 for(const header of ['0','-1','1.5','1e3','Infinity','2678401','9007199254740992','Thu, 01 Jan 2027 00:00:00 GMT'])assert.equal(client.askFailure(new ApiError('raw',429,undefined,undefined,header,'ask-ai-budget-month'),now).retryAt,undefined);
 const wrongStatus=client.askFailure(new ApiError('raw',400,undefined,undefined,'600','ask-ai-day'),now);assert.equal(wrongStatus.retryAt,undefined);assert.equal(wrongStatus.title,'Request could not finish');
 for(const code of ['ask-request-attempts','ask-sql-status-minute']){
  assert.equal(client.askFailure(new ApiError('raw',429,undefined,undefined,'61',code),now).retryAt,undefined);
  assert.equal(client.askFailure(new ApiError('raw',429,undefined,undefined,'1',code),now).retryAt,now+1000);
 }
 assert.match(client.askErrorMessage(new ApiError('raw',429,undefined,undefined,'60','ask-sql-status-minute')),/Zift can still answer other direct questions, subject to its own limits/);
});
test('progress, inline errors, quota resets and retries have accessible, safe markup',()=>{
 const working=renderToStaticMarkup(React.createElement(AskFeedback,{title:'Running your query…',detail:'Reading public data.',working:true}));
 assert.match(working,/role="status"/);assert.match(working,/aria-live="polite"/);assert.match(working,/Running your query…/);assert.match(working,/Reading public data\./);
 const failure={title:'Request limit reached',detail:'The daily allowance is used.',retryAt:Date.parse('2026-10-07T00:00:00Z'),retryable:false};
 const blocked=renderToStaticMarkup(React.createElement(AskFailureFeedback,{failure,blocked:true,onRetry:()=>{}}));assert.match(blocked,/Try again after/);assert.doesNotMatch(blocked,/<button/);
 const ready=renderToStaticMarkup(React.createElement(AskFailureFeedback,{failure,blocked:false,onRetry:()=>{}}));assert.match(ready,/You can try again/);assert.match(ready,/<button/);
 const unsafe=renderToStaticMarkup(React.createElement(AskFeedback,{title:'<script>bad()</script>',error:true}));assert.match(unsafe,/role="alert"/);assert.doesNotMatch(unsafe,/<script/i);
});
test('long retry windows include the local calendar date without promising capacity resets',()=>{
 const original=Date.now;const now=Date.parse('2026-10-06T23:50:00Z');Date.now=()=>now;
 try{
  const retryAt=now+2678400000;
  const reset=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(retryAt));
  const failure={title:'AI limit reached',detail:'AI has reached its site-wide monthly usage allowance.',retryAt,retryable:false};
  const html=renderToStaticMarkup(React.createElement(AskFailureFeedback,{failure,blocked:true,onRetry:()=>{}}));
  assert.ok(html.includes(reset));assert.match(html,/Try again after/);assert.doesNotMatch(html,/Resets at|<button/);
  const ready=renderToStaticMarkup(React.createElement(AskFailureFeedback,{failure,blocked:false,onRetry:()=>{}}));assert.match(ready,/You can try again now/);assert.doesNotMatch(ready,/window has reset/);
 }finally{Date.now=original;}
});
