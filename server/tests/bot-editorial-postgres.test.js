'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Pool } = require('pg');
const data = require('../bot/lib/editorial-data');
const { publish } = require('../bot/jobs/editorial');
const log={info(){},warn(){},error(){}};

test('editorial SQL: canonical flows, provider samples, UTC dates and atomic publication', {skip:process.env.ACTIVITY_TEST_POSTGRES!=='1'&&!process.env.TEST_ACTIVITY_DATABASE_URL},async()=>{
  const connection=process.env.TEST_ACTIVITY_DATABASE_URL;
  const admin=new Pool(connection?{connectionString:connection}:{host:'/tmp',database:'postgres'});
  const name=`bot_test_${process.pid}_${Date.now()}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url=connection?new URL(connection):null;if(url)url.pathname=`/${name}`;
    db=new Pool({...url?{connectionString:url.toString()}:{host:'/tmp',database:name},max:4,options:'-c timezone=Asia/Tokyo'});
    await db.query(fs.readFileSync(require.resolve('../bot/migrations/001_social_post_outbox.sql'),'utf8'));
    await db.query(`CREATE TABLE blocks(height bigint PRIMARY KEY,hash text,timestamp bigint,total_fees bigint);
      CREATE TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_time bigint,is_coinbase boolean DEFAULT false,
        vin_count integer DEFAULT 1,vout_count integer DEFAULT 0,value_balance_sapling bigint DEFAULT 0,
        value_balance_orchard bigint DEFAULT 0,value_balance_ironwood bigint DEFAULT 0);
      CREATE TABLE shielded_flows(txid text,block_height bigint,block_time bigint,flow_type text,amount_zat bigint,pool text);
      CREATE TABLE cross_chain_swaps(id integer,source_chain text,dest_chain text,source_amount_usd numeric,zec_txid text,status text,swap_created_at timestamptz);
      CREATE TABLE sync_state(job_name text,updated_at timestamptz);
      CREATE TABLE fork_events(id integer,depth integer,fork_height bigint,detected_at timestamptz);
      CREATE TABLE mvrv_daily(date date,mvrv numeric);
      CREATE TABLE turnstile_daily(date date,exchange_zat bigint);
      INSERT INTO blocks SELECT i,md5(i::text),extract(epoch FROM timestamptz '2026-09-29T06:00:00Z'),100 FROM generate_series(0,400) i;
      UPDATE blocks SET timestamp=extract(epoch FROM timestamptz '2026-09-29T07:50:00Z') WHERE height=400;
      INSERT INTO transactions(txid,block_height,block_time,value_balance_ironwood)
        SELECT repeat('0',32)||md5(i::text),i,timestamp,CASE WHEN i=400 THEN -89999975000 WHEN i<200 THEN -100000000 ELSE 1000000000000 END FROM blocks b CROSS JOIN LATERAL (SELECT b.height AS i) q;
      INSERT INTO shielded_flows SELECT txid,block_height,block_time,CASE WHEN value_balance_ironwood<0 THEN 'shield' ELSE 'deshield' END,abs(value_balance_ironwood),'ironwood' FROM transactions;
      INSERT INTO cross_chain_swaps SELECT i,'sol','zec',CASE WHEN i=2000 THEN 2000000 ELSE 100 END,repeat('b',64),'SUCCESS',
        CASE WHEN i=2000 THEN timestamptz '2026-09-29T07:55:00Z' ELSE timestamptz '2026-09-28T20:00:00Z' END FROM generate_series(0,2000) i;
      INSERT INTO cross_chain_swaps VALUES (2001,'zec','eth',200,repeat('c',64),'SUCCESS','2026-09-28T23:59:59Z'),
        (2002,'zec','zec',999999999,repeat('d',64),'SUCCESS','2026-09-28T20:00:00Z'),
        (2003,'eth','zec',999999999,repeat('e',64),'PENDING_DEPOSIT','2026-09-28T20:00:00Z'),
        (2004,'eth','zec',null,repeat('f',64),'SUCCESS','2026-09-28T20:00:00Z');
      INSERT INTO sync_state VALUES('crosschain_swaps','2026-09-29T08:00:00Z');
      INSERT INTO mvrv_daily SELECT d,CASE WHEN d='2026-09-28' THEN 4 ELSE 2 END FROM generate_series('2026-08-29'::date,'2026-09-28'::date,interval '1 day') d;`);
    const now=new Date('2026-09-29T08:00:00Z');
    await assert.rejects(data.assertMainnetFresh(db,now),/mainnet-only/);
    // Only database name is mapped; every transaction/aggregate executes on real PostgreSQL.
    const wrap=client=>({query:(sql,args)=>client.query(sql.replace('current_database() AS name',"'zcash_explorer_mainnet' AS name"),args),release:()=>client.release()});
    const reader={connect:async()=>wrap(await db.connect())};
    const withoutPrice={fetchPrice:async()=>({quote:null,unavailable:'http-429'})};
    const withPrice={fetchPrice:async()=>({quote:{usd:1240,source:'coingecko',currency:'usd',basis:'spot-at-detection',
      sourceUpdatedAt:'2026-09-29T07:59:00Z',fetchedAt:now.toISOString()},unavailable:null})};
    const live=await data.liveCandidates(reader,now,withoutPrice);
    const flow=live.candidates.find(c=>c.type==='flow_shield');assert.ok(flow);
    assert.equal(Number(flow.evidence.sample_count),200);assert.match(flow.content,/One of the largest 0\.5% of shielding/);
    assert.ok(live.decisions.some(d=>d.reason==='context-unavailable'));assert.doesNotMatch(flow.content,/\$/);
    await db.query(`CREATE TABLE zec_price_daily(date date,price_usd numeric);INSERT INTO zec_price_daily VALUES('2026-09-29',1400);
      CREATE TABLE privacy_stats(sapling_pool_size bigint,orchard_pool_size bigint,ironwood_pool_size bigint,transparent_pool_size bigint,shielded_pool_size bigint,updated_at timestamptz);
      INSERT INTO privacy_stats VALUES(1,1,406127848872798,1,406127848872800,'2026-09-29T07:30:00Z');
      CREATE TABLE privacy_trends_daily(date date,pool_size bigint,chain_supply bigint,ironwood_pool_size bigint);
      INSERT INTO privacy_trends_daily SELECT d,490000000000000,1700000000000000,CASE WHEN d='2026-09-28' THEN 401000000000000 ELSE 380000000000000 END
        FROM generate_series('2026-06-01'::date,'2026-09-29'::date,interval '1 day') d;`);
    const priced=(await data.liveCandidates(reader,now,withPrice)).candidates.find(c=>c.type==='flow_shield');
    assert.match(priced.content,/899\.99 ZEC \(\$1\.11M\) just entered Ironwood/);assert.match(priced.content,/Ironwood now holds 4\.06M ZEC/);
    assert.equal(priced.evidence.price_usd,1240);assert.equal(priced.evidence.price_quote.source,'coingecko');
    const unpriced=(await data.liveCandidates(reader,now,withoutPrice)).candidates.find(c=>c.type==='flow_shield');
    assert.doesNotMatch(unpriced.content,/\$/);assert.equal(unpriced.evidence.usd,null);
    const milestones=await data.milestoneCandidates(reader,now);
    assert.deepEqual(milestones.map(m=>m.key),['milestone:ironwood_zec:4000000']);
    const swap=live.candidates.find(c=>c.type==='swap');assert.ok(swap);assert.equal(swap.evidence.exceptional,true);
    assert.equal(Number(swap.evidence.sample_count),2001);
    const summary=await data.crosschainDaily(reader,now);assert.equal(summary.evidence.count,'2001');
    assert.equal(Number(summary.evidence.inflow),200000);assert.equal(Number(summary.evidence.outflow),200);
    assert.match(summary.content,/via NEAR Intents on Sep 28\./);
    const signals=await data.signalCandidates(reader,now);assert.ok(signals.find(c=>c.evidence.metric==='mvrv'));
    // Bad balance, fully shielded migration, and coinbase must not become shielding alerts.
    await db.query('UPDATE transactions SET is_coinbase=true WHERE block_height=400');
    assert.equal((await data.liveCandidates(reader,now,withoutPrice)).candidates.filter(c=>c.type==='flow_shield').length,0);
    await db.query('UPDATE transactions SET is_coinbase=false,value_balance_ironwood=-1 WHERE block_height=400');
    assert.equal((await data.liveCandidates(reader,now,withoutPrice)).candidates.filter(c=>c.type==='flow_shield').length,0);
    await db.query('UPDATE sync_state SET updated_at=updated_at-interval \'1 hour\'');
    assert.equal(await data.crosschainDaily(reader,now),null);
    assert.ok((await data.liveCandidates(reader,now,withoutPrice)).decisions.some(d=>d.reason==='sync-unavailable-or-stale'));
    // Concurrent dispatches of the same deterministic story call X exactly once.
    let sent=0;
    const x={post:async()=>{sent++;return {id:'12345'};}};
    const results=await Promise.all([publish(db,x,flow,{logger:log}),publish(db,x,flow,{logger:log})]);
    assert.equal(sent,1);assert.deepEqual(results.map(r=>r.status).sort(),['duplicate','posted']);
    const before=(await db.query('SELECT count(*) FROM social_post_outbox')).rows[0].count;
    await publish(db,{dryRun:true},swap,{logger:log});
    assert.equal((await db.query('SELECT count(*) FROM social_post_outbox')).rows[0].count,before);
    const held={...swap,key:'timeout'};
    await publish(db,{post:async()=>{throw new Error('timeout');}},held,{logger:log});
    await publish(db,x,held,{logger:log});assert.equal(sent,1);
    assert.equal((await db.query("SELECT status FROM social_post_outbox WHERE dedup_key='timeout'")).rows[0].status,'uncertain');
  } finally {
    if(db)await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();
  }
});
