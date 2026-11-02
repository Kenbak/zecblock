'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor,researchCatalogue,isPublished,coreGatedIds}=require('../../../../lib/ask/research-catalogue');
const {coreViews}=require('../../v1/lib/ask-core-catalogue');
const {displaySQL}=require('../../../../lib/ask/sql-display');
const {sqlExamples}=require('../../../../lib/ask/sql-examples');
const deploy=name=>fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8');
const migration=deploy('value-pools-v1.sql'),rollback=deploy('value-pools-v1-rollback.sql'),grant=deploy('value-pools-grant-v1.sql');
const source=deploy('value-pools-source-v1.sql'),sourceRollback=deploy('value-pools-source-v1-rollback.sql');
const id='value_pools_daily',preview={preview:true};
const view=/CREATE VIEW analytics_public\.value_pools_daily_query[\s\S]*?;\n/.exec(migration)[0];
const published='hash,height,observed_at,chain,nsm_balance_zat,circulating_supply_zat,pool_balances_zat';
// Output column names of the outermost SELECT list: the alias, or the bare column name.
function viewColumns(sql){
 const list=/\n SELECT (l\.date[\s\S]*?)\n FROM last l/.exec(sql)[1];
 let depth=0,part='';const parts=[];
 for(const ch of list){if(ch==='(')depth++;if(ch===')')depth--;if(ch===','&&depth===0){parts.push(part);part='';}else part+=ch;}
 parts.push(part);
 return parts.map(p=>{p=p.trim();const alias=/\bAS\s+([a-z_]+)$/i.exec(p);return alias?alias[1]:p.split('.').pop();});
}

test('value_pools_daily is an unpublished extended dataset until its rollout is verified',async()=>{
 const {cases,pendingCases}=require('../../v1/lib/ask-research-eval-cases');
 assert.equal(isPublished(id),false);assert.equal(isPublished(id,preview),true);
 assert.ok(!catalogueFor(true).some(d=>d.id===id));assert.ok(catalogueFor(true,preview).some(d=>d.id===id));
 assert.ok(!catalogueFor(false,preview).some(d=>d.id===id));
 await assert.rejects(compileResearchSQL({version:3,sql:'SELECT * FROM value_pools_daily',limit:1},{extended:true}),/not admitted/);
 assert.deepEqual((await compileResearchSQL({version:3,sql:'SELECT * FROM value_pools_daily',limit:1},{extended:true,...preview})).datasets,[id]);
 assert.ok(!coreGatedIds.includes(id));
 assert.doesNotMatch(instructionsFor(true),/read value_pools_daily/);
 assert.match(instructionsFor(true,preview),/read value_pools_daily \(completed UTC dates from 2026-09-28\)/);
 assert.match(instructionsFor(true,preview),/never SUM its balances across dates/);
 assert.match(instructionsFor(true,preview),/name the source used/);
 assert.deepEqual(pendingCases.filter(c=>(c.requires||[]).includes(id)).map(c=>c.id),['value_pools_end_2026_10']);
 assert.ok(!cases.some(c=>(c.requires||[]).includes(id)));
});

test('catalogue columns are exactly the view columns and semantics are stated',()=>{
 const entry=researchCatalogue.find(d=>d.id===id);
 assert.deepEqual(viewColumns(view),entry.columns.split(', '));
 assert.ok(coreViews.includes('value_pools_daily_query'));
 for(const re of [/from 2026-09-28/,/getblockchaininfo/,/including the lockbox/,/equal to supply_daily\.chain_supply/,/zero before NU7 activation/,/zatoshis and are stocks: never sum/,/absent, not zero/,/did not monitor is NULL/])assert.match(entry.description,re);
 // The node's circulating_supply_zat includes the lockbox; supply_daily.circulating_supply does not.
 assert.doesNotMatch(entry.columns,/circulating/);
});

test('examples compile in preview; the raw observation table stays unreachable',async()=>{
 const examples=sqlExamples.filter(e=>(e.datasets||[]).includes(id));
 assert.deepEqual(examples.map(e=>e.id),['value-pools-weekly']);
 for(const example of examples){
  const compiled=await compileResearchSQL({version:3,sql:example.sql,limit:50},{extended:true,...preview});
  assert.deepEqual(compiled.datasets,[id],example.id);
  assert.equal(displaySQL(compiled.request.sql).includes('analytics_public'),false);
 }
 for(const sql of ['WITH value_pools_daily AS (SELECT 1) SELECT * FROM value_pools_daily','SELECT * FROM public.node_accounting_observations','SELECT subsidy FROM node_accounting_observations'])
  await assert.rejects(compileResearchSQL({version:3,sql,limit:1},{extended:true,...preview}));
});

test('migrations are guarded, keep private columns private and order destination before source',()=>{
 for(const sql of [migration,rollback,grant,source,sourceRollback]){assert.match(sql,/^\\set ON_ERROR_STOP on\n/);assert.match(sql,/COMMIT;\n$/);assert.equal(sql.match(/BEGIN;/g).length,1);}
 assert.match(migration,/current_database\(\)<>'ask_analytics' OR pg_is_in_recovery\(\)/);
 assert.match(migration,/to_regclass\('analytics_public\.swap_daily_query'\) IS NULL/);
 assert.doesNotMatch(migration,/\bDROP\b|\bDELETE FROM\b|\bTRUNCATE\b|\bUPDATE\b|\bALTER\b/);
 // The reader grant waits for the worker that lists the view (its guard refuses every query otherwise).
 assert.doesNotMatch(migration,/ask_public_reader/);
 assert.deepEqual(migration.match(/GRANT [^;]+;/g),['GRANT SELECT ON public.node_accounting_observations TO ask_public_view_owner;']);
 assert.deepEqual(grant.match(/GRANT [^;]+;/g),['GRANT SELECT ON analytics_public.value_pools_daily_query TO ask_public_reader;']);
 // Destination columns are exactly the published source columns, in order.
 const table=/CREATE TABLE public\.node_accounting_observations\((.*?)\);/.exec(migration)[1].split(',').map(c=>c.trim().split(' ')[0]);
 assert.deepEqual(table,published.split(','));
 assert.equal(/ADD TABLE public\.node_accounting_observations\(([^)]*)\);/.exec(source)[1],published);
 assert.equal(/GRANT SELECT\(([^)]*)\) ON public\.node_accounting_observations /.exec(source)[1],published);
 assert.equal(/REVOKE SELECT\(([^)]*)\) ON public\.node_accounting_observations /.exec(sourceRollback)[1],published);
 // Funding-stream addresses (subsidy), upgrade state and poller details stay private.
 assert.doesNotMatch(source.match(/(?:GRANT|ADD TABLE)[^;]+;/g).join(''),/subsidy|upgrades|source,|poll_interval/);
 assert.match(source,/Apply value-pools-v1\.sql on the analytics store FIRST/);
 assert.match(rollback,/EXISTS\(SELECT FROM pg_subscription_rel WHERE srrelid='public\.node_accounting_observations'::regclass\)/);
 const admission=fs.readFileSync(path.join(__dirname,'../../scripts/ask-core-admission.js'),'utf8');
 assert.match(admission,/WHEN 'value_pools_daily' THEN ARRAY\['public\.node_accounting_observations'\]/);
 assert.match(admission,/'swap_daily','value_pools_daily'\)/);
});

test('value_pools_daily view: canonical day-end snapshots, coverage counts and gating',{skip:process.env.ASK_EVAL_TEST_POSTGRES!=='1',timeout:60000},async t=>{
 const {execFileSync}=require('node:child_process'),{Client}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;assert.ok(bin&&path.isAbsolute(bin));
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{PATH:bin+':/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-pools-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.mkdirSync(socket,{mode:0o700});let started=false,client;
 t.after(async()=>{try{await client?.end();}catch{/* cluster stop below */}if(started)command('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','fixture','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${socket}'\nshared_buffers='16MB'\nfsync=off\n`);
 started=true;command('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-w','start']);
 client=new Client({host:socket,user:'fixture',database:'postgres'});await client.connect();
 const pools=(t,i)=>JSON.stringify({transparent:String(t),sprout:'100',sapling:'200',orchard:'300',ironwood:i===null?null:String(i),lockbox:'50'});
 await client.query(`SET TIME ZONE 'UTC';CREATE SCHEMA analytics_public;
  CREATE TABLE public.blocks(height bigint PRIMARY KEY,hash text,timestamp bigint);
  CREATE TABLE public.node_accounting_observations(hash text PRIMARY KEY,height bigint NOT NULL,observed_at timestamptz NOT NULL,chain text,nsm_balance_zat bigint,circulating_supply_zat bigint,pool_balances_zat jsonb NOT NULL);
  CREATE TABLE analytics_public.dataset_coverage(dataset text PRIMARY KEY,ready boolean);
  CREATE TABLE analytics_public.coverage(ready boolean,covered_from bigint,covered_through bigint);
  INSERT INTO analytics_public.dataset_coverage VALUES('value_pools_daily',true);
  INSERT INTO analytics_public.coverage VALUES(true,0,1000);
  INSERT INTO public.blocks VALUES(99,'h99',extract(epoch FROM TIMESTAMPTZ '2026-10-29 23:59:00+00')),(100,'h100',extract(epoch FROM TIMESTAMPTZ '2026-10-30 01:00:00+00')),
   (101,'h101',extract(epoch FROM TIMESTAMPTZ '2026-10-30 12:00:00+00')),(102,'h102',extract(epoch FROM TIMESTAMPTZ '2026-10-30 23:00:00+00')),
   (103,'h103',extract(epoch FROM TIMESTAMPTZ '2026-10-31 10:00:00+00')),(104,'h104',extract(epoch FROM now()));`);
 // 102 was observed only as an orphan (x102); 103 has an unmonitored Ironwood pool; 104 is today; t100 is another chain.
 await client.query(`INSERT INTO public.node_accounting_observations VALUES
  ('h100',100,now(),'main',0,1650,$1),('h101',101,now(),'main',-5,1640,$2),('x102',102,now(),'main',0,9999,$3),
  ('h103',103,now(),'main',7,1630,$4),('h104',104,now(),'main',0,1620,$5),('t100',99,now(),'test',0,1,$6)`,
  [pools(1000,300),pools(990,300),pools(1,1),pools(980,null),pools(970,300),pools(5,5)]);
 await client.query(view);
 const rows=async()=>(await client.query('SELECT date::text,height::int,hash,observed_blocks::int,day_blocks::int,transparent::text,ironwood::text,lockbox::text,nsm::text,chain_supply::text FROM analytics_public.value_pools_daily_query ORDER BY date')).rows;
 assert.deepEqual(await rows(),[
  {date:'2026-10-30',height:101,hash:'h101',observed_blocks:2,day_blocks:3,transparent:'990',ironwood:'300',lockbox:'50',nsm:'-5',chain_supply:'1640'},
  {date:'2026-10-31',height:103,hash:'h103',observed_blocks:1,day_blocks:1,transparent:'980',ironwood:null,lockbox:'50',nsm:'7',chain_supply:'1630'}]);
 // Snapshots above the admitted coverage are hidden; so is everything while the dataset is unready.
 await client.query('UPDATE analytics_public.coverage SET covered_through=102');
 assert.deepEqual((await rows()).map(r=>r.date),['2026-10-30']);
 await client.query("UPDATE analytics_public.dataset_coverage SET ready=false");
 assert.equal((await client.query('SELECT count(*)::int AS n FROM analytics_public.value_pools_daily_query')).rows[0].n,0);
});
