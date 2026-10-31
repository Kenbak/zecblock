'use strict';
// Opt-in local PG16 capability/transport fixture only. No serving database,
// provider, Redis, copied production data, readiness or historical-coverage claim.
const test=require('node:test'),assert=require('node:assert/strict');
const {cases:published,pendingCases}=require('../../v1/lib/ask-research-eval-cases');
// Pending cases need unpublished datasets; the fixture executes them in preview.
const cases=[...published,...pendingCases],preview={preview:true};
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const {comparisonQuery,splitComparison,matchRoles}=require('../../v1/lib/ask-research-eval');
const when='2026-10-28T00:00:00Z';

const schemaSQL=`
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE ROLE ask_eval_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ask_eval_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE postgres TO ask_eval_reader;
ALTER ROLE ask_eval_reader SET default_transaction_read_only=on;
ALTER ROLE ask_eval_reader SET statement_timeout='3s';
ALTER ROLE ask_eval_reader SET lock_timeout='500ms';
ALTER ROLE ask_eval_reader SET idle_in_transaction_session_timeout='5s';
ALTER ROLE ask_eval_reader SET work_mem='1MB';
ALTER ROLE ask_eval_reader SET temp_file_limit='16MB';
ALTER ROLE ask_eval_reader SET max_parallel_workers_per_gather=0;
ALTER ROLE ask_eval_reader SET jit=off;
ALTER ROLE ask_eval_reader SET search_path=pg_catalog;
ALTER ROLE ask_eval_reader SET timezone='UTC';
CREATE SCHEMA fixture_private AUTHORIZATION ask_eval_owner;
CREATE SCHEMA analytics_public AUTHORIZATION ask_eval_owner;
SET ROLE ask_eval_owner;
SET TIME ZONE 'UTC';
CREATE TABLE fixture_private.blocks(height integer PRIMARY KEY,hash text,timestamp bigint,miner text,transactions integer,bytes bigint,fees bigint);
CREATE TABLE fixture_private.transactions(txid text PRIMARY KEY,height integer,timestamp bigint,miner text,shielded boolean,orchard boolean,ironwood boolean,sapling boolean,bytes bigint,fees bigint);
CREATE TABLE fixture_private.flows(txid text,height integer,timestamp bigint,direction text,pool text,amount bigint);
CREATE TABLE fixture_private.daily(date date PRIMARY KEY,transactions numeric,shielded_transactions bigint,transparent_transactions bigint,orchard bigint,ironwood bigint,sapling bigint,sprout bigint);
CREATE TABLE fixture_private.swaps(timestamp timestamptz,direction text,chain text,token text,usd numeric);
CREATE TABLE fixture_private.addresses(address text PRIMARY KEY,balance bigint,received bigint,sent bigint,transactions integer,first_seen bigint,last_seen bigint);
CREATE TABLE fixture_private.address_activity(address text,txid text,height integer,timestamp bigint,tx_index integer,is_input boolean,is_output boolean,received bigint,sent bigint);
CREATE TABLE fixture_private.activity_daily(date date PRIMARY KEY,blocks bigint,transactions bigint,shielded_transactions bigint,transparent_transactions bigint,unclassified_transactions bigint,bytes numeric,fees numeric,missing_fees bigint,missing_bytes bigint);
CREATE TABLE fixture_private.address_daily(date date PRIMARY KEY,active_addresses bigint,sending_addresses bigint,receiving_addresses bigint,new_addresses bigint,incidences bigint,input_incidences bigint,output_incidences bigint);
CREATE TABLE fixture_private.supply_daily(date date PRIMARY KEY,height bigint,hash text,timestamp bigint,chain_supply bigint,lockbox bigint,circulating_supply bigint,net_change bigint);
CREATE TABLE fixture_private.issuance(height bigint PRIMARY KEY,hash text,timestamp bigint,subsidy bigint,miner_subsidy bigint,founders bigint,funding_streams bigint,lockbox bigint,lockbox_disbursed bigint,fees bigint);
CREATE TABLE fixture_private.mining_daily(date date,pool text,blocks bigint,day_blocks bigint,PRIMARY KEY(date,pool));
CREATE TABLE fixture_private.software_daily(date date,software text,blocks bigint,day_blocks bigint,PRIMARY KEY(date,software));
CREATE TABLE fixture_private.block_timing(height bigint PRIMARY KEY,hash text,timestamp bigint,miner text,first_seen numeric,lag_seconds numeric,observed_by text);
CREATE TABLE fixture_private.reorgs(reorg_id integer PRIMARY KEY,fork_height bigint,depth integer,reported_orphans integer,orphans bigint,detected_at bigint);
CREATE TABLE fixture_private.orphaned_blocks(height bigint,hash text PRIMARY KEY,canonical_hash text,timestamp bigint,miner text,transactions integer,bytes integer,reorg_id integer,detected_at bigint,canonical_now boolean);
CREATE TABLE fixture_private.issuance_daily(date date PRIMARY KEY,first_height bigint,last_height bigint,blocks bigint,subsidy bigint,miner_subsidy bigint,founders bigint,funding_streams bigint,lockbox bigint,lockbox_disbursed bigint);
CREATE TABLE fixture_private.flow_daily(date date,pool text,direction text,records bigint,amount numeric,missing_amounts bigint,PRIMARY KEY(date,pool,direction));
CREATE VIEW analytics_public.blocks_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.blocks;
CREATE VIEW analytics_public.transactions_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.transactions;
CREATE VIEW analytics_public.flows_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.flows;
CREATE VIEW analytics_public.daily_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.daily;
CREATE VIEW analytics_public.swaps_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.swaps;
CREATE VIEW analytics_public.addresses_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.addresses;
CREATE VIEW analytics_public.address_activity_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.address_activity;
CREATE VIEW analytics_public.activity_daily_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.activity_daily;
CREATE VIEW analytics_public.flow_daily_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.flow_daily;
CREATE VIEW analytics_public.address_daily_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.address_daily;
CREATE VIEW analytics_public.supply_daily_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.supply_daily;
CREATE VIEW analytics_public.issuance_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.issuance;
CREATE VIEW analytics_public.mining_daily_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.mining_daily;
CREATE VIEW analytics_public.software_daily_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.software_daily;
CREATE VIEW analytics_public.block_timing_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.block_timing;
CREATE VIEW analytics_public.issuance_daily_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.issuance_daily;
CREATE VIEW analytics_public.reorgs_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.reorgs;
CREATE VIEW analytics_public.orphaned_blocks_query WITH(security_barrier=true) AS SELECT * FROM fixture_private.orphaned_blocks;
REVOKE ALL ON ALL TABLES IN SCHEMA fixture_private,analytics_public FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics_public TO ask_eval_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics_public TO ask_eval_reader;
INSERT INTO fixture_private.blocks VALUES(0,'fixture_genesis',1477641360,'fixture_miner',1,100,0);
INSERT INTO fixture_private.blocks SELECT 3500000+i,'fixture_block_'||i,1788220800+i*75,'fixture_miner',3,1000,CASE WHEN i=1 THEN NULL ELSE 100+i END FROM generate_series(0,19) i;
INSERT INTO fixture_private.transactions SELECT 'fixture_tx_'||i,3500000+i,1788220800+i*75,'fixture_miner',i%2=0,i%2=0,false,false,200,CASE WHEN i=1 THEN NULL ELSE 50+i END FROM generate_series(0,19) i;
INSERT INTO fixture_private.flows SELECT 'fixture_tx_'||i,3500000+i,1788220800+i*75,CASE WHEN i%2=0 THEN 'shield' ELSE 'deshield' END,'orchard',100000000+i FROM generate_series(0,9) i;
INSERT INTO fixture_private.daily SELECT DATE '2025-12-25'+i,300,100,200,(1000-2*i)::bigint*100000000,(100+3*i)::bigint*100000000,500000000,0 FROM generate_series(0,279) i;
INSERT INTO fixture_private.activity_daily SELECT (DATE '2025-01-01'+i*INTERVAL '1 month')::date,10,300,100+i,180,20,1000,100,0,0 FROM generate_series(0,11) i;
INSERT INTO fixture_private.activity_daily SELECT DATE '2026-06-01'+i,10,300,CASE WHEN DATE '2026-06-01'+i=DATE '2026-09-01' THEN 1000 ELSE 100 END,180,20,1000,CASE WHEN DATE '2026-06-01'+i=DATE '2026-09-01' THEN NULL ELSE 100 END,CASE WHEN DATE '2026-06-01'+i=DATE '2026-09-01' THEN 1 ELSE 0 END,0 FROM generate_series(0,121) i;
INSERT INTO fixture_private.flow_daily SELECT DATE '2026-08-25'+i,p,d,2,CASE WHEN i=8 AND p='orchard' THEN NULL ELSE (CASE WHEN d='shield' THEN 150000000 ELSE 100000000 END)*(CASE WHEN i=23 THEN 2 ELSE 1 END) END,CASE WHEN i=8 AND p='orchard' THEN 1 ELSE 0 END FROM generate_series(0,36) i CROSS JOIN(VALUES('orchard'),('ironwood')) pools(p) CROSS JOIN(VALUES('shield'),('deshield')) directions(d);
INSERT INTO fixture_private.swaps SELECT (DATE '2026-08-25'+i)::timestamptz,d,'fixture_chain','fixture_token',CASE WHEN i=7 THEN NULL ELSE 100*(CASE WHEN i=23 THEN 2 ELSE 1 END) END FROM generate_series(0,36) i CROSS JOIN(VALUES('inflow'),('outflow')) directions(d);
INSERT INTO fixture_private.addresses VALUES('fixture_address_a',1000000000,2000000000,1000000000,2,1788220800,1788220800),('fixture_address_b',500000000,500000000,0,1,1788220800,1788220800);
INSERT INTO fixture_private.address_activity VALUES('fixture_address_a','fixture_tx_0',3500000,1788220800,0,true,true,100,50),('fixture_address_b','fixture_tx_0',3500000,1788220800,0,false,true,50,0),('fixture_address_a','fixture_tx_1',3500001,1788220875,1,true,false,0,50);
-- The same three September 1 incidences, summarized; other September dates have blocks but no incidences.
INSERT INTO fixture_private.address_daily SELECT DATE '2026-09-01'+i,CASE WHEN i=0 THEN 2 ELSE 0 END,CASE WHEN i=0 THEN 1 ELSE 0 END,CASE WHEN i=0 THEN 2 ELSE 0 END,CASE WHEN i=0 THEN 2 ELSE 0 END,CASE WHEN i=0 THEN 3 ELSE 0 END,CASE WHEN i=0 THEN 2 ELSE 0 END,CASE WHEN i=0 THEN 2 ELSE 0 END FROM generate_series(0,29) i;
-- Year-end and September 2026 supply dates (2016-12-31 through 2026-10-28) with steady 1150-block days.
INSERT INTO fixture_private.supply_daily SELECT d,3000000+i,'fixture_hash',extract(epoch FROM d)::bigint+86000,1500000000000000+i*179687500000,7000000000000,1500000000000000+i*179687500000-7000000000000,CASE WHEN i>0 THEN 179687500000 END FROM generate_series(DATE '2016-12-31',DATE '2026-10-28','1 day') WITH ORDINALITY g(d,n) CROSS JOIN LATERAL (SELECT (n-1)::bigint AS i) x;
-- Daily blocks in 2025 and September 2026 at the post-2726400 split, one per hour.
INSERT INTO fixture_private.issuance SELECT 2900000+n,'fixture_hash',extract(epoch FROM t)::bigint,156250000,125000000,0,12500000,18750000,0,1000 FROM generate_series(TIMESTAMP '2025-01-01',TIMESTAMP '2026-10-28','1 hour') WITH ORDINALITY g(t,n);
-- Pools over the 40 completed days before today: 1,150 blocks a day.
INSERT INTO fixture_private.mining_daily SELECT d,p,b,1150 FROM generate_series(CURRENT_DATE-40,CURRENT_DATE-1,'1 day') d CROSS JOIN (VALUES('ViaBTC',400),('F2Pool',250),('Foundry USA',200),('AntPool',100),('Unknown',200)) v(p,b);
INSERT INTO fixture_private.software_daily SELECT d,s,b,1150 FROM generate_series(DATE '2026-08-25',DATE '2026-10-05','1 day') d CROSS JOIN (VALUES('zebra',300),('zakura',150),('unknown',700),('missing',0)) v(s,b);
-- Three payout addresses with distinct clock offsets, one block every 10 minutes.
INSERT INTO fixture_private.block_timing SELECT 3530000+n,'fixture_hash',extract(epoch FROM t)::bigint,m,extract(epoch FROM t)::bigint+o,o,'node-block-stream' FROM generate_series(TIMESTAMP '2026-10-18',TIMESTAMP '2026-10-29','10 minutes') WITH ORDINALITY g(t,n) CROSS JOIN LATERAL (SELECT CASE n%3 WHEN 0 THEN 't1fast' WHEN 1 THEN 't1slow' ELSE 't1ahead' END AS m,CASE n%3 WHEN 0 THEN 0.5 WHEN 1 THEN 4.25 ELSE -2.75 END AS o) x;
INSERT INTO fixture_private.issuance_daily SELECT d,1000*i+1,1000*(i+1),1000,156250000000,125000000000,0,12500000000,18750000000,0 FROM generate_series(DATE '2024-12-01',DATE '2026-10-28','1 day') WITH ORDINALITY g(d,n) CROSS JOIN LATERAL (SELECT n::bigint AS i) x;
-- One depth-1 reorg every 2.5 days in September-November 2026, one depth-2; each orphan replaced by fixture_block_0's miner.
INSERT INTO fixture_private.reorgs SELECT n,3510000+n*100,CASE WHEN n=20 THEN 2 ELSE 1 END,CASE WHEN n=20 THEN 2 ELSE 1 END,CASE WHEN n=20 THEN 2 ELSE 1 END,extract(epoch FROM TIMESTAMP '2026-09-01'+n*INTERVAL '60 hours')::bigint FROM generate_series(1,36) n;
INSERT INTO fixture_private.orphaned_blocks SELECT 3510000+n*100,'fixture_orphan_'||n,'fixture_block_0',extract(epoch FROM TIMESTAMP '2026-09-01'+n*INTERVAL '60 hours')::bigint-60,CASE n%3 WHEN 0 THEN 't1orphanA' WHEN 1 THEN 't1orphanB' ELSE 'fixture_miner' END,2,500,n,extract(epoch FROM TIMESTAMP '2026-09-01'+n*INTERVAL '60 hours')::bigint,n=7 FROM generate_series(1,36) n;
RESET ROLE;`;

// Independent, fixed mathematical oracles; these do not trust case.fixtureRows.
const oracles={
 fixture_zero_baseline:[['2026-09-01','0','5','5',null]],
 fixture_null_fee_average:[['3','2','1','0.00000050']],
 fixture_exact_large_count:[['2026-09-01','9007199254740993']],
 fixture_boolean_unknown:[['2026-09-01','true','false',null]],
 fixture_empty_interval:[],
};

test('disposable PG16 catalogue SQL and exact wire transport',{skip:process.env.ASK_EVAL_TEST_POSTGRES!=='1',timeout:45000},async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{Client}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;
 assert.ok(bin&&path.isAbsolute(bin),'ASK_LOGICAL_PG_BIN must be an absolute PG16 binary directory');
 assert.notEqual(process.getuid?.(),0,'Run the disposable fixture as a non-root OS user');
 const command=(name,args,timeout=7500)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout,maxBuffer:1048576,stdio:['ignore','pipe','pipe'],env:{PATH:bin+':/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
 assert.match(command('postgres',['--version']),/^postgres \(PostgreSQL\) 16\./);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-eval-pg16-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.chmodSync(root,0o700);fs.mkdirSync(socket,{mode:0o700});
 let startAttempted=false,admin,reader;
 const close=async client=>{if(!client)return;let timer;try{await Promise.race([client.end(),new Promise(resolve=>{timer=setTimeout(()=>{client.connection?.stream?.destroy();resolve();},1000);})]);}finally{clearTimeout(timer);}};
 // Cleanup is registered before init/start. A timed-out pg_ctl start can leave
 // postgres alive, so every attempted start receives stop, not only successes.
 t.after(async()=>{
  await Promise.allSettled([close(reader),close(admin)]);
  let stopped=!startAttempted;
  if(startAttempted){
   try{command('pg_ctl',['-D',data,'-m','fast','-t','3','-w','stop'],4500);stopped=true;}
   catch{try{command('pg_ctl',['-D',data,'-m','immediate','-t','2','-w','stop'],3500);stopped=true;}catch{stopped=!fs.existsSync(path.join(data,'postmaster.pid'));}}
  }
  if(stopped)fs.rmSync(root,{recursive:true,force:true});
  assert.ok(stopped,'Disposable cluster stop failed; fixture directory retained at '+root);
 });
 command('initdb',['-D',data,'-U','ask_eval_fixture','-A','trust','--no-locale','--encoding=UTF8'],10000);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nport=5432\nunix_socket_directories='${socket.replaceAll("'","''")}'\nunix_socket_permissions=0700\nshared_buffers='16MB'\nmax_connections=10\nlog_min_messages=warning\n`);
 startAttempted=true;command('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-t','6','-w','start'],8000);
 const connect=user=>new Client({host:socket,port:5432,user,database:'postgres',ssl:false,connectionTimeoutMillis:1500,query_timeout:4000,application_name:'ask-eval-native-fixture'});
 admin=connect('ask_eval_fixture');await admin.connect();await admin.query(schemaSQL);
 reader=connect('ask_eval_reader');await reader.connect();
 await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const read=async compiled=>{const raw=await reader.query({text:compiled.text,values:compiled.values,rowMode:'array',types:{getTypeParser:()=>value=>value}});return researchEvidence(compiled,raw.rows,raw.fields,{indexed_through:when},when);};
 const results=new Map();

 await t.test('reader uses private socket, published views and independent read-only privileges',async()=>{
  const identity=(await reader.query(`SELECT current_user AS identity,current_setting('transaction_read_only') AS readonly,current_setting('work_mem') AS work_mem,current_setting('temp_file_limit') AS temp_limit,inet_server_addr() IS NULL AS unix_socket`)).rows[0];
  assert.deepEqual(identity,{identity:'ask_eval_reader',readonly:'on',work_mem:'1MB',temp_limit:'16MB',unix_socket:true});
  const role=(await admin.query(`SELECT rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='ask_eval_reader'`)).rows[0];
  assert.ok(Object.values(role).every(value=>value===false));
  const denied=async(sql,code)=>{await reader.query('SAVEPOINT privilege_probe');try{await assert.rejects(reader.query(sql),error=>error.code===code);}finally{await reader.query('ROLLBACK TO SAVEPOINT privilege_probe');await reader.query('RELEASE SAVEPOINT privilege_probe');}};
  await denied('SELECT * FROM fixture_private.blocks','42501');
  await denied('INSERT INTO analytics_public.blocks_query(height) VALUES(9999999)','42501');
  // The reader has no INSERT privilege, so its ACL denial precedes the
  // read-only check. Prove that separate guard with fixture-admin privileges;
  // the reader never receives write grants, even temporarily.
  await admin.query('BEGIN READ ONLY');
  try{await assert.rejects(admin.query('INSERT INTO fixture_private.blocks(height) VALUES(9999999)'),error=>error.code==='25006');}
  finally{await admin.query('ROLLBACK');}
  assert.equal((await reader.query('SELECT count(*) FROM analytics_public.blocks_query')).rows[0].count,'21');
 });

 for(const item of cases.filter(entry=>entry.kind==='research'))await t.test('native syntax/comparison capability: '+item.id,async()=>{
  const compiled=await compileResearchSQL({version:3,sql:item.referenceSQL,limit:100},{extended:true,...preview}),candidate=await read(compiled);
  assert.equal(candidate.truncated,false);assert.equal(candidate.columns.length,item.roles.length);
  const combined=await comparisonQuery(item,candidate),verification=await read(await compileResearchSQL(combined,{extended:true,...preview}));
  const pair=splitComparison(item,candidate,verification);
  const mapping=matchRoles(item,pair.reference,pair.observed,candidate.columns);
  assert.ok(mapping,'native typed rows retain an equivalent role mapping');assert.equal(new Set(mapping).size,item.roles.length);
  results.set(item.id,{candidate,verification,pair});
 });

 for(const [id,expected]of Object.entries(oracles))await t.test('independent exact native oracle: '+id,()=>{
  const {candidate,pair}=results.get(id);
  assert.deepEqual(pair.reference,expected);assert.deepEqual(pair.observed,expected);
  const normalized=candidate.rows.map(row=>row.map((cell,i)=>candidate.columns[i].type==='boolean'?(cell==='t'?'true':cell==='f'?'false':cell):cell));
  assert.deepEqual(normalized,expected);
  if(id==='fixture_boolean_unknown'){assert.deepEqual(candidate.rows,[['2026-09-01','t','f',null]]);assert.deepEqual(candidate.columns.slice(1).map(column=>column.type),['boolean','boolean','boolean']);}
 });

 await t.test('nonzero unclassified activity distinguishes all-transaction and classified-only shares',async()=>{
  const compiled=await compileResearchSQL({version:3,sql:`SELECT transactions,shielded_transactions,transparent_transactions,unclassified_transactions,
   round(100*shielded_transactions::numeric/nullif(transactions,0),2) AS all_share,
   round(100*shielded_transactions::numeric/nullif(shielded_transactions+transparent_transactions,0),2) AS classified_share
   FROM activity_daily WHERE date=DATE '2025-01-01'`,limit:10},{extended:true});
  const result=await read(compiled);
  assert.deepEqual(result.rows,[['300','100','180','20','33.33','35.71']]);
  assert.notEqual(result.rows[0][4],result.rows[0][5],'matching zero-unclassified production rows must not hide a wrong denominator');
 });

 await t.test('upstream period filtering cannot supply the requested full preceding baseline',async()=>{
  const bad=fs.readFileSync(path.join(__dirname,'../fixtures/ask-fixed-short-lookback.sql'),'utf8');
  const empty=await read(await compileResearchSQL({version:3,sql:bad,limit:100},{extended:true}));
  assert.deepEqual(empty.rows,[]);
  const reviewed=cases.find(item=>item.id==='shielded_baseline');
  const corrected=await read(await compileResearchSQL({version:3,sql:reviewed.referenceSQL,limit:100},{extended:true}));
  assert.equal(corrected.rows.length,10);
  assert.equal(corrected.rows[0][0],'2026-09-01');
  assert.equal(corrected.rows[0][1],'1000');
  assert.equal(corrected.rows[0][2],'100.00');
 });

 await t.test('transport check rejects a rounded large count instead of trusting numeric appearance',()=>{
  const {candidate,verification}=results.get('fixture_exact_large_count'),mutant={...candidate,rows:[['2026-09-01','9007199254740992']]};
  assert.throws(()=>splitComparison(cases.find(item=>item.id==='fixture_exact_large_count'),mutant,verification),error=>error.verificationDiagnostic?.stage==='snapshot-mismatch');
 });
 await t.test('transport check keeps false distinct from unknown NULL',()=>{
  const {candidate,verification}=results.get('fixture_boolean_unknown'),mutant={...candidate,rows:[['2026-09-01','t','f','f']]};
  assert.throws(()=>splitComparison(cases.find(item=>item.id==='fixture_boolean_unknown'),mutant,verification),error=>error.verificationDiagnostic?.stage==='snapshot-mismatch');
 });
 await t.test('explicit NULLS LAST selects the measured change while direct SQL preserves default null ordering',async()=>{
  const base="WITH evaluation_seed AS(SELECT height FROM blocks WHERE height=0 LIMIT 1),change_samples AS(SELECT 'missing'::text AS label,NULL::numeric AS delta FROM evaluation_seed UNION ALL SELECT 'decrease'::text,-5::numeric FROM evaluation_seed UNION ALL SELECT 'increase'::text,2::numeric FROM evaluation_seed) SELECT label,delta FROM change_samples ORDER BY abs(delta) DESC";
  const defaultOrder=await read(await compileResearchSQL({version:3,sql:base+' LIMIT 1',limit:1},{extended:true}));
  const knownFirst=await read(await compileResearchSQL({version:3,sql:base+' NULLS LAST LIMIT 1',limit:1},{extended:true}));
  assert.deepEqual(defaultOrder.rows,[['missing',null]]);
  assert.deepEqual(knownFirst.rows,[['decrease','-5']]);
 });
 await t.test('summary-row counts and public-record counts have different grains',async()=>{
  const compiled=await compileResearchSQL({version:3,sql:"SELECT count(*) AS summary_rows,sum(records) AS public_records FROM flow_daily WHERE date=DATE '2026-09-01' AND direction='shield'",limit:1},{extended:true});
  assert.deepEqual((await read(compiled)).rows,[['2','4']]);
 });
 await reader.query('ROLLBACK');
});
