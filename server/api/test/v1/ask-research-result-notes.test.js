'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchIds,canonicalIds,resultNotes}=require('../../../../lib/ask/research-catalogue');
const {researchResultSchema}=require('../../../../lib/ask/research-contract');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const {createAnalyticsClient}=require('../../v1/lib/ask-analytics-client');

const VERIFIED='verified canonical records',UNVERIFIED='source-defined coverage; independent historical completeness unverified';

test('only canonical chain datasets are labelled verified; everything else defaults to unverified',()=>{
 assert.deepEqual([...canonicalIds].sort(),['activity_daily','blocks','issuance','issuance_daily','transactions']);
 for(const id of canonicalIds)assert.ok(researchIds.includes(id),id);
 for(const id of researchIds)assert.equal(resultNotes([id]).coverage,canonicalIds.includes(id)?VERIFIED:UNVERIFIED,id);
 // Provider, observer, node-reported, registry-attributed and price-based datasets.
 for(const id of ['swap_daily','swaps','mining_daily','software_daily','block_timing','reorgs','orphaned_blocks','utxo_daily','value_pools_daily','supply_daily','labels'])
  assert.equal(resultNotes([id]).coverage,UNVERIFIED,id);
 // One unverified dataset in a join decides the label; a dataset added later is unverified until listed.
 assert.equal(resultNotes(['blocks','transactions']).coverage,VERIFIED);
 assert.equal(resultNotes(['blocks','mining_daily']).coverage,UNVERIFIED);
 assert.equal(resultNotes(['a_future_dataset']).coverage,UNVERIFIED);
 assert.equal(resultNotes([]).coverage,UNVERIFIED);
});

test('units notes name every column that is not zatoshis and always fit the result contract',()=>{
 assert.doesNotMatch(resultNotes(['blocks']).units,/swap_daily|utxo_daily|USD/);
 assert.match(resultNotes(['swap_daily']).units,/swap_daily\.zec is already whole ZEC, not zatoshis; usd is whole USD\./);
 assert.match(resultNotes(['utxo_daily']).units,/utxo_daily\.cdd is ZEC-days; its _usd columns are USD\./);
 assert.match(resultNotes(['swaps']).units,/swaps\.usd is USD\./);
 const all=resultNotes(researchIds);
 assert.ok(all.units.length<=300&&all.coverage.length<=200,String(all.units.length));
 // Order of the dataset list never changes the wording.
 assert.deepEqual(resultNotes(['utxo_daily','swap_daily']),resultNotes(['swap_daily','utxo_daily']));
});

test('worker evidence carries the catalogue notes',async()=>{
 const evidence=async sql=>researchEvidence(await compileResearchSQL({version:3,sql,limit:5},{extended:true}),[['1']],[{name:'n',dataTypeID:1700}],{indexed_through:'2026-11-10T00:00:00Z'},'2026-11-10T00:00:01Z');
 const swaps=await evidence('SELECT sum(zec) AS n FROM swap_daily');
 assert.equal(swaps.coverage,UNVERIFIED);assert.match(swaps.units,/whole ZEC/);
 assert.equal((await evidence('SELECT max(height) AS n FROM blocks')).coverage,VERIFIED);
 assert.equal((await evidence('SELECT max(orchard) AS n FROM value_pools_daily')).coverage,UNVERIFIED);
 researchResultSchema.parse(swaps);
});

test('the API restates notes from its own catalogue when the worker runs an older build',async()=>{
 const env={ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:'k'.repeat(32),ASK_ANALYTICS_SERVICE_URL:'http://127.0.0.1:3015/',ASK_RESEARCH_ENABLED:'true',ASK_RESEARCH_EXTENDED:'true',ASK_ANALYTICS_STORE:'logical_public_core'};
 const query={version:3,sql:'SELECT sum(zec) AS n FROM swap_daily',limit:5};
 const compiled=await compileResearchSQL(query,{extended:true});
 // What the worker build deployed on 2026-11-03 returned on 2026-11-10.
 const stale={query:compiled.request,columns:[{key:'c0',label:'n',type:'number'}],rows:[['971']],truncated:false,datasets:compiled.datasets,fingerprint:compiled.fingerprint,
  retrievedAt:'2026-11-10T21:07:05.050Z',indexedThrough:'2026-11-10T21:05:58.000Z',coverage:VERIFIED,
  units:'Numeric results remain exact decimal strings. Stored ZEC amounts are zatoshis unless the SQL explicitly converts them; 100000000 zatoshis = 1 ZEC.'};
 const client=createAnalyticsClient(env,async()=>new Response(JSON.stringify({research:stale}),{status:200}));
 const {result}=await client.execute(query);
 assert.equal(result.coverage,UNVERIFIED);
 assert.match(result.units,/swap_daily\.zec is already whole ZEC/);
 assert.deepEqual(result.rows,[['971']]);assert.equal(result.fingerprint,compiled.fingerprint);
 researchResultSchema.parse(result);
});
