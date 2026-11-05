'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const { renderEditorial, seriesModel, chartValue, W, H, C } = require('../bot/lib/zecblock-cards');
const { publish } = require('../bot/jobs/editorial');
const { preparePublication } = require('../bot/lib/editorial-source');
const { addDays } = require('../lib/transaction-activity');
const { poolMilestoneStories } = require('../bot/lib/pool-activity-milestones');
const p = require('../bot/lib/editorial-policy');
const { insightFixtures } = require('../bot/lib/editorial-insights');
const stories = require('./fixtures/bot-editorial-stories');
const byType = type => stories.find(s => s.type === type);

test('all scheduled editorial types render attributed, bounded ZecBlock PNGs', async () => {
  for (const story of stories) {
    assert.ok(story);
    assert.equal(new URL(story.content.split('\n').at(-1)).origin, 'https://zecblock.com');
    assert.match(story.evidence.card.source, /^zecblock\.com\//);
    const file = await renderEditorial(story);
    try {
      const img = await loadImage(file);
      assert.equal(img.width, W); assert.equal(img.height, H);
      const canvas = createCanvas(W,H), ctx = canvas.getContext('2d');
      ctx.drawImage(img,0,0);
      assert.deepEqual([...ctx.getImageData(0,0,1,1).data], [11,12,14,255]);
    } finally { fs.unlinkSync(file); }
  }
});

test('cards keep direction, truncated amounts, routes and the neutral migration wording', () => {
  const shield = byType('flow_shield').evidence.card, deshield = byType('flow_deshield').evidence.card;
  assert.equal(shield.hero, '+899.99'); assert.equal(shield.tone, 'in'); assert.equal(shield.visual.direction, 'down');
  assert.equal(shield.line, 'entered Ironwood (≈ $1.33M)');
  assert.equal(deshield.hero, '−899.99'); assert.equal(deshield.tone, 'out'); assert.equal(deshield.visual.direction, 'up');
  const odd = p.flowStory({ ...byType('flow_shield').evidence, flow_type: 'shield', amount_zat: '51205000000', sample_count: 10000, greater_count: 4, equal_count: 2 });
  assert.equal(odd.evidence.card.hero, '+512.05');
  assert.deepEqual(byType('swap').evidence.card.visual, { kind: 'swap', from: 'zec', to: 'sol' });
  assert.equal(byType('migration').evidence.card.tone, 'ironwood');
  assert.match(byType('migration').evidence.card.qualifier, /not new shielding/);
  assert.equal(byType('reorg').evidence.card.visual.depth, 2);
});

test('image delivery uploads the new renderer output and removes the temporary file', async () => {
  const db = { query: async sql => ({rows: sql.startsWith('INSERT')?[{id:1}]:[]}) };
  let uploaded;
  const x = { post(){throw new Error('Unexpected text fallback');}, async postWithMedia(content,file) {
    assert.equal(content, preparePublication(stories[0]).content);
    assert.ok(fs.existsSync(file)); uploaded=file;
    return {id:'123'};
  } };
  const result=await publish(db,x,stories[0],{render:renderEditorial,logger:{info(){},warn(){},error(){}}});
  assert.equal(result.status,'posted'); assert.ok(uploaded); assert.equal(fs.existsSync(uploaded),false);
});

test('invalid evidence fails safely rather than fabricating chart values', async () => {
  const story = structuredClone(byType('network_signal')); story.evidence.card.visual.values[3]=null;
  await assert.rejects(renderEditorial(story), /Missing editorial value/);
  await assert.rejects(renderEditorial({...stories[0],content:stories[0].content.replace('https://zecblock.com','https://example.com')}), /Unexpected editorial link/);
  await assert.rejects(renderEditorial({...stories[0],evidence:{}}), /Story has no card/);
  const long = structuredClone(stories[0]); long.evidence.card.line = 'x'.repeat(200);
  await assert.rejects(renderEditorial(long), /exceeds safe bounds/);
});

function poolComparison(target = '2026-10-26', periodDays = 7) {
  const launch = '2026-07-28', historyStart = addDays(launch, -365);
  const length = (Date.parse(target) - Date.parse(historyStart)) / 86400000 + 1;
  const source = {
    historyStart,
    capturedAt: `${addDays(target, 1)}T08:00:00.000Z`,
    activation: { height: 3428143, date: launch, timestamp: Date.parse(`${launch}T12:00:00Z`) / 1000 },
    tip: { height: 3600000, hash: 'a'.repeat(64), timestamp: Date.parse(`${addDays(target, 1)}T07:59:00Z`) / 1000 },
    days: Array.from({ length }, (_, i) => {
      const date = addDays(historyStart, i);
      return { date, complete: true, totalTransactions: 500000, orchard: 1000,
        ironwood: date === target ? periodDays === 365 ? 365000 : periodDays * 1000 + 1000 : 0 };
    }),
  };
  return poolMilestoneStories(source, target)[0];
}

test('two-pool crossover cards render both series in bounded PNGs, including equality and cross-year dates', async () => {
  const examples = [poolComparison(), poolComparison('2026-10-26', 30),
    poolComparison('2026-07-28', 365), poolComparison('2027-01-05')];
  const rgb = hex => hex.slice(1).match(/../g).map(byte => parseInt(byte, 16));
  for (const story of examples) {
    assert.equal(story.evidence.card.visual.kind, 'comparison');
    assert.equal(story.evidence.card.visual.series.length, 2);
    const file = await renderEditorial(story);
    try {
      const img = await loadImage(file);
      assert.equal(img.width, W); assert.equal(img.height, H);
      const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, W, H).data;
      for (const tone of ['ironwood', 'orchard']) {
        const [r, g, b] = rgb(C[tone]);
        let visible = false;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === r && pixels[i + 1] === g && pixels[i + 2] === b && pixels[i + 3] === 255) {
            visible = true; break;
          }
        }
        assert.ok(visible, `${tone} series must remain visually distinguishable`);
      }
    } finally { fs.unlinkSync(file); }
  }
});

test('comparison cards reject incomplete, mismatched or nonfinite series rather than drawing misleading lines', async () => {
  const original = poolComparison();
  const mutations = [
    visual => { visual.series.pop(); },
    visual => { visual.series[1].values.pop(); },
    visual => { visual.series[0].values = []; visual.series[1].values = []; },
    visual => { visual.series[0].values[0] = null; },
    visual => { visual.series[0].values[0] = NaN; },
    visual => { visual.series[0].values[0] = Infinity; },
    visual => { visual.series[0].values[0] = -1; },
    visual => { visual.series[0].values[0] = Number.MAX_SAFE_INTEGER + 1; },
    visual => { visual.series[0].values[0] = 1.5; },
    visual => { visual.series[1].key = 'ironwood'; },
    visual => { delete visual.label; },
    visual => { delete visual.start; },
    visual => { visual.end = addDays(visual.end, 1); },
    visual => { visual.end = '2026-02-30'; },
    visual => { visual.unit = 'ZEC'; },
  ];
  for (const mutate of mutations) {
    const story = structuredClone(original);
    mutate(story.evidence.card.visual);
    await assert.rejects(renderEditorial(story), /Invalid comparison/);
  }
});

test('existing daily charts recover units and exact UTC bounds from their source observations', () => {
  const story = byType('activity_daily'), model = seriesModel(story);
  assert.equal(model.unit, '%');
  assert.equal(model.start, story.evidence.days[0].date);
  assert.equal(model.end, story.evidence.days.at(-1).date);
  assert.equal(model.values.at(-1), story.evidence.stats.value);
  const unknown = structuredClone(story);
  delete unknown.evidence.days;
  delete unknown.evidence.card.visual.start; delete unknown.evidence.card.visual.end;
  unknown.evidence.target = '2026-09-30';
  assert.equal(seriesModel(unknown).start, undefined, 'a reporting date alone must not invent the chart start');
  assert.equal(seriesModel(unknown).end, '2026-09-30');
  const gapped = structuredClone(story);
  delete gapped.evidence.card.visual.start; delete gapped.evidence.card.visual.end;
  gapped.evidence.days[4].date = gapped.evidence.days[3].date;
  assert.equal(seriesModel(gapped).start, undefined, 'noncontiguous observations must not be given a contiguous date axis');
});

test('signed net-flow charts preserve withdrawals below a visible zero baseline', async () => {
  const story = structuredClone(byType('activity_daily'));
  story.evidence.card = { kicker: 'Pools · Public flows', title: 'More ZEC left shielded pools than entered.',
    hero: '−75', unit: 'ZEC', line: 'net public shielding.', qualifier: 'Public flows; pool migrations excluded.',
    tone: 'out', source: 'zecblock.com/privacy', date: 'Oct 27, 2026',
    visual: { kind: 'series', label: 'Net public shielding per UTC day', unit: 'ZEC',
      values: [40, -50, 90, -75], allowNegative: true, reference: -12.5,
      referenceLabel: 'Prior 30-day daily average', start: '2026-10-24', end: '2026-10-27' } };
  const model = seriesModel(story);
  assert.ok(model.min < -75 && model.max > 90);
  assert.equal(model.reference, -12.5);
  assert.deepEqual(model.values, [40, -50, 90, -75]);
  assert.equal(chartValue(-75, 'ZEC', { signed: true }), '−75 ZEC');
  const file = await renderEditorial(story);
  try { assert.equal((await loadImage(file)).width, W); } finally { fs.unlinkSync(file); }
  for (const mutation of [v => { delete v.allowNegative; }, v => { v.reference = NaN; },
    v => { v.scale = { min: 0, max: 100 }; }, v => { v.end = '2026-10-28'; },
    v => { v.start = '2026-02-30'; }, v => { delete v.start; }]) {
    const invalid = structuredClone(story); mutation(invalid.evidence.card.visual);
    await assert.rejects(renderEditorial(invalid), /editorial value|chart reference|chart scale|chart date/);
  }
});

test('a first complete weekly-share observation is rendered once rather than copied into a fictitious line', async () => {
  const story = structuredClone(byType('activity_daily'));
  story.evidence.card.visual = { kind: 'series', label: 'Ironwood involvement · rolling 7 days',
    unit: '%', values: [50], reference: 50, referenceLabel: 'Milestone threshold',
    scale: { min: 0, max: 100 }, start: '2026-08-04', end: '2026-08-04' };
  const model = seriesModel(story);
  assert.deepEqual(model.values, [50]); assert.equal(model.min, 0); assert.equal(model.max, 100);
  const file = await renderEditorial(story);
  try {
    const img = await loadImage(file);
    assert.equal(img.height, H);
    const canvas = createCanvas(W, H), ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    assert.deepEqual([...ctx.getImageData(400, 495, 1, 1).data], [11, 12, 14, 255],
      'one observed point must not paint a fictitious historical area');
  } finally { fs.unlinkSync(file); }
  story.evidence.card.visual.values = [101];
  await assert.rejects(renderEditorial(story), /chart scale/);
});

test('briefings render three attributed facts and reject incomplete or overcrowded evidence', async () => {
  const story = structuredClone(byType('activity_daily'));
  story.evidence.card = { kicker: 'Network · Weekly', hero: 'This week', line: 'in Zcash activity.',
    qualifier: 'Coinbase excluded from transaction counts.', source: 'zecblock.com/privacy', date: 'Oct 27, 2026',
    visual: { kind: 'briefing', items: [
      { label: 'Transactions', value: '72,000', detail: '+20.0% vs prior week', tone: 'gold' },
      { label: 'Shielded share', value: '60.0%', detail: '+5.0 pts vs prior week', tone: 'ironwood' },
      { label: 'Fees paid', value: '123.45 ZEC', detail: '−10.0% vs prior week', tone: 'gold' },
    ] } };
  const file = await renderEditorial(story);
  try { assert.equal((await loadImage(file)).height, H); } finally { fs.unlinkSync(file); }
  for (const items of [[], [...story.evidence.card.visual.items, { label: 'Extra', value: '1' }], [{ label: 'Fees', value: null }]]) {
    const invalid = structuredClone(story); invalid.evidence.card.visual.items = items;
    await assert.rejects(renderEditorial(invalid), /Invalid briefing/);
  }
});

test('new briefing and pool-trend fixtures share the renderer contract without losing signs or source dates', async () => {
  const examples = insightFixtures();
  assert.ok(examples.some(story => story.type === 'network_briefing'));
  assert.ok(examples.some(story => story.type === 'pool_trend'));
  for (const story of examples) {
    if (story.evidence.card.visual.kind === 'series') {
      const model = seriesModel(story);
      assert.equal(model.unit, 'ZEC'); assert.equal(model.allowNegative, true);
      assert.equal(model.start, story.evidence.card.visual.start);
      assert.equal(model.end, story.evidence.card.visual.end);
    }
    const file = await renderEditorial(story);
    try { assert.equal((await loadImage(file)).width, W); } finally { fs.unlinkSync(file); }
  }
  assert.equal(chartValue(3999999, 'ZEC'), '3.99M ZEC');
  assert.equal(chartValue(50.999, '%'), '50.9%');
  assert.equal(chartValue(-3999999, 'ZEC', { signed: true }), '−3.99M ZEC');
});
