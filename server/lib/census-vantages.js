'use strict';

const { BlockList, isIP } = require('node:net');

/**
 * Census collector sources. `direct` and `tor` are the primary's loopback
 * crawlers. Regional vantages are `direct-<region>` crawlers on observers that
 * the primary polls over the private WireGuard network. Keep this pattern
 * identical to migration 043's CHECK constraints.
 */
const PRIMARY_SOURCES = Object.freeze(['direct', 'tor']);
const REGIONAL_SOURCE = /^direct-[a-z][a-z0-9]{1,15}$/;
const MAX_VANTAGES = 8;
const DEFAULT_VANTAGE_NETWORK = '10.77.0.0/24';

function isCollectorSource(value) {
  return typeof value === 'string' && (PRIMARY_SOURCES.includes(value) || REGIONAL_SOURCE.test(value));
}

function isPrimarySource(value) {
  return PRIMARY_SOURCES.includes(value);
}

function parseNetwork(value) {
  const match = typeof value === 'string' ? value.trim().match(/^([0-9.]+)\/(\d{1,2})$/) : null;
  const prefix = match ? Number(match[2]) : NaN;
  if (!match || isIP(match[1]) !== 4 || prefix < 8 || prefix > 32) {
    throw new Error('CRAWLER_VANTAGE_NETWORK must be an IPv4 CIDR with a /8 to /32 prefix');
  }
  const list = new BlockList();
  list.addSubnet(match[1], prefix, 'ipv4');
  return list;
}

/**
 * Parse `CRAWLER_VANTAGES`, e.g. `nyc3=10.77.0.2:54321,sgp1=10.77.0.3:54321`.
 * Each crawler RPC must be a literal IPv4 inside the private vantage network:
 * the ingester never polls a public host or a DNS name. Invalid entries are
 * skipped and reported so one typo cannot disable the whole census.
 */
function parseVantages(spec, network = DEFAULT_VANTAGE_NETWORK) {
  const vantages = [];
  const errors = [];
  if (spec == null || String(spec).trim() === '') return { vantages, errors };
  const allowed = parseNetwork(network || DEFAULT_VANTAGE_NETWORK);
  const seenSources = new Set();
  const seenEndpoints = new Set();
  for (const raw of String(spec).split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = entry.match(/^([a-z][a-z0-9]{1,15})=([0-9.]+):(\d{1,5})$/);
    if (!match) { errors.push(`invalid vantage entry "${entry.slice(0, 64)}"`); continue; }
    const [, region, host, rawPort] = match;
    const port = Number(rawPort);
    const source = `direct-${region}`;
    const endpoint = `${host}:${port}`;
    if (isIP(host) !== 4 || !allowed.check(host, 'ipv4')) {
      errors.push(`${source}: ${host} is outside the private vantage network`); continue;
    }
    if (port < 1 || port > 65535) { errors.push(`${source}: invalid port`); continue; }
    if (seenSources.has(source)) { errors.push(`${source}: duplicate region`); continue; }
    if (seenEndpoints.has(endpoint)) { errors.push(`${source}: duplicate endpoint ${endpoint}`); continue; }
    if (vantages.length >= MAX_VANTAGES) { errors.push(`${source}: more than ${MAX_VANTAGES} vantages`); continue; }
    seenSources.add(source);
    seenEndpoints.add(endpoint);
    vantages.push({ source, host, port });
  }
  return { vantages, errors };
}

/**
 * Record per-source admission inside the ingester's census transaction.
 * Failed polls keep the last admitted snapshot facts so staleness stays
 * visible as attempted_at - admitted_at. Unconfigured sources are removed.
 */
async function persistVantageStatus(client, statuses, configuredSources) {
  const schema = await client.query("SELECT to_regclass('census_vantage_status') AS status");
  if (!schema.rows[0]?.status) return false;
  const rows = statuses.filter(status => isCollectorSource(status.source));
  const configured = [...new Set([...(configuredSources || []), ...rows.map(row => row.source)])]
    .filter(isCollectorSource);
  await client.query('DELETE FROM census_vantage_status WHERE NOT (collector_source = ANY($1::text[]))', [configured]);
  for (const row of rows) {
    const admitted = row.outcome === 'admitted';
    await client.query(`
      INSERT INTO census_vantage_status (collector_source, attempted_at, outcome, admitted_at,
        generated_at, verified_endpoints, gossip_supported, gossip_receipts)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (collector_source) DO UPDATE SET
        attempted_at = EXCLUDED.attempted_at,
        outcome = EXCLUDED.outcome,
        admitted_at = COALESCE(EXCLUDED.admitted_at, census_vantage_status.admitted_at),
        generated_at = CASE WHEN EXCLUDED.outcome = 'admitted' THEN EXCLUDED.generated_at ELSE census_vantage_status.generated_at END,
        verified_endpoints = CASE WHEN EXCLUDED.outcome = 'admitted' THEN EXCLUDED.verified_endpoints ELSE census_vantage_status.verified_endpoints END,
        gossip_supported = CASE WHEN EXCLUDED.outcome = 'admitted' THEN EXCLUDED.gossip_supported ELSE census_vantage_status.gossip_supported END,
        gossip_receipts = CASE WHEN EXCLUDED.outcome = 'admitted' THEN EXCLUDED.gossip_receipts ELSE census_vantage_status.gossip_receipts END
    `, [row.source, new Date(row.attemptedAtMs), row.outcome,
      admitted ? new Date(row.attemptedAtMs) : null,
      admitted ? new Date(row.generatedAtMs) : null,
      admitted ? row.verifiedEndpoints : null,
      admitted ? row.gossipSupported === true : null,
      admitted && row.gossipSupported ? row.gossipReceipts : null]);
  }
  return true;
}

module.exports = { persistVantageStatus, PRIMARY_SOURCES, REGIONAL_SOURCE, MAX_VANTAGES, DEFAULT_VANTAGE_NETWORK,
  isCollectorSource, isPrimarySource, parseVantages };
