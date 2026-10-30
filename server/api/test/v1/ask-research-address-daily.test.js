'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {parse}=require('pgsql-parser');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor,researchCatalogue}=require('../../../../lib/ask/research-catalogue');
const {coreViews}=require('../../v1/lib/ask-core-catalogue');
const {addressDistinctDiagnostics}=require('../../v1/lib/ask-research-address-performance');
const {displaySQL}=require('../../../../lib/ask/sql-display');
const {refreshAddressDaily}=require('../../scripts/refresh-ask-summaries');
const deploy=name=>fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8');
const migration=deploy('address-daily-v1.sql'),rollback=deploy('address-daily-v1-rollback.sql'),destination=deploy('catalogue-destination-v1.sql');
const columns='date, active_addresses, sending_addresses, receiving_addresses, new_addresses, incidences, input_incidences, output_incidences';
const coverageView=sql=>/CREATE (?:OR REPLACE )?VIEW analytics_public\.dataset_coverage[\s\S]*?;\n/.exec(sql)[0].replace('CREATE OR REPLACE VIEW','CREATE VIEW');

test('address_daily is an extended-only published summary with the migrated columns',async()=>{
 const entry=researchCatalogue.find(d=>d.id==='address_daily');
 assert.equal(entry.columns,columns);assert.ok(catalogueFor(true).includes(entry));assert.ok(!catalogueFor(false).includes(entry));
 const table=/CREATE TABLE analytics_meta\.address_daily\((.*?)\);/.exec(migration)[1].split(',').map(c=>c.trim().split(' ')[0]).filter(c=>c!=='PRIMARY');
 assert.deepEqual(table,columns.split(', '));
 assert.match(entry.description,/not additive/);assert.match(entry.description,/coinbase/);assert.match(entry.description,/not people/);
 const q={version:3,sql:"SELECT date,active_addresses,incidences FROM address_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01' ORDER BY date",limit:31};
 await assert.rejects(compileResearchSQL(q),/not admitted/);
 const c=await compileResearchSQL(q,{extended:true});
 assert.deepEqual(c.datasets,['address_daily']);assert.match(c.text,/analytics_public\.address_daily_query/);assert.deepEqual(c.shape,{features:[],span:'month'});
 assert.equal(displaySQL(c.request.sql).includes('analytics_public'),false);
 assert.ok(coreViews.includes('address_daily_query'));
 for(const sql of ['WITH address_daily AS (SELECT height FROM blocks) SELECT * FROM address_daily','SELECT * FROM analytics_meta.address_daily','SELECT * FROM analytics_meta.address_daily_dirty_days','DELETE FROM address_daily'])await assert.rejects(compileResearchSQL({version:3,sql,limit:10},{extended:true}),sql);
});

test('guidance prefers address_daily for per-day address counts and forbids summing distinct counts',()=>{
 const text=instructionsFor(true);
 assert.match(text,/read address_daily directly instead of scanning address_activity/);
 assert.match(text,/Never SUM daily address counts to report the distinct addresses of a week, month or year/);
 assert.match(text,/address_daily for daily transparent address counts/);
 assert.match(text,/avoid address_activity, activity_daily, address_daily, flow_daily/);
 assert.match(text,/correlated per-day count subqueries against address_activity/);
 assert.doesNotMatch(instructionsFor(false),/address_daily/);
});

test('the daily address eval case is answered from the summary with unchanged measures',async()=>{
 const {cases}=require('../../v1/lib/ask-research-eval-cases'),{benchmarks}=require('../../v1/lib/ask-research-benchmarks');
 const item=cases.find(c=>c.id==='daily_address_incidences');
 const c=await compileResearchSQL({version:3,sql:item.referenceSQL,limit:100},{extended:true});
 assert.deepEqual(c.datasets,['address_daily']);assert.deepEqual(item.roles,['date','count','count']);
 assert.equal(item.minRows,30);assert.equal(item.answerCheck.valueColumn,2);assert.match(item.question,/distinct active transparent addresses/);
 assert.deepEqual(addressDistinctDiagnostics(await parse(c.request.sql)),[]);
 // The raw benchmark keeps the per-day DISTINCT/count(*) meaning the summary stores.
 const raw=benchmarks.find(b=>b.id==='address_incidence').sql;
 assert.match(raw,/count\(DISTINCT a\.address\)/);assert.match(raw,/count\(\*\) FROM address_activity/);
});

test('the month-wide distinct hint points to address_daily first and keeps the raw repair',async()=>{
 const sql="SELECT to_char(to_timestamp(timestamp),'YYYY-MM-DD') AS day,count(DISTINCT address),count(*) FROM address_activity WHERE timestamp>=1788220800 AND timestamp<1790812800 GROUP BY 1";
 const c=await compileResearchSQL({version:3,sql,limit:100},{extended:true});
 const [hint]=addressDistinctDiagnostics(await parse(c.request.sql));
 assert.match(hint,/read address_daily for the same dates instead/);assert.match(hint,/Otherwise drive from activity_daily/);
});

test('migration is additive, guarded and grants only the published view',()=>{
 assert.match(migration,/^\\set ON_ERROR_STOP on\n/);assert.match(migration,/^BEGIN;$/m);assert.match(migration,/COMMIT;\n$/);
 assert.match(migration,/current_database\(\)<>'ask_analytics' OR pg_is_in_recovery\(\)/);
 assert.match(migration,/to_regclass\('analytics_meta\.address_daily'\) IS NOT NULL/);
 assert.match(migration,/CREATE TABLE analytics_meta\.address_daily_dirty_days/);
 assert.doesNotMatch(migration,/INSERT INTO analytics_meta\.summary_dirty_days/);
 assert.doesNotMatch(migration,/\bDROP\b|\bDELETE FROM\b|\bTRUNCATE (?:TABLE )?(?:public|analytics)/);
 assert.deepEqual(migration.match(/GRANT [^;]+;/g),['GRANT SELECT ON analytics_meta.address_daily,analytics_meta.address_daily_dirty_days TO ask_public_view_owner;','GRANT SELECT ON analytics_public.address_daily_query TO ask_public_reader;']);
 for(const table of ['blocks','transactions','address_transactions'])assert.match(migration,new RegExp(`ALTER TABLE public\\.${table} ENABLE ALWAYS TRIGGER ask_address_day`));
 // dataset_coverage keeps every original rule; rollback restores it byte for byte.
 const original=coverageView(destination),replaced=coverageView(migration);
 assert.equal(replaced.replace(" WHEN d.dataset='address_daily' THEN NOT EXISTS(SELECT FROM analytics_meta.address_daily_dirty_days WHERE date<CURRENT_DATE)",''),original);
 assert.equal(coverageView(rollback),original);
 assert.match(rollback,/DROP VIEW analytics_public\.address_daily_query/);assert.match(rollback,/DROP FUNCTION analytics_meta\.track_address_day\(\)/);
});

function fakePool(rows){const sent=[];return {sent,connect:async()=>({query:async(sql)=>{sent.push(String(sql).slice(0,40));for(const [match,value] of rows)if(String(sql).includes(match))return {rows:[value]};return {rows:[]};},release:()=>{}})};}
test('address refresh validates batches and stays inert until installed and admitted',async()=>{
 for(const limit of [0,32,1.5])await assert.rejects(refreshAddressDaily(fakePool([]),{limit}),/Invalid refresh batch/);
 const absent=fakePool([['AS installed',{admitted:true,installed:false}]]);
 assert.deepEqual(await refreshAddressDaily(absent),{state:'not-installed'});assert.equal(absent.sent.at(-1),'ROLLBACK');
 const warming=fakePool([['AS installed',{admitted:true,installed:true}],["dataset='address_activity'",{ready:false}]]);
 assert.deepEqual(await refreshAddressDaily(warming),{state:'source-unavailable'});assert.equal(warming.sent.at(-1),'ROLLBACK');
 const busy=fakePool([['AS installed',{admitted:true,installed:true}],["dataset='address_activity'",{ready:true}],['advisory',{locked:false}]]);
 assert.deepEqual(await refreshAddressDaily(busy),{state:'busy'});
});

// Opt-in: ASK_ADDRESS_DAILY_PG_BIN=/abs/path/to/postgres/bin (PG14+). Disposable
// cluster with synthetic rows only; compares the summary with the raw canonical view.
test('disposable PostgreSQL: address_daily equals per-day raw canonical counts',{skip:!process.env.ASK_ADDRESS_DAILY_PG_BIN,timeout:110000},async t=>{
 const os=require('node:os'),{execFileSync}=require('node:child_process'),{Pool}=require('pg');
 const bin=process.env.ASK_ADDRESS_DAILY_PG_BIN,days=Number(process.env.ASK_ADDRESS_DAILY_DAYS||11),rows=Number(process.env.ASK_ADDRESS_DAILY_ROWS||2);
 assert.ok(path.isAbsolute(bin));assert.notEqual(process.getuid?.(),0);
 const run=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-ad-')),data=path.join(root,'d'),sock=path.join(root,'s');fs.mkdirSync(sock,{mode:0o700});
 let started=false,db;
 t.after(async()=>{await db?.end();if(started)try{run('pg_ctl',['-D',data,'-m','fast','-w','stop']);}catch{}fs.rmSync(root,{recursive:true,force:true});});
 run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${sock}'\nfsync=off\n`);
 started=true;run('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-w','start']);
 const admin=new Pool({host:sock,user:'postgres',database:'postgres',max:1});await admin.query('CREATE DATABASE ask_analytics');await admin.end();
 db=new Pool({host:sock,user:'postgres',database:'ask_analytics',max:2});
 const fixture=fs.readFileSync(path.join(__dirname,'../fixtures/ask-address-daily-store.sql'),'utf8').replaceAll(':days',String(days)).replaceAll(':rows',String(rows)).replaceAll(':pool','5000');
 await db.query(fixture);await db.query(migration.replace(/^\\set ON_ERROR_STOP on\n/,''));
 const fresh=()=>db.query("UPDATE analytics_meta.dataset_state SET verified_at=clock_timestamp() WHERE dataset='address_activity'");
 let result,batches=0;const started_at=Date.now();
 do{await fresh();result=await refreshAddressDaily(db,{limit:4});batches++;}while(result.state==='warming');
 t.diagnostic(`refreshed ${days} days in ${batches} batches, ${Date.now()-started_at} ms`);
 assert.equal(result.state,'ready');
 const day="(to_timestamp(timestamp) AT TIME ZONE 'UTC')::date";
 const ref=(await db.query(`WITH a AS (SELECT * FROM analytics_public.address_activity_query),firsts AS (SELECT DISTINCT ON (address) address,${day} AS date FROM a ORDER BY address,height)
  SELECT d::date::text AS date,(SELECT count(DISTINCT address) FROM a WHERE ${day}=d)::text AS active,(SELECT count(DISTINCT address) FROM a WHERE is_input AND ${day}=d)::text AS sending,(SELECT count(DISTINCT address) FROM a WHERE is_output AND ${day}=d)::text AS receiving,(SELECT count(*) FROM firsts WHERE date=d)::text AS new,(SELECT count(*) FROM a WHERE ${day}=d)::text AS incidences,(SELECT count(*) FROM a WHERE is_input AND ${day}=d)::text AS inputs,(SELECT count(*) FROM a WHERE is_output AND ${day}=d)::text AS outputs
  FROM generate_series(DATE '2026-08-01',DATE '2026-08-01'+${days-1},interval '1 day') d ORDER BY 1`)).rows;
 const got=(await db.query('SELECT date::text,active_addresses::text AS active,sending_addresses::text AS sending,receiving_addresses::text AS receiving,new_addresses::text AS new,incidences::text,input_incidences::text AS inputs,output_incidences::text AS outputs FROM analytics_public.address_daily_query ORDER BY date')).rows;
 assert.deepEqual(got,ref);
 // The orphan-only address never counts; late_new is new on its first canonical date.
 assert.equal(got.reduce((n,r)=>n+Number(r.new),0),Number((await db.query('SELECT count(DISTINCT address) AS n FROM analytics_public.address_activity_query')).rows[0].n));
 // A correction re-dirties only its own day and leaves activity_daily readiness alone.
 await db.query("UPDATE public.address_transactions SET is_input=NOT is_input WHERE txid='tx_2000_1'");
 const ready=async dataset=>(await db.query('SELECT ready FROM analytics_public.dataset_coverage WHERE dataset=$1',[dataset])).rows[0].ready;
 assert.equal(await ready('address_daily'),false);assert.equal(await ready('activity_daily'),true);
 await fresh();assert.equal((await refreshAddressDaily(db)).state,'ready');assert.equal(await ready('address_daily'),true);
 const reader=await db.connect();
 try{await reader.query('SET ROLE ask_public_reader');assert.equal((await reader.query('SELECT count(*)::int AS n FROM analytics_public.address_daily_query')).rows[0].n,days);
  await assert.rejects(reader.query('SELECT * FROM analytics_meta.address_daily'),e=>e.code==='42501');await reader.query('RESET ROLE');}finally{reader.release();}
 await db.query(rollback.replace(/^\\set ON_ERROR_STOP on\n/,''));
 assert.deepEqual((await db.query("SELECT to_regclass('analytics_meta.address_daily') AS t,(SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'ask_address%') AS triggers")).rows[0],{t:null,triggers:0});
});
