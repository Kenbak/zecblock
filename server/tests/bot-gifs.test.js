'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const policy = require('../bot/lib/editorial-policy');
const landing = require('../bot/lib/landing-gif');
const heat = require('../bot/lib/heatmap-gif');
const quiet = { info() {}, warn() {}, error() {} };

const swap = (extra = {}) => policy.swapStory({ id: '1', venue: 'near', source_chain: 'zec', dest_chain: 'eth', source_amount_usd: '198405',
  sample_count: '24490', greater_count: '192', equal_count: '0', swap_created_at: '2026-11-12T18:05:51.848Z', zec_txid: 'a'.repeat(64), ...extra });
const flow = (extra = {}) => policy.flowStory({ txid: 'b'.repeat(64), flow_type: 'deshield', pool: 'ironwood', amount_zat: String(12000e8),
  sample_count: '5000', greater_count: '3', equal_count: '0', block_time: 1794500000, price_usd: '960', ...extra });

test('landing model: log bins on a USD or ZEC axis, rank label from the story', () => {
  const s = swap();
  const m = landing.landingModel(s, { bins: [{ bin: 0, n: 24000 }, { bin: 42, n: 489 }, { bin: 50, n: 1 }], total: 24490 });
  assert.equal(m.lo, 0); assert.equal(m.hi, 7);
  assert.equal(m.counts.length, 56); assert.equal(m.counts[42], 489);
  assert.equal(m.label, 'Top 0.79%'); assert.equal(m.sub, '192 were bigger');
  assert.equal(m.counter, 'NEAR Intents ZEC swaps · last 30 days');
  assert.deepEqual(m.ticks.map(t => t.label), ['$1', '$100', '$10K', '$1M']);
  assert.deepEqual(m.route, { from: 'zec', to: 'eth' });

  const f = flow();
  // Bins far below the eight-decade window merge into the first bar instead of vanishing.
  const fm = landing.landingModel(f, { bins: [{ bin: -64, n: 10 }, { bin: 0, n: 4990 }], total: 5000 });
  assert.equal(fm.hi - fm.lo, 8); assert.equal(fm.counts[0], 10);
  assert.equal(fm.counts.reduce((a, b) => a + b, 0), 5000);
  assert.equal(fm.counter, 'deshielding transactions · last 90 days');
  assert.match(fm.ticks.at(-1).label, / ZEC$/);
  assert.equal(fm.route, null);

  const largest = landing.landingModel(swap({ greater_count: '0', sample_count: '500' }), { bins: [{ bin: 16, n: 500 }], total: 500 });
  assert.equal(largest.label, 'Largest in 30 days'); assert.equal(largest.sub, null);
  const tie = landing.landingModel(flow({ greater_count: '1', equal_count: '2' }), { bins: [{ bin: 0, n: 5000 }], total: 5000 });
  assert.equal(tie.sub, '3 were as big or bigger');
});

test('the histogram must be exactly the ranking sample, or there is no GIF', async () => {
  const calls = [];
  const db = rows => ({ query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } });
  const near = await landing.loadDistribution(db([{ bin: 16, n: 24000 }, { bin: 42, n: 490 }]), swap());
  assert.equal(near.total, 24490);
  assert.match(calls[0].sql, /FROM cross_chain_swaps/); assert.deepEqual(calls[0].params, ['2026-11-12T18:05:51.848Z']);
  await assert.rejects(landing.loadDistribution(db([{ bin: 16, n: 10 }]), swap()), /ranked against 24490/);
  await landing.loadDistribution(db([{ bin: 16, n: 24490 }]), swap({ venue: 'maya', direction: 'outflow', canonical_identity: 'x', partial_return: false,
    zec_legs: [{ txid: 'c'.repeat(64), side: 'in' }] }));
  assert.match(calls.at(-1).sql, /FROM crosschain_venue_actions/); assert.equal(calls.at(-1).params[1], 'maya');
  await landing.loadDistribution(db([{ bin: 0, n: 5000 }]), flow());
  assert.deepEqual(calls.at(-1).params, ['deshield', 1794500000]);
  assert.equal(landing.landingKind({ type: 'hashrate' }), null);
});

test('media hook: GIF for swaps and flows, still card otherwise or on failure; heatmap has no still', async () => {
  const made = [];
  const still = async story => { made.push(['still', story.key]); return '/tmp/still.png'; };
  const gif = async (_story, _dist, file) => { made.push(['gif']); fs.writeFileSync(file, 'GIF89a'); };
  const load = async () => ({ bins: [], total: 0 });
  const media = landing.storyMedia({ reader: {}, still, gif, load, logger: quiet, heatmap: async (_s, file) => { fs.writeFileSync(file, 'GIF89a'); } });
  const file = await media(swap());
  assert.match(file, /zecblock-landing-.*\.gif$/); fs.unlinkSync(file);
  assert.equal(await media({ type: 'hashrate', key: 'h', evidence: {} }), '/tmp/still.png');
  const failing = landing.storyMedia({ reader: {}, still, load, logger: quiet, gif: async () => { throw new Error('ffmpeg missing'); } });
  assert.equal(await failing(flow()), '/tmp/still.png', 'a failed GIF falls back to the still card');
  const noReader = landing.storyMedia({ still, gif, load, logger: quiet });
  assert.equal(await noReader(swap()), '/tmp/still.png');
  const heatmapStory = policy.heatmapStory({ start: '2026-11-09', endExclusive: '2026-11-16', slots: [{ slot: 5, zat: '100000000', n: 1 }] });
  const heatFile = await media(heatmapStory);
  assert.match(heatFile, /zecblock-heatmap-.*\.gif$/); fs.unlinkSync(heatFile);
  const brokenHeat = landing.storyMedia({ still, logger: quiet, heatmap: async () => { throw new Error('no ffmpeg'); } });
  await assert.rejects(brokenHeat(heatmapStory), /no ffmpeg/, 'no still card exists for a heatmap: the post goes out as text');
});

test('weekly heatmap story: busiest hour, exact totals, Monday-based week, one key per week', () => {
  const slots = [{ slot: 0, zat: '150000000', n: 2 }, { slot: 142, zat: '5069031220117', n: 32 }, { slot: 167, zat: '1', n: 1 }];
  const s = policy.heatmapStory({ start: '2026-11-09', endExclusive: '2026-11-16', slots });
  assert.equal(s.type, 'shield_heatmap'); assert.equal(s.key, 'analysis:shield_heatmap:2026-11-09');
  assert.equal(s.evidence.busiest, 142); assert.equal(s.evidence.totalZat, '5069181220118'); assert.equal(s.evidence.transactions, 35);
  assert.equal(s.evidence.card.hero, 'Sat 22:00');
  assert.match(s.content, /Busiest hour: Saturday 22:00 UTC, with 50,690.31 ZEC\. 50,691.81 ZEC was shielded in total across 35 transactions\./);
  assert.ok(s.content.length <= 280);
  assert.equal(policy.eventTime(s), Date.parse('2026-11-16T06:00:00Z'));
  assert.equal(policy.heatmapStory({ start: '2026-11-10', endExclusive: '2026-11-17', slots }), null, 'weeks start on Monday');
  assert.equal(policy.heatmapStory({ start: '2026-11-09', endExclusive: '2026-11-16', slots: [] }), null);
  assert.equal(policy.heatmapStory({ start: '2026-11-09', endExclusive: '2026-11-16', slots: [{ slot: 168, zat: '1', n: 1 }] }), null);
  assert.equal(policy.heatmapStory({ start: '2026-11-09', endExclusive: '2026-11-16', slots: [{ slot: 1, zat: '1.5', n: 1 }] }), null);
});

test('heatmap shading: one huge hour does not black out the rest', () => {
  const cells = Array(168).fill('100000000'); cells[142] = String(50000e8); cells[3] = '0';
  const level = heat.shades(cells);
  assert.equal(level[142], 1); assert.equal(level[3], 0);
  assert.ok(level[0] > 0.9, 'ordinary hours stay visible');
  assert.throws(() => heat.shades(Array(168).fill('0')), /no shielding/);
  assert.throws(() => heat.shades(['1']), /168/);
  const a = heat.cellRect(0), b = heat.cellRect(167);
  assert.ok(b.x > a.x && b.y > a.y);
});

test('PostgreSQL: landing histograms equal the ranking samples; heatmap needs a fully indexed week', { skip: process.env.ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_ACTIVITY_DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const data = require('../bot/lib/editorial-data');
  const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
  const admin = new Pool(connection ? { connectionString: connection } : { host: '/tmp', database: 'postgres' });
  const name = `bot_gif_test_${process.pid}_${Date.now()}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = connection ? new URL(connection) : null; if (url) url.pathname = `/${name}`;
    db = new Pool({ ...url ? { connectionString: url.toString() } : { host: '/tmp', database: name }, max: 4, options: '-c timezone=Asia/Tokyo' });
    await db.query(`CREATE TABLE blocks(height bigint PRIMARY KEY,hash text,timestamp bigint,total_fees bigint,transaction_count integer);
      CREATE TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_time bigint,is_coinbase boolean DEFAULT false,
        vin_count integer DEFAULT 1,vout_count integer DEFAULT 0,value_balance_sapling bigint DEFAULT 0,
        value_balance_orchard bigint DEFAULT 0,value_balance_ironwood bigint DEFAULT 0);
      CREATE TABLE shielded_flows(txid text,block_height bigint,block_time bigint,flow_type text,amount_zat bigint,pool text);
      CREATE TABLE cross_chain_swaps(id integer,source_chain text,dest_chain text,source_amount_usd numeric,zec_txid text,status text,swap_created_at timestamptz);
      CREATE TABLE sync_state(job_name text,updated_at timestamptz);
      CREATE TABLE fork_events(id integer,depth integer,fork_height bigint,detected_at timestamptz);
      INSERT INTO blocks SELECT i,md5(i::text),extract(epoch FROM timestamptz '2026-09-29T06:00:00Z'),100,1 FROM generate_series(0,400) i;
      UPDATE blocks SET timestamp=extract(epoch FROM timestamptz '2026-09-29T07:50:00Z') WHERE height=400;
      INSERT INTO transactions(txid,block_height,block_time,value_balance_ironwood)
        SELECT repeat('0',32)||md5(i::text),i,timestamp,CASE WHEN i=400 THEN -89999975000 WHEN i<200 THEN -100000000 ELSE 1000000000000 END FROM blocks b CROSS JOIN LATERAL (SELECT b.height AS i) q;
      INSERT INTO shielded_flows SELECT txid,block_height,block_time,CASE WHEN value_balance_ironwood<0 THEN 'shield' ELSE 'deshield' END,abs(value_balance_ironwood),'ironwood' FROM transactions;
      INSERT INTO cross_chain_swaps SELECT i,'sol','zec',CASE WHEN i=2000 THEN 2000000 ELSE 100 END,repeat('b',64),'SUCCESS',
        CASE WHEN i=2000 THEN timestamptz '2026-09-29T07:55:00Z' ELSE timestamptz '2026-09-28T20:00:00Z' END FROM generate_series(0,2000) i;
      INSERT INTO cross_chain_swaps VALUES (2001,'zec','eth',200,repeat('c',64),'SUCCESS','2026-09-28T23:59:59Z');
      INSERT INTO sync_state VALUES('crosschain_swaps','2026-09-29T08:00:00Z');
      -- A completed week (Mon Sep 21 - Sun Sep 27): one small shield a day at 13:30 UTC, Saturday's largest (below the ranked flow).
      INSERT INTO blocks SELECT d-7,md5('w'||d),extract(epoch FROM timestamptz '2026-09-21T13:30:00Z')+d*86400,1,1 FROM generate_series(0,6) d;
      INSERT INTO transactions(txid,block_height,block_time,value_balance_orchard)
        SELECT md5('wt'||d)||md5('x'||d),d-7,extract(epoch FROM timestamptz '2026-09-21T13:30:00Z')+d*86400,CASE WHEN d=5 THEN -500000000 ELSE -100000000 END FROM generate_series(0,6) d;
      INSERT INTO shielded_flows SELECT txid,block_height,block_time,'shield',-value_balance_orchard,'orchard' FROM transactions WHERE block_height<0;`);
    const now = new Date('2026-09-29T08:00:00Z');
    const wrap = client => ({ query: (sql, args) => client.query(sql.replace('current_database() AS name', "'zcash_explorer_mainnet' AS name"), args), release: () => client.release() });
    const reader = { connect: async () => wrap(await db.connect()) };
    const live = await data.liveCandidates(reader, now, { fetchPrice: async () => ({ quote: null, unavailable: 'test' }) });
    const flowStory = live.candidates.find(c => c.type === 'flow_shield');
    const swapStory = live.candidates.find(c => c.type === 'swap');
    assert.ok(flowStory && swapStory);
    const flowDist = await landing.loadDistribution(db, flowStory);
    assert.equal(flowDist.total, Number(flowStory.evidence.sample_count));
    const swapDist = await landing.loadDistribution(db, swapStory);
    assert.equal(swapDist.total, Number(swapStory.evidence.sample_count));
    assert.deepEqual(swapDist.bins, [{ bin: 16, n: 2000 }, { bin: 18, n: 1 }], '$100 and $200 swaps land in their log bins');

    const [heatmap] = await data.heatmapCandidates(reader, now);
    assert.equal(heatmap.key, 'analysis:shield_heatmap:2026-09-21');
    assert.equal(heatmap.evidence.busiest, 5 * 24 + 13);
    assert.equal(heatmap.evidence.totalZat, String(500000000 + 6 * 100000000));
    // One block's transactions missing: the week is incomplete and nothing is claimed.
    await db.query('UPDATE blocks SET transaction_count=2 WHERE height=-4');
    const incomplete = await data.heatmapCandidates(reader, now);
    assert.deepEqual(incomplete.candidates, []); assert.equal(incomplete.decisions[0].reason, 'week-incomplete');
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end();
  }
});
