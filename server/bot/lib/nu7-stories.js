'use strict';

// NU7 stories. Every figure comes from canonical blocks or node-reported
// accounting observations; the activation height comes from the serving
// node's schedule, never from an announcement. Builders are pure so each
// gate and sentence is testable without a database.
const { candidate } = require('./editorial-policy');
const f = require('./editorial-format');

const BASE = 'https://zecblock.com';
const MARK = '🟨';
const NU7_TARGET = 25;
const OLD_TARGET = 75;
const HOUR = 3600;
const DAY = 86400;

// A countdown only makes sense while "about a day" is true at the old pace.
const COUNTDOWN_BLOCKS = { min: 864, max: 1152 };
// Posting a stale "is live" or milestone after an outage would mislead.
const ACTIVATION_MAX_AGE = 12 * HOUR;
const MILESTONE_MAX_AGE = DAY;
const ACTIVATION_CONFIRMATIONS = 3;
const BLOCK_LEVELS = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
const NSM_LEVELS_ZEC = [1, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];

const iso = seconds => new Date(seconds * 1000).toISOString();
const hhmm = seconds => iso(seconds).slice(11, 16);

// "2 days 21 hours", "9 hours 5 minutes": two units, floored, so a duration
// never reads longer than measured.
function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const parts = [[Math.floor(s / DAY), 'day'], [Math.floor(s % DAY / HOUR), 'hour'], [Math.floor(s % HOUR / 60), 'minute']];
  const first = parts.findIndex(([n]) => n > 0);
  if (first < 0) return 'under a minute';
  return parts.slice(first, first + 2).filter(([n]) => n > 0).map(([n, u]) => `${n} ${u}${n === 1 ? '' : 's'}`).join(' ');
}
const shortDuration = seconds => duration(seconds).replace(/ days?/, 'd').replace(/ hours?/, 'h').replace(/ minutes?/, 'm');

function story(kind, key, content, evidence, { significance, eventAt }) {
  return candidate('nu7', key, content, { ...evidence, nu7Kind: kind, eventAt,
    editorial: { topic: `nu7:${kind}`, lens: kind, significance } }, significance);
}

/** About a day before activation, with self-reported node readiness when available. */
function countdownStory({ nu7Height, tip, readiness }) {
  const remaining = nu7Height - tip.height;
  if (!Number.isSafeInteger(remaining) || remaining < COUNTDOWN_BLOCKS.min || remaining > COUNTDOWN_BLOCKS.max) return null;
  const ready = readiness?.referenceUpgrade === 'NU7' && Number.isFinite(readiness.readinessPct) && readiness.totalActive > 0
    ? readiness : null;
  const readyLine = ready ? `\n\n${ready.readinessPct}% of observed nodes already advertise the NU7 protocol.` : '';
  const content = `${MARK} NU7 activates on Zcash in about a day.\n\nBlock #${f.number(nu7Height)} is ${f.number(remaining)} blocks away. `
    + `After it, Zcash targets a block every ${NU7_TARGET} seconds instead of ${OLD_TARGET}.${readyLine}\n\n${BASE}/block/${nu7Height}`;
  const card = { kicker: 'NU7 · Countdown', title: 'NU7 activates in about a day.', hero: f.number(remaining), unit: 'blocks', tone: 'gold',
    line: 'until NU7 activates.', qualifier: `Block #${f.number(nu7Height)}. Then ${NU7_TARGET}-second blocks.`,
    source: `zecblock.com/block/${nu7Height}`, date: f.timeText(tip.timestamp),
    visual: ready ? { kind: 'bars', items: [
      { label: 'NU7-ready nodes', value: ready.latestCount, display: `${f.number(ready.latestCount)} (${ready.readinessPct}%)`, tone: 'gold' },
      { label: 'Other observed nodes', value: ready.totalActive - ready.latestCount, display: f.number(ready.totalActive - ready.latestCount), tone: 'muted' },
    ] } : null };
  return story('countdown', `nu7:countdown:${nu7Height}`, content,
    { nu7Height, tip, remaining, readiness: ready, card }, { significance: 85, eventAt: iso(tip.timestamp) });
}

/** NU7 is live: the activation block, once buried, while it is still news. */
function activationStory({ nu7Height, block, tip, pool, recent, now }) {
  const confirmations = tip.height - nu7Height + 1;
  if (!block || block.height !== nu7Height || confirmations < ACTIVATION_CONFIRMATIONS) return null;
  if (now.getTime() / 1000 - block.timestamp > ACTIVATION_MAX_AGE) return null;
  const minedBy = pool && pool !== 'Unknown' ? `, mined by ${pool}` : '';
  const content = `${MARK} NU7 is live on Zcash.\n\nBlock #${f.number(nu7Height)} activated it at ${hhmm(block.timestamp)} UTC${minedBy}. `
    + `Zcash now targets a block every ${NU7_TARGET} seconds, three times as often as before.\n\n${BASE}/block/${nu7Height}`;
  const card = { kicker: 'Network upgrade · NU7', title: 'NU7 is live on Zcash.', hero: 'NU7', unit: null, tone: 'gold',
    line: 'is live on Zcash.', qualifier: `Activated at block #${f.number(nu7Height)}.`,
    source: `zecblock.com/block/${nu7Height}`, date: f.timeText(block.timestamp),
    visual: recent?.length ? { kind: 'pulse', start: recent[0].timestamp, end: tip.timestamp, activation: nu7Height,
      blocks: recent.map(b => ({ t: b.timestamp, nu7: b.height >= nu7Height })) } : null };
  return story('activation', `nu7:activation:${nu7Height}`, content,
    { nu7Height, block, pool: pool || null, confirmations, card }, { significance: 100, eventAt: iso(block.timestamp) });
}

const waitText = seconds => `${f.number(Math.floor(seconds * 10 / 60 * 10) / 10, 1)} minutes`;

/** The first 24 hours of NU7 against the 24 hours before it. */
function firstDayStory({ nu7Height, activationTime, after, before, now }) {
  const end = activationTime + DAY;
  const age = now.getTime() / 1000 - end;
  if (age < 0 || age > DAY) return null;
  if (!(after?.blocks > 1) || !(before?.blocks > 1) || !(after.averageSeconds > 0) || !(before.averageSeconds > 0)) return null;
  const ratio = after.blocks / before.blocks;
  const content = `${MARK} NU7's first 24 hours on Zcash: ${f.number(after.blocks)} blocks.\n\n`
    + `That's ${ratio.toFixed(1)}× the ${f.number(before.blocks)} of the 24 hours before. Blocks averaged ${after.averageSeconds.toFixed(1)} seconds, `
    + `down from ${before.averageSeconds.toFixed(1)}. Ten confirmations now take about ${waitText(after.averageSeconds)}, not ${waitText(before.averageSeconds)}.\n\n${BASE}/network/block-speed`;
  const card = { kicker: 'NU7 · First 24 hours', title: 'NU7’s first 24 hours.', hero: f.number(after.blocks), unit: 'blocks', tone: 'gold',
    line: 'mined in NU7’s first 24 hours.', qualifier: `${ratio.toFixed(1)}× the 24 hours before.`,
    source: 'zecblock.com/network/block-speed', date: f.timeText(end),
    visual: { kind: 'bars', items: [
      { label: '24 hours before NU7', value: before.blocks, display: f.number(before.blocks), tone: 'muted' },
      { label: 'First 24 hours of NU7', value: after.blocks, display: f.number(after.blocks), tone: 'gold' },
    ] } };
  return story('first_day', `nu7:first_day:${nu7Height}`, content,
    { nu7Height, activationTime, after, before, card }, { significance: 88, eventAt: iso(end) });
}

/** Round block counts since activation, against the time the old target needed. */
function blockMilestoneStory({ nu7Height, tip, start, crossing, now }) {
  const mined = tip.height - nu7Height + 1;
  const level = [...BLOCK_LEVELS].reverse().find(l => l <= mined);
  if (!level || !crossing || crossing.height !== nu7Height + level - 1) return null;
  if (now.getTime() / 1000 - crossing.timestamp > MILESTONE_MAX_AGE) return null;
  const elapsed = crossing.timestamp - start.timestamp;
  if (!(elapsed > 0)) return null;
  const old = level * OLD_TARGET;
  const content = `${MARK} Zcash has mined ${f.number(level)} blocks since NU7 activated.\n\nIt took ${duration(elapsed)}. `
    + `At the old ${OLD_TARGET}-second target, ${f.number(level)} blocks would have taken ${duration(old)}.\n\n${BASE}/network/block-speed`;
  const card = { kicker: 'NU7 · Blocks', title: `${f.number(level)} blocks since NU7.`, hero: f.number(level), unit: 'blocks', tone: 'gold',
    line: 'mined since NU7 activated.', qualifier: `In ${shortDuration(elapsed)}, not ${shortDuration(old)}.`,
    source: 'zecblock.com/network/block-speed', date: f.timeText(crossing.timestamp),
    visual: { kind: 'bars', items: [
      { label: 'With NU7 · measured', value: elapsed, display: shortDuration(elapsed), tone: 'gold' },
      { label: `At the old ${OLD_TARGET}s target`, value: old, display: shortDuration(old), tone: 'muted' },
    ] } };
  return story('blocks', `nu7:blocks:${level}`, content,
    { nu7Height, level, crossing, start, elapsed, card }, { significance: 72, eventAt: iso(crossing.timestamp) });
}

// Consensus block subsidy: 12.5 ZEC scaled by target spacing, halved per era.
const subsidyZat = (seconds, halvings) => (BigInt(Math.floor(1_250_000_000 * seconds / 150)) >> BigInt(halvings));
const HALVING_DAYS = [730, 365, 180, 100, 30, 7, 1];
const zecAmount = zat => f.number(Number(zat) / 1e8, 8).replace(/(\.\d\d)\d*$/, '$1');

/**
 * Next halving, estimated from consensus target spacing (NU7 moves its height).
 * Posts once per threshold, only while the estimate sits within a day of it.
 */
function halvingCountdownStory({ schedule, tip, halvingIndex, halvingHeight, targetSeconds }) {
  const index = halvingIndex(schedule, tip.height);
  const height = index === null ? null : halvingHeight(schedule, index + 1);
  if (!Number.isSafeInteger(height) || height <= tip.height) return null;
  const days = targetSeconds(schedule, tip.height, height) / DAY;
  const threshold = HALVING_DAYS.find(t => days <= t && days > t - 1);
  if (!threshold) return null;
  const spacing = h => schedule.eras.filter(era => era.height <= h).at(-1).seconds;
  const before = subsidyZat(spacing(height - 1), index), after = subsidyZat(spacing(height), index + 1);
  const when = threshold === 730 ? 'about two years' : threshold === 365 ? 'about a year' : threshold === 1 ? 'about a day' : `about ${threshold} days`;
  const nu7Note = schedule.nu7Height != null && schedule.nu7Height < height ? ' NU7’s 25-second blocks set this height.' : '';
  const content = `${MARK} The next Zcash halving is ${when} away.

At block #${f.number(height)}, the block reward drops from `
    + `${zecAmount(before)} to ${zecAmount(after)} ZEC.${nu7Note} Timing is estimated from the target block spacing.

${BASE}/network#issuance`;
  const card = { kicker: 'Halving · Countdown', title: `Next halving: ${when}.`, hero: threshold >= 365 ? (threshold === 730 ? '~2' : '~1') : f.number(threshold),
    unit: threshold >= 365 ? (threshold === 730 ? 'years' : 'year') : threshold === 1 ? 'day' : 'days', tone: 'gold',
    line: 'until the next Zcash halving.', qualifier: `Block #${f.number(height)} · ${zecAmount(before)} → ${zecAmount(after)} ZEC.`,
    source: 'zecblock.com/network#issuance', date: f.timeText(tip.timestamp), visual: null };
  return candidate('halving', `halving:${height}:${threshold}d`, content,
    { halvingHeight: height, threshold, days, beforeZat: before.toString(), afterZat: after.toString(), tip, eventAt: iso(tip.timestamp), card,
      editorial: { topic: 'halving', lens: 'countdown', significance: threshold <= 7 ? 85 : 70 } }, 70);
}

const zatBig = value => (/^-?\d+$/.test(String(value)) ? BigInt(value) : null);

/** NSM reserve growth since activation, at round ZEC levels, from exact node counters. */
function nsmMilestoneStory({ nu7Height, baseline, current, crossing, daily, now }) {
  const base = zatBig(baseline?.nsmZat), cur = zatBig(current?.nsmZat);
  if (base === null || cur === null || !crossing) return null;
  const growth = cur - base;
  const level = [...NSM_LEVELS_ZEC].reverse().find(l => growth >= BigInt(l) * 100_000_000n);
  if (!level || zatBig(crossing.nsmZat) === null || zatBig(crossing.nsmZat) - base < BigInt(level) * 100_000_000n) return null;
  if (now.getTime() / 1000 - crossing.timestamp > MILESTONE_MAX_AGE) return null;
  const growthText = f.zecText(growth.toString());
  const content = `${MARK} Milestone: the NU7 sustainability reserve grew by ${f.number(level)} ZEC.\n\n`
    + `Since NU7, 60% of transaction fees go to the Network Sustainability Mechanism (NSM) instead of miners. `
    + `The reserve is ${growthText} ZEC above its pre-NU7 balance as of block #${f.number(current.height)}.\n\n${BASE}/network`;
  const series = (daily || []).map(d => zatBig(d.nsmZat)).filter(v => v !== null).map(v => Number(v - base) / 1e8);
  const card = { kicker: 'NU7 · NSM reserve', title: `NSM reserve: +${f.number(level)} ZEC since NU7.`, hero: `+${f.number(level)}`, unit: 'ZEC', tone: 'gold',
    line: 'added to the NSM reserve since NU7.', qualifier: `${growthText} ZEC at block #${f.number(current.height)}.`,
    source: 'zecblock.com/network', date: f.timeText(crossing.timestamp),
    visual: series.length >= 3 ? { kind: 'series', values: series, reference: level, referenceLabel: 'milestone',
      label: 'NSM reserve growth since NU7', unit: 'ZEC', start: daily[0].date, end: daily.at(-1).date } : null };
  return story('nsm', `nu7:nsm:${level}`, content,
    { nu7Height, level, growthZat: growth.toString(), baseline, current, crossing, card }, { significance: 78, eventAt: iso(crossing.timestamp) });
}

module.exports = { halvingCountdownStory, countdownStory, activationStory, firstDayStory, blockMilestoneStory, nsmMilestoneStory, duration,
  BLOCK_LEVELS, NSM_LEVELS_ZEC, COUNTDOWN_BLOCKS };
