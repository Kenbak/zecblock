'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays } = require('../lib/transaction-activity');
const { weeklyBriefing,poolTrend,insightStories,insightFixtures } = require('../bot/lib/editorial-insights');
const { readInsightSource } = require('../bot/lib/editorial-insight-source');

const ZAT = 100000000n;
const target = '2026-10-25';
function source(overrides = () => ({})) {
  return { network:'mainnet',historyStart:addDays(target,-36),tip:{height:1000,hash:'a'.repeat(64),timestamp:1793001300},
    capturedAt:'2026-10-26T08:00:00Z',days:Array.from({length:37},(_,i) => ({
      date:addDays(target,i-36),complete:true,totalTransactions:i<30 ? 10000 : 12000,
      shieldedTransactions:i<30 ? 5000 : 7200,feesZat:String((i<30 ? 20n : 25n)*ZAT),
      publicFlowComplete:true,shieldZat:String((i<30 ? 200n : 800n)*ZAT),deshieldZat:String((i<30 ? 400n : 100n)*ZAT),
      ...overrides(i),
    })) };
}

test('weekly briefing uses weighted, unique-transaction share and exact fees over calendar UTC weeks', () => {
  const s = source(i => i===36 ? {totalTransactions:20000,shieldedTransactions:10000,feesZat:'2500000001'} : {});
  const c = weeklyBriefing(s,target);
  assert.equal(c.type,'network_briefing');
  assert.equal(c.key,'analysis:network-briefing:2026-10-19');
  assert.deepEqual(c.evidence.period,{start:'2026-10-19',endExclusive:'2026-10-26'});
  assert.equal(c.evidence.totals.transactions,'92000');
  assert.equal(c.evidence.totals.shieldedTransactions,'53200');
  assert.equal(c.evidence.totals.feesZat,'17500000001');
  assert.equal(c.evidence.stats.shieldedShare,57.8);
  assert.match(c.content,/57\.8% used shielded pools/);
  assert.match(c.content,/175 ZEC paid in fees/);
  assert.equal(c.evidence.card.visual.kind,'briefing');
  assert.equal(c.evidence.card.visual.items.length,3);
  assert.equal(c.evidence.card.visual.items[2].value,'175 ZEC');
  assert.equal(c.evidence.editorial.topic,'network');
  assert.ok(c.evidence.editorial.significance>=50 && c.evidence.editorial.significance<=100);
});

test('weekly fractional shares and point changes truncate exact rational arithmetic toward zero', () => {
  const fixture = (current,prior) => source(i => i>=30 ? current : prior);
  const c = weeklyBriefing(fixture({totalTransactions:3,shieldedTransactions:2},
    {totalTransactions:2,shieldedTransactions:1}),target);
  assert.match(c.content,/66\.6% used shielded pools \(\+16\.6 pts\)/);
  assert.equal(c.evidence.card.visual.items[1].value,'66.6%');
  assert.equal(c.evidence.stats.shareChangePoints,16.6);
  assert.deepEqual(c.evidence.fractions.shieldedShare,{numerator:'14',denominator:'21'});
  assert.deepEqual(c.evidence.fractions.shareChangePoints,{numerator:'4900',denominator:'294'});
  const down = weeklyBriefing(fixture({totalTransactions:2,shieldedTransactions:1},
    {totalTransactions:3,shieldedTransactions:2}),target);
  assert.match(down.content,/50\.0% used shielded pools \(−16\.6 pts\)/);
  assert.equal(down.evidence.stats.shareChangePoints,-16.6);
});

test('weekly briefing rejects incomplete source intervals, missing fees and fabricated ratios', () => {
  assert.equal(weeklyBriefing(source(),addDays(target,-1)),null);
  for (const missing of [null,undefined,'',-1,'-1']) {
    assert.equal(weeklyBriefing(source(i => i===36 ? {feesZat:missing} : {}),target),null);
  }
  assert.equal(weeklyBriefing(source(i => i<30 ? {totalTransactions:0,shieldedTransactions:0} : {}),target),null);
  const zeroFees = weeklyBriefing(source(i => i<30 ? {feesZat:'0'} : {}),target);
  assert.ok(zeroFees);
  assert.equal(zeroFees.evidence.stats.feesChangePct,null);
  assert.equal(zeroFees.evidence.card.visual.items[2].detail,'Prior week: 0 ZEC');
  assert.doesNotMatch(zeroFees.content,/Infinity|NaN|unavailable/);
});

test('Tuesday catch-up retains the completed Sunday target, exact calendar windows and one weekly dedup key', () => {
  const monday = weeklyBriefing(source(),target);
  const later = source();
  later.days = later.days.slice(2).concat([1,2].map(n => ({...later.days.at(-1),date:addDays(target,n),
    totalTransactions:999999,shieldedTransactions:0,feesZat:'9999999999999'})));
  later.historyStart = later.days[0].date;
  later.capturedAt = '2026-10-28T08:00:00Z';
  const c = weeklyBriefing(later,'2026-10-27');
  assert.equal(c.key,monday.key);
  assert.equal(c.evidence.target,'2026-10-25');
  assert.deepEqual(c.evidence.period,{start:'2026-10-19',endExclusive:'2026-10-26'});
  assert.deepEqual(c.evidence.previousPeriod,{start:'2026-10-12',endExclusive:'2026-10-19'});
  assert.deepEqual(c.evidence.totals,monday.evidence.totals);
  assert.equal(c.evidence.days.at(-1).date,'2026-10-27');
  assert.equal(c.evidence.capturedAt,'2026-10-28T08:00:00Z');
  assert.equal(c.content,monday.content);
});

test('public flow reversal compares two disjoint complete 7-day windows in exact zatoshis', () => {
  const c = poolTrend(source(),target);
  assert.equal(c.evidence.editorial.lens,'flow_reversal');
  assert.equal(c.evidence.totals.netZat,'490000000000');
  assert.equal(c.evidence.previousTotals.netZat,'-140000000000');
  assert.equal(c.evidence.baselineTotals.netZat,'-600000000000');
  assert.deepEqual(c.evidence.previousPeriod,{start:'2026-10-12',endExclusive:'2026-10-19'});
  assert.deepEqual(c.evidence.baselinePeriod,{start:'2026-09-19',endExclusive:'2026-10-19'});
  assert.match(c.content,/4,900 ZEC net in, after 1,400 ZEC net out/);
  assert.match(c.content,/Sapling\/Orchard\/Ironwood; Sprout & migrations excluded/);
  const visual = c.evidence.card.visual;
  assert.equal(visual.allowNegative,true);
  assert.equal(visual.unit,'ZEC');
  assert.equal(visual.start,'2026-09-19');
  assert.equal(visual.end,target);
  assert.equal(visual.reference,-200);
  assert.equal(visual.values.at(-1),700);
  assert.equal(visual.values[0],-200);
});

test('public net outflows reverse the words and chart sign without a causal or adoption claim', () => {
  const c = poolTrend(source(i => ({shieldZat:String((i<30 ? 500n : 100n)*ZAT),deshieldZat:String((i<30 ? 100n : 1000n)*ZAT)})),target);
  assert.match(c.content,/6,300 ZEC net out, after 2,800 ZEC net in/);
  assert.equal(c.evidence.card.tone,'out');
  assert.ok(c.evidence.card.visual.values.at(-1)<0);
  assert.doesNotMatch(c.content,/demand|adoption|users|bullish|selling|buying/i);
});

test('streaks require measured consecutive nonzero signs and only first 7/14/21/30-day landmarks', () => {
  const streak = i => ({shieldZat:String((i>=30 ? 800n : i===29 ? 10n : 200n)*ZAT),
    deshieldZat:String((i>=30 ? 100n : i===29 ? 400n : 100n)*ZAT)});
  const c = poolTrend(source(streak),target);
  assert.equal(c.evidence.editorial.lens,'flow_streak');
  assert.equal(c.evidence.stats.streakDays,7);
  assert.match(c.content,/7 straight days of net inflows/);
  const broken = source(i => ({...streak(i),...(i===34 ? {shieldZat:'10000000000',deshieldZat:'10000000000'} : {})}));
  assert.notEqual(poolTrend(broken,target)?.evidence.editorial.lens,'flow_streak');
});

test('pace comparison uses a disjoint 30-day baseline, requires 50% change, and does not divide signed numbers', () => {
  const c = insightFixtures().find(s => s.evidence.editorial.lens==='flow_change');
  assert.ok(c);
  assert.equal(c.evidence.stats.changePct,278.5);
  assert.equal(c.evidence.baselineTotals.netZat,'600000000000');
  assert.match(c.content,/278\.5% above their prior 30-day pace/);
  assert.match(c.content,/1,400 ZEC per week/);
  // Stable/low-net periods are not filler stories.
  assert.equal(poolTrend(source(() => ({shieldZat:'10100000000',deshieldZat:'10000000000'})),target),null);
  assert.equal(poolTrend(source(() => ({shieldZat:'2000000000000',deshieldZat:'1990000000000'})),target),null);
});

test('missing days, unknown flow data and incomplete/non-mainnet classifications cannot become zero observations', () => {
  for (const mutate of [
    s => {s.network='testnet';},s => {s.days.pop();},s => {s.days[5].date=s.days[4].date;},
    s => {s.days[5].complete=false;},s => {s.days[5].totalTransactions=null;},
    s => {s.days[5].shieldedTransactions=20001;},
  ]) {
    const s = source(); mutate(s);
    assert.deepEqual(insightStories(s,target),[]);
  }
  for (const bad of [{publicFlowComplete:false},{shieldZat:null},{deshieldZat:'-1'}]) {
    assert.equal(poolTrend(source(i => i===5 ? bad : {}),target),null);
  }
  // Fees and flow availability are independent, never silently substituted.
  assert.ok(poolTrend(source(i => i===36 ? {feesZat:null} : {}),target));
  assert.ok(weeklyBriefing(source(i => i===36 ? {publicFlowComplete:false,shieldZat:null} : {}),target));
});

test('gallery fixtures cover briefing, reversal, streak and pace lenses with complete dated evidence', () => {
  const fixtures = insightFixtures();
  assert.deepEqual(fixtures.map(s => s.evidence.editorial.lens),['weekly_briefing','flow_reversal','flow_streak','flow_change']);
  for (const c of fixtures) {
    assert.ok(c.content.length<=280);
    assert.ok(c.evidence.target && c.evidence.period && c.evidence.tip && c.evidence.capturedAt);
    assert.ok(c.evidence.editorial.significance>=0 && c.evidence.editorial.significance<=100);
    assert.doesNotMatch(c.content,/NaN|Infinity|undefined|all.time|record/i);
    assert.ok(c.evidence.card.title);
  }
});

test('insight SQL verifies canonical coverage, exact balances, UTC windows and independent missing-data gates in PostgreSQL', {
  skip:process.env.ACTIVITY_TEST_POSTGRES!=='1' && !process.env.TEST_ACTIVITY_DATABASE_URL,
},async t => {
  const { Pool } = require('pg');
  const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
  const admin = new Pool(connection ? {connectionString:connection,max:1} : {host:'/tmp',database:'postgres',max:1});
  const name = `bot_insight_test_${process.pid}_${Date.now()}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = connection ? new URL(connection) : null; if (url) url.pathname=`/${name}`;
    db = new Pool({...(url ? {connectionString:url.toString()} : {host:'/tmp',database:name}),max:2,options:'-c timezone=Asia/Tokyo'});
    await db.query(`CREATE TABLE blocks(height bigint PRIMARY KEY,hash text,timestamp bigint,transaction_count integer,total_fees bigint);
      CREATE TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_hash text,block_time bigint,
        is_coinbase boolean DEFAULT false,vin_count integer DEFAULT 1,vout_count integer DEFAULT 0,
        has_sprout boolean DEFAULT false,has_sapling boolean DEFAULT false,has_orchard boolean DEFAULT false,has_ironwood boolean DEFAULT false,
        sprout_joinsplit_count integer DEFAULT 0,sapling_spend_count integer DEFAULT 0,sapling_output_count integer DEFAULT 0,
        orchard_actions integer DEFAULT 0,ironwood_actions integer DEFAULT 0,
        value_balance_sapling bigint DEFAULT 0,value_balance_orchard bigint DEFAULT 0,value_balance_ironwood bigint DEFAULT 0);
      INSERT INTO blocks SELECT 1000+i,repeat(md5(i::text),2),
        extract(epoch FROM timestamptz '2026-09-18T00:01:00Z')+i*86400,1,2000000000 FROM generate_series(0,38) i;
      UPDATE blocks SET timestamp=extract(epoch FROM timestamptz '2026-10-26T07:55:00Z') WHERE height=1038;
      INSERT INTO transactions(txid,block_height,block_hash,block_time,is_coinbase,value_balance_ironwood)
        SELECT 'coinbase-'||height,height,hash,timestamp,true,-999999999999 FROM blocks;
      INSERT INTO transactions(txid,block_height,block_hash,block_time,has_orchard,has_ironwood,vin_count,value_balance_orchard,value_balance_ironwood)
        SELECT v.txid,b.height,b.hash,b.timestamp,v.orchard,v.ironwood,v.vin,v.vb_orchard,v.vb_ironwood
        FROM blocks b CROSS JOIN (VALUES
          ('shield',false,true,1,0::bigint,-100000000001::bigint),
          ('deshield',true,false,1,10000000000,0),
          ('migration',true,true,0,1000000000000,-1000000000000),
          ('transparent',false,false,1,0,0),
          ('overlap',true,true,1,100000000000,-200000000000)
        ) AS v(txid,orchard,ironwood,vin,vb_orchard,vb_ironwood) WHERE b.height=1037;
      UPDATE blocks SET transaction_count=6 WHERE height=1037;
      -- Group by the canonical block's time, not a retained/incorrect transaction timestamp.
      UPDATE transactions SET block_time=extract(epoch FROM timestamptz '2026-10-26T00:00:00Z') WHERE txid='overlap';
      INSERT INTO transactions(txid,block_height,block_hash,block_time,has_ironwood,value_balance_ironwood)
        VALUES('orphan',1037,repeat('f',64),0,true,-999999999999);
      CREATE TABLE fixture_blocks AS TABLE blocks;CREATE TABLE fixture_transactions AS TABLE transactions;`);
    const now = new Date('2026-10-26T08:00:00Z'), queries=[];
    const reader = {connect:async () => {const client = await db.connect(); return {
      query:(sql,args) => {queries.push(sql);return client.query(sql.replace('current_database() AS name',"'zcash_explorer_mainnet' AS name"),args);},
      release:() => client.release(),
    };}};
    const reset = () => db.query(`TRUNCATE blocks,transactions;INSERT INTO blocks SELECT * FROM fixture_blocks;INSERT INTO transactions SELECT * FROM fixture_transactions;`);
    const mutate = async (label,sql,check) => t.test(label,async () => {
      await db.query(sql);try {await check();} finally {await reset();}
    });
    await t.test('complete canonical source excludes coinbase, orphan and migrations; overlaps count once',async () => {
      const result = await readInsightSource(reader,now);
      assert.equal(result.historyStart,'2026-09-19');
      assert.equal(result.days.length,37);
      assert.deepEqual(result.days.at(-1),{date:target,complete:true,totalTransactions:5,shieldedTransactions:4,
        feesZat:'2000000000',publicFlowComplete:true,shieldZat:'200000000001',deshieldZat:'10000000000'});
      assert.equal(result.days[0].shieldZat,'0');
      assert.equal(result.days[0].publicFlowComplete,true);
      assert.equal(result.tip.height,1038);
      assert.ok(queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
      assert.ok(queries.includes("SET LOCAL statement_timeout = '25s'"));
      assert.equal(queries.at(-1),'COMMIT');
    });
    await t.test('non-mainnet database is rejected',async () => assert.rejects(readInsightSource(db,now),/mainnet-only/));
    await mutate('stale tip fails closed','UPDATE blocks SET timestamp=timestamp-3600 WHERE height=1038',
      () => assert.rejects(readInsightSource(reader,now),/tip unavailable or stale/));
    await mutate('future tip fails closed','UPDATE blocks SET timestamp=timestamp+10800 WHERE height=1038',
      () => assert.rejects(readInsightSource(reader,now),/tip unavailable or stale/));
    await mutate('missing interior block invalidates the comparison','DELETE FROM blocks WHERE height=1015',
      () => assert.rejects(readInsightSource(reader,now),/Incomplete canonical insight/));
    await mutate('left shoulder is required','DELETE FROM blocks WHERE height=1000',
      () => assert.rejects(readInsightSource(reader,now),/Incomplete canonical insight/));
    await mutate('missing canonical transaction is not replaced by orphan','DELETE FROM transactions WHERE txid=\'shield\'',
      () => assert.rejects(readInsightSource(reader,now),/Incomplete canonical insight/));
    await mutate('an unknown expected count cannot hide missing transactions beside a valid same-day block', `
      UPDATE blocks SET height=1039 WHERE height=1038;
      UPDATE transactions SET block_height=1039 WHERE block_height=1038;
      INSERT INTO blocks(height,hash,timestamp,transaction_count,total_fees)
        VALUES(1038,repeat('b',64),extract(epoch FROM timestamptz '2026-10-25T00:02:00Z'),1,0);
      INSERT INTO transactions(txid,block_height,block_hash,block_time,is_coinbase)
        SELECT 'known-count-coinbase',height,hash,timestamp,true FROM blocks WHERE height=1038;
      UPDATE blocks SET transaction_count=NULL WHERE height=1037;
      DELETE FROM transactions WHERE txid='shield';`,
    () => assert.rejects(readInsightSource(reader,now),/Incomplete canonical insight/));
    await mutate('wrong block hash is rejected',"UPDATE transactions SET block_hash=repeat('e',64) WHERE txid='shield'",
      () => assert.rejects(readInsightSource(reader,now),/Incomplete canonical insight/));
    await mutate('unknown classification is unavailable',"UPDATE transactions SET has_orchard=NULL,orchard_actions=NULL WHERE txid='transparent'",
      () => assert.rejects(readInsightSource(reader,now),/Incomplete canonical insight/));
    await mutate('coinbase classification is required',"UPDATE transactions SET is_coinbase=NULL WHERE txid='transparent'",
      () => assert.rejects(readInsightSource(reader,now),/Incomplete canonical insight/));
    await mutate('missing fees stay unavailable; authoritative activity is retained','UPDATE blocks SET total_fees=NULL WHERE height=1037',async () => {
      const result = await readInsightSource(reader,now);assert.equal(result.days.at(-1).feesZat,null);
      assert.equal(result.days.at(-1).publicFlowComplete,true);assert.equal(weeklyBriefing(result,target),null);
    });
    await mutate('unknown public balance stays unavailable instead of zero',"UPDATE transactions SET value_balance_ironwood=NULL WHERE txid='shield'",async () => {
      const result = await readInsightSource(reader,now);assert.equal(result.days.at(-1).publicFlowComplete,false);
      assert.equal(result.days.at(-1).shieldZat,null);assert.equal(result.days.at(-1).deshieldZat,null);
      assert.equal(poolTrend(result,target),null);
    });
    await mutate('mixed Sprout movements cannot appear as new public shielding',"UPDATE transactions SET has_sprout=true,sprout_joinsplit_count=1 WHERE txid='shield'",async () => {
      const result = await readInsightSource(reader,now);
      assert.equal(result.days.at(-1).publicFlowComplete,true);
      assert.equal(result.days.at(-1).shieldZat,'100000000000');
      assert.equal(result.days.at(-1).totalTransactions,5);
    });
    await t.test('reader rolls back and releases after a failed read',async () => {
      await db.query('DELETE FROM blocks WHERE height=1015');
      await assert.rejects(readInsightSource(reader,now));assert.equal(queries.at(-1),'ROLLBACK');
      await reset();assert.equal((await readInsightSource(reader,now)).days.length,37);
    });
  } finally {
    if (db) await db.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();
  }
});
