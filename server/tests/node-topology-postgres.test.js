'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CHAIN_BLOCK_HASH, CHAIN_PROOF } = require('../lib/node-census');
const { GOSSIP_PROVENANCE, validateTopologySnapshots } = require('../lib/node-topology');
const { persistTopologySnapshot, readTopologySnapshot } = require('../lib/node-topology-store');

const enabled = Boolean(process.env.TEST_NODE_TOPOLOGY_DATABASE_URL) || process.env.NODE_TOPOLOGY_POSTGRES === '1';
const migrationName = '039_qualified_gossip_topology.sql';
const migration = fs.readFileSync(path.join(__dirname, '../deploy/sql', migrationName), 'utf8');
// Keep all DDL and test data inside the fixture transaction's final rollback.
const transactionalMigration = migration.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
const mirror = [process.env.TEST_NODE_TOPOLOGY_RUST_MIRROR,
  path.resolve(__dirname, '../../../cipherscan-rust/schema/migrations', migrationName),
  path.join(os.homedir(), 'code/cipherscan-rust/schema/migrations', migrationName),
].find(file => file && fs.existsSync(file));

async function withFixture(fn) {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.TEST_NODE_TOPOLOGY_DATABASE_URL,
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zcash_user') THEN CREATE ROLE zcash_user; END IF; END $$");
    await db.query(transactionalMigration);
    const now = Number((await db.query('SELECT floor(extract(epoch FROM NOW()) * 1000)::bigint AS now')).rows[0].now);
    await fn(db, now);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
}

const active = (ip, qualified = true) => ({ ip, census_crawl_qualified: qualified,
  client_impl: 'Zebra', is_tor: false, country_code: 'US' });
const activeRows = () => [active('1.1.1.1'), active('9.9.9.9', false)];
const proof = (now, addr = '1.1.1.1:8233') => ({ addr, last_verified_at_ms: now - 5000,
  chain_verified_at_ms: now - 4000, chain_block_hash: CHAIN_BLOCK_HASH, chain_proof: CHAIN_PROOF });
const receipt = (now, source = '1.1.1.1:8233', target = '8.8.8.8:8233') => ({ source, target, observed_at_ms: now - 2000 });
const metrics = (now, extra = {}) => ({ generated_at_ms: now - 1000, gossip_provenance: GOSSIP_PROVENANCE,
  gossip_truncated: false, gossip_edges: [receipt(now)], node_info: [proof(now)], ...extra });
const validated = (now, extra = {}) => validateTopologySnapshots([{ source: 'direct', metrics: metrics(now, extra) }], now);

function assertPrivate(graph) {
  const json = JSON.stringify(graph);
  for (const value of ['1.1.1.1', '8.8.8.8', '9.9.9.9', ':8233', CHAIN_BLOCK_HASH]) {
    assert.equal(json.includes(value), false, `public graph must not include ${value}`);
  }
  assert.doesNotMatch(json, /"(?:ip|addr|advertiser|advertised|advertiserIp|advertisedIp|chainProof|chainBlockHash)"\s*:/);
  for (const node of graph.nodes) {
    assert.equal(typeof node.id, 'number');
    assert.equal(node.betweenness, null);
    assert.equal(node.closeness, null);
  }
}

test('migration 039 matches the Rust schema mirror byte for byte', { skip: !enabled || !mirror }, () => {
  assert.equal(fs.readFileSync(mirror, 'utf8'), migration);
});

test('migration 039 is idempotent and enforces proof-clock ordering and cascading receipts', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await db.query(transactionalMigration);
    assert.equal(await persistTopologySnapshot(db, validated(now)), true);
    const owners = (await db.query(`SELECT tablename,tableowner FROM pg_tables
      WHERE schemaname='public' AND tablename IN ('topology_gossip_snapshots','topology_gossip_edges')`)).rows;
    assert.equal(owners.length, 2);
    assert.ok(owners.every(row => row.tableowner === 'zcash_user'));
    await db.query('SAVEPOINT invalid_clock');
    await assert.rejects(db.query(`UPDATE topology_gossip_edges
      SET advertiser_chain_verified_at=observed_at+interval '1 second'`), { code: '23514' });
    await db.query('ROLLBACK TO SAVEPOINT invalid_clock');
    await db.query('DELETE FROM topology_gossip_snapshots');
    assert.equal(Number((await db.query('SELECT count(*) AS count FROM topology_gossip_edges')).rows[0].count), 0);
  });
});

test('actual SQL preserves qualified advertisers, isolated peers and unqualified advertised targets without identity leaks', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await persistTopologySnapshot(db, validated(now));
    const graph = await readTopologySnapshot(db, activeRows(), now);
    assert.equal(graph.topologyAvailable, true);
    assert.equal(graph.topologyUnavailableReason, null);
    assert.equal(graph.gossipProvenance, GOSSIP_PROVENANCE);
    assert.equal(graph.directed, true);
    assert.equal(graph.edgeKind, 'advertised-address');
    assert.deepEqual(graph.counts, { total: 3, reachable: 2, off: 1, edges: 1 });
    assert.deepEqual(graph.edges, [{ source: 0, target: 2 }]);
    assert.equal(graph.nodes[1].reachable, true);
    assert.equal(graph.nodes[1].degree, 0, 'a peer-only IP is retained as an isolated active vertex');
    assert.equal(graph.nodes[2].reachable, false, 'gossip does not establish active census membership');
    assert.equal(graph.observedAt, new Date(now - 1000).toISOString());
    assertPrivate(graph);

    const inactive = await readTopologySnapshot(db, [active('9.9.9.9', false)], now);
    assert.deepEqual(inactive.counts, { total: 1, reachable: 1, off: 0, edges: 0 });
    const unqualified = await readTopologySnapshot(db, [active('1.1.1.1', false), active('9.9.9.9', false)], now);
    assert.equal(unqualified.edges.length, 0, 'current peer activity alone cannot certify the advertiser');
    assertPrivate(unqualified);
  });
});

test('actual SQL merges direct and Tor evidence by directed IP pair while preserving private receipt rows', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    const direct = metrics(now, { node_info: [proof(now), proof(now, '8.8.8.8:8233')] });
    const tor = metrics(now, { node_info: direct.node_info,
      gossip_edges: [receipt(now), receipt(now, '8.8.8.8:8233', '1.1.1.1:8233')] });
    const observations = validateTopologySnapshots([{ source: 'direct', metrics: direct }, { source: 'tor', metrics: tor }], now);
    await persistTopologySnapshot(db, observations);
    assert.equal(Number((await db.query('SELECT count(*) AS count FROM topology_gossip_edges')).rows[0].count), 3);
    const graph = await readTopologySnapshot(db, [active('1.1.1.1'), active('8.8.8.8'), active('9.9.9.9', false)], now);
    assert.deepEqual(graph.counts, { total: 3, reachable: 3, off: 0, edges: 2 });
    assert.deepEqual(new Set(graph.edges.map(edge => `${edge.source}:${edge.target}`)), new Set(['0:1', '1:0']));
    assert.equal(graph.nodes[2].degree, 0);
    assertPrivate(graph);
  });
});

test('SQL read-time gates reject corrupted identities, expired independent clocks and impossible ordering', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await persistTopologySnapshot(db, validated(now));
    const cases = [
      "UPDATE topology_gossip_edges SET chain_block_hash='wrong-hash'",
      "UPDATE topology_gossip_edges SET chain_proof='wrong-method'",
      "UPDATE topology_gossip_edges SET advertiser_handshake_at=NOW()-interval '2 hours'",
      `UPDATE topology_gossip_edges SET advertiser_handshake_at=NOW()-interval '2 hours',
        advertiser_chain_verified_at=NOW()-interval '61 minutes'`,
      `UPDATE topology_gossip_edges SET advertiser_handshake_at=NOW()-interval '13 minutes',
        advertiser_chain_verified_at=NOW()-interval '12 minutes', observed_at=NOW()-interval '11 minutes'`,
    ];
    for (const sql of cases) {
      await db.query('SAVEPOINT corrupt_receipt');
      await db.query(sql);
      const graph = await readTopologySnapshot(db, activeRows(), 0);
      assert.equal(graph.topologyAvailable, true, 'fresh supported metadata remains distinguishable from eligible receipts');
      assert.equal(graph.edges.length, 0, sql);
      assert.equal(graph.nodes.length, 2);
      await db.query('ROLLBACK TO SAVEPOINT corrupt_receipt');
    }
    const constraints = (await db.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='topology_gossip_edges'::regclass AND contype='c'`)).rows;
    assert.equal(constraints.length, 1);
    await db.query('SAVEPOINT impossible_receipt');
    await db.query(`ALTER TABLE topology_gossip_edges DROP CONSTRAINT "${constraints[0].conname}"`);
    for (const sql of [
      "UPDATE topology_gossip_edges SET observed_at=source_generated_at+interval '1 second'",
      "UPDATE topology_gossip_edges SET observed_at=source_generated_at, advertiser_chain_verified_at=source_generated_at+interval '1 second'",
      "UPDATE topology_gossip_edges SET advertiser_chain_verified_at=observed_at, advertiser_handshake_at=observed_at+interval '1 second'",
    ]) {
      await db.query(sql);
      assert.equal((await readTopologySnapshot(db, activeRows(), now)).edges.length, 0);
    }
    await db.query('ROLLBACK TO SAVEPOINT impossible_receipt');
    assert.equal((await readTopologySnapshot(db, activeRows(), now)).edges.length, 1);
  });
});

test('SQL freshness distinguishes unavailable snapshots, supported empty snapshots and absent schema', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await persistTopologySnapshot(db, validated(now, { node_info: [], gossip_edges: [] }));
    const empty = await readTopologySnapshot(db, activeRows(), now + 24 * 60 * 60 * 1000);
    assert.equal(empty.topologyAvailable, true, 'the database clock controls evidence freshness');
    assert.equal(empty.expiresAt, new Date(now - 1000 + 600000).toISOString());
    assert.equal(empty.nodes[0].degree, 0);
    assert.deepEqual(empty.counts, { total: 2, reachable: 2, off: 0, edges: 0 });
    for (const generated_at of ["NOW()-interval '11 minutes'", "NOW()+interval '1 second'"]) {
      await db.query(`UPDATE topology_gossip_snapshots SET generated_at=${generated_at}`);
      const unavailable = await readTopologySnapshot(db, activeRows(), 0);
      assert.equal(unavailable.topologyAvailable, false, generated_at);
      assert.equal(unavailable.nodes[0].degree, null);
    }
    await persistTopologySnapshot(db, validated(now, { gossip_provenance: 'unsupported' }));
    assert.equal((await readTopologySnapshot(db, activeRows(), now)).topologyAvailable, false);
    await db.query('ALTER TABLE topology_gossip_edges RENAME TO fixture_hidden_gossip_edges');
    assert.equal(await persistTopologySnapshot(db, validated(now)), false);
    const missing = await readTopologySnapshot(db, activeRows(), now);
    assert.equal(missing.topologyAvailable, false);
    assert.equal(missing.nodes[0].degree, null);
    assertPrivate(missing);
  });
});

test('delete-and-replay persistence preserves collector receipt times instead of advancing them to ingestion time', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    const observations = validated(now);
    const stored = () => db.query(`SELECT collector_source,source_generated_at,advertiser,advertised,
      advertiser_ip,advertised_ip,observed_at,advertiser_handshake_at,advertiser_chain_verified_at,
      chain_block_hash,chain_proof FROM topology_gossip_edges ORDER BY collector_source,advertiser,advertised`);
    await persistTopologySnapshot(db, observations);
    const first = (await stored()).rows;
    await persistTopologySnapshot(db, observations);
    assert.deepEqual((await stored()).rows, first);
    assert.equal(first[0].observed_at.getTime(), now - 2000);
    assert.equal(first[0].source_generated_at.getTime(), now - 1000);
    assert.equal(first[0].advertiser_handshake_at.getTime(), now - 5000);
    assert.equal(first[0].advertiser_chain_verified_at.getTime(), now - 4000);
    await persistTopologySnapshot(db, { available: false, snapshots: [], edges: [] });
    assert.equal(Number((await db.query('SELECT count(*) AS count FROM topology_gossip_edges')).rows[0].count), 0);
    assert.equal((await readTopologySnapshot(db, activeRows(), now)).topologyAvailable, false);
  });
});

test('producer capacity limits remain explicit after persistence and public reads', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await persistTopologySnapshot(db, validated(now, { gossip_truncated: true }));
    const partial = await readTopologySnapshot(db, activeRows(), now);
    assert.equal(partial.topologyAvailable, true);
    assert.equal(partial.truncated, true);
    await persistTopologySnapshot(db, validated(now));
    assert.equal((await readTopologySnapshot(db, activeRows(), now)).truncated, false);
  });
});

test('the crawl API route serves qualified fresh receipts without touching legacy Redis topology', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await db.query(fs.readFileSync(path.join(__dirname, 'fixtures/node-census.sql'), 'utf8'));
    await db.query(`INSERT INTO nodes (id,ip,client_impl,country_code,last_verified_at,last_chain_verified_at,
      chain_block_hash,chain_proof,last_peer_seen_at) VALUES
      (1,'1.1.1.1','Zebra','US',NOW()-interval '5 seconds',NOW()-interval '4 seconds',$1,$2,NULL),
      (2,'9.9.9.9','Zakura','JP',NULL,NULL,NULL,NULL,NOW()-interval '5 seconds')`, [CHAIN_BLOCK_HASH, CHAIN_PROOF]);
    await persistTopologySnapshot(db, validated(now));
    process.env.NODE_SOURCE = 'crawl';
    const router = require('../api/routes/network');
    const req = { app: { locals: { pool: db, redisClient: { isOpen: true,
      async get() { throw new Error('Legacy Redis topology must not be read'); } },
    } }, query: {}, headers: {} };
    router.stack[0].handle(req, {}, () => {});
    const headers = {}; let body; let status = 200;
    const res = { set(name, value) { headers[name] = value; return this; },
      status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    await router.stack.find(layer => layer.route?.path === '/api/network/topology').route.stack[0].handle(req, res);
    assert.equal(status, 200);
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(body.topologyAvailable, true);
    assert.deepEqual(body.counts, { total: 3, reachable: 2, off: 1, edges: 1 });
    assert.equal(body.gossipProvenance, GOSSIP_PROVENANCE);
    assert.equal(body.expiresAt, new Date(now - 2000 + 600000).toISOString());
    assertPrivate(body);
    assert.equal(Number((await db.query('SELECT count(*) AS count FROM nodes')).rows[0].count), 2,
      'reading advertisements cannot promote targets into the active census');
  });
});
