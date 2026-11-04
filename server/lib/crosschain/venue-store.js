"use strict";

const { VENUES } = require("./venue-providers");
const waitDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODES = ["backfill", "sync"];

function validate(venue, mode) {
  if (!Object.hasOwn(VENUES, venue) || !MODES.includes(mode))
    throw new Error("Unknown venue or traversal mode");
}
function multiplyDecimals(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !/^\d{1,160}(?:\.\d{1,40})?$/.test(left) || !/^\d{1,160}(?:\.\d{1,40})?$/.test(right))
    return null;
  const [li, lf = ""] = left.split(".");
  const [ri, rf = ""] = right.split(".");
  const scale = lf.length + rf.length;
  const product = (BigInt(li + lf) * BigInt(ri + rf)).toString().padStart(scale + 1, "0");
  if (!scale) return product;
  const fraction = product.slice(-scale).replace(/0+$/, "");
  return product.slice(0, -scale) + (fraction ? `.${fraction}` : "");
}
function valuedRecord(record) {
  // These are derived swap-start valuations from historical provider prices,
  // never a current-spot fallback or an unqualified settlement-time USD amount.
  const eligible = record.actionType === "swap" && record.status === "SUCCESS";
  const hasSecuredAsset = (transactions, asset) => transactions?.some((tx) => tx.coins?.some((coin) =>
    coin.asset === asset && coin.settlement === "secured"));
  const value = (amount, quote, unsupported) => eligible && !unsupported && quote && /^\d+(?:\.\d+)?$/.test(quote) &&
    /[1-9]/.test(quote) ? multiplyDecimals(amount, quote) : null;
  const sourceSecured = hasSecuredAsset(record.inputs, record.sourceAsset);
  const destSecured = hasSecuredAsset(record.outputs, record.destAsset);
  const sourceAmountUsd = value(record.sourceAmount, record.sourcePriceUsd, sourceSecured);
  const destAmountUsd = value(record.destAmount, record.destPriceUsd, destSecured);
  return {
    ...record, sourceAmountUsd, destAmountUsd,
    valuation: {
      sourceBasis: sourceAmountUsd == null ? null : "source-amount-times-midgard-first-interval-price",
      destinationBasis: destAmountUsd == null ? null : "destination-amount-times-midgard-first-interval-price",
      authority: "Midgard historical swap metadata",
      sourceUnavailableReason: sourceSecured ? "secured-share-price-unit-unverified" : null,
      destinationUnavailableReason: destSecured ? "secured-share-price-unit-unverified" : null,
      observedActionAt: record.createdAt,
      note: "Asset prices at the first streaming interval; not settlement-time prices. Missing or nonpositive prices are unavailable.",
    },
  };
}

async function upsertAction(db, row, observedAt) {
  if (!row || !Object.hasOwn(VENUES, row.venue) || typeof row.id !== "string" ||
      !row.id.startsWith(`${row.venue}-`) || !Number.isFinite(Date.parse(observedAt)))
    throw new Error("Invalid normalized venue observation");
  const r = valuedRecord(row);
  await db.query(`INSERT INTO crosschain_venue_actions (
    venue,id,action_type,status,swap_created_at,created_at_ns,
    source_chain,source_token,source_asset,dest_chain,dest_token,dest_asset,
    source_amount,dest_amount,zec_amount_zat,source_amount_usd,dest_amount_usd,
    source_tx_hashes,dest_tx_hashes,canonical_identity,payload,last_seen_at,status_observed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22)
    ON CONFLICT (venue,id) DO UPDATE SET
      action_type=EXCLUDED.action_type,
      status_observed_at=CASE WHEN crosschain_venue_actions.status<>EXCLUDED.status
        THEN EXCLUDED.status_observed_at ELSE crosschain_venue_actions.status_observed_at END,
      status=EXCLUDED.status,swap_created_at=EXCLUDED.swap_created_at,created_at_ns=EXCLUDED.created_at_ns,
      source_chain=EXCLUDED.source_chain,source_token=EXCLUDED.source_token,source_asset=EXCLUDED.source_asset,
      dest_chain=EXCLUDED.dest_chain,dest_token=EXCLUDED.dest_token,dest_asset=EXCLUDED.dest_asset,
      source_amount=EXCLUDED.source_amount,dest_amount=EXCLUDED.dest_amount,zec_amount_zat=EXCLUDED.zec_amount_zat,
      source_amount_usd=EXCLUDED.source_amount_usd,dest_amount_usd=EXCLUDED.dest_amount_usd,
      source_tx_hashes=EXCLUDED.source_tx_hashes,dest_tx_hashes=EXCLUDED.dest_tx_hashes,
      canonical_identity=EXCLUDED.canonical_identity,payload=EXCLUDED.payload,last_seen_at=EXCLUDED.last_seen_at
    WHERE crosschain_venue_actions.last_seen_at <= EXCLUDED.last_seen_at`, [
    r.venue,r.id,r.actionType,r.status,r.createdAt,r.createdAtNs,
    r.sourceChain,r.sourceToken,r.sourceAsset,r.destChain,r.destToken,r.destAsset,
    r.sourceAmount,r.destAmount,r.zecAmountZat,r.sourceAmountUsd,r.destAmountUsd,
    r.sourceTxHashes || [],r.destTxHashes || [],r.canonicalIdentity,JSON.stringify(r),observedAt,
  ]);
}

const iso = (value) => value ? new Date(value).toISOString() : null;
function earlier(left, right) { return !left || right < left ? right : left; }
function later(left, right) { return !left || right > left ? right : left; }
function validatePage(page, venue, cursor, limit) {
  if (!page || page.venue !== venue || !Array.isArray(page.transfers) || page.transfers.length > limit ||
      !page.coverage || !Number.isInteger(page.coverage.returnedActions) ||
      page.coverage.returnedActions < page.transfers.length || page.coverage.returnedActions > limit ||
      !Number.isFinite(Date.parse(page.coverage.observedAt)) ||
      (page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor)))
    throw new Error("Invalid venue page; checkpoint preserved");
  if (page.coverage.returnedActions > 0 && !page.nextCursor)
    throw new Error("Nonempty venue page omitted its continuation; checkpoint preserved");
  const ids = new Set();
  for (const row of page.transfers) {
    if (row.venue !== venue || typeof row.id !== "string" || ids.has(row.id) ||
        !/^\d+$/.test(row.createdAtNs) || !Number.isFinite(Date.parse(row.createdAt)))
      throw new Error("Invalid venue action; checkpoint preserved");
    ids.add(row.id);
  }
}

async function commitPage(db, page, { venue, mode, state, complete }) {
  const observedAt = page.coverage.observedAt;
  const dates = page.transfers.map((r) => r.createdAt).sort();
  const newHead = page.transfers.reduce((max, r) => max == null || BigInt(r.createdAtNs) > BigInt(max)
    ? r.createdAtNs : max, state?.head_created_at_ns || null);
  const earliest = dates.length ? earlier(iso(state?.earliest_seen_at), dates[0]) : iso(state?.earliest_seen_at);
  const latest = dates.length ? later(iso(state?.latest_seen_at), dates[dates.length - 1]) : iso(state?.latest_seen_at);
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL statement_timeout='15s'");
    for (const row of page.transfers) await upsertAction(db, row, observedAt);
    const next = (await db.query(`INSERT INTO crosschain_venue_sync (
      venue,mode,cursor,snapshot_at,head_created_at_ns,earliest_seen_at,latest_seen_at,
      pages,actions,excluded_actions,completed_at,as_of,last_advanced_at,last_checked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now())
      ON CONFLICT (venue,mode) DO UPDATE SET
        cursor=EXCLUDED.cursor,snapshot_at=EXCLUDED.snapshot_at,head_created_at_ns=EXCLUDED.head_created_at_ns,
        earliest_seen_at=EXCLUDED.earliest_seen_at,latest_seen_at=EXCLUDED.latest_seen_at,
        pages=EXCLUDED.pages,actions=EXCLUDED.actions,excluded_actions=EXCLUDED.excluded_actions,
        completed_at=EXCLUDED.completed_at,as_of=EXCLUDED.as_of,last_advanced_at=now(),last_checked_at=now()
      RETURNING *`, [
      venue, mode, complete ? null : page.nextCursor, iso(state?.snapshot_at) || observedAt,
      newHead, earliest, latest,
      Number(state?.pages || 0) + 1, Number(state?.actions || 0) + page.transfers.length,
      Number(state?.excluded_actions || 0) + (page.coverage.excludedNonNativeActions || 0),
      complete ? observedAt : null, observedAt,
    ])).rows[0];
    await db.query("COMMIT");
    return next;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/** A bounded resumable provider traversal. The caller explicitly supplies the DB. */
async function traverseVenue(pool, client, { venue, mode = "backfill", maxPages = 20,
  pageSize = 50, delayMs = 1000, wait = waitDefault, log = () => {} } = {}) {
  validate(venue, mode);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 ||
      !Number.isInteger(delayMs) || delayMs < 300 || delayMs > 60000)
    throw new Error("Invalid venue traversal bounds");
  const db = await pool.connect();
  let locked = false;
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS acquired",
      [`zecblock-venue:${venue}`, mode])).rows[0].acquired;
    if (!locked) return { venue, mode, locked: true, complete: false, pages: 0, actions: 0 };
    let state = (await db.query("SELECT * FROM crosschain_venue_sync WHERE venue=$1 AND mode=$2", [venue,mode])).rows[0];
    if (mode === "backfill" && state?.completed_at)
      return { venue, mode, complete: true, pages: 0, actions: 0, checkpoint: state };
    if (mode === "sync" && state?.completed_at) {
      // Do not persist this reset until a full page and its data commit together.
      state = { ...state, cursor: null, snapshot_at: null, head_created_at_ns: null,
        pages: 0, actions: 0, excluded_actions: 0, completed_at: null };
    }
    let pages = 0, actions = 0;
    while (pages < maxPages) {
      if (pages > 0) await wait(delayMs);
      const cursor = state?.cursor || null;
      const page = await client.readPage({ cursor, limit: pageSize });
      validatePage(page, venue, cursor, pageSize);
      if (state?.head_created_at_ns && page.transfers.some((row) => BigInt(row.createdAtNs) > BigInt(state.head_created_at_ns)))
        throw new Error("Venue cursor exceeded its fixed snapshot head; checkpoint preserved");
      let complete = page.coverage.returnedActions === 0 && !page.nextCursor;
      if (mode === "sync" && page.transfers.length) {
        const known = (await db.query("SELECT id,status FROM crosschain_venue_actions WHERE venue=$1 AND id=ANY($2::text[])",
          [venue,page.transfers.map((r) => r.id)])).rows;
        // Every row in the boundary page is refreshed before stopping. Older
        // pending actions need explicit refreshUnsettled, not a freshness claim.
        complete ||= known.some((r) => r.status !== "PROCESSING");
      }
      state = await commitPage(db, page, { venue, mode, state, complete });
      pages++; actions += page.transfers.length;
      log({ venue, mode, pages, actions, complete, oldest: iso(state?.earliest_seen_at) });
      if (complete) return { venue, mode, complete: true, pages, actions, checkpoint: state };
    }
    return { venue, mode, complete: false, yielded: true, pages, actions, checkpoint: state };
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1),hashtext($2))", [`zecblock-venue:${venue}`,mode]).catch(() => {});
    db.release();
  }
}

/** Explicit bounded refresh for old pending observations, with no history claim. */
async function refreshUnsettled(pool, client, { venue, limit = 2, delayMs = 1000,
  wait = waitDefault } = {}) {
  validate(venue, "sync");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 ||
      !Number.isInteger(delayMs) || delayMs < 300 || delayMs > 60000)
    throw new Error("Invalid pending refresh bounds");
  const db = await pool.connect();
  let locked = false;
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS acquired",
      [`zecblock-venue:${venue}`,"sync"])).rows[0].acquired;
    if (!locked) return { locked: true, checked: 0 };
    const rows = (await db.query(`SELECT id,source_tx_hashes FROM crosschain_venue_actions
      WHERE venue=$1 AND status='PROCESSING' ORDER BY last_seen_at,id LIMIT $2`, [venue,limit])).rows;
    let checked = 0;
    for (const row of rows) {
      if (checked > 0) await wait(delayMs);
      const txid = row.source_tx_hashes?.[0];
      if (!txid) continue;
      const page = await client.readPage({ txid, limit: 50 });
      // The bounded lookup must actually contain this identity before mutation.
      if (!page.transfers.some((r) => r.id === row.id))
        throw new Error("Pending venue action absent from identity lookup");
      await db.query("BEGIN");
      try {
        for (const action of page.transfers) await upsertAction(db, action, page.coverage.observedAt);
        await db.query("COMMIT");
      } catch (err) { await db.query("ROLLBACK"); throw err; }
      checked++;
    }
    return { checked };
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1),hashtext($2))", [`zecblock-venue:${venue}`,"sync"]).catch(() => {});
    db.release();
  }
}

module.exports = { multiplyDecimals, valuedRecord, upsertAction, traverseVenue, refreshUnsettled };
