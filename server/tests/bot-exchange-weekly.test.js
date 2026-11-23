'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const x = require('../bot/lib/exchange-flows');
const data = require('../bot/lib/editorial-data');

// Real totals for Nov 16–22, 2026 from /v1/exchange-flows/daily (exact zatoshis).
const WEEK = [
  { entity: 'binance', depositsZat: '32494548981536', withdrawalsZat: '10229576425030', depositCount: 373, withdrawalCount: 1520 },
  { entity: 'kraken', depositsZat: '11306547865880', withdrawalsZat: '13882902529082', depositCount: 356, withdrawalCount: 1009 },
  { entity: 'coinbase', depositsZat: '48154816942', withdrawalsZat: '3697152122519', depositCount: 9, withdrawalCount: 8 },
  { entity: 'coinbase_prime', depositsZat: '10002714658174', withdrawalsZat: '6401903102750', depositCount: 91, withdrawalCount: 26 },
  { entity: 'gemini', depositsZat: '0', withdrawalsZat: '0', depositCount: 0, withdrawalCount: 0 },
  { entity: 'grayscale', depositsZat: '240000', withdrawalsZat: '212560279104', depositCount: 1, withdrawalCount: 1 },
  { entity: 'hyperunit', depositsZat: '1801281063983', withdrawalsZat: '1348788966324', depositCount: 148, withdrawalCount: 227 },
];
const week = rows => x.weeklyNetFlowStory({ start: '2026-11-16', endExclusive: '2026-11-23', rows });

test('weekly recap: exact net, movers by size, inactive entities left out, ≤ 280 characters', () => {
  const s = week(WEEK);
  assert.equal(s.type, 'exchange_netflow_weekly');
  assert.equal(s.key, 'analysis:exchange_netflow:2026-11-16');
  const net = WEEK.reduce((a, r) => a + BigInt(r.depositsZat) - BigInt(r.withdrawalsZat), 0n);
  assert.equal(s.evidence.netZat, net.toString());
  assert.ok(s.content.length <= 280, `length ${s.content.length}`);
  assert.match(s.content, /Exchange flows last week \(Nov 16 – 22, 2026, UTC\): 198,803\.\d\d ZEC net into labelled exchange and custody wallets\./);
  assert.match(s.content, /^.*\n\nBinance \+222\.6K · Coinbase −36\.4K · Coinbase Prime \+36\.0K · Kraken −25\.7K/m);
  assert.ok(!/Gemini/.test(s.content) && !s.evidence.entities.some(e => e.entity === 'gemini'));
  assert.equal(s.evidence.card.visual.rows.length, 6);
  assert.equal(s.evidence.card.hero, '+198.8K');
  assert.match(s.content, /\nhttps:\/\/zecblock\.com\/docs#exchange-flows-daily$/);
});

test('weekly recap: net outflow reads "out of"; a quiet or invalid week posts nothing', () => {
  const out = week([{ entity: 'kraken', depositsZat: '100', withdrawalsZat: '500000000000', depositCount: 1, withdrawalCount: 3 },
    { entity: 'binance', depositsZat: '0', withdrawalsZat: '100000000', depositCount: 0, withdrawalCount: 1 }]);
  assert.match(out.content, /ZEC net out of labelled/);
  assert.equal(out.evidence.card.tone, 'out');
  assert.equal(week([WEEK[0]]), null, 'one active entity is not a comparison');
  assert.equal(x.weeklyNetFlowStory({ start: '2026-11-17', endExclusive: '2026-11-24', rows: WEEK }), null, 'weeks start on Monday');
  assert.equal(week([{ ...WEEK[0], depositsZat: '1.5' }, WEEK[1]]), null);
  assert.equal(week([{ ...WEEK[0], entity: 'other:x' }, WEEK[1]]), null);
});

test('weekly collector: needs an ok dataset covering the whole completed week', async () => {
  const now = new Date('2026-11-23T07:00:00Z');
  const pool = { query: async sql => {
    if (/current_database/.test(sql)) return { rows: [{ name: 'zcash_explorer_mainnet', timestamp: Math.floor(now / 1000) - 60 }] };
    if (/exchange_flow_daily/.test(sql)) return { rows: WEEK };
    throw new Error(`unexpected ${sql.slice(0, 40)}`);
  } };
  const state = through => ({ status: 'ok', state: { coverage_from_time: 1477612800, through_time: through } });
  const run = st => data.exchangeWeeklyCandidates(pool, now, { store: { status: async () => st } });
  const ok = await run(state(Date.parse('2026-11-23T00:05:00Z') / 1000));
  assert.equal(ok[0].key, 'analysis:exchange_netflow:2026-11-16');
  const short = await run(state(Date.parse('2026-11-22T23:00:00Z') / 1000));
  assert.equal(short.decisions[0].reason, 'week-incomplete');
  const stale = await run({ status: 'stale', reason: 'labels-changed', state: {} });
  assert.equal(stale.decisions[0].reason, 'exchange-flows-stale');
});

test('weekly recap renders a still card and a GIF', async () => {
  const s = week(WEEK);
  const { renderEditorial } = require('../bot/lib/zecblock-cards');
  const png = await renderEditorial(s);
  assert.ok(fs.statSync(png).size > 10000); fs.unlinkSync(png);
  const out = require('path').join(require('os').tmpdir(), `netflow-test-${process.pid}.gif`);
  try {
    const r = await require('../bot/lib/netflow-gif').renderNetflowGif(s, out);
    assert.ok(r.bytes > 10000);
    assert.equal(fs.readFileSync(out).subarray(0, 6).toString(), 'GIF89a');
  } catch (error) {
    if (!/ffmpeg|ENOENT/.test(error.message)) throw error;
  } finally { try { fs.unlinkSync(out); } catch { /* not written */ } }
});
