'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const subscriberSQL=fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics/subscriber-core-v1.sql'),'utf8');
const fixtureHash=tag=>createHash('sha256').update(tag).digest('hex');
const {execFileSync}=require('node:child_process');
const {TABLES,publicationDDL,buildPreflightSQL,assessPreflight,buildPublicationPlan}=require('../../scripts/profile-ask-logical-sync');

function ready() {
 return {kind:'logical_sync_preflight',database:'zcash_explorer_mainnet',standby:false,version:'16.15',
  settings:{wal_level:{value:'logical'},max_slot_wal_keep_size:{value:'64'},max_replication_slots:{value:'8'},max_wal_senders:{value:'8'}},
  slots:{total:0},connected_wal_senders:0,
  core_keys:TABLES.map(t=>({relation:t.name,present:true,identity_valid:true,replica_identity:'d',identity_columns:t.key,missing_columns:[],columns:t.types}))};
}
test('operator preflight/plan stays fixed and activation remains separate from configuration readiness',()=>{
 assert.equal(assessPreflight(ready()).configuration_ready,true);
 assert.equal(assessPreflight(ready()).activation_authorized,false);
 const cases=[
  [r=>{r.settings.wal_level.value='replica';},'logical_wal_requires_planned_restart'],
  [r=>{r.settings.max_slot_wal_keep_size.value='-1';},'finite_positive_slot_wal_budget_required'],
  [r=>{r.settings.max_slot_wal_keep_size.value='0';},'finite_positive_slot_wal_budget_required'],
  [r=>{r.slots.total=7;},'snapshot_slot_headroom_required'],
  [r=>{r.connected_wal_senders=7;},'snapshot_sender_headroom_required'],
  [r=>{r.standby=true;},'verified_mainnet_primary_required'],
  [r=>{r.database='other';},'verified_mainnet_primary_required'],
  [r=>{r.version='14.18';},'reviewed_pg16_required'],
  [r=>{r.settings.wal_level.pending_restart=true;},'pending_settings_require_review'],
  [r=>{r.core_keys[2].identity_columns=['txid','flow_type'];},'reviewed_identity_and_columns_required:shielded_flows'],
  [r=>{r.core_keys[0].missing_columns=['previous_block_hash'];},'reviewed_identity_and_columns_required:blocks'],
  [r=>{r.core_keys[1].columns.fee='text';},'reviewed_types_required:transactions'],
 ];
 for(const [mutate,reason] of cases) {const r=structuredClone(ready());mutate(r);assert.ok(assessPreflight(r).blockers.includes(reason));}
 const sql=buildPreflightSQL();assert.match(sql,/BEGIN READ ONLY/);assert.match(sql,/ROLLBACK;/);
 assert.doesNotMatch(sql,/CREATE |ALTER |INSERT |UPDATE |DELETE |pg_create_logical_replication_slot/);
 const plan=buildPublicationPlan();assert.match(plan,/CREATE PUBLICATION/);assert.doesNotMatch(plan,/FOR ALL TABLES|CREATE SUBSCRIPTION|PASSWORD|ALTER SYSTEM|SELECT \*/);
 assert.deepEqual(TABLES.find(t=>t.name==='shielded_flows').key,['id']);
 assert.ok(Object.isFrozen(TABLES[0].columns));
});

const enabled=process.env.ASK_LOGICAL_TEST_POSTGRES==='1';
test('isolated PG16: filtered initial copy, atomic CDC, pause/resume, restart and restricted reader', {skip:!enabled},async t=>{
 const {Pool}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;
 if(!bin || !path.isAbsolute(bin)) throw new Error('Explicit absolute PG16 fixture binary directory required');
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 assert.match(command('postgres',['--version']),/^postgres \(PostgreSQL\) 16\./);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-logical-fixture-'));
 fs.chmodSync(root,0o700);
 const clusters=['source','target'].map(name=>({name,data:path.join(root,name),socket:path.join(root,`${name}-socket`),active:false}));
 const pools=[];let source,target,reader;
 const start=c=>{command('pg_ctl',['-D',c.data,'-l',path.join(root,`${c.name}.log`),'-w','start']);c.active=true;};
 const stop=c=>{command('pg_ctl',['-D',c.data,'-m','fast','-w','stop']);c.active=false;};
 const close=async pool=>{if(pool && pools.includes(pool)) {pools.splice(pools.indexOf(pool),1);await pool.end();}};
 const pool=(cluster,user='ask_fixture_admin')=>{const p=new Pool({host:cluster.socket,port:5432,user,database:cluster.name==='target'?'ask_analytics':'ask_logical_fixture',max:2,ssl:false});pools.push(p);return p;};
 t.after(async()=>{
  for(const p of [...pools]) await close(p);
  try {for(const c of clusters.reverse()) if(c.active) stop(c);}
  finally {if(clusters.every(c=>!c.active)) fs.rmSync(root,{recursive:true,force:true});}
 });
 for(const c of clusters) {
  fs.mkdirSync(c.socket,{mode:0o700});
  command('initdb',['-D',c.data,'-U','ask_fixture_admin','-A','trust','--no-locale','--encoding=UTF8']);
  fs.appendFileSync(path.join(c.data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${c.socket.replaceAll("'","''")}'\nwal_level=logical\nmax_replication_slots=8\nmax_wal_senders=8\nmax_logical_replication_workers=4\nmax_worker_processes=8\nmax_slot_wal_keep_size='64MB'\nshared_buffers='32MB'\nlog_min_messages=warning\n`);
  start(c);
  const admin=new Pool({host:c.socket,port:5432,user:'ask_fixture_admin',database:'postgres',max:1,ssl:false});
  try {
   if(c.name==='target') {
    await admin.query('CREATE ROLE analytics_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await admin.query('CREATE DATABASE ask_analytics OWNER analytics_owner');
   } else await admin.query('CREATE DATABASE ask_logical_fixture');
  }finally {await admin.end();}
 }
 source=pool(clusters[0]);target=pool(clusters[1]);
 for(const table of TABLES) {
  const columns=table.columns.map(k=>`${k} ${table.types[k]}`);
  await source.query(`CREATE TABLE public.${table.name}(${columns.join(',')},private_marker text,PRIMARY KEY(${table.key.join(',')}))`);

 }
 await source.query(`CREATE TABLE public.private_fixture(secret text);INSERT INTO public.private_fixture VALUES('secret-fixture');
  CREATE ROLE ask_fixture_replicator LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 4;`);
 for(const table of TABLES) await source.query(`GRANT SELECT(${table.columns.join(',')}) ON public.${table.name} TO ask_fixture_replicator`);
 await source.query(publicationDDL());
 await t.test('fresh migration rejects inherited owner authority without creating objects',async()=>{
  await target.query('CREATE ROLE ask_fixture_extra NOLOGIN;GRANT ask_fixture_extra TO analytics_owner');
  await assert.rejects(target.query(subscriberSQL),/must not inherit other roles/);
  await target.query('ROLLBACK');
  assert.equal((await target.query("SELECT count(*) FROM pg_roles WHERE rolname IN ('ask_public_reader','ask_public_view_owner')")).rows[0].count,'0');
  await target.query('REVOKE ask_fixture_extra FROM analytics_owner;DROP ROLE ask_fixture_extra');
 });
 await target.query(subscriberSQL);
 // Production migration leaves the reader dormant. Only this private trust
 // fixture activates it; no real credential/HBA or deployed worker is involved.
 assert.equal((await target.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='ask_public_reader'")).rows[0].rolcanlogin,false);
 await target.query('ALTER ROLE ask_public_reader LOGIN');
 const sourceSystem=(await source.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;
 const markReady=async()=>{
  const tip=(await target.query('SELECT height::text,hash FROM public.blocks ORDER BY height DESC LIMIT 1')).rows[0];
  const progress=(await target.query('SELECT remote_lsn::text FROM pg_replication_origin_status LIMIT 1')).rows[0];
  // Trusted fixture admin publishes synthetic coverage after waiting for native
  // apply. This is NOT the production reconciliation/admission service.
  await target.query(`UPDATE analytics_meta.sync_state SET state='ready',source_id='00000000-0000-4000-8000-000000000001',
   source_system_identifier=$1,applied_lsn=$2,covered_from=1,covered_through=$3,tip_hash=$4,verified_at=clock_timestamp()`,
   [sourceSystem,progress?.remote_lsn||'0/0',tip.height,tip.hash]);
 };
 const insertBlock=async(c,height,tag)=>{
  const hash=fixtureHash(tag);
  const columns=TABLES[0].columns;
  await c.query(`INSERT INTO blocks(${columns.join(',')},private_marker) VALUES($1,$2,$3,$4,2,100,7,'fixture-miner','excluded-secret')`,[height,hash,fixtureHash(height===1?'parent':'b1'),1700000000+height]);
  for(const coinbase of [true,false]) {
   const txid=`${tag}-${coinbase?'coinbase':'tx'}`;
   const values={txid,block_height:height,block_hash:hash,block_time:String(1700000000+height),is_coinbase:coinbase,fee:coinbase?'0':'7',size:'50',has_sapling:false,has_orchard:!coinbase,has_ironwood:false,has_sprout:false,value_balance_orchard:null,value_balance_ironwood:null};
   const fields=TABLES[1].columns;
   await c.query(`INSERT INTO transactions(${fields.join(',')},private_marker) VALUES(${fields.map((_,i)=>`$${i+1}`).join(',')},'excluded-secret')`,fields.map(k=>values[k]));
  }
  await c.query("INSERT INTO shielded_flows VALUES($1,$2,$3,$4,'shield','orchard',9007199254740993,'excluded-secret')",[height*10,`${tag}-tx`,height,1700000000+height]);
 };
 await insertBlock(source,1,'b1');
 await source.query("INSERT INTO shielded_flows VALUES(11,'b1-tx',1,1700000001,'deshield','orchard',100,'excluded-secret')");
 const conn=`host=${clusters[0].socket} port=5432 dbname=ask_logical_fixture user=ask_fixture_replicator application_name=ask_fixture`;
 await target.query(`CREATE SUBSCRIPTION ask_public_core_v1 CONNECTION '${conn.replaceAll("'","''")}' PUBLICATION ask_public_core_v1 WITH(copy_data=true,streaming=off,disable_on_error=true)`);
 reader=pool(clusters[1],'ask_public_reader');
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const wait=async(fn)=>{const until=Date.now()+10000;while(Date.now()<until) {if(await fn()) return;await sleep(40);}throw new Error('Fixture replication deadline exceeded');};
 const counts=async()=>(await reader.query(`SELECT (SELECT count(*) FROM analytics_public.blocks)::text AS blocks,
  (SELECT count(*) FROM analytics_public.transactions)::text AS transactions,
  (SELECT count(*) FROM analytics_public.flows)::text AS flows`)).rows[0];
 await t.test('column-filtered snapshot synchronizes all tables and retains exact amounts',async()=>{
  await wait(async()=>Number((await target.query("SELECT count(*) FROM pg_subscription_rel WHERE srsubstate='r'")).rows[0].count)===3);
  assert.equal((await reader.query('SELECT ready FROM analytics_public.coverage')).rows[0].ready,false);
  assert.deepEqual(await counts(),{blocks:'0',transactions:'0',flows:'0'});
  await markReady();
  await wait(async()=>(await counts()).flows==='2');
  assert.deepEqual(await counts(),{blocks:'1',transactions:'2',flows:'2'});
  assert.equal((await reader.query("SELECT amount_zat::text FROM analytics_public.flows WHERE flow_type='shield'")).rows[0].amount_zat,'9007199254740993');
  const attrs=(await target.query("SELECT count(*) FROM pg_attribute WHERE attname='private_marker' AND attrelid IN ('public.blocks'::regclass,'public.transactions'::regclass,'public.shielded_flows'::regclass)")).rows[0];assert.equal(attrs.count,'0');
 });
 await t.test('source transaction publishes block, transactions and flows atomically',async()=>{
  const client=await source.connect();
  try {await client.query('BEGIN');await insertBlock(client,2,'b2');await sleep(100);assert.deepEqual(await counts(),{blocks:'1',transactions:'2',flows:'2'});await client.query('COMMIT');}
  finally {await client.query('ROLLBACK');client.release();}
  await wait(async()=>(await target.query('SELECT count(*) FROM public.blocks')).rows[0].count==='2');
  await markReady();
  await wait(async()=>(await counts()).blocks==='2');
  assert.deepEqual(await counts(),{blocks:'2',transactions:'4',flows:'3'});
 });
 await t.test('disabled consumer catches historical updates/deletes and reorg rollback on resume',async()=>{
  await target.query('ALTER SUBSCRIPTION ask_public_core_v1 DISABLE');
  await wait(async()=>Number((await target.query('SELECT count(*) FROM pg_stat_subscription WHERE pid IS NOT NULL')).rows[0].count)===0);
  await source.query(`BEGIN;UPDATE transactions SET fee=42 WHERE txid='b1-tx';UPDATE shielded_flows SET amount_zat=123 WHERE id=10;
    DELETE FROM shielded_flows WHERE id=11 OR block_height=2;DELETE FROM transactions WHERE block_height=2;DELETE FROM blocks WHERE height=2;COMMIT`);
  assert.deepEqual(await counts(),{blocks:'2',transactions:'4',flows:'3'});
  assert.equal((await reader.query("SELECT fee::text FROM analytics_public.transactions WHERE txid='b1-tx'")).rows[0].fee,'7');
  await target.query('ALTER SUBSCRIPTION ask_public_core_v1 ENABLE');
  await wait(async()=>(await target.query('SELECT count(*) FROM public.blocks')).rows[0].count==='1');
  assert.equal((await reader.query('SELECT ready FROM analytics_public.coverage')).rows[0].ready,false);
  await markReady();
  await wait(async()=>(await counts()).blocks==='1');
  assert.deepEqual(await counts(),{blocks:'1',transactions:'2',flows:'1'});
  assert.equal((await reader.query("SELECT fee::text FROM analytics_public.transactions WHERE txid='b1-tx'")).rows[0].fee,'42');
  assert.equal((await reader.query('SELECT amount_zat::text FROM analytics_public.flows')).rows[0].amount_zat,'123');
 });
 await t.test('subscriber process restart resumes durable native checkpoint',async()=>{
  await close(reader);await close(target);stop(clusters[1]);
  await source.query('BEGIN');await insertBlock(source,2,'replacement-b2');await source.query('COMMIT');
  start(clusters[1]);target=pool(clusters[1]);reader=pool(clusters[1],'ask_public_reader');
  await wait(async()=>(await target.query('SELECT count(*) FROM public.blocks')).rows[0].count==='2');
  await markReady();
  await wait(async()=>(await counts()).blocks==='2');
  assert.deepEqual(await counts(),{blocks:'2',transactions:'4',flows:'2'});
  assert.equal((await reader.query('SELECT hash FROM analytics_public.blocks WHERE height=2')).rows[0].hash,fixtureHash('replacement-b2'));
 });
 await t.test('truncate changes are carried; WAL budget is finite and identity unchanged',async()=>{
  await source.query('TRUNCATE shielded_flows');await wait(async()=>(await counts()).flows==='0');
  const report=(await source.query("SELECT current_setting('max_slot_wal_keep_size') AS budget,(SELECT count(*) FROM pg_replication_slots WHERE slot_type='logical')::text AS slots")).rows[0];
  assert.equal(report.budget,'64MB');assert.equal(report.slots,'1');
  const flowPK=(await source.query("SELECT attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) key(attnum) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum WHERE i.indrelid='shielded_flows'::regclass AND i.indisprimary")).rows.map(r=>r.attname);assert.deepEqual(flowPK,['id']);
 });
 await t.test('replication credentials/private columns are inaccessible to query reader',async()=>{
  const attacker=await reader.connect();
  try {
   await attacker.query('SET default_transaction_read_only=off');
   assert.equal((await attacker.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'off');
   for(const attack of ['SELECT * FROM public.transactions','DELETE FROM public.blocks','SELECT * FROM analytics_meta.sync_state',"UPDATE analytics_meta.sync_state SET state='ready'",'SELECT id FROM public.shielded_flows','SET ROLE analytics_owner','SET ROLE ask_public_view_owner','DROP VIEW analytics_public.blocks','CREATE TABLE public.attack(x int)','CREATE ROLE attack','SELECT subconninfo FROM pg_subscription','DELETE FROM analytics_public.blocks','CREATE TEMP TABLE attack(x int)',
    "SELECT pg_read_file('/etc/passwd')",'SET ROLE ask_fixture_admin','ALTER SUBSCRIPTION ask_public_core_v1 DISABLE',
    "COPY (SELECT height FROM analytics_public.blocks) TO PROGRAM 'id'",
    "COPY (SELECT height FROM analytics_public.blocks) TO '/tmp/ask-forbidden-output'"]) await assert.rejects(attacker.query(attack),/permission|must be|not permitted|cannot delete from view/i,attack);
   assert.equal((await attacker.query("SELECT has_table_privilege(current_user,'analytics_public.coverage','UPDATE') AS allowed")).rows[0].allowed,false);
  } finally {attacker.release();}
  const replicator=pool(clusters[0],'ask_fixture_replicator');
  await assert.rejects(replicator.query('SELECT private_marker FROM public.blocks'),/permission denied/);
  await assert.rejects(replicator.query('SELECT secret FROM public.private_fixture'),/permission denied/);
  await close(replicator);
 });
 await t.test('destination migration matches types, rejects reruns and excludes noncanonical/uncovered rows',async()=>{
  for(const table of TABLES) {
   const actual=(await target.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a
    WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[`public.${table.name}`])).rows;
   assert.deepEqual(actual.map(a=>a.attname),table.columns);
   assert.deepEqual(Object.fromEntries(actual.map(a=>[a.attname,a.type])),table.types);
  }
  await assert.rejects(target.query(subscriberSQL),/empty and reserved/);await target.query('ROLLBACK');
  await assert.rejects(source.query(subscriberSQL),/Expected dedicated/);await source.query('ROLLBACK');
  await target.query(`INSERT INTO public.transactions(txid,block_height,block_hash,block_time) VALUES
   ('orphan',1,'wrong-hash',1700000001),('wrong-time',1,$1,0)`,[fixtureHash('b1')]);
  await target.query('INSERT INTO public.blocks(height,hash,timestamp) VALUES(3,$1,1700000003)',[fixtureHash('b3')]);
  assert.deepEqual(await counts(),{blocks:'2',transactions:'4',flows:'0'});
  await target.query("DELETE FROM public.transactions WHERE txid IN ('orphan','wrong-time');DELETE FROM public.blocks WHERE height=3");
 });
 await t.test('unready, stale, future-dated or quarantined evidence hides all data and cannot be forged by reader',async()=>{
  for(const state of ['copying','reconciling','quarantined']) {
   await target.query('UPDATE analytics_meta.sync_state SET state=$1',[state]);
   assert.deepEqual(await counts(),{blocks:'0',transactions:'0',flows:'0'});
  }
  await markReady();
  for(const offset of ["-interval '121 seconds'","+interval '1 hour'"]) {
   await target.query(`UPDATE analytics_meta.sync_state SET verified_at=clock_timestamp()${offset}`);
   assert.deepEqual(await counts(),{blocks:'0',transactions:'0',flows:'0'});
   assert.equal((await reader.query('SELECT state FROM analytics_public.coverage')).rows[0].state,'stale');
  }
  await markReady();
  await target.query("UPDATE analytics_meta.sync_state SET tip_hash=repeat('f',64)");
  assert.deepEqual(await counts(),{blocks:'0',transactions:'0',flows:'0'});
  await markReady();assert.deepEqual(await counts(),{blocks:'2',transactions:'4',flows:'0'});
  await assert.rejects(reader.query('UPDATE analytics_public.coverage SET ready=true'),/permission|cannot update view|not automatically/i);
  await assert.rejects(reader.query('SELECT source_system_identifier,applied_lsn FROM analytics_public.coverage'),/does not exist/);
  const ownerProbe=await target.connect();
  try {
   await ownerProbe.query('SET ROLE ask_public_view_owner');
   await assert.rejects(ownerProbe.query('SELECT id FROM public.shielded_flows'),/permission/);
   await assert.rejects(ownerProbe.query('SELECT source_system_identifier FROM analytics_meta.sync_state'),/permission/);
  } finally {await ownerProbe.query('RESET ROLE');ownerProbe.release();}
 });
 await t.test('dedicated admission tracks actual native changes, rejects stale signals and quarantines broken history',async admission=>{
  const {refreshAdmission}=require('../../scripts/ask-core-admission');
  const {CORE_GUARD,checkCoreGuard,createAnalytics}=require('../../v1/lib/ask-analytics');
  const {compileCorePlan}=require('../../v1/lib/ask-core-catalogue');
  await target.query(fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics/admission-v1.sql'),'utf8'));
  await source.query('BEGIN');await insertBlock(source,0,'parent');await source.query('COMMIT');
  await source.query(`CREATE SCHEMA analytics_feed_meta; CREATE TABLE analytics_feed_meta.signal(singleton boolean PRIMARY KEY,generation uuid NOT NULL,system_identifier text NOT NULL,timeline integer NOT NULL,sampled_at timestamptz NOT NULL,tip_height bigint NOT NULL,tip_hash text NOT NULL,before_lsn pg_lsn NOT NULL); GRANT USAGE ON SCHEMA analytics_feed_meta TO ask_fixture_replicator; GRANT SELECT ON analytics_feed_meta.signal TO ask_fixture_replicator; ALTER PUBLICATION ask_public_core_v1 ADD TABLE analytics_feed_meta.signal`);
  const signal=async()=>source.query(`INSERT INTO analytics_feed_meta.signal SELECT true,'00000000-0000-4000-8000-000000000001',$1,2,clock_timestamp(),height,hash,pg_current_wal_lsn() FROM blocks ORDER BY height DESC LIMIT 1 ON CONFLICT(singleton) DO UPDATE SET sampled_at=EXCLUDED.sampled_at,tip_height=EXCLUDED.tip_height,tip_hash=EXCLUDED.tip_hash,before_lsn=EXCLUDED.before_lsn`,[sourceSystem]);
  await signal();await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION');
  await wait(async()=>(await target.query("SELECT count(*) FROM pg_subscription_rel WHERE srsubstate='r'")).rows[0].count==='4');
  const result=await refreshAdmission(target);assert.equal(result.state,'verified');
  checkCoreGuard((await reader.query(CORE_GUARD)).rows[0]);
  assert.equal((await reader.query('SELECT ready FROM analytics_public.coverage')).rows[0].ready,true);
  for(const sql of ['SELECT * FROM analytics_feed_meta.signal','SELECT * FROM analytics_meta.dirty_heights','SELECT analytics_meta.is_admitted()','SELECT analytics_meta.track_change()'])await assert.rejects(reader.query(sql),/permission|trigger/i);
  const plan={version:2,dataset:'transactions',start:'2023-11-14',end:'2023-11-14',bucket:'none',dimensions:[],filters:[],measures:[{field:'records',operation:'count',filters:[]}],calculations:[],order:{column:0,direction:'desc'},limit:5};
  const compiled=compileCorePlan(plan);assert.equal((await reader.query(compiled.text,compiled.values)).rows[0].m0,'3.000000');
  const research=await require('../../v1/lib/ask-research-sql').compileResearchSQL({version:3,limit:5,sql:'WITH totals AS(SELECT height,sum(fees)::numeric AS fees FROM transactions GROUP BY height) SELECT totals.height,totals.fees,9007199254740993::numeric AS exact,rank() OVER(ORDER BY totals.fees DESC) AS ranking FROM totals JOIN blocks b ON b.height=totals.height ORDER BY totals.height'});
  const researchClient=await reader.connect();try{await researchClient.query('BEGIN READ ONLY');await researchClient.query("SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC'");const raw=await researchClient.query({text:research.text,values:research.values,rowMode:'array',types:{getTypeParser:()=>v=>v}});const result=require('../../v1/lib/ask-research-sql').researchEvidence(research,raw.rows,raw.fields,{indexed_through:'2026-10-06T00:00:00Z'},'2026-10-06T00:00:01Z');assert.deepEqual(result.rows,[['0','7','9007199254740993','2'],['1','42','9007199254740993','1'],['2','7','9007199254740993','2']]);}finally{await researchClient.query('ROLLBACK');researchClient.release();}
  const executeResearch=async sql=>{
   const compiled=await require('../../v1/lib/ask-research-sql').compileResearchSQL({version:3,limit:10,sql});
   const client=await reader.connect();
   try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC'");
    return (await client.query({text:compiled.text,values:compiled.values,rowMode:'array',types:{getTypeParser:()=>v=>v}})).rows;
   } finally {await client.query('ROLLBACK');client.release();}
  };
  await admission.test('three-table research preserves exact net flows and prevents fee multiplication',async()=>{
   // Fixture source only: two flow rows for one transaction expose join fanout.
   await source.query(`INSERT INTO shielded_flows VALUES
    (10,'b1-tx',1,1700000001,'shield','orchard',9007199254740993,'excluded-secret'),
    (11,'b1-tx',1,1700000001,'deshield','sapling',100,'excluded-secret'),
    (20,'replacement-b2-tx',2,1700000002,'shield','ironwood',5,'excluded-secret')`);
   await wait(async()=>(await target.query('SELECT count(*) FROM public.shielded_flows')).rows[0].count==='4');
   await signal();
   await wait(async()=>(await target.query("SELECT sampled_at FROM analytics_feed_meta.signal")).rows[0].sampled_at.getTime()===
    (await source.query("SELECT sampled_at FROM analytics_feed_meta.signal")).rows[0].sampled_at.getTime());
   assert.equal((await refreshAdmission(target)).state,'verified');
   const rows=await executeResearch(`WITH flow_totals AS (
    SELECT txid,count(*) AS flow_records,
     sum(CASE WHEN direction='shield' THEN amount ELSE 0 END)::numeric AS shielding,
     sum(CASE WHEN direction='deshield' THEN amount ELSE 0 END)::numeric AS deshielding
    FROM flows WHERE height>=1 GROUP BY txid
   ), per_block AS (
    SELECT b.height,sum(t.fees)::numeric AS fees,sum(f.shielding) AS shielding,
     sum(f.deshielding) AS deshielding,sum(f.flow_records) AS flow_records
    FROM blocks b JOIN transactions t ON t.height=b.height
    JOIN flow_totals f ON f.txid=t.txid WHERE b.height>=1 GROUP BY b.height
   ) SELECT height,fees,shielding,deshielding,shielding-deshielding AS net,
    flow_records,dense_rank() OVER(ORDER BY shielding-deshielding DESC) AS ranking
    FROM per_block ORDER BY height`);
   assert.deepEqual(rows,[['1','42','9007199254740993','100','9007199254740893','2','1'],['2','7','5','0','5','1','2']]);
   assert.equal(rows.reduce((sum,row)=>sum+BigInt(row[1]),0n),49n);
  });
  await admission.test('rolling averages, lag, filtered aggregates and nested queries execute on native PG16',async()=>{
   const rows=await executeResearch(`WITH fees_by_height AS (
    SELECT height,sum(fees)::numeric AS fees,count(*) FILTER(WHERE shielded) AS shielded_transactions
    FROM transactions GROUP BY height
   ) SELECT height,fees,shielded_transactions,
    round(avg(fees) OVER(ORDER BY height ROWS BETWEEN 1 PRECEDING AND CURRENT ROW),2) AS rolling_average,
    lag(fees) OVER(ORDER BY height) AS previous_fees
    FROM fees_by_height WHERE height<=(SELECT max(height) FROM blocks) ORDER BY height`);
   assert.deepEqual(rows,[['0','7','1','7.00',null],['1','42','1','24.50','7'],['2','7','1','24.50','42']]);
  });
  await admission.test('protocol cancellation stops a CPU-bound read before its thirty-second timeout',async()=>{
   const {Client}=require('pg');
   const client=await reader.connect();
   try{
    await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='30s'");
    const compiled=await require('../../v1/lib/ask-research-sql').compileResearchSQL({version:3,sql:'SELECT count(*) FROM '+Array.from({length:14},(_,i)=>'blocks b'+i).join(' CROSS JOIN '),limit:1});
    const started=Date.now();
    const pending=client.query({text:compiled.text,values:compiled.values});
    // Attach the rejection observer before sending cancellation.
    const cancelled=assert.rejects(pending,e=>e.code==='57014');
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(client.activeQuery);
    const cancel=new Client({host:clusters.find(c=>c.name==='target').socket,port:5432,user:'ask_public_reader',database:'ask_analytics',ssl:false});
    cancel.on('error',()=>{});cancel.cancel(client,client.activeQuery);
    await cancelled;assert.ok(Date.now()-started<3000);
    await client.query('ROLLBACK');assert.equal((await client.query('SELECT count(*) FROM analytics_public.blocks')).rows[0].count,'3');
   }finally{await client.query('ROLLBACK');client.release();}
  });
  await admission.test('PostgreSQL cancels overlong work independently of SQL validation',async()=>{
   const client=await reader.connect();
   try {
    // Deliberately bypass parser only in disposable fixture to test the DB layer.
    await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='50ms'");
    await assert.rejects(client.query('SELECT pg_sleep(1)'),e=>e.code==='57014');
    await client.query('ROLLBACK');
    // A policy-valid SELECT can still consume work despite its output limit.
    const costly=await require('../../v1/lib/ask-research-sql').compileResearchSQL({version:3,limit:1,
     sql:'SELECT count(*) FROM '+Array.from({length:14},(_,i)=>`blocks b${i}`).join(' CROSS JOIN ')});
    await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='50ms'");
    await assert.rejects(client.query(costly.text,costly.values),e=>e.code==='57014');
   } finally {await client.query('ROLLBACK');client.release();}
   assert.equal((await reader.query('SELECT ready FROM analytics_public.coverage')).rows[0].ready,true);
  });
  // Real source update, real logical apply, and replica-enabled dirty tracking.
  await source.query("UPDATE transactions SET fee=43 WHERE txid='b1-tx'");
  await wait(async()=>(await target.query("SELECT fee::text FROM public.transactions WHERE txid='b1-tx'")).rows[0].fee==='43');
  assert.equal((await reader.query('SELECT ready FROM analytics_public.coverage')).rows[0].ready,false);
  const analytics=createAnalytics({ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_DATABASE_URL:'peer-only',ASK_ANALYTICS_SOCKET:'/run/ask-public-db',ASK_ANALYTICS_STORE:'logical_public_core',ASK_ANALYTICS_DAILY_QUERY_LIMIT:'20'},{pool:reader});
  const redis={isReady:true,eval:async()=>1,zRem:async()=>1};
  await assert.rejects(analytics.execute(plan,{redis}),e=>e.askKind==='source');
  assert.equal((await refreshAdmission(target)).state,'verified');
  const evidence=await analytics.execute(plan,{redis});assert.equal(evidence.result.rows[0].m0.value,'3.000000');
  await source.query("UPDATE analytics_feed_meta.signal SET sampled_at=clock_timestamp()-interval '121 seconds'");
  await wait(async()=>(await target.query("SELECT sampled_at<clock_timestamp()-interval '120 seconds' AS stale FROM analytics_feed_meta.signal")).rows[0].stale);
  assert.equal((await reader.query('SELECT ready FROM analytics_public.coverage')).rows[0].ready,false);
  assert.equal((await refreshAdmission(target)).state,'stale');
  await signal();await wait(async()=>(await target.query("SELECT sampled_at>clock_timestamp()-interval '120 seconds' AS fresh FROM analytics_feed_meta.signal")).rows[0].fresh);
  assert.equal((await refreshAdmission(target)).state,'verified');
  // 2026-11-01: the Sprout repair backfilled historical pool='sprout' flows and
  // admission quarantined them as unknown pools. A Sprout flow is valid history.
  await source.query("INSERT INTO shielded_flows VALUES(12,'b1-tx',1,1700000001,'shield','sprout',50,'excluded-secret')");
  await wait(async()=>(await target.query("SELECT count(*)::int AS n FROM public.shielded_flows WHERE pool='sprout'")).rows[0].n===1);
  await signal();await wait(async()=>(await target.query("SELECT sampled_at>clock_timestamp()-interval '120 seconds' AS fresh FROM analytics_feed_meta.signal")).rows[0].fresh);
  assert.equal((await refreshAdmission(target)).state,'verified');
  await source.query('DELETE FROM shielded_flows WHERE id=12');
  await wait(async()=>(await target.query("SELECT count(*)::int AS n FROM public.shielded_flows WHERE pool='sprout'")).rows[0].n===0);
  await signal();await wait(async()=>(await target.query("SELECT sampled_at>clock_timestamp()-interval '120 seconds' AS fresh FROM analytics_feed_meta.signal")).rows[0].fresh);
  assert.equal((await refreshAdmission(target)).state,'verified');
  await admission.test('extended catalogue copies public columns, gates readiness, derives summaries and denies writes',async()=>{
   const strip=text=>text.replace(/^\\set.*$/gm,'');
   const migration=strip(fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics/catalogue-destination-v1.sql'),'utf8'));
   await target.query(migration);
   assert.equal((await reader.query("SELECT count(*) FROM analytics_public.dataset_coverage WHERE ready")).rows[0].count,'0');
   const sourceTables=[
    "CREATE TABLE privacy_trends_daily(id integer PRIMARY KEY,date date,shielded_count bigint,transparent_count bigint,orchard_pool_size bigint,ironwood_pool_size bigint,sapling_pool_size bigint,sprout_pool_size bigint,private_marker text)",
    "CREATE TABLE cross_chain_swaps(id integer PRIMARY KEY,status text,source_chain text,source_token text,source_amount_usd numeric,dest_chain text,dest_token text,dest_amount_usd numeric,swap_created_at timestamptz,private_marker text)",
    "CREATE TABLE addresses(address text PRIMARY KEY,balance bigint,total_received bigint,total_sent bigint,tx_count integer,first_seen bigint,last_seen bigint,address_type text,private_marker text)",
    "CREATE TABLE address_transactions(address text,txid text,block_height integer,tx_index integer,block_time bigint,is_input boolean,is_output boolean,value_in bigint,value_out bigint,private_marker text,PRIMARY KEY(address,block_height,tx_index,txid))"
   ];for(const sql of sourceTables)await source.query(sql);
   await source.query("INSERT INTO privacy_trends_daily VALUES(1,'2023-11-14',3,0,9007199254740993,100,0,0,'secret');INSERT INTO cross_chain_swaps VALUES(1,'SUCCESS','eth','eth',125.75,'zec','zec',120,'2023-11-14T12:00Z','secret'),(2,'SUCCESS','zec','zec',10,'btc','btc',0,'2023-11-14T12:00Z','secret'),(3,'FAILED','eth','eth',999,'zec','zec',999,'2023-11-14T12:00Z','secret');INSERT INTO addresses VALUES('t1fixture',100,150,50,1,1700000000,1700000001,'transparent','secret'),('zsprivate-fixture',100,150,50,1,1700000000,1700000001,'shielded','secret');INSERT INTO address_transactions VALUES('t1fixture','b1-tx',1,1,1700000001,false,true,0,150,'secret'),('zsprivate-fixture','b1-tx',1,1,1700000001,false,true,0,150,'secret')");
   const sourceMigration=strip(fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics/catalogue-source-v1.sql'),'utf8')).replaceAll("'zcash_explorer_mainnet'","'ask_logical_fixture'").replaceAll('ask_core_replicator','ask_fixture_replicator');
   await source.query(sourceMigration);
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=true)');
   await wait(async()=>(await target.query("SELECT count(*) FROM pg_subscription_rel WHERE srsubstate='r'")).rows[0].count==='8');
   await signal();await wait(async()=>(await target.query("SELECT sampled_at>clock_timestamp()-interval '120 seconds' AS fresh FROM analytics_feed_meta.signal")).rows[0].fresh);
   assert.equal((await refreshAdmission(target)).state,'verified');
   assert.equal((await reader.query("SELECT count(*) FROM analytics_public.dataset_coverage WHERE ready")).rows[0].count,'4');
   assert.deepEqual((await reader.query('SELECT orchard::text FROM analytics_public.daily_query')).rows,[{orchard:'9007199254740993'}]);
   assert.deepEqual((await reader.query('SELECT usd::text FROM analytics_public.swaps_query ORDER BY direction')).rows,[{usd:'125.75'},{usd:null}]);
   assert.equal((await reader.query('SELECT count(*) FROM analytics_public.address_activity_query')).rows[0].count,'1');
   assert.equal((await target.query('SELECT count(*) FROM public.addresses')).rows[0].count,'1');
   assert.equal((await target.query('SELECT count(*) FROM public.address_transactions')).rows[0].count,'1');
   for(const sql of ['DELETE FROM public.addresses','UPDATE analytics_public.addresses_query SET balance=0','TRUNCATE public.cross_chain_swaps','SELECT * FROM analytics_meta.dataset_state','SELECT private_marker FROM public.addresses',"SELECT pg_read_file('/etc/passwd')"]){const attack=await reader.connect();try{await attack.query('SET default_transaction_read_only=off');await assert.rejects(attack.query(sql),e=>['42501','55000'].includes(e.code));}finally{attack.release(true);}}
   const extendedAnalytics=createAnalytics({ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_DATABASE_URL:'peer-only',ASK_ANALYTICS_SOCKET:'/run/ask-public-db',ASK_ANALYTICS_STORE:'logical_public_core',ASK_ANALYTICS_DAILY_QUERY_LIMIT:'20',ASK_RESEARCH_ENABLED:'true',ASK_RESEARCH_EXTENDED:'true'},{pool:reader});
   await assert.rejects(extendedAnalytics.execute({version:3,sql:'SELECT * FROM activity_daily',limit:10},{redis}),e=>e.askKind==='dataset');
   const swapEvidence=await extendedAnalytics.execute({version:3,sql:'SELECT count(*) AS swaps FROM swaps',limit:1},{redis});
   assert.equal(swapEvidence.result.rows[0][0],'2');
   const {refreshSummaries}=require('../../scripts/refresh-ask-summaries');
   assert.equal((await refreshSummaries(target)).state,'ready');
   const summary=(await reader.query('SELECT transactions::text,shielded_transactions::text,fees::text FROM analytics_public.activity_daily_query')).rows[0];
   assert.deepEqual(summary,{transactions:'3',shielded_transactions:'3',fees:'57'});
   const flow=(await reader.query("SELECT sum(amount)::text AS amount FROM analytics_public.flow_daily_query WHERE direction='shield'")).rows[0];
   assert.equal(flow.amount,'18014398509481991');
   // A historical correction invalidates summaries immediately, before refresh.
   await source.query("UPDATE transactions SET fee=44 WHERE txid='b1-tx'");
   await wait(async()=>(await target.query("SELECT fee::text FROM transactions WHERE txid='b1-tx'")).rows[0].fee==='44');
   assert.equal((await reader.query("SELECT ready FROM analytics_public.dataset_coverage WHERE dataset='activity_daily'")).rows[0].ready,false);
   assert.equal((await refreshAdmission(target)).state,'verified');
   assert.equal((await refreshSummaries(target)).state,'ready');
   assert.equal((await reader.query('SELECT fees::text FROM analytics_public.activity_daily_query')).rows[0].fees,'58');
   await source.query("UPDATE transactions SET fee=NULL WHERE txid='b1-tx'");
   await wait(async()=>(await target.query("SELECT fee FROM transactions WHERE txid='b1-tx'")).rows[0].fee===null);
   await refreshAdmission(target);await refreshSummaries(target);
   assert.deepEqual((await reader.query('SELECT fees::text,missing_fees::text FROM analytics_public.activity_daily_query')).rows,[{fees:null,missing_fees:'1'}]);
   await target.query("BEGIN;INSERT INTO analytics_meta.activity_daily(date) VALUES('2020-01-01');TRUNCATE public.shielded_flows");
   assert.equal((await target.query("SELECT EXISTS(SELECT FROM analytics_meta.summary_dirty_days WHERE date='2020-01-01') AS dirty")).rows[0].dirty,true);
   assert.equal((await reader.query("SELECT ready FROM analytics_public.dataset_coverage WHERE dataset='activity_daily'")).rows[0].ready,true);
   await target.query('ROLLBACK');
   // SQL publication text names no provider secrets/payload/address labels.
   assert.doesNotMatch(sourceMigration,/deposit_address|senders|recipient|raw_origin_asset/);
  });
  await admission.test('supply archive replicates after its destination migration; issuance derives from canonical blocks',async()=>{
   const strip=text=>text.replace(/^\\set.*$/gm,''),read=name=>strip(fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8'));
   await target.query(read('supply-issuance-v1.sql'));
   assert.equal((await reader.query("SELECT ready FROM analytics_public.dataset_coverage WHERE dataset='supply_daily'")).rows[0].ready,false);
   await source.query("CREATE TABLE chain_supply_daily(date date PRIMARY KEY,block_height bigint NOT NULL,block_hash text NOT NULL,block_time bigint NOT NULL,chain_supply_zat bigint NOT NULL,source text NOT NULL DEFAULT 'node-getblock-chain-supply-v1',computed_at timestamptz NOT NULL DEFAULT now())");
   const [first,second]=(await source.query('SELECT height::int,hash,timestamp::text FROM blocks ORDER BY height LIMIT 2')).rows;
   // Two consecutive canonical dates plus a later row whose hash is not canonical.
   await source.query("INSERT INTO chain_supply_daily(date,block_height,block_hash,block_time,chain_supply_zat,source) VALUES('2023-11-14',$1,$2,$3,62500,'secret'),('2023-11-15',$4,$5,$6,187500,'secret'),('2023-11-16',$4,$7,$6,999,'secret')",[first.height,first.hash,first.timestamp,second.height,second.hash,second.timestamp,'f'.repeat(64)]);
   const before=(await target.query("SELECT count(*)::int AS n FROM pg_subscription_rel WHERE srsubstate='r'")).rows[0].n;
   await source.query(read('supply-issuance-source-v1.sql').replaceAll("'zcash_explorer_mainnet'","'ask_logical_fixture'").replaceAll('ask_core_replicator','ask_fixture_replicator'));
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=true)');
   await wait(async()=>(await target.query("SELECT count(*)::int AS n FROM pg_subscription_rel WHERE srsubstate='r'")).rows[0].n===before+1);
   await signal();await wait(async()=>(await target.query("SELECT sampled_at>clock_timestamp()-interval '120 seconds' AS fresh FROM analytics_feed_meta.signal")).rows[0].fresh);
   assert.equal((await refreshAdmission(target)).state,'verified');
   assert.equal((await reader.query("SELECT ready FROM analytics_public.dataset_coverage WHERE dataset='supply_daily'")).rows[0].ready,true);
   assert.deepEqual((await reader.query('SELECT date::text,height::text,chain_supply::text,lockbox::text,circulating_supply::text,net_change::text FROM analytics_public.supply_daily_query ORDER BY date')).rows,[
    {date:'2023-11-14',height:String(first.height),chain_supply:'62500',lockbox:'0',circulating_supply:'62500',net_change:null},
    {date:'2023-11-15',height:String(second.height),chain_supply:'187500',lockbox:'0',circulating_supply:'187500',net_change:'125000'}]);
   assert.deepEqual((await target.query("SELECT attname FROM pg_attribute WHERE attrelid='public.chain_supply_daily'::regclass AND attnum>0 ORDER BY attnum")).rows.map(r=>r.attname),['date','block_height','block_hash','block_time','chain_supply_zat']);
   // Fixture heights are in the slow start: 62500 zat per height, founders 20%.
   assert.deepEqual((await reader.query('SELECT height::int,subsidy::text,miner_subsidy::text,founders::text,funding_streams::text,lockbox::text,lockbox_disbursed::text FROM analytics_public.issuance_query ORDER BY height LIMIT 2')).rows,[
    {height:first.height,subsidy:String(62500*first.height),miner_subsidy:String(50000*first.height),founders:String(12500*first.height),funding_streams:'0',lockbox:'0',lockbox_disbursed:'0'},
    {height:second.height,subsidy:String(62500*second.height),miner_subsidy:String(50000*second.height),founders:String(12500*second.height),funding_streams:'0',lockbox:'0',lockbox_disbursed:'0'}]);
   for(const sql of ['SELECT * FROM public.chain_supply_daily','DELETE FROM public.chain_supply_daily','SELECT source FROM analytics_public.supply_daily_query']){const attack=await reader.connect();try{await assert.rejects(attack.query(sql));}finally{attack.release();}}
   // Rollback order: source publication first, then subscription refresh, then destination.
   await assert.rejects(target.query(read('supply-issuance-v1-rollback.sql')),/removed from the subscription/);
   await source.query(read('supply-issuance-source-v1-rollback.sql').replaceAll("'zcash_explorer_mainnet'","'ask_logical_fixture'").replaceAll('ask_core_replicator','ask_fixture_replicator'));
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=false)');
   await target.query(read('supply-issuance-v1-rollback.sql'));
   assert.equal((await target.query("SELECT to_regclass('public.chain_supply_daily') IS NULL AND to_regclass('analytics_public.issuance_query') IS NULL AS gone")).rows[0].gone,true);
   await source.query("INSERT INTO chain_supply_daily(date,block_height,block_hash,block_time,chain_supply_zat) VALUES('2023-11-17',1,'x',1,1)");
   await signal();await wait(async()=>(await target.query("SELECT sampled_at>clock_timestamp()-interval '120 seconds' AS fresh FROM analytics_feed_meta.signal")).rows[0].fresh);
   assert.equal((await target.query("SELECT bool_and(subenabled) AS enabled FROM pg_subscription")).rows[0].enabled,true);
   assert.equal((await refreshAdmission(target)).state,'verified');
  });
  await admission.test('mining tables replicate only reviewed columns, every listed table gates readiness, and roll back in order',async()=>{
   const strip=text=>text.replace(/^\\set.*$/gm,''),read=name=>strip(fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8'));
   const fixtureSource=name=>read(name).replaceAll("'zcash_explorer_mainnet'","'ask_logical_fixture'").replaceAll('ask_core_replicator','ask_fixture_replicator');
   const subscribed=async()=>(await target.query("SELECT count(*)::int AS n FROM pg_subscription_rel WHERE srsubstate='r'")).rows[0].n;
   const refreshed=async()=>{await signal();await wait(async()=>(await target.query("SELECT sampled_at>clock_timestamp()-interval '120 seconds' AS fresh FROM analytics_feed_meta.signal")).rows[0].fresh);assert.equal((await refreshAdmission(target)).state,'verified');};
   const ready=async()=>Object.fromEntries((await reader.query("SELECT dataset,ready FROM analytics_public.dataset_coverage WHERE dataset IN('mining_daily','software_daily','block_timing','issuance_daily')")).rows.map(r=>[r.dataset,r.ready]));
   // issuance_daily reads supply_daily: reinstate the supply archive first.
   await target.query(read('supply-issuance-v1.sql'));
   let before=await subscribed();
   await source.query(fixtureSource('supply-issuance-source-v1.sql'));
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=true)');
   await wait(async()=>await subscribed()===before+1);
   const [first,second]=(await source.query('SELECT height::int,hash,timestamp::bigint AS timestamp FROM blocks ORDER BY height LIMIT 2')).rows;
   await source.query(`CREATE TABLE analytics_history_daily(date date PRIMARY KEY,anchor_height bigint,anchor_hash text,method text,cohorts jsonb,sopr numeric,mining_pool_blocks jsonb);
    CREATE TABLE block_software_daily(day integer,software text,blocks bigint,PRIMARY KEY(day,software));
    CREATE TABLE block_software_state(version integer,ready boolean);INSERT INTO block_software_state VALUES(1,true);
    CREATE TABLE block_observations(hash text PRIMARY KEY,height bigint,first_seen_at timestamptz,source text,poll_interval_ms integer);
    CREATE TABLE captured_blocks(hash text PRIMARY KEY,network text,height bigint,first_seen_at timestamptz,coinbase_hex text,raw_block bytea)`);
   await source.query("INSERT INTO analytics_history_daily VALUES('2023-11-14',$1,$2,'m','{\"secret\":1}',1.5,'{\"F2Pool\":2,\"Unknown\":1}')",[second.height,second.hash]);
   await source.query("INSERT INTO block_software_daily VALUES(19675,'zebra',2),(19675,'unknown',1)");
   await source.query("INSERT INTO block_observations VALUES($1,$2,to_timestamp($3::bigint+2.5),'local-node-rpc',1000)",[first.hash,first.height,first.timestamp]);
   await source.query("INSERT INTO captured_blocks VALUES($1,'mainnet',$2,to_timestamp($3::bigint+1),'73656372657421','\\x00')",[second.hash,second.height,second.timestamp]);
   await target.query(read('mining-v1.sql'));
   assert.deepEqual(await ready(),{mining_daily:false,software_daily:false,block_timing:false,issuance_daily:false});
   before=await subscribed();
   await source.query(fixtureSource('mining-source-v1.sql'));
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=true)');
   await wait(async()=>await subscribed()===before+4);
   await refreshed();
   assert.deepEqual(await ready(),{mining_daily:true,software_daily:true,block_timing:true,issuance_daily:true});
   for(const [table,columns] of [['analytics_history_daily',['date','anchor_height','anchor_hash','mining_pool_blocks']],['block_software_daily',['day','software','blocks']],['block_observations',['hash','height','first_seen_at']],['captured_blocks',['hash','height','first_seen_at']]])
    assert.deepEqual((await target.query(`SELECT attname FROM pg_attribute WHERE attrelid='public.${table}'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`)).rows.map(r=>r.attname),columns,table);
   assert.deepEqual((await reader.query('SELECT height::int,lag_seconds::text,observed_by FROM analytics_public.block_timing_query ORDER BY height')).rows,[
    {height:first.height,lag_seconds:'2.500',observed_by:'local-node-rpc'},{height:second.height,lag_seconds:'1.000',observed_by:'node-block-stream'}]);
   assert.deepEqual((await reader.query("SELECT pool,blocks::int,day_blocks::int FROM analytics_public.mining_daily_query ORDER BY pool")).rows,[{pool:'F2Pool',blocks:2,day_blocks:3},{pool:'Unknown',blocks:1,day_blocks:3}]);
   for(const sql of ['SELECT * FROM public.captured_blocks','SELECT * FROM public.analytics_history_daily','SELECT raw_block FROM analytics_public.block_timing_query']){const attack=await reader.connect();try{await assert.rejects(attack.query(sql));}finally{attack.release();}}
   // A dataset is ready only while every listed table is subscribed.
   await source.query('ALTER PUBLICATION ask_public_core_v1 DROP TABLE captured_blocks');
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=false)');
   await refreshed();
   assert.deepEqual(await ready(),{mining_daily:true,software_daily:true,block_timing:false,issuance_daily:true});
   await source.query('ALTER PUBLICATION ask_public_core_v1 ADD TABLE captured_blocks(hash,height,first_seen_at)');
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=false)');
   await wait(async()=>(await target.query("SELECT bool_and(srsubstate='r') AS done FROM pg_subscription_rel WHERE srrelid='public.captured_blocks'::regclass")).rows[0].done===true);
   await refreshed();
   assert.equal((await ready()).block_timing,true);
   // Rollback order: source publication first, then subscription refresh, then destination.
   await assert.rejects(target.query(read('mining-v1-rollback.sql')),/removed from the subscription/);
   await source.query(fixtureSource('mining-source-v1-rollback.sql'));
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=false)');
   await target.query(read('mining-v1-rollback.sql'));
   assert.equal((await target.query("SELECT to_regclass('public.captured_blocks') IS NULL AND to_regclass('analytics_public.issuance_daily_query') IS NULL AS gone")).rows[0].gone,true);
   await source.query("INSERT INTO block_software_daily VALUES(19676,'zebra',1)");
   await source.query(fixtureSource('supply-issuance-source-v1-rollback.sql'));
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=false)');
   await target.query(read('supply-issuance-v1-rollback.sql'));
   await refreshed();
   assert.equal((await target.query("SELECT bool_and(subenabled) AS enabled FROM pg_subscription")).rows[0].enabled,true);
  });
  await admission.test('reorg tables replicate only reviewed columns, convert Berlin detection times and roll back in order',async()=>{
   const strip=text=>text.replace(/^\\set.*$/gm,''),read=name=>strip(fs.readFileSync(path.join(__dirname,'../../../deploy/ask-analytics',name),'utf8'));
   const fixtureSource=name=>read(name).replaceAll("'zcash_explorer_mainnet'","'ask_logical_fixture'").replaceAll('ask_core_replicator','ask_fixture_replicator');
   const subscribed=async()=>(await target.query("SELECT count(*)::int AS n FROM pg_subscription_rel WHERE srsubstate='r'")).rows[0].n;
   const refreshed=async()=>{await signal();await wait(async()=>(await target.query("SELECT sampled_at>clock_timestamp()-interval '120 seconds' AS fresh FROM analytics_feed_meta.signal")).rows[0].fresh);assert.equal((await refreshAdmission(target)).state,'verified');};
   // The reorg migration builds on the mining catalogue; its destination views are enough here.
   await target.query(read('supply-issuance-v1.sql'));await target.query(read('mining-v1.sql'));await target.query(read('reorgs-v1.sql'));
   const [,second]=(await source.query('SELECT height::int,hash,timestamp::bigint AS timestamp FROM blocks ORDER BY height LIMIT 2')).rows;
   await source.query("SET TIME ZONE 'Europe/Berlin'");
   await source.query(`CREATE TABLE fork_events(id serial PRIMARY KEY,fork_height bigint,depth integer,canonical_tip bigint,orphaned_count integer,source text,description text,detected_at timestamp DEFAULT now(),resolved_at timestamp);
    CREATE TABLE orphaned_blocks(id serial PRIMARY KEY,height bigint,hash text UNIQUE,canonical_hash text,timestamp bigint,transaction_count integer,size integer,difficulty text,miner_address text,fork_event_id integer REFERENCES fork_events(id) ON DELETE SET NULL,source text,reported_by text,detected_at timestamp DEFAULT now(),coinbase_hex text,raw_hex text,block_metadata jsonb)`);
   await source.query("INSERT INTO fork_events(fork_height,depth,canonical_tip,orphaned_count,source,description,detected_at) VALUES($1,1,$1,1,'indexer','secret text','2026-10-31 08:01:40')",[second.height]);
   await source.query("INSERT INTO orphaned_blocks(height,hash,canonical_hash,timestamp,transaction_count,size,miner_address,fork_event_id,source,reported_by,detected_at,coinbase_hex,raw_hex) VALUES($1,$2,$3,$4,2,700,'t1orphan',1,'indexer','node-a','2026-10-31 08:01:40','deadbeef','00'),($1,'f'||repeat('0',63),$2,$4,1,300,'t1other',1,'indexer','node-a','2026-10-31 08:01:40','beef','00')",[second.height,second.hash,'e'.repeat(64),second.timestamp]);
   await source.query('RESET TIME ZONE');
   const before=await subscribed();
   // Production runs under the server zone; the source step refuses any other.
   await source.query(fixtureSource('reorgs-source-v1.sql').replace('BEGIN;',"BEGIN;SET LOCAL TimeZone='Europe/Berlin';"));
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=true)');
   await wait(async()=>await subscribed()===before+2);
   await refreshed();
   assert.deepEqual((await reader.query("SELECT dataset,ready FROM analytics_public.dataset_coverage WHERE dataset IN('reorgs','orphaned_blocks') ORDER BY dataset")).rows,[{dataset:'orphaned_blocks',ready:true},{dataset:'reorgs',ready:true}]);
   for(const [table,columns] of [['fork_events',['id','fork_height','depth','orphaned_count','detected_at']],['orphaned_blocks',['id','height','hash','canonical_hash','timestamp','transaction_count','size','miner_address','fork_event_id','detected_at']]])
    assert.deepEqual((await target.query(`SELECT attname FROM pg_attribute WHERE attrelid='public.${table}'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`)).rows.map(r=>r.attname),columns,table);
   assert.deepEqual((await reader.query('SELECT reorg_id,depth,reported_orphans,orphans::int,detected_at::text FROM analytics_public.reorgs_query')).rows,[{reorg_id:1,depth:1,reported_orphans:1,orphans:2,detected_at:'1793430100'}]);
   // The first orphan row records the hash that is canonical in the fixture chain.
   assert.deepEqual((await reader.query('SELECT miner,canonical_now FROM analytics_public.orphaned_blocks_query ORDER BY miner')).rows,[{miner:'t1orphan',canonical_now:true},{miner:'t1other',canonical_now:false}]);
   for(const sql of ['SELECT * FROM public.fork_events','SELECT raw_hex FROM analytics_public.orphaned_blocks_query']){const attack=await reader.connect();try{await assert.rejects(attack.query(sql));}finally{attack.release();}}
   await assert.rejects(target.query(read('reorgs-v1-rollback.sql')),/removed from the subscription/);
   await source.query(fixtureSource('reorgs-source-v1-rollback.sql'));
   await target.query('ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH(copy_data=false)');
   await target.query(read('reorgs-v1-rollback.sql'));await target.query(read('mining-v1-rollback.sql'));await target.query(read('supply-issuance-v1-rollback.sql'));
   assert.equal((await target.query("SELECT to_regclass('public.fork_events') IS NULL AND to_regclass('analytics_public.supply_daily_query') IS NULL AS gone")).rows[0].gone,true);
   await source.query("INSERT INTO fork_events(fork_height,depth,orphaned_count) VALUES(1,1,0)");
   await refreshed();
   assert.equal((await target.query("SELECT bool_and(subenabled) AS enabled FROM pg_subscription")).rows[0].enabled,true);
  });
  await source.query('UPDATE blocks SET transaction_count=3 WHERE height=1');
  await wait(async()=>(await target.query('SELECT transaction_count FROM blocks WHERE height=1')).rows[0].transaction_count===3);
  assert.equal((await refreshAdmission(target)).state,'quarantined');
  await source.query('UPDATE blocks SET transaction_count=2 WHERE height=1');
  await wait(async()=>(await target.query('SELECT transaction_count FROM blocks WHERE height=1')).rows[0].transaction_count===2);
  assert.equal((await refreshAdmission(target)).state,'quarantined');
 });
 await target.query('DROP SUBSCRIPTION ask_public_core_v1');
 assert.equal((await source.query('SELECT count(*) FROM pg_replication_slots')).rows[0].count,'0');
});
