'use strict';
// Opt-in "Explain results" for SQL runs: offered only for a finished queued SQL
// job while AI is available, sends that job's ticket once, and never appears
// for guided mode or synchronous runs without a ticket.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function load(file,imports={}) {
  const filename=path.resolve(__dirname,'../../'+file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);
  m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?{default:new Proxy({},{get:(_,key)=>String(key)})}:base(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);return m.exports;
}
const ticket={id:'00000000-0000-4000-8000-000000000009',token:'a'.repeat(64)};
const result={query:{version:3,sql:'SELECT height FROM blocks LIMIT 1',limit:100},columns:[{key:'c0',label:'height',type:'number'}],rows:[['3534601']],truncated:false,datasets:['blocks'],fingerprint:'b'.repeat(64),retrievedAt:'2026-10-29T00:00:00.000Z',indexedThrough:'2026-10-29T00:00:00.000Z',coverage:'verified canonical records',units:'Exact decimal strings.'};

class ApiError extends Error{constructor(message,status,type,requestId,retryAfter,code){super(message);this.status=status;this.code=code;}}
async function fixture(t,{mode='ai',jobsEnabled=true,expired=0,boardId=null,submitFailures=[]}={}) {
  const states=[],effects=[],elements=[],calls={submit:[],explain:[],annotate:[],run:[],refreshed:[],reports:[]};let cursor=0,pending=[];
  const original={window:global.window,document:global.document,fetch:global.fetch,setInterval:global.setInterval,clearInterval:global.clearInterval,requestAnimationFrame:global.requestAnimationFrame};
  global.window={location:{hash:''},addEventListener(){},removeEventListener(){}};global.document={visibilityState:'visible'};
  global.fetch=async()=>new Response('{}');global.setInterval=()=>1;global.clearInterval=()=>{};global.requestAnimationFrame=fn=>fn();
  const react={
    useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];},
    useRef(initial){const index=cursor++;return states[index]||(states[index]={current:initial});},
    useEffect(run,deps){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))pending.push(()=>{previous?.cleanup?.();effects[index]={deps,cleanup:run()};});},
  };
  const feedback={failure:null,failureBlocked:false,requestBlocked:false,blocked:false,blockedFor:()=>false,clear(){},report:error=>{calls.reports.push(error);}};
  const runtime=require('react/jsx-runtime');const capture=fn=>(type,props,...rest)=>{elements.push({type,props});return fn(type,props,...rest);};
  const tools={library:{documents:[],dashboards:[]},boardId,importing:false,title:'Analysis',accept(){},refreshDocument:(id,data)=>{calls.refreshed.push({id,data});return true;},annotate:narrative=>{calls.annotate.push(narrative);return true;}};
  const imports={
    react,'react/jsx-runtime':{...runtime,jsx:capture(runtime.jsx),jsxs:capture(runtime.jsxs)},
    'next/link':{default:({children,...props})=>React.createElement('a',props,children)},
    '@/lib/ask/contract':require('../../lib/ask/contract'),
    '@/lib/ask/api-base':{getAskApiUrl:()=>'/v1/ask',isAuthenticatedAskStaging:()=>true},
    '@/lib/api-client':{ApiError,readApiResponse:async()=>({data:{mode,provider:mode==='ai'?'OpenAI':null,researchEnabled:true,jobsEnabled,authenticatedStaging:true},meta:{network:'mainnet'}})},
    './ResearchWorkbench':{useResearchTools:()=>tools,ResearchLibrary:()=>null,ResearchDashboard:()=>'dashboard',ResearchPanel:()=>null,ResearchData:()=>null,SharedResearchDraft:()=>null},
    '@/lib/ask/research-job-contract':{jobTicketSchema:{parse:value=>value}},'@/lib/ask/research-display': require('../../lib/ask/research-display'), '@/lib/ask/research-contract':{researchResultSchema:{parse:value=>value}},
    '@/lib/ask/research-client':{
      submitResearch:async query=>{calls.submit.push(query);const failure=submitFailures.shift();if(failure)throw failure;return ticket;},
      waitResearch:async()=>result,
      runResearch:async query=>{calls.run.push(query);return result;},
      explainResearch:async(sent,question)=>{calls.explain.push({sent,question});if(expired-->0)throw new ApiError('gone',404,'not-found',undefined,undefined,'ask-job');return{answer:'The latest returned height is 3,534,601.',locale:'en',mode:'ai',sources:[],spec:null,research:result};},
    },
    '@/components/ask/AskChallenge':{AskChallenge:()=>null},'@/components/ask/AskTransactions':{AskTransactions:()=>null},'@/components/ask/AskBlocks':{AskBlocks:()=>null},'@/components/ask/AskTransfers':{AskTransfers:()=>null},'@/components/ask/AskAnalytics':{AskAnalytics:()=>null},'@/components/ask/AskSources':{AskSources:()=>null},
    '@/lib/ask/client':{askErrorMessage:()=>'This research job has expired or is unavailable. Run the query again.',peekAskHandoff:()=>null,clearAskHandoff(){},askChat:async()=>{throw Error('unexpected chat');}},
    '@/lib/ask/composer':require('../../lib/ask/composer'),
    '@/components/ask/AskAnswerRating':{AskAnswerRating:()=>null},'@/components/ask/AskFeedback':{AskFeedback:({title,detail})=>title?React.createElement('p',null,title,' ',detail||''):null,AskFailureFeedback:()=>null,useAskFeedback:()=>feedback},
    '@/lib/ask/data':require('../../lib/ask/data'),'@/lib/ask/research-share':require('../../lib/ask/research-share'),'@/lib/ask/follow-ups':require('../../lib/ask/follow-ups'),...require('./ask-sql-test-imports'),
    './AskAnalysis':{AskAnalysis:()=>null},
  };
  const {AskWorkspace}=load('app/ask/AskWorkspace.tsx',imports);
  let html='';
  function render(){cursor=0;pending=[];elements.length=0;html=renderToStaticMarkup(React.createElement(AskWorkspace));for(const effect of pending)effect();return html;}
  const settle=async()=>{for(let i=0;i<4;i++){await new Promise(resolve=>setImmediate(resolve));render();}};
  t.after(()=>{for(const effect of effects)effect?.cleanup?.();for(const[key,value]of Object.entries(original)){if(value===undefined)delete global[key];else global[key]=value;}});
  render();await settle();
  // A button's visible label is its first text child (Explain results also carries an sr-only note).
  const label=children=>Array.isArray(children)?children.find(child=>typeof child==='string'):children;
  const button=text=>elements.find(item=>item.type==='button'&&label(item.props.children)===text);
  async function runSQL(){
    button('SQL').props.onClick();render();
    elements.find(item=>item.props?.datasets&&typeof item.props.onRun==='function').props.onChange(result.query.sql);render();
    elements.find(item=>item.type==='form').props.onSubmit({preventDefault(){}});await settle();
  }
  const dashboard=()=>elements.find(item=>item.props?.refresh)?.props.refresh;
  return{calls,render,settle,button,runSQL,dashboard,get html(){return html;}};
}

test('a finished SQL job offers Explain results, sends its ticket once and shows the checked answer',async t=>{
  const f=await fixture(t);await f.runSQL();
  assert.equal(f.calls.submit.length,1);assert.equal(f.calls.explain.length,0);
  assert.match(f.html,/1 rows returned\. No AI was used\./);
  const explain=f.button('Explain results');assert.ok(explain,'Explain results is offered after a queued SQL run');
  assert.match(JSON.stringify(explain.props.children),/AI allowance/,'the cost is announced to assistive technology');
  explain.props.onClick();await f.settle();
  assert.equal(f.calls.explain.length,1);assert.deepEqual(f.calls.explain[0].sent,ticket);
  assert.equal(f.calls.explain[0].question,'What are the main findings in these SQL results? Name the leading rows and how they compare.','no conversation title or earlier question leaks into the request');
  assert.match(f.html,/The latest returned height is 3,534,601\./);
  assert.equal(f.calls.annotate.at(-1).inputMode,'sql');assert.equal(f.calls.annotate.at(-1).fingerprint,result.fingerprint);
  assert.equal(f.button('Explain results'),undefined,'the ticket is consumed; no second paid explanation is offered');
  assert.equal(f.button('Refresh & explain'),undefined,'an explained result is not offered again');
});

test('Explain results is not offered in guided mode',async t=>{
  const guided=await fixture(t,{mode:'guided'});await guided.runSQL();
  assert.equal(guided.calls.submit.length,1);assert.equal(guided.button('Explain results'),undefined);
});
test('Explain results is not offered for a synchronous run without a job ticket',async t=>{
  const synchronous=await fixture(t,{jobsEnabled:false});await synchronous.runSQL();
  assert.equal(synchronous.calls.run.length,1);assert.equal(synchronous.button('Explain results'),undefined);
});

test('an expired job runs its SQL again once, then explains the refreshed result',async t=>{
  const f=await fixture(t,{expired:1});await f.runSQL();
  f.button('Explain results').props.onClick();await f.settle();
  assert.equal(f.calls.submit.length,2,'the SQL is submitted again for a fresh ticket');
  assert.equal(f.calls.explain.length,2);assert.match(f.html,/The latest returned height is 3,534,601\./);
});
test('an explanation that still fails is reported beside the result, not hidden',async t=>{
  const f=await fixture(t,{expired:2});await f.runSQL();
  f.button('Explain results').props.onClick();await f.settle();
  assert.equal(f.calls.submit.length,2,'only one automatic re-run');assert.equal(f.calls.explain.length,2);
  assert.match(f.html,/1 rows returned\. No AI was used\./,'the original answer is kept');
  assert.match(f.html,/Could not explain these results/);
});

const doc=(id,title)=>({id,title,query:result.query,chart:{view:'table',x:0,y:0},result:null});
test('dashboard Refresh all runs each saved query once, in order, and stores the new results',async t=>{
  const f=await fixture(t,{boardId:'board'});const refresh=f.dashboard();
  assert.ok(refresh?.available,'Refresh is offered when SQL jobs are enabled');
  refresh.run([doc('a','First'),doc('b','Second')]);await f.settle();await f.settle();
  assert.equal(f.calls.submit.length,2);assert.deepEqual(f.calls.refreshed.map(item=>item.id),['a','b']);
  assert.match(f.dashboard().status,/Refreshed all 2 analyses/);assert.equal(f.dashboard().running,false);
});
test('a daily SQL limit stops a dashboard refresh and keeps the remaining saved results',async t=>{
  const quota=new ApiError('limit',429,'rate-limited',undefined,'3600','ask-sql-day');
  const f=await fixture(t,{boardId:'board',submitFailures:[undefined,quota]});
  f.dashboard().run([doc('a','First'),doc('b','Second'),doc('c','Third')]);await f.settle();await f.settle();
  assert.equal(f.calls.submit.length,2,'nothing is submitted after the daily limit');
  assert.deepEqual(f.calls.refreshed.map(item=>item.id),['a']);
  assert.match(f.dashboard().status,/Refreshed 1 of 3/);assert.equal(f.calls.reports.at(-1),quota);
});
test('dashboard Refresh is not offered without SQL jobs',async t=>{
  const f=await fixture(t,{boardId:'board',jobsEnabled:false});assert.equal(f.dashboard().available,false);
});
