'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays } = require('../lib/transaction-activity');
const p = require('../bot/lib/editorial-policy');
const { publish, run, activationTime } = require('../bot/jobs/editorial');
const target = '2026-09-28';
const now = new Date('2026-09-29T08:00:00Z');
const series = (value, latest) => Array.from({length:31}, (_,i) => ({date:addDays(target,i-30),value:i===30?latest:value}));
const log = {info(){},warn(){},error(){}};

// Counts, percentages and interpretations must remain distinguishable in copy.
test('daily activity explains share in percentage points and counts once', () => {
  const days = series(0,0).map((r,i)=>({date:r.date,shielded:i===30?90:50,transparent:i===30?10:50,fully_shielded:20}));
  const c=p.dailyActivity({days},target);
  assert.match(c.content,/^🟨 Zcash’s shielded transaction share hit a 31-day high\./);
  assert.match(c.content,/90.0% on Sep 28/);
  assert.match(c.content,/40.0 percentage points above the 30-day average \(50.0%\)/);
  assert.equal(c.evidence.editorial.lens,'record_high');
  assert.equal(c.evidence.card.visual.values.length,31);
  assert.equal(p.dailyActivity({days:days.slice(1)},target),null);
  days.at(-1).shielded=NaN;
  assert.equal(p.dailyActivity({days},target),null);
});

test('flow rank uses same-direction samples, includes ties and never invents precision',()=>{
  const flow={flow_type:'shield',amount_zat:89999975000,sample_count:10000,greater_count:4,equal_count:2,pool:'ironwood',txid:'a'.repeat(64)};
  const c=p.flowStory(flow);assert.match(c.content,/^🟨 899\.99 ZEC just entered Ironwood\./);
  assert.match(c.content,/One of the largest 0.07% of shielding transactions in 90 days\./);
  assert.doesNotMatch(c.content,/\$|now holds/);
  const priced=p.flowStory({...flow,price_usd:1483.2445,pool_zat:'406127848872798'});
  assert.match(priced.content,/899\.99 ZEC \(\$1\.33M\) just entered Ironwood/);assert.match(priced.content,/Ironwood now holds 4\.06M ZEC\./);
  assert.equal(p.flowStory({...flow,price_usd:0}).evidence.usd,null);
  assert.equal(p.flowStory({...flow,amount_zat:49999999999}),null);
  assert.equal(p.flowStory({...flow,equal_count:1000}),null);
  assert.equal(p.flowStory({...flow,sample_count:50}),null);
  assert.equal(p.flowStory({...flow,txid:'bad'}),null);
  assert.ok(c.content.length<=280);
});

test('swap uses explicit provider sample and preserves full provenance URL',()=>{
  const c=p.swapStory({id:1,source_amount_usd:1500000,source_chain:'sol',dest_chain:'zec',sample_count:10000,greater_count:2,equal_count:1,zec_txid:'b'.repeat(64)});
  assert.match(c.content,/^🟨 \$1,500,000 just crossed from Solana into ZEC\./);
  assert.match(c.content,/One of the largest 0.04% of ZEC swaps we've tracked on NEAR Intents in 30 days/);
  assert.equal(c.evidence.exceptional,true);assert.ok(c.content.endsWith('b'.repeat(64)));
  assert.equal(p.swapStory({id:2,source_amount_usd:1500000,source_chain:'sol',dest_chain:'eth',sample_count:10000,greater_count:2,equal_count:1}),null);
  assert.match(p.swapStory({id:3,source_amount_usd:90000,source_chain:'zec',dest_chain:'eth',sample_count:10000,greater_count:0,equal_count:0}).content,/The largest ZEC swap/);
});

test('migrations, reorgs and cross-chain days read as plain events with exact context',()=>{
  const m=p.migrationStory({txid:'c'.repeat(64),amount_zat:'1000000000000',block_time:1790812800,price_usd:1420.17,ironwood_zat:'406127848872798'});
  assert.match(m.content,/10,000 ZEC \(\$14\.20M\) just moved from Orchard to Ironwood\./);assert.match(m.content,/no new ZEC was shielded/);
  assert.equal(p.migrationStory({txid:'bad',amount_zat:'1'}),null);
  assert.match(p.reorgStory({id:1,depth:3,fork_height:3500000,detected_at:'2026-09-30T10:00:00Z'}).content,/3-block reorg at height 3,500,000/);
  assert.equal(p.reorgStory({id:1,depth:1,fork_height:3500000}),null);
  const x=p.crosschainStory({inflow:'2000000',outflow:'3000000',largest:'1500000',top_route:'zec -> sol'},target);
  assert.match(x.content,/Net \$1,000,000 flowed out of ZEC via NEAR Intents on Sep 28\./);assert.match(x.content,/Zcash → Solana/);
  assert.equal(p.crosschainStory({inflow:'1',outflow:'1',largest:'1',top_route:'<script> -> sol'},target),null);
});

test('worst-case values stay within the 280-character tweet limit',()=>{
  const flow=p.flowStory({flow_type:'deshield',amount_zat:'2100000000000000',sample_count:10000,greater_count:0,equal_count:0,pool:'sapling',
    txid:'a'.repeat(64),block_time:1790812800,price_usd:99999.99,pool_zat:'2100000000000000'});
  assert.ok(flow.content.length<=280);
  const swap=p.swapStory({id:1,source_amount_usd:999999999,source_chain:'arbitrum_nova_x',dest_chain:'zec',sample_count:10000,greater_count:5,equal_count:0,zec_txid:'b'.repeat(64)});
  assert.ok(swap.content.length<=280);
  for (const metric of ['exchange_deposit_zat','daily_fees_zat','shield_volume_zat','deshield_volume_zat','mvrv'])
    assert.ok(p.signalStory(metric,series(1,2.1e15),target).content.length<=280);
  assert.throws(()=>p.candidate('x','k','x'.repeat(281),{}),/exceeds 280/);
});

function trend(ironwood, {shielded=() => 4.9e6, supply=1.7e7, price=1400}={}) {
  return Array.from({length:100},(_,i)=>({date:addDays(target,i-99),pool_size:String(Math.round(shielded(i)*1e8)),
    chain_supply:String(supply*1e8),ironwood_pool_size:String(Math.round(ironwood(i)*1e8)),price_usd:price}));
}
test('milestones post only the first completed close at or above a level',()=>{
  const [m]=p.milestoneStories(trend(i=>i===99?4.01e6:3.8e6+i*1000),target);
  assert.equal(m.key,'milestone:ironwood_zec:4000000');
  assert.match(m.content,/^🟨 Milestone: Ironwood crossed 4M ZEC\.\n\nIt held 4\.01M ZEC \(\$5\.61B\) at the end of Sep 28, 81% of all shielded ZEC\./);
  // Hovering back above a level already reached on an earlier day is not new.
  assert.equal(p.milestoneStories(trend(i=>i===99?4.01e6:i===50?4.02e6:3.8e6),target).length,0);
  // Too little history cannot prove a level is new.
  assert.equal(p.milestoneStories(trend(i=>i===99?4.01e6:3.8e6).slice(-30),target).length,0);
  // A stale latest day is not today's close.
  assert.equal(p.milestoneStories(trend(i=>i===99?4.01e6:3.8e6).slice(0,-1),target).length,0);
  const share=p.milestoneStories(trend(()=>3.8e6,{shielded:i=>i===99?5.11e6:4.9e6}),target).find(s=>s.evidence.metric==='shielded_share');
  assert.equal(share.key,'milestone:shielded_share:30');assert.match(share.content,/30% of all ZEC is now shielded/);
  const usd=p.milestoneStories(trend(()=>3.8e6,{price:1400}).map((r,i)=>({...r,price_usd:i===99?1450:1400})),target).find(s=>s.evidence.metric==='shielded_usd');
  assert.equal(usd.key,'milestone:shielded_usd:7000000000');assert.match(usd.content,/more than \$7B for the first time on record/);
});

test('milestones are capped at one post per UTC day',()=>{
  const ms=['a','b'].map(k=>({type:'milestone',key:`milestone:${k}`,score:1,evidence:{}}));
  const result=p.select(ms,[],now);
  assert.equal(result.selected.length,1);assert.deepEqual(result.skipped.map(s=>s.reason),['daily-cap']);
});

test('MVRV and exchange signals explain context without price or selling claims',()=>{
  const c=p.signalStory('mvrv',series(2,3),target);
  assert.match(c.content,/Zcash’s MVRV reached a 31-day high\./);
  assert.match(c.content,/Zcash MVRV hit 3.00 on Sep 28, 50.0% above its 30-day average\./);
  assert.match(c.content,/estimated realized cap/);assert.match(c.content,/not a forecast/);
  assert.doesNotMatch(c.content,/overvalu|undervalu|σ/);
  assert.equal(p.signalStory('mvrv',series(0,3),target),null);
  const nulls=series(2,3);nulls[4].value=null;assert.equal(p.signalStory('mvrv',nulls,target),null);
  assert.equal(p.signalStory('mvrv',series(2,3).slice(1),target),null);
  assert.match(p.signalStory('exchange_deposit_zat',series(1e8,3e8),target).content,/A deposit is not necessarily a sale\./);
});

function hashes(count=366) {
  return {method:'target-work-v1',window:'7d',points:Array.from({length:count},(_,i)=>({
    date:`${addDays('2026-09-29',i-count+1)}T00:00:00.000Z`,method:'target-work-v1',windowSeconds:604800,
    unavailableReason:null,hashrate:i===count-1?2e10:1e10,
  }))};
}
test('hashrate records require continuous same-method windows and qualified ATH coverage',()=>{
  let h=hashes();const c=p.hashStory(h,{target,genesisComplete:true});
  assert.match(c.content,/^🟨 New all-time high: Zcash hashrate hit/);assert.match(c.content,/The 7-day average is up 100.0% on the previous peak/);
  assert.ok(c.content.length<=280);assert.ok(c.evidence.card.visual.values.length<=91);
  assert.doesNotMatch(p.hashStory(h,{target,genesisComplete:false}).content,/all-time/);
  h.points[0].unavailableReason='missing-targets';assert.doesNotMatch(p.hashStory(h,{target,genesisComplete:true}).content,/all-time/);
  h.points.at(-5).hashrate=null;assert.equal(p.hashStory(h,{target,genesisComplete:true}),null);
  h=hashes();h.points.at(-1).hashrate=1.001e10;assert.equal(p.hashStory(h,{target,genesisComplete:true}),null);
  h=hashes();h.points.at(-1).date='2026-09-28T00:00:00.000Z';assert.equal(p.hashStory(h,{target,genesisComplete:true}),null);
});

test('combined flow allowance preserves exceptional swap capacity without four daily flow posts',()=>{
  const history=[1,2].map(i=>({dedup_key:`old${i}`,post_type:'flow_deshield',status:'posted',created_at:now,metadata:{}}));
  history.push({dedup_key:'oldswap',post_type:'swap',status:'posted',created_at:now,metadata:{slot:'am'}});
  const cs=[['flow_shield','s',{}],['flow_deshield','d',{}],['swap','ordinary',{}],['swap','exceptional',{exceptional:true}]]
    .map(([type,key,evidence])=>({type,key,evidence,score:1}));
  const result=p.select(cs,history,now);
  assert.deepEqual(result.selected.map(c=>c.key),['exceptional']);
  assert.equal(result.skipped.length,3);
  assert.equal(result.skipped.filter(c=>c.reason==='flow-combined-daily-cap').length,2);
  assert.equal(p.select([cs[2]],history,new Date('2026-09-29T12:00:00Z')).selected.length,1);
});

test('cooldowns suppress repeat network topics; held attempts remain deduplicated',()=>{
  const history=[{dedup_key:'old',post_type:'network_signal',status:'posted',created_at:'2026-09-27T12:00:00Z',metadata:{metric:'mvrv'}}];
  const a={type:'network_signal',key:'new',score:1,evidence:{metric:'mvrv'}};
  assert.equal(p.select([a],history,now).selected.length,0);
  assert.equal(p.select([{...a,key:'old'}],[{...history[0],status:'uncertain'}],now).selected.length,0);
});

test('preview does not mutate outbox or invoke any X methods',async()=>{
  const db={query(){throw new Error('unexpected DB write');}};
  const x={dryRun:true,post(){throw new Error('unexpected post');}};
  assert.equal((await publish(db,x,{key:'a',content:'facts'},{logger:log})).status,'preview');
});

test('ambiguous X acceptance is held for reconciliation rather than retried',async()=>{
  const writes=[];
  const db={async query(sql,args){writes.push([sql,args]);return {rows:sql.startsWith('INSERT')?[{id:1}]:[]};}};
  const result=await publish(db,{post:async()=>{throw new Error('timeout');}},{type:'flow_shield',key:'x',content:'facts',evidence:{}},{logger:log});
  assert.equal(result.status,'uncertain');assert.match(writes[1][0],/status='uncertain'/);
});

test('orchestrator retries source failures and never drains stale historical drafts',async()=>{
  const writes=[];
  const client={async query(){return {rows:[{acquired:true}]};},release(){}};
  const pool={async connect(){return client;},async query(sql){writes.push(sql);return {rows:sql.startsWith('SELECT metadata')?[{metadata:{activatedAt:'2026-09-20T00:00:00Z'}}]:[]};}};
  let calls=0;
  const collectors={assertMainnetFresh:async()=>{},liveCandidates:async()=>({candidates:[],decisions:[]}),
    activityCandidates:async()=>{calls++;throw new Error('coverage missing');},hashrateCandidate:async()=>null,
    signalCandidates:async()=>[],crosschainDaily:async()=>null};
  const result=await run(pool,{dryRun:true},{now,collectors,logger:log});
  assert.equal(calls,1);assert.equal(result.selected.length,0);
  assert.equal(writes.filter(s=>s.startsWith('INSERT')).length,0);
  assert.ok(result.decisions.some(d=>d.reason==='source-check-failed'));
});

test('one post per run leaves deferred analysis eligible for a later scan',async()=>{
  const writes=[];
  const client={async query(){return {rows:[{acquired:true}]};},release(){}};
  const pool={connect:async()=>client,async query(sql,args){writes.push([sql,args]);return {rows:sql.startsWith('SELECT metadata')?[{metadata:{activatedAt:'2026-09-20T00:00:00Z'}}]:sql.startsWith('INSERT INTO social_post_outbox\n')?[{id:1}]:[]};}};
  const mk=type=>p.candidate(type,`key:${type}`,'Verified facts',{metric:'mvrv',target,period:{endExclusive:'2026-09-28'}},1);
  const collectors={assertMainnetFresh:async()=>{},liveCandidates:async()=>({candidates:[],decisions:[]}),
    activityCandidates:async()=>[mk('activity_weekly'),mk('activity_daily')],hashrateCandidate:async()=>mk('hashrate'),
    signalCandidates:async()=>[],crosschainDaily:async()=>null};
  let sent=0;
  const result=await run(pool,{post:async()=>{sent++;return {id:'42'};}},{now,collectors,logger:log});
  assert.equal(sent,1);assert.equal(result.results[0].key,'key:activity_weekly');
  const scans=writes.filter(([sql])=>sql.includes("VALUES ('editorial_scan'"));
  assert.ok(!scans.some(([,args])=>args[0].includes(':activity:')||args[0].includes(':hashrate:')));
  assert.ok(result.decisions.some(d=>d.reason==='paced-for-next-run'));
});

test('spacing skips heavy scans but preserves urgent reorg checks',async()=>{
  const client={async query(){return {rows:[{acquired:true}]};},release(){}};
  const pool={connect:async()=>client,query:async(sql)=>({rows:sql.startsWith('SELECT metadata')?[{metadata:{activatedAt:'2026-09-20T00:00:00Z'}}]:[{metadata:{editorialVersion:1},status:'posted',created_at:now}]})};
  let reorgs=0;
  const collectors={assertMainnetFresh:async()=>{},reorgCandidates:async()=>{reorgs++;return [];},
    liveCandidates:async()=>{throw new Error('must not scan');}};
  const result=await run(pool,{dryRun:true},{now,collectors,logger:log});
  assert.equal(reorgs,1);assert.equal(result.candidates.length,0);
});

test('activation cutoff excludes old alerts and drafts, allows new events and reporting periods',()=>{
  const since='2026-09-29T09:00:00Z';
  assert.equal(p.isNew({type:'flow_shield',evidence:{block_time:Date.parse('2026-09-29T08:22:46Z')/1000}},since),false);
  assert.equal(p.isNew({type:'flow_shield',evidence:{block_time:Date.parse('2026-09-29T09:01:00Z')/1000}},since),true);
  assert.equal(p.isNew({type:'activity_weekly',evidence:{period:{endExclusive:'2026-09-28'}}},since),false);
  assert.equal(p.isNew({type:'hashrate',key:'analysis:hashrate:2026-09-28',evidence:{target:'2026-09-28'}},since),false);
  assert.equal(p.isNew({type:'activity_daily',key:'analysis:activity:2026-09-29',evidence:{}},since),true);
});

test('activation watermark is persistent and preview never initializes it',async()=>{
  let row, writes=0;
  const db={async query(sql,args){if(sql.startsWith('INSERT')){writes++;row??={metadata:JSON.parse(args[1])};}return {rows:sql.startsWith('SELECT')&&row?[row]:[]};}};
  assert.equal(await activationTime(db,true,now),now.toISOString());assert.equal(writes,0);
  assert.equal(await activationTime(db,false,now),now.toISOString());
  assert.equal(await activationTime(db,false,new Date('2026-10-01T00:00:00Z')),now.toISOString());
  row={metadata:{activatedAt:'invalid'}};
  await assert.rejects(activationTime(db,false,now),/watermark unavailable/);
});
