'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const catalogue = require('../../v1/lib/ask-public-catalogue');
const {validateSnapshot,readCoreSnapshot,applyCoreSnapshot,MAX_BLOCKS,FIELDS}=require('../../lib/ask-core-store');
const id='00000000-0000-4000-8000-000000000001';
const h=n=>BigInt(n).toString(16).padStart(64,'0');
const now=Date.UTC(2026,9,4);
function fixture() {
  const blocks=[100,101].map(n=>({height:String(n),hash:h(n),previous_hash:h(n-1),timestamp:String(1790985600+(n-100)*75),transaction_count:'2',size:'100',total_fees:'7',miner_address:'fixture-miner'}));
  const transactions=blocks.flatMap((b,i)=>[true,false].map((is_coinbase,j)=>({txid:h(1000+i*10+j),block_height:b.height,block_hash:b.hash,block_time:b.timestamp,is_coinbase,fee:j?'7':'0',size:'50',has_sapling:false,has_orchard:!is_coinbase,has_ironwood:false,has_sprout:false,value_balance_orchard:j?'-9007199254740993':null,value_balance_ironwood:null})));
  const flows=[{txid:h(1001),block_height:'100',block_time:blocks[0].timestamp,flow_type:'shield',pool:'orchard',amount_zat:'9007199254740993'},
    {txid:h(1001),block_height:'100',block_time:blocks[0].timestamp,flow_type:'deshield',pool:'orchard',amount_zat:'100'},
    {txid:h(1011),block_height:'101',block_time:blocks[1].timestamp,flow_type:'shield',pool:'orchard',amount_zat:'10'}];
  return {version:1,network:'mainnet',source:{mode:'fixture_snapshot',id,revision:'1',observed_at:new Date(now).toISOString()},range:{from:'100',through:'101'},blocks,transactions,flows};
}

test('snapshot contract refuses incomplete, noncanonical, ambiguous and oversized inputs',()=>{
  const valid=fixture();assert.equal(validateSnapshot(valid,now).flows[1].amount_zat,'9007199254740993');
  const reject=fn=>{const input=structuredClone(valid);fn(input);assert.throws(()=>validateSnapshot(input,now));};
  reject(s=>{s.blocks.pop();});
  reject(s=>{s.transactions.pop();});
  reject(s=>{s.blocks[1].previous_hash=h(9);});
  reject(s=>{s.blocks[1].hash=s.blocks[0].hash;});
  reject(s=>{s.flows=Array.from({length:5001},()=>({...s.flows[0]}));});
  reject(s=>{s.transactions[1].block_hash=h(9);});
  reject(s=>{s.transactions[1].block_time='0';});
  reject(s=>{s.flows[0].block_time='0';});
  reject(s=>{s.flows[0].amount_zat=9007199254740993;});
  reject(s=>{s.flows[0].amount_zat='-1';});
  reject(s=>{s.flows.push({...s.flows[0]});});
  reject(s=>{s.transactions[1].is_coinbase=true;});
  reject(s=>{s.transactions[1].has_orchard=null;});
  reject(s=>{s.transactions[1].credentials='fixture-secret';});
  reject(s=>{s.range.through=String(100+MAX_BLOCKS);});
  reject(s=>{s.source.revision='0';});
  reject(s=>{s.source.mode='production';});
  reject(s=>{s.source.observed_at=new Date(now+60001).toISOString();});
  reject(s=>{s.source.id='not-a-uuid';});
  reject(s=>{s.network='testnet';});
  reject(s=>{s.blocks[0].miner_address='x'.repeat(257);});
  reject(s=>{s.flows[0].amount_zat='1e8';});
});

test('local PostgreSQL: one-way copy, atomic publication, retries, reorgs and grants', {skip:process.env.ASK_STORE_TEST_POSTGRES!=='1'},async t=>{
  const {Pool}=require('pg');
  // Ignore environment connection URLs/users; fixed local Unix socket only.
  const local={host:'/tmp',user:os.userInfo().username,max:1,ssl:false};
  const admin=new Pool({...local,database:'postgres'});
  const sourceName=`ask_source_fixture_${process.pid}`,storeName=`ask_store_fixture_${process.pid}`;
  const roles=['ask_store_owner','ask_store_writer','ask_store_reader'];
  if(Number((await admin.query('SELECT count(*) FROM pg_roles WHERE rolname=ANY($1::text[])',[roles])).rows[0].count)) {
    await admin.end();throw new Error('Local test roles already exist; refusing to reuse them');
  }
  const created=[];let source,store,writer,reader;
  t.after(async()=>{
    await Promise.all([source?.end(),store?.end(),writer?.end(),reader?.end()]);
    for(const name of created) await admin.query(`DROP DATABASE ${name}`);
    for(const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });
  for(const name of [sourceName,storeName]) {await admin.query(`CREATE DATABASE ${name}`);created.push(name);}
  source=new Pool({...local,database:sourceName});store=new Pool({...local,database:storeName});
  const types={integer:'bigint',integer_or_numeric:'numeric',text:'text',boolean:'boolean'};
  for(const candidate of catalogue.sources.filter(s=>['blocks','transactions','flows'].includes(s.id))) {
    const columns=Object.entries(candidate.fields).map(([name,field])=>`${name} ${types[field.type]}`);
    if(candidate.id==='blocks') columns.push('previous_block_hash text');
    await source.query(`CREATE TABLE ${candidate.relation} (${columns.join(',')})`);
  }
  await source.query(`CREATE TABLE fixture_control(singleton boolean PRIMARY KEY CHECK(singleton),id uuid,revision bigint,network text);
    CREATE TABLE private_fixture(secret text); INSERT INTO private_fixture VALUES('never-export');`);
  await source.query('INSERT INTO fixture_control VALUES(true,$1,1,$2)',[id,'mainnet']);
  const initial=fixture();
  for(const kind of Object.keys(FIELDS)) {
    const relation={blocks:'blocks',transactions:'transactions',flows:'shielded_flows'}[kind];
    const fields=FIELDS[kind].map(k=>k==='previous_hash'?'previous_block_hash':k);
    for(const row of initial[kind]) await source.query(`INSERT INTO public.${relation}(${fields.join(',')}) VALUES(${fields.map((_,i)=>`$${i+1}`).join(',')})`,FIELDS[kind].map(k=>row[k]));
  }
  const provision=fs.readFileSync(path.resolve(__dirname,'../../../deploy/ask-analytics/local-core-store.sql'),'utf8');
  await assert.rejects(source.query(provision),/Disposable local store database required/);
  await source.query('ROLLBACK');
  assert.equal((await admin.query('SELECT count(*) FROM pg_roles WHERE rolname=ANY($1::text[])',[roles])).rows[0].count,'0');
  await assert.rejects(readCoreSnapshot(store,{from:'100',through:'101'}),/disposable local source required/);
  await store.query(provision);
  await store.query("CREATE TABLE public.private_fixture(secret text); INSERT INTO public.private_fixture VALUES('never-query')");
  writer=new Pool({...local,user:'ask_store_writer',database:storeName});
  reader=new Pool({...local,user:'ask_store_reader',database:storeName});
  const state=async()=>(await reader.query('SELECT * FROM analytics_public.coverage')).rows[0];
  const read=()=>readCoreSnapshot(source,{from:'100',through:'101'});
  const publish=(snapshot,generation,pool=writer)=>applyCoreSnapshot(pool,snapshot,{expectedGeneration:generation});
  let first;
  await t.test('bootstrap copies only public fields and preserves exact money',async()=>{
    first=await read();assert.equal(first.flows[1].amount_zat,'9007199254740993');
    assert.equal(JSON.stringify(first).includes('never-export'),false);
    assert.equal((await reader.query('SELECT count(*) FROM analytics_public.coverage')).rows[0].count,'0');
    await assert.rejects(publish(first,'0',store),/local writer/);
    assert.equal((await publish(first,'0')).generation,'1');
    assert.equal((await state()).covered_through,'101');assert.equal((await state()).flow_completeness,'historical_backfill_unverified');
    const result=(await reader.query(`WITH shield AS(SELECT txid,sum(amount_zat) AS amount FROM analytics_public.flows WHERE flow_type='shield' GROUP BY txid)
      SELECT b.miner_address,count(*)::text AS transactions,sum(s.amount)::text AS amount,sum(t.fee)::text AS fees
      FROM shield s JOIN analytics_public.transactions t ON t.txid=s.txid JOIN analytics_public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash
      WHERE NOT t.is_coinbase GROUP BY b.miner_address`)).rows[0];
    assert.deepEqual(result,{miner_address:'fixture-miner',transactions:'2',amount:'9007199254741003',fees:'14'});
  });
  await t.test('retries and a new observation of an unchanged revision do not duplicate data',async()=>{
    assert.deepEqual(await publish(first,'0'),{status:'duplicate',generation:'1'});
    const repeated=await read();repeated.flows.reverse();
    assert.deepEqual(await publish(repeated,'1'),{status:'duplicate',generation:'1'});
    assert.equal((await reader.query('SELECT count(*) FROM analytics_public.transactions')).rows[0].count,'4');
  });
  await t.test('new revision updates historical rows; stale/checkpoint conflicts are refused',async()=>{
    await source.query("BEGIN; UPDATE shielded_flows SET amount_zat=42 WHERE flow_type='shield' AND block_height=100; DELETE FROM shielded_flows WHERE flow_type='deshield'; UPDATE fixture_control SET revision=2; COMMIT;");
    const updated=await read();
    await assert.rejects(publish(updated,'0'),/checkpoint conflict/);
    assert.equal((await publish(updated,'1')).generation,'2');
    assert.equal((await reader.query("SELECT amount_zat::text FROM analytics_public.flows WHERE block_height=100 AND flow_type='shield'")).rows[0].amount_zat,'42');
    assert.equal((await reader.query("SELECT count(*) FROM analytics_public.flows WHERE flow_type='deshield'")).rows[0].count,'0');
    await assert.rejects(publish(first,'2'),/stale or conflicting/);
    const changed=structuredClone(updated);changed.flows[0].amount_zat='123';
    await assert.rejects(publish(changed,'2'),/stale or conflicting/);
  });
  await t.test('reorg replaces canonical rows and growth advances coverage together',async()=>{
    await source.query('BEGIN');
    await source.query('UPDATE blocks SET hash=$1 WHERE height=101',[h(201)]);
    // Keep the old source transaction as an orphan to prove the join excludes it.
    await source.query('UPDATE transactions SET txid=$1,block_hash=$2 WHERE block_height=101 AND is_coinbase',[h(2010),h(201)]);
    await source.query('INSERT INTO transactions SELECT $1,block_height,$2,block_time,is_coinbase,fee,size,has_sapling,has_orchard,has_ironwood,has_sprout,value_balance_orchard,value_balance_ironwood FROM transactions WHERE txid=$3',[h(2011),h(201),h(1011)]);
    await source.query('INSERT INTO blocks SELECT 102,$1,timestamp+75,transaction_count,size,total_fees,miner_address,$2 FROM blocks WHERE height=101',[h(202),h(201)]);
    await source.query('INSERT INTO transactions SELECT $1,102,$2,block_time+75,is_coinbase,fee,size,has_sapling,has_orchard,has_ironwood,has_sprout,value_balance_orchard,value_balance_ironwood FROM transactions WHERE txid=$3',[h(2020),h(202),h(2010)]);
    await source.query('INSERT INTO transactions SELECT $1,102,$2,block_time+75,is_coinbase,fee,size,has_sapling,has_orchard,has_ironwood,has_sprout,value_balance_orchard,value_balance_ironwood FROM transactions WHERE txid=$3',[h(2021),h(202),h(2011)]);
    await source.query('UPDATE fixture_control SET revision=3; COMMIT');
    const reorg=await readCoreSnapshot(source,{from:'100',through:'102'});
    assert.equal((await publish(reorg,'2')).generation,'3');
    assert.equal((await state()).tip_hash,h(202));
    assert.equal((await reader.query('SELECT count(*) FROM analytics_public.transactions WHERE txid=$1',[h(1011)])).rows[0].count,'0');
    assert.equal((await reader.query('SELECT count(*) FROM analytics_public.flows WHERE txid=$1',[h(1011)])).rows[0].count,'0');
  });
  await t.test('source tip retreat removes the old tail rather than retaining stale rows',async()=>{
    await source.query('BEGIN; DELETE FROM blocks WHERE height=102; UPDATE fixture_control SET revision=4; COMMIT');
    assert.equal((await publish(await read(),'3')).generation,'4');
    assert.equal((await state()).covered_through,'101');
    assert.equal((await reader.query('SELECT count(*) FROM analytics_public.transactions WHERE block_height=102')).rows[0].count,'0');
  });
  await t.test('interrupted publication rolls back all rows and watermark; retry resumes',async()=>{
    await source.query("BEGIN; UPDATE shielded_flows SET amount_zat=777 WHERE block_height=100 AND flow_type='shield'; UPDATE fixture_control SET revision=5; COMMIT");
    const snapshot=await read();
    const interrupted={connect:async()=>{
      const client=await writer.connect();return {
        query:async(text,values)=>{
          if(text.startsWith('UPDATE analytics_meta.sync_state SET generation')) {
            assert.equal((await state()).generation,'4');
            assert.equal((await reader.query("SELECT amount_zat::text FROM analytics_public.flows WHERE block_height=100 AND flow_type='shield'")).rows[0].amount_zat,'42');
            throw new Error('fixture simulated connection interruption');
          }
          return client.query(text,values);
        },release:discard=>client.release(discard),
      };
    }};
    await assert.rejects(publish(snapshot,'4',interrupted),/simulated connection interruption/);
    assert.equal((await state()).generation,'4');
    assert.equal((await publish(snapshot,'4')).generation,'5');
    assert.equal((await reader.query("SELECT amount_zat::text FROM analytics_public.flows WHERE block_height=100 AND flow_type='shield'")).rows[0].amount_zat,'777');
  });
  await t.test('missing transactions, wrong source identity and changed range stay unpublished',async()=>{
    const wrong=await read();wrong.source.id='00000000-0000-4000-8000-000000000002';wrong.source.revision='6';
    await assert.rejects(publish(wrong,'5'),/source\/range identity/);
    wrong.source.id=id;wrong.range.from='101';wrong.blocks.shift();wrong.transactions=wrong.transactions.filter(tx=>tx.block_height==='101');wrong.flows=wrong.flows.filter(f=>f.block_height==='101');
    await assert.rejects(publish(wrong,'5'),/source\/range identity/);
    await source.query('DELETE FROM transactions WHERE txid=$1',[h(2011)]);
    await assert.rejects(read(),/incomplete block/);
    assert.equal((await state()).generation,'5');
    assert.equal((await reader.query('SELECT count(*) FROM analytics_public.transactions')).rows[0].count,'4');
  });
  await t.test('reader cannot write, access metadata/private fields, grant privileges or access files/programs',async()=>{
    const attacks=['DELETE FROM analytics_public.blocks','UPDATE analytics_public.flows SET amount_zat=0','TRUNCATE analytics_public.transactions',
      'DROP TABLE analytics_public.blocks','CREATE TABLE analytics_public.attack(x int)','CREATE TEMP TABLE attack(x int)',
      'SELECT * FROM analytics_meta.sync_state','SELECT secret FROM public.private_fixture','SET ROLE ask_store_writer','SET ROLE ask_store_owner',
      'ALTER ROLE ask_store_reader SUPERUSER',"SELECT pg_read_file('/etc/passwd')","COPY (SELECT 1) TO PROGRAM 'id'"];
    for(const sql of attacks) {
      const client=await reader.connect();
      try {await client.query('SET default_transaction_read_only=off');await assert.rejects(client.query(sql),/permission|must be|not permitted/i,sql);}
      finally {client.release(true);}
    }
    // PostgreSQL may warn and do nothing for a GRANT without grant option.
    // Verify effective ACLs instead of requiring a SQL error for that case.
    const grantClient=await reader.connect();
    try {await grantClient.query('SET default_transaction_read_only=off');await grantClient.query('GRANT SELECT ON analytics_public.blocks TO PUBLIC');}
    finally {grantClient.release(true);}
    const publicGrant=(await store.query(`SELECT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid='analytics_public.blocks'::regclass AND a.grantee=0 AND a.privilege_type='SELECT') AS leaked`)).rows[0];
    assert.equal(publicGrant.leaked,false);
    const privileges=(await store.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
      FROM pg_roles WHERE rolname='ask_store_reader'`)).rows[0];
    assert.ok(Object.values(privileges).every(v=>v===false));
    assert.equal((await store.query(`SELECT count(*) FROM pg_auth_members WHERE member IN
      (SELECT oid FROM pg_roles WHERE rolname IN ('ask_store_reader','ask_store_writer'))`)).rows[0].count,'0');
    for(const sql of ['TRUNCATE analytics_public.blocks','DROP TABLE analytics_public.blocks','CREATE TABLE analytics_public.attack(x int)','SELECT secret FROM public.private_fixture','SET ROLE ask_store_owner']) await assert.rejects(writer.query(sql),/permission|must be|not permitted/i);
    assert.equal((await state()).generation,'5');
  });
});
