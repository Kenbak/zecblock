'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {replicationErrorsAcknowledged}=require('../../scripts/ask-core-admission');
const deploy=path.join(__dirname,'../../../deploy/ask-analytics');

test('admission acknowledges only the installed helper or legacy zero-error rule',async()=>{
 for(const installed of [false,true])for(const acknowledged of [false,true]){
  const statements=[];
  const client={query:async sql=>{statements.push(sql);return {rows:[statements.length===1?{installed}:{acknowledged}]};}};
  assert.equal(await replicationErrorsAcknowledged(client),acknowledged);
  assert.equal(statements.length,2);
  if(installed)assert.match(statements[1],/^SELECT analytics_meta\.replication_errors_acknowledged\(\)/);
  else assert.match(statements[1],/sum\(apply_error_count\+sync_error_count\),0\)=0/);
 }
});
test('missing helper evidence and helper execution errors never become a legacy fallback',async()=>{
 await assert.rejects(replicationErrorsAcknowledged({query:async()=>({rows:[]})}),/availability unknown/);
 let calls=0;
 await assert.rejects(replicationErrorsAcknowledged({query:async()=>{if(++calls===1)return {rows:[{installed:true}]};throw Error('operator helper failed');}}),/operator helper failed/);
 assert.equal(calls,2);
});

test('isolated PG16 acknowledgement ledger preserves real errors, epochs and operator-only access', {skip:process.env.ASK_RECOVERY_TEST_POSTGRES!=='1',timeout:60000},async t=>{
 const {Pool}=require('pg'),bin=process.env.ASK_LOGICAL_PG_BIN;
 assert.ok(bin&&path.isAbsolute(bin),'Explicit PG16 binary directory required');
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 assert.match(command('postgres',['--version']),/^postgres \(PostgreSQL\) 16\./);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-recovery-fixture-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.chmodSync(root,0o700);fs.mkdirSync(socket,{mode:0o700});let active=false,admin,db,publisher;
 t.after(async()=>{await publisher?.end();await db?.end();await admin?.end();if(active)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${socket}'\nwal_level=logical\nmax_replication_slots=4\nmax_logical_replication_workers=4\nmax_worker_processes=8\nshared_buffers='16MB'\nlog_min_messages=warning\n`);
 command('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-w','start']);active=true;
 admin=new Pool({host:socket,user:'postgres',database:'postgres',max:1,ssl:false});
 await admin.query('CREATE ROLE analytics_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
 await admin.query('CREATE DATABASE ask_analytics OWNER analytics_owner');
 await admin.query('CREATE DATABASE ask_recovery_source');
 db=new Pool({host:socket,user:'postgres',database:'ask_analytics',max:1,ssl:false});
 publisher=new Pool({host:socket,user:'postgres',database:'ask_recovery_source',max:1,ssl:false});
 for(const name of ['subscriber-core-v1.sql','admission-v1.sql','replication-recovery-v1.sql'])await db.query(fs.readFileSync(path.join(deploy,name),'utf8'));
 await db.query(`UPDATE analytics_meta.sync_state SET state='stale',source_id='00000000-0000-4000-8000-000000000001',source_system_identifier='1234567890123456789';
  UPDATE analytics_meta.admission_control SET baseline_verified=true;
  INSERT INTO analytics_feed_meta.signal VALUES(true,'00000000-0000-4000-8000-000000000001','1234567890123456789',2,clock_timestamp(),0,repeat('a',64),'0/0')`);
 await publisher.query('CREATE TABLE public.blocks(height bigint PRIMARY KEY,hash text); CREATE PUBLICATION fixture_publication FOR TABLE public.blocks');
 // Same-cluster publisher: create the slot first, outside CREATE SUBSCRIPTION,
 // to avoid waiting for this session's own subscription-creation transaction.
 await publisher.query("SELECT pg_create_logical_replication_slot('ask_public_core_v1','pgoutput')");
 await db.query(`CREATE SUBSCRIPTION ask_public_core_v1 CONNECTION 'host=${socket} dbname=ask_recovery_source user=postgres connect_timeout=1' PUBLICATION fixture_publication WITH(copy_data=false,create_slot=false,enabled=false,slot_name='ask_public_core_v1',disable_on_error=true,run_as_owner=false)`);
 const subid=(await db.query("SELECT oid FROM pg_subscription WHERE subname='ask_public_core_v1'")).rows[0].oid;
 if(!(await db.query('SELECT 1 FROM pg_replication_origin WHERE roname=$1',['pg_'+subid])).rowCount)await db.query('SELECT pg_replication_origin_create($1)',['pg_'+subid]);
 // Disposable empty-store setup only, so the origin has a visible status row.
 // Production acknowledgement/recovery never creates or advances an origin.
 await db.query("SELECT pg_replication_origin_advance($1,'0/1')",['pg_'+subid]);
 const acknowledged=async()=>{await db.query('SELECT pg_stat_clear_snapshot()');return (await db.query('SELECT analytics_meta.replication_errors_acknowledged() AS ok')).rows[0].ok;};
 const record=async(tag,overrides={})=>{
  const eventId=tag.repeat(64);
  await db.query(`INSERT INTO analytics_meta.replication_recovery_events(event_id,subid,stats_reset,apply_errors,sync_errors,source_generation,source_system_identifier,source_timeline,origin_name,event_at,evidence)
   SELECT $1,stats.subid,stats.stats_reset,stats.apply_error_count,stats.sync_error_count,$2,$3,$4,'pg_'||stats.subid::text,clock_timestamp(),'{"classification":"disposable-fixture-only"}'::jsonb FROM pg_stat_subscription_stats stats WHERE stats.subid=$5`,
   [eventId,overrides.generation||'00000000-0000-4000-8000-000000000001',overrides.identity||'1234567890123456789',overrides.timeline||2,subid]);
  await db.query('INSERT INTO analytics_meta.replication_recovery_ack(subid,event_id) VALUES($1,$2) ON CONFLICT(subid) DO UPDATE SET event_id=excluded.event_id',[subid,eventId]);
 };
 assert.equal(await acknowledged(),true,'zero errors need no acknowledgement');
 await record('a');assert.equal(await acknowledged(),true);
 await db.query('SELECT pg_stat_reset_subscription_stats($1)',[subid]);
 assert.equal(await acknowledged(),false,'an unexpected epoch change fails even with zero errors');
 await record('b');assert.equal(await acknowledged(),true);
 // A receiver startup connection failure does not necessarily count as an
 // apply error. Create a genuine duplicate-key apply failure instead. This
 // tests the operator ledger only; automatic recovery must reject data conflicts.
 await db.query("INSERT INTO public.blocks(height,hash) VALUES(1,repeat('a',64))");
 await publisher.query("INSERT INTO public.blocks(height,hash) VALUES(1,repeat('b',64))");
 await db.query('ALTER SUBSCRIPTION ask_public_core_v1 ENABLE');
 const until=Date.now()+10000;
 while(true){
  await db.query('SELECT pg_stat_clear_snapshot()');
  const row=(await db.query('SELECT sub.subenabled,stats.apply_error_count FROM pg_subscription sub JOIN pg_stat_subscription_stats stats ON stats.subid=sub.oid WHERE sub.oid=$1',[subid])).rows[0];
  if(!row.subenabled&&BigInt(row.apply_error_count)>0n)break;
  assert.ok(Date.now()<until,'fixture duplicate-key apply failure must disable the subscription');await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.match(fs.readFileSync(path.join(root,'postgres.log'),'utf8'),/duplicate key value violates unique constraint/);
 assert.equal(await acknowledged(),false,'real unacknowledged errors remain closed');
 const before=(await db.query('SELECT apply_error_count,sync_error_count,stats_reset FROM pg_stat_subscription_stats WHERE subid=$1',[subid])).rows[0];
 await record('c');assert.equal(await acknowledged(),true);
 assert.deepEqual((await db.query('SELECT apply_error_count,sync_error_count,stats_reset FROM pg_stat_subscription_stats WHERE subid=$1',[subid])).rows[0],before,'acknowledgement never resets original counters');
 await record('d',{generation:'00000000-0000-4000-8000-000000000002'});assert.equal(await acknowledged(),false);
 await record('e',{identity:'9999999999999999999'});assert.equal(await acknowledged(),false);
 await record('f',{timeline:3});assert.equal(await acknowledged(),false);
 await db.query('UPDATE analytics_meta.replication_recovery_ack SET event_id=$1 WHERE subid=$2',['c'.repeat(64),subid]);assert.equal(await acknowledged(),true);
 for(const sql of ['UPDATE analytics_meta.replication_recovery_events SET evidence=\'{}\'','DELETE FROM analytics_meta.replication_recovery_events','TRUNCATE analytics_meta.replication_recovery_events CASCADE'])await assert.rejects(db.query(sql),/append-only/);
 for(const role of ['analytics_owner','ask_public_reader','ask_public_view_owner']){
  // Pool.query releases a client with its query error, discarding that session.
  // Hold the client so each expected denial stays under the intended SET ROLE.
  const roleClient=await db.connect();
  try{
   await roleClient.query('SET ROLE '+role);
   assert.equal((await roleClient.query('SELECT current_user AS role')).rows[0].role,role);
   for(const sql of ['SELECT * FROM analytics_meta.replication_recovery_events','SELECT * FROM analytics_meta.replication_recovery_ack','SELECT analytics_meta.replication_errors_acknowledged()'])await assert.rejects(roleClient.query(sql),{code:'42501'},role+' must be denied: '+sql);
  }finally{await roleClient.query('RESET ROLE');roleClient.release();}
 }
 const fn=(await db.query("SELECT prosecdef,pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='analytics_meta.replication_errors_acknowledged()'::regprocedure")).rows[0];
 assert.deepEqual(fn,{prosecdef:false,owner:'postgres'});
 await db.query('ALTER SUBSCRIPTION ask_public_core_v1 RENAME TO unexpected_subscription');assert.equal(await acknowledged(),false);
});
