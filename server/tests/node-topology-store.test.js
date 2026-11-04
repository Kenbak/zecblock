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
const graphRows = rows => rows.map(row => ({ expires_at: new Date(now + 598000), ...row }));

function queryMock(responses) {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({ sql, values });
    const next = responses.shift();
    if (next === undefined) throw new Error('Unexpected query');
    return { rows: next };
  } };
}

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

test('persistence replaces snapshots atomically and retains exact source evidence clocks', async () => {
  const client = queryMock([[schema], [], [], []]);
  assert.equal(await persistTopologySnapshot(client, { snapshots: [snapshot()], edges: [edge()] }), true);
  assert.equal(client.calls[1].sql, 'DELETE FROM topology_gossip_snapshots');
  assert.deepEqual(client.calls[2].values, ['direct', new Date(now - 1000), GOSSIP_PROVENANCE, 1, false]);
  const insert = client.calls[3];
  assert.match(insert.sql, /INSERT INTO topology_gossip_edges/);
  assert.match(insert.sql, /UNNEST/);
  assert.doesNotMatch(insert.sql, /NOW\(|CURRENT_TIMESTAMP/);
  assert.deepEqual(insert.values, [
    ['direct'], [new Date(now - 1000)], ['8.8.8.8:8233'], ['1.1.1.1:8233'],
    ['8.8.8.8'], ['1.1.1.1'], [new Date(now - 2000)], [new Date(now - 6000)],
    [new Date(now - 5000)], [CHAIN_BLOCK_HASH], [CHAIN_PROOF],
  ]);
  assert.ok(client.calls.every(call => !/\bBEGIN\b|\bCOMMIT\b/.test(call.sql)), 'caller owns transaction boundaries');
});

test('unsupported snapshots clear prior capability while supported zero edges retain explicit metadata', async () => {
  const unsupported = queryMock([[schema], []]);
  assert.equal(await persistTopologySnapshot(unsupported, { available: false, snapshots: [], edges: [] }), true);
  assert.equal(unsupported.calls.length, 2);
  const empty = queryMock([[schema], [], []]);
  await persistTopologySnapshot(empty, { available: true, snapshots: [{ ...snapshot(), edgeCount: 0 }], edges: [] });
  assert.equal(empty.calls.length, 3);
  assert.equal(empty.calls[2].values[3], 0);
});

test('duplicate collector inputs cannot relabel older generation receipts or inflate edge counts', async () => {
  const client = queryMock([[schema], [], [], [], []]);
  const newer = edge({ generatedAtMs: now - 500, observedAtMs: now - 1000 });
  await persistTopologySnapshot(client, {
    snapshots: [snapshot(), snapshot('direct', now - 500), snapshot('tor')],
    edges: [edge(), newer, { ...newer, observedAtMs: now - 1500 }, edge({ collectorSource: 'tor' })],
  });
  assert.deepEqual(client.calls[2].values, ['direct', new Date(now - 500), GOSSIP_PROVENANCE, 1, false]);
  assert.deepEqual(client.calls[3].values, ['tor', new Date(now - 1000), GOSSIP_PROVENANCE, 1, false]);
  assert.deepEqual(client.calls[4].values[0], ['direct', 'tor']);
  assert.deepEqual(client.calls[4].values[1], [new Date(now - 500), new Date(now - 1000)]);
  assert.deepEqual(client.calls[4].values[6], [new Date(now - 1000), new Date(now - 2000)]);
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
  const pool = queryMock([[schema], [metadata()], graphRows(rows)]);
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
  assert.equal(result.expiresAt, new Date(now + 598000).toISOString());
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
  assert.match(sql, /MIN\(LEAST\(s.generated_at \+ INTERVAL '10 minutes', e.observed_at \+ INTERVAL '10 minutes'/);
  assert.match(sql, /e.advertiser_handshake_at \+ INTERVAL '1 hour', e.advertiser_chain_verified_at \+ INTERVAL '1 hour'\)\) AS expires_at/);
  assert.doesNotMatch(sql, /\btopology_nodes\b|\btopology_edges\b/);
  assert.deepEqual(values, [GOSSIP_PROVENANCE, CHAIN_BLOCK_HASH, CHAIN_PROOF, ['8.8.8.8'], MAX_GOSSIP_EDGES + 1]);
});

test('IPv6 textual aliases collapse to one active IP identity without exposing any address', async () => {
  const pool = queryMock([[schema], [metadata()], graphRows([
    { advertiser_ip: '2001:4860:0:0:0:0:0:8888', advertised_ip: '1.1.1.1' },
    { advertiser_ip: '2001:4860::8888', advertised_ip: '1.1.1.1' },
  ])]);
  const result = await readTopologySnapshot(pool, [active('2001:4860:0:0:0:0:0:8888'), active('2001:4860::8888')], now);
  assert.deepEqual(result.counts, { total: 2, reachable: 1, off: 1, edges: 1 });
  assert.deepEqual(result.edges, [{ source: 0, target: 1 }]);
  assert.ok(!JSON.stringify(result).includes('2001:'));
});

test('zone-scoped IPv6 identifiers cannot throw or become public graph identities', async () => {
  const pool = queryMock([[schema], [metadata()], graphRows([
    { advertiser_ip: '8.8.8.8', advertised_ip: 'fe80::1%eth0' },
  ])]);
  const result = await readTopologySnapshot(pool, [active('fe80::1%eth0'), active('8.8.8.8')], now);
  assert.deepEqual(result.counts, { total: 1, reachable: 1, off: 0, edges: 0 });
  assert.ok(!JSON.stringify(result).includes('eth0'));
});

test('collector truncation persists and propagates even when no public edges remain', async () => {
  const client = queryMock([[schema], [], []]);
  await persistTopologySnapshot(client, { snapshots: [{ ...snapshot(), edgeCount: 0, truncated: true }], edges: [] });
  assert.deepEqual(client.calls[2].values, ['direct', new Date(now - 1000), GOSSIP_PROVENANCE, 0, true]);
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
  const pool = queryMock([[schema], [metadata()], graphRows(rows)]);
  const result = await readTopologySnapshot(pool, [active('8.8.8.8')], now);
  assert.equal(result.edges.length, MAX_GOSSIP_EDGES);
  assert.equal(result.nodes.length, MAX_GOSSIP_EDGES + 1);
  assert.equal(result.truncated, true);
  assert.ok(result.edges.every(row => row.source < result.nodes.length && row.target < result.nodes.length));
  assert.equal(result.nodes[0].degree, MAX_GOSSIP_EDGES);
});

test('visible graph expires at the earliest supported source or admitted receipt boundary', async () => {
  const metadataRows = [metadata(), metadata({ collector_source: 'tor', generated_at: new Date(now - 3000) })];
  const empty = queryMock([[schema], metadataRows]);
  assert.equal((await readTopologySnapshot(empty, [], now)).expiresAt, new Date(now + 597000).toISOString());
  const graph = queryMock([[schema], metadataRows, graphRows([
    { advertiser_ip: '8.8.8.8', advertised_ip: '1.1.1.1', expires_at: new Date(now + 5000) },
    { advertiser_ip: '9.9.9.9', advertised_ip: '4.4.4.4', expires_at: new Date(now + 1000) },
  ])]);
  const result = await readTopologySnapshot(graph, [active('8.8.8.8')], now);
  assert.equal(result.expiresAt, new Date(now + 5000).toISOString());
  assert.equal(result.edges.length, 1, 'only admitted receipt boundaries affect the visible graph');
});
