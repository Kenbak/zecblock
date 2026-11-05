'use strict';
// Explicit opt-in, disposable local database only. No production URLs accepted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { compilePlan } = require('../../v1/lib/ask-analytics-plan');
const { GUARD, createAnalytics } = require('../../v1/lib/ask-analytics');

test('real PostgreSQL least-privilege reader, injection boundary, coverage, snapshots and primary refusal', { skip: process.env.ASK_TEST_POSTGRES !== '1' }, async t => {
  const name = `ask_analytics_test_${process.pid}`;
  const admin = new Pool({ host:'/tmp', database:'postgres', max:1 });
  if (Number((await admin.query("SELECT count(*) FROM pg_roles WHERE rolname IN ('ask_analytics_reader','ask_analytics_owner')")).rows[0].count)) {
    await admin.end(); throw new Error('Test roles already exist; refusing to reuse or alter them');
  }
  await admin.query(`CREATE DATABASE ${name}`);
  const owner = new Pool({ host:'/tmp', database:name, max:1 }); let reader;
  t.after(async () => {
    await reader?.end(); await owner.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.query('DROP ROLE IF EXISTS ask_analytics_reader, ask_analytics_owner'); await admin.end();
  });
  // PG14's PUBLIC schema CREATE default is intentionally revoked only in this
  // disposable database. The production script never changes shared defaults.
  await owner.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE TABLE privacy_trends_daily(date date PRIMARY KEY, shielded_count bigint, transparent_count bigint, orchard_pool_size bigint, ironwood_pool_size bigint, sapling_pool_size bigint, sprout_pool_size bigint);
    CREATE TABLE private_fixture(secret text); INSERT INTO private_fixture VALUES ('confidential-fixture');
    INSERT INTO privacy_trends_daily SELECT '2026-09-01'::date+i, (i+1)*100, 50, 900000000000-i, 400000000000001+i, 0, 0 FROM generate_series(0,29) i;
    DELETE FROM privacy_trends_daily WHERE date='2026-09-04';`);
  await owner.query(fs.readFileSync(path.resolve(__dirname,'../../../deploy/ask-analytics/provision.sql'),'utf8'));
  reader = new Pool({ host:'/tmp', database:name, user:'ask_analytics_reader', max:1 });
  const guard = (await reader.query(GUARD)).rows[0];
  assert.equal(guard.standby, false);
  for (const key of ['identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers']) assert.equal(guard[key], true, key);
  // Turn off the user-changeable session default to prove grants are a second
  // boundary, not merely the READ ONLY flag.
  for (const attack of [
    'DELETE FROM public.privacy_trends_daily', 'DELETE FROM ask_public.daily_v1', 'TRUNCATE public.private_fixture',
    'DROP VIEW ask_public.daily_v1', 'CREATE TABLE ask_public.attack(n int)', 'SELECT secret FROM public.private_fixture',
    "SELECT pg_read_file('/etc/passwd')", "COPY (SELECT 1) TO PROGRAM 'id'", 'SET ROLE ask_analytics_owner',
    'ALTER ROLE ask_analytics_reader SUPERUSER',
  ]) {
    const connection = await reader.connect();
    try {
      await connection.query('SET default_transaction_read_only=off');
      await assert.rejects(connection.query(attack), /permission|must be|not permitted/i, attack);
    } finally { connection.release(true); }
  }
  const input = {version:1,metric:'transactions',start:'2026-09-01',end:'2026-09-30',bucket:'week',order:'highest',limit:5};
  const compiled = compilePlan(input, Date.UTC(2026,9,2));
  const counts = (await reader.query(compiled.text, compiled.values)).rows;
  assert.equal(counts[0].bucket,'2026-09-21'); assert.equal(counts[0].value,'17150');
  const snapshots = compilePlan({...input,metric:'ironwood_balance'},Date.UTC(2026,9,2));
  const balances = (await reader.query(snapshots.text,snapshots.values)).rows;
  assert.equal(balances[0].value,'400000000000030'); assert.equal(balances[0].observed_through,'2026-09-30'); assert.equal(balances[0].observed_days,3);
  assert.equal((await reader.query('SELECT count(*) FROM ask_public.daily_v1')).rows[0].count,'29');
  await owner.query(`CREATE TABLE blocks(height bigint PRIMARY KEY, hash text UNIQUE, timestamp bigint,transaction_count int,size int,total_fees bigint,miner_address text);
    CREATE TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_hash text,is_coinbase boolean,has_sapling boolean,has_orchard boolean,has_ironwood boolean,has_sprout boolean,size int,fee bigint,orchard_actions int,ironwood_actions int,private_fixture text);
    CREATE TABLE shielded_flows(txid text,block_height int,block_time int,flow_type text,pool text,amount_zat bigint);
    CREATE TABLE cross_chain_swaps(status text,direction text,source_chain text,source_token text,source_amount_usd numeric,dest_chain text,dest_token text,dest_amount_usd numeric,swap_created_at timestamptz);
    INSERT INTO blocks VALUES (1,'canonical',1789430400,2,100,7,'miner'),(2,'next',1789516800,2,200,9,'miner');
    INSERT INTO transactions VALUES ('a',1,'canonical',false,false,true,false,false,80,7,1,0,'secret'),('orphan',1,'old-hash',false,false,true,false,false,80,99,1,0,'secret'),('b',2,'next',false,false,false,true,false,90,9,0,2,'secret');
    INSERT INTO shielded_flows VALUES ('a',1,1789430400,'deshield','orchard',9007199254740993),('orphan',1,1789430400,'deshield','orchard',999),('b',2,1789516800,'shield','ironwood',100000000);
    INSERT INTO cross_chain_swaps VALUES ('SUCCESS','inflow','ETH','ETH',123.45,'ZEC','ZEC',120,'2026-09-14'),('SUCCESS','outflow','ZEC','ZEC',900,'BTC','BTC',800,'2026-09-14'),('SUCCESS','inflow','ETH','ETH',NULL,'ZEC','ZEC',NULL,'2026-09-14'),('PENDING','inflow','ETH','ETH',900,'ZEC','ZEC',900,'2026-09-14'),('SUCCESS','inflow','ZEC','ZEC',1000,'ZEC','ZEC',1000,'2026-09-14'),('SUCCESS','inflow','ETH','ETH',0,'ZEC','ZEC',0,'2026-09-14'),('SUCCESS','inflow','ETH','ETH',500,'BTC','BTC',500,'2026-09-14');`);
  await owner.query(fs.readFileSync(path.resolve(__dirname,'../../../deploy/ask-analytics/upgrade-v2.sql'),'utf8'));
  assert.equal((await reader.query(GUARD)).rows[0].only_public_view,true);
  const query = {version:2,dataset:'flows',start:'2026-09-01',end:'2026-09-30',bucket:'week',dimensions:[],filters:[{field:'direction',op:'eq',value:'deshield'}],measures:[{field:'records',operation:'count',filters:[]},{field:'amount',operation:'sum',filters:[]}],calculations:[],order:{column:2,direction:'desc'},limit:5};
  const run = async p => { const c=compilePlan(p,Date.UTC(2026,9,3)); return (await reader.query(c.text,c.values)).rows; };
  const flows=await run(query);assert.equal(flows[0].m0,'1.000000');assert.equal(flows[0].m1,'9007199254740993.000000');
  const fees=await run({...query,dataset:'transactions',filters:[],dimensions:['miner'],bucket:'none',measures:[{field:'fees',operation:'sum',filters:[]},{field:'records',operation:'count',filters:[]}],order:{column:1,direction:'desc'}});
  assert.equal(fees[0].m0,'16.000000');assert.equal(fees[0].m1,'2.000000');
  const swaps=await run({...query,dataset:'swaps',bucket:'none',dimensions:['direction','chain'],filters:[],measures:[{field:'usd',operation:'sum',filters:[]}],order:{column:2,direction:'desc'}});
  assert.equal(swaps.length,2);assert.equal(swaps[0].d1,'BTC');assert.equal(swaps[0].m0,'800.000000');assert.equal(swaps[1].m0,'123.450000');assert.equal(swaps[1].u0,'2');
  await owner.query(fs.readFileSync(path.resolve(__dirname,'../../../deploy/ask-analytics/refresh-swaps-v2.sql'),'utf8'));
  assert.deepEqual(await run({...query,dataset:'swaps',bucket:'none',dimensions:['direction','chain'],filters:[],measures:[{field:'usd',operation:'sum',filters:[]}],order:{column:2,direction:'desc'}}),swaps);
  const ratio=await run({...query,dataset:'daily',bucket:'none',filters:[],measures:[{field:'ironwood',operation:'last',filters:[]},{field:'sapling',operation:'last',filters:[]}],calculations:[{operation:'ratio',left:0,right:1}],order:{column:0,direction:'desc'}});assert.equal(ratio[0].c0,null);
  await assert.rejects(reader.query('SELECT private_fixture FROM public.transactions'),/permission denied/);
  await owner.query('CREATE VIEW ask_public.unreviewed AS SELECT secret FROM public.private_fixture; GRANT SELECT ON ask_public.unreviewed TO ask_analytics_reader');
  assert.equal((await reader.query(GUARD)).rows[0].only_public_view,false);
  await owner.query('DROP VIEW ask_public.unreviewed');
  const service = createAnalytics({ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_DATABASE_URL:`postgres://ask_analytics_reader@localhost/${name}`,ASK_ANALYTICS_DAILY_QUERY_LIMIT:'100'},{pool:reader});
  await assert.rejects(service.execute(input,{redis:{isReady:true,eval:async()=>1,zRem:async()=>{}},now:Date.UTC(2026,9,2)}),error=>error.askKind==='source');
  // Effective PUBLIC and column-level leaks must be detected too.
  await owner.query('GRANT SELECT ON private_fixture TO PUBLIC');
  assert.equal((await reader.query(GUARD)).rows[0].only_public_view,false);
  await owner.query('REVOKE SELECT ON private_fixture FROM PUBLIC; GRANT UPDATE(secret) ON private_fixture TO ask_analytics_reader');
  assert.equal((await reader.query(GUARD)).rows[0].only_public_view,false);
  await owner.query('REVOKE UPDATE(secret) ON private_fixture FROM ask_analytics_reader');
  await owner.query("CREATE FUNCTION public.unsafe_fixture() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT secret FROM public.private_fixture'");
  assert.equal((await reader.query(GUARD)).rows[0].no_definers,false);
});
