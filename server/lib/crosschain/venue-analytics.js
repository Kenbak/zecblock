'use strict';

const VENUES = new Set(['maya', 'thorchain']);
function venueSource(venue) {
  if (!VENUES.has(venue)) throw Object.assign(new Error('Invalid indexed venue'), { status: 400 });
  // Identifiers are application-authored and selected from the closed enum.
  // Existing analytics consume this projection; venue-native facts stay in
  // payload instead of being inserted into NEAR's deposit-address identity.
  return `WITH raw AS (SELECT id AS deposit_address,''::text AS deposit_memo,
    status,swap_created_at,source_chain,source_token,dest_chain,dest_token,
    source_amount,dest_amount,source_amount_usd,dest_amount_usd,
    source_tx_hashes,dest_tx_hashes,
    CASE WHEN payload->>'sourceAddress' IS NULL THEN ARRAY[]::text[] ELSE ARRAY[payload->>'sourceAddress'] END AS senders,
    payload || jsonb_build_object('originAsset',source_asset,'destinationAsset',dest_asset,
      'amountIn',payload->>'sourceAmountBaseUnits','amountOut',payload->>'destAmountBaseUnits',
      'refundType',payload->>'refundKind') AS payload,
    first_seen_at,last_seen_at,status_observed_at,zec_amount_zat
    FROM crosschain_venue_actions WHERE venue='${venue}'),
    swaps AS (SELECT *,payload->>'direction' AS direction,
      zec_amount_zat/100000000::numeric AS zec_amount,
      CASE WHEN payload->>'direction'='inflow' THEN dest_tx_hashes[1] ELSE source_tx_hashes[1] END AS zec_txid FROM raw)`;
}

async function readVenueCoverage(db, venue, now) {
  if (!VENUES.has(venue)) throw Object.assign(new Error('Invalid indexed venue'), { status: 400 });
  const records = (await db.query(`SELECT count(*)::int AS records,min(swap_created_at) AS earliest,
    max(swap_created_at) AS latest,count(*) FILTER(WHERE canonical_identity IS NULL)::int AS missing_identity,
    count(*) FILTER(WHERE jsonb_array_length(COALESCE(payload->'zecLegs','[]'::jsonb))=0 OR EXISTS
      (SELECT 1 FROM jsonb_array_elements(COALESCE(payload->'zecLegs','[]'::jsonb)) leg WHERE leg->>'txid' IS NULL))::int AS missing_hash,
    count(*) FILTER(WHERE payload->>'direction'='internal')::int AS internal
    FROM crosschain_venue_actions WHERE venue=$1`, [venue])).rows[0];
  const states = (await db.query('SELECT * FROM crosschain_venue_sync WHERE venue=$1 ORDER BY mode', [venue])).rows;
  const backfill = states.find(s => s.mode === 'backfill');
  const sync = states.find(s => s.mode === 'sync');
  if (!states.some(s => s.as_of)) throw Object.assign(new Error('Venue index has not observed its source'), { status: 503 });
  const iso = value => value ? new Date(value).toISOString() : null;
  const observed = sync?.as_of || backfill?.as_of;
  const through = sync?.completed_at ? sync.as_of : backfill?.snapshot_at;
  const complete = !!backfill?.completed_at;
  return {
    source: `${venue}-midgard-index`, venue,
    records: records.records, earliest: iso(records.earliest), latest: iso(records.latest),
    missingZecHash: records.missing_hash, unresolvedOverlapIdentity: records.missing_identity, internalSwaps: records.internal,
    syncedThrough: iso(through), continuousThrough: complete ? iso(through) : null,
    stale: !observed || now.getTime() - new Date(observed).getTime() > 20 * 60000,
    statusesAvailable: ['SUCCESS', 'REFUNDED', 'FAILED', 'PROCESSING'], excludedStatuses: [],
    ingestionScope: 'native-zec-swap-refund-v1', historyTraversalComplete: complete,
    statusReconciliationComplete: false,
    backfill: [{ direction: venue, complete, pages: Number(backfill?.pages || 0), completedThrough: iso(backfill?.snapshot_at) }],
    reconciliation: [],
    providerObservedAt: iso(observed),
    valuationBasis: 'Exact source amount times provider-reported asset USD price at its first streaming interval; not settlement-time USD.',
    note: 'Native ZEC swap/refund actions retained by this venue’s Midgard source. Traversal completion means the available provider history was exhausted, not proof of all protocol activity. Partial refunds retain all legs and are excluded from successful volume. Separate venue totals may overlap aggregator records; no combined unique total is claimed.',
  };
}

module.exports = { venueSource, readVenueCoverage };
