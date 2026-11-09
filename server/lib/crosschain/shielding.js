"use strict";
// Shielded-rate tracking: what share of ZEC delivered by successful NEAR 1Click
// inflow swaps reaches a shielded pool, either directly on arrival or on the
// first spend of the delivered transparent output.
//
// Classification reuses the Turnstile rules (server/jobs/refresh-turnstile.js):
// one spend hop, priority shield > exchange > bridge > transferred, unspent is
// held. Swaps whose Zcash leg cannot be tied to chain data are counted as
// uncovered, never as zero or as "not shielded".
const { source } = require("./analytics");

const ARRIVALS = ["no_zec_tx", "tx_not_indexed", "unmatched", "shielded", "transparent"];
const COVERED = ["shielded", "transparent"];
const OUTCOMES = ["held", "shielded", "exchange", "bridge", "transferred"];
const RECHECK_DAYS = 120; // held/uncovered rows newer than this are re-examined
// Swaps credited to a NEAR Intents balance never reach a Zcash address, so they
// are outside the population (reported separately), not uncovered deliveries.
const POPULATION = `s.status='SUCCESS' AND s.direction='inflow'
  AND COALESCE(s.payload->>'recipientType','DESTINATION_CHAIN') <> 'INTENTS'`;
const INTENTS_BALANCE = `s.status='SUCCESS' AND s.direction='inflow' AND s.payload->>'recipientType' = 'INTENTS'`;

/**
 * Recompute classification rows for the given swap identities in one
 * transaction. `targets` is [{ address, memo }]. Returns number of rows written.
 * Must be called on a single checked-out primary client (temp tables).
 */
async function classifySwaps(client, targets, { v2 }) {
  if (targets.length === 0) return 0;
  const addresses = targets.map((t) => t.address);
  const memos = targets.map((t) => t.memo);
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE TEMP TABLE _cs_swaps ON COMMIT DROP AS
       ${source(v2)}
       SELECT s.deposit_address, s.deposit_memo, s.swap_created_at, s.source_chain,
              s.payload->>'recipient' AS recipient,
              -- A non-hex hash is a NEAR transaction, not a Zcash delivery.
              CASE WHEN s.zec_txid ~ '^[0-9a-f]{64}$' THEN s.zec_txid END AS zec_txid,
              CASE WHEN s.dest_amount IS NOT NULL AND s.dest_amount >= 0 AND s.dest_amount <= 21000000
                   THEN round(s.dest_amount * 100000000)::bigint END AS reported_zat
       FROM swaps s
       JOIN unnest($1::text[], $2::text[]) AS t(address, memo)
         ON t.address = s.deposit_address AND t.memo = s.deposit_memo
       WHERE ${POPULATION}`,
      [addresses, memos],
    );
    // Canonical delivery transaction (orphaned transactions leave this table).
    await client.query(
      `CREATE TEMP TABLE _cs_tx ON COMMIT DROP AS
       SELECT s.deposit_address, s.deposit_memo, t.block_time,
              EXISTS (SELECT 1 FROM shielded_flows sf
                      WHERE sf.txid = s.zec_txid AND sf.flow_type = 'shield') AS has_shield
       FROM _cs_swaps s JOIN transactions t ON t.txid = s.zec_txid`,
    );
    // Transparent outputs paid to a transparent recipient.
    await client.query(
      `CREATE TEMP TABLE _cs_outputs ON COMMIT DROP AS
       SELECT s.deposit_address, s.deposit_memo, o.txid, o.vout_index, o.value::bigint AS value,
              ti.txid AS spending_txid
       FROM _cs_swaps s
       JOIN _cs_tx x USING (deposit_address, deposit_memo)
       JOIN transaction_outputs o ON o.txid = s.zec_txid AND o.address = s.recipient
       LEFT JOIN transaction_inputs ti ON ti.prev_txid = o.txid AND ti.prev_vout = o.vout_index
       WHERE s.recipient LIKE 't%'`,
    );
    await client.query(
      `CREATE TEMP TABLE _cs_spend ON COMMIT DROP AS
       SELECT sp.spending_txid,
              EXISTS (SELECT 1 FROM shielded_flows sf WHERE sf.txid = sp.spending_txid AND sf.flow_type = 'shield') AS shield,
              EXISTS (SELECT 1 FROM transaction_outputs o JOIN address_labels al ON al.address = o.address
                      WHERE o.txid = sp.spending_txid AND al.category = 'exchange') AS exchange,
              EXISTS (SELECT 1 FROM transaction_outputs o JOIN address_labels al ON al.address = o.address
                      WHERE o.txid = sp.spending_txid AND al.category = 'bridge') AS bridge,
              (SELECT t.block_time FROM transactions t WHERE t.txid = sp.spending_txid) AS block_time
       FROM (SELECT DISTINCT spending_txid FROM _cs_outputs WHERE spending_txid IS NOT NULL) sp`,
    );
    await client.query(
      `DELETE FROM crosschain_shielding c
       USING unnest($1::text[], $2::text[]) AS t(address, memo)
       WHERE c.deposit_address = t.address AND c.deposit_memo = t.memo`,
      [addresses, memos],
    );
    const result = await client.query(
      `WITH per_output AS (
         SELECT o.deposit_address, o.deposit_memo, o.value,
                CASE WHEN o.spending_txid IS NULL THEN 'held'
                     WHEN sp.shield THEN 'shielded'
                     WHEN sp.exchange THEN 'exchange'
                     WHEN sp.bridge THEN 'bridge'
                     ELSE 'transferred' END AS outcome,
                CASE WHEN sp.shield THEN sp.block_time END AS shield_time
         FROM _cs_outputs o LEFT JOIN _cs_spend sp ON sp.spending_txid = o.spending_txid
       ), per_swap AS (
         SELECT deposit_address, deposit_memo, sum(value)::bigint AS delivered,
                COALESCE(sum(value) FILTER (WHERE outcome='held'),0)::bigint AS held,
                COALESCE(sum(value) FILTER (WHERE outcome='shielded'),0)::bigint AS shielded,
                COALESCE(sum(value) FILTER (WHERE outcome='exchange'),0)::bigint AS exchange,
                COALESCE(sum(value) FILTER (WHERE outcome='bridge'),0)::bigint AS bridge,
                COALESCE(sum(value) FILTER (WHERE outcome='transferred'),0)::bigint AS transferred,
                min(shield_time) AS first_shield
         FROM per_output GROUP BY deposit_address, deposit_memo
       ), classified AS (
         SELECT s.*, x.block_time, x.has_shield, p.delivered, p.held, p.shielded, p.exchange,
                p.bridge, p.transferred, p.first_shield,
                CASE WHEN s.zec_txid IS NULL THEN 'no_zec_tx'
                     WHEN x.block_time IS NULL THEN 'tx_not_indexed'
                     WHEN p.delivered IS NOT NULL THEN 'transparent'
                     WHEN (s.recipient IS NULL OR s.recipient NOT LIKE 't%') AND x.has_shield
                          AND s.reported_zat IS NOT NULL THEN 'shielded'
                     ELSE 'unmatched' END AS arrival
         FROM _cs_swaps s
         LEFT JOIN _cs_tx x USING (deposit_address, deposit_memo)
         LEFT JOIN per_swap p USING (deposit_address, deposit_memo)
       )
       INSERT INTO crosschain_shielding (deposit_address, deposit_memo, swap_created_at, source_chain,
         recipient, zec_txid, arrival, arrival_block_time, delivered_zat, amount_source,
         held_zat, shielded_zat, exchange_zat, bridge_zat, transferred_zat, first_shield_block_time, classified_at)
       SELECT deposit_address, deposit_memo, swap_created_at, source_chain, recipient, zec_txid, arrival,
         CASE WHEN arrival IN ('shielded','transparent') THEN block_time END,
         CASE arrival WHEN 'transparent' THEN delivered WHEN 'shielded' THEN reported_zat END,
         CASE arrival WHEN 'transparent' THEN 'chain_output' WHEN 'shielded' THEN 'provider_reported' END,
         CASE WHEN arrival='transparent' THEN held ELSE 0 END,
         CASE WHEN arrival='transparent' THEN shielded ELSE 0 END,
         CASE WHEN arrival='transparent' THEN exchange ELSE 0 END,
         CASE WHEN arrival='transparent' THEN bridge ELSE 0 END,
         CASE WHEN arrival='transparent' THEN transferred ELSE 0 END,
         CASE arrival WHEN 'transparent' THEN first_shield WHEN 'shielded' THEN block_time END,
         now()
       FROM classified`,
    );
    await client.query("COMMIT");
    return result.rowCount;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** Successful inflow swaps not yet classified, oldest first. */
async function findUnclassified(client, { v2, limit }) {
  const r = await client.query(
    `${source(v2)}
     SELECT s.deposit_address AS address, s.deposit_memo AS memo FROM swaps s
     WHERE ${POPULATION}
       AND NOT EXISTS (SELECT 1 FROM crosschain_shielding c
                       WHERE c.deposit_address=s.deposit_address AND c.deposit_memo=s.deposit_memo)
     ORDER BY s.swap_created_at, s.deposit_address, s.deposit_memo LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/**
 * Rows whose classification can still change: delivery not indexed yet, held
 * outputs that may be spent, or recipients not yet matched. Bounded window.
 */
async function findOpen(client, { limit, minAgeSeconds = 240, days = RECHECK_DAYS }) {
  const r = await client.query(
    `SELECT deposit_address AS address, deposit_memo AS memo FROM crosschain_shielding
     WHERE (arrival IN ('tx_not_indexed','unmatched') OR (arrival='transparent' AND held_zat > 0))
       AND classified_at < now() - make_interval(secs => $2)
       AND swap_created_at >= now() - make_interval(days => $3)
     ORDER BY classified_at LIMIT $1`,
    [limit, minAgeSeconds, days],
  );
  return r.rows;
}

/** Swaps whose provider record changed after classification (late tx hash). */
async function findChanged(client, { v2, limit }) {
  if (!v2) return [];
  const r = await client.query(
    `SELECT c.deposit_address AS address, c.deposit_memo AS memo
     FROM crosschain_shielding c JOIN crosschain_swaps_v2 v
       ON v.deposit_address=c.deposit_address AND v.deposit_memo=c.deposit_memo
     WHERE v.last_seen_at > c.classified_at OR v.status <> 'SUCCESS'
        OR v.payload->>'recipientType' = 'INTENTS'
     ORDER BY c.classified_at LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/** Rows that are no longer successful inflows (status changed) are removed. */
async function pruneStale(client, { v2 }) {
  const r = await client.query(
    `${source(v2)}
     DELETE FROM crosschain_shielding c WHERE NOT EXISTS (
       SELECT 1 FROM swaps s WHERE s.deposit_address=c.deposit_address AND s.deposit_memo=c.deposit_memo
         AND ${POPULATION})`,
  );
  return r.rowCount;
}

// ─── Reader ────────────────────────────────────────────────────────────────

const PERIOD_DAYS = { "30d": 30, "90d": 90, "1y": 365, all: null };
function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function parseShieldingFilters(q = {}) {
  for (const value of Object.values(q))
    if (value != null && typeof value !== "string") throw invalid("Parameters must be single strings");
  const period = q.period || "90d";
  if (!Object.hasOwn(PERIOD_DAYS, period)) throw invalid("Invalid period");
  return { period };
}

const zat = (v) => (v == null ? null : String(v));
const ratio = (num, den) => {
  const n = BigInt(num || 0), d = BigInt(den || 0);
  if (d === 0n) return null;
  // Fraction 0..1 at basis-point precision (truncated), computed on exact integers.
  return Number((n * 10000n) / d) / 10000;
};

async function readShielding(db, q, { v2 }) {
  const { period } = parseShieldingFilters(q);
  const days = PERIOD_DAYS[period];
  const params = days == null ? [] : [days];
  const window = days == null ? "TRUE" : "swap_created_at >= date_trunc('day', now()) - make_interval(days => $1)";
  const sourceWindow = days == null ? "TRUE" : "s.swap_created_at >= date_trunc('day', now()) - make_interval(days => $1)";

  const sums = `count(*)::int AS swaps,
    count(*) FILTER (WHERE arrival IN ('shielded','transparent'))::int AS covered_swaps,
    count(*) FILTER (WHERE arrival='no_zec_tx')::int AS no_zec_tx,
    count(*) FILTER (WHERE arrival='tx_not_indexed')::int AS tx_not_indexed,
    count(*) FILTER (WHERE arrival='unmatched')::int AS unmatched,
    count(*) FILTER (WHERE arrival='shielded')::int AS shielded_arrivals,
    COALESCE(sum(delivered_zat) FILTER (WHERE arrival IN ('shielded','transparent')),0)::text AS covered_zat,
    COALESCE(sum(delivered_zat) FILTER (WHERE arrival='shielded'),0)::text AS shielded_on_arrival_zat,
    COALESCE(sum(shielded_zat),0)::text AS shielded_after_zat,
    COALESCE(sum(held_zat),0)::text AS held_zat,
    COALESCE(sum(exchange_zat),0)::text AS exchange_zat,
    COALESCE(sum(bridge_zat),0)::text AS bridge_zat,
    COALESCE(sum(transferred_zat),0)::text AS transferred_zat`;

  const [totalRow, dailyRows, chainRows, sourceRow, freshRow, delayRow] = await Promise.all([
    db.query(`SELECT ${sums} FROM crosschain_shielding WHERE ${window}`, params).then((r) => r.rows[0]),
    db.query(
      `SELECT (swap_created_at AT TIME ZONE 'UTC')::date::text AS date, ${sums}
       FROM crosschain_shielding WHERE ${window} GROUP BY 1 ORDER BY 1`,
      params,
    ).then((r) => r.rows),
    db.query(
      `SELECT source_chain AS chain, ${sums} FROM crosschain_shielding WHERE ${window}
       GROUP BY source_chain ORDER BY count(*) DESC LIMIT 20`,
      params,
    ).then((r) => r.rows),
    // Successful inflows in the source index, to expose classification lag.
    db.query(
      `${source(v2)} SELECT count(*) FILTER (WHERE ${POPULATION})::int AS swaps,
         count(*) FILTER (WHERE ${INTENTS_BALANCE})::int AS intents_balance
       FROM swaps s WHERE s.status='SUCCESS' AND s.direction='inflow' AND ${sourceWindow}`,
      params,
    ).then((r) => r.rows[0]),
    db.query(
      `SELECT min(classified_at) FILTER (WHERE arrival IN ('tx_not_indexed','unmatched') OR held_zat > 0) AS oldest_open,
              max(classified_at) AS last_classified FROM crosschain_shielding`,
    ).then((r) => r.rows[0]),
    db.query(
      `SELECT count(*)::int AS samples,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (first_shield_block_time - arrival_block_time)/60.0) AS median_minutes,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY (first_shield_block_time - arrival_block_time)/60.0) AS p90_minutes
       FROM crosschain_shielding
       WHERE ${window} AND arrival='transparent' AND first_shield_block_time >= arrival_block_time`,
      params,
    ).then((r) => r.rows[0]),
  ]);

  const shape = (r) => {
    const shieldedTotal = (BigInt(r.shielded_on_arrival_zat) + BigInt(r.shielded_after_zat)).toString();
    return {
      swaps: r.swaps,
      coveredSwaps: r.covered_swaps,
      swapCoverage: r.swaps ? Math.round((r.covered_swaps / r.swaps) * 10000) / 10000 : null,
      uncovered: { noZecTx: r.no_zec_tx, txNotIndexed: r.tx_not_indexed, unmatched: r.unmatched },
      coveredZat: zat(r.covered_zat),
      shieldedZat: r.covered_swaps ? shieldedTotal : null,
      shieldedRate: ratio(shieldedTotal, r.covered_zat),
      breakdownZat: {
        shieldedOnArrival: zat(r.shielded_on_arrival_zat),
        shieldedAfter: zat(r.shielded_after_zat),
        held: zat(r.held_zat),
        exchange: zat(r.exchange_zat),
        bridge: zat(r.bridge_zat),
        transferred: zat(r.transferred_zat),
      },
      shieldedArrivals: r.shielded_arrivals,
    };
  };
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return {
    success: true,
    period,
    definition: {
      venue: "near-1click",
      population: "Successful NEAR 1Click swaps into native ZEC delivered to a Zcash address, dated by provider creation time (UTC). Swaps credited to a NEAR Intents balance are excluded and counted in coverage.intentsBalanceSwaps.",
      shielded: "ZEC delivered directly into a shielded pool, or whose delivered transparent output was next spent by a shielding transaction (one hop).",
      denominator: "Covered ZEC only: swaps whose Zcash delivery transaction is reported, canonical and tied to the recipient.",
      units: "zatoshis (decimal strings); rates are fractions 0..1 of covered ZEC.",
      amounts: "Transparent deliveries use exact chain output values. Direct shielded deliveries use the provider-reported amount because shielded values are not public.",
      limits: "Later shielding after more than one hop, or by a different address, is counted as transferred. Held outputs may still be shielded later.",
    },
    summary: shape(totalRow),
    daily: dailyRows.map((r) => ({ date: r.date, ...shape(r) })),
    byChain: chainRows.map((r) => ({ chain: r.chain, ...shape(r) })),
    timeToShield: {
      samples: delayRow.samples,
      medianMinutes: delayRow.median_minutes == null ? null : Number(delayRow.median_minutes),
      p90Minutes: delayRow.p90_minutes == null ? null : Number(delayRow.p90_minutes),
      note: "Delivery block time to the first shielding spend block time, transparent arrivals only.",
    },
    coverage: {
      sourceSwaps: sourceRow.swaps,
      classifiedSwaps: totalRow.swaps,
      pendingClassification: Math.max(0, sourceRow.swaps - totalRow.swaps),
      intentsBalanceSwaps: sourceRow.intents_balance,
      lastClassifiedAt: iso(freshRow.last_classified),
      oldestOpenCheckAt: iso(freshRow.oldest_open),
      recheckDays: RECHECK_DAYS,
    },
  };
}

module.exports = {
  ARRIVALS, COVERED, OUTCOMES, RECHECK_DAYS,
  classifySwaps, findUnclassified, findOpen, findChanged, pruneStale,
  parseShieldingFilters, readShielding,
};
