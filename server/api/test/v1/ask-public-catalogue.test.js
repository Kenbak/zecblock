'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const catalogue = require('../../v1/lib/ask-public-catalogue');
const { windowOptions, buildSQL, parseArgs, metadataSQL, probes, sampleSQL, storageSamples, GUARD_SQL } = require('../../scripts/profile-ask-catalogue');
const now = Date.UTC(2026,9,3);
const options = { start:'2026-09-01',end:'2026-09-03',benchmarks:true };

test('catalogue relationships resolve reviewed fields and preserve join grain', () => {
  assert.equal(catalogue.sources.length,9);
  assert.equal(new Set(catalogue.sources.map(s=>s.id)).size,9);
  for (const join of catalogue.joins) {
    const from=catalogue.sources.find(s=>s.id===join.from),to=catalogue.sources.find(s=>s.id===join.to);
    for (const [left,right] of join.pairs) { assert.ok(from.fields[left]); assert.ok(to.fields[right]); }
  }
  assert.deepEqual(catalogue.joins[0].pairs,[['block_height','height'],['block_hash','hash']]);
  assert.ok(Object.isFrozen(catalogue.sources[0].fields));
  assert.equal(catalogue.sources.find(s=>s.id==='addresses').currentView,null);
  assert.equal(catalogue.status,'operator_inventory_not_public_query_contract');
});

test('operator SQL rejects injected/invalid/future/large windows and unknown options', () => {
  for(const start of ["2026-09-01'; DROP TABLE blocks;--",'2026-02-30','2026-9-01']) assert.throws(()=>buildSQL({...options,start},now));
  for(const changes of [{end:'2026-10-03'},{start:'2026-08-01'},{start:'2026-09-04'}]) assert.throws(()=>windowOptions({...options,...changes},now));
  assert.throws(()=>parseArgs(['--sql','DELETE FROM blocks']));
  assert.throws(()=>parseArgs(['--start']));
  assert.deepEqual(parseArgs(['--start','2026-09-01','--end','2026-09-03','--benchmarks']),options);
  const sql=buildSQL({},now);
  assert.match(sql,/REPEATABLE READ READ ONLY/);
  assert.match(sql,/NOT pg_is_in_recovery\(\)/);
  assert.match(sql,/statement_timeout='3s'/);
  assert.match(sql,/ROLLBACK;/);
  assert.match(sql,/Audit contains unavailable probes/);
  assert.doesNotMatch(sql,/'probe_result'/);
  assert.doesNotMatch(sql,/INSERT|DELETE|UPDATE|CREATE TABLE|GRANT|VACUUM|ANALYZE/);
});

test('real PostgreSQL catalogue, canonical join, exact sums and timeout recovery', {skip:process.env.CATALOGUE_TEST_POSTGRES!=='1'}, async t => {
  const {Pool}=require('pg');
  const name=`ask_catalogue_test_${process.pid}`;
  const admin=new Pool({host:'/tmp',database:'postgres',max:1});
  await admin.query(`CREATE DATABASE ${name}`);
  const db=new Pool({host:'/tmp',database:name,max:1});
  t.after(async()=>{await db.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();});
  const types={integer:'bigint',integer_or_numeric:'numeric',text:'text',boolean:'boolean',date:'date',numeric:'numeric',timestamptz:'timestamptz'};
  for(const source of catalogue.sources) await db.query(`CREATE TABLE ${source.relation} (${Object.entries(source.fields).map(([n,f])=>`"${n}" ${types[f.type]}`).join(',')})`);
  await db.query(`INSERT INTO blocks(height,hash,timestamp,transaction_count,total_fees,miner_address) VALUES
    (1,'canonical',1788220800,4,16,'miner-a'),(2,'next',1788307200,1,NULL,'miner-b'),
    (9,'height-nine',1788480000,0,0,NULL),(10,'height-ten',1788566400,0,0,NULL);
    INSERT INTO transactions(txid,block_height,block_hash,block_time,is_coinbase,fee) VALUES
    ('a',1,'canonical',1788220800,false,7),('b',1,'canonical',1788220800,false,9),
    ('negative',1,'canonical',1788220800,false,300),('orphan',1,'old-hash',1788220800,false,999),('coinbase',1,'canonical',1788220800,true,0),('c',2,'next',1788307200,false,NULL);
    INSERT INTO shielded_flows(txid,block_height,block_time,flow_type,pool,amount_zat) VALUES
    ('a',1,1788220800,'shield','orchard',9007199254740993),('a',1,1788220800,'deshield','orchard',1000),
    ('b',1,1788220800,'shield','orchard',7),('negative',1,1788220800,'shield','orchard',-1),('orphan',1,1788220800,'shield','orchard',999),
    ('coinbase',1,1788220800,'shield','orchard',999),('c',2,1788307200,'shield','ironwood',100);
    INSERT INTO privacy_trends_daily(date,shielded_count,transparent_count,orchard_pool_size,ironwood_pool_size)
    VALUES ('2026-09-01',0,0,0,NULL),('2026-09-03',NULL,2,100,200);
    INSERT INTO address_transactions(address,txid,block_height,tx_index,block_time) VALUES
    ('t1-fixture','a',1,0,1788220800),('t3-fixture','a',1,0,1788220800),('t1-fixture','b',1,1,1788220801),
    ('t1-orphan','orphan',1,2,1788220800);
`);
  const client=await db.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const inventory=(await client.query(metadataSQL())).rows[0].jsonb_build_object;
    assert.equal(inventory.sources.length,9);
    assert.equal(inventory.snapshot_height,'10');assert.equal(inventory.snapshot_hash,'height-ten');assert.equal(inventory.snapshot_block_time,'1788566400');
    for(const source of inventory.sources) {assert.equal(source.present,true);assert.deepEqual(source.missing_columns,[]);}
    const samples=probes(options,now);
    const daily=(await client.query(samples[0].text)).rows;
    assert.equal(daily[0].transactions,'0');assert.equal(daily[0].observed,true);assert.equal(daily[0].ironwood_missing,true);
    assert.equal(daily[1].observed,false);assert.equal(daily[1].transactions,null);assert.equal(daily[2].transactions,null);
    const activity=(await client.query(samples[1].text)).rows;
    assert.equal(activity[0].transactions,'3');assert.equal(activity[0].coinbase_transactions,'1');
    const ranking=(await client.query(samples[2].text)).rows;
    assert.equal(ranking[0].shielding_transactions,'2');assert.equal(ranking[0].shielding_zat,'9007199254741000');assert.equal(ranking[0].average_fee_zat,'8.000000');
    assert.equal(ranking[1].average_fee_zat,null);assert.equal(ranking[1].missing_fees,'1');
    assert.deepEqual((await client.query(samples[4].text)).rows,ranking);
    const sizes=(await client.query(storageSamples()[0].text)).rows[0];
    assert.deepEqual(Object.keys(sizes).sort(),['sampled_rows','mean_selected_row_bytes','minimum_selected_row_bytes','maximum_selected_row_bytes'].sort());
    if(sizes.sampled_rows==='0') assert.equal(sizes.mean_selected_row_bytes,null);
    const addresses=(await client.query(samples[3].text)).rows[0];
    assert.equal(addresses.active_transparent_addresses,'2');assert.equal(addresses.address_transaction_incidences,'3');assert.equal(addresses.timestamp_mismatches,'1');
  } finally {await client.query('ROLLBACK');client.release();}
  // The real CLI guard refuses this writable/non-mainnet fixture before inventory.
  const refused=spawnSync('psql',['-X','-q','-h','/tmp','-d',name],{input:buildSQL(options,now),encoding:'utf8'});
  assert.equal(refused.status,3);assert.match(refused.stderr,/Fresh mainnet standby required/);assert.doesNotMatch(refused.stdout,/'inventory'/);
  assert.match(GUARD_SQL,/current_database\(\) <> 'zcash_explorer_mainnet'/);
  // Exercise psql's real SQLSTATE/savepoint behavior, rather than mocking errors.
  const timeout=sampleSQL({id:'slow_fixture',text:'SELECT pg_sleep(0.1)',values:{}});
  const next=sampleSQL({id:'next_fixture',text:'SELECT 7 AS n',values:{}});
  const recovered=spawnSync('psql',['-X','-q','-h','/tmp','-d',name],{input:`\\set ON_ERROR_STOP on\n\\pset format unaligned\n\\pset tuples_only on\nBEGIN READ ONLY; SET LOCAL statement_timeout='20ms';\n${timeout}\n${next}\nROLLBACK;`,encoding:'utf8'});
  assert.equal(recovered.status,0,recovered.stderr);
  const records=recovered.stdout.trim().split('\n').filter(s=>s.startsWith('{')).map(JSON.parse);
  assert.equal(records[0].id,'slow_fixture');assert.equal(records[0].status,'unavailable');assert.equal(records[0].sqlstate,'57014');
  assert.deepEqual(records[1].rows,[{n:7}]);assert.equal(records[2].status,'passed');
  const failedExit=spawnSync('psql',['-X','-q','-h','/tmp','-d',name],{input:`\\set ON_ERROR_STOP on\n\\set probe_failed false\nBEGIN READ ONLY; SET LOCAL statement_timeout='20ms';\n${timeout}\nROLLBACK;\n\\if :probe_failed\nDO $$ BEGIN RAISE EXCEPTION 'Audit contains unavailable probes'; END $$;\n\\endif`,encoding:'utf8'});
  assert.equal(failedExit.status,3);
});
