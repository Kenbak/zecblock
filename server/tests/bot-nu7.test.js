'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const s = require('../bot/lib/nu7-stories');
const sch = require('../api/lib/network-schedule');
const { select, isNew } = require('../bot/lib/editorial-policy');
const { preparePublication } = require('../bot/lib/editorial-source');
const { renderEditorial } = require('../bot/lib/zecblock-cards');

const H = 3543405;
const T = Date.parse('2026-11-06T00:30:00Z') / 1000;
const at = seconds => new Date(seconds * 1000);
const schedule = { network: 'main', nu7Height: H, eras: [{ height: 0, seconds: 150 }, { height: 653600, seconds: 75 }, { height: H, seconds: 25 }] };
const readiness = { referenceUpgrade: 'NU7', latestProtocol: 170190, latestCount: 285, totalActive: 465, readinessPct: 61.3 };

test('countdown posts once, only while about a day remains, and never claims stale readiness', () => {
  const story = s.countdownStory({ nu7Height: H, tip: { height: H - 1100, timestamp: T - 82500 }, readiness });
  assert.equal(story.key, `nu7:countdown:${H}`);
  assert.match(story.content, /about a day/);
  assert.match(story.content, /1,100 blocks away/);
  assert.match(story.content, /61\.3% of observed nodes already advertise the NU7 protocol/);
  assert.ok(story.content.length <= 280);
  for (const remaining of [1153, 863, 0, -5]) assert.equal(s.countdownStory({ nu7Height: H, tip: { height: H - remaining, timestamp: T }, readiness }), null);
  const legacy = s.countdownStory({ nu7Height: H, tip: { height: H - 1000, timestamp: T }, readiness: { ...readiness, referenceUpgrade: 'NU6.3' } });
  assert.doesNotMatch(legacy.content, /advertise/);
  assert.equal(legacy.evidence.card.visual, null);
});

test('NU7 is live waits for confirmations and is not posted late', () => {
  const block = { height: H, hash: 'a'.repeat(64), timestamp: T };
  const recent = Array.from({ length: 12 }, (_, i) => ({ height: H - 8 + i, timestamp: T - 600 + i * 60 }));
  const live = s.activationStory({ nu7Height: H, block, tip: { height: H + 2, timestamp: T + 60 }, pool: 'ViaBTC', recent, now: at(T + 300) });
  assert.match(live.content, /NU7 is live on Zcash\.\n\nBlock #3,543,405 activated it at 00:30 UTC, mined by ViaBTC/);
  assert.equal(live.evidence.card.visual.kind, 'pulse');
  assert.equal(live.evidence.card.visual.blocks.filter(b => b.nu7).length, 4);
  assert.equal(s.activationStory({ nu7Height: H, block, tip: { height: H + 1, timestamp: T + 30 }, pool: null, recent, now: at(T + 60) }), null, 'two confirmations');
  assert.equal(s.activationStory({ nu7Height: H, block, tip: { height: H + 500, timestamp: T + 13 * 3600 }, pool: null, recent, now: at(T + 13 * 3600) }), null, 'stale');
  assert.doesNotMatch(s.activationStory({ nu7Height: H, block, tip: { height: H + 3, timestamp: T + 90 }, pool: 'Unknown', recent, now: at(T + 120) }).content, /mined by/);
});

test('first day compares measured windows and floors waits', () => {
  const story = s.firstDayStory({ nu7Height: H, activationTime: T, now: at(T + 86400 + 600),
    after: { blocks: 3461, averageSeconds: 24.97 }, before: { blocks: 1152, averageSeconds: 75.06 } });
  assert.match(story.content, /3,461 blocks/);
  assert.match(story.content, /3\.0× the 1,152/);
  assert.match(story.content, /about 4\.1 minutes, not 12\.5 minutes/);
  assert.ok(story.content.length <= 280);
  assert.equal(s.firstDayStory({ nu7Height: H, activationTime: T, now: at(T + 3600), after: { blocks: 9, averageSeconds: 25 }, before: { blocks: 1152, averageSeconds: 75 } }), null, 'day not complete');
  assert.equal(s.firstDayStory({ nu7Height: H, activationTime: T, now: at(T + 3 * 86400), after: { blocks: 3461, averageSeconds: 25 }, before: { blocks: 1152, averageSeconds: 75 } }), null, 'stale');
});

test('block milestones compare the measured time with the old target', () => {
  const crossing = { height: H + 9999, timestamp: T + 250000 };
  const story = s.blockMilestoneStory({ nu7Height: H, tip: { height: H + 10050, timestamp: T + 251000 }, start: { height: H - 1, timestamp: T - 80 },
    crossing, now: at(T + 252000) });
  assert.equal(story.key, 'nu7:blocks:10000');
  assert.match(story.content, /It took 2 days 21 hours\. At the old 75-second target, 10,000 blocks would have taken 8 days 16 hours\./);
  assert.equal(s.blockMilestoneStory({ nu7Height: H, tip: { height: H + 9998, timestamp: T }, start: { timestamp: T }, crossing, now: at(T) }), null);
  // Launch news only: a crossing more than 30 days after activation is not posted.
  const late = { height: H + 99999, timestamp: T + 31 * 86400 };
  assert.equal(s.blockMilestoneStory({ nu7Height: H, tip: { height: H + 100000, timestamp: late.timestamp }, start: { height: H - 1, timestamp: T - 75 },
    crossing: late, now: at(late.timestamp + 60) }), null);
  assert.equal(s.blockMilestoneStory({ nu7Height: H, tip: { height: H + 300000, timestamp: T + 90 * 86400 }, start: { height: H - 1, timestamp: T - 75 },
    crossing: { height: H + 249999, timestamp: T + 89 * 86400 }, now: at(T + 89 * 86400) }), null, 'no level beyond the launch month');
  assert.equal(s.blockMilestoneStory({ nu7Height: H, tip: { height: H + 10050, timestamp: T }, start: { height: H - 1, timestamp: T - 80 }, crossing, now: at(T + 250000 + 90000) }), null, 'stale');
});

test('NSM milestones use exact signed zatoshi and the first crossing', () => {
  const story = s.nsmMilestoneStory({ nu7Height: H, now: at(T + 5000),
    baseline: { height: H - 1, nsmZat: '5' }, current: { height: H + 900, nsmZat: '1000000005' },
    crossing: { height: H + 880, timestamp: T + 4000, nsmZat: '1000000005' },
    daily: [{ date: '2026-11-06', nsmZat: '400000005' }, { date: '2026-11-07', nsmZat: '800000005' }, { date: '2026-11-08', nsmZat: '1000000005' }] });
  assert.equal(story.key, 'nu7:nsm:10');
  assert.equal(story.evidence.growthZat, '1000000000');
  assert.match(story.content, /grew by 10 ZEC/);
  assert.match(story.content, /60% of transaction fees go to the Network Sustainability Mechanism/);
  assert.equal(story.evidence.card.visual.kind, 'series');
  assert.equal(s.nsmMilestoneStory({ nu7Height: H, now: at(T), baseline: { nsmZat: '5' }, current: { height: H, nsmZat: '99999999' }, crossing: { timestamp: T, nsmZat: '99999999' } }), null, 'below 1 ZEC');
  assert.equal(s.nsmMilestoneStory({ nu7Height: H, now: at(T), baseline: { nsmZat: null }, current: { height: H, nsmZat: '1000000000' }, crossing: { timestamp: T, nsmZat: '1000000000' } }), null, 'no baseline');
});

test('halving countdown fires within a day of each threshold with exact subsidy', () => {
  const target = sch.halvingHeight(schedule, sch.halvingIndex(schedule, 3535800) + 1);
  assert.equal(target, 6132390);
  const tipFor = days => {
    let lo = 3535800, hi = target;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sch.targetSeconds(schedule, m, target) / 86400 <= days - 0.5) hi = m; else lo = m + 1; }
    return { height: lo, timestamp: T };
  };
  const story = s.halvingCountdownStory({ schedule, tip: tipFor(100), ...sch });
  assert.equal(story.key, 'halving:6132390:100d');
  assert.equal(story.evidence.beforeZat, '52083333');
  assert.equal(story.evidence.afterZat, '26041666');
  assert.match(story.content, /from 0\.52 to 0\.26 ZEC/);
  assert.equal(s.halvingCountdownStory({ schedule, tip: { height: 3535800, timestamp: T }, ...sch }), null, '~756 days is between thresholds');
});

test('selection: activation outranks routine stories, NU7 milestones share a daily cap, eventAt drives freshness', () => {
  const block = { height: H, hash: 'a'.repeat(64), timestamp: T };
  const live = s.activationStory({ nu7Height: H, block, tip: { height: H + 3, timestamp: T + 90 }, pool: null, recent: [{ height: H, timestamp: T }], now: at(T + 120) });
  assert.equal(isNew(live, at(T - 1).toISOString()), true);
  assert.equal(isNew(live, at(T + 1).toISOString()), false);
  const routine = { type: 'activity_daily', key: 'analysis:activity:2026-11-05', content: 'x', evidence: { editorial: { significance: 99 } } };
  assert.equal(select([routine, live], [], at(T + 120)).selected[0].key, live.key);
  const now = at(T + 3 * 86400);
  const history = ['nu7:blocks:10000', 'nu7:nsm:1'].map(key => ({ post_type: 'nu7', dedup_key: key, status: 'posted', created_at: now.toISOString(), metadata: { nu7Kind: key.split(':')[1] } }));
  const nsm = { type: 'nu7', key: 'nu7:nsm:10', content: 'x', evidence: { nu7Kind: 'nsm', editorial: { topic: 'nu7:nsm', significance: 78 } } };
  assert.deepEqual(select([nsm], history, now).skipped, [{ key: 'nu7:nsm:10', reason: 'nu7-daily-cap' }]);
});

test('NU7 publications carry a scoped source reply and render cards', async () => {
  const block = { height: H, hash: 'a'.repeat(64), timestamp: T };
  const recent = Array.from({ length: 80 }, (_, i) => ({ height: H - 70 + i, timestamp: T - 70 * 75 + i * (i < 70 ? 75 : 25) }));
  const live = s.activationStory({ nu7Height: H, block, tip: { height: H + 9, timestamp: T + 250 }, pool: 'ViaBTC', recent, now: at(T + 300) });
  const publication = preparePublication(live);
  assert.match(publication.sourceReply.content, /zecblock\.com\/block\/3543405/);
  assert.match(publication.sourceReply.content, /Serving-node NU7 schedule/);
  for (const story of [live, s.countdownStory({ nu7Height: H, tip: { height: H - 1000, timestamp: T }, readiness })]) {
    const file = await renderEditorial(story);
    assert.ok(fs.statSync(file).size > 10000);
    fs.unlinkSync(file);
  }
});

test('NU7 reader: node schedule, canonical joins, exact NSM and countdown readiness on real PostgreSQL', {
  skip: process.env.ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_ACTIVITY_DATABASE_URL,
}, async t => {
  const { Client } = require('pg');
  const { nu7Candidates } = require('../bot/lib/nu7-source');
  const db = new Client(process.env.TEST_ACTIVITY_DATABASE_URL ? { connectionString: process.env.TEST_ACTIVITY_DATABASE_URL } : { host: '/tmp', database: 'postgres' });
  await db.connect();
  t.after(async () => { await db.query('ROLLBACK'); await db.end(); });
  const h = H, first = H - 1200, t0 = T - 1200 * 75;
  const upgrades = JSON.stringify({ '2bb40e60': { name: 'Blossom', activationheight: 653600, status: 'active' },
    '77190ad9': { name: 'NU7', activationheight: h, status: 'pending' } });
  await db.query(`BEGIN;
    CREATE TEMP TABLE blocks(height bigint PRIMARY KEY, hash text, timestamp bigint, miner_address text, coinbase_hex text);
    CREATE TEMP TABLE node_accounting_observations(hash text PRIMARY KEY, height bigint, observed_at timestamptz, chain text,
      nsm_balance_zat bigint, upgrades jsonb);
    CREATE TEMP TABLE nodes(protocol_version integer, is_active boolean);
    INSERT INTO nodes SELECT CASE WHEN i < 6 THEN 170190 ELSE 170160 END, i <> 9 FROM generate_series(0, 9) i;`);
  // Recent canonical history only: every query is bounded by height.
  const fill = async (tip, nsmPerBlock) => {
    await db.query('TRUNCATE blocks, node_accounting_observations');
    await db.query(`INSERT INTO blocks SELECT i, md5(i::text),
        $3::bigint + LEAST(i - $2, $4 - $2) * 75 + GREATEST(i - $4, 0) * 25, 't1test', NULL
      FROM generate_series($2::bigint, $1::bigint) i`, [tip, first, t0, h]);
    await db.query(`INSERT INTO node_accounting_observations SELECT md5(i::text), i, now(), 'main',
        7 + $3::bigint * GREATEST(i - $4 + 1, 0), $5::jsonb FROM generate_series($2::bigint, $1::bigint) i`, [tip, first, nsmPerBlock, h, upgrades]);
    // An orphaned observation with a huge balance must never be read.
    await db.query(`INSERT INTO node_accounting_observations VALUES (md5('orphan'), $1, now(), 'main', 999999999999, $2::jsonb)`, [tip, upgrades]);
  };
  await fill(h - 1000, '0');
  let result = await nu7Candidates(db, at(t0 + 200 * 75 + 60));
  assert.deepEqual(result.candidates.map(c => c.key), [`nu7:countdown:${h}`]);
  assert.match(result.candidates[0].content, /66\.7% of observed nodes/, '6 of 9 active nodes');

  await fill(h + 4, '50000000');
  const tipTime = t0 + 1200 * 75 + 4 * 25;
  result = await nu7Candidates(db, at(tipTime + 30));
  const keys = result.candidates.map(c => c.key);
  assert.ok(keys.includes(`nu7:activation:${h}`));
  assert.ok(keys.includes('nu7:nsm:1'), 'five blocks × 0.5 ZEC crosses 1 ZEC');
  const nsm = result.candidates.find(c => c.key === 'nu7:nsm:1');
  assert.equal(nsm.evidence.growthZat, '250000000');
  assert.equal(nsm.evidence.crossing.height, h + 1);
});
