"use strict";
const { STATUSES, INGEST_STATUSES, INGEST_SCOPE } = require("./ingest");
const { venueSource, readVenueCoverage } = require("./venue-analytics");
const PERIODS = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
  all: null,
};
function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function parseFilters(q) {
  for (const value of Object.values(q))
    if (value != null && typeof value !== "string")
      throw invalid("Parameters must be single strings");
  const period = q.period || "30d";
  if (!Object.hasOwn(PERIODS, period)) throw invalid("Invalid period");
  const granularity =
    q.granularity || (["24h", "7d"].includes(period) ? "hour" : "day");
  if (
    !["hour", "day"].includes(granularity) ||
    (granularity === "hour" && !["24h", "7d"].includes(period))
  )
    throw invalid("Hourly buckets require 24h or 7d");
  if (q.direction && !["inflow", "outflow", "internal"].includes(q.direction))
    throw invalid("Invalid direction");
  if (q.status && !STATUSES.includes(q.status)) throw invalid("Invalid status");
  if (q.chain && !/^[a-z0-9_-]{1,32}$/.test(q.chain))
    throw invalid("Invalid chain");
  if (q.token != null && (typeof q.token !== "string" || q.token.length > 64 || /[\x00-\x1f]/.test(q.token)))
    throw invalid("Invalid token");
  if (q.search != null && (typeof q.search !== "string" || q.search.length > 200 || /[\x00-\x1f]/.test(q.search)))
    throw invalid("Search must be at most 200 characters");
  for (const name of ["sourceAsset", "destAsset", "referral"])
    if (q[name] && (q[name].length > 256 || /[\x00-\x1f]/.test(q[name])))
      throw invalid(`Invalid ${name}`);
  for (const name of ["minUsd", "maxUsd"])
    if (
      q[name] &&
      (!/^\d+(\.\d{1,8})?$/.test(q[name]) || Number(q[name]) > 1e12)
    )
      throw invalid(`Invalid ${name}`);
  if (q.minUsd && q.maxUsd && Number(q.minUsd) > Number(q.maxUsd))
    throw invalid("Minimum exceeds maximum");
  for (const name of ["from", "to"])
    if (
      q[name] &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(q[name]) ||
        !Number.isFinite(Date.parse(q[name])) ||
        new Date(q[name]).toISOString() !==
          q[name].replace(/(?<!\.\d{3})Z$/, ".000Z"))
    )
      throw invalid(`Invalid ${name}; use UTC ISO timestamp`);
  if (q.from && q.to && Date.parse(q.from) >= Date.parse(q.to))
    throw invalid("Invalid date interval");
  const limit = q.limit == null ? 25 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw invalid("Limit must be 1..100");
  return { ...q, period, granularity, limit };
}

// Legacy reads remain available before any schema migration; v2 is an explicit
// reader switch, never an automatic switch just because backfill inserted a row.
function source(v2, venue = 'near') {
  if (venue !== 'near') return venueSource(venue);
  const raw = v2
    ? `SELECT deposit_address,deposit_memo,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,
    source_amount,dest_amount,source_amount_usd,dest_amount_usd,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(payload->'originChainTxHashes','null'::jsonb),'[]'))) AS source_tx_hashes,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(payload->'destinationChainTxHashes','null'::jsonb),'[]'))) AS dest_tx_hashes,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(payload->'senders','null'::jsonb),'[]'))) AS senders,
    payload,first_seen_at,last_seen_at,status_observed_at
    FROM crosschain_swaps_v2 WHERE status <> 'PENDING_DEPOSIT'`
    : `SELECT deposit_address,''::text AS deposit_memo,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,
    NULLIF(source_amount,0) AS source_amount,NULLIF(dest_amount,0) AS dest_amount,
    NULLIF(source_amount_usd,0) AS source_amount_usd,NULLIF(dest_amount_usd,0) AS dest_amount_usd,source_tx_hashes,dest_tx_hashes,senders,
    jsonb_build_object('originAsset',raw_origin_asset,'destinationAsset',raw_dest_asset,'nearTxHashes',near_tx_hashes,'recipient',recipient) AS payload,
    NULL::timestamptz AS first_seen_at,NULL::timestamptz AS last_seen_at,NULL::timestamptz AS status_observed_at FROM cross_chain_swaps`;
  return `WITH raw AS (${raw}), swaps AS (SELECT *,
    CASE WHEN source_chain='zec' AND dest_chain='zec' THEN 'internal' WHEN dest_chain='zec' THEN 'inflow' ELSE 'outflow' END AS direction,
    CASE WHEN dest_chain='zec' THEN dest_amount ELSE source_amount END AS zec_amount,
    CASE WHEN dest_chain='zec' THEN dest_tx_hashes[1] ELSE source_tx_hashes[1] END AS zec_txid
    FROM raw)`;
}
const count = (value) => Number(value || 0);
const iso = (value) => (value ? new Date(value).toISOString() : null);
function medianExpression(column, venue) {
  if (venue === 'near') return `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${column})::text`;
  // PostgreSQL percentile_cont converts numeric to float8. Provider monetary
  // medians instead average the exact numeric middle value(s), including ties.
  const values = `(array_agg(${column} ORDER BY ${column}) FILTER (WHERE ${column} IS NOT NULL))`;
  const count = `count(${column})`;
  return `CASE WHEN ${count}=0 THEN NULL ELSE trim_scale((${values}[((${count}+1)/2)::int]+${values}[((${count}+2)/2)::int])/2)::text END`;
}
async function coverage(db, v2, now) {
  const r = (
    await db.query(`${source(v2)} SELECT count(*)::int AS records,min(swap_created_at) AS earliest,max(swap_created_at) AS latest,
    count(*) FILTER (WHERE zec_txid IS NULL)::int AS missing_zec_hash,
    count(*) FILTER (WHERE direction='internal')::int AS internal FROM swaps`)
  ).rows[0];
  const states = v2
    ? (
        await db.query(
          "SELECT * FROM crosschain_sync_v2 WHERE scope=$1 ORDER BY mode,direction",
          [INGEST_SCOPE],
        )
      ).rows
    : [];
  const lastSync = v2
    ? states.filter((s) => s.mode === "sync").map((s) => s.completed_through)
    : (
        await db.query(
          "SELECT last_sync_timestamp AS completed_through FROM sync_state WHERE job_name='crosschain_swaps'",
        )
      ).rows.map((s) => s.completed_through);
  const syncedThrough =
    lastSync.length === (v2 ? 2 : 1) && lastSync.every(Boolean)
      ? new Date(Math.min(...lastSync.map((d) => new Date(d).getTime())))
      : null;
  const backfill = states.filter((s) => s.mode === "backfill");
  const reconciled = states.filter((s) => s.mode === "reconcile");
  const ranges = v2
    ? (
        await db.query(`WITH windows AS (
      SELECT direction,range_agg(tstzrange(window_start,window_end,'[)')) AS spans FROM crosschain_coverage_v2 WHERE scope=$1 GROUP BY direction)
      SELECT direction,upper(span) AS through FROM windows CROSS JOIN LATERAL unnest(spans) span WHERE lower_inf(span)`, [INGEST_SCOPE])
      ).rows
    : [];
  const continuousThrough =
    ranges.length === 2
      ? new Date(Math.min(...ranges.map((r) => new Date(r.through).getTime())))
      : null;
  return {
    source: v2 ? "near-explorer-v2" : "legacy-success-index",
    records: r.records,
    earliest: iso(r.earliest),
    latest: iso(r.latest),
    missingZecHash: r.missing_zec_hash,
    internalSwaps: r.internal,
    syncedThrough: iso(syncedThrough),
    continuousThrough: iso(continuousThrough),
    stale:
      !syncedThrough || now.getTime() - syncedThrough.getTime() > 20 * 60000,
    statusesAvailable: v2 ? INGEST_STATUSES : ["SUCCESS"],
    excludedStatuses: v2 ? ["PENDING_DEPOSIT"] : [],
    ingestionScope: v2 ? INGEST_SCOPE : "legacy-success-index",
    historyTraversalComplete:
      backfill.length === 2 && backfill.every((s) => s.completed_at),
    statusReconciliationComplete:
      v2 && reconciled.length === 2 && reconciled.every((s) => s.completed_at && !s.window_end),
    reconciliation: reconciled.map((s) => ({
      direction: s.direction,
      complete: !!s.completed_at && !s.window_end,
      pages: count(s.pages),
      completedThrough: iso(s.completed_through),
      lastAdvancedAt: iso(s.updated_at),
    })),
    backfill: backfill.map((s) => ({
      direction: s.direction,
      complete: !!s.completed_at,
      pages: count(s.pages),
      completedThrough: iso(s.completed_through),
    })),
    note: "Observed NEAR 1Click swaps only. Pending-deposit quotes are excluded; outcomes are not quote-conversion rates. History traversal is not proof of upstream completeness. Sender addresses are not people. Internal ZEC routes are excluded from cross-chain volume.",
  };
}
async function snapshot(pool, fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout='8s'");
    await db.query("SET LOCAL timezone='UTC'");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

async function readAnalytics(pool, q, { v2 = false, now = new Date(), venue = 'near' } = {}) {
  const filters = parseFilters(q);
  return snapshot(pool, async (db) => {
    const cov = venue === 'near' ? await coverage(db, v2, now) : await readVenueCoverage(db, venue, now);
    const end = now.toISOString();
    const start =
      PERIODS[filters.period] == null
        ? cov.earliest || end
        : new Date(
            now.getTime() - PERIODS[filters.period] * 86400000,
          ).toISOString();
    const params = [start, end];
    const window = `swap_created_at >= $1::timestamptz AND swap_created_at < $2::timestamptz AND ${venue === 'near' ? "direction <> 'internal'" : "(direction <> 'internal' OR status <> 'SUCCESS')"}`;
    // Keep projection pruning through the shared query template: status/count
    // queries must not materialize every payload and hash array just because
    // the template also declares the successful subset.
    const base = `${source(v2, venue)}, selected AS NOT MATERIALIZED (SELECT * FROM swaps WHERE ${window}), successful AS NOT MATERIALIZED (SELECT * FROM selected WHERE status='SUCCESS')`;
    const summary = (
      await db.query(
        `${base} SELECT count(*)::int AS swaps,
      CASE WHEN count(*)>0 AND count(source_amount_usd)=0 THEN NULL ELSE COALESCE(sum(source_amount_usd),0)::text END AS volume_usd,CASE WHEN count(*)>0 AND count(zec_amount)=0 THEN NULL ELSE COALESCE(sum(zec_amount),0)::text END AS volume_zec,
      CASE WHEN count(*) FILTER (WHERE direction='inflow')>0 AND count(zec_amount) FILTER (WHERE direction='inflow')=0 THEN NULL ELSE COALESCE(sum(zec_amount) FILTER (WHERE direction='inflow'),0)::text END AS inflow_zec,
      CASE WHEN count(*) FILTER (WHERE direction='outflow')>0 AND count(zec_amount) FILTER (WHERE direction='outflow')=0 THEN NULL ELSE COALESCE(sum(zec_amount) FILTER (WHERE direction='outflow'),0)::text END AS outflow_zec,
      CASE WHEN count(*) FILTER (WHERE direction='inflow')>0 AND count(source_amount_usd) FILTER (WHERE direction='inflow')=0 THEN NULL ELSE COALESCE(sum(source_amount_usd) FILTER (WHERE direction='inflow'),0)::text END AS inflow_usd,
      CASE WHEN count(*) FILTER (WHERE direction='outflow')>0 AND count(source_amount_usd) FILTER (WHERE direction='outflow')=0 THEN NULL ELSE COALESCE(sum(source_amount_usd) FILTER (WHERE direction='outflow'),0)::text END AS outflow_usd,
      avg(source_amount_usd)::text AS average_usd,avg(zec_amount)::text AS average_zec,
      ${medianExpression('source_amount_usd', venue)} AS median_usd,
      ${medianExpression('zec_amount', venue)} AS median_zec,
      count(*) FILTER (WHERE source_amount_usd IS NULL)::int AS missing_usd,
      count(*) FILTER (WHERE zec_amount IS NULL)::int AS missing_zec
      FROM successful`,
        params,
      )
    ).rows[0];
    const statuses = (
      await db.query(
        `${base} SELECT status,count(*)::int AS count FROM selected GROUP BY status ORDER BY status`,
        params,
      )
    ).rows;
    const addresses = (
      await db.query(
        `${base} SELECT count(DISTINCT (source_chain,sender))::int AS count
      FROM successful CROSS JOIN LATERAL unnest(senders) sender WHERE sender IS NOT NULL AND sender<>''`,
        params,
      )
    ).rows[0].count;
    let trends = (
      await db.query(
        `${base} SELECT date_trunc('${filters.granularity}',swap_created_at) AS bucket,
      count(*)::int AS swaps,
      CASE WHEN count(*) FILTER (WHERE direction='inflow')>0 AND count(source_amount_usd) FILTER (WHERE direction='inflow')=0 THEN NULL ELSE COALESCE(sum(source_amount_usd) FILTER (WHERE direction='inflow'),0)::text END AS inflow_usd,
      CASE WHEN count(*) FILTER (WHERE direction='outflow')>0 AND count(source_amount_usd) FILTER (WHERE direction='outflow')=0 THEN NULL ELSE COALESCE(sum(source_amount_usd) FILTER (WHERE direction='outflow'),0)::text END AS outflow_usd,
      CASE WHEN count(*) FILTER (WHERE direction='inflow')>0 AND count(zec_amount) FILTER (WHERE direction='inflow')=0 THEN NULL ELSE COALESCE(sum(zec_amount) FILTER (WHERE direction='inflow'),0)::text END AS inflow_zec,
      CASE WHEN count(*) FILTER (WHERE direction='outflow')>0 AND count(zec_amount) FILTER (WHERE direction='outflow')=0 THEN NULL ELSE COALESCE(sum(zec_amount) FILTER (WHERE direction='outflow'),0)::text END AS outflow_zec
      FROM successful GROUP BY bucket ORDER BY bucket`,
        params,
      )
    ).rows.map((r) => ({ ...r, bucket: iso(r.bucket) }));
    // Unknown history stays a gap. Only an exhausted historical traversal plus
    // a completed live sync can turn an absent bucket into an observed zero.
    const byBucket = new Map(trends.map((r) => [r.bucket, r]));
    const step = filters.granularity === "hour" ? 3600000 : 86400000;
    const first = Math.floor(Date.parse(start) / step) * step;
    const last = Math.floor(now.getTime() / step) * step;
    const verified =
      cov.historyTraversalComplete && !cov.stale && cov.continuousThrough;
    trends = [];
    for (let time = first; time <= last; time += step) {
      const bucket = new Date(time).toISOString();
      const complete =
        verified &&
        (venue === 'near' || (cov.earliest && time >= Date.parse(cov.earliest))) &&
        time >= Date.parse(start) &&
        time + step <=
          Math.min(
            Date.parse(cov.syncedThrough),
            Date.parse(cov.continuousThrough),
          );
      trends.push(
        byBucket.get(bucket) || {
          bucket,
          swaps: complete ? 0 : null,
          inflow_usd: complete ? "0" : null,
          outflow_usd: complete ? "0" : null,
          inflow_zec: complete ? "0" : null,
          outflow_zec: complete ? "0" : null,
        },
      );
    }
    const distribution = (
      await db.query(
        `${base}, buckets AS (SELECT *,
      CASE WHEN source_amount_usd<10 THEN 0 WHEN source_amount_usd<50 THEN 1 WHEN source_amount_usd<100 THEN 2
      WHEN source_amount_usd<500 THEN 3 WHEN source_amount_usd<1000 THEN 4 WHEN source_amount_usd<5000 THEN 5
      WHEN source_amount_usd<10000 THEN 6 WHEN source_amount_usd<50000 THEN 7 ELSE 8 END AS bucket
      FROM successful WHERE source_amount_usd IS NOT NULL)
      SELECT bucket,count(*)::int AS swaps,sum(source_amount_usd)::text AS volume_usd,sum(zec_amount)::text AS volume_zec
      FROM buckets GROUP BY bucket ORDER BY bucket`,
        params,
      )
    ).rows;
    // Aggregate every successful route before the separate top-100 route limit.
    const flowColumns = ["inflow", "outflow"]
      .flatMap((direction) =>
        [
          ["usd", "source_amount_usd"],
          ["zec", "zec_amount"],
        ].map(
          ([unit, column]) =>
            `CASE WHEN count(*) FILTER (WHERE direction='${direction}')>0 AND count(${column}) FILTER (WHERE direction='${direction}')=0 THEN NULL ELSE COALESCE(sum(${column}) FILTER (WHERE direction='${direction}'),0)::text END AS ${direction}_${unit}`,
        ),
      )
      .join(",");
    const flows = (
      await db.query(
        `${base} SELECT
      CASE WHEN direction='inflow' THEN source_chain ELSE dest_chain END AS chain,
      count(*)::int AS swaps,
      count(*) FILTER (WHERE direction='inflow')::int AS buy_swaps,
      count(*) FILTER (WHERE direction='outflow')::int AS sell_swaps,${flowColumns}
      FROM successful GROUP BY 1 ORDER BY count(*) DESC,1`,
        params,
      )
    ).rows;
    const tokenFlows = (
      await db.query(
        `${base} SELECT
      CASE WHEN direction='inflow' THEN source_chain ELSE dest_chain END AS chain,
      CASE WHEN direction='inflow' THEN source_token ELSE dest_token END AS token,
      NULL::text AS asset,
      count(*)::int AS swaps,
      count(*) FILTER (WHERE direction='inflow')::int AS buy_swaps,
      count(*) FILTER (WHERE direction='outflow')::int AS sell_swaps,${flowColumns}
      FROM successful GROUP BY 1,2 ORDER BY count(*) DESC,1,2`,
        params,
      )
    ).rows;
    const chainHistory = (
      await db.query(
        `${base} SELECT
      date_trunc('week',swap_created_at) AS bucket,
      CASE WHEN direction='inflow' THEN source_chain ELSE dest_chain END AS chain,
      count(*)::int AS swaps,
      count(*) FILTER (WHERE zec_amount IS NULL)::int AS missing_zec,
      CASE WHEN count(zec_amount)<count(*) THEN NULL
        ELSE sum(CASE WHEN direction='inflow' THEN zec_amount ELSE -zec_amount END)::text END AS net_zec
      FROM successful GROUP BY 1,2 ORDER BY 1,2`,
        params,
      )
    ).rows.map((r) => ({ ...r, bucket: iso(r.bucket) }));
    const chainOutcomes = (
      await db.query(
        `${base} SELECT
      CASE WHEN direction='inflow' THEN source_chain ELSE dest_chain END AS chain,
      status,count(*)::int AS count FROM selected GROUP BY 1,2 ORDER BY 1,2`,
        params,
      )
    ).rows;
    const rankedRoutes = (
      await db.query(
        `${base}, route_totals AS (SELECT source_chain,source_token,dest_chain,dest_token,direction,
      payload->>'originAsset' AS source_asset,payload->>'destinationAsset' AS dest_asset,
      count(*)::int AS swaps,sum(source_amount_usd) AS volume_usd,sum(zec_amount) AS volume_zec,
      ${medianExpression('source_amount_usd', venue)} AS median_usd,
      ${medianExpression('zec_amount', venue)} AS median_zec
      FROM successful GROUP BY source_chain,source_token,dest_chain,dest_token,direction,payload->>'originAsset',payload->>'destinationAsset'
      ), ranked AS (SELECT *,
      row_number() OVER (ORDER BY swaps DESC,source_chain,source_token,dest_chain,dest_token,source_asset,dest_asset) AS rank_swaps,
      row_number() OVER (ORDER BY volume_usd DESC NULLS LAST,swaps DESC,source_chain,source_token,dest_chain,dest_token,source_asset,dest_asset) AS rank_usd,
      row_number() OVER (ORDER BY volume_zec DESC NULLS LAST,swaps DESC,source_chain,source_token,dest_chain,dest_token,source_asset,dest_asset) AS rank_zec
      FROM route_totals)
      SELECT *,volume_usd::text AS volume_usd,volume_zec::text AS volume_zec FROM ranked
      WHERE rank_swaps<=100 OR rank_usd<=100 OR rank_zec<=100`,
        params,
      )
    ).rows;
    // Rank before limiting: a rare, high-value pair must survive the count cap.
    const routeRankings = Object.fromEntries(["swaps", "usd", "zec"].map((metric) => [
      metric,
      rankedRoutes.filter((r) => Number(r[`rank_${metric}`]) <= 100)
        .sort((a, b) => Number(a[`rank_${metric}`]) - Number(b[`rank_${metric}`]))
        .map((r) => {
          const route = { ...r };
          delete route.rank_swaps;
          delete route.rank_usd;
          delete route.rank_zec;
          return route;
        }),
    ]));
    const routes = routeRankings.swaps;
    const latency = venue === 'near' ? (
      await db.query(
        `${base}, observations AS (
      SELECT s.direction,CASE WHEN s.direction='inflow' THEN s.source_chain ELSE s.dest_chain END AS chain,
        (t.block_time-extract(epoch FROM s.swap_created_at))/60.0 AS minutes
      FROM successful s JOIN transactions t ON t.txid=s.zec_txid
      WHERE t.block_time>extract(epoch FROM s.swap_created_at) AND t.block_time-extract(epoch FROM s.swap_created_at)<86400)
      SELECT direction,chain,count(*)::int AS samples,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) AS median_minutes,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes) AS p90_minutes
      FROM observations GROUP BY direction,chain ORDER BY samples DESC LIMIT 50`,
        params,
      )
    ).rows : [];
    const referrals = v2 && venue === 'near'
      ? (
          await db.query(
            `${base} SELECT payload->>'referral' AS referral,
      count(*)::int AS observed,count(*) FILTER (WHERE status='SUCCESS')::int AS successful,
      count(*) FILTER (WHERE status='REFUNDED')::int AS refunded,count(*) FILTER (WHERE status='FAILED')::int AS failed,
      sum(source_amount_usd) FILTER (WHERE status='SUCCESS')::text AS volume_usd
      FROM selected GROUP BY payload->>'referral' ORDER BY count(*) DESC LIMIT 20`,
            params,
          )
        ).rows
      : [];
    return {
      success: true,
      period: filters.period,
      granularity: filters.granularity,
      start,
      end,
      coverage: cov,
      summary: { ...summary, sender_addresses: addresses },
      statuses,
      trends,
      distribution,
      routes,
      routeRankings,
      flows,
      tokenFlows,
      chainHistory,
      chainOutcomes,
      latency,
      referrals,
      latencyDefinition:
        venue === 'near'
          ? "Swap creation to Zcash block timestamp; outbound measures the deposit leg, not destination delivery. Matched samples only, restricted to 0–24h. No end-to-end settlement claim."
          : "Native-block confirmation and end-to-end delivery latency are unavailable for this venue index. Midgard protocol heights and action times do not establish delivery timestamps.",
      volumeDefinition:
        venue === 'near'
          ? "USD uses source-side reported USD; ZEC uses destination amount for inflows and source amount for outflows. Successful external routes only. Missing valuations are excluded and counted."
          : "USD is exact source amount times the provider’s first-stream-interval asset price; it is not settlement-time value. ZEC uses the sum of native payouts for inflows and reported consumed input for outflows. Successful external actions only; partial refunds are excluded from successful volume. Missing valuations are excluded and counted.",
    };
  });
}

function encodeCursor(row, fingerprint, start, end) {
  return Buffer.from(
    JSON.stringify({
      time: iso(row.swap_created_at),
      address: row.deposit_address,
      memo: row.deposit_memo,
      fingerprint,
      start,
      end,
    }),
  ).toString("base64url");
}
async function readSwaps(pool, q, { v2 = false, now = new Date(), venue = 'near' } = {}) {
  const f = parseFilters(q);
  const fingerprint = JSON.stringify([
    ...(venue === 'near' ? [] : [venue]),
    v2,
    f.period,
    f.direction || "",
    f.status || "",
    f.chain || "",
    f.token || "",
    f.search || "",
    f.minUsd || "",
    f.maxUsd || "",
    f.from || "",
    f.to || "",
    f.sourceAsset || "",
    f.destAsset || "",
    f.referral || "",
  ]);
  let cursor;
  if (f.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(f.cursor, "base64url").toString());
    } catch {
      throw invalid("Invalid cursor");
    }
    if (
      f.cursor.length > 8192 ||
      !cursor ||
      typeof cursor !== "object" ||
      cursor.fingerprint !== fingerprint ||
      !Number.isFinite(Date.parse(cursor.time)) ||
      typeof cursor.address !== "string" ||
      typeof cursor.memo !== "string" ||
      !Number.isFinite(Date.parse(cursor.end)) ||
      (cursor.start != null && !Number.isFinite(Date.parse(cursor.start)))
    )
      throw invalid("Cursor does not match filters");
  }
  return snapshot(pool, async (db) => {
    const venueCoverage = venue === 'near' ? null : await readVenueCoverage(db, venue, now);
    const params = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions = [];
    const end = cursor?.end || f.to || now.toISOString();
    const start =
      cursor?.start ||
      f.from ||
      (PERIODS[f.period]
        ? new Date(Date.parse(end) - PERIODS[f.period] * 86400000).toISOString()
        : null);
    if (start)
      conditions.push(`swap_created_at >= ${bind(start)}::timestamptz`);
    conditions.push(`swap_created_at < ${bind(end)}::timestamptz`);
    if (f.direction) conditions.push(`direction=${bind(f.direction)}`);
    if (f.status) conditions.push(`status=${bind(f.status)}`);
    if (f.chain) {
      const p = bind(f.chain);
      conditions.push(`(source_chain=${p} OR dest_chain=${p})`);
    }
    if (f.token) {
      const p = bind(f.token);
      conditions.push(`(source_token=${p} OR dest_token=${p})`);
    }
    for (const [param, field] of [
      ["sourceAsset", "originAsset"],
      ["destAsset", "destinationAsset"],
      ["referral", "referral"],
    ])
      if (f[param]) conditions.push(`payload->>'${field}'=${bind(f[param])}`);
    if (f.minUsd)
      conditions.push(`source_amount_usd>=${bind(f.minUsd)}::numeric`);
    if (f.maxUsd)
      conditions.push(`source_amount_usd<=${bind(f.maxUsd)}::numeric`);
    if (f.search) {
      const p = bind(f.search);
      conditions.push(
        `(deposit_address=${p} OR payload->>'recipient'=${p} OR ${p}=ANY(source_tx_hashes) OR ${p}=ANY(dest_tx_hashes) OR ${p}=ANY(senders) OR payload->>'intentHashes'=${p} OR payload->'nearTxHashes' @> jsonb_build_array(${p}::text))`,
      );
    }
    if (cursor)
      conditions.push(
        `(swap_created_at,deposit_address,deposit_memo)<(${bind(cursor.time)}::timestamptz,${bind(cursor.address)},${bind(cursor.memo)})`,
      );
    const limit = bind(f.limit + 1);
    const rows = (
      await db.query(
        `${source(v2, venue)} SELECT * FROM swaps WHERE ${conditions.join(" AND ")}
      ORDER BY swap_created_at DESC,deposit_address DESC,deposit_memo DESC LIMIT ${limit}`,
        params,
      )
    ).rows;
    const page = rows.slice(0, f.limit);
    return {
      success: true,
      source: venue === 'near' ? v2 ? "near-explorer-v2" : "legacy-success-index" : `${venue}-midgard-index`,
      ...(venueCoverage ? { coverage: venueCoverage } : {}),
      swaps: page.map((r) => ({
        id: Buffer.from(
          JSON.stringify([r.deposit_address, r.deposit_memo]),
        ).toString("base64url"),
        depositAddress: venue === 'near' ? r.deposit_address : r.payload.sourceAddress || '',
        depositMemo: v2 ? r.deposit_memo : null,
        status: r.status,
        direction: r.direction,
        createdAt: iso(r.swap_created_at),
        sourceChain: r.source_chain,
        sourceToken: r.source_token,
        destChain: r.dest_chain,
        destToken: r.dest_token,
        sourceAmount: r.source_amount,
        destAmount: r.dest_amount,
        amountUsd: r.source_amount_usd,
        zecAmount: r.zec_amount,
        sourceTxHashes: r.source_tx_hashes || [],
        destTxHashes: r.dest_tx_hashes || [],
        nearTxHashes: r.payload.nearTxHashes || [],
        sourceAsset: r.payload.originAsset || null,
        destAsset: r.payload.destinationAsset || null,
        amountInRaw: ["SUCCESS", "REFUNDED"].includes(r.status)
          ? r.payload.amountIn || null
          : null,
        amountOutRaw: ["SUCCESS", "REFUNDED"].includes(r.status)
          ? r.payload.amountOut || null
          : null,
        intentHashes: r.payload.intentHashes || null,
        senders: r.senders || [],
        recipient: r.payload.recipient || null,
        refundTo: r.payload.refundTo || null,
        refundType: r.payload.refundType || null,
        referral: r.payload.referral || null,
        appFees: r.payload.appFees || null,
        refundReason: r.payload.refundReason || null,
        refundFee: r.payload.refundFeeFormatted ?? null,
        depositType: r.payload.depositType || null,
        recipientType: r.payload.recipientType || null,
        firstSeenAt: iso(r.first_seen_at),
        lastSeenAt: iso(r.last_seen_at),
        statusObservedAt: iso(r.status_observed_at),
        ...(venue === 'near' ? {} : {
          venue, actionType: r.payload.actionType, refundKind: r.payload.refundKind,
          nativeLegs: r.payload.zecLegs,
          providerRecord: Object.fromEntries(Object.entries(r.payload).filter(([key]) => key !== 'raw')),
        }),
      })),
      nextCursor:
        rows.length > f.limit
          ? encodeCursor(page.at(-1), fingerprint, start, end)
          : null,
    };
  });
}
module.exports = { PERIODS, parseFilters, source, readAnalytics, readSwaps };
