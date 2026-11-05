'use strict';

// Real PostgreSQL coverage for migration 043 and multi-vantage census ingest.
// Every statement runs inside one transaction that is rolled back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CHAIN_BLOCK_HASH, CHAIN_PROOF } = require('../lib/node-census');
const { GOSSIP_PROVENANCE, validateTopologySnapshots } = require('../lib/node-topology');
const { persistTopologySnapshot, readTopologySnapshot } = require('../lib/node-topology-store');
const { persistVantageStatus, parseVantages } = require('../lib/census-vantages');

const enabled = Boolean(process.env.TEST_NODE_TOPOLOGY_DATABASE_URL) || process.env.NODE_TOPOLOGY_POSTGRES === '1';
const sqlDir = path.join(__dirname, '../deploy/sql');
const strip = sql => sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
const migration039 = strip(fs.readFileSync(path.join(sqlDir, '039_qualified_gossip_topology.sql'), 'utf8'));
const name043 = '043_regional_census_vantages.sql';
const raw043 = fs.readFileSync(path.join(sqlDir, name043), 'utf8');
const migration043 = strip(raw043);
const mirror = [process.env.TEST_CENSUS_VANTAGES_RUST_MIRROR,
  path.resolve(__dirname, '../../../cipherscan-rust/schema/migrations', name043),
  path.join(os.homedir(), 'code/cipherscan-rust/schema/migrations', name043),
].find(file => file && fs.existsSync(file));

async function withFixture(fn, { apply043 = true } = {}) {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.TEST_NODE_TOPOLOGY_DATABASE_URL,
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zcash_user') THEN CREATE ROLE zcash_user; END IF; END $$");
    await db.query(migration039);
    if (apply043) await db.query(migration043);
    const now = Number((await db.query('SELECT floor(extract(epoch FROM NOW()) * 1000)::bigint AS now')).rows[0].now);
    await fn(db, now);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
}

const proof = (now, addr, ageMs = 4000) => ({ addr, last_verified_at_ms: now - ageMs - 1000,
  chain_verified_at_ms: now - ageMs, chain_block_hash: CHAIN_BLOCK_HASH, chain_proof: CHAIN_PROOF });
const receipt = (now, source, target) => ({ source, target, observed_at_ms: now - 2000 });
const metrics = (now, nodeInfo, edges) => ({ generated_at_ms: now - 1000, gossip_provenance: GOSSIP_PROVENANCE,
  gossip_truncated: false, node_info: nodeInfo, gossip_edges: edges });
const active = ip => ({ ip, census_crawl_qualified: true, client_impl: 'Zebra', is_tor: false, country_code: 'US' });
const count = async (db, sql) => Number((await db.query(sql)).rows[0].count);

test('migration 043 matches the Rust schema mirror byte for byte', { skip: !enabled || !mirror }, () => {
  assert.equal(fs.readFileSync(mirror, 'utf8'), raw043);
});

test('migration 043 widens collector sources, keeps existing rows and is idempotent', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await persistTopologySnapshot(db, validateTopologySnapshots([{ source: 'direct',
      metrics: metrics(now, [proof(now, '1.1.1.1:8233')], [receipt(now, '1.1.1.1:8233', '8.8.8.8:8233')]) }], now));
    await db.query('SAVEPOINT before_regional');
    await assert.rejects(db.query(`INSERT INTO topology_gossip_snapshots VALUES ('direct-nyc3', NOW(), $1, 0, false)`,
      [GOSSIP_PROVENANCE]), { code: '23514' }, 'migration 039 alone rejects regional sources');
    await db.query('ROLLBACK TO SAVEPOINT before_regional');

    await db.query(migration043);
    await db.query(migration043);
    assert.equal(await count(db, 'SELECT count(*) AS count FROM topology_gossip_edges'), 1, 'existing receipts survive');
    const checks = (await db.query(`SELECT conname FROM pg_constraint
      WHERE conrelid='topology_gossip_snapshots'::regclass AND contype='c' ORDER BY conname`)).rows.map(row => row.conname);
    assert.ok(checks.includes('topology_gossip_snapshots_collector_source_vantage'));
    assert.ok(!checks.includes('topology_gossip_snapshots_collector_source_check'), 'the inline 039 check is replaced');
    for (const source of ['direct', 'tor', 'direct-nyc3', 'direct-sgp1', 'direct-syd1']) {
      await db.query('SAVEPOINT accepted');
      await db.query('DELETE FROM topology_gossip_snapshots WHERE collector_source=$1', [source]);
      await db.query('INSERT INTO topology_gossip_snapshots VALUES ($1, NOW(), $2, 0, false)', [source, GOSSIP_PROVENANCE]);
      await db.query('INSERT INTO census_vantage_status (collector_source, attempted_at, outcome) VALUES ($1, NOW(), $2)', [source, 'unreachable']);
      await db.query('ROLLBACK TO SAVEPOINT accepted');
    }
    for (const source of ['tor-nyc3', 'direct-', 'direct-NYC3', 'nyc3', "direct-nyc3'; --"]) {
      for (const sql of [`INSERT INTO topology_gossip_snapshots VALUES ($1, NOW(), '${GOSSIP_PROVENANCE}', 0, false)`,
        "INSERT INTO census_vantage_status (collector_source, attempted_at, outcome) VALUES ($1, NOW(), 'unreachable')"]) {
        await db.query('SAVEPOINT rejected');
        await assert.rejects(db.query(sql, [source]), { code: '23514' }, source);
        await db.query('ROLLBACK TO SAVEPOINT rejected');
      }
    }
    await db.query('SAVEPOINT incomplete');
    await assert.rejects(db.query(`INSERT INTO census_vantage_status (collector_source, attempted_at, outcome)
      VALUES ('direct', NOW(), 'admitted')`), { code: '23514' }, 'an admitted row must carry its snapshot facts');
    await db.query('ROLLBACK TO SAVEPOINT incomplete');
    const owner = (await db.query("SELECT tableowner FROM pg_tables WHERE tablename='census_vantage_status'")).rows[0];
    assert.equal(owner.tableowner, 'zcash_user');
    const publicGrants = await count(db, `SELECT count(*) AS count FROM information_schema.role_table_grants
      WHERE table_name='census_vantage_status' AND grantee='PUBLIC'`);
    assert.equal(publicGrants, 0);
  }, { apply043: false });
});

test('regional receipts are private per vantage while public links and vertices deduplicate by IP', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    const a = '1.1.1.1:8233';
    const aOtherPort = '1.1.1.1:18233';
    const b = '2.2.2.2:8233';
    const direct = metrics(now, [proof(now, a)], [receipt(now, a, '8.8.8.8:8233')]);
    const nyc3 = metrics(now, [proof(now, aOtherPort), proof(now, b)],
      [receipt(now, aOtherPort, '8.8.8.8:8233'), receipt(now, b, '1.1.1.1:8233')]);
    const sgp1 = metrics(now, [proof(now, b)], [receipt(now, b, '1.1.1.1:8233'), receipt(now, b, '8.8.8.8:8233')]);
    const configuredSources = ['direct', 'tor', 'direct-nyc3', 'direct-sgp1', 'direct-syd1'];
    await persistTopologySnapshot(db, validateTopologySnapshots([{ source: 'direct', metrics: direct },
      { source: 'direct-nyc3', metrics: nyc3 }, { source: 'direct-sgp1', metrics: sgp1 }], now), { configuredSources });
    assert.equal(await count(db, 'SELECT count(*) AS count FROM topology_gossip_edges'), 5);
    const graph = await readTopologySnapshot(db, [active('1.1.1.1'), active('2.2.2.2')], now);
    assert.equal(graph.topologyAvailable, true);
    assert.deepEqual(graph.counts, { total: 3, reachable: 2, off: 1, edges: 3 },
      'A→X seen by two vantages and B→A seen by two vantages each count once');
    assert.deepEqual(new Set(graph.edges.map(edge => `${edge.source}>${edge.target}`)), new Set(['0>2', '1>0', '1>2']));
    assert.equal(JSON.stringify(graph).includes('direct-nyc3'), false, 'vantage names are private');

    // nyc3 is unreachable next run: its evidence stays until expiry; sgp1 is
    // removed from configuration and is pruned at once.
    await persistTopologySnapshot(db, validateTopologySnapshots([{ source: 'direct', metrics: direct }], now),
      { configuredSources: ['direct', 'tor', 'direct-nyc3'] });
    assert.deepEqual((await db.query('SELECT collector_source FROM topology_gossip_snapshots ORDER BY 1')).rows
      .map(row => row.collector_source), ['direct', 'direct-nyc3']);
    assert.equal((await readTopologySnapshot(db, [active('1.1.1.1'), active('2.2.2.2')], now)).counts.edges, 2);
  });
});

test('vantage status keeps the last admitted snapshot facts across failed polls', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    const configured = ['direct', 'tor', 'direct-nyc3'];
    await persistVantageStatus(db, [{ source: 'direct-nyc3', attemptedAtMs: now - 300000, outcome: 'admitted',
      generatedAtMs: now - 301000, verifiedEndpoints: 41, gossipSupported: true, gossipReceipts: 900 }], configured);
    await persistVantageStatus(db, [{ source: 'direct-nyc3', attemptedAtMs: now, outcome: 'unreachable' },
      { source: 'direct-sgp1', attemptedAtMs: now, outcome: 'rejected' }], configured);
    const rows = (await db.query('SELECT * FROM census_vantage_status ORDER BY collector_source')).rows;
    assert.deepEqual(rows.map(row => [row.collector_source, row.outcome]), [['direct-nyc3', 'unreachable'], ['direct-sgp1', 'rejected']]);
    assert.equal(rows[0].attempted_at.getTime(), now);
    assert.equal(rows[0].admitted_at.getTime(), now - 300000);
    assert.equal(rows[0].generated_at.getTime(), now - 301000);
    assert.equal(rows[0].verified_endpoints, 41);
    assert.equal(rows[0].gossip_receipts, 900);
    assert.equal(rows[1].admitted_at, null);
    await persistVantageStatus(db, [], ['direct']);
    assert.equal(await count(db, 'SELECT count(*) AS count FROM census_vantage_status'), 0, 'unconfigured sources are removed');
  });
});

test('ingestion merges regional vantages into one IP census with primary-only latency', { skip: !enabled }, async () => {
  process.env.NODE_SOURCE = 'crawl';
  await withFixture(async db => {
    await db.query(fs.readFileSync(path.join(__dirname, 'fixtures/node-census.sql'), 'utf8'));
    await db.query('CREATE UNIQUE INDEX ON nodes(ip)');
    await db.query('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_verified_at timestamptz');
    await db.query('ALTER TABLE node_snapshots ADD COLUMN IF NOT EXISTS census_version smallint NOT NULL DEFAULT 0');
    await db.query('ALTER TABLE nodes ALTER COLUMN id DROP DEFAULT');
    await db.query('ALTER TABLE node_snapshots ALTER COLUMN id DROP DEFAULT');
    await db.query('ALTER TABLE nodes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 100)');
    await db.query('ALTER TABLE node_snapshots ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 100)');
    const writer = { release() {}, async query(sql, params) {
      if (sql === 'BEGIN') return db.query('SAVEPOINT ingest_fixture');
      if (sql === 'COMMIT') return db.query('RELEASE SAVEPOINT ingest_fixture');
      if (sql === 'ROLLBACK') return db.query('ROLLBACK TO SAVEPOINT ingest_fixture');
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
      return db.query(sql, params);
    } };
    const at = Date.now();
    const node = (addr, ageMs, handshake) => ({ ...proof(at, addr, ageMs), user_agent: '/Zebra:6.4.2/', handshake_time_ms: handshake });
    const snapshot = nodes => ({ generated_at_ms: at - 1000, num_good_nodes: nodes.length, node_info: nodes,
      gossip_provenance: GOSSIP_PROVENANCE, gossip_truncated: false,
      gossip_edges: [receipt(at, nodes[0].addr, '8.8.8.8:8233')] });
    let nycUp = true;
    const rpc = async (method, port, host) => {
      if (!host) {
        if (port) throw new Error('tor offline');
        return snapshot([node('1.1.1.1:8233', 9000, 25), node('2.2.2.2:8233', 9000, 30)]);
      }
      if (host === '10.77.0.2' && nycUp) return snapshot([node('1.1.1.1:8233', 3000, 180), node('3.3.3.3:8233', 3000, 210)]);
      throw new Error('unreachable');
    };
    const { ingestCrawl } = require('../jobs/ingest-crawl');
    const options = { rpc, peerRpc: async () => [], now: () => at, torExits: async () => new Set(),
      vantages: parseVantages('nyc3=10.77.0.2:54321,sgp1=10.77.0.3:54321').vantages,
      crunch: async input => ({ nodes: input.node_info.map(n => ({ ...n, geo: {} })) }),
      dbPool: { connect: async () => writer }, classificationPublisher: async () => true };
    await ingestCrawl(options);
    const nodes = (await db.query('SELECT ip, ping_ms, last_chain_verified_at FROM nodes WHERE is_active ORDER BY ip')).rows;
    assert.deepEqual(nodes.map(row => [row.ip, row.ping_ms]), [['1.1.1.1', 25], ['2.2.2.2', 30], ['3.3.3.3', null]],
      'one row per IP; latency stays a primary measurement');
    assert.equal(nodes[0].last_chain_verified_at.getTime(), at - 3000, 'the freshest proof from any vantage wins');
    assert.equal((await db.query('SELECT active_nodes FROM node_snapshots ORDER BY id DESC LIMIT 1')).rows[0].active_nodes, 3);
    const status = Object.fromEntries((await db.query('SELECT collector_source, outcome, verified_endpoints FROM census_vantage_status')).rows
      .map(row => [row.collector_source, [row.outcome, row.verified_endpoints]]));
    assert.deepEqual(status, { direct: ['admitted', 2], tor: ['unreachable', null],
      'direct-nyc3': ['admitted', 2], 'direct-sgp1': ['unreachable', null] });
    assert.deepEqual((await db.query('SELECT collector_source FROM topology_gossip_snapshots ORDER BY 1')).rows
      .map(row => row.collector_source), ['direct', 'direct-nyc3']);

    nycUp = false;
    await ingestCrawl(options);
    assert.equal(await count(db, 'SELECT count(*) AS count FROM nodes WHERE is_active'), 3,
      'a vantage outage does not erase IPs whose own proof is still within the hour');
    const nyc = (await db.query("SELECT outcome, admitted_at FROM census_vantage_status WHERE collector_source='direct-nyc3'")).rows[0];
    assert.equal(nyc.outcome, 'unreachable');
    assert.equal(nyc.admitted_at.getTime(), at);
  });
});
