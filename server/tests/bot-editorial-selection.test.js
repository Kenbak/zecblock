'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../bot/lib/editorial-policy');
const { addDays } = require('../lib/transaction-activity');
const { insightFixtures } = require('../bot/lib/editorial-insights');

const target = '2026-10-25';
const now = new Date('2026-10-26T08:00:00Z');
const days = (latest = {}) => Array.from({ length: 31 }, (_, i) => ({
  date: addDays(target, i - 30), shielded: 5000, transparent: 5000, fully_shielded: 4000,
  ...(i === 30 ? latest : {}),
}));
const values = (before, value) => days().map((row, i) => ({ date: row.date, value: i === 30 ? value : before }));
const flow = (key = 'a', extra = {}) => p.flowStory({ flow_type: 'shield', amount_zat: 900e8,
  sample_count: 10000, greater_count: 4, equal_count: 2, pool: 'ironwood', txid: key.repeat(64), ...extra });
const posted = (story, at, status = 'posted') => ({ post_type: story.type, dedup_key: story.key,
  metadata: story.evidence, status, created_at: at });

test('standalone daily activity stays quiet on unchanged or immaterial new records', () => {
  assert.equal(p.dailyActivity({ days: days() }, target), null);
  assert.equal(p.dailyActivity({ days: days({ shielded: 5001, transparent: 4999 }) }, target), null);
  assert.equal(p.dailyActivity({ days: days({ shielded: 5100, transparent: 4900 }) }, target), null);
  assert.equal(p.select([], [], now).selected.length, 0);
});

test('material bounded records lead with the finding and retain exact units and dates', () => {
  const story = p.dailyActivity({ days: days({ shielded: 3000, transparent: 7000 }) }, target);
  assert.equal(story.evidence.metric, 'share');
  assert.match(story.content, /shielded transaction share hit a 31-day low/);
  assert.match(story.content, /30.0% on Oct 25, 20.0 percentage points below the 30-day average \(50.0%\)/);
  assert.equal(story.evidence.card.visual.unit, '%');
  assert.deepEqual(story.evidence.card.visual.scale, { min: 0, max: 100 });
  assert.equal(story.evidence.card.visual.start, '2026-09-25');
  assert.equal(story.evidence.card.visual.end, target);
  assert.equal(story.evidence.editorial.lens, 'record_low');
  assert.doesNotMatch(story.content, /all-time|users|adoption/);
});

test('a strong network finding beats an ordinary large transfer on a common significance scale', () => {
  const ordinary = flow();
  const signal = p.signalStory('daily_fees_zat', values(1e8, 20e8), target);
  // The old raw score was denominated in ZEC for flows and sigma for signals.
  assert.ok(ordinary.score > signal.score);
  const result = p.select([ordinary, signal], [], now);
  assert.equal(result.selected[0].type, 'network_signal');
  assert.ok(result.selected[0].evidence.editorialSelection.significance
    > ordinary.evidence.editorialSelection.significance);
  assert.ok(result.selected.every(s => Number.isFinite(s.evidence.editorialSelection.score)));
});

test('urgent reorgs and exceptional swaps and flows keep protected capacity', () => {
  const reorg = p.reorgStory({ id: 1, depth: 2, fork_height: 3530000, detected_at: now.toISOString() });
  const exceptionalSwap = p.swapStory({ id: 1, source_amount_usd: 2000000, sample_count: 10000,
    greater_count: 0, equal_count: 0, source_chain: 'sol', dest_chain: 'zec' });
  const exceptional = flow('b', { amount_zat: 50000e8, greater_count: 0, equal_count: 0 });
  const old = flow('c');
  const history = [posted(old, '2026-10-26T07:30:00Z'), {
    post_type: 'swap', dedup_key: 'ordinary-am', status: 'posted', created_at: '2026-10-26T07:50:00Z', metadata: { slot: 'am' },
  }];
  const result = p.select([exceptional, exceptionalSwap, reorg], history, now);
  assert.deepEqual(result.selected.map(s => s.type), ['reorg', 'swap', 'flow_shield']);
  assert.ok(result.selected.every(s => s.evidence.editorialSelection.noveltyPenalty === 0));
});

test('money-movement family repetition can yield to a fresh analytical topic', () => {
  const ordinary = flow();
  const briefing = p.candidate('network_briefing', 'weekly', 'Synthetic verified briefing.', {
    editorial: { topic: 'network', lens: 'weekly_briefing', significance: 50 }, target,
  });
  assert.equal(p.select([ordinary, briefing], [], now).selected[0].type, 'flow_shield');
  const history = [{ post_type: 'swap', dedup_key: 'recent-swap', status: 'posted', created_at: '2026-10-26T07:30:00Z', metadata: {} }];
  const result = p.select([ordinary, briefing], history, now);
  assert.equal(result.selected[0].type, 'network_briefing');
  assert.equal(ordinary.evidence.editorialSelection.noveltyPenalty, 10);
});

test('the two-per-day direct-flow cap combines directions and counts held delivery attempts', () => {
  const history = [posted(flow('b'), '2026-10-26T00:00:00Z', 'posting'),
    posted(flow('c', { flow_type: 'deshield' }), '2026-10-26T01:00:00Z', 'uncertain')];
  const result = p.select([flow('d'), flow('e', { flow_type: 'deshield' })], history, now);
  assert.equal(result.selected.length, 0);
  assert.deepEqual(result.skipped.map(s => s.reason), ['flow-combined-daily-cap', 'flow-combined-daily-cap']);
  assert.equal(p.select([flow('f')], history, new Date('2026-10-27T08:00:00Z')).selected.length, 1);
});

test('an ordinary consecutive flow waits six hours even when there is no filler story', () => {
  const history = [posted(flow('b', { flow_type: 'deshield' }), '2026-10-26T07:00:00Z')];
  const result = p.select([flow()], history, now);
  assert.equal(result.selected.length, 0);
  assert.equal(result.skipped[0].reason, 'recent-flow-topic');
  assert.equal(p.select([flow()], history, new Date('2026-10-26T13:00:00Z')).selected.length, 1);
});

test('source replies cannot change editorial diversity, caps or headline deduplication', () => {
  const story = flow();
  const reply = { post_type: 'source_reply', dedup_key: story.key, status: 'posted', created_at: '2026-10-26T07:59:00Z',
    metadata: { deliveryRole: 'source_reply' } };
  assert.equal(p.select([story], [reply], now).selected[0].key, story.key);
  assert.equal(story.evidence.editorialSelection.noveltyPenalty, 0);
  const disguised = { ...reply, post_type: 'flow_shield' };
  assert.equal(p.select([flow()], [disguised], now).selected.length, 1);
});

test('routine cross-chain summaries need comparative evidence before standalone publication', () => {
  const summary = p.crosschainStory({ inflow: '2000000', outflow: '3000000', largest: '1500000', top_route: 'zec -> sol' }, target);
  assert.equal(p.select([summary], [], now).skipped[0].reason, 'routine-summary-without-comparison');
  summary.evidence.stats = {};
  assert.equal(p.select([summary], [], now).selected.length, 0);
  summary.evidence.stats = { changePct: 0, high: false, low: false };
  assert.equal(p.select([summary], [], now).selected.length, 0);
});

test('pool-trend cooldown uses exact net zatoshis and permits a material new observation', () => {
  const trend = insightFixtures().find(s => s.type === 'pool_trend');
  const history = [posted(trend, '2026-10-25T08:00:00Z')];
  const next = structuredClone(trend);
  next.key += ':next-date';
  assert.equal(p.select([next], history, now).skipped[0].reason, 'three-day-trend-cooldown');
  next.evidence.totals.netZat = (BigInt(trend.evidence.totals.netZat) * 125n / 100n).toString();
  assert.equal(p.select([next], history, now).selected.length, 1);
  const held = [posted(next, '2026-10-26T07:00:00Z', 'uncertain')];
  assert.equal(p.select([next], held, now).skipped[0].reason, 'duplicate-or-held');
});

test('a simulated seven-day candidate feed selects different verified story families and permits a quiet day', () => {
  const history = [], feed = [];
  const fixtures = insightFixtures();
  const signal = p.signalStory('daily_fees_zat', values(1e8, 20e8), target);
  const significantDaily = p.dailyActivity({ days: days({ shielded: 9000, transparent: 1000 }) }, target);
  const candidates = [
    [fixtures.find(s => s.type === 'network_briefing')],
    [fixtures.find(s => s.type === 'pool_trend')],
    [signal],
    [p.candidate('milestone', 'milestone:pool-parity', 'Synthetic first parity milestone.', { lead: 'parity:365:100' })],
    [significantDaily],
    [],
    [],
  ];
  for (let i = 0; i < 7; i++) {
    const at = new Date(now.getTime() + i * 86400000);
    const proposals = [...candidates[i], ...(i < 6 ? [flow(String.fromCharCode(97 + i))] : [])];
    const selected = p.select(proposals, history, at).selected[0];
    if (selected) { feed.push(selected.type); history.push(posted(selected, at)); }
  }
  assert.deepEqual(feed, ['network_briefing', 'pool_trend', 'network_signal', 'milestone', 'activity_daily', 'flow_shield']);
  assert.equal(feed.length, 6);
});

test('malformed percentile samples fail closed rather than producing a rarity claim', () => {
  assert.equal(flow('a', { sample_count: 'bad' }), null);
  assert.equal(flow('a', { greater_count: -1 }), null);
  assert.equal(flow('a', { equal_count: 10001 }), null);
  assert.equal(p.swapStory({ id: 1, source_amount_usd: 2000000, sample_count: 'bad',
    greater_count: 0, equal_count: 0, source_chain: 'sol', dest_chain: 'zec' }), null);
});
