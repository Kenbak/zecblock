'use strict';

const { addDays, day } = require('../../lib/transaction-activity');
const { candidate } = require('./editorial-policy');
const f = require('./editorial-format');

const VOLUME_LEVELS = [100000, 250000, 500000, 1000000, 2000000, 5000000, 10000000];
const SHARE_LEVELS = [10, 25, 50, 75];
const PARITY_LEVELS = [90, 95, 100];
const METHODOLOGY = 'Canonical mainnet non-coinbase transactions, once per pool per transaction. Pool counts overlap; migrations are included. Rolling windows use complete UTC days. Lifetime Ironwood counts include the activation day. Counts measure activity, not users or payments.';

function validate(activity, target) {
  day(target);
  const activation = activity?.activation;
  if (activation?.height !== 3428143 || activation.date !== '2026-07-28'
    || !Number.isSafeInteger(activation.timestamp)
    || new Date(activation.timestamp * 1000).toISOString().slice(0, 10) !== activation.date) {
    throw new Error('Verified Ironwood activation is required');
  }
  const start = addDays(activation.date, -365);
  const days = activity.days;
  const length = (Date.parse(target) - Date.parse(start)) / 86400000 + 1;
  if (target < activation.date || activity.historyStart !== start || !Array.isArray(days)
    || days.length !== length) throw new Error('Incomplete pool activity history');
  for (let i = 0; i < days.length; i++) {
    const row = days[i];
    if (row.date !== addDays(start, i) || row.complete !== true) throw new Error('Incomplete pool activity day');
    for (const key of ['totalTransactions', 'orchard', 'ironwood']) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error('Invalid pool activity count');
    }
    if (row.orchard > row.totalTransactions || row.ironwood > row.totalTransactions) throw new Error('Invalid pool activity denominator');
    if (row.date < activation.date && row.ironwood !== 0) throw new Error('Ironwood activity predates activation');
  }
  return days;
}

function firstCrossingStories(activity, target) {
  const days = validate(activity, target);
  const prefixes = [{ ironwood: 0, orchard: 0, totalTransactions: 0 }];
  for (const row of days) {
    const sums = {};
    for (const key of ['ironwood', 'orchard', 'totalTransactions']) {
      sums[key] = prefixes.at(-1)[key] + row[key];
      if (!Number.isSafeInteger(sums[key])) throw new Error('Pool activity sum exceeds safe integer range');
    }
    prefixes.push(sums);
  }
  const sum = (endIndex, count) => Object.fromEntries(['ironwood', 'orchard', 'totalTransactions']
    .map(key => [key, prefixes[endIndex + 1][key] - prefixes[endIndex + 1 - count][key]]));
  const atLeast = (value, denominator, level) => denominator > 0
    && BigInt(value) * 100n >= BigInt(denominator) * BigInt(level);
  const seen = new Set();
  const achievements = [];
  const launchIndex = 365;
  for (let i = launchIndex; i < days.length; i++) {
    const date = days[i].date;
    const period = count => ({ start: addDays(date, 1 - count), endExclusive: addDays(date, 1) });
    const consider = (id, facts) => {
      if (!seen.has(id) && date === target) achievements.push({ id, ...facts });
      seen.add(id);
    };
    for (const periodDays of [7, 30]) {
      // The activation day is partial. Rate windows start on the next UTC day.
      if (i - launchIndex < periodDays) continue;
      const totals = sum(i, periodDays);
      if (totals.ironwood > totals.orchard) consider(`leadership:${periodDays}`, {
        kind: 'leadership', periodDays, ...totals, period: period(periodDays),
      });
      if (periodDays === 7) for (const level of SHARE_LEVELS) {
        if (atLeast(totals.ironwood, totals.totalTransactions, level)) consider(`share:7:${level}`, {
          kind: 'share', periodDays: 7, level, ...totals, period: period(7),
        });
      }
    }
    const annual = sum(i, 365);
    for (const level of PARITY_LEVELS) {
      if (atLeast(annual.ironwood, annual.orchard, level)) consider(`parity:365:${level}`, {
        kind: 'parity', periodDays: 365, level, ...annual, period: period(365),
      });
    }
    const lifetime = sum(i, i - launchIndex + 1);
    for (const level of VOLUME_LEVELS) {
      if (lifetime.ironwood >= level) consider(`volume:${level}`, {
        kind: 'volume', periodDays: i - launchIndex + 1, level, ...lifetime,
        period: { start: activity.activation.date, endExclusive: addDays(date, 1) },
      });
    }
  }
  if (!achievements.length) return [];

  // Preserve every simultaneous first crossing in evidence, but send one story.
  const rank = a => a.kind === 'parity' && a.level === 100 ? 100
    : a.kind === 'leadership' ? 60 + a.periodDays
    : a.kind === 'volume' ? 50 : a.kind === 'share' ? 40 : 20;
  achievements.sort((a, b) => rank(b) - rank(a) || (b.level || 0) - (a.level || 0));
  const lead = achievements[0];
  const range = lead.period.start.slice(0, 4) === target.slice(0, 4)
    ? f.rangeText(lead.period.start, target) : `${f.dayYear(lead.period.start)} – ${f.dayYear(target)}`;
  const window = `${range} UTC`;
  const ageDays = Math.floor((Date.parse(`${addDays(target, 1)}T00:00:00Z`) / 1000 - activity.activation.timestamp) / 86400);
  const ageText = ageDays === 0 ? 'Less than a day after Ironwood launched.' : `${ageDays} days after Ironwood launched.`;
  let headline, detail, hero, line, qualifier;
  if (lead.kind === 'leadership') {
    headline = lead.periodDays === 7 ? 'Ironwood just overtook Orchard in weekly transaction activity.'
      : "Ironwood just passed Orchard's 30-day transaction count.";
    detail = `${f.number(lead.ironwood)} transactions vs Orchard's ${f.number(lead.orchard)} over ${lead.periodDays} days.`;
    hero = f.number(lead.ironwood); line = `transactions in the past ${lead.periodDays} days.`;
    qualifier = `Ahead of Orchard's ${f.number(lead.orchard)}.`;
  } else if (lead.kind === 'parity') {
    headline = lead.level === 100 ? "Ironwood just caught up with Orchard's transaction count over the past year."
      : `Ironwood just reached ${lead.level}% of Orchard's transaction count over the past year.`;
    detail = `${f.number(lead.ironwood)} vs ${f.number(lead.orchard)} transactions over 365 days.`;
    hero = `≥${lead.level}%`; line = "of Orchard's past-year transactions.";
    qualifier = ageText;
  } else if (lead.kind === 'volume') {
    headline = `Ironwood just reached ${f.number(lead.level)} transactions.`;
    detail = `${f.number(lead.ironwood)} transactions since launch. ${ageText}`;
    hero = f.levelText(lead.level); line = 'transactions since launch.';
    qualifier = ageText;
  } else {
    headline = `At least ${lead.level}% of Zcash transactions now use Ironwood.`;
    detail = `${f.number(lead.ironwood)} of ${f.number(lead.totalTransactions)} transactions over the past week.`;
    hero = `≥${lead.level}%`; line = 'of transactions used Ironwood.';
    qualifier = 'Over the past week; coinbase excluded.';
  }
  // Dates, counts and the denominator take precedence over optional age context.
  const compose = extra => `🟨 ${headline}\n\n${detail}${extra}\n\n${window}. Coinbase excluded.\nhttps://zecblock.com/pools`;
  const withAge = compose(lead.kind === 'volume' ? '' : ` ${ageText}`);
  const content = withAge.length <= 280 ? withAge : compose('');
  const chartRows = days.slice(Math.max(launchIndex, days.length - 30));
  const cumulative = lead.kind === 'volume';
  const values = chartRows.map((row, offset) => cumulative
    ? prefixes[days.length - chartRows.length + offset + 1].ironwood : row.ironwood);
  let visual = { kind: 'series', values,
    label: cumulative ? 'Ironwood transactions since launch' : 'Ironwood transactions per UTC day',
    unit: 'transactions', start: chartRows[0].date, end: target };
  if (lead.kind === 'share') {
    // The headline concerns a seven-day share. Plot that same weighted ratio,
    // including transparent transactions in its denominator, at each endpoint.
    // Earlier zero-denominator windows are unavailable, never a fabricated 0%.
    let startIndex = Math.max(launchIndex + 7, days.length - 30);
    for (let index = startIndex; index < days.length; index++) {
      if (sum(index, 7).totalTransactions === 0) startIndex = index + 1;
    }
    const indices = Array.from({ length: days.length - startIndex }, (_, i) => startIndex + i);
    const totals = indices.map(index => sum(index, 7));
    visual = { kind: 'series', label: 'Ironwood involvement · rolling 7 days', unit: '%',
      values: totals.map(total => 100 * total.ironwood / total.totalTransactions),
      numerators: totals.map(total => total.ironwood), denominators: totals.map(total => total.totalTransactions),
      reference: lead.level, referenceLabel: 'Milestone threshold', scale: { min: 0, max: 100 },
      start: days[startIndex].date, end: target };
  } else if (lead.kind === 'leadership' || lead.kind === 'parity') {
    // Plot the same rolling count as the claim, for both pools on every date.
    // One pre-launch endpoint supplies a real zero baseline for launch-day events.
    const startIndex = Math.max(launchIndex - 1, days.length - 90);
    const indices = Array.from({ length: days.length - startIndex }, (_, i) => startIndex + i);
    visual = { kind: 'comparison', label: `Transactions · rolling ${lead.periodDays} days`, unit: 'transactions', periodDays: lead.periodDays,
      start: days[startIndex].date, end: target,
      series: ['ironwood', 'orchard'].map(key => ({ key, label: key === 'ironwood' ? 'Ironwood' : 'Orchard', tone: key,
        values: indices.map(index => sum(index, lead.periodDays)[key]) })) };
  }
  const comparisonTitle = lead.kind === 'leadership' ? 'Ironwood overtakes Orchard'
    : lead.kind === 'parity' ? lead.level === 100 ? 'Ironwood catches up with Orchard'
      : `Ironwood reaches ${lead.level}% of Orchard` : null;
  const card = { kicker: 'Milestone · Ironwood activity', title: comparisonTitle || headline, hero, tone: 'ironwood', line, qualifier,
    source: 'zecblock.com/pools', date: range,
    visual };
  return [candidate('milestone', `milestone:pool_activity:${lead.id}`, content, {
    target, achievements, lead: lead.id, activation: activity.activation, ageDays,
    historyStart: activity.historyStart, capturedAt: activity.capturedAt, tip: activity.tip,
    methodology: METHODOLOGY, card,
  }, 10 + rank(lead))];
}

// A bounded recovery window covers source failures and the shared daily cap.
// Preserve the original reporting date; never turn an old crossing into a new one.
function poolMilestoneStories(activity, target, { activatedAt, excludedKeys = [] } = {}) {
  validate(activity, target);
  let start = target;
  if (activatedAt) {
    const time = Date.parse(activatedAt);
    if (!Number.isFinite(time)) throw new Error('Invalid pool activity activation watermark');
    const activationDate = new Date(time).toISOString().slice(0, 10);
    const firstTarget = Date.parse(`${activationDate}T06:00:00Z`) >= time
      ? addDays(activationDate, -1) : activationDate;
    start = [addDays(target, -6), firstTarget, activity.activation.date].sort().at(-1);
  }
  const excluded = new Set(excludedKeys);
  const stories = [];
  for (let date = start; date <= target; date = addDays(date, 1)) {
    const length = (Date.parse(date) - Date.parse(activity.historyStart)) / 86400000 + 1;
    const events = firstCrossingStories({ ...activity, days: activity.days.slice(0, length) }, date);
    stories.push(...events.filter(story => !excluded.has(story.key)));
  }
  return stories;
}

module.exports = { VOLUME_LEVELS, SHARE_LEVELS, PARITY_LEVELS, poolMilestoneStories };
