"use strict";

const { createHash } = require("node:crypto");

// Documented public Midgard endpoints only. Callers cannot supply an origin.
// https://docs.mayaprotocol.com/mayachain-dev-docs/concepts/connecting-to-mayachain
// https://dev.thorchain.org/concepts/connecting-to-thorchain.html
const VENUES = Object.freeze({
  maya: Object.freeze({
    name: "Maya Protocol",
    endpoints: Object.freeze(["https://midgard.mayachain.info/v2"]),
  }),
  thorchain: Object.freeze({
    name: "THORChain",
    endpoints: Object.freeze([
      "https://gateway.liquify.com/chain/thorchain_midgard/v2",
      "https://midgard.thorchain.network/v2",
    ]),
  }),
});
const MAX_BYTES = 2 * 1024 * 1024;
const HASH = /^(?:0x)?[a-fA-F0-9]{64}$/;
const UINT = /^(?:0|[1-9]\d{0,39})$/;

function unavailable(message, code = "VENUE_UPSTREAM_INVALID") {
  return Object.assign(new Error(message), { status: 503, code });
}
function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: "VENUE_INPUT_INVALID" });
}
function invalidCursor() {
  return Object.assign(invalid("Invalid venue page cursor"), { code: "INVALID_CURSOR" });
}
function encodeCursor(venue, token) {
  return Buffer.from(JSON.stringify({ v: 1, venue, token })).toString("base64url");
}
function decodeCursor(venue, cursor) {
  if (cursor == null) return null;
  if (typeof cursor !== "string" || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw invalidCursor();
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw invalidCursor();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || value.v !== 1 || value.venue !== venue ||
        Object.keys(value).sort().join(",") !== "token,v,venue" ||
        typeof value.token !== "string" || !UINT.test(value.token)) throw invalidCursor();
    return value.token;
  } catch { throw invalidCursor(); }
}
function venueConfig(venue) {
  if (!Object.hasOwn(VENUES, venue)) throw invalid("Unknown cross-chain venue");
  return VENUES[venue];
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function uint(value, label) {
  if (typeof value !== "string" || !UINT.test(value))
    throw unavailable(`Invalid Midgard ${label}`);
  return value;
}
function txHash(value) {
  if (value === "" || value == null || /^0+$/.test(value)) return null;
  if (typeof value !== "string" || !HASH.test(value))
    throw unavailable("Invalid Midgard transaction hash");
  return value.replace(/^0x/i, "").toLowerCase();
}
function amountDecimal(value, decimals = 8) {
  if (![4, 8, 10].includes(decimals)) throw unavailable("Unsupported Midgard amount scale");
  const n = BigInt(uint(value, "amount"));
  const divisor = 10n ** BigInt(decimals);
  const fraction = (n % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (n / divisor).toString() + (fraction ? `.${fraction}` : "");
}
function price(value) {
  return typeof value === "string" && /^\d{1,30}(?:\.\d{1,30})?$/.test(value)
    ? value
    : null;
}
function assetDetails(asset, venue) {
  if (typeof asset !== "string" || asset.length > 200 ||
      !/^[A-Z0-9]{1,16}[./~-][A-Z0-9][A-Z0-9._-]*$/.test(asset))
    throw unavailable("Invalid Midgard asset");
  const separator = asset.match(/[./~-]/)[0];
  const splitAt = asset.indexOf(separator);
  const assetChain = asset.slice(0, splitAt), symbol = asset.slice(splitAt + 1);
  // Maya's inherited Coin schema still says e8, but its native CACAO uses e10
  // and MAYA uses e4. External assets remain Midgard-normalized e8, including
  // ETH/ERC20s regardless of their chain-native decimals. Current authority:
  // https://docs.mayaprotocol.com/node-docs/mayanodes/pooled-mayanodes
  // https://gitlab.com/mayachain/midgard/-/blob/develop/openapi/openapi.yaml
  const decimals = venue === "maya" && asset === "MAYA.CACAO" ? 10
    : venue === "maya" && asset === "MAYA.MAYA" ? 4 : 8;
  if (venue === "maya" && assetChain === "MAYA" && separator === "." &&
      !["MAYA.CACAO", "MAYA.MAYA"].includes(asset))
    throw unavailable("Unknown Maya native asset scale");
  return {
    asset,
    decimals,
    chain: separator === "." ? assetChain.toLowerCase() : venue === "maya" ? "maya" : "thor",
    token: symbol.split("-")[0],
    settlement: separator === "." ? "native" : separator === "/" ? "synthetic"
      : separator === "-" ? "secured" : "trade",
  };
}
function transaction(raw, venue, side) {
  if (!raw || typeof raw !== "object" || typeof raw.address !== "string" ||
      raw.address.length > 256 || /[\x00-\x1f]/.test(raw.address) ||
      !Array.isArray(raw.coins) || raw.coins.length < 1 || raw.coins.length > 16 ||
      (raw.affiliate != null && typeof raw.affiliate !== "boolean"))
    throw unavailable("Invalid Midgard transaction");
  return {
    side,
    txid: txHash(raw.txID),
    address: raw.address || null,
    affiliate: raw.affiliate === true,
    protocolHeight: raw.height == null ? null : uint(raw.height, "transaction height"),
    coins: raw.coins.map((coin) => {
      const amountBaseUnits = uint(coin?.amount, "coin amount");
      const details = assetDetails(coin?.asset, venue);
      return { ...details, amountBaseUnits, amount: amountDecimal(amountBaseUnits, details.decimals) };
    }),
  };
}
function coinsByAsset(transactions) {
  const result = new Map();
  for (const tx of transactions) for (const coin of tx.coins) {
    const prior = result.get(coin.asset);
    result.set(coin.asset, {
      ...coin,
      amountBaseUnits: (BigInt(prior?.amountBaseUnits || "0") + BigInt(coin.amountBaseUnits)).toString(),
    });
  }
  for (const coin of result.values()) coin.amount = amountDecimal(coin.amountBaseUnits, coin.decimals);
  return result;
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function sole(values) { const entries = unique(values); return entries.length === 1 ? entries[0] : null; }
function principalCoin(transactions) {
  const coins = [...coinsByAsset(transactions).values()];
  if (coins.length !== 1) return null;
  const coin = coins[0];
  if (coin.settlement !== "native") {
    const seen = new Set();
    for (const tx of transactions) for (const raw of tx.coins) if (raw.asset === coin.asset) {
      const identity = JSON.stringify([tx.address, raw.asset, raw.amountBaseUnits]);
      if (seen.has(identity)) return { ...coin, amount: null, amountBaseUnits: null,
        summaryUnavailableReason: "repeated-protocol-asset-credit-needs-reconciliation" };
      seen.add(identity);
    }
  }
  return coin;
}

/**
 * Normalize a protocol action, not an alleged shielded transfer. Midgard coin
 * external-asset amounts are e8 (including ETH/ERC20s); Maya's native CACAO is
 * e10 and MAYA is e4. Dates are nanoseconds.
 * Return null for actions without an actual native ZEC.ZEC leg. A pool mention,
 * ZEC/ZEC synth or ZEC~ZEC trade balance is not a native Zcash transfer.
 */
function normalizeMidgardAction(venue, action) {
  venueConfig(venue);
  if (!action || typeof action !== "object" ||
      !["swap", "refund"].includes(action.type) ||
      !["success", "pending", "failed"].includes(action.status) ||
      !Array.isArray(action.in) || action.in.length < 1 || action.in.length > 32 ||
      !Array.isArray(action.out) || action.out.length > 64)
    throw unavailable("Invalid Midgard swap action");
  const createdAtNs = uint(action.date, "action date");
  const timestampMs = BigInt(createdAtNs) / 1000000n;
  if (timestampMs > 8640000000000000n)
    throw unavailable("Midgard timestamp is outside the supported date range");
  const createdAt = new Date(Number(timestampMs)).toISOString();
  const protocolHeight = uint(action.height, "action height");
  const inputs = action.in.map((tx) => transaction(tx, venue, "in"));
  const outputs = action.out.map((tx) => transaction(tx, venue, "out"));
  const zecLegs = [...inputs, ...outputs].filter((tx) => !tx.affiliate)
    .flatMap((tx) => tx.coins.filter((coin) => coin.asset === "ZEC.ZEC")
      .map((coin) => ({
        side: tx.side, txid: tx.txid, address: tx.address,
        amountZat: coin.amountBaseUnits, amount: coin.amount,
      })));
  if (zecLegs.length === 0) return null;
  const sourceTxHashes = unique(inputs.map((tx) => tx.txid));
  if (!sourceTxHashes.length)
    throw unavailable("Midgard action has no stable inbound transaction identity");
  const anchor = sourceTxHashes.length === 1
    ? sourceTxHashes[0]
    : hash(JSON.stringify([...sourceTxHashes].sort()));
  const id = `${venue}-${action.type}-${anchor}`;
  const sourceCoin = principalCoin(inputs);
  const principalOutputs = outputs.filter((tx) => !tx.affiliate);
  // Partial streaming swaps may return unused source coins in an extra output.
  // Keep those outputs in the record, but do not select one as the destination.
  const destinationOutputs = sourceCoin
    ? principalOutputs.map((tx) => ({ ...tx, coins: tx.coins.filter((c) =>
      action.type === "refund" ? c.asset === sourceCoin.asset : c.asset !== sourceCoin.asset) }))
      .filter((tx) => tx.coins.length)
    : principalOutputs;
  const destCoin = principalCoin(destinationOutputs);
  const refundKind = action.type === "refund" && sourceCoin
    ? principalOutputs.some((tx) => tx.coins.some((coin) => coin.asset !== sourceCoin.asset)) ? "partial" : "full"
    : null;
  const zecInputs = zecLegs.filter((leg) => leg.side === "in");
  const zecOutputs = zecLegs.filter((leg) => leg.side === "out");
  const direction = zecInputs.length && sourceCoin?.asset === "ZEC.ZEC" &&
      ((destCoin && destCoin.asset !== "ZEC.ZEC") || !zecOutputs.length) ? "outflow"
    : !zecInputs.length && zecOutputs.length ? "inflow" : "internal";
  const status = action.status === "pending" ? "PROCESSING"
    : action.status === "failed" ? "FAILED"
    : action.type === "refund" ? "REFUNDED" : "SUCCESS";
  const amountLegs = direction === "inflow" ? zecOutputs : direction === "outflow" ? zecInputs : [];
  const zecAmountZat = status === "SUCCESS" && amountLegs.length
    ? amountLegs.reduce((sum, leg) => sum + BigInt(leg.amountZat), 0n).toString()
    : null;
  const swap = action.metadata?.swap;
  const streaming = swap?.isStreamingSwap === true;
  // This is a candidate identity from provider-reported native legs, not an
  // independent vout reconciliation. Missing hashes cannot certify deduplication.
  const identityComplete = status === "SUCCESS" && zecLegs.every((leg) => leg.txid && leg.address);
  const canonicalIdentity = identityComplete ? `zec-${hash(JSON.stringify(zecLegs.map(
    ({ side, txid, address, amountZat }) => [side, txid, address, amountZat],
  ).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)))}` : null;
  return {
    id, venue, source: "midgard", status, observedStatus: action.status,
    actionType: action.type, refundKind, createdAt, createdAtNs, protocolHeight, direction,
    sourceChain: sourceCoin?.chain || null, sourceToken: sourceCoin?.token || null,
    sourceAsset: sourceCoin?.asset || null, sourceAmount: sourceCoin?.amount || null,
    sourceAmountBaseUnits: sourceCoin?.amountBaseUnits || null, sourceDecimals: sourceCoin?.decimals ?? null,
    sourceSummaryUnavailableReason: sourceCoin?.summaryUnavailableReason || null,
    destChain: destCoin?.chain || null, destToken: destCoin?.token || null,
    destAsset: destCoin?.asset || null, destAmount: destCoin?.amount || null,
    destAmountBaseUnits: destCoin?.amountBaseUnits || null, destDecimals: destCoin?.decimals ?? null,
    destSummaryUnavailableReason: destCoin?.summaryUnavailableReason || null,
    sourceAmountUsd: null, destAmountUsd: null,
    sourcePriceUsd: price(swap?.inPriceUSD), destPriceUsd: price(swap?.outPriceUSD),
    priceBasis: "Provider-reported asset price at the first streaming interval; not a settlement-time valuation.",
    sourceAddress: sole(inputs.map((tx) => tx.address)),
    recipient: sole(destinationOutputs.map((tx) => tx.address)),
    sourceTxHashes, destTxHashes: unique(destinationOutputs.map((tx) => tx.txid)),
    inputs, outputs, zecLegs, zecAmountZat,
    zecAmount: zecAmountZat == null ? null : amountDecimal(zecAmountZat),
    zecAmountBasis: direction === "inflow" ? "sum-of-reported-native-zec-payouts"
      : direction === "outflow" ? "midgard-reported-native-zec-input" : null,
    streaming,
    depositedCoin: streaming && swap.streamingSwapMeta?.depositedCoin?.asset
      ? { ...assetDetails(swap.streamingSwapMeta.depositedCoin.asset, venue),
        amountBaseUnits: uint(swap.streamingSwapMeta.depositedCoin.amount, "deposited amount") }
      : null,
    canonicalIdentity, canonicalIdentityAuthority: "provider-reported-native-legs",
    raw: action,
  };
}

async function boundedJson(response, maxBytes) {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(maxBytes))
    throw unavailable("Midgard response exceeds the byte limit", "VENUE_RESPONSE_TOO_LARGE");
  if (!response.body) throw unavailable("Empty Midgard response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw unavailable("Midgard response exceeds the byte limit", "VENUE_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (err) {
    if (err.code === "VENUE_RESPONSE_TOO_LARGE") throw err;
    throw unavailable("Invalid or incomplete Midgard JSON response");
  } finally {
    reader.releaseLock();
  }
}

function createVenueClient({ venue, fetchImpl = fetch, timeoutMs = 8000, maxBytes = MAX_BYTES,
  now = Date.now } = {}) {
  const config = venueConfig(venue);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES)
    throw invalid("Invalid venue request bounds");
  async function request(query) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    for (const endpoint of config.endpoints) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw unavailable("Midgard request timed out", "VENUE_TIMEOUT");
      const url = new URL(`${endpoint}/actions`);
      for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, value);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const response = await fetchImpl(url, {
          redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", "x-client-id": "zecblock" },
        });
        if (response.redirected || (response.url && new URL(response.url).origin !== url.origin))
          throw unavailable("Midgard redirect refused", "VENUE_REDIRECT_REFUSED");
        if (!response.ok) {
          const err = unavailable("Midgard venue is unavailable", "VENUE_HTTP_ERROR");
          err.upstreamStatus = response.status;
          if (response.status === 429) {
            const retry = response.headers.get("retry-after");
            if (retry && retry.length <= 128) err.retryAfter = retry;
          }
          throw err;
        }
        return { body: await boundedJson(response, maxBytes), endpoint, observedAt: new Date(now()).toISOString() };
      } catch (err) {
        if (controller.signal.aborted)
          lastError = unavailable("Midgard request timed out", "VENUE_TIMEOUT");
        else lastError = err.status === 503 ? err : unavailable("Midgard venue is unreachable", "VENUE_UNREACHABLE");
        // Never evade throttling, schema/size controls or a redirect by switching
        // providers. Fallback is only for transport failures and server outages.
        if (!(lastError.code === "VENUE_UNREACHABLE" ||
          (lastError.code === "VENUE_HTTP_ERROR" && lastError.upstreamStatus >= 500))) throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || unavailable("Midgard venue is unavailable");
  }
  async function page({ cursor = null, limit = 25, txid = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw invalid("Venue page limit must be 1..50");
    const token = decodeCursor(venue, cursor);
    if (txid != null && (typeof txid !== "string" || !HASH.test(txid)))
      throw invalid("Invalid venue transaction hash");
    const { body, endpoint, observedAt } = await request({
      asset: "ZEC.ZEC", type: "swap,refund", limit: String(limit),
      nextPageToken: token, txid: txid?.replace(/^0x/i, "").toUpperCase(),
    });
    if (!body || !Array.isArray(body.actions) || body.actions.length > limit ||
        (body.count != null && body.count !== "-1" && (typeof body.count !== "string" || !UINT.test(body.count))))
      throw unavailable("Invalid Midgard actions page");
    const nextToken = body.meta?.nextPageToken || null;
    if (nextToken != null && (typeof nextToken !== "string" || !UINT.test(nextToken) || nextToken === token))
      throw unavailable("Invalid or non-advancing Midgard cursor");
    if (body.actions.length === limit && !nextToken)
      throw unavailable("Midgard full page omitted its continuation cursor");
    const transfers = [];
    let excludedNonNativeActions = 0;
    const ids = new Set();
    for (const action of body.actions) {
      const normalized = normalizeMidgardAction(venue, action);
      if (!normalized) { excludedNonNativeActions++; continue; }
      if (ids.has(normalized.id)) throw unavailable("Duplicate Midgard action identity in one page");
      ids.add(normalized.id);
      transfers.push(normalized);
    }
    return {
      venue, source: "midgard", transfers,
      nextCursor: nextToken == null ? null : encodeCursor(venue, nextToken),
      coverage: {
        scope: "recent-native-zec-actions", historyComplete: false,
        endpoint, observedAt, upstreamCount: body.count === "-1" ? null : body.count || null,
        returnedActions: body.actions.length, excludedNonNativeActions,
        nativeLegAuthority: "provider-reported",
        aggregation: "Separate venue observations; do not add to NEAR totals without cross-provider leg reconciliation.",
      },
    };
  }
  return {
    readPage: page,
    async readTransfer(txid) {
      const result = await page({ txid, limit: 50 });
      const wanted = txid.replace(/^0x/i, "").toLowerCase();
      const matches = result.transfers.filter((transfer) =>
        [...transfer.inputs, ...transfer.outputs].some((tx) => tx.txid === wanted));
      if (matches.length > 1) throw unavailable("Midgard transaction identifies multiple actions");
      return { venue, transfer: matches[0] || null, coverage: result.coverage };
    },
  };
}

module.exports = { VENUES, amountDecimal, normalizeMidgardAction, createVenueClient };
