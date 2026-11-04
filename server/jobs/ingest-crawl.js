'use strict';

/**
 * Crawl Ingester Job
 *
 * Polls the Ziggurat crawler's JSON-RPC (getmetrics), invokes the Rust cruncher
 * for geolocation + centrality enrichment, then persists to PostgreSQL.
 *
 * Run: node server/jobs/ingest-crawl.js [--dry-run]
 * Schedule: every 5 minutes via flock in crontab.production.
 *
 * During parallel validation, writes to `nodes_crawl` (shadow table).
 * After cutover (NODE_SOURCE=crawl), writes to `nodes` directly.
 */

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { log, loadEnv, withAdvisoryLock } = require('../lib/job-utils');
const { getPool } = require('../lib/db-pool');
const { callZebraRPC } = require('../lib/zebra-rpc');
const { parsePeerClient, parsePeerAddress } = require('../lib/peer-client');
const { CENSUS_VERSION, validateCrawlSnapshot, mergeVerifiedNodes, livePeerNodes, COMBINED_ELIGIBILITY, CRAWL_PROOF_MATCH, CRAWL_ELIGIBILITY, CENSUS_OBSERVED_AT } = require('../lib/node-census');
const { parseTorExitList, publishTorClassificationStatus } = require('../lib/tor-classification');
const { validateTopologySnapshots } = require('../lib/node-topology');
const { persistTopologySnapshot } = require('../lib/node-topology-store');

const execFileAsync = promisify(execFile);

loadEnv(__dirname);

const CRAWLER_RPC_HOST = process.env.CRAWLER_RPC_HOST || '127.0.0.1';
const CRAWLER_RPC_PORT = parseInt(process.env.CRAWLER_RPC_PORT || '54321');
const CRAWLER_TOR_RPC_PORT = parseInt(process.env.CRAWLER_TOR_RPC_PORT || '54322');
const CRUNCHER_BIN = process.env.CRUNCHER_BIN || '/opt/zcash-crawler/target/release/cruncher';
const MAXMIND_DB_PATH = process.env.MAXMIND_DB_PATH || '/opt/zcash-crawler/data/GeoLite2-City.mmdb';
const NODE_SOURCE = process.env.NODE_SOURCE || 'peer';
const DRY_RUN = process.argv.includes('--dry-run');
const ADVISORY_LOCK_ID = 839272; // 839271 belongs to refresh-turnstile.js.

const pool = getPool({ max: 3, idleTimeoutMillis: 10000 });

/**
 * Call a crawler's JSON-RPC endpoint.
 */
function callCrawlerRPC(method, port = CRAWLER_RPC_PORT) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 });
    const req = http.request({
      hostname: CRAWLER_RPC_HOST,
      port,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) reject(new Error(`RPC error: ${JSON.stringify(parsed.error)}`));
          else resolve(parsed.result);
        } catch (e) {
          reject(new Error(`RPC parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('RPC timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Invoke the Rust cruncher binary.
 * Stdin: raw crawl JSON, Stdout: enriched JSON with geo + centrality.
 */
async function runCruncher(crawlJson) {
  const tmpFile = path.join(os.tmpdir(), `crawl-input-${process.pid}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(crawlJson));

  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', [
      '-c', `${CRUNCHER_BIN} --mmdb ${MAXMIND_DB_PATH} < ${tmpFile}`,
    ], {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 60000,
    });

    if (stderr) {
      log(`[Cruncher stderr] ${stderr.slice(0, 500)}`);
    }

    return JSON.parse(stdout);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Fetch known Tor exit node IPs from the Tor Project's bulk exit list.
 */
function fetchTorExitNodes({ get = https.get, now = Date.now } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let deadline;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const unavailable = () => finish({ available: false, ips: new Set(), checkedAtMs: now() });
    const req = get('https://check.torproject.org/torbulkexitlist', { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { unavailable(); res.destroy(); return; }
      res.on('error', unavailable);
      res.on('aborted', unavailable);
      let data = '';
      res.on('data', (chunk) => {
        if (settled) return;
        data += chunk;
        if (Buffer.byteLength(data) > 1024 * 1024) { unavailable(); res.destroy(); }
      });
      res.on('end', () => {
        if (settled) return;
        const ips = parseTorExitList(data);
        if (!ips) { log('Tor exit list unavailable: empty or invalid response'); unavailable(); return; }
        log(`Fetched ${ips.size} Tor exit node IPs`);
        finish({ available: true, ips, checkedAtMs: now() });
      });
    }).on('error', (err) => {
      log(`Could not fetch Tor exit list: ${err.message}`);
      unavailable();
    });
    req.on('timeout', () => req.destroy(new Error('Tor exit-list timeout')));
    if (!settled) deadline = setTimeout(() => {
      unavailable();
      req.destroy(new Error('Tor exit-list deadline'));
    }, 8000);
  });
}

/**
 * Determine the target table based on NODE_SOURCE and dry-run mode.
 */
function getTargetTable() {
  if (DRY_RUN) return 'nodes_crawl';
  return NODE_SOURCE === 'crawl' ? 'nodes' : 'nodes_crawl';
}

/**
 * Main ingestion logic.
 */
async function ingestCrawl({ rpc = callCrawlerRPC, peerRpc = callZebraRPC, now = Date.now, crunch = runCruncher, torExits = fetchTorExitNodes, dbPool = pool, classificationPublisher = publishTorClassificationStatus } = {}) {
  const startTime = Date.now();
  const targetTable = getTargetTable();
  log(`Starting crawl ingestion (target: ${targetTable}, dry-run: ${DRY_RUN})`);

  // Collect independently: a crawler outage must not suppress live peers, and
  // a node RPC outage must not refresh or erase previous peer observations.
  const sources = await Promise.allSettled([
    rpc('getmetrics').then(m => validateCrawlSnapshot(m, now())),
    rpc('getmetrics', CRAWLER_TOR_RPC_PORT).then(m => validateCrawlSnapshot(m, now())),
    peerRpc('getpeerinfo', [], { timeout: 8000 }).then(peers => livePeerNodes(peers, now())),
  ]);
  const snapshots = sources.slice(0, 2).filter(s => s.status === 'fulfilled').map(s => s.value);
  const qualifiedTopology = validateTopologySnapshots(sources.slice(0, 2).flatMap((source, index) =>
    source.status === 'fulfilled' ? [{ source: index === 0 ? 'direct' : 'tor', metrics: source.value }] : []), now());
  const peers = sources[2].status === 'fulfilled' ? sources[2].value : [];
  sources.forEach((source, i) => {
    if (source.status === 'rejected') log(`${['Direct crawler', 'Tor crawler', 'Live peers'][i]} unavailable (not refreshed)`);
  });
  if (!snapshots.length && sources[2].status === 'rejected') throw new Error('All node observation sources unavailable');
  const metrics = structuredClone(snapshots[0] || { generated_at_ms: Date.now(), num_good_nodes: 0, num_known_nodes: 0, num_known_connections: 0, num_versions: 0, protocol_versions: {}, user_agents: {}, crawler_runtime: { secs: 0, nanos: 0 }, node_info: [], node_network_types: [], nodes_indices: [], all_node_addrs: [], all_nodes_indices: [], all_node_reachable: [] });
  const crawled = mergeVerifiedNodes(snapshots, now());
  const crawlByHost = new Map(crawled.map(n => [parsePeerAddress(n.addr).host, n]));
  const peerByHost = new Map(peers.map(n => [parsePeerAddress(n.addr).host, n]));
  const combined = new Map(crawlByHost);
  for (const [host, peer] of peerByHost) {
    const crawl = crawlByHost.get(host);
    combined.set(host, { ...crawl, ...peer, handshake_time_ms: crawl?.handshake_time_ms ?? null });
  }
  const verified = [...combined.values()];
  log(`Combined census: ${crawled.length} crawler IPs, ${peers.length} live-peer IPs, ${verified.length} unique IPs`);
  // A filtered/reordered list no longer has the original adjacency indices.
  const originalAddrs = (metrics.node_info || []).map(node => node.addr);
  if (verified.length !== originalAddrs.length || verified.some((node, i) => node.addr !== originalAddrs[i])) {
    const originalIndex = new Map(originalAddrs.map((addr, i) => [addr, i]));
    const newIndex = new Map(verified.map((node, i) => [node.addr, i]));
    metrics.nodes_indices = verified.map(node => (metrics.nodes_indices?.[originalIndex.get(node.addr)] || [])
      .map(i => newIndex.get(originalAddrs[i])).filter(i => i !== undefined));
  }
  metrics.node_info = verified;
  metrics.node_addrs = verified.map(node => node.addr);
  metrics.num_good_nodes = verified.length;
  metrics.node_network_types = verified.map(() => 'Zcash');
  // Legacy all_* snapshots have no chain-qualified advertiser provenance. Even
  // after filtering node_info, passing them through would retain Flux as grey
  // "off" vertices and contaminate centrality. Quarantine that whole graph.
  // The qualified core's filtered nodes_indices may retain real gossip links.
  metrics.all_node_addrs = [];
  metrics.all_nodes_indices = [];
  metrics.all_node_reachable = [];

  const enriched = await crunch(metrics);
  if (!enriched || !Array.isArray(enriched.nodes)) {
    throw new Error('Cruncher returned invalid output');
  }
  // Qualified node membership does not establish the old graph's provenance.
  // Keep geography/client enrichment, but publish no connectivity measurements.
  enriched.edges = [];
  enriched.topo_nodes = [];
  enriched.topo_edges = [];
  for (const node of enriched.nodes) {
    node.betweenness = null;
    node.closeness = null;
    node.degree = null;
  }

  log(`Cruncher enriched ${enriched.nodes.length} nodes`);

  let torResult;
  try { torResult = await torExits(); } catch { torResult = null; }
  // Injected legacy Set providers remain supported; an empty set is unknown.
  if (torResult instanceof Set) torResult = { available: torResult.size > 0, ips: torResult, checkedAtMs: now() };
  const parsedTorIPs = torResult?.ips instanceof Set ? parseTorExitList([...torResult.ips].join('\n')) : null;
  const torAvailable = torResult?.available === true && !!parsedTorIPs
    && Number.isSafeInteger(torResult.checkedAtMs) && torResult.checkedAtMs <= now()
    && now() - torResult.checkedAtMs <= 600000;
  const torExitIPs = torAvailable ? parsedTorIPs : new Set();
  const checkedAtMs = torResult?.checkedAtMs <= now() && Number.isSafeInteger(torResult.checkedAtMs) ? torResult.checkedAtMs : now();

  const client = await dbPool.connect();
  try {
    await withAdvisoryLock(client, ADVISORY_LOCK_ID, async () => {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '10s'");

      let upserted = 0;
      let newNodes = 0;

      for (const node of enriched.nodes) {
        if (!node.addr) continue;

        const [ip, portStr] = node.addr.includes(']:')
          ? [node.addr.match(/\[(.+)\]/)?.[1], node.addr.split(']:')[1]]
          : node.addr.split(':');

        if (!ip || ip === '0.0.0.0') continue;

        const crawlObservation = crawlByHost.get(ip);
        const peerObservation = peerByHost.get(ip);
        if (!crawlObservation && !peerObservation) continue;
        const crawlTime = crawlObservation?.last_verified_at_ms;
        const chainTime = crawlObservation?.chain_verified_at_ms;
        const peerTime = peerObservation?.last_peer_seen_at_ms;
        const observedAt = Math.max(chainTime || 0, peerTime || 0);
        const port = parseInt(portStr) || 8233;
        const isOnion = ip.endsWith('.onion');
        const isTor = isOnion || torExitIPs.has(ip);
        const torType = isOnion ? 'relay' : (isTor ? 'exit' : null);

        const parsed = parsePeerClient(node.user_agent || '');
        const previousObservation = `GREATEST(${targetTable}.last_chain_verified_at, ${targetTable}.last_peer_seen_at)`;
        const latestObservation = `(${previousObservation} IS NULL OR EXCLUDED.last_seen >= ${previousObservation})`;
        const latestProof = `EXCLUDED.last_chain_verified_at IS NOT NULL AND (${targetTable}.last_chain_verified_at IS NULL OR EXCLUDED.last_chain_verified_at >= ${targetTable}.last_chain_verified_at)`;
        const preservePeerIdentity = `EXCLUDED.user_agent IS NULL AND EXCLUDED.last_peer_seen_at IS NULL AND ${targetTable}.observed_via = 'peer'
          AND ${targetTable}.last_peer_seen_at > NOW() - INTERVAL '15 minutes' AND ${targetTable}.last_peer_seen_at <= NOW()`;
        const replaceIdentity = `${latestObservation} AND NOT COALESCE((${preservePeerIdentity}), FALSE)`;

        const result = await client.query(`
          INSERT INTO ${targetTable} (
            ip, port, country, country_code, city, lat, lon, isp,
            ping_ms, is_tor, is_active, user_agent, client_impl,
            client_version, protocol_version, observed_via, onion_address,
            tor_type, betweenness, closeness, degree, network_type,
            start_height, services, crawl_seen_count, last_verified_at, last_seen, last_peer_seen_at, inbound,
            last_chain_verified_at, chain_block_hash, chain_proof
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE,
            $11, $12, $13, $14, $27, $15, $16, $17, $18, $19, $20,
            $21, $22, CASE WHEN $23::timestamptz IS NULL THEN 0 ELSE 1 END, $23, $24, $25, $26,
            $28, $29, $30
          )
          ON CONFLICT (ip) DO UPDATE SET
            port = CASE WHEN ${latestObservation} THEN EXCLUDED.port ELSE ${targetTable}.port END,
            country = COALESCE(EXCLUDED.country, ${targetTable}.country),
            country_code = COALESCE(EXCLUDED.country_code, ${targetTable}.country_code),
            city = COALESCE(EXCLUDED.city, ${targetTable}.city),
            lat = COALESCE(EXCLUDED.lat, ${targetTable}.lat),
            lon = COALESCE(EXCLUDED.lon, ${targetTable}.lon),
            isp = COALESCE(EXCLUDED.isp, ${targetTable}.isp),
            ping_ms = CASE WHEN ${latestProof} THEN EXCLUDED.ping_ms ELSE ${targetTable}.ping_ms END,
            is_tor = CASE WHEN $31 OR EXCLUDED.onion_address IS NOT NULL THEN EXCLUDED.is_tor ELSE ${targetTable}.is_tor END,
            is_active = TRUE,
            user_agent = CASE WHEN ${replaceIdentity} THEN EXCLUDED.user_agent ELSE ${targetTable}.user_agent END,
            client_impl = CASE WHEN ${replaceIdentity} THEN EXCLUDED.client_impl ELSE ${targetTable}.client_impl END,
            client_version = CASE WHEN ${replaceIdentity} THEN EXCLUDED.client_version ELSE ${targetTable}.client_version END,
            protocol_version = CASE WHEN ${latestObservation} THEN COALESCE(EXCLUDED.protocol_version, ${targetTable}.protocol_version) ELSE ${targetTable}.protocol_version END,
            observed_via = CASE WHEN ${preservePeerIdentity} THEN ${targetTable}.observed_via WHEN ${latestObservation} THEN EXCLUDED.observed_via ELSE ${targetTable}.observed_via END,
            inbound = CASE WHEN EXCLUDED.last_peer_seen_at >= ${targetTable}.last_peer_seen_at OR ${targetTable}.last_peer_seen_at IS NULL THEN COALESCE(EXCLUDED.inbound, ${targetTable}.inbound) ELSE ${targetTable}.inbound END,
            last_peer_seen_at = GREATEST(EXCLUDED.last_peer_seen_at, ${targetTable}.last_peer_seen_at),
            last_seen = GREATEST(EXCLUDED.last_seen, ${previousObservation}),
            last_verified_at = CASE WHEN ${latestProof} THEN EXCLUDED.last_verified_at ELSE ${targetTable}.last_verified_at END,
            last_chain_verified_at = CASE WHEN ${latestProof} THEN EXCLUDED.last_chain_verified_at ELSE ${targetTable}.last_chain_verified_at END,
            chain_block_hash = CASE WHEN ${latestProof} THEN EXCLUDED.chain_block_hash ELSE ${targetTable}.chain_block_hash END,
            chain_proof = CASE WHEN ${latestProof} THEN EXCLUDED.chain_proof ELSE ${targetTable}.chain_proof END,
            onion_address = COALESCE(EXCLUDED.onion_address, ${targetTable}.onion_address),
            tor_type = CASE WHEN $31 OR EXCLUDED.onion_address IS NOT NULL THEN EXCLUDED.tor_type ELSE ${targetTable}.tor_type END,
            betweenness = NULL,
            closeness = NULL,
            degree = NULL,
            network_type = CASE WHEN ${latestObservation} THEN EXCLUDED.network_type ELSE ${targetTable}.network_type END,
            start_height = CASE WHEN ${latestObservation} THEN COALESCE(EXCLUDED.start_height, ${targetTable}.start_height) ELSE ${targetTable}.start_height END,
            services = CASE WHEN ${latestObservation} THEN COALESCE(EXCLUDED.services, ${targetTable}.services) ELSE ${targetTable}.services END,
            crawl_seen_count = CASE WHEN EXCLUDED.last_chain_verified_at IS NULL THEN COALESCE(${targetTable}.crawl_seen_count, 0)
              WHEN ${targetTable}.last_chain_verified_at IS NULL THEN 1
              WHEN EXCLUDED.last_chain_verified_at > ${targetTable}.last_chain_verified_at THEN COALESCE(${targetTable}.crawl_seen_count, 0) + 1
              ELSE ${targetTable}.crawl_seen_count END,
            crawl_miss_count = CASE WHEN EXCLUDED.last_chain_verified_at IS NOT NULL AND ${targetTable}.last_chain_verified_at IS NULL THEN 0 ELSE ${targetTable}.crawl_miss_count END
          RETURNING (xmax = 0) AS is_insert
        `, [
          ip, port,
          node.geo?.country || null,
          node.geo?.country_code || null,
          node.geo?.city || null,
          node.geo?.lat ?? null,
          node.geo?.lon ?? null,
          node.geo?.isp || null,
          crawlObservation?.handshake_time_ms ?? null,
          isTor,
          parsed.userAgent || node.user_agent || null,
          parsed.clientImpl,
          parsed.clientVersion,
          node.protocol_version || null,
          isOnion ? ip : null,
          torType,
          node.betweenness ?? null,
          node.closeness ?? null,
          node.degree ?? null,
          node.network_type || null,
          node.start_height || null,
          node.services ?? null,
          crawlTime ? new Date(crawlTime) : null,
          new Date(observedAt),
          peerTime ? new Date(peerTime) : null,
          peerObservation ? peerObservation.inbound : null,
          peerObservation ? 'peer' : 'crawl',
          chainTime ? new Date(chainTime) : null,
          crawlObservation?.chain_block_hash ?? null,
          crawlObservation?.chain_proof ?? null,
          torAvailable,
        ]);

        if (result.rows[0]?.is_insert) newNodes++;
        else upserted++;
      }

      // Cross-reference with Zebra peer data to fill Unknown gaps
      if (targetTable === 'nodes_crawl') {
        const crossRef = await client.query(`
          UPDATE nodes_crawl nc SET
            client_impl = n.client_impl,
            client_version = n.client_version,
            user_agent = n.user_agent,
            protocol_version = COALESCE(nc.protocol_version, n.protocol_version)
          FROM nodes n
          WHERE nc.ip = n.ip
            AND nc.client_impl = 'Unknown'
            AND n.client_impl IS NOT NULL
            AND n.client_impl != 'Unknown'
        `);
        if (crossRef.rowCount > 0) {
          log(`Cross-referenced ${crossRef.rowCount} nodes from Zebra peer data`);
        }
      }

      // A valid provider observation reclassifies the entire active population.
      // Failure preserves last-known flags, which are not a current public count.
      if (torAvailable) {
        const torFlagged = await client.query(`
          UPDATE ${targetTable} SET is_tor = (onion_address IS NOT NULL OR ip = ANY($1::varchar[])),
            tor_type = CASE WHEN onion_address IS NOT NULL THEN 'relay' WHEN ip = ANY($1::varchar[]) THEN 'exit' ELSE NULL END
          WHERE is_active = TRUE
          RETURNING id
        `, [[...torExitIPs]]);
        if (torFlagged.rowCount > 0) {
          log(`Refreshed Tor classification for ${torFlagged.rowCount} active nodes`);
        }
      }

      // Increment miss count for nodes not refreshed this crawl, then deactivate stale ones
      await client.query(`
        UPDATE ${targetTable} SET crawl_miss_count = COALESCE(crawl_miss_count, 0) + 1
        WHERE is_active = TRUE AND (${CRAWL_PROOF_MATCH})
          AND last_chain_verified_at < NOW() - INTERVAL '6 minutes'
      `);
      await client.query(`
        UPDATE ${targetTable} SET is_active = FALSE
        WHERE is_active = TRUE AND NOT COALESCE((${COMBINED_ELIGIBILITY}), FALSE)
      `);

      // Persist topology edges
      if (enriched.edges && Array.isArray(enriched.edges)) {
        await client.query('DELETE FROM node_edges');

        for (const edge of enriched.edges) {
          await client.query(`
            INSERT INTO node_edges (src_addr_id, dst_addr_id)
            SELECT s.id, d.id
            FROM ${targetTable} s, ${targetTable} d
            WHERE s.ip = $1 AND d.ip = $2
            ON CONFLICT (src_addr_id, dst_addr_id) DO UPDATE SET observed_at = NOW()
          `, [edge.src, edge.dst]);
        }
        log(`Persisted ${enriched.edges.length} topology edges`);
      }

      // Persist per-node metrics
      if (enriched.nodes.length > 0) {
        await client.query('DELETE FROM node_metrics');

        for (const node of enriched.nodes) {
          if (!node.addr || node.betweenness == null) continue;
          const nodeIp = node.addr.includes(']:')
            ? node.addr.match(/\[(.+)\]/)?.[1]
            : node.addr.split(':')[0];

          await client.query(`
            INSERT INTO node_metrics (addr_id, betweenness, closeness, degree, network_type)
            SELECT id, $2, $3, $4, $5
            FROM ${targetTable} WHERE ip = $1
            ON CONFLICT DO NOTHING
          `, [nodeIp, node.betweenness, node.closeness, node.degree, node.network_type]);
        }
      }

      // Persist the FULL known-network topology (reachable core + connected
      // "known/unreachable" nodes that reachable peers gossiped). Kept in dedicated
      // snapshot tables so it never pollutes the reachable-node metrics that read
      // the `nodes` table. Bulk UNNEST inserts keep this to two queries.
      if (!DRY_RUN && snapshots.length && Array.isArray(enriched.topo_nodes)) {
        const addrs = [];
        const ips = [];
        const reachables = [];
        const clients = [];
        const isTors = [];
        const countries = [];
        const lats = [];
        const lons = [];
        const degrees = [];
        const betweennesses = [];
        const closenesses = [];

        for (const tn of enriched.topo_nodes) {
          if (!tn.addr) continue;
          const tip = tn.addr.includes(']:')
            ? tn.addr.match(/\[(.+)\]/)?.[1]
            : tn.addr.split(':')[0];
          if (!tip) continue;
          const isOnion = tip.endsWith('.onion');
          addrs.push(tn.addr);
          ips.push(tip);
          reachables.push(tn.reachable === true);
          clients.push(tn.network_type || null);
          isTors.push(isOnion || torExitIPs.has(tip));
          countries.push(tn.geo?.country_code || null);
          lats.push(tn.geo?.lat ?? null);
          lons.push(tn.geo?.lon ?? null);
          degrees.push(tn.degree ?? 0);
          betweennesses.push(tn.betweenness ?? null);
          closenesses.push(tn.closeness ?? null);
        }

        // Snapshot semantics: replace the whole graph each crawl. DELETE (not
        // TRUNCATE) keeps concurrent API readers unblocked until COMMIT.
        await client.query('DELETE FROM topology_edges');
        await client.query('DELETE FROM topology_nodes');

        if (addrs.length > 0) {
          await client.query(`
            INSERT INTO topology_nodes
              (addr, ip, reachable, client_impl, is_tor, country_code, lat, lon, degree, betweenness, closeness)
            SELECT * FROM UNNEST(
              $1::text[], $2::text[], $3::boolean[], $4::text[], $5::boolean[],
              $6::text[], $7::double precision[], $8::double precision[],
              $9::int[], $10::double precision[], $11::double precision[]
            )
            ON CONFLICT (addr) DO NOTHING
          `, [addrs, ips, reachables, clients, isTors, countries, lats, lons, degrees, betweennesses, closenesses]);
        }

        if (Array.isArray(enriched.topo_edges) && enriched.topo_edges.length > 0) {
          const srcs = enriched.topo_edges.map(e => e.src);
          const dsts = enriched.topo_edges.map(e => e.dst);
          await client.query(`
            INSERT INTO topology_edges (src, dst)
            SELECT * FROM UNNEST($1::text[], $2::text[])
            ON CONFLICT (src, dst) DO NOTHING
          `, [srcs, dsts]);
        }

        const reachCount = reachables.filter(Boolean).length;
        log(`Persisted topology: ${addrs.length} nodes (${reachCount} reachable, ${addrs.length - reachCount} off), ${enriched.topo_edges?.length || 0} edges`);
      }

      // New directed receipts retain their original proof/receipt clocks. Legacy
      // adjacency remains quarantined; advertised targets never enter nodes.
      if (!DRY_RUN && NODE_SOURCE === 'crawl') {
        const stored = await persistTopologySnapshot(client, qualifiedTopology);
        log(stored
          ? `Qualified gossip: ${qualifiedTopology.edges.length} receipts from ${qualifiedTopology.snapshots.length} supported sources`
          : 'Qualified gossip unavailable: provenance schema not installed');
      }

      // Record snapshot
      const stats = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE is_active) AS active,
          COUNT(*) AS total,
          COUNT(DISTINCT country_code) FILTER (WHERE is_active) AS countries,
          COUNT(*) FILTER (WHERE is_active AND is_tor) AS tor,
          COUNT(*) FILTER (WHERE is_active AND last_peer_seen_at > NOW() - INTERVAL '15 minutes' AND inbound = TRUE) AS inbound,
          COUNT(*) FILTER (WHERE is_active AND last_peer_seen_at > NOW() - INTERVAL '15 minutes' AND inbound = FALSE) AS outbound,
          COUNT(*) FILTER (WHERE is_active AND tor_type = 'relay') AS tor_hidden,
          ROUND(AVG(ping_ms) FILTER (WHERE is_active AND (${CRAWL_ELIGIBILITY}) AND ping_ms > 0)::numeric, 3) AS avg_ping
          , MAX(${CENSUS_OBSERVED_AT}) FILTER (WHERE is_active) AS source_observed_at
        FROM ${targetTable}
      `);

      const clientResult = await client.query(`
        SELECT client_impl, COUNT(*)::int AS node_count
        FROM ${targetTable}
        WHERE is_active = TRUE
        GROUP BY client_impl
        ORDER BY node_count DESC
      `);

      const snap = stats.rows[0];
      const clientCounts = Object.fromEntries(
        clientResult.rows.map(r => [r.client_impl || 'Unknown', r.node_count])
      );
      const identifiedClientNodes = clientResult.rows
        .filter(r => r.client_impl && r.client_impl !== 'Unknown')
        .reduce((sum, r) => sum + Number(r.node_count), 0);

      let snapshotTimeMs = null;
      if (!DRY_RUN && NODE_SOURCE === 'crawl') {
        const snapshot = await client.query(`
          INSERT INTO node_snapshots (
            active_nodes, total_nodes, countries, tor_nodes,
            inbound_nodes, outbound_nodes, avg_ping_ms,
            identified_client_nodes, client_counts, tor_hidden_nodes, census_version
          )
          VALUES ($1, $2, $3, $4, $10, $11, $5, $6, $7, $8, $9)
          RETURNING snapshot_time
        `, [
          parseInt(snap.active), parseInt(snap.total),
          parseInt(snap.countries), parseInt(snap.tor),
          snap.avg_ping ? parseFloat(snap.avg_ping) : null,
          identifiedClientNodes, JSON.stringify(clientCounts),
          parseInt(snap.tor_hidden || 0), CENSUS_VERSION,
          parseInt(snap.inbound || 0), parseInt(snap.outbound || 0),
        ]);
        snapshotTimeMs = snapshot.rows[0]?.snapshot_time?.getTime();
      }

      await client.query('COMMIT');

      if (!DRY_RUN && NODE_SOURCE === 'crawl' && targetTable === 'nodes') {
        let published = false;
        try {
          published = await classificationPublisher({ version: 1, available: torAvailable,
            checkedAtMs, sourceObservedAtMs: snap.source_observed_at?.getTime() ?? null,
            committedAtMs: now(), snapshotTimeMs,
            classifiedTorNodes: torAvailable ? parseInt(snap.tor) : null });
        } catch { /* The DB commit stands; API commit matching rejects older cache status. */ }
        if (!published) log('Tor classification status unavailable: cache publication failed');
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Ingestion complete in ${elapsed}s — ${newNodes} new, ${upserted} updated, ${snap.active} active, ${snap.countries} countries, ${torAvailable ? snap.tor : 'unavailable'} Tor`);
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  ingestCrawl()
    .then(() => { pool.end(); process.exit(0); })
    .catch((err) => {
      log(`Ingestion failed: ${err.message}`);
      console.error(err);
      pool.end();
      process.exit(1);
    });
}

module.exports = { ingestCrawl, fetchTorExitNodes };
