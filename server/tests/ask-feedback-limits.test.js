'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function load(file,imports={}) {
  const filename=path.resolve(__dirname,'../../'+file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);
  m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?{default:new Proxy({},{get:(_,key)=>String(key)})}:base(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);return m.exports;
}
const {ApiError}=load('lib/api-client.ts');
const client=load('lib/ask/client.ts',{'@/lib/api-client':{ApiError},'./api-base':{getAskApiUrl:()=>'/v1/ask'}});
function harness(t) {
  let now=Date.parse('2026-10-27T00:00:00Z'),cursor=0,sequence=0,pending=[];
  const states=[],effects=[],timers=new Map(),original={now:Date.now,setTimeout:global.setTimeout,clearTimeout:global.clearTimeout};
  Date.now=()=>now;global.setTimeout=(run,delay)=>{const id=++sequence;timers.set(id,{run,delay});return id;};global.clearTimeout=id=>timers.delete(id);
  const react={
    useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];},
    useEffect(run,deps){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))pending.push(()=>{previous?.cleanup?.();effects[index]={deps,cleanup:run()};});},
  };
  const {useAskFeedback}=load('components/ask/AskFeedback.tsx',{react,'@/lib/ask/client':client});
  t.after(()=>{for(const effect of effects)effect?.cleanup?.();Date.now=original.now;global.setTimeout=original.setTimeout;global.clearTimeout=original.clearTimeout;});
  return {
    render(mode='ask'){
      cursor=0;pending=[];
      // The deterministic hook runtime above owns state/effect execution.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const feedback=useAskFeedback(mode);for(const effect of pending)effect();return feedback;
    },
    advance(milliseconds){now+=milliseconds;},
    timer(){assert.equal(timers.size,1);return [...timers.entries()][0];},
    fire(){const[id,timer]=this.timer();timers.delete(id);timer.run();},
  };
}
const quota=(code,seconds)=>new ApiError('private-secret',429,undefined,undefined,String(seconds),code);

test('AI and SQL limits stay attached to their modes, persist on switchback, and cannot be cleared early',t=>{
  const h=harness(t);let feedback=h.render();feedback.report(quota('ask-ai-budget-month',2678400),'ask');
  feedback=h.render();assert.equal(feedback.blocked,true);assert.equal(feedback.failure.scope,'ai');assert.equal(feedback.blockedFor('sql'),false);
  feedback=h.render('sql');assert.equal(feedback.failure,null);assert.equal(feedback.blocked,false);feedback.clear();
  feedback=h.render('ask');assert.equal(feedback.blocked,true);assert.match(feedback.failure.detail,/monthly usage allowance/);
  feedback.clear('sql');feedback=h.render('ask');assert.equal(feedback.blocked,true);
  feedback.report(quota('ask-sql-day',600),'sql');feedback=h.render('sql');assert.equal(feedback.failure.scope,'sql');assert.equal(feedback.blocked,true);
  feedback.clear();feedback=h.render('sql');assert.equal(feedback.blocked,true);
  feedback=h.render('ask');const deadline=feedback.failure.retryAt;feedback.report(quota('ask-ai-busy',1),'ask');
  feedback=h.render('ask');assert.equal(feedback.failure.retryAt,deadline);assert.match(feedback.failure.detail,/monthly/);
});
test('request limits apply to both modes and each mode unlocks only after its own earned reset',t=>{
  const h=harness(t);let feedback=h.render();feedback.report(quota('ask-ai-day',1200),'ask');feedback=h.render();feedback.report(quota('ask-sql-day',900),'sql');feedback=h.render();feedback.report(quota('ask-request-day',600),'ask');
  feedback=h.render();assert.equal(feedback.blockedFor('ask'),true);assert.equal(feedback.blockedFor('sql'),true);
  h.advance(600000);h.fire();feedback=h.render('sql');feedback.clear('sql');
  feedback=h.render('sql');assert.equal(feedback.blocked,true);assert.equal(feedback.failure.scope,'sql');assert.equal(feedback.blockedFor('ask'),true);
  h.advance(300000);h.fire();feedback=h.render('sql');assert.equal(feedback.blocked,false);assert.equal(feedback.blockedFor('ask'),true);feedback.clear();
  assert.equal(h.render('sql').failure,null);assert.equal(h.render('ask').blocked,true);
  h.advance(300000);h.fire();feedback=h.render('ask');assert.equal(feedback.blocked,false);assert.equal(feedback.blockedFor('sql'),false);
});
test('legacy connection quotas block both modes; ordinary failures appear only in the mode that submitted them',t=>{
  const h=harness(t);let feedback=h.render();feedback.report(quota('ask-quota-day',60),'ask');
  feedback=h.render('sql');assert.equal(feedback.failure.scope,'request');assert.equal(feedback.blocked,true);feedback.clear();assert.equal(h.render('ask').blocked,true);
  h.advance(60000);h.fire();feedback=h.render('ask');feedback.clear();feedback=h.render('sql');assert.equal(feedback.failure,null);
  feedback.report(new ApiError('private-secret',503,undefined,undefined,null,'ask-source'),'sql');feedback=h.render('ask');assert.equal(feedback.failure,null);
  feedback=h.render('sql');assert.match(feedback.failure.detail,/Source data/);assert.equal(feedback.blocked,false);assert.doesNotMatch(feedback.failure.detail,/private-secret/);
});
test('monthly timers are bounded and do not unlock at the browser timer overflow boundary',t=>{
  const h=harness(t);let feedback=h.render();feedback.report(quota('ask-ai-budget-month',2678400),'ask');feedback=h.render();
  assert.equal(h.timer()[1].delay,2147483647);h.advance(2147483647);h.fire();feedback=h.render();
  assert.equal(feedback.blocked,true);assert.equal(h.timer()[1].delay,2678400000-2147483647);
  h.advance(2678400000-2147483647);h.fire();feedback=h.render();assert.equal(feedback.blocked,false);
});
test('cross-workflow quota errors remain visible at their origin while only their actual bucket is blocked',t=>{
  const h=harness(t);let feedback=h.render('ask');feedback.report(quota('ask-sql-day',60),'ask');
  feedback=h.render('ask');assert.equal(feedback.failure.scope,'sql');assert.equal(feedback.blocked,false);assert.equal(feedback.requestBlocked,false);assert.equal(feedback.failureBlocked,true);assert.equal(feedback.blockedFor('sql'),true);
  feedback=h.render('sql');assert.equal(feedback.failure.scope,'sql');assert.equal(feedback.blocked,true);assert.equal(feedback.failureBlocked,true);
  h.advance(60000);h.fire();feedback=h.render('ask');assert.equal(feedback.failureBlocked,false);assert.equal(feedback.blockedFor('sql'),false);
  feedback.clear('ask');assert.equal(h.render('ask').failure,null);
});
test('acknowledging a foreign-bucket origin error keeps its earned restriction in the matching mode',t=>{
  const h=harness(t);let feedback=h.render('sql');feedback.report(quota('ask-ai-day',60),'sql');
  feedback=h.render('sql');assert.equal(feedback.failure.scope,'ai');assert.equal(feedback.failureBlocked,true);assert.equal(feedback.blocked,false);
  feedback.clear('sql');feedback=h.render('sql');assert.equal(feedback.failure,null);assert.equal(feedback.blockedFor('ask'),true);
  feedback=h.render('ask');assert.equal(feedback.failure.scope,'ai');assert.equal(feedback.failureBlocked,true);
});

async function workspaceFixture(t,scope) {
  const states=[],effects=[],elements=[],calls=[];let cursor=0,pending=[];
  const original={window:global.window,document:global.document,fetch:global.fetch,setInterval:global.setInterval,clearInterval:global.clearInterval,requestAnimationFrame:global.requestAnimationFrame};
  global.window={location:{hash:''},addEventListener(){},removeEventListener(){}};global.document={visibilityState:'visible'};
  global.fetch=async()=>new Response('{}');global.setInterval=()=>1;global.clearInterval=()=>{};global.requestAnimationFrame=fn=>fn();
  const react={
    useState(initial){const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];},
    useRef(initial){const index=cursor++;return states[index]||(states[index]={current:initial});},
    useEffect(run,deps){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))pending.push(()=>{previous?.cleanup?.();effects[index]={deps,cleanup:run()};});},
  };
  const failure=client.askFailure(quota(scope==='request'?'ask-request-day':scope==='sql'?'ask-sql-day':'ask-ai-day',60));
  const feedback={failure,failureBlocked:true,requestBlocked:scope==='request',blocked:scope!=='sql',blockedFor:mode=>scope==='request'||scope===(mode==='sql'?'sql':'ai'),clear(){},report(){}};
  const runtime=require('react/jsx-runtime');const capture=fn=>(type,props,...rest)=>{elements.push({type,props});return fn(type,props,...rest);};
  const imports={
    react,'react/jsx-runtime':{...runtime,jsx:capture(runtime.jsx),jsxs:capture(runtime.jsxs)},
    'next/link':{default:({children,...props})=>React.createElement('a',props,children)},
    '@/lib/ask/contract':require('../../lib/ask/contract'),
    '@/lib/ask/api-base':{getAskApiUrl:()=>'/v1/ask',isAuthenticatedAskStaging:()=>true},
    '@/lib/api-client':{readApiResponse:async()=>({data:{mode:'ai',provider:'OpenAI',researchEnabled:true},meta:{network:'mainnet'}})},
    './ResearchWorkbench':{useResearchTools:()=>({library:{documents:[]},importing:false,title:'Analysis'}),ResearchLibrary:()=>null,ResearchEditor:()=>null,ResearchDashboard:()=>null,ResearchPanel:()=>null,ResearchData:()=>null},
    '@/lib/ask/research-job-contract':{},'@/lib/ask/research-client':{},'@/lib/ask/research-display': require('../../lib/ask/research-display'), '@/lib/ask/research-contract':{},
    '@/components/ask/AskChallenge':{AskChallenge:()=>null},'@/components/ask/AskTransactions':{AskTransactions:()=>null},'@/components/ask/AskBlocks':{AskBlocks:()=>null},'@/components/ask/AskTransfers':{AskTransfers:()=>null},'@/components/ask/AskAnalytics':{AskAnalytics:()=>null},'@/components/ask/AskSources':{AskSources:()=>null},
    '@/lib/ask/client':{peekAskHandoff:()=>null,clearAskHandoff(){},askChat:async question=>{calls.push(question);return{answer:'A block contains confirmed transactions.',sources:[],spec:null,locale:'en',mode:'ai'};}},
    '@/lib/ask/composer':require('../../lib/ask/composer'),
    '@/components/ask/AskAnswerRating':{AskAnswerRating:()=>null},'@/components/ask/AskFeedback':{AskFeedback:()=>null,AskFailureFeedback:()=>null,useAskFeedback:()=>feedback},
    '@/lib/ask/data':require('../../lib/ask/data'),'@/lib/ask/research-share':require('../../lib/ask/research-share'),'@/lib/ask/follow-ups':require('../../lib/ask/follow-ups'),...require('./ask-sql-test-imports'),
    './AskAnalysis':{AskAnalysis:()=>null},
  };
  const {AskWorkspace}=load('app/ask/AskWorkspace.tsx',imports);
  function render(){cursor=0;pending=[];elements.length=0;renderToStaticMarkup(React.createElement(AskWorkspace));for(const effect of pending)effect();}
  t.after(()=>{for(const effect of effects)effect?.cleanup?.();for(const[key,value]of Object.entries(original)){if(value===undefined)delete global[key];else global[key]=value;}});
  render();await new Promise(resolve=>setImmediate(resolve));render();
  return{calls,render,elements,feedback};
}
for(const scope of ['ai','sql','request'])test(`${scope} quota composer: explicit Ask still reaches server-side direct-answer selection unless request admission is blocked`,async t=>{
  const fixture=await workspaceFixture(t,scope);
  const question='How does a Zcash block work?';
  fixture.elements.find(item=>item.type==='textarea').props.onChange({target:{value:question}});fixture.render();
  const send=fixture.elements.find(item=>item.type==='button'&&item.props['aria-label']==='Send question');
  assert.equal(send.props.disabled,scope==='request');
  const warning=fixture.elements.find(item=>typeof item.type==='function'&&item.props.failure);assert.equal(warning.props.blocked,true);
  fixture.elements.find(item=>item.type==='form').props.onSubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fixture.calls,scope==='request'?[]:[question]);
});
test('SQL bucket still disables raw SQL without erasing the Ask draft',async t=>{
  const fixture=await workspaceFixture(t,'sql'),question='How does a Zcash block work?';
  fixture.elements.find(item=>item.type==='textarea').props.onChange({target:{value:question}});fixture.render();
  fixture.elements.find(item=>item.type==='button'&&item.props.children==='SQL').props.onClick();fixture.render();
  // SQL mode renders the editor component; it reports plain strings.
  fixture.elements.find(item=>item.props?.datasets&&typeof item.props.onRun==='function').props.onChange('SELECT height FROM blocks LIMIT 1');fixture.render();
  assert.equal(fixture.elements.find(item=>item.type==='button'&&item.props['aria-label']==='Run SQL').props.disabled,true);
  fixture.elements.find(item=>item.type==='form').props.onSubmit({preventDefault(){}});assert.deepEqual(fixture.calls,[]);
  fixture.elements.find(item=>item.type==='button'&&item.props.children==='Ask').props.onClick();fixture.render();
  assert.equal(fixture.elements.find(item=>item.type==='textarea').props.value,question);
  assert.equal(fixture.elements.find(item=>item.type==='button'&&item.props['aria-label']==='Send question').props.disabled,false);
});
