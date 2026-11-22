'use strict';

// Exchange deposits and withdrawals, at the level of the entity behind the
// labels (owner request 2026-11-22).
//
// Every address labelled with an exchange or custodian name belongs to that
// entity: hot wallets, cold wallets, deposit addresses, custody. Per
// transaction and entity:
//   - deposit:    no input is the entity's; value reaches the entity's addresses.
//   - withdrawal: every input is the entity's; value leaves to addresses that
//                 are not the entity's (or into a shielded pool).
//   - internal:   hot <-> cold moves, deposit-address sweeps into the hot
//                 wallet, change back to the entity. Never an event.
// Value moving between two different labelled exchanges, inputs mixing the
// entity with unlabelled addresses, Sprout and unresolved inputs are skipped,
// never guessed. Amounts are exact zatoshi integers (BigInt / decimal strings).
//
// Attribution is only as good as the labels: an unlabelled deposit address
// swept into a labelled hot wallet reads as one deposit (the sweep), and a
// move to an unlabelled wallet the exchange owns reads as a withdrawal. The
// copy says "labelled wallets" for that reason. Shielded deposits and
// withdrawals that never touch a labelled transparent address are invisible.

const crypto = require('crypto');

const WINDOW_DAYS = 30;
const DAY_S = 86_400;
// Blocks this recent may still be reorganised; flows wait two minutes like shielded flows.
const SETTLE_S = 120;
// Each tick re-reads this much history, so late-indexed or reorganised blocks are replaced.
const OVERLAP_S = 2 * 3600;

// Explicit label -> entity aliases, matching lib/entity-logos.ts. A label that
// is not listed here still belongs to its own entity (so it is never mistaken
// for a customer), but it is never posted about.
const ENTITIES = Object.freeze({
  binance: { name: 'Binance', logo: 'binance.png', kind: 'exchange',
    labels: ['Binance', 'Binance Cold Wallet', 'Binance Hot Wallet'] },
  kraken: { name: 'Kraken', logo: 'kraken.png', kind: 'exchange',
    labels: ['Kraken', 'Kraken Cold Wallet', 'Kraken Deposit', 'Kraken Hot Wallet'] },
  coinbase: { name: 'Coinbase', logo: 'coinbase.png', kind: 'exchange',
    labels: ['Coinbase', 'Coinbase Cold Wallet'] },
  coinbase_prime: { name: 'Coinbase Prime', logo: 'coinbase.png', kind: 'custody',
    labels: ['Coinbase Prime Custody'] },
  gemini: { name: 'Gemini', logo: 'gemini.png', kind: 'exchange',
    labels: ['Gemini', 'Gemini Cold Wallet', 'Gemini Custody'] },
  grayscale: { name: 'Grayscale', logo: 'grayscale.png', kind: 'custody',
    labels: ['Grayscale Zcash Trust'] },
  kucoin: { name: 'KuCoin', logo: 'kucoin.png', kind: 'exchange',
    labels: ['Kucoin Cold Wallet', 'KuCoin Cold Wallet'] },
  // Per-user deposit addresses carry "Hyperunit Deposit"; each one sweeps only to the hot wallet.
  hyperunit: { name: 'Hyperunit', logo: 'hyperunit.png', kind: 'exchange',
    labels: ['Hyperunit Hot Wallet', 'Hyperunit Deposit'] },
});
const LABEL_ENTITY = new Map(Object.entries(ENTITIES).flatMap(([id, e]) => e.labels.map(l => [l.toLowerCase(), id])));

/** Entity id for an exchange-category label; unknown labels form their own unposted entity. */
function entityOfLabel(label) {
  const key = String(label || '').trim().toLowerCase();
  if (!key) return null;
  return LABEL_ENTITY.get(key) || `other:${key}`;
}
const postable = entity => Object.hasOwn(ENTITIES, entity);

/** Exchange-category labels as parallel arrays for the SQL, plus a fingerprint that changes when any label does. */
async function loadLabels(db) {
  const { rows } = await db.query(`SELECT address, label FROM address_labels
    WHERE category='exchange' ORDER BY address`);
  const addresses = [], entities = [];
  for (const row of rows) {
    const entity = entityOfLabel(row.label);
    if (!entity || !row.address) continue;
    addresses.push(row.address); entities.push(entity);
  }
  const fingerprint = crypto.createHash('sha256').update(addresses.map((a, i) => `${a}=${entities[i]}`).join('\n')).digest('hex').slice(0, 16);
  return { addresses, entities, fingerprint };
}

// Canonical transactions touching a labelled address in [from, to), with their
// transparent legs summed per side and per entity (NULL = unlabelled). The
// height bound uses the address_transactions primary key; time bounds it exactly.
const FLOW_ROWS = `WITH lab AS (SELECT * FROM unnest($1::text[], $2::text[]) AS l(address, entity)),
  start AS (SELECT COALESCE(min(height), 0) AS height FROM blocks WHERE timestamp >= $3),
  hits AS MATERIALIZED (
    SELECT DISTINCT at.txid, at.block_height FROM lab
    JOIN address_transactions at ON at.address = lab.address
    WHERE at.block_height >= (SELECT height FROM start) AND at.block_time >= $3 AND at.block_time < $4
  ), tx AS MATERIALIZED (
    SELECT t.txid, t.block_height, t.block_time, t.is_coinbase, COALESCE(t.has_sprout, false) AS has_sprout,
      (COALESCE(t.value_balance_sapling,0) + COALESCE(t.value_balance_orchard,0) + COALESCE(t.value_balance_ironwood,0))::text AS value_balance
    FROM hits h JOIN transactions t ON t.txid = h.txid AND t.block_height = h.block_height
    JOIN blocks b ON b.height = t.block_height AND b.hash = t.block_hash
    WHERE t.block_time >= $3 AND t.block_time < $4
  ), legs AS (
    SELECT i.txid, 'in' AS side, i.address, i.value FROM tx JOIN transaction_inputs i ON i.txid = tx.txid
    UNION ALL
    SELECT o.txid, 'out', o.address, o.value FROM tx JOIN transaction_outputs o ON o.txid = tx.txid
  )
  SELECT tx.txid, tx.block_height, tx.block_time, tx.is_coinbase, tx.has_sprout, tx.value_balance,
    g.side, g.entity, g.zat, g.unknown
  FROM tx JOIN (
    SELECT legs.txid, legs.side, lab.entity, COALESCE(sum(legs.value), 0)::text AS zat,
      count(*) FILTER (WHERE legs.value IS NULL)::int AS unknown
    FROM legs LEFT JOIN lab ON lab.address = legs.address
    GROUP BY 1, 2, 3
  ) g ON g.txid = tx.txid
  ORDER BY tx.block_time, tx.txid, g.side, g.entity NULLS FIRST`;

/** Group FLOW_ROWS rows into one record per transaction. */
function groupRows(rows) {
  const byTx = new Map();
  for (const row of rows) {
    let tx = byTx.get(row.txid);
    if (!tx) {
      tx = { txid: row.txid, blockHeight: Number(row.block_height), blockTime: Number(row.block_time),
        isCoinbase: Boolean(row.is_coinbase), hasSprout: Boolean(row.has_sprout), valueBalance: BigInt(row.value_balance ?? 0),
        legs: [], unknown: 0 };
      byTx.set(row.txid, tx);
    }
    tx.legs.push({ side: row.side, entity: row.entity ?? null, zat: BigInt(row.zat) });
    tx.unknown += Number(row.unknown || 0);
  }
  return [...byTx.values()];
}

/**
 * Classify one grouped transaction. Returns { events, skipped } where each
 * event is { txid, entity, direction, amountZat (string), blockHeight,
 * blockTime, counterparty } and skipped is a reason string or null.
 */
function classify(tx) {
  if (tx.isCoinbase) return { events: [], skipped: 'coinbase' };
  if (tx.hasSprout) return { events: [], skipped: 'sprout' };
  if (tx.unknown > 0) return { events: [], skipped: 'unresolved-legs' };
  const sum = (side, test) => tx.legs.filter(l => l.side === side && test(l.entity)).reduce((a, l) => a + l.zat, 0n);
  const inEntities = [...new Set(tx.legs.filter(l => l.side === 'in' && l.entity && l.zat > 0n).map(l => l.entity))];
  const outEntities = [...new Set(tx.legs.filter(l => l.side === 'out' && l.entity && l.zat > 0n).map(l => l.entity))];
  const unlabelledIn = sum('in', e => !e), unlabelledOut = sum('out', e => !e);
  // valueBalance > 0: value left a shielded pool into this transaction; < 0: value entered one.
  const fromShielded = tx.valueBalance > 0n ? tx.valueBalance : 0n;
  const toShielded = tx.valueBalance < 0n ? -tx.valueBalance : 0n;
  const base = { txid: tx.txid, blockHeight: tx.blockHeight, blockTime: tx.blockTime };

  if (inEntities.length > 1) return { events: [], skipped: 'inputs-from-several-entities' };
  if (inEntities.length === 1) {
    const entity = inEntities[0];
    // A co-spend with unlabelled inputs suggests an unlabelled entity wallet, or a joint transaction. Not guessed.
    if (unlabelledIn > 0n) return { events: [], skipped: 'mixed-inputs' };
    if (outEntities.some(e => e !== entity)) return { events: [], skipped: 'between-entities' };
    const amount = unlabelledOut + toShielded;
    if (amount <= 0n) return { events: [], skipped: 'internal' };
    const counterparty = unlabelledOut > 0n && toShielded > 0n ? 'mixed' : toShielded > 0n ? 'shielded' : 'transparent';
    return { events: [{ ...base, entity, direction: 'withdrawal', amountZat: amount.toString(), counterparty }], skipped: null };
  }
  if (!outEntities.length) return { events: [], skipped: 'no-entity-value' };
  // No entity input: each entity receiving value got a deposit.
  const counterparty = unlabelledIn > 0n && fromShielded > 0n ? 'mixed' : fromShielded > 0n ? 'shielded' : 'transparent';
  const events = outEntities.map(entity => ({ ...base, entity, direction: 'deposit',
    amountZat: sum('out', e => e === entity).toString(), counterparty }));
  return { events, skipped: null };
}

/** Classify every transaction in FLOW_ROWS output. */
function classifyRows(rows) {
  const events = [], skipped = {};
  for (const tx of groupRows(rows)) {
    const result = classify(tx);
    events.push(...result.events);
    if (result.skipped) skipped[result.skipped] = (skipped[result.skipped] || 0) + 1;
  }
  return { events, skipped };
}

async function readEvents(db, labels, fromS, toS) {
  if (!labels.addresses.length) return { events: [], skipped: {} };
  const { rows } = await db.query(FLOW_ROWS, [labels.addresses, labels.entities, fromS, toS]);
  return classifyRows(rows);
}

/**
 * Rolling 30-day (+1 day margin) classified history, kept in memory. The
 * first call reads the whole window; later calls re-read the last two hours
 * and replace everything in that span, so reorganised blocks drop out. A label
 * change or a new UTC day forces a full rebuild.
 */
function createHistory() {
  const state = { fingerprint: null, day: null, events: [], through: null };
  return {
    state,
    async refresh(db, now, { load = loadLabels, read = readEvents } = {}) {
      const nowS = Math.floor(now.getTime() / 1000), to = nowS - SETTLE_S;
      const labels = await load(db);
      const day = now.toISOString().slice(0, 10);
      const keep = to - (WINDOW_DAYS + 1) * DAY_S;
      const full = state.fingerprint !== labels.fingerprint || state.day !== day || state.through == null || state.through < to - DAY_S;
      const from = full ? keep : Math.max(keep, state.through - OVERLAP_S);
      const { events, skipped } = await read(db, labels, from, to);
      const retained = full ? [] : state.events.filter(e => e.blockTime >= keep && e.blockTime < from);
      Object.assign(state, { fingerprint: labels.fingerprint, day, through: to,
        events: [...retained, ...events].sort((a, b) => a.blockTime - b.blockTime || a.txid.localeCompare(b.txid)) });
      return { full, from, to, skipped, labels: labels.addresses.length, events: state.events };
    },
  };
}

// ─── Ranking and totals ─────────────────────────────────────────────────────

const BINS_PER_DECADE = 8;
const binOf = zat => Math.floor(Math.log10(Number(zat) / 1e8) * BINS_PER_DECADE);

/**
 * Rank an event against every postable-entity event of the same direction in
 * the 30 days before it. The histogram is built from exactly those rows, so the
 * GIF and the "top x%" claim cannot disagree.
 */
function rankEvent(event, events) {
  const start = event.blockTime - WINDOW_DAYS * DAY_S, amount = BigInt(event.amountZat);
  let n = 0, greater = 0, equal = 0;
  const bins = new Map();
  for (const e of events) {
    if (e.direction !== event.direction || !postable(e.entity) || e.blockTime >= event.blockTime || e.blockTime < start) continue;
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

// Owner-approved bars: at least 1,000 ZEC and in the top 1% of the same
// direction across labelled exchanges over 30 days (>= 100 comparable events).
const MIN_ZAT = 1000n * 100000000n;
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
  const content = `${MARK} ${amt} ZEC${usd ? ` (${f.usdShort(usd)})` : ''} ${verb}.\n\n${rank}${net}\n\n${BASE}/tx/${row.txid}`;
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

module.exports = { ENTITIES, MIN_ZAT, MAX_TAIL_PCT, MIN_SAMPLE, exchangeFlowStory, WINDOW_DAYS, SETTLE_S, BINS_PER_DECADE, FLOW_ROWS, entityOfLabel, postable, loadLabels,
  groupRows, classify, classifyRows, readEvents, createHistory, rankEvent, netFlow, binOf };
