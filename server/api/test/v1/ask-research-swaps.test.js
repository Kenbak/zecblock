'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor,researchCatalogue,isPublished,coreGatedIds}=require('../../../../lib/ask/research-catalogue');
const {coreViews}=require('../../v1/lib/ask-core-catalogue');
const {displaySQL}=require('../../../../lib/ask/sql-display');
const {sqlExamples}=require('../../../../lib/ask/sql-examples');
const deploy=name=>fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8');
const migration=deploy('swaps-v1.sql'),rollback=deploy('swaps-v1-rollback.sql');
const source=deploy('swaps-source-v1.sql'),sourceRollback=deploy('swaps-source-v1-rollback.sql');
const id='swap_daily';
const preview={preview:true};
const view=/CREATE VIEW analytics_public\.swap_daily_query[\s\S]*?;\n/.exec(migration)[0];
// Output column names of the outermost SELECT list: the alias, or the bare column name.
function viewColumns(sql){
 const list=/\n SELECT (f\.date[\s\S]*?)\n FROM folded f/.exec(sql)[1];
 let depth=0,part='';const parts=[];
 for(const ch of list){if(ch==='(')depth++;if(ch===')')depth--;if(ch===','&&depth===0){parts.push(part);part='';}else part+=ch;}
 parts.push(part);
 return parts.map(p=>{p=p.trim();const alias=/\bAS\s+([a-z_]+)$/i.exec(p);return alias?alias[1]:p.split('.').pop();});
}

test('swap_daily is an unpublished extended dataset until its rollout is verified',async()=>{
 const {cases,pendingCases}=require('../../v1/lib/ask-research-eval-cases');
 assert.equal(isPublished(id),false);assert.equal(isPublished(id,preview),true);
 assert.ok(!catalogueFor(true).some(d=>d.id===id));assert.ok(catalogueFor(true,preview).some(d=>d.id===id));
 assert.ok(!catalogueFor(false,preview).some(d=>d.id===id));
 await assert.rejects(compileResearchSQL({version:3,sql:'SELECT * FROM swap_daily',limit:1},{extended:true}),/not admitted/);
 assert.deepEqual((await compileResearchSQL({version:3,sql:'SELECT * FROM swap_daily',limit:1},{extended:true,...preview})).datasets,[id]);
 assert.ok(!coreGatedIds.includes(id));
 assert.doesNotMatch(instructionsFor(true),/read swap_daily/);
 assert.match(instructionsFor(true,preview),/read swap_daily \(completed UTC dates\)/);
 assert.match(instructionsFor(true,preview),/whole ZEC, not zatoshis/);
 assert.match(instructionsFor(true,preview),/refuse requests to match swaps to transactions or flows/);
 assert.deepEqual(pendingCases.filter(c=>(c.requires||[]).includes(id)).map(c=>c.id),['swap_volume_by_venue_2026_10','swap_linkage_unavailable']);
 assert.ok(!cases.some(c=>(c.requires||[]).includes(id)));
});

test('catalogue columns are exactly the view columns and semantics are stated',()=>{
 const entry=researchCatalogue.find(d=>d.id===id);
 assert.deepEqual(viewColumns(view),entry.columns.split(', '));
 assert.ok(coreViews.includes('swap_daily_query'));
 for(const re of [/near-intents, from 2026-06-14/,/maya, from 2025-05-21/,/thorchain, from 2026-10-02/,/fewer than 5 swaps on a date are folded into chain and token other/,/zec is whole ZEC/,/Individual swap amounts and times are not available/,/not all exchange activity/])assert.match(entry.description,re);
});

test('examples compile in preview; raw swap tables stay unreachable',async()=>{
 const examples=sqlExamples.filter(e=>(e.datasets||[]).includes(id));
 assert.deepEqual(examples.map(e=>e.id),['swap-volume-by-venue','swap-top-chains-30d']);
 for(const example of examples){
  const compiled=await compileResearchSQL({version:3,sql:example.sql,limit:50},{extended:true,...preview});
  assert.deepEqual(compiled.datasets,[id],example.id);
  assert.equal(displaySQL(compiled.request.sql).includes('analytics_public'),false);
 }
 for(const sql of ['WITH swap_daily AS (SELECT 1) SELECT * FROM swap_daily','SELECT * FROM public.crosschain_venue_actions','SELECT source_amount FROM public.cross_chain_swaps'])
  await assert.rejects(compileResearchSQL({version:3,sql,limit:1},{extended:true,...preview}));
});

test('migrations are guarded, keep linkable fields private and order destination before source',()=>{
 assert.match(migration,/^\\set ON_ERROR_STOP on\n/);assert.match(migration,/COMMIT;\n$/);
 assert.match(migration,/current_database\(\)<>'ask_analytics' OR pg_is_in_recovery\(\)/);
 assert.match(migration,/to_regclass\('analytics_public\.reorgs_query'\) IS NULL/);
 // Additive only: the one ALTER TABLE adds the two amount columns.
 assert.doesNotMatch(migration,/\bDROP\b|\bDELETE FROM\b|\bTRUNCATE\b|\bUPDATE\b|\bALTER (?:SUBSCRIPTION|PUBLICATION)\b/);
 assert.deepEqual(migration.match(/ALTER TABLE [^;]+;/g),['ALTER TABLE public.cross_chain_swaps ADD COLUMN source_amount numeric,ADD COLUMN dest_amount numeric;']);
 assert.deepEqual(migration.match(/GRANT [^;]+;/g),['GRANT SELECT ON public.crosschain_venue_actions TO ask_public_view_owner;','GRANT SELECT(source_amount,dest_amount) ON public.cross_chain_swaps TO ask_public_view_owner;','GRANT SELECT ON analytics_public.swap_daily_query TO ask_public_reader;']);
 const added=/ADD TABLE([^;]*);/.exec(source)[1];
 const venue=/CREATE TABLE public\.crosschain_venue_actions\((.*?),PRIMARY KEY/.exec(migration)[1].split(',').map(c=>c.trim().split(' ')[0]);
 const venuePublished=/public\.crosschain_venue_actions\(([^)]*)\)/.exec(added)[1].split(',');
 assert.deepEqual(venue,venuePublished);
 assert.deepEqual(/GRANT SELECT\(([^)]*)\) ON public\.crosschain_venue_actions /.exec(source)[1].split(','),venuePublished);
 // The swaps dataset's nine columns plus the two amounts, re-added in one transaction.
 assert.deepEqual(/public\.cross_chain_swaps\(([^)]*)\)/.exec(added)[1].split(','),['id','status','source_chain','source_token','source_amount_usd','dest_chain','dest_token','dest_amount_usd','swap_created_at','source_amount','dest_amount']);
 assert.match(source,/DROP TABLE public\.cross_chain_swaps;\nALTER PUBLICATION ask_public_core_v1 ADD TABLE/);
 assert.equal(source.match(/BEGIN;/g).length,1);
 // Deposit addresses, memos, senders, recipients, tx hashes, matching state and payloads stay private.
 assert.doesNotMatch(added+source.match(/GRANT [^;]+;/g).join(''),/deposit|memo|sender|recipient|tx_hash|zec_txid|zec_address|matched|match_attempts|payload|canonical_identity|asset|created_at_ns|first_seen|indexed_at/);
 assert.match(source,/Apply swaps-v1\.sql on the\n-- analytics store FIRST/);
 assert.match(sourceRollback,/ADD TABLE public\.cross_chain_swaps\(id,status,source_chain,source_token,source_amount_usd,dest_chain,dest_token,dest_amount_usd,swap_created_at\);/);
 assert.match(rollback,/EXISTS\(SELECT FROM pg_subscription_rel WHERE srrelid='public\.crosschain_venue_actions'::regclass\)/);
 const admission=fs.readFileSync(path.join(__dirname,'../../scripts/ask-core-admission.js'),'utf8');
 assert.match(admission,/WHEN 'swap_daily' THEN ARRAY\['public\.cross_chain_swaps','public\.crosschain_venue_actions'\]/);
 assert.match(admission,/'reorgs','orphaned_blocks','swap_daily'\)/);
});

test('swap_daily view: venues, directions, folding, rounding and suppression',{skip:process.env.ASK_EVAL_TEST_POSTGRES!=='1',timeout:60000},async t=>{
 const {execFileSync}=require('node:child_process'),{Client}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;assert.ok(bin&&path.isAbsolute(bin));
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{PATH:bin+':/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-swaps-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.mkdirSync(socket,{mode:0o700});let started=false,client;
 t.after(async()=>{try{await client?.end();}catch{/* cluster stop below */}if(started)command('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','fixture','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${socket}'\nshared_buffers='16MB'\nfsync=off\n`);
 started=true;command('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-w','start']);
 client=new Client({host:socket,user:'fixture',database:'postgres'});await client.connect();
 await client.query(`SET TIME ZONE 'UTC';CREATE SCHEMA analytics_public;
  CREATE TABLE public.cross_chain_swaps(id integer PRIMARY KEY,status text,source_chain text,source_token text,source_amount_usd numeric,dest_chain text,dest_token text,dest_amount_usd numeric,swap_created_at timestamptz,source_amount numeric,dest_amount numeric);
  CREATE TABLE public.crosschain_venue_actions(venue text,id text,action_type text,status text,swap_created_at timestamptz,source_chain text,source_token text,dest_chain text,dest_token text,zec_amount_zat numeric,source_amount_usd numeric,dest_amount_usd numeric,PRIMARY KEY(venue,id));
  CREATE TABLE analytics_public.dataset_coverage(dataset text PRIMARY KEY,ready boolean);
  INSERT INTO analytics_public.dataset_coverage VALUES('swap_daily',true);`);
 await client.query(view);
 // 2026-10-30: six NEAR swaps eth->ZEC (1.25 ZEC each, one unvalued), two NEAR ZEC->btc,
 // one failed and one zec->zec row (both excluded); Maya: five btc->ZEC, one ZEC->eth,
 // a refund (excluded); THORChain: one zec->zec internal. Today's swaps are hidden.
 await client.query(`INSERT INTO public.cross_chain_swaps SELECT n,'SUCCESS','eth','ETH',CASE WHEN n=6 THEN 0 ELSE 500 END,'zec','ZEC',490,'2026-10-30 10:00Z',0.2,1.25 FROM generate_series(1,6) n;
  INSERT INTO public.cross_chain_swaps VALUES(7,'SUCCESS','zec','ZEC',100,'btc','BTC',99,'2026-10-30 11:00Z',0.33333333,0.001),(8,'SUCCESS','ZEC','ZEC',100,'BTC','BTC',98,'2026-10-30 12:00Z',0.4,0.002),
   (9,'FAILED','eth','ETH',999,'zec','ZEC',999,'2026-10-30 12:00Z',1,100),(10,'SUCCESS','zec','ZEC',1,'zec','ZEC',1,'2026-10-30 12:00Z',1,1),(11,'SUCCESS','eth','ETH',500,'zec','ZEC',490,now(),0.2,7);
  INSERT INTO public.crosschain_venue_actions SELECT 'maya','m'||n,'swap','SUCCESS','2026-10-30 23:59:59Z','btc','BTC','zec','ZEC',123456789,1000,990 FROM generate_series(1,5) n;
  INSERT INTO public.crosschain_venue_actions VALUES('maya','m6','swap','SUCCESS','2026-10-30 01:00Z','zec','ZEC','eth','ETH',50000000,400,390),('maya','m7','refund','REFUNDED','2026-10-30 01:00Z','btc','BTC','zec','ZEC',99900000000,1,1),
   ('thorchain','t1','swap','SUCCESS','2026-10-30 02:00Z','zec','ZEC','zec','ZEC',10000000,40,40);`);
 assert.deepEqual((await client.query('SELECT date::text,venue,direction,chain,token,swaps::int,zec::text,usd::text,missing_zec::int,missing_usd::int FROM analytics_public.swap_daily_query ORDER BY venue,direction,chain')).rows,[
  {date:'2026-10-30',venue:'maya',direction:'inflow',chain:'btc',token:'BTC',swaps:5,zec:'6',usd:'5000',missing_zec:0,missing_usd:0},
  {date:'2026-10-30',venue:'maya',direction:'outflow',chain:'other',token:'other',swaps:1,zec:null,usd:null,missing_zec:0,missing_usd:0},
  {date:'2026-10-30',venue:'near-intents',direction:'inflow',chain:'eth',token:'ETH',swaps:6,zec:'8',usd:'2500',missing_zec:0,missing_usd:1},
  {date:'2026-10-30',venue:'near-intents',direction:'outflow',chain:'other',token:'other',swaps:2,zec:null,usd:null,missing_zec:0,missing_usd:0},
  {date:'2026-10-30',venue:'thorchain',direction:'internal',chain:'other',token:'other',swaps:1,zec:null,usd:null,missing_zec:0,missing_usd:0}]);
 // Rows copied before the source step have NULL amounts until the backfill.
 await client.query('UPDATE public.cross_chain_swaps SET dest_amount=NULL WHERE id IN(1,2)');
 assert.deepEqual((await client.query("SELECT zec,missing_zec::int FROM analytics_public.swap_daily_query WHERE venue='near-intents' AND direction='inflow'")).rows,[{zec:null,missing_zec:2}]);
 await client.query("UPDATE analytics_public.dataset_coverage SET ready=false");
 assert.equal((await client.query('SELECT count(*)::int AS n FROM analytics_public.swap_daily_query')).rows[0].n,0);
});
