'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor,researchCatalogue,isPublished,coreGatedIds}=require('../../../../lib/ask/research-catalogue');
const {coreViews}=require('../../v1/lib/ask-core-catalogue');
const {displaySQL}=require('../../../../lib/ask/sql-display');
const deploy=name=>fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8');
const migration=deploy('supply-issuance-v1.sql'),rollback=deploy('supply-issuance-v1-rollback.sql');
const source=deploy('supply-issuance-source-v1.sql'),sourceRollback=deploy('supply-issuance-source-v1-rollback.sql');
const preview={preview:true};
const view=name=>new RegExp(`CREATE VIEW analytics_public\\.${name}_query[\\s\\S]*?;\\n`).exec(migration)[0];
// Output column names of a CREATE VIEW: the alias, or the bare column name.
function viewColumns(sql){
 const list=/AS\s+SELECT\s+([\s\S]*?)\s+FROM public\./.exec(sql)[1];
 let depth=0,part='';const parts=[];
 for(const ch of list){if(ch==='('||ch==='[')depth++;if(ch===')'||ch===']')depth--;if(ch===','&&depth===0){parts.push(part);part='';}else part+=ch;}
 parts.push(part);
 return parts.map(p=>{p=p.trim();const alias=/\bAS\s+([a-z_]+)$/i.exec(p);return alias?alias[1]:p.split('.').pop();});
}

// getblocksubsidy from the mainnet node (zakurad, 2026-10-31) at each schedule
// boundary: [height, subsidy, founders, funding streams, lockbox, miner].
const nodeSubsidy=[
 [1,62500,12500,0,0,50000],[9999,624937500,124987500,0,0,499950000],[10000,625062500,125012500,0,0,500050000],
 [19999,1250000000,250000000,0,0,1000000000],[20000,1250000000,250000000,0,0,1000000000],
 [653599,1250000000,250000000,0,0,1000000000],[653600,625000000,125000000,0,0,500000000],
 [1046399,625000000,125000000,0,0,500000000],[1046400,312500000,0,62500000,0,250000000],
 [2726399,312500000,0,62500000,0,250000000],[2726400,156250000,0,12500000,18750000,125000000],
 [3146400,156250000,0,12500000,18750000,125000000],[3364600,156250000,0,12500000,18750000,125000000],
 [3428143,156250000,0,12500000,18750000,125000000],[3543404,156250000,0,12500000,18750000,125000000],
];

// Published 2026-10-31 after the host rollout was verified (supply-issuance.md).
test('supply_daily and issuance are published extended datasets with guidance',async()=>{
 const {cases,pendingCases}=require('../../v1/lib/ask-research-eval-cases');
 for(const id of ['supply_daily','issuance']){
  assert.equal(isPublished(id),true,id);assert.ok(catalogueFor(true).some(d=>d.id===id));assert.ok(!catalogueFor(false).some(d=>d.id===id));
  await assert.rejects(compileResearchSQL({version:3,sql:`SELECT * FROM ${id}`,limit:1}),/not admitted/);
  assert.deepEqual((await compileResearchSQL({version:3,sql:`SELECT * FROM ${id}`,limit:1},{extended:true})).datasets,[id]);
 }
 assert.match(instructionsFor(true),/read supply_daily: a current figure is the latest row/);
 assert.match(instructionsFor(true),/never SUM chain_supply, lockbox or circulating_supply across dates/);
 assert.match(instructionsFor(true),/aggregate issuance/);
 assert.doesNotMatch(instructionsFor(false),/supply_daily|issuance\(/);
 assert.deepEqual(pendingCases.map(c=>c.id),[]);
 for(const id of ['total_supply_current','supply_year_end_closing','issuance_split_2025','net_supply_vs_subsidy'])assert.ok(cases.some(c=>c.id===id),id);
});

test('issuance examples and guidance bound the scan by timestamp',async()=>{
 const {sqlExamples}=require('../../../../lib/ask/sql-examples');
 for(const example of sqlExamples.filter(example=>(example.datasets||[]).includes('issuance'))){
  assert.match(example.sql,/WHERE timestamp >= EXTRACT\(EPOCH FROM [^\n]+\)::bigint/,example.id);
  assert.deepEqual((await compileResearchSQL({version:3,sql:example.sql,limit:10},{extended:true})).datasets,["issuance"],example.id);
 }
 assert.match(instructionsFor(true),/Always bound issuance by a bigint Unix timestamp window/);
});
test('catalogue columns are exactly the published view columns',()=>{
 for(const id of ['supply_daily','issuance']){
  const entry=researchCatalogue.find(d=>d.id===id);
  assert.deepEqual(viewColumns(view(id)),entry.columns.split(', '),id);
  assert.ok(coreViews.includes(id+'_query'));
 }
 assert.ok(coreGatedIds.includes('issuance'));assert.ok(!coreGatedIds.includes('supply_daily'));
 const supply=researchCatalogue.find(d=>d.id==='supply_daily').description,issuance=researchCatalogue.find(d=>d.id==='issuance').description;
 for(const text of [/zatoshis/,/never sum stock columns/,/including the NU6 lockbox/,/null from NU7 activation \(height 3543405\)/])assert.match(supply,text);
 for(const text of [/subsidy = miner_subsidy \+ founders \+ funding_streams \+ lockbox/,/not new issuance/,/maximum claimable/,/null from NU7 activation/])assert.match(issuance,text);
});

test('previewed datasets compile to the reviewed views and display by name',async()=>{
 const supply=await compileResearchSQL({version:3,sql:'SELECT date,chain_supply,circulating_supply FROM supply_daily ORDER BY date DESC LIMIT 1',limit:1},{extended:true,...preview});
 assert.deepEqual(supply.datasets,['supply_daily']);assert.match(supply.text,/analytics_public\.supply_daily_query/);
 assert.equal(displaySQL(supply.request.sql).includes('analytics_public'),false);
 const split=await compileResearchSQL({version:3,sql:"SELECT date_trunc('year',to_timestamp(timestamp)) AS year,sum(miner_subsidy) AS miner,sum(funding_streams) AS streams,sum(lockbox) AS lockbox FROM issuance GROUP BY 1 ORDER BY 1",limit:20},{extended:true,...preview});
 assert.deepEqual(split.datasets,['issuance']);
 for(const sql of ['WITH issuance AS (SELECT height FROM blocks) SELECT * FROM issuance','WITH supply_daily AS (SELECT 1) SELECT * FROM supply_daily','SELECT * FROM public.chain_supply_daily','SELECT * FROM analytics_meta.dataset_state'])
  await assert.rejects(compileResearchSQL({version:3,sql,limit:1},{extended:true,...preview}));
});

test('migrations are guarded, additive and ordered destination before source',()=>{
 assert.match(migration,/^\\set ON_ERROR_STOP on\n/);assert.match(migration,/COMMIT;\n$/);
 assert.match(migration,/current_database\(\)<>'ask_analytics' OR pg_is_in_recovery\(\)/);
 assert.doesNotMatch(migration,/\bDROP\b|\bDELETE FROM\b|\bTRUNCATE\b|\bALTER (?:TABLE|SUBSCRIPTION|PUBLICATION)\b/);
 assert.deepEqual(migration.match(/GRANT [^;]+;/g),['GRANT SELECT ON public.chain_supply_daily TO ask_public_view_owner;','GRANT SELECT ON analytics_public.supply_daily_query,analytics_public.issuance_query TO ask_public_reader;']);
 // The destination table and the published column list must be identical, or apply stops.
 const destination=/CREATE TABLE public\.chain_supply_daily\((.*?)\);/.exec(migration)[1].split(',').map(c=>c.trim().split(' ')[0]).filter(c=>c!=='PRIMARY');
 const published=/ADD TABLE public\.chain_supply_daily\(([^)]*)\)/.exec(source)[1].split(',');
 assert.deepEqual(destination,published);
 assert.deepEqual(/GRANT SELECT\(([^)]*)\) ON public\.chain_supply_daily/.exec(source)[1].split(','),published);
 assert.doesNotMatch(source,/\bsource\b,|computed_at/);
 assert.match(source,/current_database\(\)<>'zcash_explorer_mainnet'/);assert.match(source,/Apply supply-issuance-v1\.sql on the analytics store FIRST/);
 assert.match(sourceRollback,/DROP TABLE public\.chain_supply_daily;/);
 assert.match(rollback,/EXISTS\(SELECT FROM pg_subscription_rel WHERE srrelid='public\.chain_supply_daily'::regclass\)/);
 assert.match(rollback,/DROP VIEW analytics_public\.supply_daily_query,analytics_public\.issuance_query;/);
 const admission=fs.readFileSync(path.join(__dirname,'../../scripts/ask-core-admission.js'),'utf8');
 assert.match(admission,/WHEN 'supply_daily' THEN 'public\.chain_supply_daily'/);assert.match(admission,/'address_activity','supply_daily'\)/);
});

// Executes the migration's own view text against node-verified vectors. Opt-in
// like the other disposable-cluster tests; PostgreSQL 14+ is enough for it.
test('consensus subsidy views match node getblocksubsidy and the node lockbox balance',{skip:process.env.ASK_EVAL_TEST_POSTGRES!=='1',timeout:45000},async t=>{
 const {execFileSync}=require('node:child_process'),{Client}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;assert.ok(bin&&path.isAbsolute(bin));
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{PATH:bin+':/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-issuance-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.mkdirSync(socket,{mode:0o700});let started=false,client;
 t.after(async()=>{try{await client?.end();}catch{/* cluster stop below */}if(started)command('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','fixture','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${socket}'\nshared_buffers='16MB'\nfsync=off\n`);
 started=true;command('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-w','start']);
 client=new Client({host:socket,user:'fixture',database:'postgres'});await client.connect();
 await client.query(`SET TIME ZONE 'UTC';CREATE SCHEMA analytics_public;
  CREATE TABLE public.blocks(height bigint PRIMARY KEY,hash text,timestamp bigint,total_fees bigint);
  CREATE TABLE public.chain_supply_daily(date date PRIMARY KEY,block_height bigint,block_hash text,block_time bigint,chain_supply_zat bigint);
  CREATE VIEW analytics_public.coverage AS SELECT true AS ready,0::bigint AS covered_from,3600000::bigint AS covered_through;
  CREATE VIEW analytics_public.dataset_coverage AS SELECT 'supply_daily'::text AS dataset,true AS ready;`);
 await client.query(view('supply_daily')+view('issuance'));
 const heights=[...nodeSubsidy.map(v=>v[0]),3146399,3146401,3543405,3543406];
 await client.query("INSERT INTO public.blocks SELECT h,md5(h::text),1477000000+h*75,CASE WHEN h=3543406 THEN NULL ELSE 7 END FROM unnest($1::bigint[]) h",[heights]);
 const rows=(await client.query('SELECT height::int,subsidy::text,founders::text,funding_streams::text,lockbox::text,miner_subsidy::text,lockbox_disbursed::text,fees::text FROM analytics_public.issuance_query ORDER BY height')).rows;
 const at=h=>rows.find(r=>r.height===h);
 for(const [height,...expected] of nodeSubsidy)assert.deepEqual([at(height).subsidy,at(height).founders,at(height).funding_streams,at(height).lockbox,at(height).miner_subsidy].map(Number),expected,String(height));
 assert.equal(at(3146400).lockbox_disbursed,'7875000000000');assert.equal(at(3146399).lockbox_disbursed,'0');assert.equal(at(3146401).lockbox_disbursed,'0');
 // ZIP 234 makes NU7 issuance state-dependent: unknown, never zero.
 for(const h of [3543405,3543406])assert.deepEqual(Object.values(at(h)).slice(1,7),[null,null,null,null,null,null]);
 assert.equal(at(3543406).fees,null);assert.equal(at(3543405).fees,'7');
 // Node pool sample at height 3537015: lockbox 7324050000000 zat.
 await client.query("INSERT INTO public.blocks VALUES(3537015,'tip',1793420000,0),(2726399,'pre',1716000000,0) ON CONFLICT DO NOTHING");
 await client.query("INSERT INTO public.chain_supply_daily VALUES('2024-11-22',2726399,md5('2726399'),1716000000,1),('2026-10-27',3146401,md5('3146401'),1793300000,1701345485304480),('2026-10-28',3537015,'tip',1793420000,1701524391554480),('2026-10-29',3543405,md5('3543405'),1793500000,1701600000000000),('2026-10-30',3543406,'not-canonical',1793500100,1)");
 const supply=(await client.query('SELECT date::text,lockbox::text,circulating_supply::text,net_change::text FROM analytics_public.supply_daily_query ORDER BY date')).rows;
 assert.deepEqual(supply,[
  {date:'2024-11-22',lockbox:'0',circulating_supply:'1',net_change:null},
  {date:'2026-10-27',lockbox:String(18750000*(3146401-2726399)-7875000000000),circulating_supply:String(1701345485304480-(18750000*(3146401-2726399)-7875000000000)),net_change:null},
  {date:'2026-10-28',lockbox:'7324050000000',circulating_supply:String(1701524391554480-7324050000000),net_change:'178906250000'},
  {date:'2026-10-29',lockbox:null,circulating_supply:null,net_change:String(1701600000000000-1701524391554480)}]);
});
