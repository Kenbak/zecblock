"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { normalizeMidgardAction } = require("../lib/crosschain/venue-providers");
const { multiplyDecimals, valuedRecord, upsertAction, traverseVenue, refreshUnsettled } = require("../lib/crosschain/venue-store");
const { parseOptions, localDatabaseConfig } = require("../jobs/sync-crosschain-venues");
const maya = require("./fixtures/crosschain-venues/maya-actions.json");
const refunds = require("./fixtures/crosschain-venues/thorchain-refunds.json");
const rows = maya.actions.map((a) => normalizeMidgardAction("maya", a));
const page = (transfers, nextCursor, observedAt = "2026-10-29T10:00:00.000Z") => ({
  venue: "maya", transfers, nextCursor,
  coverage: { observedAt, returnedActions: transfers.length, excludedNonNativeActions: 0 },
});

test("historical provider USD is exact, qualified and unavailable for refunds/missing prices", () => {
  assert.equal(multiplyDecimals("1.23456789", "1000.123456"), "1234.72030481342784");
  assert.equal(multiplyDecimals("0.00000001", "1000"), "0.00001");
  assert.equal(multiplyDecimals("90071992547409931.23456789", "2"), "180143985094819862.46913578");
  assert.equal(multiplyDecimals("1e8", "1"), null);
  const r = valuedRecord(rows[2]);
  assert.equal(r.sourceAmountUsd, "3553.818435167869532251864");
  assert.equal(r.destAmountUsd, "3552.035621785595352183494053503");
  assert.equal(r.valuation.sourceBasis, "source-amount-times-midgard-first-interval-price");
  assert.match(r.valuation.note, /not settlement-time/);
  assert.equal(valuedRecord({ ...rows[2], sourcePriceUsd: "0" }).sourceAmountUsd, null);
  assert.equal(valuedRecord({ ...rows[2], sourceAmount: null }).sourceAmountUsd, null);
  assert.equal(valuedRecord(normalizeMidgardAction("thorchain", refunds.actions[0])).sourceAmountUsd, null);
  const secured = { ...rows[2], sourceAsset: "BTC-BTC", inputs: [{ coins: [{ asset: "BTC-BTC", settlement: "secured" }] }] };
  assert.equal(valuedRecord(secured).sourceAmountUsd, null);
  assert.equal(valuedRecord(secured).valuation.sourceUnavailableReason, "secured-share-price-unit-unverified");
});

test("writer requires explicit local configuration and bounded opt-in arguments", async () => {
  assert.equal(parseOptions(["--venue", "maya"]).apply, false);
  assert.equal(parseOptions(["--venue=thorchain", "--max-pages=1000", "--delay-ms=300", "--apply"]).apply, true);
  for (const args of [[], ["--venue=other"], ["--venue=maya", "--delay-ms=299"],
    ["--venue=maya", "--max-pages=1001"], ["--venue=maya", "--page-size=51"],
    ["--venue=maya", "--refresh-pending=1"], ["--venue=maya", "--venue=thorchain"],
    ["--venue=maya", "--unknown=1"]]) assert.throws(() => parseOptions(args));
  assert.equal(localDatabaseConfig("postgresql:///isolated_venue_fixture?host=/tmp").host, "/tmp");
  assert.equal(localDatabaseConfig("postgresql://localhost/isolated_venue_fixture").database, "isolated_venue_fixture");
  for (const url of [null, "not-a-url", "postgresql://db.example/production", "postgresql:///fixture?host=db.example",
    "postgresql:///fixture?host=/tmp&host=remote", "postgresql:///fixture?options=bad", "https://localhost/db"])
    assert.throws(() => localDatabaseConfig(url));
  await assert.rejects(traverseVenue({}, {}, { venue: "maya", delayMs: 0 }), /bounds/);
});

test("PostgreSQL: page transactions resume exactly, roll back failures, exhaust to complete and preserve lifecycle", {
  skip: process.env.VENUE_TEST_POSTGRES !== "1",
}, async () => {
  const { Pool } = require("pg");
  const name = `venue_store_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ host: "/tmp", database: "postgres", max: 1 });
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Pool({ host: "/tmp", database: name, max: 3, statement_timeout: 3000 });
    const schema = fs.readFileSync(require.resolve("../scripts/create-crosschain-venues.sql"), "utf8");
    await db.query(schema); await db.query(schema);
    const first = await traverseVenue(db, { readPage: async (p) => {
      assert.equal(p.cursor, null); return page(rows.slice(0, 2), "cursor-a");
    } }, { venue: "maya", maxPages: 1, pageSize: 2, delayMs: 300 });
    assert.equal(first.complete, false);
    assert.equal((await db.query("SELECT count(*) FROM crosschain_venue_actions")).rows[0].count, "2");
    const before = (await db.query("SELECT * FROM crosschain_venue_sync")).rows;
    const broken = { ...rows[3], status: "not-a-status" };
    await assert.rejects(traverseVenue(db, { readPage: async (p) => {
      assert.equal(p.cursor, "cursor-a"); return page([rows[2], broken], "cursor-b");
    } }, { venue: "maya", maxPages: 1, pageSize: 2, delayMs: 300 }));
    assert.equal((await db.query("SELECT count(*) FROM crosschain_venue_actions")).rows[0].count, "2");
    assert.deepEqual((await db.query("SELECT * FROM crosschain_venue_sync")).rows, before);
    await assert.rejects(traverseVenue(db, { readPage: async () => { throw new Error("provider unavailable"); } },
      { venue: "maya", maxPages: 1, pageSize: 2, delayMs: 300 }), /provider unavailable/);
    assert.deepEqual((await db.query("SELECT * FROM crosschain_venue_sync")).rows, before);
    await assert.rejects(traverseVenue(db, { readPage: async () => page([rows[2]], null) },
      { venue: "maya", maxPages: 1, pageSize: 2, delayMs: 300 }), /continuation/);
    assert.deepEqual((await db.query("SELECT * FROM crosschain_venue_sync")).rows, before);
    const second = await traverseVenue(db, { readPage: async (p) => {
      assert.equal(p.cursor, "cursor-a"); return page([rows[2]], "cursor-b");
    } }, { venue: "maya", maxPages: 1, pageSize: 2, delayMs: 300 });
    assert.equal(second.complete, false); // A short page is not terminal proof.
    const third = await traverseVenue(db, { readPage: async (p) => {
      assert.equal(p.cursor, "cursor-b"); return page([], null);
    } }, { venue: "maya", maxPages: 1, pageSize: 2, delayMs: 300 });
    assert.equal(third.complete, true);
    assert.ok(third.checkpoint.completed_at);
    assert.equal(third.checkpoint.as_of.toISOString(), "2026-10-29T10:00:00.000Z");
    assert.equal(third.checkpoint.pages, "3");
    assert.equal(third.checkpoint.actions, "3");
    await traverseVenue(db, { readPage: () => assert.fail("Completed backfill must not restart") },
      { venue: "maya", maxPages: 1, delayMs: 300 });
    const exact = (await db.query("SELECT * FROM crosschain_venue_actions WHERE id=$1", [rows[2].id])).rows[0];
    assert.equal(exact.dest_amount, "31457.3310978543");
    assert.equal(exact.source_amount_usd, "3553.818435167869532251864");
    assert.equal(exact.created_at_ns, rows[2].createdAtNs);
    assert.equal(exact.payload.valuation.sourceBasis, "source-amount-times-midgard-first-interval-price");
    const original = (await db.query("SELECT first_seen_at FROM crosschain_venue_actions WHERE id=$1", [rows[0].id])).rows[0].first_seen_at;
    const pending = { ...rows[0], status: "PROCESSING", zecAmountZat: null, canonicalIdentity: null };
    await upsertAction(db, pending, "2026-10-29T11:00:00Z");
    await upsertAction(db, rows[0], "2026-10-29T12:00:00Z");
    await upsertAction(db, pending, "2026-10-29T11:00:00Z");
    const lifecycle = (await db.query("SELECT * FROM crosschain_venue_actions WHERE id=$1", [rows[0].id])).rows[0];
    assert.equal(lifecycle.status, "SUCCESS");
    assert.deepEqual(lifecycle.first_seen_at, original);
    assert.equal(lifecycle.status_observed_at.toISOString(), "2026-10-29T12:00:00.000Z");
    const freshRaw = structuredClone(maya.actions[0]);
    freshRaw.in[0].txID = "f".repeat(64); freshRaw.date = (BigInt(freshRaw.date) + 1000000000n).toString();
    const fresh = normalizeMidgardAction("maya", freshRaw);
    const synced = await traverseVenue(db, { readPage: async () => page([fresh, rows[0]], "older", "2026-10-29T13:00:00Z") },
      { venue: "maya", mode: "sync", maxPages: 1, pageSize: 2, delayMs: 300 });
    assert.equal(synced.complete, true);
    assert.equal((await db.query("SELECT count(*) FROM crosschain_venue_actions")).rows[0].count, "4");
    const locker = await db.connect();
    try {
      await locker.query("SELECT pg_advisory_lock(hashtext($1),hashtext($2))", ["zecblock-venue:maya", "sync"]);
      const held = await traverseVenue(db, { readPage: () => assert.fail("Concurrent writer must not fetch") },
        { venue: "maya", mode: "sync", delayMs: 300 });
      assert.equal(held.locked, true);
    } finally {
      await locker.query("SELECT pg_advisory_unlock(hashtext($1),hashtext($2))", ["zecblock-venue:maya", "sync"]);
      locker.release();
    }
    await upsertAction(db, { ...fresh, status: "PROCESSING" }, "2026-10-29T14:00:00Z");
    const refreshed = await refreshUnsettled(db, { readPage: async (p) => {
      assert.equal(p.txid, fresh.sourceTxHashes[0]); return page([fresh], null, "2026-10-29T15:00:00Z");
    } }, { venue: "maya", limit: 1, delayMs: 300 });
    assert.equal(refreshed.checked, 1);
    assert.equal((await db.query("SELECT status FROM crosschain_venue_actions WHERE id=$1", [fresh.id])).rows[0].status, "SUCCESS");
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
