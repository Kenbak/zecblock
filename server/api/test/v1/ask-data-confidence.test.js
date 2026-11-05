'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const audit=require('../../scripts/audit-ask-data-confidence');
const source={mode:'source',sourceKind:'primary',fromHeight:1,toHeight:3};
const indexed=[{Plan:{'Node Type':'Index Scan','Relation Name':'blocks','Index Cond':'height >= 1 AND height <= 3','Total Cost':10}}];
const relationRows=audit.TABLES.map(relation=>({schema:'public',relation,estimated_rows:'1000000'}));
function fake(overrides={}){
 const calls=[],definitions=audit.probes(overrides.options||source);
 const client={calls,query:async(sql,values)=>{
  calls.push({sql,values});
  if(sql===audit.IDENTITY)return{rows:[{database:overrides.options?.mode==='analytics'?'ask_analytics':'zcash_explorer_mainnet',recovery:false,version:160015,temp_bytes:'16777216',observed_at:'2026-10-16T00:00:00Z',...overrides.identity}]};
  if(sql===audit.RELATIONS)return{rows:relationRows};
  if(sql.startsWith('SELECT ready,covered_from'))return{rows:[{ready:true,covered_from:'0',covered_through:'1000',...overrides.coverage}]};
  if(sql.startsWith('SELECT dataset,ready'))return{rows:[{dataset:'addresses',ready:true},{dataset:'address_activity',ready:true}]};
  if(sql.startsWith('EXPLAIN '))return{rows:[{'QUERY PLAN':overrides.plan||indexed}]};
  const probe=definitions.find(p=>p.text===sql);
  if(probe){if(overrides.fail===probe.id)throw Object.assign(Error('SECRET must never leave exception'),{code:'57014'});return{rows:[{records:'2',truncated:false,...Object.fromEntries(probe.checks.map(k=>[k,'0'])),...overrides.results?.[probe.id]}]};}
  return{rows:[]};
 }};return client;
}
test('height and source boundaries reject injection, unknown options and unbounded ranges',()=>{
 for(const input of [{...source,fromHeight:"1; SELECT secret"},{...source,toHeight:1025},{...source,fromHeight:-1},{...source,toHeight:0},{...source,fromHeight:true},{...source,fromHeight:null},{...source,sql:'SELECT 1'},{...source,sourceKind:'any'},{...source,execute:'true'}])assert.throws(()=>audit.options(input));
 assert.throws(()=>audit.parseArgs(['--mode','source','--source-kind','primary','--from-height','1','--to-height','2','--sql','SELECT 1']));
 assert.throws(()=>audit.parseArgs(['--mode','source','--mode','analytics']));
 assert.deepEqual(audit.parseArgs(['--mode','source','--source-kind','standby','--from-height','0','--to-height','1023']),{mode:'source',sourceKind:'standby',fromHeight:0,toHeight:1023,execute:false});
});
test('fixed SQL bounds all records before joins and emits no address/transaction records',()=>{
 for(const mode of ['source','analytics']){
  const definitions=audit.probes(mode==='source'?source:{mode,fromHeight:1,toHeight:3});
  assert.equal(definitions.length,5);
  for(const p of definitions){assert.match(p.text,/BETWEEN 1 AND 3/);assert.doesNotMatch(p.text,/\b(?:INSERT|UPDATE|DELETE|GRANT|COPY|CREATE|VACUUM)\b/);assert.match(p.fingerprint,/^[a-f0-9]{64}$/);}
  for(const p of definitions.slice(1))assert.match(p.text,/LIMIT 10001\), observed AS MATERIALIZED/);
  assert.deepEqual(audit.probes(mode==='source'?source:{mode,fromHeight:1,toHeight:3}),definitions);
  if(mode==='analytics'){for(const p of definitions)assert.doesNotMatch(p.text,/\bpublic\./);assert.ok(!definitions[2].checks.includes('missing_transaction'));}
 }
});
test('plan admission rejects large or unknown sequential scans and excessive nested costs',()=>{
 const seq=estimate=>audit.assessPlan([{Plan:{'Node Type':'Seq Scan','Relation Name':'transactions','Total Cost':4}}],[{schema:'public',relation:'transactions',estimated_rows:estimate}]);
 for(const estimate of ['1000000','-1',undefined,null,true])assert.equal(seq(estimate).allowed,false);
 assert.equal(seq('12').allowed,true);
 assert.equal(audit.assessPlan([{Plan:{'Node Type':'Aggregate','Total Cost':4,Plans:[{'Node Type':'Index Scan','Total Cost':100001}]}}],relationRows).allowed,false);
 assert.equal(audit.assessPlan([],relationRows).allowed,false);
 assert.equal(audit.assessPlan(indexed,relationRows).allowed,true);
 for(const type of ['Index Scan','Index Only Scan','Parallel Index Scan']){
  assert.equal(audit.assessPlan([{Plan:{'Node Type':type,'Relation Name':'addresses','Total Cost':10}}],relationRows).allowed,false);
  assert.equal(audit.assessPlan([{Plan:{'Node Type':type,'Relation Name':'addresses','Index Cond':'address = c.address','Total Cost':10}}],relationRows).allowed,true);
 }
});
test('database/network and bounded disk rules refuse wrong targets and stale standby',()=>{
 const good={database:'zcash_explorer_mainnet',recovery:false,version:160015,temp_bytes:'16777216'};
 for(const patch of [{database:'other'},{recovery:true},{version:150000},{temp_bytes:'-1'},{temp_bytes:'16777217'}])assert.throws(()=>audit.assertIdentity({...good,...patch},source));
 audit.assertIdentity({...good,recovery:true,replay_age:'1.5'},{...source,sourceKind:'standby'});
 for(const replay_age of [null,-1,121,'unknown'])assert.throws(()=>audit.assertIdentity({...good,recovery:true,replay_age},{...source,sourceKind:'standby'}));
});
test('plan-only is default and no data SELECT executes without a preceding accepted EXPLAIN',async()=>{
 const client=fake();const report=await audit.runAudit(client,source);
 assert.equal(report.execution,'plan_only');assert.equal(report.chain_history_completeness,'unverified');assert.equal(report.complete,false);
 assert.ok(report.probes.every(p=>p.status==='planned'));
 for(const p of audit.probes(source))assert.equal(client.calls.filter(c=>c.sql===p.text).length,0);
 assert.equal(client.calls.at(-1).sql,'ROLLBACK');
 const blocked=fake({plan:[{Plan:{'Node Type':'Seq Scan','Relation Name':'transactions','Total Cost':4}}]});
 const denied=await audit.runAudit(blocked,{...source,execute:true});assert.ok(denied.probes.every(p=>p.status==='blocked_plan'));
 for(const p of audit.probes(source))assert.equal(blocked.calls.filter(c=>c.sql===p.text).length,0);
});
test('missing values, exact zatoshis and row caps remain unknown/incomplete rather than certified',async()=>{
 const client=fake({results:{flow_window:{missing_amounts:'1',recorded_amount_zat:null},address_summary_sample:{truncated:true},transaction_window:{missing_fees:'1',large_exact_zat:'9007199254740993'}}});
 const report=await audit.runAudit(client,{...source,execute:true});
 assert.equal(report.probes[1].metrics.large_exact_zat,'9007199254740993');assert.equal(report.probes[2].metrics.recorded_amount_zat,null);
 assert.deepEqual(report.probes[2].findings,[{metric:'missing_amounts',count:'1'}]);assert.equal(report.probes[4].status,'incomplete_row_budget');
 assert.equal(report.complete,false);assert.equal(report.scope_consistent,false);assert.equal(report.chain_history_completeness,'unverified');
 for(const p of audit.probes(source)){const index=client.calls.findIndex(c=>c.sql===p.text);assert.ok(index>0);assert.equal(client.calls[index-1].sql,'EXPLAIN (FORMAT JSON, COSTS TRUE) '+p.text);}
});
test('one unavailable probe rolls back its savepoint and cannot invent zero results or leak errors',async()=>{
 const report=await audit.runAudit(fake({fail:'flow_window'}),{...source,execute:true});
 assert.equal(report.probes[2].status,'unavailable');assert.equal(report.probes[2].sqlstate,'57014');assert.equal(report.probes[2].metrics,undefined);assert.equal(report.probes[3].status,'measured');
 assert.doesNotMatch(JSON.stringify(report),/SECRET/);assert.equal(report.complete,false);
});
test('view-only audit refuses stale or uncovered data before planning',async()=>{
 const input={mode:'analytics',fromHeight:1,toHeight:3,execute:true};
 for(const coverage of [{ready:false},{covered_from:'2'},{covered_through:'2'}]){
  const client=fake({options:input,coverage});await assert.rejects(audit.runAudit(client,input),/coverage unavailable/);assert.equal(client.calls.at(-1).sql,'ROLLBACK');assert.ok(!client.calls.some(c=>c.sql.startsWith('EXPLAIN')));
 }
});
test('native PG16 bounded source metrics distinguish real gaps, nulls, duplicates, orphans and summary contradictions',{skip:process.env.ASK_DATA_CONFIDENCE_TEST_POSTGRES!=='1',timeout:60000},async t=>{
 const {Pool}=require('pg'),bin=process.env.ASK_LOGICAL_PG_BIN;
 assert.ok(bin&&path.isAbsolute(bin),'Explicit PG16 binary directory required');
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 assert.match(command('postgres',['--version']),/^postgres \(PostgreSQL\) 16\./);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-confidence-fixture-'));fs.chmodSync(root,0o700);
 const data=path.join(root,'data'),socket=path.join(root,'socket');fs.mkdirSync(socket,{mode:0o700});let active=false,admin,db;
 t.after(async()=>{await db?.end();await admin?.end();if(active)command('pg_ctl',['-D',data,'-m','fast','-w','stop']);fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${socket}'\nshared_buffers='16MB'\n`);
 command('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-w','start']);active=true;
 admin=new Pool({host:socket,user:'postgres',database:'postgres',max:1,ssl:false});await admin.query('CREATE DATABASE zcash_explorer_mainnet');
 db=new Pool({host:socket,user:'postgres',database:'zcash_explorer_mainnet',max:1,ssl:false});
 await db.query(`CREATE TABLE blocks(height bigint PRIMARY KEY,hash text,previous_block_hash text,timestamp bigint,transaction_count integer);
 CREATE TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_hash text,block_time bigint,is_coinbase boolean,fee bigint,size integer);
 CREATE TABLE shielded_flows(txid text,block_height bigint,block_time bigint,flow_type text,pool text,amount_zat bigint);
 CREATE TABLE address_transactions(address text,txid text,block_height bigint,tx_index integer,block_time bigint,is_input boolean,is_output boolean,value_in bigint,value_out bigint);
 CREATE TABLE addresses(address text PRIMARY KEY,balance bigint,total_received bigint,total_sent bigint,tx_count integer,first_seen bigint,last_seen bigint);
 INSERT INTO blocks VALUES(0,repeat('0',64),NULL,0,0),(1,repeat('a',64),repeat('0',64),100,2),(3,repeat('c',64),repeat('a',64),300,1);
 INSERT INTO transactions VALUES('coinbase',1,repeat('a',64),100,true,0,10),('a',1,repeat('a',64),100,false,9007199254740993,20),('bad',3,repeat('d',64),301,false,NULL,NULL);
 INSERT INTO shielded_flows VALUES('a',1,100,'shield','orchard',9007199254740993),('a',1,100,'shield','orchard',7),('bad',3,300,'deshield','sapling',NULL),('missing',3,300,'shield','unknown',-1);
 INSERT INTO address_transactions VALUES('t1-a','a',1,0,100,false,true,0,10),('t1-a','a',1,1,100,false,true,0,10),('t3-missing','missing',3,0,300,NULL,NULL,NULL,NULL);
 INSERT INTO addresses VALUES('t1-a',20,20,0,1,101,99);
 ANALYZE blocks;ANALYZE transactions;ANALYZE shielded_flows;ANALYZE address_transactions;ANALYZE addresses;`);
 const client=await db.connect();try{
  const report=await audit.runAudit(client,{...source,execute:true});
  assert.equal(report.complete,true,JSON.stringify(report));assert.equal(report.scope_consistent,false);assert.equal(report.chain_history_completeness,'unverified');
  const byId=Object.fromEntries(report.probes.map(p=>[p.id,p.metrics]));
  assert.equal(byId.block_window.missing_heights,'1');assert.equal(byId.block_window.parent_mismatches,'1');
  assert.equal(byId.transaction_window.missing_fees,'1');assert.equal(byId.transaction_window.block_hash_mismatches,'1');assert.equal(byId.transaction_window.timestamp_mismatches,'1');
  assert.equal(byId.flow_window.duplicate_groups,'1');assert.equal(byId.flow_window.missing_transaction,'1');assert.equal(byId.flow_window.recorded_amount_zat,null);assert.equal(byId.flow_window.negative_amounts,'1');
  assert.equal(byId.address_activity_window.missing_transaction,'1');assert.equal(byId.address_activity_window.duplicate_groups,'1');
  assert.equal(byId.address_summary_sample.missing_summary,'1');assert.equal(byId.address_summary_sample.first_seen_after_observation,'1');assert.equal(byId.address_summary_sample.last_seen_before_observation,'1');assert.equal(byId.address_summary_sample.incidence_count_below_sample,'1');
 }finally{client.release();}
 assert.equal((await db.query('SELECT count(*)::text AS n FROM shielded_flows')).rows[0].n,'4');
});
