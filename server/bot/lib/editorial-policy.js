'use strict';

const { addDays } = require('../../lib/transaction-activity');
const { formatHashrate } = require('../../api/lib/hashrate');
const f = require('./editorial-format');
const BASE = 'https://zecblock.com';
const number = f.number;
const MARK = '🟨';

// Copy leads with the event in plain words, then one line on why it matters.
// Every claim still comes from the evidence below; the image is described by
// `card` so the tweet and the card can never disagree.
function candidate(type, key, content, evidence, score = 0) {
  if (content.length > 280) throw new Error(`Editorial copy exceeds 280 characters: ${key}`);
  return { type, key, content, evidence: { ...evidence, editorialVersion: 1, copyVersion: 2 }, score };
}

function eventTime(story) {
  // Stories with their own observed instant (NU7) carry it explicitly.
  if (story.evidence?.eventAt) return Date.parse(story.evidence.eventAt);
  if (story.type.startsWith('flow_') || story.type === 'migration') return Number(story.evidence.block_time) * 1000;
  if (story.type === 'swap') return Date.parse(story.evidence.swap_created_at);
  if (story.type === 'reorg') return Date.parse(story.evidence.detected_at);
  if (story.type === 'activity_weekly') return Date.parse(`${story.evidence.period.endExclusive}T06:00:00Z`);
  // Daily stories become eligible only as a newly completed reporting period,
  // after the six-hour data settling window. Their observations remain dated.
  const target = story.evidence.target || story.key.split(':').at(-1);
  return Date.parse(`${addDays(target, 1)}T06:00:00Z`);
}

function isNew(story, activatedAt) {
  const time = eventTime(story);
  return Number.isFinite(time) && time >= Date.parse(activatedAt);
}

function comparison(values) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) return null;
  const value = values.at(-1), prior = values.slice(0, -1);
  if (!prior.length) return null;
  const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
  const std = Math.sqrt(prior.reduce((s, v) => s + (v - mean) ** 2, 0) / prior.length);
  return { value, mean, previous: prior.at(-1), samples: prior.length,
    changePct: mean > 0 ? 100 * (value / mean - 1) : null,
    z: std > 0 ? (value - mean) / std : null,
    greater: prior.filter(v => v > value).length, equal: prior.filter(v => v === value).length,
    high: value > Math.max(...prior), low: value < Math.min(...prior) };
}

function completeSeries(rows, target, length) {
  return rows.length === length && rows.every((r, i) => r.date === addDays(target, i - length + 1));
}

const positivePrice = n => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null);
const balance = zat => (Number.isFinite(Number(zat)) && Number(zat) > 0 ? Number(zat) / 1e8 : null);

function dailyActivity(activity, target) {
  if (!completeSeries(activity.days, target, 31)) return null;
  const definitions = [
    ['share', d => d.shielded + d.transparent > 0 ? 100 * d.shielded / (d.shielded + d.transparent) : NaN],
    ['shielded', d => d.shielded],
    ['fully', d => d.fully_shielded],
    ['total', d => d.shielded + d.transparent],
  ];
  // Coinbase is excluded from every count; only the total needs saying so.
  const nouns = { shielded: 'Zcash transactions used a shielded pool', fully: 'fully shielded Zcash transactions',
    total: 'Zcash transactions, excluding mining rewards' };
  const cardNouns = { share: 'of transactions used a shielded pool.', shielded: 'transactions used a shielded pool.',
    fully: 'fully shielded transactions.', total: 'transactions, excluding mining rewards.' };
  const day = f.dayText(target);
  const choices = definitions.map(([metric, get]) => {
    const values = activity.days.map(get);
    const stats = comparison(values);
    if (!stats) return null;
    const noteworthy = stats.high || stats.low || (stats.z !== null && Math.abs(stats.z) >= 3);
    const share = metric === 'share';
    // A daily post needs a material finding. A new high by a fraction, or an
    // unchanged daily percentage, is useful dashboard data but not a story.
    const material = share ? Math.abs(stats.value - stats.mean) >= 2
      : stats.changePct !== null && Math.abs(stats.changePct) >= 20;
    if (!noteworthy || !material) return null;
    const value = share ? `${stats.value.toFixed(1)}%` : number(stats.value);
    const mean = share ? `${stats.mean.toFixed(1)}%` : number(stats.mean);
    const dir = stats.value >= stats.mean ? 'above' : 'below';
    const delta = share ? `${Math.abs(stats.value - stats.mean).toFixed(1)} percentage points ${dir} the 30-day average (${mean})`
      : stats.changePct === null ? `30-day average: ${mean}` : `${Math.abs(stats.changePct).toFixed(1)}% ${dir} the 30-day average (${mean})`;
    const context = stats.high ? 'The highest in 31 days' : stats.low ? 'The lowest in 31 days' : null;
    const topic = { share: 'Zcash’s shielded transaction share', shielded: 'Shielded Zcash transaction activity',
      fully: 'Fully shielded Zcash transaction activity', total: 'Zcash transaction activity' }[metric];
    const lead = context ? `${topic} hit a 31-day ${stats.high ? 'high' : 'low'}.`
      : `${topic} moved ${dir} its recent baseline.`;
    const observation = share ? `${value} on ${day}` : `${value} ${nouns[metric]} on ${day}`;
    const content = `${MARK} ${lead}\n\n${observation}, ${delta}.\n\n${BASE}/privacy`;
    const shortDelta = share ? `${stats.value >= stats.mean ? '+' : '−'}${Math.abs(stats.value - stats.mean).toFixed(1)} pts vs 30-day average.`
      : stats.changePct === null ? `30-day average: ${mean}.` : `${f.signedPct(stats.changePct)} vs 30-day average.`;
    const card = { kicker: 'Activity · Daily', title: lead, hero: value, tone: 'gold', line: cardNouns[metric],
      qualifier: context ? `${context}.` : shortDelta, source: 'zecblock.com/privacy', date: f.dayYear(target),
      visual: { kind: 'series', values, reference: stats.mean, referenceLabel: '30-day average',
        label: share ? 'Shielded transaction share' : cardNouns[metric].replace(/\.$/, ''),
        unit: share ? '%' : 'transactions', start: activity.days[0].date, end: target,
        ...(share ? { scale: { min: 0, max: 100 } } : {}) } };
    const significance = 45 + Math.min(20, share ? Math.abs(stats.value - stats.mean) * 2 : Math.abs(stats.changePct) / 4)
      + Math.min(Math.abs(stats.z || 0), 5) * 2;
    return candidate('activity_daily', `analysis:activity:${target}`, content, { ...activity, metric, stats, card,
      editorial: { topic: 'transaction_activity', lens: stats.high ? 'record_high' : stats.low ? 'record_low' : 'baseline_change', significance } }, significance);
  }).filter(Boolean);
  return choices.sort((a, b) => b.score - a.score)[0] || null;
}

function weeklyActivity(draft) {
  if (!draft) return null;
  const m = draft.metadata.metrics.find(m => m.noteworthy);
  if (!m || !Number.isFinite(m.value) || !Number.isInteger(m.rank)) return null;
  const fully = m.metric === 'fully_shielded';
  const noun = fully ? 'fully shielded Zcash transactions' : 'Zcash transactions used a shielded pool';
  const end = addDays(draft.metadata.period.endExclusive, -1);
  const doubled = m.changePct !== null && m.changePct >= 100;
  let rankLine, cardRank;
  if (m.rank === 1) {
    rankLine = m.tied ? 'Tied for the busiest week on record.' : 'The busiest week on record.';
    cardRank = m.tied ? 'Joint busiest week on record.' : 'Busiest week on record.';
  } else if (m.rank <= 10) {
    rankLine = m.tied ? `Tied for the ${f.ORDINALS[m.rank]}-busiest week on record.`
      : `Only ${f.WORDS[m.rank - 1]} week${m.rank === 2 ? '' : 's'} in Zcash history ${m.rank === 2 ? 'was' : 'were'} busier.`;
    cardRank = `${m.tied ? 'Joint ' : ''}${f.ORDINALS[m.rank]}-busiest week on record.`;
  } else if (m.weeksSince === null || m.weeksSince >= 52) {
    rankLine = m.lastAtLeast ? `The busiest week since ${f.dayYear(m.lastAtLeast)}.` : 'The busiest week on record.';
    cardRank = m.lastAtLeast ? `Busiest since ${f.dayYear(m.lastAtLeast)}.` : 'Busiest week on record.';
  } else {
    rankLine = 'More than double the week before.';
    cardRank = 'More than double the week before.';
  }
  const change = m.changePct === null || (doubled && m.rank > 10 && m.weeksSince !== null && m.weeksSince < 52) ? ''
    : ` ${m.changePct >= 0 ? 'Up' : 'Down'} ${Math.abs(m.changePct).toFixed(1)}% on the week before.`;
  const card = { kicker: 'Activity · Weekly', title: rankLine, hero: number(m.value), tone: 'gold',
    line: fully ? 'fully shielded transactions.' : 'transactions used a shielded pool.', qualifier: cardRank,
    source: 'zecblock.com/privacy', date: f.rangeText(draft.week, end),
    visual: m.rank <= 10 ? { kind: 'rank', rank: m.rank, tied: Boolean(m.tied) } : null };
  return candidate('activity_weekly', `analysis:week:${draft.week}`,
    `${MARK} ${number(m.value)} ${noun} last week.\n\n${rankLine}${change}\n\n${BASE}/privacy`, { ...draft.metadata, card }, 80);
}

// Shared by flows and migrations: public side on top, shielded pools below.
function poolNode(name, zec, detail, style) {
  return { name, detail: zec ? `${f.zecShort(zec)} ZEC · ${detail}` : detail, style };
}

function flowStory(flow) {
  const amount = Number(flow.amount_zat), n = Number(flow.sample_count);
  const greater = Number(flow.greater_count), equal = Number(flow.equal_count);
  if (!['shield', 'deshield'].includes(flow.flow_type) || !Number.isSafeInteger(amount) || amount < 500e8
    || !Number.isSafeInteger(n) || n < 100 || ![greater, equal].every(v => Number.isSafeInteger(v) && v >= 0)
    || greater + equal > n) return null;
  // Inclusive upper tail handles ties honestly. No extrapolated percentile.
  const tailPct = 100 * (greater + equal + 1) / (n + 1);
  if (tailPct > 0.5) return null;
  if (!/^[a-f0-9]{64}$/.test(flow.txid) || !['sapling', 'orchard', 'ironwood', 'mixed'].includes(flow.pool)) return null;
  const into = flow.flow_type === 'shield';
  const pool = f.POOLS[flow.pool];
  const where = pool || 'the shielded pools';
  const price = positivePrice(flow.price_usd);
  const usd = price ? (amount / 1e8) * price : null;
  const held = balance(flow.pool_zat), transparent = balance(flow.transparent_zat);
  const tail = f.tailText(tailPct), amt = f.zecText(amount);
  const largest = greater === 0 && equal === 0;
  const holds = held ? ` ${pool || 'Shielded pools'} now ${pool ? 'holds' : 'hold'} ${f.zecShort(held)} ZEC.` : '';
  const content = `${MARK} ${amt} ZEC${usd ? ` (${f.usdShort(usd)})` : ''} just ${into ? 'entered' : 'left'} ${where}.\n\n`
    + `${largest ? `The largest ${into ? 'shielding' : 'deshielding'} transaction in 90 days.`
      : `One of the largest ${tail}% of ${into ? 'shielding' : 'deshielding'} transactions in 90 days.`}${holds}\n\n${BASE}/tx/${flow.txid}`;
  const card = { kicker: `${into ? 'Shielding' : 'Deshielding'} · ${pool || 'Shielded pools'}`,
    title: `${amt} ZEC ${into ? 'entered' : 'left'} ${where}.`, hero: `${into ? '+' : '−'}${amt}`,
    unit: 'ZEC', tone: into ? 'in' : 'out',
    line: `${into ? 'entered' : 'left'} ${where}${usd ? ` (≈ ${f.usdShort(usd)})` : '.'}`,
    qualifier: largest ? `Largest ${into ? 'shield' : 'deshield'} in 90 days.` : `Top ${tail}% of ${into ? 'shields' : 'deshields'} in 90 days.`,
    source: `zecblock.com/tx/${f.shortTxid(flow.txid)}`, date: f.timeText(Number(flow.block_time)),
    visual: { kind: 'transfer', direction: into ? 'down' : 'up',
      top: poolNode('Transparent', transparent, 'public', 'outline'),
      bottom: poolNode(pool || 'Shielded pools', held, 'shielded', flow.pool === 'mixed' ? 'gold' : flow.pool) } };
  return candidate(`flow_${flow.flow_type}`, `large_flow:${flow.txid}`, content,
    { ...flow, tailPct, usd, card, editorial: { topic: 'public_flow_event', lens: largest ? 'record_high' : 'large_event' } }, amount / 1e8);
}

function swapStory(swap) {
  const usd = Number(swap.source_amount_usd), n = Number(swap.sample_count);
  const larger = Number(swap.greater_count), equal = Number(swap.equal_count);
  if (!Number.isFinite(usd) || usd < 50000 || !Number.isSafeInteger(n) || n < 100
    || ![larger, equal].every(v => Number.isSafeInteger(v) && v >= 0) || larger + equal > n
    || !swap.source_chain || !swap.dest_chain) return null;
  const tailPct = 100 * (larger + equal + 1) / (n + 1);
  if (tailPct > 1) return null;
  if (![swap.source_chain, swap.dest_chain].every(c => /^[a-z0-9_-]{1,16}$/i.test(c))) return null;
  const into = swap.dest_chain.toLowerCase() === 'zec';
  if (!into && swap.source_chain.toLowerCase() !== 'zec') return null;
  const other = into ? swap.source_chain : swap.dest_chain;
  const route = into ? `from ${f.chainName(other)} into ZEC` : `from ZEC to ${f.chainName(other)}`;
  const largest = larger === 0 && equal === 0;
  const tail = f.tailText(tailPct);
  const url = /^[a-f0-9]{64}$/.test(swap.zec_txid || '') ? `${BASE}/tx/${swap.zec_txid}` : `${BASE}/crosschain`;
  const content = `${MARK} $${number(usd)} just crossed ${route}.\n\n`
    + `${largest ? 'The largest ZEC swap' : `One of the largest ${tail}% of ZEC swaps`} we've tracked on NEAR Intents in 30 days.\n\n${url}`;
  const card = { kicker: 'Cross-chain · NEAR Intents', title: `A ZEC swap crossed ${route}.`, hero: `$${number(usd)}`, tone: into ? 'in' : 'out',
    line: `crossed ${route}.`, qualifier: largest ? 'Largest ZEC swap in 30 days.' : `Top ${tail}% of ZEC swaps in 30 days.`,
    source: url.startsWith(`${BASE}/tx/`) ? `zecblock.com/tx/${f.shortTxid(swap.zec_txid)}` : 'zecblock.com/crosschain',
    date: f.timeText(Date.parse(swap.swap_created_at) / 1000),
    visual: { kind: 'swap', from: swap.source_chain.toLowerCase(), to: swap.dest_chain.toLowerCase() } };
  return candidate('swap', `cross_chain:${swap.id}`, content,
    { ...swap, tailPct, exceptional: usd >= 1000000 && tailPct <= 0.1, card }, usd);
}

function migrationStory(row) {
  const amount = Number(row.amount_zat);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[a-f0-9]{64}$/.test(row.txid)) return null;
  const price = positivePrice(row.price_usd);
  const usd = price ? (amount / 1e8) * price : null;
  const ironwood = balance(row.ironwood_zat), orchard = balance(row.orchard_zat);
  const amt = f.zecText(amount);
  const content = `${MARK} ${amt} ZEC${usd ? ` (${f.usdShort(usd)})` : ''} just moved from Orchard to Ironwood.\n\n`
    + `A pool-to-pool migration, so no new ZEC was shielded.${ironwood ? ` Ironwood now holds ${f.zecShort(ironwood)} ZEC.` : ''}\n\n${BASE}/tx/${row.txid}`;
  const card = { kicker: 'Migration · Orchard → Ironwood', title: 'ZEC moved from Orchard to Ironwood.', hero: amt, unit: 'ZEC', tone: 'ironwood',
    line: `moved to Ironwood${usd ? ` (≈ ${f.usdShort(usd)})` : '.'}`, qualifier: 'Pool migration, not new shielding.',
    source: `zecblock.com/tx/${f.shortTxid(row.txid)}`, date: f.timeText(Number(row.block_time)),
    visual: { kind: 'transfer', direction: 'down', top: poolNode('Orchard', orchard, 'closed to deposits', 'orchard'),
      bottom: poolNode('Ironwood', ironwood, 'shielded', 'ironwood') } };
  return candidate('migration', `migration:${row.txid}`, content, { ...row, usd, card }, 10);
}

function reorgStory(row) {
  const depth = Number(row.depth), height = Number(row.fork_height);
  if (!Number.isInteger(depth) || depth < 2 || !Number.isInteger(height)) return null;
  const content = `${MARK} Zcash just had a ${depth}-block reorg at height ${number(height)}.\n\n`
    + `Recent transactions may show new confirmation counts while the chain settles.\n\n${BASE}/network`;
  const card = { kicker: 'Network · Reorg', title: `Zcash had a ${depth}-block reorg.`, hero: String(depth), unit: depth === 1 ? 'block' : 'blocks', tone: 'gold',
    line: `reorganized at height ${number(height)}.`, qualifier: 'Recent confirmations may change.',
    source: 'zecblock.com/network', date: f.timeText(Date.parse(row.detected_at) / 1000),
    visual: { kind: 'reorg', depth: Math.min(depth, 6) } };
  return candidate('reorg', `reorg:${row.id}`, content, { ...row, card }, 100);
}

function crosschainStory(row, target) {
  const inflow = Number(row.inflow), outflow = Number(row.outflow), net = inflow - outflow;
  const [src, dst] = String(row.top_route).split(' -> ');
  if (![src, dst].every(c => /^[a-z0-9_-]{1,16}$/i.test(c || ''))) return null;
  const usd = n => `$${number(Math.round(n))}`;
  const route = `${f.chainName(src)} → ${f.chainName(dst)}`;
  const content = `${MARK} Net ${usd(Math.abs(net))} flowed ${net >= 0 ? 'into' : 'out of'} ZEC via NEAR Intents on ${f.dayText(target)}.\n\n`
    + `${usd(inflow)} in, ${usd(outflow)} out. Top route: ${route}. Largest swap: ${usd(Number(row.largest))}.\n\n${BASE}/crosschain`;
  const card = { kicker: 'Cross-chain · Daily', hero: `${net >= 0 ? '+' : '−'}${f.usdShort(Math.abs(net))}`, tone: net >= 0 ? 'in' : 'out',
    line: `net ${net >= 0 ? 'into' : 'out of'} ZEC via NEAR Intents.`, qualifier: `Top route: ${route}.`,
    source: 'zecblock.com/crosschain', date: f.dayYear(target),
    visual: { kind: 'bars', items: [{ label: 'Into ZEC', value: inflow, display: f.usdShort(inflow), tone: 'in' },
      { label: 'Out of ZEC', value: outflow, display: f.usdShort(outflow), tone: 'out' }] } };
  return candidate('crosschain_daily', `analysis:crosschain:${target}`, content, { ...row, target, card }, 5);
}

function hashStory(history, { target, genesisComplete }) {
  if (history.method !== 'target-work-v1' || history.window !== '7d') return null;
  const rows = history.points;
  const last = rows.at(-1);
  const end = `${addDays(target, 1)}T00:00:00.000Z`;
  if (!last || last.date !== end) return null;
  const valid = p => p.method === 'target-work-v1' && p.windowSeconds === 604800 && p.unavailableReason === null && Number.isFinite(p.hashrate) && p.hashrate > 0;
  if (!valid(last)) return null;
  let label, samples;
  const contiguous = points => points.every((p, i) => valid(p) && p.date === new Date(Date.parse(end) - (points.length - 1 - i) * 86400000).toISOString());
  if (rows.length >= 366 && genesisComplete && contiguous(rows) && comparison(rows.map(p => p.hashrate)).high) {
    label = 'New all-time high'; samples = rows;
  } else {
    for (const days of [90, 30]) {
      const window = rows.slice(-(days + 1));
      if (window.length !== days + 1 || !contiguous(window)) continue;
      const s = comparison(window.map(p => p.hashrate));
      if (s.high) { label = `Highest in ${days + 1} days`; samples = window; break; }
    }
  }
  if (!samples) return null;
  const stats = comparison(samples.map(p => p.hashrate));
  // Avoid posting every tiny new record. Delivery also enforces a 7-day cooldown.
  const previousPeak = Math.max(...samples.slice(0, -1).map(p => p.hashrate));
  if (last.hashrate < previousPeak * 1.01) return null;
  const change = (100 * (last.hashrate / previousPeak - 1)).toFixed(1);
  const formatted = formatHashrate(last.hashrate);
  const [value, ...unit] = formatted.split(' ');
  // Chart the samples behind the claim only, at most the last 91 days.
  const series = samples.slice(-91).map(p => p.hashrate);
  const card = { kicker: 'Network · Hashrate', title: `Zcash hashrate: ${label.toLowerCase()}.`, hero: value, unit: unit.join(' '), tone: 'gold', line: `${label}.`,
    qualifier: `7-day average, +${change}% on the last peak.`, source: 'zecblock.com/network', date: f.dayYear(target),
    visual: { kind: 'series', values: series, reference: previousPeak, referenceLabel: 'previous peak',
      label: '7-day estimated hashrate', unit: 'Sol/s', start: samples.slice(-91)[0].date.slice(0, 10), end: last.date.slice(0, 10) } };
  return candidate('hashrate', `analysis:hashrate:${target}`,
    `${MARK} ${label}: Zcash hashrate hit ${formatted}.\n\nThe 7-day average is up ${change}% on the previous peak.\n\n${BASE}/network`,
    { target, method: history.method, window: history.window, point: last, previousPeak, stats, historyStart: samples[0].date, genesisComplete, allTime: label.startsWith('New all-time'), card }, 60);
}

const SIGNALS = {
  mvrv: { kicker: 'MVRV', subject: 'Zcash’s MVRV', format: n => n.toFixed(2), unit: null, url: 'valuation', line: 'Zcash MVRV ratio.',
    lead: (v, d, c) => `Zcash MVRV hit ${v} on ${d}, ${c}.`,
    note: 'MVRV compares market cap with an estimated realized cap. It is a valuation gauge, not a forecast.' },
  exchange_deposit_zat: { kicker: 'Exchange deposits', subject: 'Tracked Zcash exchange deposits', format: n => number(n / 1e8, 1), unit: 'ZEC', url: 'turnstile', line: 'moved to known exchanges.',
    lead: (v, d, c) => `${v} ZEC moved to known exchange addresses on ${d}, ${c}.`,
    note: 'Tracked transparent deposits only. A deposit is not necessarily a sale.' },
  daily_fees_zat: { kicker: 'Fees', subject: 'Zcash transaction fees', format: n => number(n / 1e8, 2), unit: 'ZEC', url: 'network', line: 'paid in transaction fees.',
    lead: (v, d, c) => `Zcash paid ${v} ZEC in transaction fees on ${d}, ${c}.`, note: null },
  shield_volume_zat: { kicker: 'Shielding', subject: 'Public Zcash shielding', format: n => number(n / 1e8, 1), unit: 'ZEC', url: 'privacy', line: 'shielded in one day.',
    lead: (v, d, c) => `${v} ZEC was shielded on ${d}, ${c}.`,
    note: 'Public flows into shielded pools; pool-to-pool migrations are not counted.' },
  deshield_volume_zat: { kicker: 'Deshielding', subject: 'Public Zcash deshielding', format: n => number(n / 1e8, 1), unit: 'ZEC', url: 'privacy', line: 'deshielded in one day.',
    lead: (v, d, c) => `${v} ZEC was deshielded on ${d}, ${c}.`,
    note: 'Public flows out of shielded pools; pool-to-pool migrations are not counted.' },
};

function signalStory(metric, rows, target) {
  const d = SIGNALS[metric];
  if (!d || !completeSeries(rows, target, 31)) return null;
  const values = rows.map(r => r.value == null ? NaN : Number(r.value));
  const stats = comparison(values);
  if (!stats || stats.changePct === null || Math.abs(stats.changePct) < 20 || (!stats.high && !stats.low && Math.abs(stats.z || 0) < 3)) return null;
  const context = `${Math.abs(stats.changePct).toFixed(1)}% ${stats.changePct >= 0 ? 'above' : 'below'} its 30-day average`;
  const observation = d.lead(d.format(stats.value), f.dayText(target), context);
  const headline = stats.high || stats.low ? `${d.subject} reached a 31-day ${stats.high ? 'high' : 'low'}.` : null;
  // A bounded record is the headline; its dated value and comparison remain
  // the evidence. Keep compact observational copy when a long value needs it.
  const expanded = `${MARK} ${headline ? `${headline}\n\n` : ''}${observation}${d.note ? `\n\n${d.note}` : ''}\n\n${BASE}/${d.url}`;
  const content = expanded.length <= 280 ? expanded
    : `${MARK} ${observation}${d.note ? `\n\n${d.note}` : ''}\n\n${BASE}/${d.url}`;
  const scale = metric.endsWith('_zat') ? 1e8 : 1;
  const card = { kicker: `Signal · ${d.kicker}`, title: headline || `${d.subject} moved away from its recent baseline.`, hero: d.format(stats.value), unit: d.unit, tone: 'gold', line: d.line,
    qualifier: `${f.signedPct(stats.changePct)} vs 30-day average.`, source: `zecblock.com/${d.url}`, date: f.dayYear(target),
    visual: { kind: 'series', values: values.map(v => v / scale), reference: stats.mean / scale, referenceLabel: '30-day average',
      label: d.kicker, unit: d.unit || 'ratio', start: rows[0].date, end: target } };
  return candidate('network_signal', `analysis:signal:${metric}:${target}`, content,
    { metric, rows, stats, target, card, editorial: { topic: `network:${metric}`,
      lens: stats.high ? 'record_high' : stats.low ? 'record_low' : 'baseline_change' } }, Math.abs(stats.z || 0));
}

// Round-number milestones on completed UTC days. A level posts only when the
// day's close is the first ever at or above it, so a balance hovering around
// a level cannot re-trigger; the outbox key also makes each level one-time.
const MILESTONES = {
  ironwood_zec: { step: 250000, value: r => balance(r.ironwood_pool_size), url: 'pools', kicker: 'Milestone · Ironwood' },
  shielded_zec: { step: 250000, value: r => balance(r.pool_size), url: 'pools', kicker: 'Milestone · Shielded ZEC' },
  shielded_share: { step: 1, value: r => (Number(r.chain_supply) > 0 && Number(r.pool_size) > 0 ? 100 * Number(r.pool_size) / Number(r.chain_supply) : null), url: 'privacy', kicker: 'Milestone · Shielded share' },
  shielded_usd: { step: 1e9, value: r => (balance(r.pool_size) && positivePrice(r.price_usd) ? balance(r.pool_size) * Number(r.price_usd) : null), url: 'pools', kicker: 'Milestone · Shielded value' },
};

function milestoneStories(rows, target) {
  const today = rows.at(-1);
  if (!today || today.date !== target) return [];
  const stories = [];
  for (const [metric, m] of Object.entries(MILESTONES)) {
    const value = m.value(today);
    const prior = rows.slice(0, -1).map(m.value).filter(v => Number.isFinite(v));
    // Thin history could make an old level look new; require a real baseline.
    if (!Number.isFinite(value) || prior.length < 30) continue;
    const level = Math.floor(value / m.step) * m.step;
    if (level <= 0 || Math.max(...prior) >= level) continue;
    const shielded = balance(today.pool_size), supply = balance(today.chain_supply);
    const price = positivePrice(today.price_usd);
    const usd = zec => (price ? ` (${f.usdShort(zec * price)})` : '');
    const day = f.dayText(target);
    let content, hero, unit = 'ZEC', line, qualifier;
    if (metric === 'ironwood_zec') {
      content = `Milestone: Ironwood crossed ${f.levelText(level)} ZEC.\n\nIt held ${f.zecShort(value)} ZEC${usd(value)} at the end of ${day}${shielded ? `, ${Math.floor(100 * value / shielded)}% of all shielded ZEC` : ''}.`;
      hero = f.levelText(level); line = 'now in Ironwood.';
      qualifier = shielded ? `${Math.floor(100 * value / shielded)}% of all shielded ZEC.` : `${f.zecShort(value)} ZEC at close.`;
    } else if (metric === 'shielded_zec') {
      content = `Milestone: shielded ZEC crossed ${f.levelText(level)}.\n\n${f.zecShort(value)} ZEC${usd(value)} sat in shielded pools at the end of ${day}${supply ? `, ${(Math.floor(1000 * value / supply) / 10).toFixed(1)}% of all ZEC` : ''}.`;
      hero = f.levelText(level); line = 'now shielded.';
      qualifier = supply ? `${(Math.floor(1000 * value / supply) / 10).toFixed(1)}% of all ZEC.` : `${f.zecShort(value)} ZEC at close.`;
    } else if (metric === 'shielded_share') {
      content = `Milestone: ${level}% of all ZEC is now shielded.\n\n${f.zecShort(shielded)} of ${f.zecShort(supply)} ZEC sat in shielded pools at the end of ${day}.`;
      hero = `${level}%`; unit = null; line = 'of all ZEC is shielded.'; qualifier = `${f.zecShort(shielded)} of ${f.zecShort(supply)} ZEC.`;
    } else {
      content = `Milestone: shielded ZEC is worth more than $${level / 1e9}B for the first time on record.\n\n${f.zecShort(shielded)} ZEC at $${number(price, 2)} at the end of ${day}.`;
      hero = `$${level / 1e9}B`; unit = null; line = 'in shielded ZEC.'; qualifier = 'First time on record.';
    }
    const seriesRows = rows.slice(-90);
    const series = seriesRows.map(m.value).map(v => (Number.isFinite(v) ? v : null));
    const card = { kicker: m.kicker, title: content.split('\n')[0], hero, unit, tone: metric === 'ironwood_zec' ? 'ironwood' : 'gold', line, qualifier,
      source: `zecblock.com/${m.url}`, date: f.dayYear(target),
      visual: { kind: 'series', values: series, reference: level, referenceLabel: metric === 'shielded_share' ? `${level}%` : metric === 'shielded_usd' ? `$${level / 1e9}B` : `${f.levelText(level)} ZEC`,
        label: m.kicker.replace('Milestone · ', ''), unit: metric === 'shielded_share' ? '%' : metric === 'shielded_usd' ? 'USD' : 'ZEC',
        start: seriesRows[0].date, end: target, ...(metric === 'shielded_share' ? { scale: { min: 0, max: 100 } } : {}) } };
    stories.push(candidate('milestone', `milestone:${metric}:${level}`, `${MARK} ${content}\n\n${BASE}/${m.url}`,
      { metric, level, value, target, priorMax: Math.max(...prior), card }, { ironwood_zec: 4, shielded_zec: 3, shielded_share: 2, shielded_usd: 1 }[metric]));
  }
  return stories;
}

const DAY = 86400000;
const clamp = (value, min = 0, max = 100) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const evidenceOf = story => story.evidence || story.metadata || {};
const typeOf = story => story.type || story.post_type;
const isFlow = story => /^flow_(shield|deshield)$/.test(typeOf(story));
const movementFamily = story => isFlow(story) || ['swap', 'migration', 'crosschain_daily', 'pool_trend'].includes(typeOf(story));
const isEditorialHistory = story => typeOf(story) !== 'source_reply' && evidenceOf(story).deliveryRole !== 'source_reply';

function editorialTopic(story) {
  const e = evidenceOf(story), type = typeOf(story);
  if (e.editorial?.topic) return e.editorial.topic;
  if (isFlow(story)) return 'public_flow_event';
  if (type === 'network_signal') return `network:${e.metric}`;
  if (['activity_daily', 'activity_weekly'].includes(type)) return 'transaction_activity';
  if (type === 'milestone') return `milestone:${e.metric || (e.lead ? 'pool_activity' : 'balance')}`;
  return type;
}

function exceptionalFlow(story) {
  const e = evidenceOf(story);
  return isFlow(story) && Number(e.amount_zat) >= 50000e8 && Number.isFinite(e.tailPct) && e.tailPct <= 0.1;
}

function materialTrendChange(current, previous) {
  if (Number.isFinite(current.stats?.value) && Number.isFinite(previous.stats?.value)) {
    const before = previous.stats.value, value = current.stats.value;
    return before === 0 ? value !== 0 : Math.abs(value - before) / Math.abs(before) >= 0.25;
  }
  // Public-flow totals are exact signed zatoshi strings. Do not round them to
  // floating-point ZEC merely to decide whether a repeated trend has changed.
  const value = current.totals?.netZat, before = previous.totals?.netZat;
  if (!/^-?\d+$/.test(String(value)) || !/^-?\d+$/.test(String(before))) return false;
  const a = BigInt(value), b = BigInt(before), abs = n => n < 0n ? -n : n;
  return b === 0n ? a !== 0n : abs(a - b) * 100n >= abs(b) * 25n;
}

// Compare reader significance across categories on one bounded scale. Raw ZEC,
// USD and z-scores are not comparable, so they never sort directly against one
// another. Protected urgent events use a separate lane, not a novelty penalty.
function editorialRank(story, history, now) {
  const e = evidenceOf(story), type = typeOf(story), stats = e.stats || {};
  const change = Number.isFinite(stats.changePct) ? Math.abs(stats.changePct) : 0;
  const sigma = Number.isFinite(stats.z) ? Math.abs(stats.z) : 0;
  let significance;
  if (Number.isFinite(e.editorial?.significance)) significance = clamp(e.editorial.significance);
  else if (isFlow(story)) {
    const rarity = Number.isFinite(e.tailPct) ? clamp((0.5 - e.tailPct) / 0.5, 0, 1) : 0;
    const amount = Number(e.amount_zat) > 0 ? Number(e.amount_zat) / 1e8 : 500;
    significance = 45 + 12 * rarity + Math.min(18, 8 * Math.log10(Math.max(1, amount / 500)));
  } else if (type === 'swap') {
    const rarity = Number.isFinite(e.tailPct) ? clamp(1 - e.tailPct, 0, 1) : 0;
    significance = 45 + 12 * rarity + Math.min(18, 10 * Math.log10(Math.max(1, Number(e.source_amount_usd) / 50000 || 1)));
  } else if (type === 'network_signal') significance = 50 + Math.min(25, change / 2) + Math.min(10, sigma * 2);
  else if (type === 'hashrate') {
    const growth = e.previousPeak > 0 ? 100 * (e.point?.hashrate / e.previousPeak - 1) : 0;
    significance = 60 + (e.allTime ? 10 : 0) + Math.min(15, Math.max(0, growth || 0));
  } else if (type === 'activity_weekly') {
    const metric = e.metrics?.find(m => m.noteworthy);
    significance = 65 + (metric?.rank === 1 ? 15 : metric?.rank <= 10 ? 8 : 0)
      + Math.min(10, Math.max(0, metric?.changePct || 0) / 10);
  } else if (type === 'milestone') {
    significance = e.lead?.startsWith('parity:365:100') ? 85 : e.lead?.startsWith('leadership:') ? 80
      : e.lead ? 72 : 60;
  } else significance = { activity_daily: 45, network_briefing: 60, pool_trend: 60, crosschain_daily: 30, migration: 35 }[type] || 0;
  significance = clamp(significance);
  const protectedLane = type === 'reorg' ? 1000 : type === 'nu7' && e.nu7Kind === 'activation' ? 950
    : type === 'swap' && e.exceptional ? 900 : exceptionalFlow(story) ? 800 : type === 'nu7' && e.nu7Kind === 'countdown' ? 700 : 0;
  const topic = editorialTopic(story);
  const recent = history.filter(p => isEditorialHistory(p) && ['posted', 'posting', 'uncertain'].includes(p.status)
    && Number.isFinite(Date.parse(p.created_at)) && now - new Date(p.created_at) >= 0 && now - new Date(p.created_at) < 3 * DAY);
  const sameTopic = recent.filter(p => editorialTopic(p) === topic);
  let noveltyPenalty = Math.min(24, sameTopic.reduce((sum, p) => sum + (now - new Date(p.created_at) < DAY ? 12 : 6), 0));
  const latest = [...recent].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  // Swaps and direct flows are different types but often the same feed rhythm.
  if (movementFamily(story) && latest && movementFamily(latest) && now - new Date(latest.created_at) < DAY) noveltyPenalty += 10;
  if (protectedLane) noveltyPenalty = 0;
  return { topic, significance, noveltyPenalty, protectedLane, score: protectedLane + significance - noveltyPenalty };
}

// Keep exceptional swap capacity while limiting direct-flow dominance across
// both directions. No daily quota needs filling: an empty selection is valid.
function select(candidates, history, now) {
  const today = now.toISOString().slice(0, 10);
  const eligibleHistory = history.filter(isEditorialHistory);
  const recent = eligibleHistory.filter(p => ['posted','posting','uncertain'].includes(p.status));
  const used = new Set(eligibleHistory.map(p => p.dedup_key));
  const selected = [], skipped = [];
  const ranked = candidates.map(story => ({ story, rank: editorialRank(story, history, now) }))
    .sort((a, b) => b.rank.score - a.rank.score || a.story.key.localeCompare(b.story.key));
  for (const { story: c, rank } of ranked) {
    let reason = used.has(c.key) ? 'duplicate-or-held' : null;
    const same = recent.filter(p => p.post_type === c.type);
    const dayPosts = same.filter(p => new Date(p.created_at).toISOString().slice(0, 10) === today);
    if (!reason && isFlow(c)) {
      const flowsToday = recent.filter(p => isFlow(p) && new Date(p.created_at).toISOString().slice(0, 10) === today);
      if (flowsToday.length >= 2) reason = 'flow-combined-daily-cap';
      const latest = [...recent].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (!reason && !exceptionalFlow(c) && latest && isFlow(latest)
        && now - new Date(latest.created_at) < 6 * 3600000) reason = 'recent-flow-topic';
    }
    if (!reason && c.type === 'swap') {
      const exceptional = c.evidence.exceptional;
      const slot = exceptional ? 'exceptional' : now.getUTCHours() < 12 ? 'am' : 'pm';
      if (dayPosts.some(p => p.metadata?.slot === slot)) reason = `swap-${slot}-slot-used`;
      c.evidence.slot = slot;
    }
    if (!reason && ['hashrate','network_signal'].includes(c.type)) {
      const comparable = same.filter(p => c.type !== 'network_signal' || p.metadata?.metric === c.evidence.metric);
      const latest = comparable.filter(p => now-new Date(p.created_at)<7*86400000)
        .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0];
      if (latest) {
        const previous = c.type === 'hashrate' ? latest.metadata?.point?.hashrate : latest.metadata?.stats?.value;
        const value = c.type === 'hashrate' ? c.evidence.point?.hashrate : c.evidence.stats?.value;
        const materialChange = Number.isFinite(previous) && previous>0 && Number.isFinite(value) &&
          (c.type === 'hashrate' ? value>=previous*1.05 : Math.abs(value/previous-1)>=0.25);
        if (!materialChange) reason = 'seven-day-topic-cooldown';
      }
    }
    if (!reason && c.type === 'crosschain_daily') {
      const stats = c.evidence.stats;
      const comparativeStats = Number.isFinite(stats?.changePct) && Math.abs(stats.changePct) >= 20
        && (stats.high || stats.low || Math.abs(stats.z || 0) >= 3);
      const comparativeLens = Number.isFinite(c.evidence.editorial?.significance) && c.evidence.editorial.significance >= 50
        && typeof c.evidence.editorial.lens === 'string' && c.evidence.editorial.lens.length > 0;
      if (!comparativeStats && !comparativeLens) reason = 'routine-summary-without-comparison';
    }
    if (!reason && ['migration','crosschain_daily','milestone','network_briefing','pool_trend','halving'].includes(c.type) && dayPosts.length) reason = 'daily-cap';
    if (!reason && c.type === 'pool_trend') {
      const latest = same.filter(p => editorialTopic(p) === rank.topic && p.metadata?.editorial?.lens === c.evidence.editorial?.lens
        && now - new Date(p.created_at) >= 0 && now - new Date(p.created_at) < 3 * DAY)
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (latest && !materialTrendChange(c.evidence, latest.metadata)) reason = 'three-day-trend-cooldown';
    }
    if (!reason && c.type === 'network_signal' && dayPosts.length >= 1) reason = 'signal-daily-cap';
    // One-time NU7 moments are deduplicated by key; routine NU7 milestones share two slots a day.
    if (!reason && c.type === 'nu7' && !['activation', 'countdown'].includes(c.evidence.nu7Kind)
      && dayPosts.filter(p => !['activation', 'countdown'].includes(p.metadata?.nu7Kind)).length >= 2) reason = 'nu7-daily-cap';
    if (reason) { skipped.push({ key: c.key, reason }); continue; }
    c.evidence.editorialSelection = rank;
    selected.push(c); used.add(c.key);
    recent.push({ post_type: c.type, status: 'posting', created_at: now.toISOString(), metadata: c.evidence });
  }
  return { selected, skipped };
}

module.exports = { candidate, comparison, completeSeries, dailyActivity, weeklyActivity, flowStory, swapStory,
  migrationStory, reorgStory, crosschainStory, hashStory, signalStory, milestoneStories, select, editorialRank, eventTime, isNew };
