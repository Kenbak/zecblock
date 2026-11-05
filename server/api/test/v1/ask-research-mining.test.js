'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor,researchCatalogue,isPublished,coreGatedIds}=require('../../../../lib/ask/research-catalogue');
const {coreViews}=require('../../v1/lib/ask-core-catalogue');
const {displaySQL}=require('../../../../lib/ask/sql-display');
const {sqlExamples}=require('../../../../lib/ask/sql-examples');
const deploy=name=>fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8');
const migration=deploy('mining-v1.sql'),rollback=deploy('mining-v1-rollback.sql');
const source=deploy('mining-source-v1.sql'),sourceRollback=deploy('mining-source-v1-rollback.sql');
const supplyMigration=deploy('supply-issuance-v1.sql');
const ids=['mining_daily','software_daily','block_timing','issuance_daily'];
const preview={preview:true};
const view=(sql,name)=>new RegExp(`CREATE VIEW analytics_public\\.${name}_query[\\s\\S]*?;\\n`).exec(sql)[0];
// Output column names of the outermost SELECT list: the alias, or the bare column name.
function viewColumns(sql){
 const list=/\n SELECT ([\s\S]*?)\n FROM (?:public\.|days d)/.exec(sql)[1];
 let depth=0,part='';const parts=[];
 for(const ch of list){if(ch==='(')depth++;if(ch===')')depth--;if(ch===','&&depth===0){parts.push(part);part='';}else part+=ch;}
 parts.push(part);
 return parts.map(p=>{p=p.trim();const alias=/\bAS\s+([a-z_]+)$/i.exec(p);return alias?alias[1]:p.split('.').pop();});
}

// Published 2026-10-31 after the host rollout was verified (mining.md).
test('mining datasets are published extended datasets with guidance',async()=>{
 const {cases,pendingCases}=require('../../v1/lib/ask-research-eval-cases');
 for(const id of ids){
  assert.equal(isPublished(id),true,id);
  assert.ok(catalogueFor(true).some(d=>d.id===id));assert.ok(!catalogueFor(false).some(d=>d.id===id));
  await assert.rejects(compileResearchSQL({version:3,sql:`SELECT * FROM ${id}`,limit:1}),/not admitted/);
  assert.deepEqual((await compileResearchSQL({version:3,sql:`SELECT * FROM ${id}`,limit:1},{extended:true})).datasets,[id]);
  assert.ok(!coreGatedIds.includes(id),id);
 }
 assert.match(instructionsFor(true),/read mining_daily: sum blocks per pool/);
 assert.match(instructionsFor(true),/read issuance_daily instead/);
 assert.match(instructionsFor(true),/markers are self-reported, and unknown is not proof of zcashd/);
 assert.match(instructionsFor(true),/read block_timing bounded by timestamp or height/);
 assert.match(instructionsFor(true),/never call it pure propagation delay/);
 assert.doesNotMatch(instructionsFor(false),/mining_daily:|read block_timing|read issuance_daily/);
 assert.ok(pendingCases.every(c=>!(c.requires||[]).some(id=>ids.includes(id))));
 for(const id of ['issuance_since_launch','pool_concentration_30d','timestamp_lag_by_miner_2026_10','zebra_share_2026_09'])assert.ok(cases.some(c=>c.id===id),id);
});

test('catalogue columns are exactly the view columns and semantics are stated',()=>{
 for(const id of ids){
  const entry=researchCatalogue.find(d=>d.id===id);
  assert.deepEqual(viewColumns(view(migration,id)),entry.columns.split(', '),id);
  assert.ok(coreViews.includes(id+'_query'),id);
 }
 const text=id=>researchCatalogue.find(d=>d.id===id).description;
 for(const re of [/pool Unknown is unattributed/,/not a verified identity/,/blocks\/day_blocks/,/not hashrate/])assert.match(text('mining_daily'),re);
 for(const re of [/zebra, zakura, other \(a zcashd marker\), conflicting/,/unknown is not proof of zcashd/,/missing \(coinbase data unavailable\)/])assert.match(text('software_daily'),re);
 for(const re of [/lag_seconds = first_seen - timestamp/,/neither pure propagation delay nor a network-wide figure/,/absent, not zero/,/local-node-rpc \(a 1 s tip poll/])assert.match(text('block_timing'),re);
 for(const re of [/identical to summing issuance over those heights/,/not new issuance/,/null from NU7 activation \(height 3543405\)/,/supply_daily\.net_change/])assert.match(text('issuance_daily'),re);
});

test('examples compile in preview and the issuance history example reads issuance_daily',async()=>{
 const examples=sqlExamples.filter(e=>(e.datasets||[]).some(id=>ids.includes(id)));
 assert.deepEqual(examples.map(e=>e.id),['pool-share-30d','software-share-monthly','timestamp-vs-first-seen','issuance-history']);
 for(const example of examples){
  const compiled=await compileResearchSQL({version:3,sql:example.sql,limit:50},{extended:true});
  assert.deepEqual(compiled.datasets,example.datasets,example.id);
  assert.equal(displaySQL(compiled.request.sql).includes('analytics_public'),false);
 }
 for(const sql of ['WITH mining_daily AS (SELECT 1) SELECT * FROM mining_daily','SELECT * FROM public.analytics_history_daily','SELECT * FROM public.block_software_daily','SELECT * FROM public.captured_blocks','SELECT * FROM public.block_observations'])
  await assert.rejects(compileResearchSQL({version:3,sql,limit:1},{extended:true,...preview}));
});

test('migrations are guarded, additive and ordered destination before source',()=>{
 assert.match(migration,/^\\set ON_ERROR_STOP on\n/);assert.match(migration,/COMMIT;\n$/);
 assert.match(migration,/current_database\(\)<>'ask_analytics' OR pg_is_in_recovery\(\)/);
 assert.match(migration,/to_regclass\('analytics_public\.supply_daily_query'\) IS NULL/);
 assert.doesNotMatch(migration,/\bDROP\b|\bDELETE FROM\b|\bTRUNCATE\b|\bUPDATE\b|\bALTER (?:TABLE|SUBSCRIPTION|PUBLICATION)\b/);
 assert.deepEqual(migration.match(/CREATE INDEX [a-z_]+ ON public\.[a-z_]+\(height\)/g).length,2);
 assert.deepEqual(migration.match(/GRANT [^;]+;/g),['GRANT SELECT ON public.analytics_history_daily,public.block_software_daily,public.block_observations,public.captured_blocks TO ask_public_view_owner;','GRANT SELECT ON analytics_public.mining_daily_query,analytics_public.software_daily_query,analytics_public.block_timing_query,analytics_public.issuance_daily_query TO ask_public_reader;']);
 // Each destination table and its published column list must be identical, or apply stops.
 for(const table of ['analytics_history_daily','block_software_daily','block_observations','captured_blocks']){
  const destination=new RegExp(`CREATE TABLE public\\.${table}\\((.*?)\\);`).exec(migration)[1].replace(/,PRIMARY KEY\(.*\)$/,'').split(',').map(c=>c.trim().split(' ')[0]).filter(c=>c!=='PRIMARY');
  const published=new RegExp(`public\\.${table}\\(([^)]*)\\)`).exec(/ADD TABLE ([^;]*);/.exec(source)[1])[1].split(',');
  assert.deepEqual(destination,published,table);
  assert.deepEqual(new RegExp(`GRANT SELECT\\(([^)]*)\\) ON public\\.${table} `).exec(source)[1].split(','),published,table);
 }
 // Cohorts, USD cost basis, SOPR and fee metadata stay private.
 assert.doesNotMatch(/ADD TABLE[^;]*;/.exec(source)[0]+source.match(/GRANT [^;]+;/g).join(''),/cohorts|realized|sopr|fees|spent|transparent_supply|computed_at|method|raw_block|coinbase|miner_address|poll_interval|previous_block_hash|network/);
 assert.match(source,/current_database\(\)<>'zcash_explorer_mainnet'/);assert.match(source,/Apply mining-v1\.sql on the analytics store FIRST/);
 assert.match(source,/block_software_state WHERE version=1 AND ready/);
 assert.match(sourceRollback,/DROP TABLE public\.analytics_history_daily,public\.block_software_daily,public\.block_observations,public\.captured_blocks;/);
 assert.match(rollback,/EXISTS\(SELECT FROM pg_subscription_rel WHERE srrelid IN\('public\.analytics_history_daily'::regclass,'public\.block_software_daily'::regclass,'public\.block_observations'::regclass,'public\.captured_blocks'::regclass\)\)/);
 const admission=fs.readFileSync(path.join(__dirname,'../../scripts/ask-core-admission.js'),'utf8');
 for(const [id,tables] of [['mining_daily','analytics_history_daily'],['software_daily','block_software_daily'],['issuance_daily','chain_supply_daily'],['block_timing',"block_observations','public\\.captured_blocks"]])
  assert.match(admission,new RegExp(`WHEN '${id}' THEN ARRAY\\['public\\.${tables}'\\]`),id);
 // Every listed table must be ready; a dataset outside the map is never ready.
 assert.match(admission,/ready=coalesce\(\(SELECT bool_and\(EXISTS\([^`]*r\.srrelid=to_regclass\(t\)\)\) FROM unnest\(CASE d\.dataset /);
 assert.match(admission,/'supply_daily','mining_daily','software_daily','issuance_daily','block_timing'[,)]/);
});

// Executes the migrations' own view text. Opt-in like the other disposable-cluster
// tests; PostgreSQL 14+ is enough for it.
test('daily views: canonical anchors, completed days, and closed-form issuance equal per-block sums',{skip:process.env.ASK_EVAL_TEST_POSTGRES!=='1',timeout:60000},async t=>{
 const {execFileSync}=require('node:child_process'),{Client}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;assert.ok(bin&&path.isAbsolute(bin));
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{PATH:bin+':/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-mining-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.mkdirSync(socket,{mode:0o700});let started=false,client;
 t.after(async()=>{try{await client?.end();}catch{/* cluster stop below */}if(started)command('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','fixture','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${socket}'\nshared_buffers='16MB'\nfsync=off\n`);
 started=true;command('pg_ctl',['-D',data,'-l',path.join(root,'log'),'-w','start']);
 client=new Client({host:socket,user:'fixture',database:'postgres'});await client.connect();
 // Windows of consecutive dates around every schedule boundary, separated by gaps.
 const windows=[[0,30],[9980,10010],[19990,20010],[653590,653610],[1046390,1046410],[2726390,2726410],[3146390,3146410],[3543395,3543415],[1500000,1501152]];
 const tip=3543415;
 await client.query(`SET TIME ZONE 'UTC';CREATE SCHEMA analytics_public;
  CREATE TABLE public.blocks(height bigint PRIMARY KEY,hash text,timestamp bigint,total_fees bigint);
  CREATE TABLE public.chain_supply_daily(date date PRIMARY KEY,block_height bigint,block_hash text,block_time bigint,chain_supply_zat bigint);
  CREATE TABLE public.analytics_history_daily(date date PRIMARY KEY,anchor_height bigint,anchor_hash text,mining_pool_blocks jsonb);
  CREATE TABLE public.block_software_daily(day integer,software text,blocks bigint,PRIMARY KEY(day,software));
  CREATE TABLE public.block_observations(hash text PRIMARY KEY,height bigint,first_seen_at timestamptz);
  CREATE TABLE public.captured_blocks(hash text PRIMARY KEY,height bigint,first_seen_at timestamptz);
  ALTER TABLE public.blocks ADD COLUMN miner_address text;
  CREATE VIEW analytics_public.coverage AS SELECT true AS ready,0::bigint AS covered_from,${tip}::bigint AS covered_through;
  CREATE TABLE analytics_public.dataset_coverage(dataset text PRIMARY KEY,ready boolean);
  INSERT INTO analytics_public.dataset_coverage VALUES('supply_daily',true),('mining_daily',true),('software_daily',true),('issuance_daily',true),('block_timing',true);`);
 await client.query(view(supplyMigration,'supply_daily')+view(supplyMigration,'issuance')+view(migration,'mining_daily')+view(migration,'software_daily')+view(migration,'block_timing')+view(migration,'issuance_daily'));
 for(const [lo,hi] of windows)await client.query('INSERT INTO public.blocks SELECT h,md5(h::text),1600000000+h,0 FROM generate_series($1::bigint,$2::bigint) h ON CONFLICT DO NOTHING',[lo,hi]);
 // Tip header time 2025-03-23 12:00 UTC: software days before 2025-03-23 are complete.
 await client.query('UPDATE public.blocks SET timestamp=1742731200 WHERE height=$1',[tip]);
 // Each window: date A ends at its low height, date B (next day) at its high height.
 let date=new Date(Date.UTC(2016,9,28));const supply=[];
 for(const [i,[lo,hi]] of windows.entries()){
  if(i===0){supply.push([date.toISOString().slice(0,10),hi]);}
  else{supply.push([date.toISOString().slice(0,10),lo]);date=new Date(date.getTime()+86400000);supply.push([date.toISOString().slice(0,10),hi]);}
  date=new Date(date.getTime()+10*86400000);
 }
 // An idle date repeats the previous height.
 supply.push([new Date(date.getTime()-9*86400000).toISOString().slice(0,10),windows.at(-1)[1]]);
 for(const [d,h] of supply)await client.query('INSERT INTO public.chain_supply_daily VALUES($1::date,$2::bigint,md5($2::bigint::text),0,1)',[d,h]);
 const daily=(await client.query('SELECT date::text,first_height::text,last_height::text,blocks::text,subsidy::text,miner_subsidy::text,founders::text,funding_streams::text,lockbox::text,lockbox_disbursed::text FROM analytics_public.issuance_daily_query ORDER BY date')).rows;
 assert.equal(daily.length,supply.length);
 const brute=async(lo,hi)=>(await client.query('SELECT count(*)::text AS blocks,sum(subsidy)::text AS subsidy,sum(miner_subsidy)::text AS miner_subsidy,sum(founders)::text AS founders,sum(funding_streams)::text AS funding_streams,sum(lockbox)::text AS lockbox,sum(lockbox_disbursed)::text AS lockbox_disbursed FROM analytics_public.issuance_query WHERE height BETWEEN $1 AND $2',[lo,hi])).rows[0];
 const byDate=Object.fromEntries(daily.map(r=>[r.date,r]));
 // Genesis date starts at height 0.
 const genesis=byDate['2016-10-28'],g=await brute(0,30);
 assert.deepEqual([genesis.first_height,genesis.blocks,genesis.subsidy,genesis.founders,genesis.miner_subsidy],['0','31',g.subsidy,g.founders,g.miner_subsidy]);
 for(const [lo,hi] of windows.slice(1)){
  const b=supply.find(([,h])=>h===hi)[0],a=supply.find(([,h])=>h===lo)[0],row=byDate[b],expected=await brute(lo+1,hi);
  // A date whose previous date is missing is unknown, never zero.
  assert.deepEqual([byDate[a].first_height,byDate[a].blocks,byDate[a].subsidy],[null,null,null],a);
  assert.equal(row.first_height,String(lo+1),b);assert.equal(row.blocks,expected.blocks,b);
  if(hi>=3543405){assert.deepEqual([row.subsidy,row.miner_subsidy,row.founders,row.funding_streams,row.lockbox,row.lockbox_disbursed],[null,null,null,null,null,null],b);continue;}
  for(const key of ['subsidy','miner_subsidy','founders','funding_streams','lockbox','lockbox_disbursed'])assert.equal(row[key],expected[key],`${b} ${key}`);
 }
 assert.equal(byDate[supply.find(([,h])=>h===3146410)[0]].lockbox_disbursed,'7875000000000');
 const idle=daily.at(-1);assert.deepEqual([idle.blocks,idle.subsidy,idle.miner_subsidy,idle.lockbox_disbursed],['0','0','0','0']);
 await client.query("UPDATE analytics_public.dataset_coverage SET ready=false WHERE dataset='issuance_daily'");
 assert.equal((await client.query('SELECT count(*)::int AS n FROM analytics_public.issuance_daily_query')).rows[0].n,0);

 // Pool attribution: canonical anchors only, completed dates only.
 await client.query(`INSERT INTO public.analytics_history_daily VALUES
  ('2016-10-28',30,md5('30'),'{"Unknown":25,"F2Pool":6}'),
  ('2016-11-08',10010,'not-canonical','{"ViaBTC":5}'),
  (CURRENT_DATE,20010,md5('20010'),'{"ViaBTC":9}')`);
 assert.deepEqual((await client.query('SELECT date::text,pool,blocks::text,day_blocks::text FROM analytics_public.mining_daily_query ORDER BY date,pool')).rows,
  [{date:'2016-10-28',pool:'F2Pool',blocks:'6',day_blocks:'31'},{date:'2016-10-28',pool:'Unknown',blocks:'25',day_blocks:'31'}]);

 // Software markers: day number to UTC date; the tip's own day is incomplete.
 await client.query("INSERT INTO public.block_software_daily VALUES(20169,'zebra',40),(20169,'unknown',60),(20169,'missing',0),(20170,'zebra',5),(20200,'zakura',1)");
 assert.deepEqual((await client.query('SELECT date::text,software,blocks::text,day_blocks::text FROM analytics_public.software_daily_query ORDER BY software')).rows,
  [{date:'2025-03-22',software:'missing',blocks:'0',day_blocks:'100'},{date:'2025-03-22',software:'unknown',blocks:'60',day_blocks:'100'},{date:'2025-03-22',software:'zebra',blocks:'40',day_blocks:'100'}]);

 // First-seen timing: earliest receipt of either collector, canonical blocks
 // only, from the first collected height; unreceived blocks are absent.
 await client.query("UPDATE public.blocks SET timestamp=1700000000+height,miner_address='t1'||(height%2) WHERE height BETWEEN 1500000 AND 1500010");
 await client.query(`INSERT INTO public.block_observations VALUES
  (md5('1500001'),1500001,to_timestamp(1701500001.25)),
  (md5('1500002'),1500002,to_timestamp(1701500005.5)),
  (md5('1500003'),1500003,to_timestamp(1701500000)),
  ('orphan',1500004,to_timestamp(1701500004))`);
 await client.query(`INSERT INTO public.captured_blocks VALUES
  (md5('1500002'),1500002,to_timestamp(1701500003.125)),
  (md5('1500005'),1500005,to_timestamp(1701500004.875))`);
 assert.deepEqual((await client.query('SELECT height::int,miner,first_seen::text,lag_seconds::text,observed_by FROM analytics_public.block_timing_query ORDER BY height')).rows,[
  {height:1500001,miner:'t11',first_seen:'1701500001.250',lag_seconds:'0.250',observed_by:'local-node-rpc'},
  {height:1500002,miner:'t10',first_seen:'1701500003.125',lag_seconds:'1.125',observed_by:'node-block-stream'},
  {height:1500003,miner:'t11',first_seen:'1701500000.000',lag_seconds:'-3.000',observed_by:'local-node-rpc'},
  {height:1500005,miner:'t11',first_seen:'1701500004.875',lag_seconds:'-0.125',observed_by:'node-block-stream'}]);
 await client.query("UPDATE analytics_public.dataset_coverage SET ready=false WHERE dataset='block_timing'");
 assert.equal((await client.query('SELECT count(*)::int AS n FROM analytics_public.block_timing_query')).rows[0].n,0);
 await client.query("UPDATE analytics_public.dataset_coverage SET ready=false WHERE dataset IN('mining_daily','software_daily')");
 for(const name of ['mining_daily','software_daily'])assert.equal((await client.query(`SELECT count(*)::int AS n FROM analytics_public.${name}_query`)).rows[0].n,0,name);
});
