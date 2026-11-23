'use strict';

// Durable exchange-flow dataset (migration 046): writer used by
// server/jobs/refresh-exchange-flows.js and readers used by the bot and API.
//
// Authority: canonical transactions (block hash matched at its height) in
// blocks/transactions/transaction_inputs/transaction_outputs, classified with
// server/lib/exchange-flows.js against address_labels (category 'exchange').
// Only named entities (ENTITIES) are stored; `other:*` labels still shape
// classification so their wallets are never read as customers.
//
// Semantics a reader must keep:
//   - unavailable: no completed rebuild (state.ready false). Never zero.
//   - stale: labels or classifier changed since the rows were written, a
//     rebuild is in progress, or the job is behind the index tip. Values are
//     served but marked; the bot does not post from stale data.
//   - a covered day with no daily row is a true zero; a day outside
//     [coverage_from_time, through_time] is unknown (null).

const x = require('./exchange-flows');

const DAY_S = 86_400;
// The mainnet writer's automatic reorg bound (wiki: reorg-observations).
const REORG_WINDOW = 1000;
// Every incremental run re-reads and replaces this many recent blocks, so
// late-written transactions and short reorgs are picked up.
const OVERLAP_BLOCKS = 100;
const BATCH_BLOCKS = 20_000;
const TXID_BATCH = 2_000;
// A label change affecting more transactions than this waits for --rebuild
// (or --max-affected); until then rows keep the stored label map and read stale.
const MAX_AUTO_AFFECTED = 100_000;
// Readers call the dataset stale when it trails the index tip by more blocks than this (~30 min).
const STALE_LAG_BLOCKS = 24;
const RANK_WINDOW_S = 30 * DAY_S;
const BINS_PER_DECADE = 8;

const dayOf = s => new Date(Number(s) * 1000).toISOString().slice(0, 10);

// ─── Writer ─────────────────────────────────────────────────────────────────

async function readState(db) {
  const { rows } = await db.query(`SELECT ready, label_version, coverage_from_height, coverage_from_time,
    through_height, through_hash, through_time, rebuild_label_version, rebuild_next_height, last_run_at, last_skipped
    FROM exchange_flow_state WHERE id = 1`);
  const s = rows[0];
  if (!s) return null;
  const num = v => v == null ? null : Number(v);
  return { ...s, coverage_from_height: num(s.coverage_from_height), coverage_from_time: num(s.coverage_from_time),
    through_height: num(s.through_height), through_time: num(s.through_time), rebuild_next_height: num(s.rebuild_next_height) };
}

async function chainTip(db) {
  const { rows } = await db.query('SELECT height, hash, timestamp FROM blocks ORDER BY height DESC LIMIT 1');
  return rows[0] ? { height: Number(rows[0].height), hash: rows[0].hash, time: Number(rows[0].timestamp) } : null;
}

async function storedLabels(db) {
  const { rows } = await db.query('SELECT address, entity FROM exchange_flow_labels ORDER BY address');
  return x.labelSet(rows.map(r => r.address), rows.map(r => r.entity));
}

/** Addresses whose entity differs between two label sets (added, removed or remapped). */
function changedAddresses(before, after) {
  const a = new Map(before.addresses.map((addr, i) => [addr, before.entities[i]]));
  const b = new Map(after.addresses.map((addr, i) => [addr, after.entities[i]]));
  const out = [];
  for (const [addr, e] of a) if (b.get(addr) !== e) out.push(addr);
  for (const addr of b.keys()) if (!a.has(addr)) out.push(addr);
  return out.sort();
}

const mergeSkipped = (into, from) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v; return into; };

async function recomputeDays(client, days) {
  if (!days.length) return 0;
  await client.query('DELETE FROM exchange_flow_daily WHERE day = ANY($1::date[])', [days]);
  const { rowCount } = await client.query(`INSERT INTO exchange_flow_daily
      (day, entity, deposits_zat, withdrawals_zat, deposit_count, withdrawal_count, label_version)
    SELECT day, entity,
      COALESCE(sum(amount_zat) FILTER (WHERE direction = 'deposit'), 0),
      COALESCE(sum(amount_zat) FILTER (WHERE direction = 'withdrawal'), 0),
      count(*) FILTER (WHERE direction = 'deposit'), count(*) FILTER (WHERE direction = 'withdrawal'),
      CASE WHEN count(DISTINCT label_version) = 1 THEN min(label_version) ELSE 'mixed' END
    FROM exchange_flows WHERE day = ANY($1::date[]) GROUP BY day, entity`, [days]);
  return rowCount;
}

/**
 * Replace stored rows in one transaction: delete `where` (plus any row for a
 * transaction being written), insert `events`, recompute every touched day,
 * then run `after(client)` (state updates) before COMMIT.
 */
async function replaceRows(client, { where, params, events, version, after }) {
  const keep = events.filter(e => x.postable(e.entity));
  const txids = [...new Set(keep.map(e => e.txid))];
  await client.query('BEGIN');
  try {
    const n = params.length;
    const del = await client.query(`DELETE FROM exchange_flows WHERE (${where}) OR txid = ANY($${n + 1}::text[]) RETURNING day::text`,
      [...params, txids]);
    let ins = { rows: [] };
    if (keep.length) {
      ins = await client.query(`INSERT INTO exchange_flows
          (txid, entity, direction, block_height, block_hash, block_time, day, amount_zat, counterparty, label_version)
        SELECT e.txid, e.entity, e.direction, e.height, e.hash, e.time,
          (to_timestamp(e.time) AT TIME ZONE 'UTC')::date, e.amount, e.counterparty, $9
        FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::bigint[], $7::bigint[], $8::text[])
          AS e(txid, entity, direction, height, hash, time, amount, counterparty)
        RETURNING day::text`, [keep.map(e => e.txid), keep.map(e => e.entity), keep.map(e => e.direction),
        keep.map(e => e.blockHeight), keep.map(e => e.blockHash), keep.map(e => e.blockTime),
        keep.map(e => e.amountZat), keep.map(e => e.counterparty), version]);
    }
    const days = [...new Set([...del.rows, ...ins.rows].map(r => r.day))].sort();
    await recomputeDays(client, days);
    if (after) await after(client);
    await client.query('COMMIT');
    return { deleted: del.rows.length, inserted: ins.rows.length, days: days.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function replaceLabelSnapshot(client, labels) {
  await client.query('DELETE FROM exchange_flow_labels');
  if (labels.addresses.length) await client.query(`INSERT INTO exchange_flow_labels(address, entity)
    SELECT * FROM unnest($1::text[], $2::text[])`, [labels.addresses, labels.entities]);
}

const classifierOf = version => String(version || '').split(':')[0];

/**
 * Full rebuild over every canonical block, in height batches. Resumes an
 * interrupted rebuild of the same label version. Readers see `stale` until
 * the final step flips label_version and ready.
 */
async function rebuild(client, { labels, batchBlocks = BATCH_BLOCKS, log = () => {}, now = () => Date.now() } = {}) {
  const started = now();
  const state = await readState(client);
  if (!state) throw new Error('exchange_flow_state missing: apply migration 046 first');
  const { rows: [first] } = await client.query('SELECT height, timestamp FROM blocks ORDER BY height ASC LIMIT 1');
  let tip = await chainTip(client);
  if (!first || !tip) throw new Error('no blocks indexed');
  const resume = state.rebuild_label_version === labels.version && state.rebuild_next_height != null;
  let height = resume ? state.rebuild_next_height : Number(first.height);
  log(`${resume ? 'Resuming' : 'Starting'} rebuild ${labels.version} at height ${height}; tip ${tip.height}; ${labels.addresses.length} labelled addresses`);
  await client.query(`UPDATE exchange_flow_state SET rebuild_label_version = $1, rebuild_next_height = $2, updated_at = now() WHERE id = 1`,
    [labels.version, height]);
  const skipped = resume && state.last_skipped?.rebuild === labels.version ? { ...(state.last_skipped.counts || {}) } : {};
  const totals = { batches: 0, events: 0, deleted: 0, readMs: 0, writeMs: 0 };
  for (;;) {
    if (height > tip.height) {
      const latest = await chainTip(client);
      if (latest.height <= tip.height) break;
      tip = latest;
    }
    const end = Math.min(height + batchBlocks - 1, tip.height);
    const t0 = now();
    const { events, skipped: s } = await x.readEventsByHeight(client, labels, height, end);
    const t1 = now();
    const next = end + 1;
    mergeSkipped(skipped, s);
    const w = await replaceRows(client, { where: 'block_height BETWEEN $1 AND $2', params: [height, end], events, version: labels.version,
      after: c => c.query(`UPDATE exchange_flow_state SET rebuild_next_height = $1, last_skipped = $2, updated_at = now() WHERE id = 1`,
        [next, { rebuild: labels.version, counts: skipped }]) });
    totals.batches++; totals.events += w.inserted; totals.deleted += w.deleted;
    totals.readMs += t1 - t0; totals.writeMs += now() - t1;
    log(`  ${height}-${end}: ${w.inserted} events, ${w.deleted} replaced, ${w.days} days, read ${t1 - t0}ms write ${now() - t1}ms`);
    height = next;
  }
  // Final flip: drop rows from another label version or above the tip, then publish.
  const final = await replaceRows(client, { where: 'label_version <> $1 OR block_height > $2', params: [labels.version, tip.height],
    events: [], version: labels.version, after: async c => {
      await replaceLabelSnapshot(c, labels);
      await c.query(`UPDATE exchange_flow_state SET ready = true, label_version = $1, coverage_from_height = $2, coverage_from_time = $3,
        through_height = $4, through_hash = $5, through_time = $6, rebuild_label_version = NULL, rebuild_next_height = NULL,
        last_run_at = now(), last_skipped = $7, updated_at = now() WHERE id = 1`,
      [labels.version, Number(first.height), Number(first.timestamp), tip.height, tip.hash, tip.time, { rebuild: labels.version, counts: skipped }]);
    } });
  return { ...totals, removedStale: final.deleted, skipped, tip, elapsedMs: now() - started };
}

/**
 * Re-classify only the transactions touching addresses whose entity changed,
 * then adopt the new label map. Idempotent: an interrupted repair leaves the
 * old label_version and repeats from the same diff.
 */
async function repairLabels(client, { labels, affected, log = () => {} }) {
  let events = 0, deleted = 0;
  const skipped = {};
  for (let i = 0; i < affected.length; i += TXID_BATCH) {
    const batch = affected.slice(i, i + TXID_BATCH);
    const read = await x.readEventsByTxids(client, labels, batch);
    mergeSkipped(skipped, read.skipped);
    const w = await replaceRows(client, { where: 'txid = ANY($1::text[])', params: [batch], events: read.events, version: labels.version });
    events += w.inserted; deleted += w.deleted;
  }
  await replaceRows(client, { where: 'FALSE', params: [], events: [], version: labels.version, after: async c => {
    await replaceLabelSnapshot(c, labels);
    // Untouched rows were classified identically under the new labels.
    await c.query('UPDATE exchange_flows SET label_version = $1 WHERE label_version <> $1', [labels.version]);
    await c.query('UPDATE exchange_flow_daily SET label_version = $1 WHERE label_version <> $1', [labels.version]);
    await c.query('UPDATE exchange_flow_state SET label_version = $1, updated_at = now() WHERE id = 1', [labels.version]);
  } });
  log(`Label repair: ${affected.length} affected transactions, ${events} events written, ${deleted} replaced`);
  return { affected: affected.length, events, deleted, skipped };
}

/**
 * Incremental run: apply label changes (bounded), drop orphaned rows, then
 * re-read [through - overlap, tip] and replace it.
 */
async function refresh(client, { labels, maxAffected = MAX_AUTO_AFFECTED, log = () => {} } = {}) {
  const state = await readState(client);
  if (!state) throw new Error('exchange_flow_state missing: apply migration 046 first');
  // An interrupted rebuild leaves mixed rows: only --rebuild may continue it.
  if (state.rebuild_label_version) return { action: 'rebuild-in-progress', stale: true };
  if (!state.ready) return { action: 'not-built' };
  if (classifierOf(state.label_version) !== classifierOf(labels.version)) return { action: 'classifier-changed', stale: true };
  let use = await storedLabels(client);
  let repair = null, deferred = false;
  if (labels.version !== state.label_version) {
    const changed = changedAddresses(use, labels);
    const { rows } = await client.query(`SELECT DISTINCT txid FROM address_transactions
      WHERE address = ANY($1::text[]) AND block_height <= $2`, [changed, state.through_height]);
    const affected = rows.map(r => r.txid).sort();
    log(`Labels changed: ${changed.length} addresses, ${affected.length} affected transactions`);
    if (affected.length > maxAffected) {
      deferred = true;
      log(`Deferring label repair (> ${maxAffected}); rows keep ${state.label_version} and read stale. Run --rebuild.`);
    } else {
      repair = await repairLabels(client, { labels, affected, log });
      use = labels;
    }
  }
  const tip = await chainTip(client);
  let from = state.through_height - OVERLAP_BLOCKS + 1;
  const { rows: [h] } = await client.query('SELECT hash FROM blocks WHERE height = $1', [state.through_height]);
  const reorged = !h || h.hash !== state.through_hash;
  if (reorged) from = Math.min(from, state.through_height - REORG_WINDOW + 1);
  const { rows: [orphan] } = await client.query(`SELECT min(f.block_height) AS height FROM exchange_flows f
    WHERE f.block_height > $1 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.height = f.block_height AND b.hash = f.block_hash)`,
  [state.through_height - REORG_WINDOW]);
  if (orphan?.height != null) from = Math.min(from, Number(orphan.height));
  from = Math.max(from, state.coverage_from_height ?? 0);
  const { events, skipped } = await x.readEventsByHeight(client, use, from, tip.height);
  const w = await replaceRows(client, { where: 'block_height >= $1', params: [from], events, version: use.version,
    after: c => c.query(`UPDATE exchange_flow_state SET through_height = $1, through_hash = $2, through_time = $3,
      last_run_at = now(), last_skipped = $4, updated_at = now() WHERE id = 1`, [tip.height, tip.hash, tip.time, { from, to: tip.height, counts: skipped }]) });
  return { action: 'incremental', from, to: tip.height, reorged, orphanHeight: orphan?.height == null ? null : Number(orphan.height),
    ...w, skipped, repair, deferred, stale: deferred };
}

// ─── Readers ────────────────────────────────────────────────────────────────

/**
 * Dataset status for readers: unavailable | stale | ok, with reason. Reads
 * the live labels so a label edit is visible immediately.
 */
async function status(db, { labels } = {}) {
  const state = await readState(db).catch(error => { if (error.code === '42P01') return null; throw error; });
  if (!state || !state.ready) return { status: 'unavailable', reason: state?.rebuild_label_version ? 'rebuild-in-progress' : 'not-built', state };
  const live = labels || await x.loadLabels(db);
  const tip = await chainTip(db);
  const lagBlocks = tip ? tip.height - state.through_height : null;
  let reason = null;
  if (state.rebuild_label_version) reason = 'rebuild-in-progress';
  else if (classifierOf(state.label_version) !== classifierOf(live.version)) reason = 'classifier-changed';
  else if (state.label_version !== live.version) reason = 'labels-changed';
  else if (lagBlocks == null || lagBlocks > STALE_LAG_BLOCKS) reason = 'behind-tip';
  return { status: reason ? 'stale' : 'ok', reason, state, currentLabelVersion: live.version, tipHeight: tip?.height ?? null, lagBlocks };
}

const rowEvent = r => ({ txid: r.txid, entity: r.entity, direction: r.direction, amountZat: String(r.amount_zat),
  blockHeight: Number(r.block_height), blockHash: r.block_hash, blockTime: Number(r.block_time), counterparty: r.counterparty });

/** Stored events with block_time in [fromS, toS] and amount >= minZat, oldest first. */
async function recentEvents(db, fromS, toS, minZat = 0n) {
  const { rows } = await db.query(`SELECT txid, entity, direction, amount_zat::text, block_height, block_hash, block_time, counterparty
    FROM exchange_flows WHERE block_time >= $1 AND block_time <= $2 AND amount_zat >= $3 AND entity = ANY($4::text[])
    ORDER BY block_time, txid, entity, direction`, [fromS, toS, String(minZat), x.ENTITY_IDS]);
  return rows.map(rowEvent);
}

/**
 * Same contract as the in-memory rankEvent: every named-entity event of the
 * same direction in the 30 days before it; the histogram is that exact sample.
 */
/**
 * Rank against stored rows of the same direction in the 30 days up to and
 * including the event's own block: other events of that block count, the
 * event's own row (txid, entity, direction) does not, later blocks never do.
 * Same sample and histogram as rankEvent in server/bot/lib/exchange-flows.js.
 */
async function rankStored(db, event) {
  const height = event.blockHeight == null ? null : Number(event.blockHeight);
  const params = [event.direction, Number(event.blockTime), String(event.amountZat), x.ENTITY_IDS, RANK_WINDOW_S, BINS_PER_DECADE,
    event.txid ?? null, event.entity ?? null, height];
  const { rows } = await db.query(`SELECT floor(log(10, amount_zat::numeric / 100000000) * $6)::int AS bin, count(*)::int AS n,
      count(*) FILTER (WHERE amount_zat > $3::bigint)::int AS greater, count(*) FILTER (WHERE amount_zat = $3::bigint)::int AS equal
    FROM exchange_flows WHERE direction = $1 AND block_time >= $2::bigint - $5::bigint AND block_time <= $2::bigint
      AND ($9::int IS NULL OR block_height <= $9::int)
      AND (txid, entity) IS DISTINCT FROM ($7::text, $8::text)
      AND amount_zat > 0 AND entity = ANY($4::text[])
    GROUP BY 1 ORDER BY 1`, params);
  let n = 0, greater = 0, equal = 0;
  for (const r of rows) { n += r.n; greater += r.greater; equal += r.equal; }
  return { sample_count: n, greater_count: greater, equal_count: equal,
    distribution: { bins: rows.map(r => ({ bin: r.bin, n: r.n })), total: n } };
}

/** Exact deposits, withdrawals and net (signed) in (endS - 24h, endS], per entity or across all named entities. */
async function netStored(db, endS, entity = null) {
  const { rows: [r] } = await db.query(`SELECT COALESCE(sum(amount_zat) FILTER (WHERE direction = 'deposit'), 0)::text AS d,
      COALESCE(sum(amount_zat) FILTER (WHERE direction = 'withdrawal'), 0)::text AS w, count(*)::int AS n
    FROM exchange_flows WHERE block_time > $1::bigint - 86400 AND block_time <= $1::bigint AND entity = ANY($2::text[])`,
  [Number(endS), entity ? [entity] : x.ENTITY_IDS]);
  return { depositsZat: r.d, withdrawalsZat: r.w, netZat: (BigInt(r.d) - BigInt(r.w)).toString(), count: r.n };
}

// ─── Daily API read ─────────────────────────────────────────────────────────

class ExchangeFlowQueryError extends Error {
  // publicMessage is always one of the fixed strings below, safe to return to clients.
  constructor(message, status = 400, extra = {}) { super(message); this.publicMessage = message; this.status = status; Object.assign(this, extra); }
}
const MAX_DAYS = 4000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = d => DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_S * 1000).toISOString().slice(0, 10);

function parseDailyQuery(query = {}, now = Date.now()) {
  const entity = query.entity == null || query.entity === '' ? 'all' : String(query.entity);
  if (entity !== 'all' && !x.ENTITY_IDS.includes(entity)) throw new ExchangeFlowQueryError('Unknown entity');
  const today = new Date(now).toISOString().slice(0, 10);
  const to = query.to == null || query.to === '' ? today : String(query.to);
  if (!validDate(to)) throw new ExchangeFlowQueryError('to must be YYYY-MM-DD');
  const from = query.from == null || query.from === '' ? addDays(to, -89) : String(query.from);
  if (!validDate(from)) throw new ExchangeFlowQueryError('from must be YYYY-MM-DD');
  if (from > to) throw new ExchangeFlowQueryError('from must not be after to');
  const span = (Date.parse(to) - Date.parse(from)) / (DAY_S * 1000) + 1;
  if (span > MAX_DAYS) throw new ExchangeFlowQueryError(`At most ${MAX_DAYS} days`);
  return { entity, from, to };
}

/**
 * Daily deposits, withdrawals and net per entity or across all named
 * entities. Days outside coverage are null with coverage 'none'; the day
 * holding through_time is 'partial'. Totals are null unless every requested
 * day is at least partially covered.
 */
async function dailyFlows(db, query, { now = Date.now() } = {}) {
  const q = parseDailyQuery(query, now);
  const st = await status(db);
  if (st.status === 'unavailable') throw new ExchangeFlowQueryError('Exchange flow history is not available yet', 503, { reason: st.reason });
  const s = st.state, fromDay = dayOf(s.coverage_from_time), throughDay = dayOf(s.through_time);
  const { rows } = await db.query(`SELECT day::text AS day, sum(deposits_zat)::text AS d, sum(withdrawals_zat)::text AS w,
      sum(deposit_count)::int AS dn, sum(withdrawal_count)::int AS wn
    FROM exchange_flow_daily WHERE day BETWEEN $1::date AND $2::date AND entity = ANY($3::text[]) GROUP BY day`,
  [q.from, q.to, q.entity === 'all' ? x.ENTITY_IDS : [q.entity]]);
  const byDay = new Map(rows.map(r => [r.day, r]));
  const days = [];
  let dep = 0n, wd = 0n, dn = 0, wn = 0, uncovered = 0;
  for (let d = q.from; d <= q.to; d = addDays(d, 1)) {
    if (d < fromDay || d > throughDay) {
      uncovered++;
      days.push({ date: d, coverage: 'none', depositsZat: null, withdrawalsZat: null, netZat: null, depositCount: null, withdrawalCount: null });
      continue;
    }
    const r = byDay.get(d);
    const D = BigInt(r?.d ?? 0), W = BigInt(r?.w ?? 0);
    dep += D; wd += W; dn += r?.dn ?? 0; wn += r?.wn ?? 0;
    days.push({ date: d, coverage: d === throughDay ? 'partial' : 'complete', depositsZat: D.toString(), withdrawalsZat: W.toString(),
      netZat: (D - W).toString(), depositCount: r?.dn ?? 0, withdrawalCount: r?.wn ?? 0 });
  }
  const entities = (q.entity === 'all' ? x.ENTITY_IDS : [q.entity]).map(id => ({ id, name: x.ENTITIES[id].name, kind: x.ENTITIES[id].kind }));
  return {
    success: true, status: st.status, staleReason: st.reason, entity: q.entity, from: q.from, to: q.to, unit: 'zatoshi', entities,
    labelVersion: s.label_version, currentLabelVersion: st.currentLabelVersion,
    coverage: { fromDate: fromDay, throughDate: throughDay, throughHeight: s.through_height, throughHash: s.through_hash,
      throughTime: s.through_time, tipHeight: st.tipHeight, lagBlocks: st.lagBlocks },
    totals: uncovered ? null : { depositsZat: dep.toString(), withdrawalsZat: wd.toString(), netZat: (dep - wd).toString(), depositCount: dn, withdrawalCount: wn },
    days,
  };
}

module.exports = { DAY_S, REORG_WINDOW, OVERLAP_BLOCKS, BATCH_BLOCKS, TXID_BATCH, MAX_AUTO_AFFECTED, STALE_LAG_BLOCKS, RANK_WINDOW_S, BINS_PER_DECADE, MAX_DAYS,
  dayOf, readState, chainTip, storedLabels, changedAddresses, recomputeDays, replaceRows, rebuild, repairLabels, refresh,
  status, recentEvents, rankStored, netStored, ExchangeFlowQueryError, parseDailyQuery, dailyFlows };
