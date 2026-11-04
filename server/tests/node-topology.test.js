'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHAIN_PROOF, CHAIN_BLOCK_HASH, mergeVerifiedNodes } = require('../lib/node-census');
const { GOSSIP_PROVENANCE, MAX_GOSSIP_AGE_MS, MAX_GOSSIP_EDGES, validateTopologySnapshots } = require('../lib/node-topology');

const now = Date.parse('2026-10-23T00:00:00Z');
const advertiser = '8.8.8.8:8233';
const advertised = '1.1.1.1:8233';
const proof = (addr = advertiser, extra = {}) => ({ addr, last_verified_at_ms: now - 6000,
  chain_verified_at_ms: now - 5000, chain_proof: CHAIN_PROOF, chain_block_hash: CHAIN_BLOCK_HASH, ...extra });
const receipt = (source = advertiser, target = advertised, extra = {}) => ({ source, target, observed_at_ms: now - 2000, ...extra });
const snapshot = (extra = {}) => ({ generated_at_ms: now - 1000, node_info: [proof()],
  gossip_provenance: GOSSIP_PROVENANCE, gossip_truncated: false, gossip_edges: [receipt()], ...extra });
const validate = (metrics = snapshot(), at = now) => validateTopologySnapshots([{ source: 'direct', metrics }], at);

test('a supported snapshot retains directed endpoint and original evidence clocks', () => {
  const result = validate();
  assert.equal(result.available, true);
  assert.deepEqual(result.snapshots, [{ source: 'direct', generatedAtMs: now - 1000, edgeCount: 1, truncated: false }]);
  assert.deepEqual(result.edges, [{ collectorSource: 'direct', advertiser, advertised,
    advertiserIp: '8.8.8.8', advertisedIp: '1.1.1.1', observedAtMs: now - 2000,
    lastVerifiedAtMs: now - 6000, chainVerifiedAtMs: now - 5000, generatedAtMs: now - 1000,
    chainBlockHash: CHAIN_BLOCK_HASH, chainProof: CHAIN_PROOF }]);
  assert.deepEqual(validate(snapshot(), now + 60000).edges, result.edges, 'ingestion never refreshes evidence clocks');
});

test('unavailable collectors differ from supported fresh snapshots with zero edges', () => {
  assert.deepEqual(validateTopologySnapshots([], now), { available: false, snapshots: [], edges: [] });
  assert.deepEqual(validateTopologySnapshots(null, now), { available: false, snapshots: [], edges: [] });
  assert.equal(validate(snapshot({ gossip_provenance: undefined })).available, false);
  assert.equal(validate(snapshot({ gossip_provenance: 'unqualified-v0' })).available, false);
  assert.equal(validate(snapshot({ gossip_edges: undefined })).available, false);
  assert.equal(validate(snapshot({ gossip_edges: {} })).available, false);
  const empty = validate(snapshot({ node_info: [], gossip_edges: [] }));
  assert.equal(empty.available, true);
  assert.deepEqual(empty.snapshots, [{ source: 'direct', generatedAtMs: now - 1000, edgeCount: 0, truncated: false }]);
  assert.deepEqual(empty.edges, []);
});

test('stale, future, malformed and oversized snapshots are rejected entirely', () => {
  for (const extra of [
    { generated_at_ms: now - 180001 }, { generated_at_ms: now + 1 }, { generated_at_ms: String(now - 1000) },
    { generated_at_ms: undefined }, { node_info: {} }, { gossip_truncated: undefined }, { gossip_truncated: 'false' },
    { gossip_edges: Array(MAX_GOSSIP_EDGES + 1).fill(receipt()) },
    { node_info: Array(MAX_GOSSIP_EDGES + 1).fill(proof()), gossip_edges: [] },
  ]) {
    assert.deepEqual(validate(snapshot(extra)), { available: false, snapshots: [], edges: [] });
  }
  assert.equal(validateTopologySnapshots([{ source: 'unknown', metrics: snapshot() }], now).available, false);
  assert.equal(validate(snapshot(), Number.NaN).available, false);
});

test('a receipt can use proof only from its exact source endpoint in the same collector snapshot', () => {
  for (const node_info of [[], [proof('8.8.8.8:18233')], [proof(advertised)]]) {
    assert.deepEqual(validate(snapshot({ node_info })).edges, []);
  }
  const direct = snapshot({ node_info: [] });
  const tor = snapshot({ gossip_edges: [] });
  const result = validateTopologySnapshots([{ source: 'direct', metrics: direct }, { source: 'tor', metrics: tor }], now);
  assert.equal(result.available, true);
  assert.deepEqual(result.edges, [], 'Tor proof never certifies a direct observation');
  const anotherSnapshot = snapshot({ node_info: [], gossip_edges: [receipt()] });
  assert.deepEqual(validateTopologySnapshots([{ source: 'direct', metrics: tor },
    { source: 'direct', metrics: anotherSnapshot }], now).edges, [], 'a separate snapshot cannot donate proof either');
});

test('source proof must have the pinned identity and ordered, fresh handshake/proof clocks', () => {
  for (const changes of [
    { chain_proof: undefined }, { chain_proof: 'other-chain-v1' }, { chain_block_hash: '0'.repeat(64) },
    { last_verified_at_ms: undefined }, { chain_verified_at_ms: undefined },
    { last_verified_at_ms: now - 3600001, chain_verified_at_ms: now - 3600000 },
    { last_verified_at_ms: now - 3600001, chain_verified_at_ms: now - 3600001 },
    { chain_verified_at_ms: now - 7000 }, { chain_verified_at_ms: now + 1 },
    { chain_verified_at_ms: now - 1500 }, { chain_verified_at_ms: now - 500 },
  ]) {
    assert.deepEqual(validate(snapshot({ node_info: [proof(advertiser, changes)] })).edges, []);
  }
});

test('receipts must occur after proof and before generation without exceeding their own age bound', () => {
  for (const observed_at_ms of [undefined, 'invalid', now + 1, now - 500, now - 5001, 0, -1]) {
    assert.deepEqual(validate(snapshot({ gossip_edges: [receipt(advertiser, advertised, { observed_at_ms })] })).edges, []);
  }
  const oldProof = proof(advertiser, { last_verified_at_ms: now - MAX_GOSSIP_AGE_MS - 2000,
    chain_verified_at_ms: now - MAX_GOSSIP_AGE_MS - 1000 });
  assert.deepEqual(validate(snapshot({ node_info: [oldProof], gossip_edges: [receipt(advertiser, advertised,
    { observed_at_ms: now - MAX_GOSSIP_AGE_MS - 1 })] })).edges, []);
  assert.equal(validate(snapshot({ node_info: [oldProof], gossip_edges: [receipt(advertiser, advertised,
    { observed_at_ms: now - MAX_GOSSIP_AGE_MS })] })).edges.length, 1);
});

test('direct and Tor receipts retain separate evidence and directional pairs deduplicate to latest receipt', () => {
  const metrics = snapshot({ node_info: [proof(), proof(advertised)], gossip_edges: [receipt(),
    receipt(advertiser, advertised, { observed_at_ms: now - 3000 }),
    receipt(advertiser, advertised, { observed_at_ms: now - 1500 }), receipt(advertised, advertiser)] });
  const result = validateTopologySnapshots([{ source: 'direct', metrics }, { source: 'tor', metrics }], now);
  assert.equal(result.edges.length, 4);
  assert.equal(result.snapshots[0].edgeCount, 2);
  for (const source of ['direct', 'tor']) {
    const forward = result.edges.find(edge => edge.collectorSource === source && edge.advertiser === advertiser);
    assert.equal(forward.observedAtMs, now - 1500);
    assert.ok(result.edges.some(edge => edge.collectorSource === source && edge.advertiser === advertised && edge.advertised === advertiser));
  }
});

test('same collector duplicates merge by receipt time without borrowing another snapshot proof', () => {
  const newer = snapshot({ generated_at_ms: now - 500,
    gossip_edges: [receipt(advertiser, advertised, { observed_at_ms: now - 1000 })] });
  const result = validateTopologySnapshots([{ source: 'direct', metrics: newer }, { source: 'direct', metrics: snapshot() }], now);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].observedAtMs, now - 1000);
  assert.equal(result.edges[0].generatedAtMs, now - 500);
  assert.equal(result.edges[0].chainVerifiedAtMs, now - 5000);
});

test('malformed, nonliteral and nonpublic endpoints cannot enter graph evidence', () => {
  const invalid = ['8.8.8.8', '8.8.8.8:0', '8.8.8.8:65536', '8.8.8.8:-1', ' 8.8.8.8:8233',
    '8.8.8.8:8233 ', 'seed.example:8233', 'example.onion:8233', '[8.8.8.8]:8233', '1.1.1.1:8233/path',
    '0.0.0.0:8233', '10.0.0.1:8233', '100.64.0.1:8233', '127.0.0.1:8233', '169.254.1.1:8233',
    '172.16.0.1:8233', '192.168.1.1:8233', '192.0.2.1:8233', '198.51.100.1:8233', '203.0.113.1:8233',
    '198.18.0.1:8233', '224.0.0.1:8233', '255.255.255.255:8233', '[::]:8233', '[::1]:8233',
    '[fe80::1]:8233', '[fc00::1]:8233', '[ff02::1]:8233', '[2001:db8::1]:8233', '[::ffff:8.8.8.8]:8233',
    '[2001:4860::1%en0]:8233'];
  for (const endpoint of invalid) {
    assert.deepEqual(validate(snapshot({ gossip_edges: [receipt(advertiser, endpoint)] })).edges, [], `target ${endpoint}`);
    assert.deepEqual(validate(snapshot({ node_info: [proof(endpoint)], gossip_edges: [receipt(endpoint)] })).edges, [], `source ${endpoint}`);
  }
});

test('IPv6 and nondefault ports are allowed, but equivalent spellings cannot donate exact endpoint proof', () => {
  const source = '[2001:4860:4860::8888]:18233';
  const target = '[2606:4700:4700::1111]:16125';
  const result = validate(snapshot({ node_info: [proof(source)], gossip_edges: [receipt(source, target)] }));
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].advertiserIp, '2001:4860:4860::8888');
  assert.equal(result.edges[0].advertisedIp, '2606:4700:4700::1111');
  const alternative = '[2001:4860:4860:0:0:0:0:8888]:18233';
  assert.deepEqual(validate(snapshot({ node_info: [proof(source)], gossip_edges: [receipt(alternative, target)] })).edges, []);
});

test('an advertised target is an observation only and gains no active census membership or score', () => {
  const metrics = snapshot();
  const before = structuredClone(metrics);
  const result = validate(metrics);
  assert.equal(result.edges[0].advertisedIp, '1.1.1.1');
  assert.equal(mergeVerifiedNodes([metrics], now).length, 1);
  assert.equal(mergeVerifiedNodes([metrics], now)[0].addr, advertiser);
  assert.equal('nodes' in result, false);
  for (const field of ['degree', 'betweenness', 'closeness', 'healthScore']) assert.equal(field in result.edges[0], false);
  assert.deepEqual(metrics, before, 'validation cannot mutate collector data');
});

test('bounded producer snapshots preserve their explicit partial-graph marker', () => {
  const result = validate(snapshot({ gossip_truncated: true }));
  assert.equal(result.available, true);
  assert.equal(result.snapshots[0].truncated, true);
  assert.equal(result.edges.length, 1);
});
