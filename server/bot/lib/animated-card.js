'use strict';

// Animated social cards: a replay of real daily history with a running
// counter. One fact per video, in the same type and palette as the still
// cards. Models are pure (payload in, numbers out) so they can be tested
// without canvas or ffmpeg; one renderer draws every model.
//
// A model returns null when its source is incomplete. A missing day drawn as
// a flat or zero stretch would misstate history, so nothing is rendered.
const { spawn } = require('child_process');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const LOGO = path.join(__dirname, '..', '..', '..', 'public', 'brand', 'zecblock-logotype.png');
const W = 1200, H = 675, PAD = 80;
const FPS = 30;
const TEXT_STEP_FRAMES = 10;
const DAY_MS = 86_400_000;

// Dark tokens from app/globals.css and lib/chart-theme.ts.
const C = {
  bg: '#0B0C0E', track: '#1B1E23', grid: '#20242A',
  text: '#F1F3F5', secondary: '#C2C7CF', muted: '#9CA4B0', faint: '#6E7682',
  gold: '#F8BC21', ironwood: '#E8CF78', orchard: '#B6A0E0', sapling: '#91AC90', sprout: '#7F897A',
  zakura: '#E8A1C4', steel: '#A1A9AD', stone: '#565D68', in: '#65C79A', out: '#E0A070',
};

// ─── Shared helpers ──────────────────────────────────────────────────────────

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const unwrap = payload => (isRecord(payload) && payload.success !== false ? (isRecord(payload.data) ? payload.data : payload) : null);
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const decimal = value => (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : amount(value) ? value : null);
const isoDay = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(`${value.slice(0, 10)}T00:00:00Z`)) ? value.slice(0, 10) : null);
const fmt = n => Math.round(n).toLocaleString('en-US');
/** Three significant figures while the replay runs: "248K", "2.54M". */
const compact = n => (n >= 999_500_000 ? `${(n / 1e9).toFixed(2)}B`
  : n >= 99_950_000 ? `${Math.round(n / 1e6)}M` : n >= 9_995_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 999_500 ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1_000 ? `${Math.round(n / 1_000).toLocaleString('en-US')}K` : fmt(n));
const dayLabel = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const monthLabel = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
const today = now => now.toISOString().slice(0, 10);

/** True when the dates are strictly consecutive UTC days. */
function consecutive(dates) {
  for (let i = 1; i < dates.length; i++) {
    if (Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`) !== DAY_MS) return false;
  }
  return true;
}

/**
 * Which data point each frame shows. Playback eases out so recent history gets
 * more screen time; only the speed changes, the time axis stays linear and
 * every frame is a real data point. `text` lags `frames`: a chart can move 30
 * times a second but a number cannot be read that fast, so text steps a few
 * times a second and lands on the latest point for the hold.
 */
function timeline(count, { seconds = 12, holdSeconds = 2.5, ease = 0.5 } = {}) {
  const motion = Math.round(seconds * FPS);
  const hold = Math.round(holdSeconds * FPS);
  const frames = Array.from({ length: motion + hold }, (_, i) => Math.min(count - 1, Math.round((Math.min(i, motion - 1) / (motion - 1)) ** ease * (count - 1))));
  const text = frames.map((_, i) => (i >= motion - 1 ? count - 1 : frames[Math.floor(i / TEXT_STEP_FRAMES) * TEXT_STEP_FRAMES]));
  return { frames, text };
}

/** Year labels for a daily axis. Long histories label every other year; short ones label quarters. */
function axisTicks(dates) {
  const span = Number(dates.at(-1).slice(0, 4)) - Number(dates[0].slice(0, 4));
  const ticks = [];
  dates.forEach((date, index) => {
    if (span >= 3) {
      if (date.endsWith('-01-01') && (span < 7 || Number(date.slice(0, 4)) % 2 === 0)) ticks.push({ index, label: date.slice(0, 4) });
    } else if (date.endsWith('-01') && Number(date.slice(5, 7)) % 3 === 1) {
      ticks.push({ index, label: new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }) });
    }
  });
  return ticks;
}

/** Trailing sum over `window` points; null until the window is full. */
function trailing(values, window) {
  let sum = 0;
  return values.map((value, i) => {
    sum += value;
    if (i >= window) sum -= values[i - window];
    return i >= window - 1 ? sum : null;
  });
}

// ─── Is there a story? ───────────────────────────────────────────────────────
// A video is worth posting only when its data has just done something. Each
// model answers with a short event name, or null on an ordinary day.

const RECENT_DAYS = 7;

/** The latest level, when it is an all-time high first reached within the last week; otherwise null. */
function newLevel(levels, recent = RECENT_DAYS) {
  const last = levels.length - 1;
  if (last < recent || !Number.isFinite(levels[last])) return null;
  const before = Math.max(...levels.slice(0, last - recent + 1));
  return levels[last] > before && levels[last] >= Math.max(...levels) ? levels[last] : null;
}

/** "<name>:<first day>" when the leader changed within the last week and has held for three days; otherwise null. */
function newLeader(names, dates, recent = RECENT_DAYS) {
  const last = names.length - 1;
  if (last < recent || names[last] == null || names[last] !== names[last - 1] || names[last] !== names[last - 2] || names[last] === names[last - recent]) return null;
  let start = last;
  while (start > 0 && names[start - 1] === names[last]) start--;
  return `${names[last]}:${dates[start]}`;
}

const base = (network, section, dates, options) => ({
  network, eyebrow: `${section} · Zcash ${network}`, dates, ticks: axisTicks(dates), ...timeline(dates.length, options),
});

// ─── Models ──────────────────────────────────────────────────────────────────

const POOLS = [
  { key: 'sprout', label: 'Sprout' },
  { key: 'sapling', label: 'Sapling' },
  { key: 'orchard', label: 'Orchard' },
  { key: 'ironwood', label: 'Ironwood' },
];

/**
 * `/v1/shielded-pools/history?period=all`: daily closing pool balances in
 * coins. Balances are stocks: each frame is one day's state, never a sum
 * across days.
 */
function poolGrowthModel(payload, options = {}) {
  const network = options.network || 'mainnet';
  const rows = unwrap(payload)?.points;
  if (!Array.isArray(rows) || rows.length < 30) return null;
  const days = [];
  for (const row of rows) {
    const date = isRecord(row) ? isoDay(row.date) : null;
    if (!date || row.hasPoolBreakdown !== true || !amount(row.chainSupply) || row.chainSupply <= 0 || !POOLS.every(pool => amount(row[pool.key]))) return null;
    const pools = POOLS.map(pool => row[pool.key]);
    days.push({ date, pools, shielded: pools.reduce((sum, value) => sum + value, 0), supply: row.chainSupply });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  const dates = days.map(day => day.date);
  if (!consecutive(dates)) return null;
  const unit = network === 'mainnet' ? 'ZEC' : 'TAZ';
  const started = POOLS.map((_, p) => days.findIndex(day => day.pools[p] > 0));
  return {
    ...base(network, 'Privacy', dates, options), days,
    headline: (i, final) => `${(final ? fmt : compact)(days[i].shielded)} ${unit}`,
    caption: (i, final) => `shielded · ${(days[i].shielded / days[i].supply * 100).toFixed(final ? 1 : 0)}% of supply`,
    chart: { kind: 'area', max: Math.max(...days.map(day => day.shielded)), series: POOLS.map((pool, p) => ({ ...pool, color: C[pool.key], values: days.map(day => day.pools[p]) })) },
    // A pool joins the legend once it holds a balance.
    legend: (i, final) => POOLS.map((pool, p) => ({ label: pool.label, color: C[pool.key], value: (final ? fmt : compact)(days[i].pools[p]), show: started[p] >= 0 && started[p] <= i })).filter(item => item.show),
    // A new whole percent of supply shielded.
    event: () => { const level = newLevel(days.map(day => Math.floor(day.shielded / day.supply * 100))); return level == null ? null : `share:${level}`; },
    post: () => ({
      lead: `${fmt(days.at(-1).shielded)} ${unit} is shielded: ${(days.at(-1).shielded / days.at(-1).supply * 100).toFixed(1)}% of supply.`,
      context: `The shielded pools since ${monthLabel(dates[0])}, day by day.`,
    }),
  };
}

const LEAD_IN_DAYS = 30;
const SOFTWARE = [
  { key: 'zakura', label: 'Zakura', color: C.zakura },
  { key: 'zebra', label: 'Zebra', color: C.gold },
  { key: 'other', label: 'zcashd', color: C.steel },
  { key: 'unknown', label: 'No tag', color: C.stone },
];

/**
 * `/v1/mining/software?period=1y&bucket=day`: blocks per self-reported
 * coinbase software tag. Shown as a trailing 7-day share so one quiet day
 * does not swing the picture; today's partial day is left out.
 *
 * A tag is what a miner chose to write, not proof of what it runs: before
 * Zebra tagged blocks automatically (July 2026) only a few pools wrote the
 * tag by hand, and one stopping looks like Zebra vanishing. So the wording is
 * "tagged", and the replay starts 30 days before the first Zakura tag, where
 * tagging is widespread enough for shares to mean something.
 */
function softwareShareModel(payload, options = {}, now = new Date()) {
  const network = options.network || 'mainnet';
  const data = unwrap(payload);
  if (!data || data.bucket !== 'day' || !Array.isArray(data.history)) return null;
  const rows = [];
  for (const row of data.history) {
    const date = isRecord(row) ? isoDay(row.date) : null;
    const counts = isRecord(row) ? row.counts : null;
    if (!date || !isRecord(counts) || !amount(row.total)) return null;
    if (date >= today(now)) continue;
    // Tag data the index could not read cannot be assigned to any software.
    if (!SOFTWARE.every(item => amount(counts[item.key])) || !amount(counts.missing) || counts.missing > 0) return null;
    rows.push({ date, total: row.total, counts: SOFTWARE.map(item => counts[item.key]) });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 60 || !consecutive(rows.map(row => row.date))) return null;
  const WINDOW = 7;
  const totals = trailing(rows.map(row => row.total), WINDOW);
  const sums = SOFTWARE.map((_, s) => trailing(rows.map(row => row.counts[s]), WINDOW));
  const kept = rows.map((row, i) => ({ date: row.date, total: totals[i], counts: sums.map(series => series[i]) })).filter(row => row.total != null && row.total > 0);
  const firstZakura = kept.findIndex(row => row.counts[0] > 0);
  if (firstZakura > LEAD_IN_DAYS) kept.splice(0, firstZakura - LEAD_IN_DAYS);
  if (kept.length < 30) return null;
  const share = (i, s) => kept[i].counts[s] / kept[i].total * 100;
  const tagged = SOFTWARE.map((_, s) => s).filter(s => SOFTWARE[s].key !== 'unknown');
  const leader = i => [...tagged].sort((a, b) => share(i, b) - share(i, a))[0];
  const started = SOFTWARE.map((_, s) => kept.findIndex(row => row.counts[s] > 0));
  const dates = kept.map(row => row.date);
  return {
    ...base(network, 'Mining', dates, { ease: 0.7, ...options }), days: kept,
    headline: (i, final) => `${share(i, leader(i)).toFixed(final ? 1 : 0)}%`,
    caption: i => `of blocks are tagged ${SOFTWARE[leader(i)].label} · 7-day share`,
    // Untagged blocks are the empty space above the areas: drawing them would fill the whole chart with grey.
    chart: { kind: 'area', max: 100, series: SOFTWARE.map((item, s) => ({ ...item, values: kept.map((_, i) => share(i, s)) })).filter(series => series.key !== 'unknown') },
    legend: (i, final) => SOFTWARE.map((item, s) => ({ label: item.label, color: item.color, value: `${share(i, s).toFixed(final ? 1 : 0)}%`, show: started[s] >= 0 && started[s] <= i })).filter(item => item.show),
    // A new leading tag, or the leader passing a new ten-point share.
    event: () => {
      const top = leader(kept.length - 1);
      const changed = newLeader(kept.map((_, i) => SOFTWARE[leader(i)].key), dates);
      if (changed) return `leader:${changed}`;
      const level = newLevel(kept.map((_, i) => Math.floor(share(i, top) / 10) * 10));
      return level == null ? null : `level:${SOFTWARE[top].key}:${level}`;
    },
    post: () => ({
      lead: `${share(kept.length - 1, leader(kept.length - 1)).toFixed(1)}% of Zcash blocks are tagged ${SOFTWARE[leader(kept.length - 1)].label}.`,
      context: `The 7-day share since ${monthLabel(dates[0])}. Miners write the tag themselves.`,
    }),
  };
}

/**
 * NEAR Intents `/v1/crosschain/analytics?period=all` (`trends`, daily):
 * successful swaps into and out of ZEC at provider-reported source-side USD.
 * One venue only; other venues are separate indexes and are not added.
 * Flows, so the counter is a running sum. Today's partial day is left out.
 */
function swapFlowModel(payload, options = {}, now = new Date()) {
  const data = unwrap(payload);
  if (!data || !isRecord(data.coverage) || data.coverage.stale !== false || !Array.isArray(data.trends)) return null;
  const rows = [];
  for (const row of data.trends) {
    const date = isRecord(row) ? isoDay(row.bucket) : null;
    const into = isRecord(row) ? decimal(row.inflow_usd) : null;
    const out = isRecord(row) ? decimal(row.outflow_usd) : null;
    if (!date || into == null || out == null) return null;
    if (date < today(now)) rows.push({ date, into, out });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 30) return null;
  // The index has no row for a day without swaps; those days are real zeros between the first and last swap.
  const byDate = new Map(rows.map(row => [row.date, row]));
  const days = [];
  for (let t = Date.parse(`${rows[0].date}T00:00:00Z`); t <= Date.parse(`${rows.at(-1).date}T00:00:00Z`); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.push(byDate.get(date) || { date, into: 0, out: 0 });
  }
  let into = 0, out = 0;
  const totals = days.map(day => ({ into: (into += day.into), out: (out += day.out) }));
  const dates = days.map(day => day.date);
  const usd = (value, final) => `$${final ? (value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : `${(value / 1e6).toFixed(1)}M`) : compact(value)}`;
  return {
    ...base('mainnet', 'Cross-chain', dates, { ease: 0.7, ...options }), eyebrow: 'Cross-chain · NEAR Intents', days, totals,
    headline: (i, final) => usd(totals[i].into, final),
    caption: () => 'swapped into ZEC via NEAR Intents',
    // Bars are weeks so each one is wide enough to read; the counter still advances by day.
    chart: { kind: 'mirror', group: 7, up: days.map(day => day.into), down: days.map(day => day.out), upColor: C.in, downColor: C.out },
    legend: (i, final) => [
      { label: 'Into ZEC', color: C.in, value: usd(totals[i].into, final) },
      { label: 'Out of ZEC', color: C.out, value: usd(totals[i].out, final) },
    ],
    // Another $250M swapped into ZEC.
    event: () => { const level = newLevel(totals.map(total => Math.floor(total.into / SWAP_STEP_USD))); return level == null ? null : `into:${level * SWAP_STEP_USD / 1e6}M`; },
    post: () => ({
      lead: `${usd(totals.at(-1).into, true)} swapped into ZEC through NEAR Intents since ${monthLabel(dates[0])}.`,
      context: `${usd(totals.at(-1).out, true)} went the other way. Week by week.`,
    }),
  };
}

const SWAP_STEP_USD = 250_000_000;
const MAX_SUPPLY = 21_000_000;

/** `/v1/network/emission` (`supplyHistory`): issued supply at each UTC day's last observation, toward the 21M cap. */
function supplyModel(payload, options = {}) {
  const network = options.network || 'mainnet';
  const rows = unwrap(payload)?.supplyHistory;
  if (!Array.isArray(rows) || rows.length < 30) return null;
  const days = [];
  for (const row of rows) {
    const date = isRecord(row) ? isoDay(row.date) : null;
    if (!date || !Number.isSafeInteger(row.circulatingZat) || row.circulatingZat <= 0) return null;
    days.push({ date, supply: row.circulatingZat / 1e8 });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  const dates = days.map(day => day.date);
  // Issued supply never falls; a drop means the source mixed two definitions.
  if (!consecutive(dates) || days.some((day, i) => i > 0 && day.supply < days[i - 1].supply) || days.at(-1).supply > MAX_SUPPLY) return null;
  const unit = network === 'mainnet' ? 'ZEC' : 'TAZ';
  return {
    ...base(network, 'Supply', dates, { ease: 0.8, ...options }), days,
    headline: (i, final) => `${(final ? fmt : compact)(days[i].supply)} ${unit}`,
    caption: (i, final) => `issued · ${(days[i].supply / MAX_SUPPLY * 100).toFixed(final ? 1 : 0)}% of the 21M cap`,
    chart: { kind: 'area', max: MAX_SUPPLY, capLabel: `21M ${unit} cap`, series: [{ key: 'supply', label: 'Issued', color: C.gold, values: days.map(day => day.supply) }] },
    legend: () => [],
    // Another whole percent of the cap issued.
    event: () => { const level = newLevel(days.map(day => Math.floor(day.supply / MAX_SUPPLY * 100))); return level == null ? null : `cap:${level}`; },
    post: () => ({
      lead: `${fmt(days.at(-1).supply)} ${unit} has been issued: ${(days.at(-1).supply / MAX_SUPPLY * 100).toFixed(1)}% of the 21M cap.`,
      context: `Zcash issuance since ${monthLabel(dates[0])}, day by day.`,
    }),
  };
}

/**
 * `/v1/privacy/stats?days=3650` (`trends.daily`): shielded and transparent
 * non-coinbase transactions per UTC day, as a trailing 30-day share.
 */
function shieldedShareModel(payload, options = {}, now = new Date()) {
  const network = options.network || 'mainnet';
  const trends = unwrap(payload)?.trends;
  const rows = isRecord(trends) && Array.isArray(trends.daily) ? trends.daily : null;
  if (!rows) return null;
  const days = [];
  for (const row of rows) {
    const date = isRecord(row) ? isoDay(row.date) : null;
    if (!date || !amount(row.shielded) || !amount(row.transparent)) return null;
    if (date < today(now)) days.push({ date, shielded: row.shielded, total: row.shielded + row.transparent });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 120 || !consecutive(days.map(day => day.date))) return null;
  const WINDOW = 30;
  const shielded = trailing(days.map(day => day.shielded), WINDOW);
  const total = trailing(days.map(day => day.total), WINDOW);
  const kept = days.map((day, i) => ({ date: day.date, share: total[i] ? shielded[i] / total[i] * 100 : null })).filter(day => day.share != null);
  const dates = kept.map(day => day.date);
  return {
    ...base(network, 'Privacy', dates, { ease: 0.8, ...options }), days: kept,
    headline: (i, final) => `${kept[i].share.toFixed(final ? 1 : 0)}%`,
    caption: () => 'of transactions are shielded · 30-day share',
    chart: { kind: 'area', max: 100, series: [{ key: 'shielded', label: 'Shielded', color: C.ironwood, values: kept.map(day => day.share) }] },
    legend: () => [],
    // The 30-day share reaching a new whole percent for the first time in this series.
    event: () => { const level = newLevel(kept.map(day => Math.floor(day.share))); return level == null ? null : `share:${level}`; },
    post: () => ({
      lead: `${kept.at(-1).share.toFixed(1)}% of Zcash transactions are shielded.`,
      context: `The 30-day share since ${monthLabel(dates[0])}.`,
    }),
  };
}

const hashrateLabel = value => (value >= 1e9 ? `${(value / 1e9).toFixed(value >= 1e10 ? 1 : 2)} GSol/s` : value >= 1e6 ? `${(value / 1e6).toFixed(1)} MSol/s` : `${(value / 1e3).toFixed(1)} KSol/s`);

/** `/v1/mining/hashrate-history?period=all`: closed 24-hour windows only, as a trailing 7-day mean. */
function hashrateModel(payload, options = {}, now = new Date()) {
  const network = options.network || 'mainnet';
  const rows = unwrap(payload)?.points;
  if (!Array.isArray(rows)) return null;
  const days = [];
  for (const row of rows) {
    const end = isRecord(row) && typeof row.windowEnd === 'string' ? Date.parse(row.windowEnd) : NaN;
    const date = isRecord(row) ? isoDay(row.windowStart) : null;
    if (!date || !Number.isFinite(end)) return null;
    if (end > now.getTime()) continue;
    if (row.unavailableReason != null || !amount(row.hashrate) || row.hashrate <= 0) return null;
    days.push({ date, hashrate: row.hashrate });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 60 || !consecutive(days.map(day => day.date))) return null;
  const sums = trailing(days.map(day => day.hashrate), 7);
  const kept = days.map((day, i) => ({ date: day.date, hashrate: sums[i] == null ? null : sums[i] / 7 })).filter(day => day.hashrate != null);
  const dates = kept.map(day => day.date);
  return {
    ...base(network, 'Mining', dates, { ease: 0.8, ...options }), days: kept,
    headline: i => hashrateLabel(kept[i].hashrate),
    caption: () => 'network hashrate · 7-day average',
    chart: { kind: 'area', max: Math.max(...kept.map(day => day.hashrate)), series: [{ key: 'hashrate', label: 'Hashrate', color: C.gold, values: kept.map(day => day.hashrate) }] },
    legend: () => [],
    // A record 7-day average passing a new round level: half the leading power of ten, so 5 GSol/s steps at 32 GSol/s.
    event: () => {
      const values = kept.map(day => day.hashrate);
      const step = 10 ** Math.floor(Math.log10(Math.max(...values))) / 2;
      const level = newLevel(values.map(value => Math.floor(value / step)));
      return level == null ? null : `record:${hashrateLabel(level * step)}`;
    },
    post: () => ({
      lead: `Zcash hashrate is ${hashrateLabel(kept.at(-1).hashrate)}, as a 7-day average.`,
      context: `Every day since ${monthLabel(dates[0])}.`,
    }),
  };
}

/**
 * `/v1/mining/hashrate-share?period=all`: each pool's share of a UTC day's
 * blocks. Shown as a trailing 30-day share of blocks (weighted by each day's
 * block count), top five pools. "Unknown" is unattributed blocks, not a pool,
 * and never leads.
 */
function poolRaceModel(payload, options = {}, now = new Date()) {
  const network = options.network || 'mainnet';
  const rows = unwrap(payload)?.series;
  if (!Array.isArray(rows)) return null;
  const days = [];
  for (const row of rows) {
    const date = isRecord(row) ? isoDay(row.date) : null;
    if (!date || !amount(row.totalBlocks) || !isRecord(row.pools) || !Object.values(row.pools).every(amount)) return null;
    if (date < today(now)) days.push({ date, total: row.totalBlocks, pools: row.pools });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 120 || !consecutive(days.map(day => day.date))) return null;
  const WINDOW = 30;
  const names = [...new Set(days.flatMap(day => Object.keys(day.pools)))].filter(name => name !== 'Unknown');
  const totals = trailing(days.map(day => day.total), WINDOW);
  const blocks = Object.fromEntries(names.map(name => [name, trailing(days.map(day => (day.pools[name] || 0) * day.total), WINDOW)]));
  const start = WINDOW - 1;
  const allDates = days.slice(start).map(day => day.date);
  const ranked = allDates.map((_, k) => names.map(name => ({ name, share: blocks[name][k + start] / totals[k + start] * 100 })).filter(pool => pool.share > 0).sort((a, b) => b.share - a.share).slice(0, 5));
  // Attribution starts after genesis; the replay starts with the first identified pool.
  const first = ranked.findIndex(row => row.length > 0);
  if (first < 0 || allDates.length - first < 90) return null;
  const race = ranked.slice(first);
  const dates = allDates.slice(first);
  if (race.some(row => row.length === 0)) return null;
  return {
    ...base(network, 'Mining', dates, { ease: 0.8, ...options }), days: race,
    headline: i => race[i][0].name,
    caption: (i, final) => `mines the most blocks · ${race[i][0].share.toFixed(final ? 1 : 0)}% over 30 days`,
    chart: { kind: 'race', rows: race, max: Math.max(...race.map(row => row[0].share)) },
    legend: () => [],
    // A different pool in first place.
    event: () => { const changed = newLeader(race.map(row => row[0].name), dates); return changed ? `leader:${changed}` : null; },
    post: () => ({
      lead: `${race.at(-1)[0].name} mines the most Zcash blocks: ${race.at(-1)[0].share.toFixed(1)}% over 30 days.`,
      context: `The top five pools since ${monthLabel(dates[0])}.`,
    }),
  };
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

let fontsReady = false;
function canvasApi() {
  const canvas = require('canvas');
  if (!fontsReady) {
    const font = name => path.join(ASSETS, 'fonts', name);
    canvas.registerFont(font('Geist-Medium.ttf'), { family: 'Geist', weight: '500' });
    canvas.registerFont(font('Geist-Regular.ttf'), { family: 'Geist', weight: 'normal' });
    canvas.registerFont(font('GeistMono-Regular.ttf'), { family: 'GeistMono', weight: 'normal' });
    fontsReady = true;
  }
  return canvas;
}

const CHART = { x: PAD, y: 322, w: W - 2 * PAD, h: 228 };
const RACE_COLORS = [C.gold, C.ironwood, C.orchard, C.sapling, C.steel];

function drawArea(ctx, model, upto) {
  const { chart } = model;
  const last = model.dates.length - 1;
  const x = i => CHART.x + i / last * CHART.w;
  const y = value => CHART.y + CHART.h - Math.min(1, value / chart.max) * CHART.h;
  if (chart.capLabel) {
    ctx.strokeStyle = C.faint;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(CHART.x, CHART.y + 0.5);
    ctx.lineTo(CHART.x + CHART.w, CHART.y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'normal 15px GeistMono';
    ctx.fillStyle = C.muted;
    ctx.fillText(chart.capLabel, CHART.x + CHART.w - ctx.measureText(chart.capLabel).width, CHART.y - 10);
  }
  // One sample per pixel column at most, always ending on the current point.
  const step = Math.max(1, Math.floor(last / CHART.w));
  const idx = [];
  for (let i = 0; i <= upto; i += step) idx.push(i);
  if (idx[idx.length - 1] !== upto) idx.push(upto);
  const floor = idx.map(() => 0);
  for (const series of chart.series) {
    const top = idx.map((i, k) => floor[k] + series.values[i]);
    ctx.beginPath();
    idx.forEach((i, k) => (k ? ctx.lineTo(x(i), y(top[k])) : ctx.moveTo(x(i), y(top[k]))));
    for (let k = idx.length - 1; k >= 0; k--) ctx.lineTo(x(idx[k]), y(floor[k]));
    ctx.closePath();
    ctx.fillStyle = series.color;
    ctx.fill();
    top.forEach((value, k) => { floor[k] = value; });
  }
  const head = y(floor[floor.length - 1]);
  ctx.fillStyle = C.text;
  ctx.fillRect(x(upto), head - 6, 1.5, CHART.y + CHART.h - head + 6);
  ctx.beginPath();
  ctx.arc(x(upto) + 0.75, head - 6, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawMirror(ctx, model, upto) {
  const { chart } = model;
  const count = model.dates.length;
  const groups = Math.ceil(count / chart.group);
  const sum = (values, g, end) => { let total = 0; for (let i = g * chart.group; i < Math.min((g + 1) * chart.group, end + 1); i++) total += values[i]; return total; };
  // Scale to the tallest complete bar of the whole history, so heights do not rescale as the replay runs.
  let max = 0;
  for (let g = 0; g < groups; g++) max = Math.max(max, sum(chart.up, g, count - 1), sum(chart.down, g, count - 1));
  const mid = CHART.y + CHART.h / 2;
  const half = CHART.h / 2 - 2;
  const slot = CHART.w / groups;
  const bar = Math.max(1, slot * 0.72);
  for (let g = 0; g * chart.group <= upto; g++) {
    const x = CHART.x + g * slot + (slot - bar) / 2;
    const up = sum(chart.up, g, upto) / max * half;
    const down = sum(chart.down, g, upto) / max * half;
    ctx.fillStyle = chart.upColor;
    ctx.fillRect(x, mid - 2 - up, bar, up);
    ctx.fillStyle = chart.downColor;
    ctx.fillRect(x, mid + 2, bar, down);
  }
}

function drawRace(ctx, model, upto, shown) {
  const { chart } = model;
  // Order follows the text step so rows do not reshuffle faster than they can be read; widths move every frame.
  const order = chart.rows[shown];
  const current = new Map(chart.rows[upto].map(pool => [pool.name, pool.share]));
  const labelWidth = 230, valueWidth = 90;
  const barMax = CHART.w - labelWidth - valueWidth;
  order.forEach((pool, r) => {
    const y = CHART.y + 6 + r * 46;
    const share = current.get(pool.name) ?? pool.share;
    ctx.font = 'normal 22px Geist';
    ctx.fillStyle = r === 0 ? C.text : C.secondary;
    ctx.fillText(pool.name, CHART.x, y + 21);
    ctx.fillStyle = C.track;
    ctx.fillRect(CHART.x + labelWidth, y + 6, barMax, 14);
    ctx.fillStyle = RACE_COLORS[r];
    ctx.fillRect(CHART.x + labelWidth, y + 6, Math.max(3, share / chart.max * barMax), 14);
    ctx.fillStyle = C.text;
    const value = `${pool.share.toFixed(0)}%`;
    ctx.fillText(value, CHART.x + CHART.w - ctx.measureText(value).width, y + 21);
  });
}

function drawFrame(ctx, model, frame, logo) {
  const upto = model.frames[frame];
  const shown = model.text[frame];
  const last = model.dates.length - 1;
  const final = shown === last;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // Header
  ctx.font = 'normal 18px Geist';
  ctx.fillStyle = C.muted;
  ctx.fillText(model.eyebrow.toUpperCase().split('').join(' '), PAD, 72);
  if (logo) ctx.drawImage(logo, W - PAD - 138, 48, 138, 32);

  // Counter
  const headline = model.headline(shown, final);
  let size = 112;
  ctx.font = `500 ${size}px Geist`;
  while (ctx.measureText(headline).width > W - 2 * PAD && size > 56) { size -= 4; ctx.font = `500 ${size}px Geist`; }
  ctx.fillStyle = C.text;
  ctx.fillText(headline, PAD - 4, 212);
  ctx.font = 'normal 32px Geist';
  ctx.fillText(model.caption(shown, final), PAD, 262);
  // The date sits at the right of the caption line, so nothing is stacked under the caption.
  ctx.font = 'normal 24px GeistMono';
  ctx.fillStyle = C.muted;
  const long = model.dates.length > 900;
  const when = final ? dayLabel(model.dates[shown]) : long ? model.dates[shown].slice(0, 4) : monthLabel(model.dates[shown]);
  ctx.fillText(when, W - PAD - ctx.measureText(when).width, 262);

  // Time axis: the whole history is on screen from the first frame.
  if (model.chart.kind !== 'race') {
    ctx.fillStyle = C.grid;
    ctx.fillRect(CHART.x, model.chart.kind === 'mirror' ? CHART.y + CHART.h / 2 - 0.5 : CHART.y + CHART.h, CHART.w, 1);
    ctx.font = 'normal 15px GeistMono';
    for (const tick of model.ticks) {
      ctx.fillStyle = tick.index <= upto ? C.muted : C.faint;
      const width = ctx.measureText(tick.label).width;
      ctx.fillText(tick.label, Math.min(CHART.x + CHART.w - width, Math.max(CHART.x, CHART.x + tick.index / last * CHART.w - width / 2)), CHART.y + CHART.h + 24);
    }
  }

  if (model.chart.kind === 'area') drawArea(ctx, model, upto);
  else if (model.chart.kind === 'mirror') drawMirror(ctx, model, upto);
  else drawRace(ctx, model, upto, shown);

  // Legend
  let lx = PAD;
  ctx.font = 'normal 19px Geist';
  for (const item of model.legend(shown, final)) {
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(lx + 5, 611, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.secondary;
    ctx.fillText(item.label, lx + 18, 618);
    lx += 18 + ctx.measureText(item.label).width + 10;
    ctx.fillStyle = C.text;
    ctx.fillText(item.value, lx, 618);
    lx += ctx.measureText(item.value).width + 32;
  }
  ctx.font = 'normal 15px Geist';
  ctx.fillStyle = C.muted;
  ctx.fillText('zecblock.com', W - PAD - ctx.measureText('zecblock.com').width, 618);
}

/**
 * Renders a model to an H.264 MP4 (X plays MP4; a GIF upload is converted to
 * one anyway). Frames are piped to ffmpeg, so nothing is written but the
 * output file. Rejects when ffmpeg is missing or exits non-zero.
 */
async function renderVideo(model, output, { ffmpeg = 'ffmpeg' } = {}) {
  const { createCanvas, loadImage } = canvasApi();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const logo = await loadImage(LOGO).catch(() => null);
  // yuv420p needs even dimensions; one background-coloured row is added below the 675px card.
  const child = spawn(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-vf', `pad=${W}:${H + 1}:0:0:color=${C.bg.replace('#', '0x')}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output],
  { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`))));
  });
  child.stdin.on('error', () => {});
  for (let frame = 0; frame < model.frames.length; frame++) {
    drawFrame(ctx, model, frame, logo);
    if (!child.stdin.write(canvas.toBuffer('raw'))) await new Promise(resolve => child.stdin.once('drain', resolve));
  }
  child.stdin.end();
  await done;
  return { output, frames: model.frames.length, fps: FPS, seconds: model.frames.length / FPS };
}

/** One frame as PNG, for review. */
async function renderStill(model, frame) {
  const { createCanvas, loadImage } = canvasApi();
  const canvas = createCanvas(W, H);
  drawFrame(canvas.getContext('2d'), model, frame, await loadImage(LOGO).catch(() => null));
  return canvas.toBuffer('image/png');
}

/** Every animation: where its data comes from and how to build its model. */
const ANIMATIONS = {
  pools: { path: '/v1/shielded-pools/history?period=all', build: poolGrowthModel, page: '/pools', networks: ['mainnet', 'testnet'] },
  software: { path: '/v1/mining/software?period=1y&bucket=day', build: softwareShareModel, page: '/mining', networks: ['mainnet', 'testnet'] },
  swaps: { path: '/v1/crosschain/analytics?period=all', build: swapFlowModel, page: '/crosschain', networks: ['mainnet'] },
  supply: { path: '/v1/network/emission', build: supplyModel, page: '/network', networks: ['mainnet', 'testnet'] },
  'shielded-share': { path: '/v1/privacy/stats?days=3650', build: shieldedShareModel, page: '/privacy', networks: ['mainnet', 'testnet'] },
  hashrate: { path: '/v1/mining/hashrate-history?period=all', build: hashrateModel, page: '/mining', networks: ['mainnet', 'testnet'] },
  'pool-race': { path: '/v1/mining/hashrate-share?period=all', build: poolRaceModel, page: '/mining', networks: ['mainnet', 'testnet'] },
};

module.exports = {
  ANIMATIONS, poolGrowthModel, softwareShareModel, swapFlowModel, supplyModel, shieldedShareModel, hashrateModel, poolRaceModel,
  renderVideo, renderStill, timeline, compact, newLevel, newLeader, FPS, TEXT_STEP_FRAMES,
};
