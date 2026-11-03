'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor,researchCatalogue,isPublished,coreGatedIds}=require('../../../../lib/ask/research-catalogue');
const {coreViews}=require('../../v1/lib/ask-core-catalogue');
const {displaySQL}=require('../../../../lib/ask/sql-display');
const {sqlExamples}=require('../../../../lib/ask/sql-examples');
const deploy=name=>fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8');
const migration=deploy('utxo-daily-v1.sql'),rollback=deploy('utxo-daily-v1-rollback.sql'),grant=deploy('utxo-daily-grant-v1.sql');
const source=deploy('utxo-daily-source-v1.sql'),sourceRollback=deploy('utxo-daily-source-v1-rollback.sql');
const id='utxo_daily',preview={preview:true};
const view=/CREATE VIEW analytics_public\.utxo_daily_query[\s\S]*?;\n/.exec(migration)[0];
const ageColumns='date,lt_1m_zat,b_1_3m_zat,b_3_6m_zat,b_6_12m_zat,b_1_2y_zat,gt_2y_zat,total_unspent_zat,utxo_count,cdd,avg_dormancy_days,spent_count';
const capColumns='date,realized_cap_usd,unspent_count,avg_cost_basis_usd';
// Output column names of the outermost SELECT list: the alias, or the bare column name.
function viewColumns(sql){
 const list=/\n SELECT (u\.date[\s\S]*?)\n FROM public\.utxo_age_daily u/.exec(sql)[1];
 let depth=0,part='';const parts=[];
 for(const ch of list){if(ch==='(')depth++;if(ch===')')depth--;if(ch===','&&depth===0){parts.push(part);part='';}else part+=ch;}
 parts.push(part);
 return parts.map(p=>{p=p.trim();const alias=/\bAS\s+([a-z0-9_]+)$/i.exec(p);return alias?alias[1]:p.split('.').pop();});
}

test('utxo_daily is an unpublished extended dataset until its rollout is verified',async()=>{
 const {cases,pendingCases}=require('../../v1/lib/ask-research-eval-cases');
 assert.equal(isPublished(id),false);assert.equal(isPublished(id,preview),true);
 assert.ok(!catalogueFor(true).some(d=>d.id===id));assert.ok(catalogueFor(true,preview).some(d=>d.id===id));
 assert.ok(!catalogueFor(false,preview).some(d=>d.id===id));
 await assert.rejects(compileResearchSQL({version:3,sql:'SELECT * FROM utxo_daily',limit:1},{extended:true}),/not admitted/);
 assert.deepEqual((await compileResearchSQL({version:3,sql:'SELECT * FROM utxo_daily',limit:1},{extended:true,...preview})).datasets,[id]);
 assert.ok(!coreGatedIds.includes(id));
 assert.doesNotMatch(instructionsFor(true),/read utxo_daily/);
 assert.match(instructionsFor(true,preview),/read utxo_daily \(completed UTC dates from 2016-10-28\)/);
 assert.match(instructionsFor(true,preview),/never SUM unspent or the age columns across dates/);
 assert.match(instructionsFor(true,preview),/daily-price estimates/);
 assert.deepEqual(pendingCases.filter(c=>(c.requires||[]).includes(id)).map(c=>c.id),['utxo_dormant_2026_10']);
 assert.ok(!cases.some(c=>(c.requires||[]).includes(id)));
});

test('catalogue columns are exactly the view columns and semantics are stated',()=>{
 const entry=researchCatalogue.find(d=>d.id===id);
 assert.deepEqual(viewColumns(view),entry.columns.split(', '));
 assert.ok(coreViews.includes('utxo_daily_query'));
 for(const re of [/since 2016-10-28/,/value above zero/,/equal to the node-reported transparent pool/,/sum to unspent/,/coin-days destroyed/,/daily USD price of its creation date/,/estimates/,/never sum them across dates/,/can change slightly/])assert.match(entry.description,re);
});

test('USD columns carry the usd unit, not zatoshi',()=>{
 const quality=fs.readFileSync(path.join(__dirname,'../../v1/lib/ask-research-plan-quality.js'),'utf8');
 assert.match(quality,/name==='usd'\|\|name\.endsWith\('_usd'\)\?'usd'/);
 assert.match(quality,/utxo_daily:\['unspent','age_lt_1m','age_1_3m','age_3_6m','age_6_12m','age_1_2y','age_gt_2y','realized_cap_usd','avg_cost_basis_usd'\]/);
});

test('examples compile in preview; the raw tables stay unreachable',async()=>{
 const examples=sqlExamples.filter(e=>(e.datasets||[]).includes(id));
 assert.deepEqual(examples.map(e=>e.id),['utxo-age-monthly']);
 for(const example of examples){
  const compiled=await compileResearchSQL({version:3,sql:example.sql,limit:50},{extended:true,...preview});
  assert.deepEqual(compiled.datasets,[id],example.id);
  assert.equal(displaySQL(compiled.request.sql).includes('analytics_public'),false);
 }
 for(const sql of ['WITH utxo_daily AS (SELECT 1) SELECT * FROM utxo_daily','SELECT * FROM public.utxo_age_daily','SELECT * FROM transparent_realized_cap_daily'])
  await assert.rejects(compileResearchSQL({version:3,sql,limit:1},{extended:true,...preview}));
});

test('migrations are guarded, keep bookkeeping private and order destination before source',()=>{
 for(const sql of [migration,rollback,grant,source,sourceRollback]){assert.match(sql,/^\\set ON_ERROR_STOP on\n/);assert.match(sql,/COMMIT;\n$/);assert.equal(sql.match(/BEGIN;/g).length,1);}
 assert.match(migration,/current_database\(\)<>'ask_analytics' OR pg_is_in_recovery\(\)/);
 assert.match(migration,/to_regclass\('analytics_public\.value_pools_daily_query'\) IS NULL/);
 assert.doesNotMatch(migration,/\bDROP\b|\bDELETE FROM\b|\bTRUNCATE\b|\bUPDATE\b|\bALTER\b|jsonb/);
 // The reader grant waits for the worker that lists the view (its guard refuses every query otherwise).
 assert.doesNotMatch(migration,/ask_public_reader/);
 assert.deepEqual(grant.match(/GRANT [^;]+;/g),['GRANT SELECT ON analytics_public.utxo_daily_query TO ask_public_reader;']);
 // Destination columns are exactly the published source columns, in order.
 const columns=table=>new RegExp(`CREATE TABLE public\\.${table}\\((.*?)\\);`).exec(migration)[1].split(',').map(c=>c.trim().split(' ')[0]).filter(c=>c!=='PRIMARY').join(',');
 assert.equal(columns('utxo_age_daily'),ageColumns);assert.equal(columns('transparent_realized_cap_daily'),capColumns);
 assert.match(source,new RegExp(`ADD TABLE public\\.utxo_age_daily\\(${ageColumns}\\),public\\.transparent_realized_cap_daily\\(${capColumns}\\);`));
 assert.match(source,new RegExp(`GRANT SELECT\\(${ageColumns}\\) ON public\\.utxo_age_daily TO ask_core_replicator;`));
 assert.match(sourceRollback,new RegExp(`REVOKE SELECT\\(${capColumns}\\) ON public\\.transparent_realized_cap_daily FROM ask_core_replicator;`));
 assert.doesNotMatch(source.match(/(?:GRANT|ADD TABLE)[^;]+;/g).join(''),/created_at/);
 assert.match(source,/Apply utxo-daily-v1\.sql on the analytics store FIRST/);
 assert.match(rollback,/EXISTS\(SELECT FROM pg_subscription_rel WHERE srrelid IN\('public\.utxo_age_daily'::regclass,'public\.transparent_realized_cap_daily'::regclass\)\)/);
 const admission=fs.readFileSync(path.join(__dirname,'../../scripts/ask-core-admission.js'),'utf8');
 assert.match(admission,/WHEN 'utxo_daily' THEN ARRAY\['public\.utxo_age_daily','public\.transparent_realized_cap_daily'\]/);
 assert.match(admission,/'value_pools_daily','utxo_daily'\)/);
});

test('utxo_daily view: renamed columns, rounding, count-guarded realized cap and gating',{skip:process.env.ASK_EVAL_TEST_POSTGRES!=='1',timeout:60000},async t=>{
 const {execFileSync}=require('node:child_process'),{Client}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;assert.ok(bin&&path.isAbsolute(bin));
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{PATH:bin+':/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-utxo-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.mkdirSync(socket,{mode:0o700});let started=false,client;
 t.after(async()=>{try{await client?.end();}catch{/* cluster stop below */}if(started)command('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','fixture','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${socket}'\nshared_buffers='16MB'\nfsync=off\n`);
 started=true;command('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-w','start']);
 client=new Client({host:socket,user:'fixture',database:'postgres'});await client.connect();
 await client.query(`SET TIME ZONE 'UTC';CREATE SCHEMA analytics_public;
  CREATE TABLE public.utxo_age_daily(date date PRIMARY KEY,lt_1m_zat bigint,b_1_3m_zat bigint,b_3_6m_zat bigint,b_6_12m_zat bigint,b_1_2y_zat bigint,gt_2y_zat bigint,total_unspent_zat bigint,utxo_count integer,cdd double precision,avg_dormancy_days double precision,spent_count integer);
  CREATE TABLE public.transparent_realized_cap_daily(date date PRIMARY KEY,realized_cap_usd numeric,unspent_count bigint,avg_cost_basis_usd numeric);
  CREATE TABLE analytics_public.dataset_coverage(dataset text PRIMARY KEY,ready boolean);
  CREATE TABLE analytics_public.coverage(ready boolean);
  INSERT INTO analytics_public.dataset_coverage VALUES('utxo_daily',true);INSERT INTO analytics_public.coverage VALUES(true);
  INSERT INTO public.utxo_age_daily VALUES('2026-10-30',1,2,3,4,5,6,21,100,1234.567891,280.123456,10),('2026-10-31',1,2,3,4,5,7,22,101,0.00004,0,0),((now() AT TIME ZONE 'UTC')::date,1,1,1,1,1,1,6,5,0,0,0);
  -- 10-31 disagrees on the UTXO count (a job ran between the two summaries): its realized cap is withheld.
  INSERT INTO public.transparent_realized_cap_daily VALUES('2026-10-30',8729397191.849414,100,729.25365886),('2026-10-31',1,999,1);`);
 await client.query(view);
 const rows=async()=>(await client.query('SELECT date::text,utxos::int,unspent::text,age_gt_2y::text,spent_outputs::int,cdd::text,avg_dormancy_days::text,realized_cap_usd::text,avg_cost_basis_usd::text FROM analytics_public.utxo_daily_query ORDER BY date')).rows;
 assert.deepEqual(await rows(),[
  {date:'2026-10-30',utxos:100,unspent:'21',age_gt_2y:'6',spent_outputs:10,cdd:'1234.5679',avg_dormancy_days:'280.1235',realized_cap_usd:'8729397191.85',avg_cost_basis_usd:'729.2537'},
  {date:'2026-10-31',utxos:101,unspent:'22',age_gt_2y:'7',spent_outputs:0,cdd:'0.0000',avg_dormancy_days:'0.0000',realized_cap_usd:null,avg_cost_basis_usd:null}]);
 await client.query("UPDATE analytics_public.dataset_coverage SET ready=false");
 assert.equal((await client.query('SELECT count(*)::int AS n FROM analytics_public.utxo_daily_query')).rows[0].n,0);
});
