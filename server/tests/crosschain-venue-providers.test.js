"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { VENUES, amountDecimal, normalizeMidgardAction, createVenueClient } = require("../lib/crosschain/venue-providers");
const maya = require("./fixtures/crosschain-venues/maya-actions.json");
const thorchain = require("./fixtures/crosschain-venues/thorchain-actions.json");
const thorchainRefunds = require("./fixtures/crosschain-venues/thorchain-refunds.json");
const securedAction = require("./fixtures/crosschain-venues/thorchain-secured-asset.json");
const provenance = require("./fixtures/crosschain-venues/provenance.json");
const clone = (value) => structuredClone(value);
const response = (body, init) => new Response(JSON.stringify(body), init);
const errorCode = (code) => (err) => err.code === code;

test("live Maya fixture preserves native input and every affiliate/destination leg", () => {
  const row = normalizeMidgardAction("maya", maya.actions[0]);
  assert.equal(row.id, "maya-swap-ab55c1891ec36c12e52cdd909513a2d11502095ff06ef64be7b959559fd93d08");
  assert.equal(row.sourceAmount, "0.1");
  assert.equal(row.destAmount, "0.05311821"); // Midgard ETH is e8, not wei.
  assert.equal(row.destAsset, "ETH.ETH");
  assert.equal(row.outputs.length, 2);
  assert.equal(row.outputs[0].affiliate, true);
  assert.equal(row.outputs[0].coins[0].asset, "MAYA.CACAO");
  assert.equal(row.outputs[0].coins[0].decimals, 10);
  assert.equal(row.outputs[0].coins[0].amountBaseUnits, "109625759499");
  assert.equal(row.outputs[0].coins[0].amount, "10.9625759499");
  assert.equal(row.recipient, maya.actions[0].out[1].address);
  assert.equal(row.zecAmountZat, "10000000");
  assert.equal(row.zecAmountBasis, "midgard-reported-native-zec-input");
  assert.equal(row.createdAtNs, "1793251769910346380");
  assert.equal(row.createdAt, "2026-10-29T05:29:29.910Z");
  assert.equal(row.sourceAmountUsd, null);
  assert.equal(row.destAmountUsd, null);
  assert.match(row.priceBasis, /first streaming interval/);
});

test("live THORChain streaming fixture sums all actual ZEC payout transactions exactly", () => {
  const row = normalizeMidgardAction("thorchain", thorchain.actions[3]);
  assert.equal(row.direction, "inflow");
  assert.equal(row.zecLegs.length, 2);
  assert.equal(row.zecAmountZat, "2326550245");
  assert.equal(row.zecAmount, "23.26550245");
  assert.equal(row.destAmount, "23.26550245");
  assert.equal(row.destTxHashes.length, 2);
  assert.equal(row.zecAmountBasis, "sum-of-reported-native-zec-payouts");
  assert.notEqual(row.zecAmountZat, thorchain.actions[3].metadata.swap.streamingSwapMeta.outCoin.amount);
  assert.notEqual(row.zecAmountZat, thorchain.actions[3].metadata.swap.streamingSwapMeta.outEstimation);
});

test("partial streaming success retains source refund without double-subtracting executed input", () => {
  const row = normalizeMidgardAction("thorchain", thorchain.actions[2]);
  assert.equal(row.status, "SUCCESS");
  assert.equal(row.sourceAmount, "6971.65991903");
  assert.equal(row.depositedCoin.amountBaseUnits, "700000000000");
  assert.equal(row.outputs.length, 2);
  assert.equal(row.destAsset, "ZEC.ZEC");
  assert.equal(row.destAmount, "5.53759254");
  assert.equal(row.recipient, thorchain.actions[2].out[0].address);
  assert.equal(row.zecAmountZat, "553759254");
  assert.equal(row.raw.metadata.swap.streamingSwapMeta.failedSwaps.length, 1);
  const outflow = clone(maya.actions[0]);
  outflow.in[0].coins[0].amount = "9000000";
  outflow.metadata.swap.streamingSwapMeta.depositedCoin = { asset: "ZEC.ZEC", amount: "10000000" };
  outflow.out.push({ address: outflow.in[0].address, txID: "a".repeat(64), coins: [{ asset: "ZEC.ZEC", amount: "900000" }] });
  const normalized = normalizeMidgardAction("maya", outflow);
  assert.equal(normalized.zecAmountZat, "9000000");
  assert.equal(normalized.destAsset, "ETH.ETH");
  assert.equal(normalized.zecLegs.length, 2);
});

test("native Maya CACAO uses ten decimals, MAYA four, and ZEC remains eight", () => {
  const row = normalizeMidgardAction("maya", maya.actions[2]);
  assert.equal(row.sourceAmount, "2.86918012");
  assert.equal(row.sourceDecimals, 8);
  assert.equal(row.destAsset, "MAYA.CACAO");
  assert.equal(row.destAmountBaseUnits, "314573310978543");
  assert.equal(row.destDecimals, 10);
  assert.equal(row.destAmount, "31457.3310978543");
  assert.equal(row.outputs[0].coins[0].amount, "31457.3310978543");
  assert.equal(provenance.unitAuthority.cacaoDecimals, row.destDecimals);
  const mayaNative = clone(maya.actions[1]);
  mayaNative.in[0].coins[0] = { asset: "MAYA.MAYA", amount: "123456789" };
  const normalized = normalizeMidgardAction("maya", mayaNative);
  assert.equal(normalized.sourceDecimals, 4);
  assert.equal(normalized.sourceAmount, "12345.6789");
  assert.equal(normalized.destDecimals, 8);
  mayaNative.in[0].coins[0].asset = "MAYA.UNKNOWN";
  assert.throws(() => normalizeMidgardAction("maya", mayaNative), /Unknown Maya native asset scale/);
});

test("partial-refund action summarizes returned source coins and retains the associated ZEC payout", () => {
  const row = normalizeMidgardAction("thorchain", thorchainRefunds.actions[0]);
  assert.equal(row.status, "REFUNDED");
  assert.equal(row.refundKind, "partial");
  assert.equal(row.sourceToken, "USDC");
  assert.equal(row.sourceAmount, "28.34008097");
  assert.equal(row.destToken, "USDC");
  assert.equal(row.destAmount, "28.090205");
  assert.equal(row.recipient, thorchainRefunds.actions[0].in[0].address);
  assert.equal(row.zecLegs.length, 1);
  assert.equal(row.zecLegs[0].amountZat, "553759254");
  assert.equal(row.zecAmountZat, null); // This payout also appears on its swap action.
  assert.equal(row.canonicalIdentity, null);
});

test("representative provider native amounts match independently fetched canonical Zcash transactions", () => {
  const input = normalizeMidgardAction("maya", maya.actions[0]).zecLegs[0];
  const mayaTx = provenance.maya.nativeCheck.data;
  assert.equal(mayaTx.status, "confirmed");
  assert.equal(mayaTx.isCanonical, true);
  assert.equal(input.txid, mayaTx.txid);
  assert.equal(input.amountZat, mayaTx.totalOutputZat);
  const output = normalizeMidgardAction("thorchain", thorchain.actions[0]).zecLegs[0];
  const thorTx = provenance.thorchain.nativeCheck.data;
  assert.equal(thorTx.status, "confirmed");
  assert.equal(thorTx.isCanonical, true);
  assert.equal(output.txid, thorTx.txid);
  assert.ok(thorTx.outputs.some((o) => o.address === output.address && o.value === output.amountZat));
});

test("only literal native ZEC.ZEC legs qualify; synth, trade and pool mentions do not", () => {
  for (const asset of ["ZEC/ZEC", "ZEC~ZEC", "ZEC-ZEC", "ETH.ZEC-0XABCDEF"]) {
    const action = clone(maya.actions[0]);
    action.in[0].coins[0].asset = asset;
    assert.equal(normalizeMidgardAction("maya", action), null);
  }
  const affiliate = clone(maya.actions[0]);
  affiliate.in[0].coins[0].asset = "BTC.BTC";
  affiliate.out[0].coins[0].asset = "ZEC.ZEC";
  assert.equal(normalizeMidgardAction("maya", affiliate), null);
});

test("legitimate THORChain secured assets stay on THORChain and repeated internal credits are not added", () => {
  const row = normalizeMidgardAction("thorchain", securedAction);
  assert.equal(row.sourceAsset, "ZEC.ZEC");
  assert.equal(row.sourceAmount, "0.005");
  assert.equal(row.destAsset, "BTC-BTC");
  assert.equal(row.destChain, "thor");
  assert.equal(row.outputs[0].coins[0].settlement, "secured");
  assert.equal(row.destAmount, null);
  assert.equal(row.destSummaryUnavailableReason, "repeated-protocol-asset-credit-needs-reconciliation");
  assert.equal(row.outputs.length, 2);
  assert.equal(row.outputs[0].coins[0].amountBaseUnits, "7701");
  assert.equal(row.zecAmountZat, "500000");
});

test("Midgard unavailable count sentinel remains unknown without discarding a usable page", async () => {
  const client = createVenueClient({ venue: "maya", fetchImpl: async () => response({ ...maya, count: "-1" }) });
  const page = await client.readPage({ limit: 5 });
  assert.equal(page.transfers.length, 5);
  assert.equal(page.coverage.upstreamCount, null);
});

test("pending, failed and refund observations never manufacture successful volume", () => {
  for (const [status, type, expected] of [
    ["pending", "swap", "PROCESSING"], ["failed", "swap", "FAILED"], ["success", "refund", "REFUNDED"],
  ]) {
    const action = { ...clone(maya.actions[0]), status, type };
    const row = normalizeMidgardAction("maya", action);
    assert.equal(row.status, expected);
    assert.equal(row.observedStatus, status);
    assert.equal(row.zecAmountZat, null);
    assert.equal(row.canonicalIdentity, null);
  }
});

test("stable identity survives status/output changes; protocol-qualified IDs cannot collide", () => {
  const initial = clone(maya.actions[0]);
  initial.status = "pending";
  initial.out = [];
  const before = normalizeMidgardAction("maya", initial);
  const after = normalizeMidgardAction("maya", maya.actions[0]);
  assert.equal(before.id, after.id);
  assert.notEqual(after.id, normalizeMidgardAction("thorchain", maya.actions[0]).id);
  assert.notEqual(after.id, normalizeMidgardAction("maya", { ...maya.actions[0], type: "refund" }).id);
  // An identical reported native boundary has one protocol-independent candidate
  // identity. It still needs native vout reconciliation before merging totals.
  assert.equal(after.canonicalIdentity, normalizeMidgardAction("thorchain", maya.actions[0]).canonicalIdentity);
  const missing = clone(thorchain.actions[0]);
  missing.out[0].txID = "";
  assert.equal(normalizeMidgardAction("thorchain", missing).canonicalIdentity, null);
});

test("exact e8 conversion exceeds Number precision without rounding or exponent acceptance", () => {
  assert.equal(amountDecimal("9007199254740993123456789"), "90071992547409931.23456789");
  assert.equal(amountDecimal("1"), "0.00000001");
  assert.equal(amountDecimal("0"), "0");
  assert.throws(() => amountDecimal(100000000));
  assert.throws(() => amountDecimal("1e8"));
  assert.throws(() => amountDecimal("-1"));
  assert.throws(() => amountDecimal("0.1"));
});

test("unknown statuses, malformed dates/assets/amounts/identities fail the whole observation", () => {
  for (const mutate of [
    (a) => { a.status = "new-status"; },
    (a) => { a.date = "99999999999999999999999999999999999999"; },
    (a) => { a.height = 19037945; },
    (a) => { a.in[0].coins[0].amount = "1.2"; },
    (a) => { a.in[0].coins[0].asset = "ZEC"; },
    (a) => { a.in[0].txID = ""; },
    (a) => { a.out[0].txID = "not-a-hash"; },
    (a) => { a.out[0].affiliate = "true"; },
  ]) {
    const action = clone(maya.actions[0]); mutate(action);
    assert.throws(() => normalizeMidgardAction("maya", action), (err) => err.status === 503);
  }
});

test("page client fixes origins/filters, preserves coverage and binds pagination to venue", async () => {
  const urls = [];
  const client = createVenueClient({ venue: "maya", now: () => Date.parse("2026-10-29T08:00:00Z"),
    fetchImpl: async (url, options) => {
      urls.push(new URL(url));
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["x-client-id"], "zecblock");
      return response(maya);
    } });
  const first = await client.readPage({ limit: 5 });
  assert.equal(first.transfers.length, 5);
  assert.equal(first.coverage.historyComplete, false);
  assert.equal(first.coverage.observedAt, "2026-10-29T08:00:00.000Z");
  assert.equal(first.coverage.nativeLegAuthority, "provider-reported");
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  const second = createVenueClient({ venue: "maya", fetchImpl: async (url) => {
    urls.push(new URL(url)); return response({ actions: [], count: "13470" });
  } });
  await second.readPage({ limit: 5, cursor: first.nextCursor });
  assert.equal(urls[0].origin, "https://midgard.mayachain.info");
  assert.equal(urls[0].searchParams.get("asset"), "ZEC.ZEC");
  assert.equal(urls[0].searchParams.get("type"), "swap,refund");
  assert.equal(urls[1].searchParams.get("nextPageToken"), maya.meta.nextPageToken);
  const wrongVenue = createVenueClient({ venue: "thorchain", fetchImpl: () => assert.fail("network not allowed") });
  await assert.rejects(wrongVenue.readPage({ cursor: first.nextCursor }), errorCode("INVALID_CURSOR"));
  for (const cursor of ["123", "https://attacker.invalid", "a".repeat(513), first.nextCursor + "=", { token: "1" }])
    await assert.rejects(client.readPage({ cursor }), errorCode("INVALID_CURSOR"));
});

test("full or malformed pages cannot silently lose their continuation or return partial rows", async () => {
  const withoutCursor = { ...clone(maya), meta: {} };
  const malformed = clone(maya); malformed.actions[3].in[0].coins[0].amount = "NaN";
  const duplicate = clone(maya); duplicate.actions[1] = duplicate.actions[0];
  for (const body of [withoutCursor, malformed, duplicate, { actions: [], count: 0 }, { actions: "oops" }]) {
    const client = createVenueClient({ venue: "maya", fetchImpl: async () => response(body) });
    await assert.rejects(client.readPage({ limit: 5 }), (err) => err.status === 503);
  }
});

test("provider outage can use only fixed documented fallback, but never throttle/redirect/invalid JSON", async () => {
  const urls = [];
  const client = createVenueClient({ venue: "thorchain", fetchImpl: async (url) => {
    urls.push(String(url));
    if (urls.length === 1) throw new Error("temporary DNS failure");
    return response(thorchain);
  } });
  const result = await client.readPage({ limit: 5 });
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith(VENUES.thorchain.endpoints[0]));
  assert.ok(urls[1].startsWith(VENUES.thorchain.endpoints[1]));
  assert.equal(result.coverage.endpoint, VENUES.thorchain.endpoints[1]);
  for (const first of [
    new Response("busy", { status: 429, headers: { "retry-after": "120" } }),
    new Response("not-json"),
    { ok: true, redirected: true, url: "https://attacker.invalid/actions" },
  ]) {
    let calls = 0;
    const limited = createVenueClient({ venue: "thorchain", fetchImpl: async () => { calls++; return first; } });
    await assert.rejects(limited.readPage());
    assert.equal(calls, 1);
  }
});

test("byte and body-inclusive time limits reject unavailable observations", async () => {
  const bytes = createVenueClient({ venue: "maya", maxBytes: 32, fetchImpl: async () => response(maya) });
  await assert.rejects(bytes.readPage({ limit: 5 }), errorCode("VENUE_RESPONSE_TOO_LARGE"));
  const declared = createVenueClient({ venue: "maya", maxBytes: 32,
    fetchImpl: async () => new Response("{}", { headers: { "content-length": "100000000000000000000" } }) });
  await assert.rejects(declared.readPage(), errorCode("VENUE_RESPONSE_TOO_LARGE"));
  const slow = createVenueClient({ venue: "maya", timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"actions":['));
        signal.addEventListener("abort", () => controller.error(new Error("aborted body")), { once: true });
      },
    });
    return new Response(body);
  } });
  await assert.rejects(slow.readPage(), errorCode("VENUE_TIMEOUT"));
});

test("transfer lookup validates input and only returns an action containing the requested hash", async () => {
  const action = maya.actions[0];
  const client = createVenueClient({ venue: "maya", fetchImpl: async (url) => {
    assert.equal(new URL(url).searchParams.get("txid"), action.in[0].txID);
    return response({ actions: [action], count: "1" });
  } });
  const result = await client.readTransfer(action.in[0].txID.toLowerCase());
  assert.equal(result.transfer.id, normalizeMidgardAction("maya", action).id);
  await assert.rejects(client.readTransfer("bad"), (err) => err.status === 400);
});
