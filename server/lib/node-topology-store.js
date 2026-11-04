'use strict';

const { isIP } = require('node:net');
const { CHAIN_BLOCK_HASH, CHAIN_PROOF, CENSUS_VERSION } = require('./node-census');
const { GOSSIP_PROVENANCE, MAX_GOSSIP_EDGES, MAX_GOSSIP_AGE_MS } = require('./node-topology');

const UNAVAILABLE_REASON = 'Awaiting fresh chain-qualified gossip provenance';

async function hasTopologySchema(queryable) {
  const result = await queryable.query(`
    SELECT to_regclass('topology_gossip_snapshots') AS snapshots,
      to_regclass('topology_gossip_edges') AS edges
  `);
  return Boolean(result.rows[0]?.snapshots && result.rows[0]?.edges);
}

/** Called by the ingester inside its existing transaction, after validation. */
async function persistTopologySnapshot(client, validated) {
  if (!await hasTopologySchema(client)) return false;

  // A replay or duplicate input cannot bind old receipts to a newer generation.
  const snapshots = new Map();
  for (const snapshot of validated.snapshots) {
    const previous = snapshots.get(snapshot.source);
    if (!previous || snapshot.generatedAtMs > previous.generatedAtMs) snapshots.set(snapshot.source, snapshot);
  }
  const edges = new Map();
  for (const edge of validated.edges) {
    if (snapshots.get(edge.collectorSource)?.generatedAtMs !== edge.generatedAtMs) continue;
    const key = `${edge.collectorSource}\n${edge.advertiser}\n${edge.advertised}`;
    const previous = edges.get(key);
    if (!previous || edge.observedAtMs > previous.observedAtMs) edges.set(key, edge);
  }

  // The foreign key deletes prior receipts atomically with their snapshot.
  await client.query('DELETE FROM topology_gossip_snapshots');
  for (const snapshot of snapshots.values()) {
    const edgeCount = [...edges.values()].filter(edge => edge.collectorSource === snapshot.source).length;
    await client.query(`
      INSERT INTO topology_gossip_snapshots (collector_source, generated_at, provenance, edge_count, truncated)
      VALUES ($1, $2, $3, $4, $5)
    `, [snapshot.source, new Date(snapshot.generatedAtMs), GOSSIP_PROVENANCE, edgeCount, snapshot.truncated === true]);
  }

  if (edges.size) {
    const rows = [...edges.values()];
    await client.query(`
      INSERT INTO topology_gossip_edges (
        collector_source, source_generated_at, advertiser, advertised,
        advertiser_ip, advertised_ip, observed_at, advertiser_handshake_at,
        advertiser_chain_verified_at, chain_block_hash, chain_proof
      ) SELECT * FROM UNNEST(
        $1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::text[],
        $6::text[], $7::timestamptz[], $8::timestamptz[], $9::timestamptz[],
        $10::text[], $11::text[]
      )
    `, [
      rows.map(row => row.collectorSource), rows.map(row => new Date(row.generatedAtMs)),
      rows.map(row => row.advertiser), rows.map(row => row.advertised),
      rows.map(row => row.advertiserIp), rows.map(row => row.advertisedIp),
      rows.map(row => new Date(row.observedAtMs)), rows.map(row => new Date(row.lastVerifiedAtMs)),
      rows.map(row => new Date(row.chainVerifiedAtMs)), rows.map(row => row.chainBlockHash),
      rows.map(row => row.chainProof),
    ]);
  }
  return true;
}

function canonicalIp(value) {
  const family = isIP(typeof value === 'string' ? value : '');
  if (!family || value.includes('%')) return null;
  try {
    return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
  } catch { return null; }
}

/**
 * All identity and proof columns stay private. SQL uses the database clock so
 * an API host clock or stale cache cannot keep expired evidence eligible.
 */
async function readTopologySnapshot(pool, activeRows, now = Date.now()) {
  const nodes = [];
  const idByIp = new Map();
  const qualifiedIps = new Set();
  for (const row of activeRows) {
    const ip = canonicalIp(row.ip);
    if (!ip) continue;
    if (row.census_crawl_qualified === true) qualifiedIps.add(ip);
    if (idByIp.has(ip)) continue;
    idByIp.set(ip, nodes.length);
    nodes.push({ id: nodes.length, reachable: true, client: row.client_impl || null,
      isTor: row.is_tor === true, countryCode: row.country_code || null,
      betweenness: null, closeness: null, degree: null });
  }
  const reachableCount = nodes.length;
  const response = (available, edges = [], observedAt = null, truncated = false, expiresAt = null) => ({
    success: true, censusVersion: CENSUS_VERSION, topologyAvailable: available,
    topologyUnavailableReason: available ? null : UNAVAILABLE_REASON,
    gossipProvenance: available ? GOSSIP_PROVENANCE : null,
    edgeKind: 'advertised-address', directed: true, observedAt, expiresAt, timestamp: now,
    truncated, nodes, edges,
    counts: { total: nodes.length, reachable: reachableCount,
      off: nodes.length - reachableCount, edges: edges.length },
  });
  if (!await hasTopologySchema(pool)) return response(false);

  const metadata = await pool.query(`
    SELECT collector_source, generated_at, provenance, edge_count, truncated
    FROM topology_gossip_snapshots
    WHERE provenance = $1 AND generated_at <= NOW()
      AND generated_at > NOW() - INTERVAL '10 minutes'
    ORDER BY generated_at DESC, collector_source
  `, [GOSSIP_PROVENANCE]);
  if (!metadata.rows.length) return response(false);

  // A supported fresh zero-edge snapshot remains an available observation.
  const latest = metadata.rows.reduce((time, row) => Math.max(time, new Date(row.generated_at).getTime()), 0);
  const observedAt = new Date(latest).toISOString();
  let earliestExpiry = Math.min(...metadata.rows.map(row => new Date(row.generated_at).getTime() + MAX_GOSSIP_AGE_MS));
  const sourceTruncated = metadata.rows.some(row => row.truncated === true);
  for (const node of nodes) node.degree = 0;
  if (!qualifiedIps.size) return response(true, [], observedAt, sourceTruncated, new Date(earliestExpiry).toISOString());

  const result = await pool.query(`
    SELECT e.advertiser_ip, e.advertised_ip, MAX(e.observed_at) AS observed_at,
      MIN(LEAST(s.generated_at + INTERVAL '10 minutes', e.observed_at + INTERVAL '10 minutes',
        e.advertiser_handshake_at + INTERVAL '1 hour', e.advertiser_chain_verified_at + INTERVAL '1 hour')) AS expires_at
    FROM topology_gossip_edges e
    JOIN topology_gossip_snapshots s ON s.collector_source = e.collector_source
      AND s.generated_at = e.source_generated_at
    WHERE s.provenance = $1 AND s.generated_at <= NOW()
      AND s.generated_at > NOW() - INTERVAL '10 minutes'
      AND e.chain_block_hash = $2 AND e.chain_proof = $3
      AND e.advertiser_handshake_at <= e.advertiser_chain_verified_at
      AND e.advertiser_chain_verified_at <= e.observed_at
      AND e.observed_at <= e.source_generated_at AND e.observed_at <= NOW()
      AND e.observed_at > NOW() - INTERVAL '10 minutes'
      AND e.advertiser_handshake_at > NOW() - INTERVAL '1 hour'
      AND e.advertiser_chain_verified_at > NOW() - INTERVAL '1 hour'
      AND e.advertiser_chain_verified_at <= NOW()
      AND e.advertiser_ip = ANY($4::text[])
      AND e.advertiser_ip <> e.advertised_ip
    GROUP BY e.advertiser_ip, e.advertised_ip
    ORDER BY observed_at DESC, e.advertiser_ip, e.advertised_ip
    LIMIT $5
  `, [GOSSIP_PROVENANCE, CHAIN_BLOCK_HASH, CHAIN_PROOF, [...qualifiedIps], MAX_GOSSIP_EDGES + 1]);

  const edges = [];
  const seen = new Set();
  let truncated = sourceTruncated;
  for (const row of result.rows) {
    const advertiser = canonicalIp(row.advertiser_ip);
    const advertised = canonicalIp(row.advertised_ip);
    const expiresAt = new Date(row.expires_at).getTime();
    if (!advertiser || !advertised || !qualifiedIps.has(advertiser) || advertiser === advertised
      || !Number.isFinite(expiresAt)) continue;
    const pair = `${advertiser}\n${advertised}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    if (edges.length >= MAX_GOSSIP_EDGES) { truncated = true; break; }
    earliestExpiry = Math.min(earliestExpiry, expiresAt);
    const source = idByIp.get(advertiser);
    let target = idByIp.get(advertised);
    if (target === undefined) {
      target = nodes.length;
      idByIp.set(advertised, target);
      nodes.push({ id: target, reachable: false, client: null, isTor: false,
        countryCode: null, betweenness: null, closeness: null, degree: 0 });
    }
    edges.push({ source, target });
    nodes[source].degree++;
    nodes[target].degree++;
  }
  return response(true, edges, observedAt, truncated, new Date(earliestExpiry).toISOString());
}

module.exports = { persistTopologySnapshot, readTopologySnapshot };
