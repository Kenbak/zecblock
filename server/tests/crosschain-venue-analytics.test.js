"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const express = require("express");
const { normalizeMidgardAction } = require("../lib/crosschain/venue-providers");
const { upsertAction } = require("../lib/crosschain/venue-store");
const { readAnalytics, readSwaps } = require("../lib/crosschain/analytics");
const { upsert } = require("../lib/crosschain/ingest");
const { createCrosschainVenuesRouter } = require("../api/routes/crosschain-venues");
const fixtures = require("./fixtures/crosschain-venues/maya-actions.json");

const NOW = new Date("2026-10-29T12:00:00.000Z");
const normalizeDecimal = value => {
  assert.equal(typeof value, "string", "SQL monetary values must remain decimal strings");
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
};
const money = (actual, expected) => assert.equal(normalizeDecimal(actual), expected);

// Start with captured provider shapes, then vary known raw amounts, identities
// and dates. Expected sums below are independent constants, not derived by the
// implementation's valuation or analytics helpers.
function action({ id, side = "outflow", status = "success", kind = "swap", at,
  sourceAtoms, destAtoms, price = "2.5", venue = "maya", partial = false }) {
  const raw = structuredClone(fixtures.actions[side === "inflow" ? 1 : 0]);
  raw.type = kind;
  raw.status = status;
  raw.date = (BigInt(Date.parse(at)) * 1000000n).toString();
  raw.in[0].txID = id.toString(16).padStart(64, "0");
  raw.in[0].coins[0].amount = sourceAtoms;
  raw.in = [raw.in[0]];
  raw.out = raw.out.filter(tx => !tx.affiliate);
  raw.out[0].txID = (id + 1000).toString(16).padStart(64, "0");
  raw.out[0].coins[0].amount = destAtoms;
  raw.out = [raw.out[0]];
  raw.metadata.swap.inPriceUSD = price;
  raw.metadata.swap.outPriceUSD = "50";
  if (partial) raw.out.push({
    address: raw.in[0].address, txID: (id + 2000).toString(16).padStart(64, "0"),
    coins: [{ asset: raw.in[0].coins[0].asset, amount: "1000" }],
  });
  return normalizeMidgardAction(venue, raw);
}

async function checkpoint(pool, venue, { complete = true, observed = NOW } = {}) {
  for (const mode of ["backfill", "sync"]) await pool.query(`
    INSERT INTO crosschain_venue_sync(venue,mode,snapshot_at,completed_at,as_of,pages)
    VALUES($1,$2,$3,$4,$3,2) ON CONFLICT(venue,mode) DO UPDATE SET
      snapshot_at=EXCLUDED.snapshot_at,completed_at=EXCLUDED.completed_at,as_of=EXCLUDED.as_of`,
  [venue, mode, observed, complete ? observed : null]);
}

async function serve(t, pool, enabled) {
  const app = express();
  app.locals.venuePool = pool;
  app.use(createCrosschainVenuesRouter({ indexedEnabled: enabled, now: () => NOW.getTime() }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async path => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crosschain/venues${path}`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

test("PostgreSQL: indexed venue analytics, charts and cursors preserve their source scope", {
  skip: process.env.CROSSCHAIN_TEST_POSTGRES !== "1",
}, async t => {
  const name = `crosschain_venue_analytics_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ host: "/tmp", database: "postgres", max: 1 });
  let pool;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    pool = new Pool({ host: "/tmp", database: name, max: 2 });
    await pool.query(fs.readFileSync(require.resolve("../scripts/create-crosschain-venues.sql"), "utf8"));

    await t.test("unobserved indexes and disabled indexed routes are unavailable, not empty measurements", async t => {
      await assert.rejects(readAnalytics(pool, { period: "24h" }, { venue: "maya", now: NOW }), { status: 503 });
      await assert.rejects(readSwaps(pool, { period: "24h" }, { venue: "maya", now: NOW }), { status: 503 });
      const get = await serve(t, pool, false);
      for (const path of ["/analytics?venue=maya", "/swaps?venue=maya"]) {
        const response = await get(path);
        assert.equal(response.status, 503);
        assert.equal(response.body.success, false);
        assert.equal(response.body.summary, undefined);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
    });

    const seeds = [
      action({ id: 1, at: "2026-10-28T12:00:00Z", sourceAtoms: "123456789", destAtoms: "1000000" }),
      action({ id: 2, side: "inflow", at: "2026-10-28T13:00:00Z", sourceAtoms: "10000000", destAtoms: "200000001", price: "1000" }),
      action({ id: 3, side: "inflow", at: "2026-10-28T14:00:00Z", sourceAtoms: "20000000", destAtoms: "300000002", price: null }),
      action({ id: 4, side: "inflow", kind: "refund", partial: true, at: "2026-10-28T15:00:00Z", sourceAtoms: "90000000", destAtoms: "900000000", price: "100000" }),
      action({ id: 5, status: "failed", at: "2026-10-28T16:00:00Z", sourceAtoms: "800000000", destAtoms: "1000000" }),
      action({ id: 6, status: "pending", at: "2026-10-28T17:00:00Z", sourceAtoms: "700000000", destAtoms: "1000000" }),
      action({ id: 7, at: "2026-10-27T12:00:00Z", sourceAtoms: "99900000000", destAtoms: "1000000" }),
      action({ id: 8, venue: "thorchain", side: "inflow", at: "2026-10-28T18:00:00Z", sourceAtoms: "100000000", destAtoms: "50000000000", price: null }),
    ];
    for (const row of seeds) await upsertAction(pool, row, NOW.toISOString());
    await checkpoint(pool, "maya");
    await checkpoint(pool, "thorchain");

    await t.test("exact successful ZEC and historical USD totals exclude refunds, pending, failures and other venues", async () => {
      const result = await readAnalytics(pool, { period: "24h" }, { venue: "maya", now: NOW });
      assert.equal(result.coverage.source, "maya-midgard-index");
      assert.equal(result.coverage.records, 7);
      assert.equal(result.coverage.historyTraversalComplete, true);
      assert.equal(result.coverage.stale, false);
      assert.equal(result.summary.swaps, 3);
      money(result.summary.volume_zec, "6.23456792");
      money(result.summary.inflow_zec, "5.00000003");
      money(result.summary.outflow_zec, "1.23456789");
      money(result.summary.volume_usd, "103.086419725");
      money(result.summary.inflow_usd, "100");
      money(result.summary.outflow_usd, "3.086419725");
      assert.equal(result.summary.missing_usd, 1);
      assert.equal(result.summary.missing_zec, 0);
      assert.deepEqual(Object.fromEntries(result.statuses.map(row => [row.status, row.count])), {
        FAILED: 1, PROCESSING: 1, REFUNDED: 1, SUCCESS: 3,
      });
      assert.match(result.volumeDefinition, /first-stream-interval/);
      assert.match(result.volumeDefinition, /partial refunds are excluded/);
      assert.deepEqual(result.latency, []);
      assert.deepEqual(result.referrals, []);
      const stored = (await pool.query("SELECT zec_amount_zat::text,source_amount_usd::text,payload FROM crosschain_venue_actions WHERE venue='maya' AND id=$1", [seeds[0].id])).rows[0];
      money(stored.zec_amount_zat, "123456789");
      money(stored.source_amount_usd, "3.086419725");
      assert.equal(stored.payload.valuation.sourceBasis, "source-amount-times-midgard-first-interval-price");
      const thor = await readAnalytics(pool, { period: "24h" }, { venue: "thorchain", now: NOW });
      assert.equal(thor.summary.swaps, 1);
      money(thor.summary.volume_zec, "500");
      assert.equal(thor.summary.volume_usd, null);
      assert.equal(thor.summary.missing_usd, 1);
    });

    await t.test("the shared chart contract conserves flows and keeps chart scope within the selected venue and period", async () => {
      const result = await readAnalytics(pool, { period: "24h" }, { venue: "maya", now: NOW });
      assert.equal(result.granularity, "hour");
      assert.equal(result.trends.reduce((sum, row) => sum + (row.swaps || 0), 0), 3);
      money(result.trends.find(row => row.bucket === "2026-10-28T12:00:00.000Z").outflow_zec, "1.23456789");
      const btc = result.flows.find(row => row.chain === "btc");
      assert.equal(btc.swaps, 2);
      money(btc.inflow_zec, "5.00000003");
      money(btc.inflow_usd, "100");
      const eth = result.flows.find(row => row.chain === "eth");
      money(eth.outflow_zec, "1.23456789");
      assert.equal(result.flows.reduce((sum, row) => sum + row.swaps, 0), 3);
      assert.equal(result.tokenFlows.reduce((sum, row) => sum + row.swaps, 0), 3);
      assert.equal(result.distribution.reduce((sum, row) => sum + row.swaps, 0), 2, "USD buckets count only priced successes");
      assert.equal(result.routeRankings.swaps.reduce((sum, row) => sum + row.swaps, 0), 3);
      assert.equal(result.chainOutcomes.filter(row => row.status === "REFUNDED").reduce((sum, row) => sum + row.count, 0), 1);
      assert.equal(result.trends.find(row => row.bucket === "2026-10-28T19:00:00.000Z").swaps, 0, "complete observed empty bucket is zero");
      assert.equal(result.trends.at(-1).swaps, null, "current partial bucket is not an observed zero");
    });

    await t.test("pagination and filters retain provider details and reject cross-venue or changed-filter cursors", async () => {
      const first = await readSwaps(pool, { period: "24h", limit: "2" }, { venue: "maya", now: NOW });
      assert.equal(first.swaps.length, 2);
      assert.ok(first.nextCursor);
      const second = await readSwaps(pool, { period: "24h", limit: "2", cursor: first.nextCursor }, { venue: "maya", now: NOW });
      assert.equal(new Set([...first.swaps, ...second.swaps].map(row => row.id)).size, 4);
      assert.equal(first.swaps.every(row => row.venue === "maya"), true);
      await assert.rejects(readSwaps(pool, { period: "24h", limit: "2", cursor: first.nextCursor }, { venue: "thorchain", now: NOW }), { status: 400 });
      await assert.rejects(readSwaps(pool, { period: "7d", limit: "2", cursor: first.nextCursor }, { venue: "maya", now: NOW }), { status: 400 });
      const refunded = await readSwaps(pool, { period: "24h", status: "REFUNDED" }, { venue: "maya", now: NOW });
      assert.equal(refunded.swaps.length, 1);
      assert.equal(refunded.swaps[0].refundKind, "partial");
      assert.equal(refunded.swaps[0].zecAmount, null);
      assert.ok(refunded.swaps[0].nativeLegs.length);
      assert.equal(refunded.swaps[0].providerRecord.raw, undefined);
      const exactAsset = await readSwaps(pool, { period: "24h", status: "SUCCESS", sourceAsset: "BTC.BTC", minUsd: "99", maxUsd: "101" }, { venue: "maya", now: NOW });
      assert.equal(exactAsset.swaps.length, 1);
      money(exactAsset.swaps[0].zecAmount, "2.00000001");
    });

    await t.test("unknown traversal and stale freshness leave unobserved chart buckets null", async () => {
      await checkpoint(pool, "maya", { complete: false });
      const partial = await readAnalytics(pool, { period: "24h" }, { venue: "maya", now: NOW });
      assert.equal(partial.coverage.historyTraversalComplete, false);
      assert.equal(partial.trends.find(row => row.bucket === "2026-10-28T19:00:00.000Z").swaps, null);
      await checkpoint(pool, "maya", { observed: new Date(NOW.getTime() - 21 * 60000) });
      const stale = await readAnalytics(pool, { period: "24h" }, { venue: "maya", now: NOW });
      assert.equal(stale.coverage.stale, true);
      assert.equal(stale.trends.find(row => row.bucket === "2026-10-28T19:00:00.000Z").swaps, null);
      money(stale.summary.volume_zec, "6.23456792");
      await checkpoint(pool, "maya");
    });

    await t.test("indexed HTTP routes use PostgreSQL and preserve rollout and unavailable boundaries", async t => {
      const get = await serve(t, pool, true);
      const analytics = await get("/analytics?venue=maya&period=24h");
      assert.equal(analytics.status, 200);
      money(analytics.body.summary.volume_zec, "6.23456792");
      assert.equal(analytics.headers.get("cache-control"), "no-store");
      const swaps = await get("/swaps?venue=maya&period=24h&status=REFUNDED");
      assert.equal(swaps.status, 200);
      assert.equal(swaps.body.swaps.length, 1);
      assert.equal((await get("/analytics?venue=near&period=24h")).status, 400);
      assert.equal((await get("/analytics?venue=maya&period=invalid")).status, 400);
    });

    await t.test("existing NEAR default and explicit v2 reads stay independent of populated venue tables", async () => {
      await pool.query(fs.readFileSync(require.resolve("../scripts/create-crosschain-v2.sql"), "utf8"));
      const tokens = new Map([["zec", { blockchain: "zec", symbol: "ZEC" }], ["eth", { blockchain: "eth", symbol: "ETH" }]]);
      await upsert(pool, {
        depositAddress: "near-fixture", depositMemo: "memo-one", status: "SUCCESS", createdAt: "2026-10-28T19:30:00Z",
        originAsset: "eth", destinationAsset: "zec", amountInFormatted: "0.5", amountOutFormatted: "10.00000001",
        amountInUsd: "1000", amountOutUsd: "999", senders: ["source"], recipient: "recipient",
        originChainTxHashes: ["a".repeat(64)], destinationChainTxHashes: ["b".repeat(64)], nearTxHashes: [],
      }, tokens);
      await pool.query(`CREATE TABLE transactions(txid text,block_time bigint);
        CREATE TABLE sync_state(job_name text,last_sync_timestamp timestamptz);
        INSERT INTO sync_state VALUES('crosschain_swaps','2026-10-29T12:00:00Z');
        CREATE TABLE cross_chain_swaps AS SELECT deposit_address,status,swap_created_at,
          source_chain,source_token,dest_chain,dest_token,source_amount,dest_amount,source_amount_usd,dest_amount_usd,
          ARRAY['a'::text] AS source_tx_hashes,ARRAY['b'::text] AS dest_tx_hashes,ARRAY['source'::text] AS senders,
          payload->>'originAsset' AS raw_origin_asset,payload->>'destinationAsset' AS raw_dest_asset,
          ARRAY[]::text[] AS near_tx_hashes,payload->>'recipient' AS recipient FROM crosschain_swaps_v2;`);
      const oldDefault = await readAnalytics(pool, { period: "24h" }, { now: NOW });
      const explicitNear = await readAnalytics(pool, { period: "24h" }, { now: NOW, venue: "near" });
      assert.deepEqual(oldDefault, explicitNear);
      assert.equal(oldDefault.coverage.source, "legacy-success-index");
      assert.equal(oldDefault.summary.swaps, 1);
      money(oldDefault.summary.volume_zec, "10.00000001");
      money(oldDefault.summary.volume_usd, "1000");
      const v2 = await readAnalytics(pool, { period: "24h" }, { now: NOW, v2: true });
      assert.equal(v2.coverage.source, "near-explorer-v2");
      assert.equal(v2.summary.swaps, 1);
      money(v2.summary.volume_zec, "10.00000001");
      const defaultSwaps = await readSwaps(pool, { period: "24h" }, { now: NOW });
      const nearSwaps = await readSwaps(pool, { period: "24h" }, { now: NOW, venue: "near" });
      assert.deepEqual(defaultSwaps, nearSwaps);
      assert.equal(defaultSwaps.swaps[0].venue, undefined);
    });

    await t.test("provider medians interpolate numeric amounts exactly instead of introducing binary-float artifacts", async () => {
      await pool.query("DELETE FROM crosschain_venue_actions WHERE venue='thorchain'");
      for (const [id, amount] of [[20, "10000000"], [21, "20000000"]]) {
        await upsertAction(pool, action({
          id, venue: "thorchain", side: "inflow", at: "2026-10-28T20:00:00Z",
          sourceAtoms: amount, destAtoms: amount, price: "1",
        }), NOW.toISOString());
      }
      const result = await readAnalytics(pool, { period: "24h" }, { venue: "thorchain", now: NOW });
      assert.equal(result.summary.swaps, 2);
      money(result.summary.median_zec, "0.15");
      money(result.summary.median_usd, "0.15");
      assert.equal(result.routes.length, 1);
      money(result.routes[0].median_zec, "0.15");
      money(result.routes[0].median_usd, "0.15");
    });
  } finally {
    if (pool) await pool.end();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
