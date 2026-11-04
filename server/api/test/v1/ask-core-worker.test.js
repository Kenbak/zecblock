const test=require('node:test');
const assert=require('node:assert/strict');
const {analyticsConfig,checkCoreGuard}=require('../../v1/lib/ask-analytics');
const {compileCorePlan,coreCatalogue}=require('../../v1/lib/ask-core-catalogue');
const env={ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core',ASK_ANALYTICS_DATABASE_URL:'peer-only',ASK_ANALYTICS_SOCKET:'/run/ask-public-db',ASK_ANALYTICS_DAILY_QUERY_LIMIT:'20'};
const plan={version:2,dataset:'transactions',start:'2026-09-01',end:'2026-09-30',bucket:'week',dimensions:[],filters:[],measures:[{field:'records',operation:'count',filters:[]}],calculations:[],order:{column:1,direction:'desc'},limit:5};
test('dedicated worker requires its peer socket and exactly three reviewed datasets',()=>{
 assert.equal(analyticsConfig(env).profile,'logical_public_core');
 for(const change of [{ASK_ANALYTICS_SOCKET:'/run/ask-source-transport'},{ASK_ANALYTICS_DATABASE_URL:'postgres://postgres@primary/db'},{ASK_ANALYTICS_STORE:'primary'},{ASK_ANALYTICS_DAILY_QUERY_LIMIT:'10001'}])assert.equal(analyticsConfig({...env,...change}),null);
 assert.deepEqual(coreCatalogue.map(x=>x.dataset),['blocks','transactions','flows']);
 assert.match(compileCorePlan(plan).text,/analytics_public\.transactions_query/);
 for(const change of [{dataset:'daily'},{dataset:'swaps'},{sql:'DELETE FROM blocks'},{measures:[{field:'orchard_actions',operation:'sum',filters:[]}]}])assert.throws(()=>compileCorePlan({...plan,...change}));
});
test('every dedicated database privilege boundary is mandatory',()=>{
 const row=Object.fromEntries(['dedicated','identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers'].map(x=>[x,true]));
 checkCoreGuard(row);for(const key of Object.keys(row))assert.throws(()=>checkCoreGuard({...row,[key]:false}));
 assert.throws(()=>checkCoreGuard(null));
});

test('core provenance certifies reconciled chain records but never flow completeness',()=>{
 const {evidenceFor}=require('../../v1/lib/ask-analytics');
 const rows=[{d0:'2026-09-14',m0:'10.000000',u0:'0'}];
 const coverage={observed_days:null,indexed_through:'2026-10-06T00:00:00Z',consistency:'verified-canonical-core'};
 assert.equal(evidenceFor(compileCorePlan(plan),rows,coverage,'2026-10-06T00:00:00Z').result.coverage.completeness,'canonical-records');
 assert.equal(evidenceFor(compileCorePlan({...plan,dataset:'flows'}),rows,coverage,'2026-10-06T00:00:00Z').result.coverage.completeness,'unverified');
 assert.equal(evidenceFor(compileCorePlan(plan),rows,{...coverage,indexed_through:'2026-09-15T00:00:00Z'},'2026-10-06T00:00:00Z').result.coverage.completeness,'unverified');
});
test('decorative foreign symbols cannot enter a validated numerical narrative',()=>{
 const {renderExplanation}=require('../../v1/lib/ask-explanation');
 assert.throws(()=>renderExplanation({summary:'During ௳{{date}}.',observations:[],limitation:''},{date:'1 Sept 2026'}));
});
test('ranked bucket evidence distinguishes full leading weeks from calendar edges',async()=>{
 const {queryReply}=require('../../v1/lib/ask-query-reply');
 const result={plan:{...plan,dataset:'flows'},columns:[{key:'d0',type:'date',unit:''}],rows:[{d0:{value:'2026-09-21'}},{d0:{value:'2026-08-31'}}],coverage:{indexedThrough:'2026-10-06T00:00:00Z'}};
 let supplied;
 await queryReply({result,facts:{}},{question:'Busiest deshielding weeks',history:[]},async(input)=>{supplied=input.evidence.facts;return{summary:'The leading period is {{row_a_da}}.',observations:[],limitation:''};},'en',()=>({instruction:''}));
 assert.equal(supplied.row_a_bucket_status,'complete calendar bucket');
 assert.equal(supplied.row_b_bucket_status,'partial calendar bucket');
 assert.match(supplied.row_a_da,/21.*27/);
 assert.match(supplied.row_b_da,/1.*6/);
});
