'use strict';

// Shielded pool sources and destinations (migration 048): where value entering
// each shielded pool comes from and where value leaving it goes, per UTC day.
// Writer used by server/jobs/refresh-pool-sources.js; reader used by the API
// (the API image ships server/lib).
//
// Authority: canonical transactions (block hash matched at its height) with
// their per-pool value balances, transparent inputs (and the transaction each
// input spends) and transparent outputs. Per-pool value balance: positive =
// value leaving that pool, negative = value entering it, exact zatoshis.
//
// Per transaction, with E = value entering pools and L = value leaving pools:
//   - M = min(E, L) moved pool to pool ("migration"), split across entering
//     and leaving pools in proportion to their amounts.
//   - E - M entered from the transparent side. Coinbase transactions are
//     "coinbase" (shielded block reward). Otherwise it is split across the
//     transparent inputs by value: an input spending a block-reward output is
//     "mining" when paid to that block's miner address, "funding" when paid to
//     a registered funding-stream address, else "other_coinbase" (for example
//     the historical Founders' Reward); an input from a labelled exchange is
//     "exchange"; anything else is "transparent".
//   - L - M left to the transparent side: the fee first ("fee"), the rest split
//     across transparent outputs by value ("exchange" or "transparent").
//   - Value that cannot be attributed (unresolved input/output values, a
//     missing fee) is "unknown", never dropped, so per pool and day
//     sum(in) - sum(out) is the pool's exact net change.
// Splits use exact integer largest-remainder apportionment with both margins
// preserved. Attribution only follows the transaction itself: a pool that
// first moves rewards to another transparent address and shields from there
// reads as "transparent". Mining attribution is therefore a lower bound.
//
// Reader semantics: unavailable until a rebuild completes; stale while a
// rebuild runs, the classifier/labels/funding registry changed, or the job is
// behind the index tip. A covered day with no row is zero; a day outside
// coverage is null.

const crypto = require('crypto');
const x = require('./exchange-flows');
const { POOL_BY_ADDRESS, getPoolName } = require('../api/mining-pools');

// Bump when classification or the SQL changes meaning: stored rows become
// stale and need `refresh-pool-sources --rebuild`.
const CLASSIFIER_VERSION = 1;
const POOLS = Object.freeze(['sprout', 'sapling', 'orchard', 'ironwood']);
const IN_CATEGORIES = Object.freeze(['migration', 'coinbase', 'mining', 'funding', 'other_coinbase', 'exchange', 'transparent', 'unknown']);
const OUT_CATEGORIES = Object.freeze(['migration', 'fee', 'exchange', 'transparent', 'unknown']);
const DAY_S = 86_400;
const REORG_WINDOW = 1000;
const BATCH_DAYS = 7;
const TXID_BATCH = 5_000;
const STALE_LAG_BLOCKS = 24;

const dayOf = s => new Date(Number(s) * 1000).toISOString().slice(0, 10);
const dayStart = d => Date.parse(`${d}T00:00:00Z`) / 1000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_S * 1000).toISOString().slice(0, 10);

// ─── Apportionment ──────────────────────────────────────────────────────────

/**
 * Split `total` (BigInt >= 0) across entries [{ key, weight (BigInt >= 0) }] in
 * proportion to weight, exactly: floor shares plus one zatoshi to the largest
 * remainders (ties by entry order). Returns Map key -> BigInt summing to total,
 * or null when there is nothing to split by.
 */
function apportion(total, entries) {
  const live = entries.filter(e => e.weight > 0n);
  const sum = live.reduce((a, e) => a + e.weight, 0n);
  if (total === 0n) return new Map(live.map(e => [e.key, 0n]));
  if (sum === 0n) return null;
  const parts = live.map((e, i) => ({ key: e.key, i, base: total * e.weight / sum, rem: total * e.weight % sum }));
  let left = total - parts.reduce((a, p) => a + p.base, 0n);
  for (const p of [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))) {
    if (left === 0n) break;
    p.base += 1n; left -= 1n;
  }
  return new Map(parts.map(p => [p.key, p.base]));
}

/**
 * Exact matrix with fixed row and column margins (both summing to the same
 * total): rows are filled in order, each apportioned over the columns'
 * remaining capacity; the last row takes what remains.
 */
function fillMatrix(rows, cols) {
  const remaining = new Map(cols.map(c => [c.key, c.amount]));
  const cells = [];
  rows.forEach((row, i) => {
    if (row.amount === 0n) return;
    const last = i === rows.length - 1 || rows.slice(i + 1).every(r => r.amount === 0n);
    const split = last ? new Map(remaining) : apportion(row.amount, cols.map(c => ({ key: c.key, weight: remaining.get(c.key) })));
    for (const [col, amount] of split) {
      if (amount <= 0n) continue;
      cells.push({ row: row.key, col, amount });
      remaining.set(col, remaining.get(col) - amount);
    }
  });
  return cells;
}

// ─── Classifier ─────────────────────────────────────────────────────────────

/** Funding-stream recipient addresses from the miner registry. */
const FUNDING_ADDRESSES = Object.freeze(Object.entries(POOL_BY_ADDRESS).filter(([, p]) => p.isFundingStream).map(([a]) => a).sort());

function versionOf(labels, funding = FUNDING_ADDRESSES) {
  const fundingHash = crypto.createHash('sha256').update(funding.join('\n')).digest('hex').slice(0, 12);
  return `c${CLASSIFIER_VERSION}:${labels.fingerprint}:${fundingHash}`;
}

/** address -> exchange entity id (named or `other:*`). */
function labelMap(labels) {
  return new Map(labels.addresses.map((a, i) => [a, labels.entities[i]]));
}

function inputSource(input, ctx) {
  const address = input.address || '';
  if (input.fromCoinbase) {
    if (ctx.funding.has(address)) return ['funding', address];
    if (address && address === input.minerAddress) return ['mining', address];
    return ['other_coinbase', address];
  }
  const entity = ctx.labels.get(address);
  if (entity) return ['exchange', x.postable(entity) ? entity : 'other'];
  return ['transparent', ''];
}

function outputDestination(output, ctx) {
  const entity = ctx.labels.get(output.address || '');
  if (entity) return ['exchange', x.postable(entity) ? entity : 'other'];
  return ['transparent', ''];
}

/** Category/detail weights for legs; null when any leg value is unknown or none carries value. */
function legWeights(legs, classifyLeg, ctx) {
  const weights = new Map();
  for (const leg of legs) {
    if (leg.value == null) return null;
    if (leg.value <= 0n) continue;
    const [category, detail] = classifyLeg(leg, ctx);
    const key = `${category}\u0000${detail}`;
    weights.set(key, (weights.get(key) || 0n) + leg.value);
  }
  return weights.size ? [...weights].map(([key, weight]) => ({ key, weight })) : null;
}

const splitKey = key => { const i = key.indexOf('\u0000'); return [key.slice(0, i), key.slice(i + 1)]; };

/**
 * Classify one transaction. tx: { txid, time, isCoinbase, fee (BigInt|null),
 * vb: { pool: BigInt|null }, inputs: [{ address, value (BigInt|null),
 * fromCoinbase, minerAddress }], outputs: [{ address, value (BigInt|null) }] }.
 * Returns { rows: [{ pool, direction, category, detail, amount (BigInt) }], skipped }.
 */
function classify(tx, ctx) {
  if (POOLS.some(p => tx.vb[p] == null)) return { rows: [], skipped: 'unknown-value-balance' };
  const entering = POOLS.filter(p => tx.vb[p] < 0n).map(p => ({ key: p, amount: -tx.vb[p] }));
  const leaving = POOLS.filter(p => tx.vb[p] > 0n).map(p => ({ key: p, amount: tx.vb[p] }));
  const E = entering.reduce((a, p) => a + p.amount, 0n);
  const L = leaving.reduce((a, p) => a + p.amount, 0n);
  if (E === 0n && L === 0n) return { rows: [], skipped: null };
  const rows = [];
  const M = E < L ? E : L;

  // Pool to pool: margins are each side's share of M.
  const migIn = apportion(M, entering.map(p => ({ key: p.key, weight: p.amount }))) || new Map();
  const migOut = apportion(M, leaving.map(p => ({ key: p.key, weight: p.amount }))) || new Map();
  if (M > 0n) {
    for (const cell of fillMatrix(entering.map(p => ({ key: p.key, amount: migIn.get(p.key) || 0n })),
      leaving.map(p => ({ key: p.key, amount: migOut.get(p.key) || 0n })))) {
      rows.push({ pool: cell.row, direction: 'in', category: 'migration', detail: cell.col, amount: cell.amount });
      rows.push({ pool: cell.col, direction: 'out', category: 'migration', detail: cell.row, amount: cell.amount });
    }
  }

  if (E > M) {
    const R = E - M;
    let categories;
    if (tx.isCoinbase) categories = new Map([[`coinbase\u0000`, R]]);
    else {
      const weights = legWeights(tx.inputs, inputSource, ctx);
      categories = weights ? apportion(R, weights) : null;
      if (!categories) categories = new Map([[`unknown\u0000`, R]]);
    }
    const poolRows = entering.map(p => ({ key: p.key, amount: p.amount - (migIn.get(p.key) || 0n) }));
    for (const cell of fillMatrix(poolRows, [...categories].map(([key, amount]) => ({ key, amount })))) {
      const [category, detail] = splitKey(cell.col);
      rows.push({ pool: cell.row, direction: 'in', category, detail, amount: cell.amount });
    }
  }

  if (L > M) {
    const D = L - M;
    const categories = new Map();
    let rest = D;
    if (tx.fee == null) categories.set(`unknown\u0000`, D), rest = 0n;
    else {
      const fee = tx.fee < 0n ? 0n : tx.fee > D ? D : tx.fee;
      if (fee > 0n) categories.set(`fee\u0000`, fee);
      rest = D - fee;
    }
    if (rest > 0n) {
      const weights = legWeights(tx.outputs, outputDestination, ctx);
      const split = weights ? apportion(rest, weights) : null;
      if (split) for (const [key, amount] of split) categories.set(key, (categories.get(key) || 0n) + amount);
      else categories.set(`unknown\u0000`, (categories.get(`unknown\u0000`) || 0n) + rest);
    }
    const poolRows = leaving.map(p => ({ key: p.key, amount: p.amount - (migOut.get(p.key) || 0n) }));
    for (const cell of fillMatrix(poolRows, [...categories].map(([key, amount]) => ({ key, amount })))) {
      const [category, detail] = splitKey(cell.col);
      rows.push({ pool: cell.row, direction: 'out', category, detail, amount: cell.amount });
    }
  }
  return { rows: rows.filter(r => r.amount > 0n), skipped: null };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

const big = v => (v == null ? null : BigInt(v));

// Canonical transactions in [$1, $2) that move value in or out of any pool.
// A NULL balance is included so it is counted as skipped, never read as 0.
const TX_SQL = `SELECT t.txid, t.block_time, t.is_coinbase, t.fee::text AS fee, t.vin_count, t.vout_count,
    t.value_balance_sprout::text AS vb_sprout, t.value_balance_sapling::text AS vb_sapling,
    t.value_balance_orchard::text AS vb_orchard, t.value_balance_ironwood::text AS vb_ironwood
  FROM transactions t JOIN blocks b ON b.height = t.block_height AND b.hash = t.block_hash
  WHERE t.block_time >= $1 AND t.block_time < $2
    AND (t.value_balance_sprout IS DISTINCT FROM 0 OR t.value_balance_sapling IS DISTINCT FROM 0
      OR t.value_balance_orchard IS DISTINCT FROM 0 OR t.value_balance_ironwood IS DISTINCT FROM 0)`;

// Each input with whether it spends a block-reward output and that block's miner address.
const INPUT_SQL = `SELECT i.txid, i.address, i.value::text AS value, p.is_coinbase AS from_coinbase, pb.miner_address
  FROM transaction_inputs i
  LEFT JOIN transactions p ON p.txid = i.prev_txid
  LEFT JOIN blocks pb ON p.is_coinbase AND pb.height = p.block_height AND pb.hash = p.block_hash
  WHERE i.txid = ANY($1::text[])`;
const OUTPUT_SQL = `SELECT txid, address, value::text AS value FROM transaction_outputs WHERE txid = ANY($1::text[])`;

async function legsFor(db, sql, txids) {
  const byTx = new Map();
  for (let i = 0; i < txids.length; i += TXID_BATCH) {
    const { rows } = await db.query(sql, [txids.slice(i, i + TXID_BATCH)]);
    for (const r of rows) {
      if (!byTx.has(r.txid)) byTx.set(r.txid, []);
      byTx.get(r.txid).push({ address: r.address, value: big(r.value), fromCoinbase: r.from_coinbase === true, minerAddress: r.miner_address || null });
    }
  }
  return byTx;
}

/**
 * Classify every canonical pool-moving transaction with block_time in
 * [fromS, toS). Returns { days: Map key -> { amount, txs }, txs, skipped }
 * keyed by `day|pool|direction|category|detail`.
 */
async function readWindow(db, ctx, fromS, toS) {
  const { rows } = await db.query(TX_SQL, [fromS, toS]);
  const inputs = await legsFor(db, INPUT_SQL, rows.filter(r => !r.is_coinbase && Number(r.vin_count) > 0).map(r => r.txid));
  const outputs = await legsFor(db, OUTPUT_SQL, rows.filter(r => Number(r.vout_count) > 0).map(r => r.txid));
  const agg = new Map();
  const skipped = {};
  for (const r of rows) {
    const tx = { txid: r.txid, time: Number(r.block_time), isCoinbase: Boolean(r.is_coinbase), fee: big(r.fee),
      vb: { sprout: big(r.vb_sprout), sapling: big(r.vb_sapling), orchard: big(r.vb_orchard), ironwood: big(r.vb_ironwood) },
      inputs: inputs.get(r.txid) || [], outputs: outputs.get(r.txid) || [] };
    // A transaction the index says has legs but whose legs are missing is unresolved.
    if (!tx.isCoinbase && Number(r.vin_count) > 0 && !inputs.has(r.txid)) tx.inputs = [{ address: null, value: null }];
    if (Number(r.vout_count) > 0 && !outputs.has(r.txid)) tx.outputs = [{ address: null, value: null }];
    const result = classify(tx, ctx);
    if (result.skipped) skipped[result.skipped] = (skipped[result.skipped] || 0) + 1;
    const day = dayOf(tx.time);
    for (const row of result.rows) {
      const key = [day, row.pool, row.direction, row.category, row.detail].join('|');
      const cur = agg.get(key) || { amount: 0n, txs: 0 };
      cur.amount += row.amount; cur.txs += 1;
      agg.set(key, cur);
    }
  }
  return { days: agg, txs: rows.length, skipped };
}

// ─── Writer ─────────────────────────────────────────────────────────────────

async function readState(db) {
  const { rows } = await db.query(`SELECT ready, version, coverage_from_day::text AS coverage_from_day, through_height, through_hash,
    through_time, rebuild_version, rebuild_next_day::text AS rebuild_next_day, last_run_at, last_skipped
    FROM shielded_pool_source_state WHERE id = 1`);
  const s = rows[0];
  if (!s) return null;
  const num = v => (v == null ? null : Number(v));
  return { ...s, through_height: num(s.through_height), through_time: num(s.through_time) };
}

async function chainTip(db) {
  const { rows } = await db.query('SELECT height, hash, timestamp FROM blocks ORDER BY height DESC LIMIT 1');
  return rows[0] ? { height: Number(rows[0].height), hash: rows[0].hash, time: Number(rows[0].timestamp) } : null;
}

/** Load the classification context (exchange labels, funding registry) and its version. */
async function loadContext(db) {
  const labels = await x.loadLabels(db);
  return { labels: labelMap(labels), funding: new Set(FUNDING_ADDRESSES), version: versionOf(labels), labelCount: labels.addresses.length };
}

/** Replace the daily rows of [fromDay, toDay) with `days` and run `after` in one transaction. */
async function replaceDays(client, fromDay, toDay, days, after) {
  const cols = { day: [], pool: [], direction: [], category: [], detail: [], amount: [], txs: [] };
  for (const [key, v] of days) {
    const [day, pool, direction, category, detail] = key.split('|');
    if (day < fromDay || day >= toDay) throw new Error(`row for ${day} outside [${fromDay}, ${toDay})`);
    cols.day.push(day); cols.pool.push(pool); cols.direction.push(direction); cols.category.push(category);
    cols.detail.push(detail); cols.amount.push(v.amount.toString()); cols.txs.push(v.txs);
  }
  await client.query('BEGIN');
  try {
    const del = await client.query('DELETE FROM shielded_pool_source_daily WHERE day >= $1::date AND day < $2::date', [fromDay, toDay]);
    if (cols.day.length) await client.query(`INSERT INTO shielded_pool_source_daily(day, pool, direction, category, detail, amount_zat, tx_count)
      SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::int[])`,
    [cols.day, cols.pool, cols.direction, cols.category, cols.detail, cols.amount, cols.txs]);
    if (after) await after(client);
    await client.query('COMMIT');
    return { deleted: del.rowCount, inserted: cols.day.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

const mergeSkipped = (into, from) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v; return into; };

/**
 * Full rebuild from the first indexed block's UTC day, in day batches.
 * Resumes an interrupted rebuild of the same version. Readers see `stale`
 * until the final step publishes the new version.
 */
async function rebuild(client, { ctx, batchDays = BATCH_DAYS, log = () => {}, now = () => Date.now() } = {}) {
  const started = now();
  const state = await readState(client);
  if (!state) throw new Error('shielded_pool_source_state missing: apply migration 048 first');
  const { rows: [first] } = await client.query('SELECT min(timestamp) AS t FROM blocks');
  if (first?.t == null) throw new Error('no blocks indexed');
  const coverageFrom = dayOf(first.t);
  const resume = state.rebuild_version === ctx.version && state.rebuild_next_day != null;
  let day = resume ? state.rebuild_next_day : coverageFrom;
  log(`${resume ? 'Resuming' : 'Starting'} rebuild ${ctx.version} at ${day}; ${ctx.labelCount} exchange-labelled addresses`);
  await client.query('UPDATE shielded_pool_source_state SET rebuild_version = $1, rebuild_next_day = $2, updated_at = now() WHERE id = 1', [ctx.version, day]);
  const skipped = resume && state.last_skipped?.rebuild === ctx.version ? { ...(state.last_skipped.counts || {}) } : {};
  const totals = { batches: 0, txs: 0, rows: 0, readMs: 0, writeMs: 0 };
  // `tip` is read before each window, so after the last one every block up to it is covered.
  let tip = await chainTip(client);
  for (;;) {
    const tomorrow = addDays(dayOf(Math.floor(now() / 1000)), 1);
    if (day >= tomorrow) break;
    const end = [addDays(day, batchDays), tomorrow].sort()[0];
    tip = await chainTip(client);
    const t0 = now();
    const read = await readWindow(client, ctx, dayStart(day), dayStart(end));
    const t1 = now();
    mergeSkipped(skipped, read.skipped);
    const w = await replaceDays(client, day, end, read.days, c => c.query(
      'UPDATE shielded_pool_source_state SET rebuild_next_day = $1, last_skipped = $2, updated_at = now() WHERE id = 1',
      [end, { rebuild: ctx.version, counts: skipped }]));
    totals.batches++; totals.txs += read.txs; totals.rows += w.inserted;
    totals.readMs += t1 - t0; totals.writeMs += now() - t1;
    log(`  ${day}..${addDays(end, -1)}: ${read.txs} txs, ${w.inserted} rows, read ${t1 - t0}ms write ${now() - t1}ms`);
    day = end;
  }
  await client.query(`UPDATE shielded_pool_source_state SET ready = true, version = $1, coverage_from_day = $2, through_height = $3,
      through_hash = $4, through_time = $5, rebuild_version = NULL, rebuild_next_day = NULL, last_run_at = now(), last_skipped = $6,
      updated_at = now() WHERE id = 1`,
  [ctx.version, coverageFrom, tip.height, tip.hash, tip.time, { rebuild: ctx.version, counts: skipped }]);
  return { ...totals, skipped, tip, coverageFrom, elapsedMs: now() - started };
}

/**
 * Incremental run: re-read from the day before the last covered block (or
 * further back after a tip reorg) through today and replace those days.
 */
async function refresh(client, { ctx, log = () => {}, now = () => Date.now() } = {}) {
  const state = await readState(client);
  if (!state) throw new Error('shielded_pool_source_state missing: apply migration 048 first');
  if (state.rebuild_version) return { action: 'rebuild-in-progress' };
  if (!state.ready) return { action: 'not-built' };
  if (state.version !== ctx.version) return { action: 'version-changed' };
  const tip = await chainTip(client);
  let fromDay = addDays(dayOf(state.through_time), -1);
  const { rows: [h] } = await client.query('SELECT hash FROM blocks WHERE height = $1', [state.through_height]);
  const reorged = !h || h.hash !== state.through_hash;
  if (reorged) {
    const { rows: [old] } = await client.query('SELECT min(timestamp) AS t FROM blocks WHERE height >= $1', [state.through_height - REORG_WINDOW]);
    if (old?.t != null) fromDay = [fromDay, addDays(dayOf(old.t), -1)].sort()[0];
    log(`Tip reorg below ${state.through_height}; re-reading from ${fromDay}`);
  }
  if (fromDay < state.coverage_from_day) fromDay = state.coverage_from_day;
  const toDay = addDays(dayOf(Math.floor(now() / 1000)), 1);
  const read = await readWindow(client, ctx, dayStart(fromDay), dayStart(toDay));
  const w = await replaceDays(client, fromDay, toDay, read.days, c => c.query(
    `UPDATE shielded_pool_source_state SET through_height = $1, through_hash = $2, through_time = $3, last_run_at = now(),
      last_skipped = $4, updated_at = now() WHERE id = 1`,
    [tip.height, tip.hash, tip.time, { from: fromDay, to: toDay, counts: read.skipped }]));
  return { action: 'incremental', fromDay, toDay, reorged, txs: read.txs, ...w, skipped: read.skipped };
}

// ─── Readers ────────────────────────────────────────────────────────────────

async function status(db, { version } = {}) {
  const state = await readState(db).catch(error => { if (error.code === '42P01') return null; throw error; });
  if (!state || !state.ready) return { status: 'unavailable', reason: state?.rebuild_version ? 'rebuild-in-progress' : 'not-built', state };
  const live = version || (await loadContext(db)).version;
  const tip = await chainTip(db);
  const lagBlocks = tip ? tip.height - state.through_height : null;
  let reason = null;
  if (state.rebuild_version) reason = 'rebuild-in-progress';
  else if (String(state.version).split(':')[0] !== String(live).split(':')[0]) reason = 'classifier-changed';
  else if (state.version !== live) reason = 'labels-changed';
  else if (lagBlocks == null || lagBlocks > STALE_LAG_BLOCKS) reason = 'behind-tip';
  return { status: reason ? 'stale' : 'ok', reason, state, tipHeight: tip?.height ?? null, lagBlocks };
}

class PoolSourceQueryError extends Error {
  // publicMessage is always one of the fixed strings below, safe to return to clients.
  constructor(message, status = 400, extra = {}) { super(message); this.publicMessage = message; this.status = status; Object.assign(this, extra); }
}

const PERIOD_DAYS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90, '1y': 365 });
const PERIODS = Object.freeze([...Object.keys(PERIOD_DAYS), 'all']);
const GRANULARITIES = Object.freeze(['day', 'week', 'month']);
const MAX_DAYS = 4000;
const DETAIL_LIMIT = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = d => DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/**
 * Validate a query. A period selects the N most recent completed UTC days
 * plus today so far (reported as partial); `all` runs from coverage start
 * through today. Explicit from/to (inclusive) may include today.
 */
function parseQuery(query = {}, now = Date.now()) {
  const allowed = new Set(['pool', 'period', 'from', 'to', 'granularity']);
  for (const key of Object.keys(query)) if (!allowed.has(key)) throw new PoolSourceQueryError('Unknown query parameter');
  const pool = String(query.pool ?? '');
  if (!POOLS.includes(pool)) throw new PoolSourceQueryError('pool must be sprout, sapling, orchard or ironwood');
  const today = new Date(now).toISOString().slice(0, 10);
  const hasRange = query.from != null || query.to != null;
  if (hasRange && query.period != null) throw new PoolSourceQueryError('Use period or from/to, not both');
  let period = null, from = null, to = null;
  if (hasRange) {
    to = query.to == null ? today : String(query.to);
    if (!validDate(to)) throw new PoolSourceQueryError('to must be YYYY-MM-DD');
    if (query.from == null) throw new PoolSourceQueryError('from is required with to');
    from = String(query.from);
    if (!validDate(from)) throw new PoolSourceQueryError('from must be YYYY-MM-DD');
    if (from > to) throw new PoolSourceQueryError('from must not be after to');
    if ((Date.parse(to) - Date.parse(from)) / (DAY_S * 1000) + 1 > MAX_DAYS) throw new PoolSourceQueryError(`At most ${MAX_DAYS} days`);
  } else {
    period = query.period == null ? '30d' : String(query.period);
    if (!PERIODS.includes(period)) throw new PoolSourceQueryError('period must be 7d, 30d, 90d, 1y or all');
    to = today;
    from = period === 'all' ? null : addDays(today, -PERIOD_DAYS[period]);
  }
  const spanDays = from ? (Date.parse(to) - Date.parse(from)) / (DAY_S * 1000) + 1 : Infinity;
  const granularity = query.granularity == null ? (spanDays <= 120 ? 'day' : spanDays <= 800 ? 'week' : 'month') : String(query.granularity);
  if (!GRANULARITIES.includes(granularity)) throw new PoolSourceQueryError('granularity must be day, week or month');
  return { pool, period, from, to, granularity };
}

function bucketOf(day, granularity) {
  if (granularity === 'day') return day;
  if (granularity === 'month') return `${day.slice(0, 7)}-01`;
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -weekday);
}

/** Display name for a detail value, from the registries; null when unnamed. */
function detailLabel(category, detail) {
  if (!detail) return null;
  if (category === 'migration') return detail.charAt(0).toUpperCase() + detail.slice(1);
  if (category === 'exchange') return x.ENTITIES[detail]?.name ?? null;
  if (category === 'mining') return getPoolName(detail);
  if (category === 'funding' || category === 'other_coinbase') return POOL_BY_ADDRESS[detail]?.name ?? null;
  return null;
}

/**
 * Sources and destinations of one pool over a window. Buckets outside
 * coverage are null; totals are null unless every requested day is covered.
 */
async function poolSources(db, query, { now = Date.now() } = {}) {
  const q = parseQuery(query, now);
  const st = await status(db);
  if (st.status === 'unavailable') throw new PoolSourceQueryError('Pool source history is not available yet', 503, { reason: st.reason });
  const s = st.state;
  const coverageFrom = s.coverage_from_day, throughDay = dayOf(s.through_time);
  const from = q.from ?? coverageFrom;
  // A period runs through today, but never past the latest covered day: just
  // after UTC midnight today has no block yet and must not void the window.
  if (q.period && q.to > throughDay) q.to = throughDay;
  if (from > q.to) throw new PoolSourceQueryError('Window is before coverage');
  const { rows } = await db.query(`SELECT day::text AS day, direction, category, detail, amount_zat::text AS amount, tx_count
    FROM shielded_pool_source_daily WHERE pool = $1 AND day BETWEEN $2::date AND $3::date`, [q.pool, from, q.to]);

  const buckets = new Map();
  const dayCoverage = new Map();
  let uncovered = 0, partial = 0, complete = 0;
  for (let d = from; d <= q.to; d = addDays(d, 1)) {
    const coverage = d < coverageFrom || d > throughDay ? 'none' : d === throughDay ? 'partial' : 'complete';
    dayCoverage.set(d, coverage);
    if (coverage === 'none') uncovered++; else if (coverage === 'partial') partial++; else complete++;
    const key = bucketOf(d, q.granularity);
    const b = buckets.get(key) || { date: key, days: 0, covered: 0, partial: false, in: {}, out: {}, inZat: 0n, outZat: 0n };
    b.days++;
    if (coverage !== 'none') b.covered++;
    if (coverage === 'partial') b.partial = true;
    buckets.set(key, b);
  }
  const detail = { in: new Map(), out: new Map() };
  const category = { in: new Map(), out: new Map() };
  // Completed days only (for per-day averages) and the partial day (today so far).
  const done = { in: 0n, out: 0n };
  const today = { in: 0n, out: 0n };
  for (const r of rows) {
    const amount = BigInt(r.amount);
    const cov = dayCoverage.get(r.day);
    if (cov === 'complete') done[r.direction] += amount;
    else if (cov === 'partial') today[r.direction] += amount;
    const b = buckets.get(bucketOf(r.day, q.granularity));
    const dir = r.direction;
    b[dir][r.category] = (b[dir][r.category] || 0n) + amount;
    b[`${dir}Zat`] += amount;
    const ck = category[dir].get(r.category) || { amount: 0n, txs: 0 };
    ck.amount += amount; ck.txs += Number(r.tx_count); category[dir].set(r.category, ck);
    const dk = `${r.category}\u0000${r.detail}`;
    const dv = detail[dir].get(dk) || { amount: 0n, txs: 0 };
    dv.amount += amount; dv.txs += Number(r.tx_count); detail[dir].set(dk, dv);
  }
  const str = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v.toString()]));
  const series = [...buckets.values()].map(b => {
    if (b.covered === 0) return { date: b.date, coverage: 'none', days: b.days, inZat: null, outZat: null, netZat: null, in: null, out: null };
    return { date: b.date, coverage: b.partial || b.covered < b.days ? 'partial' : 'complete', days: b.days,
      inZat: b.inZat.toString(), outZat: b.outZat.toString(), netZat: (b.inZat - b.outZat).toString(), in: str(b.in), out: str(b.out) };
  });
  const order = dir => (dir === 'in' ? IN_CATEGORIES : OUT_CATEGORIES);
  const categories = dir => order(dir).filter(c => category[dir].has(c)).map(c => ({ category: c,
    amountZat: category[dir].get(c).amount.toString(), txCount: category[dir].get(c).txs }))
    .sort((a, b) => (BigInt(b.amountZat) > BigInt(a.amountZat) ? 1 : BigInt(b.amountZat) < BigInt(a.amountZat) ? -1 : 0));
  const details = dir => [...detail[dir]].filter(([k]) => splitKey(k)[1] !== '')
    .sort(([, a], [, b]) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)).slice(0, DETAIL_LIMIT)
    .map(([k, v]) => { const [c, d] = splitKey(k); return { category: c, detail: d, label: detailLabel(c, d), amountZat: v.amount.toString(), txCount: v.txs }; });
  const inTotal = [...category.in.values()].reduce((a, v) => a + v.amount, 0n);
  const outTotal = [...category.out.values()].reduce((a, v) => a + v.amount, 0n);
  return {
    success: true, status: st.status, staleReason: st.reason, pool: q.pool, period: q.period, from, to: q.to,
    granularity: q.granularity, unit: 'zatoshi', classifierVersion: CLASSIFIER_VERSION,
    coverage: { fromDate: coverageFrom, throughDate: throughDay, throughHeight: s.through_height, throughHash: s.through_hash,
      throughTime: s.through_time, tipHeight: st.tipHeight, lagBlocks: st.lagBlocks, completeDays: complete, partialDays: partial, uncoveredDays: uncovered },
    totals: uncovered ? null : { inZat: inTotal.toString(), outZat: outTotal.toString(), netZat: (inTotal - outTotal).toString() },
    // Over completed UTC days only, so per-day averages are not diluted by a partial day.
    completeTotals: uncovered ? null : { days: complete, inZat: done.in.toString(), outZat: done.out.toString(), netZat: (done.in - done.out).toString() },
    // The day holding the latest covered block, when it is inside the window.
    partialDay: partial ? { date: throughDay, throughTime: s.through_time, inZat: today.in.toString(),
      outZat: today.out.toString(), netZat: (today.in - today.out).toString() } : null,
    sources: uncovered ? null : categories('in'),
    destinations: uncovered ? null : categories('out'),
    sourceDetails: uncovered ? null : details('in'),
    destinationDetails: uncovered ? null : details('out'),
    series,
  };
}

module.exports = {
  CLASSIFIER_VERSION, POOLS, IN_CATEGORIES, OUT_CATEGORIES, DAY_S, REORG_WINDOW, BATCH_DAYS, STALE_LAG_BLOCKS, PERIODS, GRANULARITIES,
  FUNDING_ADDRESSES, apportion, fillMatrix, versionOf, labelMap, classify, readWindow, readState, chainTip, loadContext,
  replaceDays, rebuild, refresh, status, PoolSourceQueryError, parseQuery, bucketOf, detailLabel, poolSources, dayOf, addDays,
};
