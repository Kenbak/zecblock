'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays } = require('../lib/transaction-activity');
const { poolMilestoneStories } = require('../bot/lib/pool-activity-milestones');
const { candidate, eventTime, isNew } = require('../bot/lib/editorial-policy');
const { run } = require('../bot/jobs/editorial');

const launch = '2026-07-28';
const historyStart = addDays(launch, -365);
const dayNumber = date => (Date.parse(date) - Date.parse(launch)) / 86400000;

function activity(target, counts = () => ({})) {
  const endExclusive = addDays(target, 1);
  const length = (Date.parse(endExclusive) - Date.parse(historyStart)) / 86400000;
  return {
    historyStart,
    capturedAt: `${endExclusive}T08:00:00.000Z`,
    activation: { height: 3428143, timestamp: Date.parse(`${launch}T12:00:00Z`) / 1000, date: launch },
    tip: { height: 3600000, hash: 'a'.repeat(64), timestamp: Date.parse(`${endExclusive}T07:59:00Z`) / 1000 },
    days: Array.from({ length }, (_, i) => {
      const date = addDays(historyStart, i), sinceLaunch = dayNumber(date);
      return { date, totalTransactions: 10000, orchard: 1000, ironwood: 0, complete: true,
        ...counts(sinceLaunch, date) };
    }),
  };
}

const achievements = stories => stories.flatMap(story => story.evidence.achievements);
const ofKind = (stories, kind) => achievements(stories).filter(a => a.kind === kind);
const visualValues = visual => visual.kind === 'comparison' ? visual.series.flatMap(s => s.values) : visual.values;

test('leadership requires a strictly greater complete seven-day or thirty-day count', () => {
  for (const periodDays of [7, 30]) {
    const target = addDays(launch, periodDays);
    const tied = activity(target, i => i > 0 ? { orchard: 100, ironwood: 100 } : {});
    assert.equal(ofKind(poolMilestoneStories(tied, target), 'leadership').length, 0);
    tied.days.at(-1).ironwood = 107;
    const match = ofKind(poolMilestoneStories(tied, target), 'leadership').find(a => a.periodDays === periodDays);
    assert.ok(match, `first ${periodDays}-day lead is missing`);
    assert.equal(match.ironwood, periodDays * 100 + 7);
    assert.equal(match.orchard, periodDays * 100);
    assert.deepEqual(match.period, { start: addDays(target, 1 - periodDays), endExclusive: addDays(target, 1) });
  }
});

test('the partial activation day cannot fill a complete post-activation week', () => {
  const target = addDays(launch, 6);
  const rows = activity(target, i => i === 0 ? { totalTransactions: 100000, ironwood: 100000 } : {});
  const stories = poolMilestoneStories(rows, target);
  assert.equal(ofKind(stories, 'leadership').length, 0);
  assert.equal(ofKind(stories, 'share').length, 0);
});

test('a prior seven-day lead suppresses a later recrossing', () => {
  const target = addDays(launch, 30);
  const rows = activity(target, i => i > 0 ? {
    orchard: 100, ironwood: i <= 7 || i >= 24 ? 200 : 0,
  } : {});
  assert.deepEqual(poolMilestoneStories(rows, target), []);
});

test('trailing-year parity is measured in the same 365 dates and equality reaches 100 percent', () => {
  const target = launch;
  const rows = activity(target, i => i === 0 ? { totalTransactions: 500000, ironwood: 365000 } : {});
  const stories = poolMilestoneStories(rows, target);
  const parity = ofKind(stories, 'parity').find(a => a.level === 100);
  assert.ok(parity);
  assert.equal(parity.periodDays, 365);
  assert.equal(parity.ironwood, 365000);
  assert.equal(parity.orchard, 365000);
  assert.deepEqual(parity.period, { start: addDays(target, -364), endExclusive: addDays(target, 1) });
  assert.match(stories[0].content, /365|year/i);
  assert.doesNotMatch(stories[0].content, /Orchard.?s lifetime|lifetime.*Orchard/i);
});

test('95 percent of a trailing year is distinct from a lifetime or transaction-rate comparison', () => {
  const target = addDays(launch, 1);
  const rows = activity(target, i => i === 1 ? { totalTransactions: 500000, ironwood: 346750 } : {});
  const parity = ofKind(poolMilestoneStories(rows, target), 'parity');
  assert.deepEqual(parity.map(a => a.level).sort((a, b) => a - b), [90, 95]);
  assert.equal(parity.find(a => a.level === 95).orchard, 365000);
  assert.equal(parity.find(a => a.level === 95).ironwood, 346750);
});

test('a zero Orchard comparison and zero transaction denominator do not create percentage claims', () => {
  const rows = activity(launch, () => ({ totalTransactions: 0, orchard: 0, ironwood: 0 }));
  assert.deepEqual(poolMilestoneStories(rows, launch), []);
  rows.days.at(-1).totalTransactions = 1;
  rows.days.at(-1).ironwood = 1;
  assert.equal(ofKind(poolMilestoneStories(rows, launch), 'parity').length, 0);
});

test('lifetime landmarks include the activation day and never re-emit an old level', () => {
  const target = addDays(launch, 1);
  const rows = activity(target, i => ({ totalTransactions: 2000000, ironwood: i === 0 ? 999999 : i === 1 ? 1 : 0 }));
  const volume = ofKind(poolMilestoneStories(rows, target), 'volume');
  assert.deepEqual(volume.map(a => a.level), [1000000]);
  assert.equal(volume[0].ironwood, 1000000);
  assert.deepEqual(volume[0].period, { start: launch, endExclusive: addDays(target, 1) });
  const next = addDays(target, 1);
  const later = activity(next, i => ({ totalTransactions: 2000000, ironwood: i === 0 ? 999999 : i === 1 || i === 2 ? 1 : 0 }));
  assert.deepEqual(poolMilestoneStories(later, next), []);
});

test('pool overlap is valid and share uses all unique non-coinbase transactions', () => {
  const target = addDays(launch, 7);
  const rows = activity(target, i => i > 0 ? {
    totalTransactions: 1000, orchard: 1000, ironwood: i === 7 ? 560 : 490,
  } : {});
  const share = ofKind(poolMilestoneStories(rows, target), 'share').find(a => a.level === 50);
  assert.ok(share);
  assert.equal(share.ironwood, 3500);
  assert.equal(share.totalTransactions, 7000);
  assert.deepEqual(share.period, { start: addDays(launch, 1), endExclusive: addDays(target, 1) });
});

test('weekly share divides total counts rather than averaging daily percentages', () => {
  const target = addDays(launch, 7);
  const rows = activity(target, i => i > 0 ? {
    orchard: 0, totalTransactions: i === 7 ? 10000 : 100, ironwood: i === 7 ? 10 : 100,
  } : {});
  assert.equal(ofKind(poolMilestoneStories(rows, target), 'share').length, 0);
});

test('simultaneous first crossings become one bounded attributed story retaining exact evidence', () => {
  const target = addDays(launch, 30);
  const rows = activity(target, i => i > 0 ? {
    totalTransactions: 2000000, orchard: 100, ironwood: i === 30 ? 1000000 : 0,
  } : {});
  const stories = poolMilestoneStories(rows, target);
  assert.equal(stories.length, 1);
  const story = stories[0];
  assert.equal(story.type, 'milestone');
  assert.equal(story.key, `milestone:pool_activity:${story.evidence.lead}`);
  assert.equal(story.evidence.target, target);
  assert.ok(new Set(story.evidence.achievements.map(a => a.kind)).size >= 3);
  assert.equal(new Set(story.evidence.achievements.map(a => a.id)).size, story.evidence.achievements.length);
  assert.ok(story.content.length <= 280);
  assert.ok(story.content.endsWith('https://zecblock.com/pools'));
  assert.equal(story.evidence.card.source, 'zecblock.com/pools');
  assert.equal(story.evidence.card.visual.kind, 'comparison');
  assert.ok(story.evidence.card.visual.series.every(s => s.values.length > 1));
  assert.ok(visualValues(story.evidence.card.visual).every(Number.isFinite));
  assert.equal(story.evidence.activation.height, 3428143);
  assert.equal(story.evidence.capturedAt, rows.capturedAt);
  assert.deepEqual(story.evidence.tip, rows.tip);
  assert.equal(eventTime(story), Date.parse(`${addDays(target, 1)}T06:00:00Z`));
  assert.equal(isNew(story, `${addDays(target, 1)}T06:00:00Z`), true);
  assert.equal(isNew(story, `${addDays(target, 1)}T06:00:01Z`), false);
});

test('a corrected first-crossing date keeps the permanent achievement dedup key', () => {
  const first = addDays(launch, 7), later = addDays(launch, 8);
  const storyAt = target => poolMilestoneStories(activity(target, i => i > 0 ? {
    orchard: 100, ironwood: i === dayNumber(target) ? 701 : 0,
  } : {}), target)[0];
  assert.equal(storyAt(first).key, storyAt(later).key);
  assert.notEqual(storyAt(first).evidence.target, storyAt(later).evidence.target);
});

test('large measured values retain a 280-character claim and finite card evidence', () => {
  const rows = activity(launch, i => i === 0 ? { totalTransactions: 9000000000000, ironwood: 9000000000000 } : {});
  const [story] = poolMilestoneStories(rows, launch);
  assert.ok(story.content.length <= 280);
  assert.ok(visualValues(story.evidence.card.visual).every(Number.isFinite));
});

function crossoverSource(target, periodDays) {
  const crossingDay = dayNumber(target);
  return activity(target, i => i > 0 ? {
    orchard: 100, ironwood: i === crossingDay ? periodDays * 100 + 1 : 2,
  } : {});
}

function assertRollingComparison(story, source) {
  const lead = story.evidence.achievements.find(a => a.id === story.evidence.lead);
  const visual = story.evidence.card.visual, target = story.evidence.target;
  const start = [addDays(launch, -1), addDays(target, -89)].sort().at(-1);
  const pointCount = (Date.parse(target) - Date.parse(start)) / 86400000 + 1;
  assert.equal(visual.kind, 'comparison');
  assert.equal(visual.label, `Transactions · rolling ${lead.periodDays} days`);
  assert.equal(visual.unit, 'transactions');
  assert.equal(visual.start, start);
  assert.equal(visual.end, target);
  assert.deepEqual(visual.series.map(s => ({ key: s.key, label: s.label, tone: s.tone })), [
    { key: 'ironwood', label: 'Ironwood', tone: 'ironwood' },
    { key: 'orchard', label: 'Orchard', tone: 'orchard' },
  ]);
  assert.ok(pointCount >= 2 && pointCount <= 90);
  for (const series of visual.series) {
    assert.equal(series.values.length, pointCount);
    for (let i = 0; i < pointCount; i++) {
      const date = addDays(start, i), windowStart = addDays(date, 1 - lead.periodDays);
      const total = source.days.filter(row => row.date >= windowStart && row.date <= date)
        .reduce((sum, row) => sum + row[series.key], 0);
      assert.equal(series.values[i], total, `${series.label} ${lead.periodDays}-day endpoint at ${date}`);
    }
    assert.equal(series.values.at(-1), lead[series.key]);
  }
}

test('weekly and monthly crossover cards compare exact rolling counts on shared UTC dates', () => {
  for (const periodDays of [7, 30]) {
    const target = addDays(launch, periodDays), source = crossoverSource(target, periodDays);
    const [story] = poolMilestoneStories(source, target);
    assert.equal(story.evidence.achievements[0].kind, 'leadership');
    assert.equal(story.evidence.achievements[0].periodDays, periodDays);
    assertRollingComparison(story, source);
    assert.equal(story.evidence.card.visual.start, addDays(launch, -1));
    assert.equal(story.evidence.card.visual.series[0].values[0], 0);
    assert.notEqual(story.evidence.card.visual.series[1].values.at(-1), source.days.at(-1).orchard);
    assert.match(story.content, periodDays === 7 ? /week|7.day/i : /month|30.day/i);
    assert.doesNotMatch(story.content, /led Orchard over \d+ complete days for the first time/i);
    assert.ok(story.content.length <= 280);
  }
});

test('annual parity cards show both rolling365 counts including a measured pre-launch zero baseline', () => {
  const source = activity(launch, i => i === 0 ? { totalTransactions: 500000, ironwood: 365000 } : {});
  const [story] = poolMilestoneStories(source, launch);
  assert.equal(story.evidence.achievements[0].kind, 'parity');
  assertRollingComparison(story, source);
  assert.equal(story.evidence.card.visual.start, addDays(launch, -1));
  assert.deepEqual(story.evidence.card.visual.series[0].values, [0, 365000]);
  assert.deepEqual(story.evidence.card.visual.series[1].values, [365000, 365000]);
  assert.match(story.content, /caught up|matched|reached/i);
  assert.match(story.content, /past year|365 days/i);
  assert.doesNotMatch(story.content, /trailing-year transaction count/i);
  assert.ok(story.content.length <= 280);
});

test('comparison charts retain a bounded shared timeline across a calendar year', () => {
  const target = '2027-01-05', source = crossoverSource(target, 7);
  const [story] = poolMilestoneStories(source, target);
  assertRollingComparison(story, source);
  assert.equal(story.evidence.card.visual.series[0].values.length, 90);
  assert.match(story.evidence.card.date, /2026/);
  assert.match(story.evidence.card.date, /2027/);
});

test('recovered crossover charts end on the original crossing and preserve its exact endpoints', () => {
  const crossing = addDays(launch, 10), target = addDays(crossing, 2);
  const original = crossoverSource(crossing, 7);
  const extended = activity(target, (i, date) => i > 0 ? {
    orchard: 100, ironwood: date === crossing ? 701 : 2,
  } : {});
  const [initial] = poolMilestoneStories(original, crossing);
  const [recovered] = poolMilestoneStories(extended, target, { activatedAt: `${launch}T00:00:00Z` });
  assert.equal(recovered.evidence.target, crossing);
  assert.deepEqual(recovered.evidence.card.visual, initial.evidence.card.visual);
  assertRollingComparison(recovered, extended);
});

test('volume and involvement-share cards retain single-metric visuals and natural count-aware copy', () => {
  const target = addDays(launch, 13), volume = delayedVolume(target, target);
  const [volumeStory] = poolMilestoneStories(volume, target);
  assert.equal(volumeStory.evidence.card.visual.kind, 'series');
  assert.match(volumeStory.content.split('\n')[0], /reached/i);
  assert.doesNotMatch(volumeStory.content.split('\n')[0], /passed|crossed/i);
  assert.match(volumeStory.content, /since launch|since activation/i);
  const week = addDays(launch, 7);
  const share = activity(week, i => i > 0 ? {
    totalTransactions: 1000, orchard: 1000, ironwood: i === 7 ? 560 : 490,
  } : {});
  const [shareStory] = poolMilestoneStories(share, week);
  assert.equal(shareStory.evidence.card.visual.kind, 'series');
  assert.match(shareStory.content, /50%.*transactions.*use Ironwood/i);
  assert.match(shareStory.content, /week|7.day/i);
  assert.doesNotMatch(shareStory.content, /appeared in at least/i);
  for (const story of [volumeStory, shareStory]) assert.ok(story.content.length <= 280);
});

test('weekly-share charts plot exact rolling weighted involvement and the all-transaction denominator', () => {
  const target = addDays(launch, 14);
  const source = activity(target, i => {
    if (i <= 0) return {};
    const totalTransactions = 1000 + i % 3 * 500;
    return { totalTransactions, orchard: totalTransactions,
      ironwood: Math.round(totalTransactions * (i < 8 ? 0.05 : i === 14 ? 0.95 : 0.45)) };
  });
  const [story] = poolMilestoneStories(source, target);
  assert.equal(story.evidence.lead, 'share:7:50');
  const visual = story.evidence.card.visual;
  assert.equal(visual.kind, 'series'); assert.equal(visual.unit, '%');
  assert.equal(visual.start, addDays(launch, 7)); assert.equal(visual.end, target);
  assert.deepEqual(visual.scale, { min: 0, max: 100 }); assert.equal(visual.reference, 50);
  assert.equal(visual.values.length, 8);
  visual.values.forEach((value, index) => {
    const end = addDays(visual.start, index), start = addDays(end, -6);
    const rows = source.days.filter(row => row.date >= start && row.date <= end);
    const numerator = rows.reduce((total, row) => total + row.ironwood, 0);
    const denominator = rows.reduce((total, row) => total + row.totalTransactions, 0);
    assert.equal(visual.numerators[index], numerator);
    assert.equal(visual.denominators[index], denominator);
    assert.equal(value, 100 * numerator / denominator);
  });
  const lastWeek = source.days.slice(-7);
  const unweighted = lastWeek.reduce((total, row) => total + 100 * row.ironwood / row.totalTransactions, 0) / 7;
  assert.notEqual(visual.values.at(-1), unweighted, 'daily percentages must not be averaged');
  assert.equal(visual.numerators.at(-1), story.evidence.achievements.find(a => a.id === story.evidence.lead).ironwood);
});

test('weekly-share charts leave zero-denominator windows unavailable and show one first full window honestly', () => {
  const first = addDays(launch, 7);
  const [initial] = poolMilestoneStories(activity(first, i => i > 0 ? {
    totalTransactions: 1000, orchard: 1000, ironwood: i === 7 ? 560 : 490,
  } : {}), first);
  assert.deepEqual(initial.evidence.card.visual.values, [50]);
  assert.equal(initial.evidence.card.visual.start, first);
  assert.equal(initial.evidence.card.visual.end, first);
  const target = addDays(launch, 15);
  const source = activity(target, i => i <= 0 ? {} : i < 14 ? {
    totalTransactions: 0, orchard: 0, ironwood: 0,
  } : { totalTransactions: 1000, orchard: 1000, ironwood: i === 14 ? 490 : 520 });
  const [story] = poolMilestoneStories(source, target);
  assert.equal(story.evidence.lead, 'share:7:50');
  assert.deepEqual(story.evidence.card.visual.values, [49, 50.5]);
  assert.deepEqual(story.evidence.card.visual.denominators, [1000, 2000]);
  assert.equal(story.evidence.card.visual.start, addDays(launch, 14));
});

function delayedVolume(target, crossing) {
  return activity(target, (i, date) => ({
    totalTransactions: 2000000,
    ironwood: i === 0 ? 99999 : date === crossing ? 1 : 0,
  }));
}

test('bounded recovery finds a missed first crossing while preserving its original reporting date and period', () => {
  const crossing = addDays(launch, 13), target = addDays(crossing, 1);
  const source = delayedVolume(target, crossing);
  assert.deepEqual(poolMilestoneStories(source, target), []);
  const [recovered] = poolMilestoneStories(source, target, { activatedAt: `${addDays(crossing, -1)}T08:00:00Z` });
  assert.ok(recovered);
  assert.equal(recovered.evidence.target, crossing);
  assert.equal(recovered.evidence.card.visual.end, crossing);
  assert.ok(recovered.evidence.achievements.every(a => a.period.endExclusive === addDays(crossing, 1)));
  assert.deepEqual(recovered.evidence.achievements[0].period, { start: launch, endExclusive: addDays(crossing, 1) });
  assert.equal(recovered.evidence.capturedAt, source.capturedAt);
  assert.equal(eventTime(recovered), Date.parse(`${addDays(crossing, 1)}T06:00:00Z`));
});

test('recovery never publishes a pre-feature reporting period, with an inclusive 06:00 UTC boundary', () => {
  const crossing = addDays(launch, 13), target = addDays(crossing, 1);
  const source = delayedVolume(target, crossing);
  const boundary = `${addDays(crossing, 1)}T06:00:00Z`;
  const included = poolMilestoneStories(source, target, { activatedAt: boundary });
  assert.equal(included.length, 1);
  assert.equal(included[0].evidence.target, crossing);
  assert.deepEqual(poolMilestoneStories(source, target, {
    activatedAt: `${addDays(crossing, 1)}T06:00:01Z`,
  }), []);
  assert.deepEqual(poolMilestoneStories(source, target, {
    activatedAt: `${addDays(target, 2)}T08:00:00Z`,
  }), []);
  assert.throws(() => poolMilestoneStories(source, target, { activatedAt: 'invalid' }), /activation watermark/);
});

test('recovery includes the seventh reporting date and does not reach older history', () => {
  const target = addDays(launch, 40), activatedAt = `${launch}T00:00:00Z`;
  const within = addDays(target, -6), outside = addDays(target, -7);
  const included = poolMilestoneStories(delayedVolume(target, within), target, { activatedAt });
  assert.equal(included.length, 1);
  assert.equal(included[0].evidence.target, within);
  assert.deepEqual(poolMilestoneStories(delayedVolume(target, outside), target, { activatedAt }), []);
});

test('recovery excludes permanent posted or held achievement keys before choosing a story', () => {
  const crossing = addDays(launch, 13), target = addDays(crossing, 1);
  const source = delayedVolume(target, crossing), options = { activatedAt: `${launch}T00:00:00Z` };
  const [recovered] = poolMilestoneStories(source, target, options);
  assert.ok(recovered);
  assert.deepEqual(poolMilestoneStories(source, target, {
    ...options, excludedKeys: ['unrelated-post', recovered.key],
  }), []);
});

test('recovery combines simultaneous achievements but retains separate original reporting dates', () => {
  const first = addDays(launch, 13), second = addDays(first, 1), target = addDays(second, 1);
  const source = activity(target, (i, date) => ({
    totalTransactions: 2000000,
    ironwood: i === 0 ? 99999 : date === first ? 1 : date === second ? 150000 : 0,
  }));
  const recovered = poolMilestoneStories(source, target, { activatedAt: `${launch}T00:00:00Z` });
  assert.deepEqual(recovered.map(s => s.evidence.target), [first, second]);
  assert.ok(recovered[1].evidence.achievements.length > 1);
  for (const story of recovered) {
    assert.ok(story.evidence.achievements.every(a => a.period.endExclusive === addDays(story.evidence.target, 1)));
    assert.ok(story.content.length <= 280);
  }
});

test('incomplete, noncontiguous, unsafe or contradictory history fails closed', () => {
  const cases = [
    rows => rows.days.shift(),
    rows => rows.days.splice(100, 1),
    rows => rows.days.reverse(),
    rows => { rows.days[30].complete = false; },
    rows => { rows.days[30].ironwood = null; },
    rows => { rows.days[30].orchard = NaN; },
    rows => { rows.days[30].totalTransactions = Number.MAX_SAFE_INTEGER + 1; },
    rows => { rows.days[30].orchard = -1; },
    rows => { rows.days.at(-1).ironwood = rows.days.at(-1).totalTransactions + 1; },
    rows => { rows.days[30].ironwood = 1; },
    rows => { rows.historyStart = addDays(rows.historyStart, 1); },
    rows => { rows.activation.date = '2026-07-29'; },
  ];
  for (const mutate of cases) {
    const target = addDays(launch, 30), rows = activity(target);
    mutate(rows);
    assert.throws(() => poolMilestoneStories(rows, target));
  }
});

const globalActivationKey = 'analysis:activation:v1';
const poolActivationKey = 'analysis:pool_activity:activation:v1';
const quiet = { info() {}, warn() {}, error() {} };

function orchestrator({ poolActivatedAt, initialHistory = [], now = new Date('2026-10-27T08:00:00Z') } = {}) {
  const markers = new Map([[globalActivationKey, '2026-09-20T00:00:00Z']]);
  if (poolActivatedAt) markers.set(poolActivationKey, poolActivatedAt);
  const writes = [], history = [...initialHistory], poolOptions = [];
  let clock = now, nextId = 0, poolCalls = 0, live = [];
  const client = { query: async () => ({ rows: [{ acquired: true }] }), release() {} };
  const db = {
    connect: async () => client,
    async query(sql, args = []) {
      if (sql.startsWith('SELECT metadata')) return {
        rows: markers.has(args[0]) ? [{ metadata: { activatedAt: markers.get(args[0]) } }] : [],
      };
      if (sql.startsWith('SELECT post_type')) return { rows: [...history] };
      writes.push([sql, args]);
      if (sql.includes("VALUES ('editorial_activation'")) {
        if (!markers.has(args[0])) markers.set(args[0], JSON.parse(args[1]).activatedAt);
      } else if (sql.includes("VALUES ('editorial_scan'")) {
        if (!history.some(row => row.dedup_key === args[0])) history.push({
          post_type: 'editorial_scan', dedup_key: args[0], status: 'evaluated',
          created_at: clock.toISOString(), metadata: JSON.parse(args[1]),
        });
      } else if (sql.includes("VALUES ($1,$2,$3,$4::jsonb,'posting')")) {
        if (history.some(row => row.dedup_key === args[1])) return { rows: [] };
        const id = ++nextId;
        history.push({ id, post_type: args[0], dedup_key: args[1], status: 'posting',
          created_at: clock.toISOString(), metadata: JSON.parse(args[3]) });
        return { rows: [{ id }] };
      } else if (sql.includes("SET status='posted'")) {
        history.find(row => row.id === args[0]).status = 'posted';
      }
      return { rows: [] };
    },
  };
  const collectors = {
    assertMainnetFresh: async () => {},
    liveCandidates: async () => ({ candidates: live, decisions: [] }),
    reorgCandidates: async () => [],
    poolActivityCandidates: async (reader, at, options) => { poolCalls++; poolOptions.push({ reader, at, options }); return []; },
    activityCandidates: async () => [],
    hashrateCandidate: async () => null,
    signalCandidates: async () => [],
    crosschainDaily: async () => null,
    milestoneCandidates: async () => [],
  };
  const x = { post: async () => ({ id: '123' }) };
  return {
    db, x, collectors, markers, writes, poolOptions,
    get poolCalls() { return poolCalls; },
    setLive(stories) { live = stories; },
    async tick(at = clock, clientOverride = x) {
      clock = at;
      return run(db, clientOverride, { now: at, collectors, logger: quiet });
    },
    scans() { return writes.filter(([sql]) => sql.includes("VALUES ('editorial_scan'")); },
  };
}

test('the pool feature has a separate persistent activation marker and does not replay first-run backlog', async () => {
  const harness = orchestrator();
  const first = await harness.tick();
  assert.equal(harness.poolCalls, 0);
  assert.equal(first.selected.length, 0);
  assert.equal(harness.markers.get(globalActivationKey), '2026-09-20T00:00:00Z');
  assert.equal(harness.markers.get(poolActivationKey), '2026-10-27T08:00:00.000Z');
  assert.ok(!harness.scans().some(([, args]) => args[0].includes(':pool_activity:')));
  await harness.tick(new Date('2026-10-27T09:00:00Z'));
  assert.equal(harness.poolCalls, 0);
  await harness.tick(new Date('2026-10-28T08:00:00Z'));
  assert.equal(harness.poolCalls, 1);
  assert.equal(harness.markers.get(poolActivationKey), '2026-10-27T08:00:00.000Z');
  assert.ok(harness.scans().some(([, args]) => args[0] === 'analysis:scan:pool_activity:2026-10-27'));
});

test('a pool source failure leaves the reporting period eligible for retry', async () => {
  const harness = orchestrator({ poolActivatedAt: '2026-10-26T08:00:00Z' });
  let failures = 0;
  harness.collectors.poolActivityCandidates = async () => { failures++; throw new Error('Incomplete canonical coverage'); };
  for (const at of ['2026-10-27T08:00:00Z', '2026-10-27T08:05:00Z']) {
    const result = await harness.tick(new Date(at));
    assert.ok(result.decisions.some(d => d.key === 'pool_activity' && d.reason === 'source-check-failed'));
  }
  assert.equal(failures, 2);
  assert.ok(!harness.scans().some(([, args]) => args[0].includes(':pool_activity:')));
});

test('the pool collector receives the feature watermark and primary outbox posted or held keys', async () => {
  const activatedAt = '2026-10-20T08:00:00Z';
  const statuses = ['posted', 'posting', 'uncertain', 'draft', 'evaluated'];
  const history = statuses.map(status => ({
    post_type: 'milestone', dedup_key: `milestone:pool_activity:${status}`,
    status, created_at: '2026-10-21T08:00:00Z', metadata: { editorialVersion: 1 },
  }));
  const harness = orchestrator({ poolActivatedAt: activatedAt, initialHistory: history });
  await harness.tick();
  assert.equal(harness.poolOptions.length, 1);
  const call = harness.poolOptions[0];
  assert.equal(call.reader, harness.db);
  assert.equal(call.at.toISOString(), '2026-10-27T08:00:00.000Z');
  assert.equal(call.options.activatedAt, activatedAt);
  assert.deepEqual(call.options.excludedKeys, statuses.slice(0, 3).map(status => `milestone:pool_activity:${status}`));
});

test('preview creates neither the pool activation marker nor scan or publication writes', async () => {
  const harness = orchestrator();
  await harness.tick(new Date('2026-10-27T08:00:00Z'), {
    dryRun: true,
    post() { throw new Error('Preview must not send'); },
    postWithMedia() { throw new Error('Preview must not upload'); },
  });
  assert.equal(harness.markers.has(poolActivationKey), false);
  assert.equal(harness.poolCalls, 0);
  assert.equal(harness.writes.length, 0);
});

test('a combined pool achievement survives an occupied publishing slot and posts on the next eligible run', async () => {
  const harness = orchestrator({ poolActivatedAt: '2026-10-26T08:00:00Z' });
  const target = '2026-10-26', sinceLaunch = dayNumber(target);
  const source = activity(target, i => i === sinceLaunch ? { totalTransactions: 2000000, ironwood: 1000000 } : {});
  const [poolStory] = poolMilestoneStories(source, target);
  let scans = 0;
  harness.collectors.poolActivityCandidates = async () => { scans++; return [poolStory]; };
  harness.setLive([candidate('reorg', 'reorg:observed', 'Observed two-block reorg.', {
    detected_at: '2026-10-27T07:58:00Z',
  })]);
  const first = await harness.tick();
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].key, 'reorg:observed');
  assert.ok(first.decisions.some(d => d.key === poolStory.key && d.reason === 'paced-for-next-run'));
  assert.ok(!harness.scans().some(([, args]) => args[0].includes(':pool_activity:')));
  harness.setLive([]);
  const next = await harness.tick(new Date('2026-10-27T08:21:00Z'));
  assert.equal(scans, 2);
  assert.equal(next.results.length, 1);
  assert.equal(next.results[0].key, poolStory.key);
  assert.ok(harness.scans().some(([, args]) => args[0] === `analysis:scan:pool_activity:${target}`));
});
