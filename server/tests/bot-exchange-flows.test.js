'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const x = require('../bot/lib/exchange-flows');
const policy = require('../bot/lib/editorial-policy');
const data = require('../bot/lib/editorial-data');
const landing = require('../bot/lib/landing-gif');
const { run, EXCHANGE_ACTIVATION_KEY } = require('../bot/jobs/editorial');
const fx = require('../bot/fixtures/exchange-flows');

const quiet = { info() {}, warn() {}, error() {} };
const one = rows => x.classify(x.groupRows(rows)[0]);

test('labels resolve to entities; unknown exchange labels stay their own unposted entity', () => {
  assert.equal(x.entityOfLabel('Hyperunit Deposit'), 'hyperunit');
  assert.equal(x.entityOfLabel(' hyperunit hot wallet '), 'hyperunit');
  assert.equal(x.entityOfLabel('Binance Cold Wallet'), 'binance');
  assert.equal(x.entityOfLabel('Coinbase Prime Custody'), 'coinbase_prime');
  assert.equal(x.entityOfLabel('Grayscale Zcash Trust'), 'grayscale');
  assert.equal(x.entityOfLabel('Some New Exchange'), 'other:some new exchange');
  assert.equal(x.postable('other:some new exchange'), false);
  assert.equal(x.entityOfLabel(''), null);
});

test('Hyperunit: the user payment is the deposit, the deposit-address sweep is internal', () => {
  const deposit = one(fx.rows.hyperunitDeposit());
  assert.equal(deposit.skipped, null);
  assert.deepEqual(deposit.events.map(e => [e.entity, e.direction, e.amountZat, e.counterparty]),
    [['hyperunit', 'deposit', '60200000000', 'transparent']], 'change back to the user is not counted');
  assert.deepEqual(one(fx.rows.hyperunitSweep()), { events: [], skipped: 'internal' });
});

test('withdrawal: exact value leaving the entity, change back excluded', () => {
  const w = one(fx.rows.krakenWithdrawal());
  assert.deepEqual(w.events.map(e => [e.entity, e.direction, e.amountZat]), [['kraken', 'withdrawal', '2000000000000']]);
  // Straight into a shielded pool: value balance is negative (value entered the pool).
  const shielded = one([
    { txid: 'e'.repeat(64), block_height: 1, block_time: 10, is_coinbase: false, has_sprout: false, value_balance: '-150000000000', side: 'in', entity: 'binance', zat: '150010000000', unknown: 0 },
    { txid: 'e'.repeat(64), block_height: 1, block_time: 10, is_coinbase: false, has_sprout: false, value_balance: '-150000000000', side: 'out', entity: 'binance', zat: '0', unknown: 0 },
  ]);
  assert.deepEqual(shielded.events.map(e => [e.direction, e.amountZat, e.counterparty]), [['withdrawal', '150000000000', 'shielded']]);
});

test('ambiguous transactions are skipped, never guessed; poisoning dust is never an event worth posting', () => {
  const t = (rows, extra = {}) => one(rows.map(r => ({ txid: 'f'.repeat(64), block_height: 1, block_time: 10, is_coinbase: false,
    has_sprout: false, value_balance: '0', unknown: 0, ...extra, ...r })));
  assert.equal(t([{ side: 'in', entity: 'kraken', zat: '5' }, { side: 'in', entity: 'binance', zat: '5' }, { side: 'out', entity: null, zat: '9' }]).skipped, 'inputs-from-several-entities');
  assert.equal(t([{ side: 'in', entity: 'kraken', zat: '5' }, { side: 'in', entity: null, zat: '5' }, { side: 'out', entity: null, zat: '9' }]).skipped, 'mixed-inputs');
  assert.equal(t([{ side: 'in', entity: 'kraken', zat: '5' }, { side: 'out', entity: 'binance', zat: '4' }]).skipped, 'between-entities');
  assert.equal(t([{ side: 'in', entity: null, zat: '5' }, { side: 'out', entity: null, zat: '4' }]).skipped, 'no-entity-value');
  assert.equal(t([{ side: 'out', entity: 'kraken', zat: '5' }], { is_coinbase: true }).skipped, 'coinbase');
  assert.equal(t([{ side: 'out', entity: 'kraken', zat: '5' }], { has_sprout: true }).skipped, 'sprout');
  assert.equal(t([{ side: 'in', entity: null, zat: '5', unknown: 1 }, { side: 'out', entity: 'kraken', zat: '5' }]).skipped, 'unresolved-legs');
  // A 0-ZEC poisoning output carries no value to the entity at all.
  assert.equal(one(fx.rows.poisoning()).skipped, 'no-entity-value');
  // And any dust that does carry value is far below the posting bar.
  const dust = { txid: 'd'.repeat(64), entity: 'binance', direction: 'deposit', amountZat: '1', blockTime: 1795371400, ...x.rankEvent({ direction: 'deposit', blockTime: 1795371400, amountZat: '1' }, fx.history(1795371400)) };
  assert.equal(x.exchangeFlowStory(dust), null);
});

test('one deposit, two transactions: only the first is an event even when both are in the window', () => {
  const { events } = x.classifyRows([...fx.rows.hyperunitDeposit(), ...fx.rows.hyperunitSweep()]);
  assert.equal(events.length, 1);
  assert.equal(events[0].txid, fx.HYPERUNIT_DEPOSIT);
});

test('rank: same direction, postable entities, prior 30 days only; histogram is that exact sample', () => {
  const end = 1795371364, events = fx.history(end);
  events.push({ txid: 'c'.repeat(64), entity: 'other:x', direction: 'deposit', amountZat: String(1e14), blockTime: end - 10 });
  events.push({ txid: '9'.repeat(64), entity: 'kraken', direction: 'deposit', amountZat: String(1e14), blockTime: end + 10 });
  const r = x.rankEvent({ direction: 'deposit', blockTime: end, amountZat: '1000000000000' }, events);
  assert.equal(r.sample_count, 400);
  assert.equal(r.greater_count, 0, 'unposted entities and later events are excluded');
  assert.equal(r.distribution.total, 400);
  assert.equal(r.distribution.bins.reduce((a, b) => a + b.n, 0), 400);
});

test('24h net flow is exact zatoshis per entity and across exchanges', () => {
  const e = (entity, direction, zat, t) => ({ entity, direction, amountZat: zat, blockTime: t, txid: 'a'.repeat(64) });
  const events = [e('kraken', 'deposit', '100000000001', 1000), e('kraken', 'withdrawal', '30000000000', 1001),
    e('binance', 'deposit', '7', 1002), e('kraken', 'deposit', '5', 1000 - 86400), e('other:x', 'deposit', '9', 1003)];
  assert.deepEqual(x.netFlow(events, 1003, 'kraken'), { depositsZat: '100000000001', withdrawalsZat: '30000000000', netZat: '70000000001', count: 2 });
  assert.deepEqual(x.netFlow(events, 1003), { depositsZat: '100000000008', withdrawalsZat: '30000000000', netZat: '70000000008', count: 3 });
});

function story(row, end = Number(row.blockTime)) {
  const events = [...fx.history(end), row];
  return x.exchangeFlowStory({ ...row, ...x.rankEvent(row, events), net: x.netFlow(events, end, row.entity), price_usd: 500 });
}

test('copy and card: one fact, attribution stated, link to the zecblock tx page, within 280 characters', () => {
  const deposit = story({ ...x.classifyRows(fx.rows.hyperunitDeposit()).events[0], amountZat: '120200000000' });
  assert.equal(deposit.type, 'exchange_flow');
  assert.equal(deposit.key, `exchange_flow:deposit:hyperunit:${fx.HYPERUNIT_DEPOSIT}`);
  assert.match(deposit.content, /^🟨 1,202 ZEC \(\$601K\) just went into Hyperunit\.\n\n/);
  assert.match(deposit.content, /labelled exchange and custody wallets in 30 days/);
  assert.match(deposit.content, /Hyperunit, last 24h: [\d.,K]+ ZEC in, [\d.,K]+ ZEC out\./);
  assert.ok(deposit.content.endsWith(`https://zecblock.com/tx/${fx.HYPERUNIT_DEPOSIT}`));
  assert.ok(deposit.content.length <= 280);
  assert.equal(deposit.evidence.card.visual.logo, 'hyperunit.png');
  assert.equal(deposit.evidence.card.hero, '+1,202');

  const w = story(x.classifyRows(fx.rows.krakenWithdrawal()).events[0]);
  assert.match(w.content, /^🟨 20,000 ZEC \(\$10\.00M\) just left Kraken\./);
  assert.match(w.content, /The largest withdrawal from labelled exchange and custody wallets in 30 days\./);
  assert.equal(w.evidence.card.tone, 'out');
  assert.ok(w.content.length <= 280);

  const custody = story({ ...x.classifyRows(fx.rows.krakenWithdrawal()).events[0], entity: 'grayscale' });
  assert.match(custody.content, /just left Grayscale custody\./);
  assert.equal(custody.evidence.card.kicker, 'Custody · Withdrawal');
});

test('bars: 1,000 ZEC floor, top 1%, at least 100 comparable events, unknown entities never post', () => {
  const base = { ...x.classifyRows(fx.rows.krakenWithdrawal()).events[0] };
  assert.equal(story({ ...base, amountZat: '99999999999' }), null, 'below 1,000 ZEC');
  const thin = x.exchangeFlowStory({ ...base, ...x.rankEvent(base, fx.history(base.blockTime, 50)) });
  assert.equal(thin, null, 'too few comparable events');
  const common = x.exchangeFlowStory({ ...base, amountZat: '100000000000', ...x.rankEvent({ ...base, amountZat: '990' + '00000000' },
    [...fx.history(base.blockTime), ...Array.from({ length: 50 }, (_, i) => ({ ...base, txid: String(i).padStart(64, '7'), amountZat: '500000000000', blockTime: base.blockTime - 100 - i }))]) });
  assert.equal(common, null, 'outside the top 1%');
  assert.equal(story({ ...base, entity: 'other:x' }), null);
});

test('selection: per-exchange cooldown, daily cap, and one story per transaction', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  const s = story({ ...x.classifyRows(fx.rows.krakenWithdrawal()).events[0], blockTime: now / 1000 - 600 });
  const held = (minutes, extra = {}) => ({ post_type: 'exchange_flow', dedup_key: `k${minutes}`, status: 'posted',
    created_at: new Date(now - minutes * 60000).toISOString(), metadata: { entity: 'kraken', direction: 'withdrawal', txid: 'x', ...extra } });
  assert.equal(policy.select([s], [], now).selected.length, 1);
  assert.equal(policy.select([s], [held(60)], now).skipped[0].reason, 'exchange-cooldown');
  assert.equal(policy.select([s], [held(200)], now).selected.length, 1, 'cooldown is three hours');
  assert.equal(policy.select([s], [held(60, { direction: 'deposit' })], now).selected.length, 1, 'per direction');
  const four = [1, 2, 3, 4].map(i => held(30 + i, { entity: `e${i}` }));
  assert.equal(policy.select([s], four, now).skipped[0].reason, 'exchange-daily-cap');
  const flow = { post_type: 'flow_deshield', dedup_key: 'large_flow:x', status: 'posted', created_at: new Date(now - 60000).toISOString(),
    metadata: { txid: s.evidence.txid } };
  assert.equal(policy.select([s], [flow], now).skipped[0].reason, 'same-transaction-already-posted');
  assert.equal(policy.eventTime(s), s.evidence.block_time * 1000);
});

test('history: full read first, then a two-hour overlap that replaces reorganised events', async () => {
  const h = x.createHistory();
  const labels = { addresses: ['a'], entities: ['kraken'], fingerprint: 'f1' };
  const reads = [];
  const ev = (txid, t) => ({ txid, entity: 'kraken', direction: 'deposit', amountZat: '1', blockTime: t });
  const now = new Date('2026-11-22T12:00:00Z'), nowS = now / 1000;
  let batch = [ev('a'.repeat(64), nowS - 5000), ev('b'.repeat(64), nowS - 1000)];
  const opts = { load: async () => labels, read: async (_db, _l, from, to) => { reads.push([from, to]); return { events: batch.filter(e => e.blockTime >= from && e.blockTime < to), skipped: {} }; } };
  const first = await h.refresh({}, now, opts);
  assert.equal(first.full, true); assert.equal(first.events.length, 2);
  assert.equal(reads[0][1] - reads[0][0], 31 * 86400);
  // The second block was reorganised away; a new one arrived.
  batch = [ev('a'.repeat(64), nowS - 5000), ev('c'.repeat(64), nowS + 100)];
  const later = new Date(now.getTime() + 300000);
  const second = await h.refresh({}, later, opts);
  assert.equal(second.full, false);
  assert.equal(reads[1][0], first.to - 7200);
  assert.deepEqual(second.events.map(e => e.txid[0]), ['a', 'c']);
  labels.fingerprint = 'f2';
  assert.equal((await h.refresh({}, later, opts)).full, true, 'a label change rebuilds the window');
});

test('collector: ranks the last hour, prices once, reports what did not qualify', async () => {
  const now = new Date((1795371364 + 600) * 1000);
  const deposit = { ...x.classifyRows(fx.rows.hyperunitDeposit()).events[0], amountZat: '120200000000' };
  const small = { ...deposit, txid: '1'.repeat(64), amountZat: '100000000000', blockTime: deposit.blockTime - 5 };
  const events = [...fx.history(deposit.blockTime), small, deposit].sort((a, b) => a.blockTime - b.blockTime);
  const history = { refresh: async () => ({ to: now / 1000 - 120, events }) };
  const db = { query: async () => ({ rows: [{ name: 'zcash_explorer_mainnet', timestamp: now / 1000 - 30 }] }) };
  let priced = 0;
  const result = await data.exchangeFlowCandidates(db, now, { history, fetchPrice: async () => { priced++; return { quote: { usd: 500 } }; } });
  assert.equal(priced, 1);
  assert.equal(result.candidates.length, 2, 'both clear the bars against a 1–999 ZEC history');
  assert.match(result.candidates[1].content, /\$601K/);
  const none = await data.exchangeFlowCandidates(db, now, { history: { refresh: async () => ({ to: now / 1000, events: fx.history(now / 1000) }) },
    fetchPrice: async () => { throw new Error('should not price'); } });
  assert.deepEqual(none, { candidates: [], decisions: [] });
});

test('editorial run: exchange flows wait for their own activation watermark', async () => {
  const now = new Date('2026-11-22T12:00:00Z');
  const s = story({ ...x.classifyRows(fx.rows.krakenWithdrawal()).events[0], blockTime: now / 1000 - 600 });
  const marks = { [EXCHANGE_ACTIVATION_KEY]: new Date(now - 3600000).toISOString() };
  const client = { query: async () => ({ rows: [{ acquired: true }] }), release() {} };
  const pool = { connect: async () => client, query: async (sql, params) => {
    if (/SELECT metadata FROM social_post_outbox WHERE dedup_key/.test(sql)) return { rows: [{ metadata: { activatedAt: marks[params[0]] || '2026-01-01T00:00:00Z' } }] };
    return { rows: [] };
  } };
  const old = story({ ...x.classifyRows(fx.rows.krakenWithdrawal()).events[0], blockTime: now / 1000 - 7200 });
  let offered = [old];
  const collectors = { assertMainnetFresh: async () => {}, liveCandidates: async () => [], reorgCandidates: async () => [],
    exchangeFlowCandidates: async () => ({ candidates: offered, decisions: [] }) };
  const result = await run(pool, { dryRun: true }, { now, logger: quiet, collectors });
  assert.deepEqual(result.selected.map(c => c.key), [], 'events before activation never post');
  assert.ok(result.decisions.some(d => d.reason === 'before-activation'));
  offered = [s];
  const later = await run(pool, { dryRun: true }, { now, logger: quiet, collectors });
  assert.deepEqual(later.selected.map(c => c.key), [s.key]);
  assert.equal(later.results[0].status, 'preview');
});

test('landing model and media hook: exchange GIF from the carried histogram, logo, still-card fallback', async () => {
  const s = story(x.classifyRows(fx.rows.krakenWithdrawal()).events[0]);
  const m = landing.landingModel(s, await landing.loadDistribution(null, s));
  assert.equal(m.kind, 'exchange');
  assert.equal(m.counter, 'exchange & custody withdrawals · last 30 days');
  assert.equal(m.label, 'Largest in 30 days');
  assert.ok(fs.existsSync(m.logo));
  await assert.rejects(landing.loadDistribution(null, { ...s, evidence: { ...s.evidence, sample_count: 1 } }), /ranked against 1/);
  const made = [];
  const media = landing.storyMedia({ still: async () => '/tmp/still.png', logger: quiet,
    gif: async (_story, dist, file) => { made.push(dist.total); fs.writeFileSync(file, 'GIF89a'); } });
  const file = await media(s);
  assert.match(file, /zecblock-landing-.*\.gif$/); fs.unlinkSync(file);
  assert.deepEqual(made, [400], 'no reader needed for exchange flows');
  const failing = landing.storyMedia({ still: async () => '/tmp/still.png', logger: quiet, gif: async () => { throw new Error('ffmpeg missing'); } });
  assert.equal(await failing(s), '/tmp/still.png');
});

test('still card renders the exchange logo', async () => {
  const cards = require('../bot/lib/zecblock-cards');
  const s = story(x.classifyRows(fx.rows.krakenWithdrawal()).events[0]);
  const file = await cards.renderEditorial(s);
  assert.ok(fs.statSync(file).size > 10000); fs.unlinkSync(file);
  await assert.rejects(cards.renderEditorial({ ...s, evidence: { ...s.evidence, card: { ...s.evidence.card, visual: { kind: 'entity', logo: '../x.png' } } } }), /Unexpected exchange logo/);
});

test('FLOW_ROWS bounds history by height and time, checks canonical blocks, and uses parameters only', () => {
  assert.match(x.FLOW_ROWS, /unnest\(\$1::text\[\], \$2::text\[\]\)/);
  assert.match(x.FLOW_ROWS, /b\.hash = t\.block_hash/);
  assert.match(x.FLOW_ROWS, /at\.block_height >= \(SELECT height FROM start\)/);
  assert.doesNotMatch(x.FLOW_ROWS, /\$\{/);
});
