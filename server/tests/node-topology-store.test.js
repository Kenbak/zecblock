'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { persistTopologySnapshot, readTopologySnapshot } = require('../lib/node-topology-store');
const { CHAIN_BLOCK_HASH, CHAIN_PROOF } = require('../lib/node-census');
const { GOSSIP_PROVENANCE, MAX_GOSSIP_EDGES } = require('../lib/node-topology');

const now = Date.parse('2026-10-23T00:00:00Z');
const schema = { snapshots: 'topology_gossip_snapshots', edges: 'topology_gossip_edges' };
const active = (ip, qualified = true, extra = {}) => ({ ip, client_impl: 'Zebra',
  is_tor: false, country_code: 'JP', census_crawl_qualified: qualified, ...extra });
const snapshot = (source = 'direct', generatedAtMs = now - 1000) => ({ source, generatedAtMs, edgeCount: 1 });
const edge = (extra = {}) => ({ collectorSource: 'direct', generatedAtMs: now - 1000,
  advertiser: '8.8.8.8:8233', advertised: '1.1.1.1:8233',
  advertiserIp: '8.8.8.8', advertisedIp: '1.1.1.1', observedAtMs: now - 2000,
  lastVerifiedAtMs: now - 6000, chainVerifiedAtMs: now - 5000,
  chainBlockHash: CHAIN_BLOCK_HASH, chainProof: CHAIN_PROOF, ...extra });
const metadata = (extra = {}) => ({ collector_source: 'direct', generated_at: new Date(now - 1000),
  provenance: GOSSIP_PROVENANCE, edge_count: 1, ...extra });

function queryMock(responses) {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({ sql, values });
    const next = responses.shift();
    if (next === undefined) throw new Error('Unexpected query');
    return { rows: next };
  } };
}

// Answers persistence queries by statement so tests assert meaning, not order.
function writerMock({ regionalAllowed = true, stored = {} } = {}) {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({ sql, values });
    if (/to_regclass\('topology_gossip_snapshots'\)/.test(sql)) return { rows: [schema] };
    if (/FROM pg_constraint/.test(sql)) return { rows: [{ allowed: regionalAllowed }] };
    if (/SELECT generated_at FROM topology_gossip_snapshots/.test(sql)) {
      return { rows: stored[values[0]] ? [{ generated_at: new Date(stored[values[0]]) }] : [] };
    }
    return { rows: [] };
  } };
}
const snapshotInserts = client => client.calls.filter(call => /INSERT INTO topology_gossip_snapshots/.test(call.sql));
const edgeInsert = client => client.calls.find(call => /INSERT INTO topology_gossip_edges/.test(call.sql));
const sourceDeletes = client => client.calls.filter(call => call.sql === 'DELETE FROM topology_gossip_snapshots WHERE collector_source = $1')
  .map(call => call.values[0]);

test('missing either new table safely defers persistence and returns unavailable active isolates', async () => {
  for (const row of [{ snapshots: null, edges: null }, { snapshots: schema.snapshots, edges: null }]) {
    const writer = queryMock([[row]]);
    assert.equal(await persistTopologySnapshot(writer, { snapshots: [], edges: [] }), false);
    assert.equal(writer.calls.length, 1);
    assert.match(writer.calls[0].sql, /to_regclass\('topology_gossip_snapshots'\)/);
    assert.match(writer.calls[0].sql, /to_regclass\('topology_gossip_edges'\)/);
    const reader = queryMock([[row]]);
    const result = await readTopologySnapshot(reader, [active('8.8.8.8')], now);
    assert.equal(result.topologyAvailable, false);
    assert.equal(result.gossipProvenance, null);
    assert.equal(result.observedAt, null);
    assert.equal(result.expiresAt, null);
    assert.equal(result.nodes[0].degree, null);
    assert.deepEqual(result.counts, { total: 1, reachable: 1, off: 0, edges: 0 });
    assert.equal(reader.calls.length, 1);
  }
});

test('persistence replaces each source atomically and retains exact source evidence clocks', async () => {
  const client = writerMock();
  assert.equal(await persistTopologySnapshot(client, { snapshots: [snapshot()], edges: [edge()] }), true);
  const prune = client.calls.find(call => /WHERE NOT \(collector_source = ANY/.test(call.sql));
  assert.match(prune.sql, /generated_at <= NOW\(\) - INTERVAL '10 minutes'/, 'database clock expires absent sources');
  assert.deepEqual(prune.values, [['direct', 'tor']]);
  assert.deepEqual(sourceDeletes(client), ['direct']);
  assert.deepEqual(snapshotInserts(client).map(call => call.values), [['direct', new Date(now - 1000), GOSSIP_PROVENANCE, 1, false]]);
  const insert = edgeInsert(client);
  assert.match(insert.sql, /UNNEST/);
  assert.doesNotMatch(insert.sql, /NOW\(|CURRENT_TIMESTAMP/);
  assert.deepEqual(insert.values, [
    ['direct'], [new Date(now - 1000)], ['8.8.8.8:8233'], ['1.1.1.1:8233'],
    ['8.8.8.8'], ['1.1.1.1'], [new Date(now - 2000)], [new Date(now - 6000)],
    [new Date(now - 5000)], [CHAIN_BLOCK_HASH], [CHAIN_PROOF],
  ]);
  assert.ok(client.calls.every(call => !/\bBEGIN\b|\bCOMMIT\b/.test(call.sql)), 'caller owns transaction boundaries');
});

test('an absent source keeps its prior snapshot until expiry while supported zero edges retain explicit metadata', async () => {
  const unsupported = writerMock();
  assert.equal(await persistTopologySnapshot(unsupported, { available: false, snapshots: [], edges: [] }), true);
  assert.deepEqual(sourceDeletes(unsupported), [], 'no source is replaced without a newer admitted snapshot');
  assert.equal(snapshotInserts(unsupported).length, 0);
  const empty = writerMock();
  await persistTopologySnapshot(empty, { available: true, snapshots: [{ ...snapshot(), edgeCount: 0 }], edges: [] });
  assert.equal(snapshotInserts(empty)[0].values[3], 0);
  assert.equal(edgeInsert(empty), undefined);
});

test('duplicate collector inputs cannot relabel older generation receipts or inflate edge counts', async () => {
  const client = writerMock();
  const newer = edge({ generatedAtMs: now - 500, observedAtMs: now - 1000 });
  await persistTopologySnapshot(client, {
    snapshots: [snapshot(), snapshot('direct', now - 500), snapshot('tor')],
    edges: [edge(), newer, { ...newer, observedAtMs: now - 1500 }, edge({ collectorSource: 'tor' })],
  });
  const inserts = snapshotInserts(client);
  assert.deepEqual(inserts[0].values, ['direct', new Date(now - 500), GOSSIP_PROVENANCE, 1, false]);
  assert.deepEqual(inserts[1].values, ['tor', new Date(now - 1000), GOSSIP_PROVENANCE, 1, false]);
  const insert = edgeInsert(client);
  assert.deepEqual(insert.values[0], ['direct', 'tor']);
  assert.deepEqual(insert.values[1], [new Date(now - 500), new Date(now - 1000)]);
  assert.deepEqual(insert.values[6], [new Date(now - 1000), new Date(now - 2000)]);
});

test('a stored newer generation is never replaced by a delayed poll from the same source', async () => {
  const client = writerMock({ stored: { direct: now - 200 } });
  await persistTopologySnapshot(client, { snapshots: [snapshot(), snapshot('tor')],
    edges: [edge(), edge({ collectorSource: 'tor' })] });
  assert.deepEqual(sourceDeletes(client), ['tor']);
  assert.deepEqual(snapshotInserts(client).map(call => call.values[0]), ['tor']);
  assert.deepEqual(edgeInsert(client).values[0], ['tor']);
});

test('regional vantages persist beside primary sources and unconfigured sources are pruned', async () => {
  const client = writerMock();
  await persistTopologySnapshot(client, { snapshots: [snapshot(), snapshot('direct-nyc3'), snapshot('bogus')],
    edges: [edge(), edge({ collectorSource: 'direct-nyc3' }), edge({ collectorSource: 'bogus' })] },
  { configuredSources: ['direct', 'tor', 'direct-nyc3', 'direct-sgp1'] });
  const prune = client.calls.find(call => /WHERE NOT \(collector_source = ANY/.test(call.sql));
  assert.deepEqual(prune.values, [['direct', 'tor', 'direct-nyc3', 'direct-sgp1']]);
  assert.deepEqual(snapshotInserts(client).map(call => call.values[0]), ['direct', 'direct-nyc3']);
  assert.deepEqual(edgeInsert(client).values[0], ['direct', 'direct-nyc3'], 'per-vantage receipts stay private rows');
});

test('before migration 043 regional rows are skipped instead of aborting the census transaction', async () => {
  const client = writerMock({ regionalAllowed: false });
  await persistTopologySnapshot(client, { snapshots: [snapshot(), snapshot('direct-nyc3')],
    edges: [edge(), edge({ collectorSource: 'direct-nyc3' })] }, { configuredSources: ['direct', 'tor', 'direct-nyc3'] });
  assert.deepEqual(snapshotInserts(client).map(call => call.values[0]), ['direct']);
  assert.deepEqual(edgeInsert(client).values[0], ['direct']);
});

test('missing or stale supported metadata stays unavailable using database clock eligibility', async () => {
  const pool = queryMock([[schema], []]);
  const result = await readTopologySnapshot(pool, [active('8.8.8.8')], now);
  assert.equal(result.topologyAvailable, false);
  assert.equal(result.nodes[0].degree, null);
  assert.match(pool.calls[1].sql, /generated_at <= NOW\(\)/);
  assert.match(pool.calls[1].sql, /generated_at > NOW\(\) - INTERVAL '10 minutes'/);
  assert.deepEqual(pool.calls[1].values, [GOSSIP_PROVENANCE]);
  assert.equal(pool.calls.length, 2);
});

test('fresh supported zero-edge observations differ from unavailable topology', async () => {
  const pool = queryMock([[schema], [metadata({ edge_count: 0 })]]);
  const result = await readTopologySnapshot(pool, [active('9.9.9.9', false)], now);
  assert.equal(result.topologyAvailable, true);
  assert.equal(result.topologyUnavailableReason, null);
  assert.equal(result.gossipProvenance, GOSSIP_PROVENANCE);
  assert.equal(result.observedAt, new Date(now - 1000).toISOString());
  assert.equal(result.expiresAt, new Date(now + 599000).toISOString());
  assert.equal(result.nodes[0].degree, 0);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.counts, { total: 1, reachable: 1, off: 0, edges: 0 });
  assert.equal(pool.calls.length, 2, 'no qualified advertisers means there can be no public edges');
});

test('public edges preserve direction, deduplicate IP pairs and require a current qualified advertiser', async () => {
  const rows = [
    { advertiser_ip: '8.8.8.8', advertised_ip: '1.1.1.1' },
    { advertiser_ip: '1.1.1.1', advertised_ip: '8.8.8.8' },
    { advertiser_ip: '8.8.8.8', advertised_ip: '4.4.4.4' },
    { advertiser_ip: '8.8.8.8', advertised_ip: '1.1.1.1' },
    { advertiser_ip: '9.9.9.9', advertised_ip: '5.5.5.5' }, // peer-only source
    { advertiser_ip: '6.6.6.6', advertised_ip: '8.8.8.8' }, // unknown source
    { advertiser_ip: '8.8.8.8', advertised_ip: '8.8.8.8' },
    { advertiser_ip: '8.8.8.8', advertised_ip: 'invalid.example' },
  ];
  const pool = queryMock([[schema], [metadata()], rows]);
  const result = await readTopologySnapshot(pool, [active('8.8.8.8'),
    active('1.1.1.1', true, { client_impl: 'Zakura', is_tor: true }), active('9.9.9.9', false)], now);
  assert.deepEqual(result.edges, [{ source: 0, target: 1 }, { source: 1, target: 0 }, { source: 0, target: 3 }]);
  assert.deepEqual(result.counts, { total: 4, reachable: 3, off: 1, edges: 3 });
  assert.deepEqual(result.nodes.map(node => node.degree), [3, 2, 0, 1]);
  assert.equal(result.nodes[1].client, 'Zakura');
  assert.equal(result.nodes[1].isTor, true);
  assert.deepEqual(result.nodes[3], { id: 3, reachable: false, client: null,
    isTor: false, countryCode: null, betweenness: null, closeness: null, degree: 1 });
  assert.equal(result.directed, true);
  assert.equal(result.edgeKind, 'advertised-address');
  assert.equal(result.truncated, false);
  assert.equal(result.expiresAt, new Date(now + 599000).toISOString());
  const serialized = JSON.stringify(result);
  for (const secret of ['8.8.8.8', '1.1.1.1', '4.4.4.4', 'advertiser', 'advertised_ip', CHAIN_BLOCK_HASH, CHAIN_PROOF]) {
    assert.ok(!serialized.includes(secret), `private identity/evidence leaked: ${secret}`);
  }
});

test('edge SQL binds fresh source metadata, proof identity, original receipt clocks and qualified source IPs', async () => {
  const pool = queryMock([[schema], [metadata()], []]);
  await readTopologySnapshot(pool, [active('8.8.8.8'), active('9.9.9.9', false)], now);
  const { sql, values } = pool.calls[2];
  assert.match(sql, /JOIN topology_gossip_snapshots s ON s.collector_source = e.collector_source/);
  assert.match(sql, /s.generated_at = e.source_generated_at/);
  assert.match(sql, /e.advertiser_handshake_at <= e.advertiser_chain_verified_at/);
  assert.match(sql, /e.advertiser_chain_verified_at <= e.observed_at/);
  assert.match(sql, /e.observed_at <= e.source_generated_at AND e.observed_at <= NOW\(\)/);
  assert.match(sql, /e.observed_at > NOW\(\) - INTERVAL '10 minutes'/);
  assert.match(sql, /e.advertiser_handshake_at > NOW\(\) - INTERVAL '1 hour'/);
  assert.match(sql, /e.advertiser_chain_verified_at > NOW\(\) - INTERVAL '1 hour'/);
  assert.match(sql, /e.advertiser_ip = ANY\(\$4::text\[\]\)/);
  assert.match(sql, /GROUP BY e.advertiser_ip, e.advertised_ip/);
  assert.doesNotMatch(sql, /expires_at/, 'receipt age filters rows and never sets the snapshot clock');
  assert.doesNotMatch(sql, /\btopology_nodes\b|\btopology_edges\b/);
  assert.deepEqual(values, [GOSSIP_PROVENANCE, CHAIN_BLOCK_HASH, CHAIN_PROOF, ['8.8.8.8'], MAX_GOSSIP_EDGES + 1]);
});

test('IPv6 textual aliases collapse to one active IP identity without exposing any address', async () => {
  const pool = queryMock([[schema], [metadata()], [
    { advertiser_ip: '2001:4860:0:0:0:0:0:8888', advertised_ip: '1.1.1.1' },
    { advertiser_ip: '2001:4860::8888', advertised_ip: '1.1.1.1' },
  ]]);
  const result = await readTopologySnapshot(pool, [active('2001:4860:0:0:0:0:0:8888'), active('2001:4860::8888')], now);
  assert.deepEqual(result.counts, { total: 2, reachable: 1, off: 1, edges: 1 });
  assert.deepEqual(result.edges, [{ source: 0, target: 1 }]);
  assert.ok(!JSON.stringify(result).includes('2001:'));
});

test('zone-scoped IPv6 identifiers cannot throw or become public graph identities', async () => {
  const pool = queryMock([[schema], [metadata()], [
    { advertiser_ip: '8.8.8.8', advertised_ip: 'fe80::1%eth0' },
  ]]);
  const result = await readTopologySnapshot(pool, [active('fe80::1%eth0'), active('8.8.8.8')], now);
  assert.deepEqual(result.counts, { total: 1, reachable: 1, off: 0, edges: 0 });
  assert.ok(!JSON.stringify(result).includes('eth0'));
});

test('collector truncation persists and propagates even when no public edges remain', async () => {
  const client = writerMock();
  await persistTopologySnapshot(client, { snapshots: [{ ...snapshot(), edgeCount: 0, truncated: true }], edges: [] });
  assert.deepEqual(snapshotInserts(client)[0].values, ['direct', new Date(now - 1000), GOSSIP_PROVENANCE, 0, true]);
  for (const activeRows of [[active('9.9.9.9', false)], [active('8.8.8.8')]]) {
    const pool = queryMock([[schema], [metadata({ truncated: true })], []]);
    const result = await readTopologySnapshot(pool, activeRows, now);
    assert.equal(result.topologyAvailable, true);
    assert.equal(result.truncated, true);
    assert.equal(result.edges.length, 0);
  }
});

test('public graph stops at the directed edge cap and reports truncation without dangling targets', async () => {
  const rows = Array.from({ length: MAX_GOSSIP_EDGES + 1 }, (_, i) => ({
    advertiser_ip: '8.8.8.8', advertised_ip: `11.${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`,
  }));
  const pool = queryMock([[schema], [metadata()], rows]);
  const result = await readTopologySnapshot(pool, [active('8.8.8.8')], now);
  assert.equal(result.edges.length, MAX_GOSSIP_EDGES);
  assert.equal(result.nodes.length, MAX_GOSSIP_EDGES + 1);
  assert.equal(result.truncated, true);
  assert.ok(result.edges.every(row => row.source < result.nodes.length && row.target < result.nodes.length));
  assert.equal(result.nodes[0].degree, MAX_GOSSIP_EDGES);
});

test('visible graph expires with its earliest supported source snapshot, not its oldest receipt', async () => {
  const metadataRows = [metadata(), metadata({ collector_source: 'tor', generated_at: new Date(now - 3000) })];
  const empty = queryMock([[schema], metadataRows]);
  assert.equal((await readTopologySnapshot(empty, [], now)).expiresAt, new Date(now + 597000).toISOString());
  const graph = queryMock([[schema], metadataRows, [
    // A receipt close to its ten-minute limit must not shorten the snapshot.
    { advertiser_ip: '8.8.8.8', advertised_ip: '1.1.1.1', observed_at: new Date(now - 599000) },
    { advertiser_ip: '8.8.8.8', advertised_ip: '4.4.4.4', observed_at: new Date(now - 2000) },
  ]]);
  const result = await readTopologySnapshot(graph, [active('8.8.8.8')], now);
  assert.equal(result.expiresAt, new Date(now + 597000).toISOString());
  assert.equal(result.edges.length, 2);
});
