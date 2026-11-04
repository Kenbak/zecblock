'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCrawlSnapshot, mergeVerifiedNodes, livePeerNodes, censusTable, CHAIN_PROOF, CHAIN_BLOCK_HASH } = require('../lib/node-census');
const now = Date.parse('2026-09-29T00:00:00Z');
const snapshot = nodes => ({ generated_at_ms: now - 1000, node_info: nodes });
const peer = (addr, age = 2000) => ({ addr, last_verified_at_ms: now - age,
  chain_verified_at_ms: now - age + 500, chain_block_hash: CHAIN_BLOCK_HASH,
  chain_proof: CHAIN_PROOF, user_agent: '/Zebra:6.4.2/' });

test('rejects missing, stale and future crawler generation timestamps, including old-format snapshots', () => {
  for (const metrics of [null, { node_info: [] }, { ...snapshot([]), generated_at_ms: now - 181000 }, { ...snapshot([]), generated_at_ms: now + 31000 }]) {
    assert.throws(() => validateCrawlSnapshot(metrics, now), /timestamp/);
  }
  assert.equal(validateCrawlSnapshot(snapshot([]), now).node_info.length, 0, 'fresh zero-node result is valid');
});
test('counts only actual recent verifications and deduplicates ports and direct/Tor observations', () => {
  const direct = snapshot([peer('192.0.2.1:8233', 6000), peer('[2001:db8::1]:8233'), peer('192.0.2.2:8233', 3600001), { addr: '192.0.2.3:8233' }]);
  const tor = snapshot([peer('192.0.2.1:18233', 3000), peer('192.0.2.4:8233', 0)]);
  const nodes = mergeVerifiedNodes([direct, tor], now);
  assert.equal(nodes.length, 2);
  assert.equal(nodes.find(n => n.addr.startsWith('192.0.2.1')).last_verified_at_ms, now - 3000);
  assert.ok(nodes.some(n => n.addr === '[2001:db8::1]:8233'));
});
test('reingesting the same snapshot preserves observation timestamps', () => {
  const input = snapshot([peer('192.0.2.1:8233')]);
  assert.equal(mergeVerifiedNodes([input], now + 60000)[0].last_verified_at_ms, now - 2000);
  assert.throws(() => mergeVerifiedNodes([input], now + 200000), /timestamp/);
});
test('read-time census eligibility excludes legacy/expired observations without needing another writer run', () => {
  assert.match(censusTable('crawl'), /last_verified_at > NOW\(\) - INTERVAL '1 hour'/);
  assert.match(censusTable('crawl'), /last_peer_seen_at/);
  assert.match(censusTable('crawl'), /last_chain_verified_at/);
  assert.match(censusTable('crawl'), /zcash-mainnet-checkpoint-v1/);
  assert.match(censusTable('crawl'), new RegExp(CHAIN_BLOCK_HASH));
  assert.doesNotMatch(censusTable('peer'), /last_verified_at/);
});
test('shared-magic Flux handshakes cannot qualify, while proof-qualified nondefault ports and unknown clients can', () => {
  const flux = { addr: '192.0.2.9:16125', user_agent: '/MagicBean:9.1.0/',
    last_verified_at_ms: now - 2000, start_height: 3049216 };
  const legitimate = { ...peer('192.0.2.8:16125'), user_agent: '/MagicBean:9.1.0/' };
  const unidentified = { ...peer('[2001:db8::8]:18233'), user_agent: null };
  assert.deepEqual(mergeVerifiedNodes([snapshot([flux, legitimate, unidentified])], now), [legitimate, unidentified]);
});
test('proof identity and its own clock must be present, fresh, nonfuture and at or after the handshake', () => {
  const good = peer('192.0.2.1:8233');
  const invalid = [
    null, 'invalid node',
    { ...good, chain_proof: null }, { ...good, chain_proof: 'other-chain-v1' },
    { ...good, chain_block_hash: '0'.repeat(64) },
    { ...good, chain_block_hash: '0007bc227e1c57a4a70e237cad00e7b7ce565155ab49166bc57397a26d339283' },
    { ...good, chain_verified_at_ms: undefined },
    { ...good, chain_verified_at_ms: now - 3_600_001 },
    { ...good, chain_verified_at_ms: now - 2500 },
    { ...good, chain_verified_at_ms: now + 1 },
    { ...good, chain_verified_at_ms: now - 999 }, // later than snapshot
    { ...good, last_verified_at_ms: now - 3_600_001 },
  ];
  assert.equal(mergeVerifiedNodes([snapshot(invalid)], now).length, 0);
  assert.equal(mergeVerifiedNodes([{ generated_at_ms: now + 1000, node_info: [{ ...good, chain_verified_at_ms: now + 1 }] }], now).length, 0);
});
const { checkHealth } = require('../jobs/check-crawler-health');
test('watchdog distinguishes bootstrap, healthy progress, frozen snapshots and a stalled scheduler', () => {
  assert.doesNotThrow(() => checkHealth({ ...snapshot([]), crawler_runtime: { secs: 30 } }, now));
  assert.doesNotThrow(() => checkHealth({ ...snapshot([peer('192.0.2.1:8233')]), crawler_runtime: { secs: 5000 } }, now));
  assert.throws(() => checkHealth({ ...snapshot([]), crawler_runtime: { secs: 5000 } }, now), /fifteen minutes/);
  assert.throws(() => checkHealth({ ...snapshot([]), generated_at_ms: now - 200000 }, now), /timestamp/);
  const legacy = { ...peer('192.0.2.2:8233'), chain_proof: null };
  assert.throws(() => checkHealth({ ...snapshot([legacy]), crawler_runtime: { secs: 5000 } }, now), /chain verification/);
});

test('live peers require established protocol identities, deduplicate ports, and keep a distinct observation clock', () => {
  const peers = livePeerNodes([
    { addr: '192.0.2.10:43210', version: 170160, subver: '/Zakura:1.5.0/', inbound: true },
    { addr: '192.0.2.10:8233', version: 170160 },
    { addr: '[2001:db8::1]:8233', version: 170160 },
    { addr: '192.0.2.11:8233', version: 0 },
    { addr: 'seed.example:8233', version: 170160 },
  ], now);
  assert.equal(peers.length, 2);
  assert.equal(peers[0].last_peer_seen_at_ms, now);
  assert.equal(peers[0].last_verified_at_ms, undefined);
  assert.equal(peers[0].inbound, true);
  assert.equal(peers[0].handshake_time_ms, null);
  assert.throws(() => livePeerNodes(null), /Invalid live peer/);
});

test('Zebend peers with zero service flags remain observable without bypassing crawler chain proof', () => {
  const peers = livePeerNodes([
    { addr: '192.0.2.20:42000', version: 170160, subver: '/Zebend-mempool:0.1/', services: 0, inbound: true },
  ], now);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].services, 0);
  assert.equal(peers[0].user_agent, '/Zebend-mempool:0.1/');
  const qualified = { ...peer('192.0.2.20:8233'), user_agent: peers[0].user_agent, services: 0 };
  const handshakeOnly = { ...qualified, chain_proof: null };
  assert.equal(mergeVerifiedNodes([snapshot([handshakeOnly])], now).length, 0);
  assert.deepEqual(mergeVerifiedNodes([snapshot([qualified])], now), [qualified]);
});
