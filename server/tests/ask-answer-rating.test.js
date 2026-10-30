'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function load(file,imports={}) {
  const filename=path.resolve(__dirname,'../../'+file),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);
  m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?{default:new Proxy({},{get:(_,key)=>String(key)})}:base(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);return m.exports;
}
const apiClient=load('lib/api-client.ts');
const feedback=load('lib/ask/feedback.ts',{'@/lib/api-client':apiClient,'./api-base':{getAskApiUrl:()=>'/v1/ask'}});
const serverFeedback=require('../api/v1/lib/ask-feedback');
// A deterministic hook runtime: state persists between renders of one instance.
function harness(t,props){
  const states=[],refs=[];let cursor=0;
  const react={...React,useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],next=>{states[i]=typeof next==='function'?next(states[i]):next;}];},useRef(initial){const i=cursor++;if(!(i in refs))refs[i]={current:initial};return refs[i];},useId:()=>'r1'};
  const {AskAnswerRating}=load('components/ask/AskAnswerRating.tsx',{react,'@/lib/ask/feedback':feedback});
  const sent=[],original=global.fetch;let reply={recorded:true,shared:false},fail=false;
  global.fetch=async(url,init)=>{sent.push({url,body:JSON.parse(init.body)});if(fail)return new Response(JSON.stringify({type:'x',title:'x',status:503}),{status:503,headers:{'Content-Type':'application/problem+json'}});return Response.json({data:reply,meta:{network:'mainnet',requestId:'fixture'}});};
  t.after(()=>{global.fetch=original;});
  const render=()=>{cursor=0;return AskAnswerRating(props);};
  const find=(node,match)=>{if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const child of node){const hit=find(child,match);if(hit)return hit;}return null;}if(match(node.props||{}))return node;return find(node.props?.children,match);};
  const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
  return {render,sent,settle,set reply(value){reply=value;},set fail(value){fail=value;},
    click:async(label)=>{const node=find(render(),p=>p['aria-label']===label||p.children===label);assert.ok(node,label);node.props.onClick();await settle();},
    tick:async(checked)=>{const node=find(render(),p=>p.type==='checkbox');node.props.onChange({target:{checked}});await settle();},
    html:()=>renderToStaticMarkup(render())};
}
const props={route:'run_sql',template:true,locale:'en',page:'ask',question:'How much ZEC was shielded last week?',answer:'About 1,200 ZEC.',sql:'SELECT 1'};

test('client enums match the server schema',()=>{
  assert.deepEqual([...feedback.answerRoutes],serverFeedback.routes);assert.deepEqual([...feedback.answerReasons],serverFeedback.reasons);
  assert.equal(feedback.answerRoute('made_up'),'unknown');assert.equal(feedback.feedbackLocale('xx'),'auto');
});

test('renders accessible unpressed thumbs with no reasons or share box before a vote',t=>{
  const h=harness(t,props),html=h.html();
  assert.match(html,/role="group"/);assert.match(html,/aria-label="Useful"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*aria-label="Useful"/);
  assert.doesNotMatch(html,/What went wrong|Share this question|<textarea|type="text"/);
});

test('a vote sends only enums; thumbs down offers fixed reasons and a changed vote replaces the previous one',async t=>{
  const h=harness(t,props);
  await h.click('Not useful');
  assert.deepEqual(h.sent[0],{url:'/v1/ask/feedback',body:{vote:'down',route:'run_sql',template:true,locale:'en',page:'ask'}});
  assert.match(h.html(),/What went wrong/);assert.match(h.html(),/Wrong number/);assert.match(h.html(),/Thanks, your vote was recorded/);
  await h.click('Wrong number');
  assert.deepEqual(h.sent[1].body,{vote:'down',reason:'wrong_number',route:'run_sql',template:true,locale:'en',page:'ask',replaces:{vote:'down'}});
  await h.click('Useful');
  assert.deepEqual(h.sent[2].body,{vote:'up',route:'run_sql',template:true,locale:'en',page:'ask',replaces:{vote:'down',reason:'wrong_number'}});
  assert.doesNotMatch(h.html(),/What went wrong/);
  for(const {body} of h.sent){assert.doesNotMatch(JSON.stringify(body),/shielded|1,200|SELECT/);assert.equal(serverFeedback.feedbackSchema.safeParse(body).success,true);}
});

test('text is sent only after ticking share, and unticking withdraws it',async t=>{
  const h=harness(t,props);
  await h.click('Not useful');h.reply={recorded:true,shared:true};
  await h.tick(true);
  const shared=h.sent[1].body;
  assert.deepEqual(shared.shared,{question:props.question,answer:props.answer,sql:'SELECT 1'});assert.match(shared.shareId,/^[0-9a-f-]{36}$/);assert.deepEqual(shared.replaces,{vote:'down'});
  assert.equal(serverFeedback.feedbackSchema.safeParse(shared).success,true);
  assert.match(h.html(),/vote and this answer were shared/);
  h.reply={recorded:true,shared:false};await h.tick(false);
  assert.deepEqual(h.sent[2].body,{vote:'down',route:'run_sql',template:true,locale:'en',page:'ask',replaces:{vote:'down'},shareId:shared.shareId});
});

test('a failed send restores the previous vote and says so',async t=>{
  const h=harness(t,props);h.fail=true;
  await h.click('Useful');
  const html=h.html();assert.match(html,/Feedback could not be sent/);assert.doesNotMatch(html,/aria-pressed="true"/);
});
