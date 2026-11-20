'use strict';

// Independent observations of public Zcash wallet servers (lightwalletd-
// compatible gRPC). Hosts come only from the reviewed registry, never from a
// request. Everything a server returns is untrusted and bounded before use.
const registry = require('../data/wallet-servers.json');

const REFRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;
const PROBE_DEADLINE_MS = 5_000;
const LAG_THRESHOLD_BLOCKS = 3;
const EXPECTED_CHAIN = { mainnet: 'main' };

function operatorsFor(network) {
  return Array.isArray(registry[network]) ? registry[network] : [];
}

function cleanText(value, max = 64) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);
  return text || null;
}

function toHeight(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]{1,10}$/.test(text)) return null;
  return Number(text);
}

// Wallet gRPC carries the block hash in serialized byte order. Explorers and
// the `blocks` table use the byte-reversed display order.
function displayHash(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) return null;
  return Buffer.from(bytes).reverse().toString('hex');
}

function probeError(error) {
  if (error?.code === 4) return 'timeout';
  if (error?.code === 14) return 'connection_failed';
  return 'invalid_response';
}

async function probeEndpoint(endpoint, { grpc, CompactTxStreamer, deadlineMs = PROBE_DEADLINE_MS, clock = () => performance.now() } = {}) {
  const client = new CompactTxStreamer(`${endpoint.host}:${endpoint.port}`, grpc.credentials.createSsl());
  // One absolute deadline covers both calls, so a slow server cannot hold a
  // check open for twice the budget.
  const deadline = new Date(Date.now() + deadlineMs);
  const call = (method) => new Promise((resolve, reject) => {
    client[method]({}, { deadline }, (error, response) => (error ? reject(error) : resolve(response)));
  });
  try {
    const info = await call('GetLightdInfo');
    // Timed on the connection the first call established: one request round
    // trip from this server, without the TLS handshake.
    const started = clock();
    const block = await call('GetLatestBlock');
    const responseMs = Math.max(0, Math.round(clock() - started));
    const height = toHeight(block?.height);
    const hash = displayHash(block?.hash);
    if (height === null || hash === null) return { reachable: false, error: 'invalid_response' };
    return {
      reachable: true,
      height,
      hash,
      responseMs,
      chainName: cleanText(info?.chainName, 16),
      vendor: cleanText(info?.vendor),
      version: cleanText(info?.version, 32),
      nodeSubversion: cleanText(info?.zcashdSubversion),
    };
  } catch (error) {
    return { reachable: false, error: probeError(error) };
  } finally {
    client.close();
  }
}

async function readChain(pool, heights) {
  const [tip, blocks] = await Promise.all([
    pool.query('SELECT MAX(height) AS height FROM blocks'),
    heights.length
      ? pool.query('SELECT height, hash FROM blocks WHERE height = ANY($1::bigint[])', [heights])
      : { rows: [] },
  ]);
  return {
    tip: toHeight(String(tip.rows[0]?.height ?? '')),
    canonical: new Map(blocks.rows.map((row) => [Number(row.height), String(row.hash).toLowerCase()])),
  };
}

function createWalletServerMonitor({ network, probe, readChain: chain, now = Date.now, refreshMs = REFRESH_MS, staleMs = STALE_MS, operators = operatorsFor(network) }) {
  const endpoints = operators.flatMap((operator) => operator.endpoints);
  let snapshot = null;
  let inflight = null;

  async function refresh() {
    const results = await Promise.all(endpoints.map((endpoint) => Promise.resolve()
      .then(() => probe(endpoint))
      .catch(() => ({ reachable: false, error: 'invalid_response' }))));
    const checkedAtMs = now();
    const heights = [...new Set(results.filter((r) => r.reachable).map((r) => r.height))];
    // The index is read after the probes, so it is at least as recent as
    // every answer it is compared with.
    let tip = null;
    let canonical = new Map();
    try { ({ tip, canonical } = await chain(heights)); } catch { /* chain agreement stays unknown */ }
    const checkedAt = new Date(checkedAtMs).toISOString();
    const observations = {};
    endpoints.forEach((endpoint, index) => {
      const result = results[index];
      if (!result.reachable) {
        observations[endpoint.id] = { checkedAt, reachable: false, error: result.error };
        return;
      }
      const expected = canonical.get(result.height);
      observations[endpoint.id] = {
        checkedAt,
        ...result,
        chain: expected === undefined ? 'unknown' : expected === result.hash ? 'canonical' : 'different',
        tipDelta: tip === null ? null : result.height - tip,
      };
    });
    snapshot = { checkedAtMs, checkedAt, referenceHeight: tip, observations };
  }

  async function read() {
    if (!endpoints.length) return null;
    const fresh = snapshot && now() - snapshot.checkedAtMs < refreshMs;
    if (!fresh && !inflight) {
      inflight = refresh().catch(() => {}).finally(() => { inflight = null; });
    }
    // Readers wait only when there is nothing current to show: on the first
    // read, or after an idle period longer than an observation's life. In
    // between they get the last observation while a refresh runs; its age is
    // public, so it cannot pass as newer than it is.
    if (!snapshot || now() - snapshot.checkedAtMs >= staleMs) await inflight;
    return snapshot;
  }

  return { read };
}

function publicSnapshot(snapshot, network) {
  const operators = operatorsFor(network);
  return {
    network,
    available: Boolean(snapshot),
    checkedAt: snapshot?.checkedAt ?? null,
    refreshSeconds: REFRESH_MS / 1000,
    staleAfterSeconds: STALE_MS / 1000,
    lagThresholdBlocks: LAG_THRESHOLD_BLOCKS,
    expectedChainName: EXPECTED_CHAIN[network] ?? null,
    reference: { source: 'zecblock-index', height: snapshot?.referenceHeight ?? null },
    operators: operators.map((operator) => ({
      id: operator.id,
      name: operator.name,
      operator: operator.operator,
      operatorUrl: operator.operatorUrl,
      statusUrl: operator.statusUrl,
      // A local brand asset path, or null when the operator publishes no mark.
      logo: typeof operator.logo === 'string' && /^\/brands\/wallet-servers\/[a-z0-9-]+\.(?:svg|png)$/.test(operator.logo) ? operator.logo : null,
      endpoints: operator.endpoints.map((endpoint) => ({
        id: endpoint.id,
        host: endpoint.host,
        port: endpoint.port,
        scope: endpoint.scope,
        label: endpoint.label,
        // A single-region name carries the city-level position its operator
        // publishes. An area name whose operator publishes no positions carries
        // a point near the middle of the area, marked approximate.
        location: Number.isFinite(endpoint.lat) && Number.isFinite(endpoint.lon)
          ? { lat: endpoint.lat, lon: endpoint.lon, approximate: endpoint.approximate === true } : null,
        latest: snapshot?.observations[endpoint.id] ?? null,
      })),
    })),
  };
}

module.exports = {
  REFRESH_MS, STALE_MS, PROBE_DEADLINE_MS, LAG_THRESHOLD_BLOCKS,
  cleanText, toHeight, displayHash, operatorsFor,
  probeEndpoint, readChain, createWalletServerMonitor, publicSnapshot,
};
