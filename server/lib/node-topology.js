'use strict';

const { BlockList, isIP } = require('node:net');
const { parsePeerAddress } = require('./peer-client');
const { verifiedNodes } = require('./node-census');

const GOSSIP_PROVENANCE = 'zcash-mainnet-qualified-addr-v1';
const MAX_GOSSIP_AGE_MS = 10 * 60 * 1000;
const MAX_GOSSIP_EDGES = 40000;

const blockedIPv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedIPv4.addSubnet(network, prefix, 'ipv4');

const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const blockedIPv6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) blockedIPv6.addSubnet(network, prefix, 'ipv6');

/** A public gossip endpoint must be a literal global-unicast IP plus a port. */
function publicEndpoint(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = value.match(/^(?:([0-9.]+):(\d{1,5})|\[([0-9a-fA-F:.]+)\]:(\d{1,5}))$/);
  if (!match) return null;
  const rawPort = match[2] || match[4];
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const { host, port: parsedPort } = parsePeerAddress(value);
  const family = isIP(host || '');
  if (!family || parsedPort !== port || (match[3] ? family !== 6 : family !== 4)) return null;
  if (family === 4 && blockedIPv4.check(host, 'ipv4')) return null;
  if (family === 6 && (!globalIPv6.check(host, 'ipv6') || blockedIPv6.check(host, 'ipv6'))) return null;
  const ip = family === 6 ? new URL(`http://[${host}]/`).hostname.slice(1, -1) : host;
  return { ip, address: family === 6 ? `[${ip}]:${port}` : `${ip}:${port}` };
}

/**
 * Admit each collector snapshot independently. Node membership is deliberately
 * not IP-merged here: another port or collector cannot certify this advertiser.
 * Invalid receipts are omitted; unsupported/oversized snapshots are unavailable.
 */
function validateTopologySnapshots(inputs, now = Date.now()) {
  const snapshots = [];
  const merged = new Map();
  if (!Array.isArray(inputs) || !Number.isSafeInteger(now) || now <= 0) {
    return { available: false, snapshots, edges: [] };
  }

  for (const input of inputs) {
    const source = input?.source;
    const metrics = input?.metrics;
    if (!['direct', 'tor'].includes(source) || metrics?.gossip_provenance !== GOSSIP_PROVENANCE
      || typeof metrics.gossip_truncated !== 'boolean'
      || !Array.isArray(metrics.gossip_edges) || metrics.gossip_edges.length > MAX_GOSSIP_EDGES
      || !Array.isArray(metrics.node_info) || metrics.node_info.length > MAX_GOSSIP_EDGES
      || !Number.isSafeInteger(metrics.generated_at_ms) || metrics.generated_at_ms > now) continue;

    let qualified;
    try { qualified = verifiedNodes(metrics, now); } catch { continue; }
    const byEndpoint = new Map();
    for (const node of qualified) {
      if (!publicEndpoint(node.addr)) continue;
      const previous = byEndpoint.get(node.addr);
      if (!previous || node.chain_verified_at_ms > previous.chain_verified_at_ms) byEndpoint.set(node.addr, node);
    }

    const accepted = new Map();
    for (const receipt of metrics.gossip_edges) {
      if (!receipt || typeof receipt !== 'object') continue;
      const observed = receipt.observed_at_ms;
      if (!Number.isSafeInteger(observed) || observed <= 0 || observed > metrics.generated_at_ms
        || observed > now || now - observed > MAX_GOSSIP_AGE_MS) continue;
      const proof = byEndpoint.get(receipt.source);
      if (!proof || proof.chain_verified_at_ms > observed) continue;
      const advertiser = publicEndpoint(receipt.source);
      const advertised = publicEndpoint(receipt.target);
      if (!advertiser || !advertised) continue;
      const edge = {
        collectorSource: source,
        advertiser: advertiser.address,
        advertised: advertised.address,
        advertiserIp: advertiser.ip,
        advertisedIp: advertised.ip,
        observedAtMs: observed,
        lastVerifiedAtMs: proof.last_verified_at_ms,
        chainVerifiedAtMs: proof.chain_verified_at_ms,
        generatedAtMs: metrics.generated_at_ms,
        chainBlockHash: proof.chain_block_hash,
        chainProof: proof.chain_proof,
      };
      const key = `${edge.advertiser}\n${edge.advertised}`;
      const previous = accepted.get(key);
      if (!previous || edge.observedAtMs > previous.observedAtMs) accepted.set(key, edge);
    }

    snapshots.push({ source, generatedAtMs: metrics.generated_at_ms, edgeCount: accepted.size, truncated: metrics.gossip_truncated });
    for (const [pair, edge] of accepted) {
      const key = `${source}\n${pair}`;
      const previous = merged.get(key);
      if (!previous || edge.observedAtMs > previous.observedAtMs
        || (edge.observedAtMs === previous.observedAtMs && edge.generatedAtMs > previous.generatedAtMs)) merged.set(key, edge);
    }
  }

  return { available: snapshots.length > 0, snapshots, edges: [...merged.values()] };
}

module.exports = { GOSSIP_PROVENANCE, MAX_GOSSIP_AGE_MS, MAX_GOSSIP_EDGES, validateTopologySnapshots };
