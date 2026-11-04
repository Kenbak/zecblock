'use strict';

const { isIP } = require('node:net');
const { parsePeerAddress } = require('./peer-client');
const VERIFIED_WINDOW_MS = 60 * 60 * 1000;
const SNAPSHOT_MAX_AGE_MS = 3 * 60 * 1000;
const CENSUS_VERSION = 3;
const PEER_WINDOW_SECONDS = 900;
// Conventional display-order hex of mainnet block 3,520,000, independently
// verified through the serving node RPC at 2026-10-19T00:48:10.141Z (2,682
// confirmations). A pre-fork genesis/block-1 challenge would also admit Ycash.
const CHAIN_PROOF = 'zcash-mainnet-checkpoint-v1';
const CHAIN_BLOCK_HASH = '00000000001cfe8c0d46d5f8a7f107546d56168fb5ab1cd66c8033390de10418';

// A recent poll of an old snapshot is not a new network observation.
function validateCrawlSnapshot(metrics, now = Date.now()) {
  const generated = metrics?.generated_at_ms;
  if (!Number.isSafeInteger(generated) || generated > now + 30_000 || now - generated > SNAPSHOT_MAX_AGE_MS) {
    throw new Error('Crawler snapshot is missing a valid recent generation timestamp');
  }
  if (!Array.isArray(metrics.node_info)) throw new Error('Crawler snapshot is missing node_info');
  return metrics;
}

function verifiedNodes(metrics, now = Date.now()) {
  validateCrawlSnapshot(metrics, now);
  return metrics.node_info.filter(node => node && typeof node === 'object'
    && Number.isSafeInteger(node.last_verified_at_ms)
    && Number.isSafeInteger(node.chain_verified_at_ms)
    && node.chain_proof === CHAIN_PROOF && node.chain_block_hash === CHAIN_BLOCK_HASH
    && node.last_verified_at_ms <= metrics.generated_at_ms
    && node.chain_verified_at_ms <= metrics.generated_at_ms
    && node.chain_verified_at_ms <= now
    && node.chain_verified_at_ms >= node.last_verified_at_ms
    && node.last_verified_at_ms > now - VERIFIED_WINDOW_MS
    && node.chain_verified_at_ms > now - VERIFIED_WINDOW_MS
    && typeof node.addr === 'string' && node.addr.length > 0);
}

// The database identity is an IP, not an IP:port. Prefer its latest verification.
function mergeVerifiedNodes(snapshots, now = Date.now()) {
  const byHost = new Map();
  for (const snapshot of snapshots) {
    for (const node of verifiedNodes(snapshot, now)) {
      const { host } = parsePeerAddress(node.addr);
      const previous = byHost.get(host);
      if (host && (!previous || node.chain_verified_at_ms > previous.chain_verified_at_ms)) byHost.set(host, node);
    }
  }
  return [...byHost.values()];
}

// A successful local getpeerinfo response observes existing, protocol-established
// connections. This is not a new crawler handshake and must retain its own clock.
function livePeerNodes(peers, observedAt = Date.now()) {
  if (!Array.isArray(peers)) throw new Error('Invalid live peer response');
  const byHost = new Map();
  for (const peer of peers) {
    if (!peer || typeof peer !== 'object') continue;
    const { host, port } = parsePeerAddress(peer.addr);
    if (!isIP(host || '') || host === '0.0.0.0' || host === '::'
      || !Number.isInteger(peer.version) || peer.version <= 0) continue;
    const addr = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
    const services = typeof peer.services === 'number' ? peer.services :
      /^[0-9a-f]{1,16}$/i.test(peer.services || '') ? Number(BigInt(`0x${peer.services}`)) : null;
    // Multiple simultaneous connections from one IP are one census identity.
    if (!byHost.has(host)) byHost.set(host, { addr, user_agent: peer.subver || null,
      protocol_version: peer.version, start_height: peer.startingheight ?? null,
      services: Number.isSafeInteger(services) && services >= 0 ? services : null,
      last_peer_seen_at_ms: observedAt, inbound: peer.inbound === true,
      handshake_time_ms: null });
  }
  return [...byHost.values()];
}

const CRAWL_PROOF_MATCH = `chain_proof = '${CHAIN_PROOF}' AND chain_block_hash = '${CHAIN_BLOCK_HASH}'
  AND last_chain_verified_at IS NOT NULL AND last_verified_at IS NOT NULL
  AND last_chain_verified_at >= last_verified_at AND last_chain_verified_at <= NOW()`;
const CRAWL_ELIGIBILITY = `${CRAWL_PROOF_MATCH}
  AND last_verified_at > NOW() - INTERVAL '1 hour'
  AND last_chain_verified_at > NOW() - INTERVAL '1 hour'`;
const PEER_ELIGIBILITY = `last_peer_seen_at > NOW() - INTERVAL '${PEER_WINDOW_SECONDS} seconds' AND last_peer_seen_at <= NOW()`;
const COMBINED_ELIGIBILITY = `(${CRAWL_ELIGIBILITY}) OR (${PEER_ELIGIBILITY})`;
const CENSUS_OBSERVED_AT = `GREATEST(CASE WHEN ${CRAWL_ELIGIBILITY} THEN last_chain_verified_at END,
  CASE WHEN ${PEER_ELIGIBILITY} THEN last_peer_seen_at END)`;

// Compute eligibility at read time as well, so a stopped ingester cannot leave
// an active flag valid forever. Historical/discovered rows remain in totalSeen.
function censusTable(source) {
  const eligibility = source === 'crawl'
    ? `(${COMBINED_ELIGIBILITY})`
    : 'is_active';
  const qualified = source === 'crawl' ? CRAWL_ELIGIBILITY : 'TRUE';
  return `(SELECT nodes.*, COALESCE((${eligibility}), FALSE) AS census_active,
    COALESCE((${qualified}), FALSE) AS census_crawl_qualified FROM nodes)`;
}

module.exports = { CENSUS_VERSION, VERIFIED_WINDOW_MS, SNAPSHOT_MAX_AGE_MS, CHAIN_PROOF, CHAIN_BLOCK_HASH,
  validateCrawlSnapshot, verifiedNodes, mergeVerifiedNodes, livePeerNodes, censusTable, PEER_WINDOW_SECONDS,
  CRAWL_PROOF_MATCH, CRAWL_ELIGIBILITY, PEER_ELIGIBILITY, COMBINED_ELIGIBILITY, CENSUS_OBSERVED_AT };
