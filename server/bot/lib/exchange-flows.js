'use strict';

// Exchange deposits and withdrawals for the bot. The classifier lives in
// server/lib/exchange-flows.js and the durable rows in exchange_flows
// (server/lib/exchange-flow-store.js, written by jobs/refresh-exchange-flows.js).
// This module keeps the posting story and the in-memory rank/net helpers used
// by fixtures and previews; the live collector ranks against stored rows.

const core = require('../../lib/exchange-flows');
const { ENTITIES, postable } = core;

const WINDOW_DAYS = 30;
const DAY_S = 86_400;
// Blocks this recent may still be reorganised; flows wait two minutes like shielded flows.
const SETTLE_S = 120;

// ─── Ranking and totals ─────────────────────────────────────────────────────

const { BINS_PER_DECADE } = require('../../lib/exchange-flow-store');
const binOf = zat => Math.floor(Math.log10(Number(zat) / 1e8) * BINS_PER_DECADE);

/**
 * Rank an event against every postable-entity event of the same direction in
 * the 30 days up to and including its own block (other events of the same block
 * count; only the event itself is left out). The histogram is built from exactly
 * those rows, so the GIF and the "top x%" claim cannot disagree.
 */
function rankEvent(event, events) {
  const start = event.blockTime - WINDOW_DAYS * DAY_S, amount = BigInt(event.amountZat);
  let n = 0, greater = 0, equal = 0;
  const bins = new Map();
  for (const e of events) {
    if (e.direction !== event.direction || !postable(e.entity) || e.blockTime > event.blockTime || e.blockTime < start) continue;
    if (e.txid === event.txid && e.entity === event.entity) continue;
    const zat = BigInt(e.amountZat);
    if (zat <= 0n) continue;
    n++;
    if (zat > amount) greater++; else if (zat === amount) equal++;
    const bin = binOf(zat);
    bins.set(bin, (bins.get(bin) || 0) + 1);
  }
  return { sample_count: n, greater_count: greater, equal_count: equal,
    distribution: { bins: [...bins].sort((a, b) => a[0] - b[0]).map(([bin, count]) => ({ bin, n: count })), total: n } };
}

/** Exact deposits, withdrawals and net (signed) in (endS - 24h, endS], per entity or across all postable entities. */
function netFlow(events, endS, entity = null) {
  let deposits = 0n, withdrawals = 0n, count = 0;
  for (const e of events) {
    if (e.blockTime <= endS - DAY_S || e.blockTime > endS || !postable(e.entity) || (entity && e.entity !== entity)) continue;
    if (e.direction === 'deposit') deposits += BigInt(e.amountZat); else withdrawals += BigInt(e.amountZat);
    count++;
  }
  return { depositsZat: deposits.toString(), withdrawalsZat: withdrawals.toString(), netZat: (deposits - withdrawals).toString(), count };
}

// ─── Story ──────────────────────────────────────────────────────────────────

// Owner-approved bars (floor lowered to 500 ZEC on 2026-11-22): at least 500 ZEC and in the top 1% of the same
// direction across labelled exchanges over 30 days (>= 100 comparable events).
const MIN_ZAT = 500n * 100000000n;
const MAX_TAIL_PCT = 1;
const MIN_SAMPLE = 100;
const TXID = /^[a-f0-9]{64}$/;
const BASE = 'https://zecblock.com';
const MARK = '🟨';

function exchangeFlowStory(row) {
  const f = require('./editorial-format');
  const { candidate } = require('./editorial-policy');
  const entity = ENTITIES[row.entity];
  if (!entity || !['deposit', 'withdrawal'].includes(row.direction) || !TXID.test(row.txid || '')) return null;
  if (!/^\d+$/.test(String(row.amountZat)) || BigInt(row.amountZat) < MIN_ZAT || !Number.isSafeInteger(Number(row.blockTime))) return null;
  const n = Number(row.sample_count), greater = Number(row.greater_count), equal = Number(row.equal_count);
  if (!Number.isSafeInteger(n) || n < MIN_SAMPLE || ![greater, equal].every(v => Number.isSafeInteger(v) && v >= 0) || greater + equal > n) return null;
  if (row.distribution?.total !== n) return null;
  // Inclusive upper tail handles ties honestly. No extrapolated percentile.
  const tailPct = 100 * (greater + equal + 1) / (n + 1);
  if (tailPct > MAX_TAIL_PCT) return null;
  const into = row.direction === 'deposit', custody = entity.kind === 'custody';
  const price = Number(row.price_usd) > 0 ? Number(row.price_usd) : null;
  const usd = price ? Number(row.amountZat) / 1e8 * price : null;
  const amt = f.zecText(row.amountZat), tail = f.tailText(tailPct), largest = greater === 0 && equal === 0;
  const place = custody ? `${entity.name} custody` : entity.name;
  const via = row.counterparty === 'shielded' ? (into ? ' from a shielded pool' : ' for a shielded pool') : '';
  const verb = into ? `just went into ${place}${via}` : `just left ${place}${via}`;
  // The ranking sample is every labelled exchange and custodian, so the copy names both.
  const rank = largest ? `The largest ${into ? 'deposit to' : 'withdrawal from'} labelled exchange and custody wallets in 30 days.`
    : `Top ${tail}% of ${into ? 'deposits to' : 'withdrawals from'} labelled exchange and custody wallets in 30 days.`;
  const net = row.net && /^\d+$/.test(row.net.depositsZat) && /^\d+$/.test(row.net.withdrawalsZat)
    ? ` ${entity.name}, last 24h: ${f.zecShort(Number(row.net.depositsZat) / 1e8)} ZEC in, ${f.zecShort(Number(row.net.withdrawalsZat) / 1e8)} ZEC out.` : '';
  // Long names (Coinbase Prime custody, shielded counterparty) can push the copy
  // past 280 characters: drop the 24h line first, then shorten the rank line.
  const shortRank = largest ? `Largest labelled ${row.direction} in 30 days.` : `Top ${tail}% of labelled ${row.direction}s in 30 days.`;
  const build = (r, extra) => `${MARK} ${amt} ZEC${usd ? ` (${f.usdShort(usd)})` : ''} ${verb}.\n\n${r}${extra}\n\n${BASE}/tx/${row.txid}`;
  const content = [build(rank, net), build(rank, ''), build(shortRank, '')].find(c => c.length <= 280) || build(shortRank, '');
  const kind = custody ? 'Custody' : 'Exchange';
  const card = { kicker: `${kind} · ${into ? 'Deposit' : 'Withdrawal'}`, hero: `${into ? '+' : '−'}${amt}`, unit: 'ZEC',
    tone: into ? 'in' : 'out', title: `${amt} ZEC ${into ? 'went into' : 'left'} ${place}.`,
    line: `${into ? 'into' : 'out of'} ${place}${usd ? ` (≈ ${f.usdShort(usd)})` : ''}`,
    qualifier: largest ? `Largest labelled ${row.direction} in 30 days.` : `Top ${tail}% of labelled ${row.direction}s in 30 days.`,
    source: `zecblock.com/tx/${f.shortTxid(row.txid)}`, date: f.timeText(Number(row.blockTime)),
    visual: { kind: 'entity', entity: row.entity, name: entity.name, logo: entity.logo } };
  return candidate('exchange_flow', `exchange_flow:${row.direction}:${row.entity}:${row.txid}`, content,
    { txid: row.txid, entity: row.entity, direction: row.direction, counterparty: row.counterparty,
      amount_zat: String(row.amountZat), block_height: row.blockHeight, block_time: Number(row.blockTime),
      sample_count: n, greater_count: greater, equal_count: equal, tailPct, distribution: row.distribution,
      net: row.net || null, price_usd: price, price_quote: row.price_quote || null, usd, card,
      attribution: 'address-labels', editorial: { topic: `exchange_flow:${row.entity}`, lens: largest ? 'record_high' : 'large_event' } },
    Number(row.amountZat) / 1e8);
}

// ─── Weekly net-flow recap ──────────────────────────────────────────────────

const WEEK_LINK = `${BASE}/docs#exchange-flows-daily`;
const MAX_ROWS = 6;
const signedZec = zat => {
  const f = require('./editorial-format');
  const v = BigInt(zat), abs = v < 0n ? -v : v;
  return `${v < 0n ? '−' : v > 0n ? '+' : ''}${f.zecShort(Number(abs) / 1e8)}`;
};

/**
 * Last completed UTC week (Monday–Sunday) of deposits and withdrawals per
 * labelled entity. `rows` are { entity, depositsZat, withdrawalsZat,
 * depositCount, withdrawalCount } with exact decimal zatoshi strings; entities
 * without activity are left out. Net = deposits − withdrawals.
 */
function weeklyNetFlowStory({ start, endExclusive, rows }) {
  const f = require('./editorial-format');
  const { candidate } = require('./editorial-policy');
  const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || addDays(start, 7) !== endExclusive || new Date(`${start}T00:00:00Z`).getUTCDay() !== 1) return null;
  if (!Array.isArray(rows)) return null;
  const active = [];
  for (const r of rows) {
    const entity = ENTITIES[r.entity];
    if (!entity || !/^\d+$/.test(String(r.depositsZat)) || !/^\d+$/.test(String(r.withdrawalsZat))) return null;
    const dn = Number(r.depositCount), wn = Number(r.withdrawalCount);
    if (![dn, wn].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
    if (!dn && !wn) continue;
    const d = BigInt(r.depositsZat), w = BigInt(r.withdrawalsZat);
    active.push({ entity: r.entity, name: entity.name, logo: entity.logo, kind: entity.kind,
      depositsZat: d.toString(), withdrawalsZat: w.toString(), netZat: (d - w).toString(), depositCount: dn, withdrawalCount: wn });
  }
  if (active.length < 2) return null;
  const abs = v => (v < 0n ? -v : v);
  active.sort((a, b) => { const x = abs(BigInt(b.netZat)) - abs(BigInt(a.netZat)); return x > 0n ? 1 : x < 0n ? -1 : a.entity.localeCompare(b.entity); });
  const deposits = active.reduce((s, r) => s + BigInt(r.depositsZat), 0n), withdrawals = active.reduce((s, r) => s + BigInt(r.withdrawalsZat), 0n);
  const net = deposits - withdrawals;
  if (net === 0n) return null;
  const into = net > 0n, range = f.rangeText(start, addDays(endExclusive, -1));
  const netText = f.zecText(abs(net).toString());
  const movers = active.filter(r => BigInt(r.netZat) !== 0n);
  const head = `${MARK} Exchange flows last week (${range}, UTC): ${netText} ZEC net ${into ? 'into' : 'out of'} labelled exchange and custody wallets.`;
  let content;
  for (let n = Math.min(movers.length, MAX_ROWS); n >= 0; n--) {
    const list = movers.slice(0, n).map(r => `${r.name} ${signedZec(r.netZat)}`).join(' · ');
    content = `${head}\n\n${list ? `${list}\n\n` : ''}${WEEK_LINK}`;
    if (content.length <= 280) break;
  }
  const shown = active.slice(0, MAX_ROWS);
  const card = { kicker: 'Exchanges · Last week', hero: signedZec(net.toString()), unit: 'ZEC', tone: into ? 'in' : 'out',
    line: `net ${into ? 'into' : 'out of'} labelled exchange & custody wallets`, source: 'zecblock.com/docs#exchange-flows-daily', date: range,
    visual: { kind: 'netflow', rows: shown.map(r => ({ entity: r.entity, name: r.name, logo: r.logo, netZat: r.netZat, display: signedZec(r.netZat) })) } };
  const transactions = active.reduce((s, r) => s + r.depositCount + r.withdrawalCount, 0);
  return candidate('exchange_netflow_weekly', `analysis:exchange_netflow:${start}`, content,
    { period: { start, endExclusive }, entities: active, depositsZat: deposits.toString(), withdrawalsZat: withdrawals.toString(),
      netZat: net.toString(), events: transactions, card, attribution: 'address-labels',
      editorial: { topic: 'exchange_netflow', lens: 'weekly_pattern', significance: 60 } });
}

module.exports = { ...core, MIN_ZAT, MAX_TAIL_PCT, MIN_SAMPLE, exchangeFlowStory, weeklyNetFlowStory, WINDOW_DAYS, SETTLE_S, BINS_PER_DECADE, rankEvent, netFlow, binOf };
