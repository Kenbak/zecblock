const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, URL, require: name => deps[name] ?? require(name) });
  return exports;
}
const blockTiming = load('lib/block-timing.ts');
const upgrades = load('lib/upgrade-history-data.ts');
const networkUpgrades = load('lib/network-upgrades.ts', { './block-timing': blockTiming, './config': { NETWORK_UPGRADES: {} }, './upgrade-history-data': upgrades });
const calendar = load('lib/zcash-calendar.ts', {
  './grant-rounds': load('lib/grant-rounds.ts'), './network-upgrades': networkUpgrades,
  './upgrade-history-data': upgrades, './nu7-vote-config': load('lib/nu7-vote-config.ts'),
});

const tipTime = Date.parse('2026-11-15T18:00:00Z') / 1000;
const snapshot = { height: 3_576_549, tipTimestamp: tipTime, observedBlockTime: null, schedule: { nu7Height: 3_543_405, eras: [{ height: 0, seconds: 150 }, { height: 653_600, seconds: 75 }, { height: 3_543_405, seconds: 25 }] } };
const now = tipTime * 1000;
const events = calendar.resolveCalendar(calendar.calendarSources({ nu7Height: 3_543_405, halvingHeight: 6_132_390, halvingEstimatedAt: Date.parse('2029-02-19T07:21:20Z') }), snapshot, now);
const byId = id => events.find(e => e.id === id);

test('dated deadlines keep exact UTC times and get labelled estimated future blocks', () => {
  const review = byId('retroactive-grants-q4-2026-review');
  assert.equal(review.time, Date.parse('2026-12-16T20:00:00Z'));
  assert.equal(review.heightEstimated, true);
  assert.equal(review.height, 3_576_549 + Math.round((review.time / 1000 - tipTime) / 25));
  const open = byId('retroactive-grants-q4-2026-vote-open');
  assert.equal(open.dateOnly, true);
  assert.equal(open.status, 'upcoming');
  // Past date-only events never claim a block they cannot know.
  assert.equal(byId('retroactive-grants-q4-2026-vote-open').heightEstimated, true);
});

test('block-anchored events keep exact heights; the halving uses the API cadence estimate', () => {
  const halving = byId('halving-3');
  assert.equal(halving.height, 6_132_390);
  assert.equal(halving.heightEstimated, false);
  assert.equal(halving.timeEstimated, true);
  assert.equal(halving.time, Date.parse('2029-02-19T07:21:20Z'));
  assert.equal(byId('nu7').status, 'past');
  assert.equal(byId('retroactive-grants-q3-2026-snapshot').time, 1789602914 * 1000);
});

test('day-to-block estimates interpolate between mined anchors and project at the current spacing', () => {
  const anchors = calendar.heightAnchors(events, snapshot.height, tipTime);
  assert.equal(calendar.estimateHeightAtTime(anchors, 1793932442 * 1000, 25), 3_543_405);
  assert.equal(calendar.estimateHeightAtTime(anchors, now + 86_400_000, 25), 3_576_549 + 3456);
  const mid = calendar.estimateHeightAtTime(anchors, Date.parse('2026-11-10T00:00:00Z'), 25);
  assert.ok(mid > 3_543_405 && mid < 3_576_549);
  assert.equal(calendar.estimateHeightAtTime(anchors, Date.parse('2016-01-01T00:00:00Z'), 25), null);
});

test('future block pages only match nearby dated events or exact block events', () => {
  const review = byId('retroactive-grants-q4-2026-review');
  assert.equal(calendar.eventsNearBlock(events, review.height + 100, 1728).some(e => e.id === review.id), true);
  assert.equal(calendar.eventsNearBlock(events, review.height + 5000, 1728).some(e => e.id === review.id), false);
  assert.deepEqual(Array.from(calendar.eventsNearBlock(events, 6_132_390, 1728), e => e.id), ['halving-3']);
});

test('past dated events carry the real block where they happened and round-specific titles', () => {
  const close = byId('retroactive-grants-q3-2026-vote-close');
  assert.equal(close.title, 'Q3 2026 grants: voting closes');
  assert.equal(close.height, 3_500_662);
  assert.equal(close.heightEstimated, false);
  assert.equal(close.anchorKind, 'dated');
  assert.equal(byId('nu7-vote-open').height, 3_460_284);
  assert.equal(byId('retroactive-grants-q3-2026-vote-open').height, 3_485_943);
  // Every exact-height milestone that is not an upgrade gets a block-page tag.
  const tagged = events.filter(e => e.height !== null && !e.heightEstimated && e.kind !== 'upgrade' && e.id !== 'nu7-snapshot').map(e => e.height);
  for (const height of [0, 1_046_400, 2_726_400, 3_485_940, 3_500_662, 3_569_925, 6_132_390]) assert.ok(tagged.includes(height), String(height));
});

test('a registered round overrides the schedule with its on-chain deadline and snapshot', () => {
  const sources = calendar.calendarSources({ registered: { 'retroactive-grants-q4-2026': { snapshotHeight: 3_684_100, voteEnd: Date.parse('2026-12-29T21:00:00Z') } } });
  const resolved = calendar.resolveCalendar(sources, snapshot, now);
  assert.equal(resolved.find(e => e.id === 'retroactive-grants-q4-2026-vote-close').time, Date.parse('2026-12-29T21:00:00Z'));
  const snap = resolved.find(e => e.id === 'retroactive-grants-q4-2026-snapshot');
  assert.equal(snap.height, 3_684_100);
  assert.equal(snap.status, 'upcoming');
});

test('watcher-approved events: Dev Fund poll, ZIP 2009 fee change and NSM reissuance', () => {
  const open = byId('devfund-poll-open');
  assert.equal(open.dateOnly, true);
  assert.equal(open.external, true);
  assert.equal(byId('devfund-poll-close').time, Date.parse('2026-11-30T23:59:00Z'));
  assert.equal(byId('devfund-poll-proposals').height, 3_553_223);
  const fee = byId('zip2009-fee');
  assert.equal(fee.height, 3_590_000);
  assert.equal(fee.heightEstimated, false);
  assert.equal(fee.status, 'upcoming');
  assert.ok(fee.time > now);
  assert.equal(byId('nsm-reissuance').height, 8_939_664);
});

test('date-only countdowns say Today, Tomorrow or N days', () => {
  const at = Date.parse('2026-11-16T00:00:00Z');
  assert.equal(calendar.daysUntilLabel(at, Date.parse('2026-11-15T19:00:00Z')), 'Tomorrow');
  assert.equal(calendar.daysUntilLabel(at, Date.parse('2026-11-16T08:00:00Z')), 'Today');
  assert.equal(calendar.daysUntilLabel(at, Date.parse('2026-11-13T19:00:00Z')), '3 days');
});
