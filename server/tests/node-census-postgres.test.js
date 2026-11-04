'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { CHAIN_PROOF, CHAIN_BLOCK_HASH, CENSUS_VERSION } = require('../lib/node-census');

test('all census routes exclude legacy/stale rows and incompatible history against PostgreSQL', {
  skip: !process.env.TEST_NODE_CENSUS_DATABASE_URL && process.env.NODE_CENSUS_POSTGRES !== '1',
}, async () => {
  process.env.NODE_SOURCE = 'crawl';
  const db = new Client({ connectionString: process.env.TEST_NODE_CENSUS_DATABASE_URL, host: process.env.DB_HOST, port: process.env.DB_PORT,
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/node-census.sql'), 'utf8'));
    await db.query('CREATE UNIQUE INDEX ON nodes(ip)');
    await db.query('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_verified_at timestamptz');
    await db.query('ALTER TABLE node_snapshots ADD COLUMN IF NOT EXISTS census_version smallint NOT NULL DEFAULT 0');
    await db.query(`INSERT INTO nodes (id, ip, observed_via, is_active, last_seen, last_verified_at,
      client_impl, client_version, protocol_version, country, country_code, lat, lon, degree, services, crawl_seen_count)
      VALUES (1,'192.0.2.1','crawl',true,now(),now()-interval '2 minutes','Zebra','6.4.2',170160,'Japan','JP',35,139,8,1,3),
      (2,'192.0.2.2','crawl',true,now(),now()-interval '2 hours','Zakura','1.5.0',170160,'Japan','JP',35,139,8,1,3),
      (3,'192.0.2.3','peer',true,now(),NULL,'Zakura','1.5.0',170160,'Japan','JP',35,139,8,1,3),
      (4,'192.0.2.4','dns',true,now(),NULL,'Unknown',NULL,NULL,'Japan','JP',35,139,0,NULL,0),
      (5,'192.0.2.9','crawl',true,now(),now()-interval '1 minute','zcashd','9.1.0',170160,'Finland','FI',60,25,999,1,999)`);
    await db.query('UPDATE nodes SET last_chain_verified_at=last_verified_at, chain_block_hash=$1,chain_proof=$2 WHERE id IN(1,2)', [CHAIN_BLOCK_HASH, CHAIN_PROOF]);
    await db.query("UPDATE nodes SET port=16125, ping_ms=999 WHERE id=5");
    await db.query(`INSERT INTO node_snapshots(id,snapshot_time,active_nodes,total_nodes,census_version)
      VALUES (1,now()-interval '2 minutes',644,2069,0),(2,now()-interval '1 minute',1,5,3),
      (9,now()-interval '30 seconds',2070,2070,2)`);
    await db.query(`INSERT INTO topology_nodes(addr,ip,reachable) VALUES
      ('192.0.2.1:8233','192.0.2.1',true),('192.0.2.2:8233','192.0.2.2',true)`);
    const router = require('../api/routes/network');
    const { createListCache } = require('../api/list-cache');
    const cacheCalls = [];
    const uncached = createListCache({ enabled: false });
    const redisKeys = [];
    const req = { app: { locals: { pool: db,
      listCache: { getOrLoad(options) { cacheCalls.push(options.params); return uncached.getOrLoad(options); } },
      redisClient: { isOpen: true,
        async get(key) { redisKeys.push(key); return key.endsWith('census-v2') ? JSON.stringify({ success: true, nodes: [{ reachable: true }], counts: { reachable: 2070 } }) : null; },
        async setEx() {} },
    } }, query: {}, headers: {} };
    router.stack[0].handle(req, {}, () => {});
    const responses = {};
    for (const path of ['/api/network/nodes', '/api/network/nodes/stats', '/api/network/nodes/list',
      '/api/network/node-history', '/api/network/topology', '/api/network/nodes/health-score',
      '/api/network/nodes/reliability', '/api/network/nodes/upgrade-readiness', '/api/network/nodes/concentration']) {
      let status = 200;
      const res = { set() { return this; }, setHeader() {}, status(code) { status = code; return this; }, json(body) { responses[path] = body; } };
      const route = router.stack.find(layer => layer.route?.path === path);
      await route.route.stack[0].handle(req, res);
      assert.equal(status, 200, path);
    }
    assert.equal(responses['/api/network/nodes/stats'].stats.activeNodes, 1);
    assert.equal(responses['/api/network/nodes/stats'].stats.chainQualifiedCrawlerNodes, 1);
    assert.equal(responses['/api/network/nodes/stats'].stats.localPeerNodes, 0);
    assert.equal(responses['/api/network/nodes/stats'].stats.totalNodes, 5);
    assert.equal(responses['/api/network/nodes/stats'].stats.torNodes, null, 'missing classification status is unavailable, not zero');
    assert.equal(responses['/api/network/nodes/stats'].stats.torClassificationAvailable, false);
    assert.equal(responses['/api/network/nodes/stats'].clients.observedNodes, 1);
    assert.deepEqual(responses['/api/network/nodes/stats'].trends,
      { change24h: null, change7d: null, change30d: null },
      'minutes of repaired history cannot stand in for day/week/month baselines');
    assert.equal(responses['/api/network/nodes/list'].total, 1);
    assert.equal(responses['/api/network/node-history'].snapshots.length, 1);
    assert.equal(responses['/api/network/topology'].nodes.filter(n => n.reachable).length, 1);
    assert.equal(responses['/api/network/topology'].nodes.length, 1, 'unqualified legacy topology never survives as off nodes');
    assert.equal(responses['/api/network/topology'].topologyAvailable, false);
    assert.equal(responses['/api/network/nodes/health-score'].healthScore, null, 'unproven graph cannot produce a composite health score');
    assert.ok(cacheCalls.length >= 2 && cacheCalls.every(p => p.censusVersion === 3), 'new map/stats cache identities exclude old payloads');
    assert.equal(redisKeys.some(key => key.startsWith('zcash:network_topology:')), false, 'crawl topology bypasses caches so receipts expire at read time');
    assert.equal(responses['/api/network/nodes/upgrade-readiness'].totalActive, 1);
    await db.query(`INSERT INTO node_snapshots(id,snapshot_time,active_nodes,total_nodes,census_version)
      VALUES (3,now()-interval '24 hours 5 minutes',2,5,3),
      (4,now()-interval '7 days 5 minutes',4,5,3),
      (5,now()-interval '30 days 2 hours',4,5,3),
      (6,now()-interval '24 hours 1 minute',9999,9999,2)`);
    const baselineRes = { set() {}, setHeader() {}, json(body) { responses.baselines=body; }, status() { return this; } };
    await router.stack.find(l=>l.route?.path==='/api/network/nodes/stats').route.stack[0].handle(req,baselineRes);
    assert.deepEqual(responses.baselines.trends, { change24h: -50, change7d: -75, change30d: null },
      'use comparable baselines near the requested age and reject stale baselines');
    await db.query(`INSERT INTO nodes(id,ip,last_verified_at,last_chain_verified_at,chain_block_hash,chain_proof) VALUES
      (10,'192.0.2.10',now()-interval '1 minute',now()-interval '30 seconds',$1,'wrong-method'),
      (11,'192.0.2.11',now()-interval '1 minute',now()-interval '30 seconds','wrong-hash',$2),
      (12,'192.0.2.12',now()-interval '1 minute',now()+interval '1 minute',$1,$2),
      (13,'192.0.2.13',now()-interval '1 minute',now()-interval '2 minutes',$1,$2),
      (14,'192.0.2.14',now()-interval '2 hours',now()-interval '2 hours',$1,$2),
      (15,'192.0.2.15',now()-interval '2 hours',now()-interval '1 minute',$1,$2)`, [CHAIN_BLOCK_HASH, CHAIN_PROOF]);
    await router.stack.find(l=>l.route?.path==='/api/network/nodes/stats').route.stack[0].handle(req,baselineRes);
    assert.equal(responses.baselines.stats.activeNodes, 1, 'SQL read-time proof validation excludes wrong identities and invalid independent clocks');
    assert.equal(new Date(responses.baselines.stats.lastUpdated).getTime(), (await db.query('SELECT last_chain_verified_at FROM nodes WHERE id=1')).rows[0].last_chain_verified_at.getTime(), 'unqualified handshakes cannot advance lastUpdated');
    await db.query("UPDATE nodes SET last_verified_at=now()-interval '2 hours' WHERE id=1");
    const res = { set() {}, setHeader() {}, json(body) { responses.expired=body; }, status() { return this; } };
    await router.stack.find(l=>l.route?.path==='/api/network/nodes/stats').route.stack[0].handle(req,res);
    assert.equal(responses.expired.stats.activeNodes, 0, 'expiry works with is_active still true and no ingester run');
    const emptyRes = { set() {}, setHeader() {}, json(body) { responses.empty = body; }, status() { return this; } };
    await router.stack.find(l=>l.route?.path==='/api/network/nodes/health-score').route.stack[0].handle(req,emptyRes);
    assert.equal(responses.empty.totalActive, 0);
    assert.equal(responses.empty.components.reliability.score, null, 'no qualified observations is unavailable, not a synthetic score');
    await router.stack.find(l=>l.route?.path==='/api/network/nodes/upgrade-readiness').route.stack[0].handle(req,emptyRes);
    assert.equal(responses.empty.totalActive, 0);
    assert.equal(responses.empty.readinessPct, null);
    await db.query(`UPDATE nodes SET last_chain_verified_at=NULL,chain_block_hash=NULL,chain_proof=NULL,
      crawl_seen_count=999,crawl_miss_count=999,last_seen=now(),client_impl='zcashd',user_agent='/MagicBean:9.1.0/' WHERE id=1`);
    // Run the real writer against the same temporary tables and deterministic RPCs.
    // All transaction statements stay within the fixture's outer rollback.
    let fixtureCommitted = false;
    const classifications = [];
    const writerClient = {
      async query(sql, params) {
        if (sql === 'BEGIN') { fixtureCommitted = false; return db.query('SAVEPOINT ingest_fixture'); }
        if (sql === 'COMMIT') { const result = await db.query('RELEASE SAVEPOINT ingest_fixture'); fixtureCommitted = true; return result; }
        if (sql === 'ROLLBACK') return db.query('ROLLBACK TO SAVEPOINT ingest_fixture');
        // Simulate refresh-turnstile holding its lock during the same cron tick.
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: params[0] !== 839271 }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
        return db.query(sql, params);
      }, release() {},
    };
    // LIKE copies serial defaults; remove them so fixture INSERTs cannot advance
    // production sequences. Temporary identity sequences are created instead.
    await db.query('ALTER TABLE node_snapshots ALTER COLUMN id DROP DEFAULT');
    await db.query('ALTER TABLE node_snapshots ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 100)');
    await db.query('ALTER TABLE nodes ALTER COLUMN id DROP DEFAULT');
    await db.query('ALTER TABLE nodes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 100)');
    const verifiedAt = Date.now() - 5000;
    const proofAt = verifiedAt + 500;
    const metrics = { generated_at_ms: Date.now(), num_good_nodes: 1, num_known_nodes: 1,
      all_node_addrs: ['192.0.2.9:16125'], all_nodes_indices: [[0]], all_node_reachable: [true],
      node_info: [{ addr: '192.0.2.1:16125', last_verified_at_ms: verifiedAt,
        chain_verified_at_ms: proofAt, chain_block_hash: CHAIN_BLOCK_HASH, chain_proof: CHAIN_PROOF,
        user_agent: '/Zebra:6.4.2/', handshake_time_ms: 25 }] };
    const { ingestCrawl } = require('../jobs/ingest-crawl');
    const options = { rpc: async () => metrics, peerRpc: async () => [],
      crunch: async input => {
        assert.deepEqual(input.all_node_addrs, [], 'unqualified full gossip graph is quarantined before crunching');
        assert.deepEqual(input.all_nodes_indices, []);
        assert.deepEqual(input.all_node_reachable, []);
        return { nodes: input.node_info.map(n => ({ ...n, geo: {} })) };
      },
      torExits: async () => new Set(), dbPool: { connect: async () => writerClient },
      classificationPublisher: async status => { assert.equal(fixtureCommitted, true, 'publication follows the DB commit'); classifications.push(status); return true; } };
    await ingestCrawl(options);
    const firstWrite = (await db.query('SELECT last_verified_at, last_seen, crawl_seen_count FROM nodes WHERE id=1')).rows[0];
    assert.equal(firstWrite.last_seen.getTime(), proofAt);
    assert.equal(firstWrite.last_verified_at.getTime(), verifiedAt);
    assert.equal(firstWrite.crawl_seen_count, 1, 'first qualified proof starts new reliability samples');
    assert.equal(classifications.at(-1).available, false);
    assert.equal(classifications.at(-1).classifiedTorNodes, null);
    assert.equal((await db.query('SELECT client_impl,port FROM nodes WHERE id=1')).rows[0].client_impl, 'Zebra', 'legacy unqualified observation time cannot preserve a foreign client identity');
    await ingestCrawl(options);
    const secondWrite = (await db.query('SELECT last_verified_at, last_seen, crawl_seen_count FROM nodes WHERE id=1')).rows[0];
    assert.deepEqual(secondWrite, firstWrite, 'replaying a snapshot must not refresh time or add successes');
    const older = { ...metrics, node_info: [{ ...metrics.node_info[0], last_verified_at_ms: verifiedAt - 1000, chain_verified_at_ms: proofAt - 1000 }] };
    await ingestCrawl({ ...options, rpc: async () => older });
    const afterOlder = (await db.query('SELECT last_verified_at, last_seen, crawl_seen_count FROM nodes WHERE id=1')).rows[0];
    assert.deepEqual(afterOlder, firstWrite, 'a lagging path cannot replace a newer verification already stored');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM nodes WHERE is_active')).rows[0].count, 1);
    assert.equal((await db.query('SELECT census_version FROM node_snapshots ORDER BY id DESC LIMIT 1')).rows[0].census_version, CENSUS_VERSION);
    await assert.rejects(ingestCrawl({ ...options, peerRpc: async () => { throw new Error('offline'); }, rpc: async () => ({ ...metrics, generated_at_ms: Date.now()-200000 }) }), /All node observation/);

    // Combined ingestion counts real connected peers without turning discovery
    // into evidence, refreshing crawler timestamps, or manufacturing graph links.
    const peerAt = proofAt + 1000;
    const combinedOptions = { ...options, now: () => peerAt,
      peerRpc: async () => [
        { addr: '192.0.2.1:40000', version: 170160, subver: '/Zebra:6.4.2/', inbound: true },
        { addr: '192.0.2.5:40001', version: 170160, subver: '/Zakura:1.5.0/', inbound: true },
        { addr: '192.0.2.5:8233', version: 170160, subver: '/Zakura:1.5.0/' },
        { addr: '[2001:db8::5]:8233', version: 170160, subver: '/Zebra:6.4.2/' },
        { addr: '192.0.2.6:8233', version: 0 },
      ] };
    await ingestCrawl(combinedOptions);
    const rows = (await db.query('SELECT ip,last_verified_at,last_peer_seen_at,crawl_seen_count FROM nodes WHERE is_active ORDER BY ip')).rows;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].last_verified_at.getTime(), verifiedAt, 'peer polling never rewrites the actual crawler handshake time');
    assert.equal(rows[1].last_verified_at, null, 'peer-only node has no fabricated crawler handshake');
    assert.equal(rows[1].crawl_seen_count, 0, 'peer observation is not a crawler success');
    assert.equal(rows[1].last_peer_seen_at.getTime(), peerAt);
    const combined = {};
    for (const path of ['/api/network/nodes/stats', '/api/network/nodes/list', '/api/network/topology']) {
      const res = { set() {}, setHeader() {}, status(code) { assert.equal(code, 200); return this; }, json(body) { combined[path] = body; } };
      await router.stack.find(l => l.route?.path === path).route.stack[0].handle(req, res);
    }
    assert.equal(combined['/api/network/nodes/stats'].stats.activeNodes, 3);
    assert.equal(combined['/api/network/nodes/stats'].stats.chainQualifiedCrawlerNodes, 1);
    assert.equal(combined['/api/network/nodes/stats'].stats.localPeerNodes, 3);
    assert.equal(combined['/api/network/nodes/stats'].stats.localPeerOnlyNodes, 2);
    assert.equal(combined['/api/network/nodes/stats'].stats.overlapNodes, 1);
    assert.equal(combined['/api/network/nodes/stats'].clients.observedNodes, 3);
    assert.equal(combined['/api/network/nodes/list'].total, 3);
    assert.equal(combined['/api/network/topology'].counts.reachable, 3, 'peer-only nodes survive an absent gossip-graph row');
    assert.equal(combined['/api/network/topology'].edges.length, 0, 'no invented edges');
    assert.equal(combined['/api/network/nodes/stats'].stats.censusVersion, CENSUS_VERSION);
    assert.equal(JSON.stringify(combined).includes('192.0.2.'), false, 'raw IPs remain private');
    // Source clocks advance independently: a newer proof cannot be blocked by a
    // still-later peer observation, and replay cannot swap the proof tuple.
    const nextProof = proofAt + 100;
    const advanced = { ...metrics, node_info: [{ ...metrics.node_info[0],
      last_verified_at_ms: verifiedAt + 50, chain_verified_at_ms: nextProof }] };
    await ingestCrawl({ ...options, now: () => peerAt + 1, rpc: async () => advanced });
    const advancedRow = (await db.query('SELECT last_verified_at,last_chain_verified_at,last_peer_seen_at,last_seen,chain_block_hash,chain_proof,crawl_seen_count FROM nodes WHERE id=1')).rows[0];
    assert.equal(advancedRow.last_verified_at.getTime(), verifiedAt + 50);
    assert.equal(advancedRow.last_chain_verified_at.getTime(), nextProof);
    assert.equal(advancedRow.last_peer_seen_at.getTime(), peerAt);
    assert.equal(advancedRow.last_seen.getTime(), peerAt);
    assert.equal(advancedRow.chain_block_hash, CHAIN_BLOCK_HASH);
    assert.equal(advancedRow.chain_proof, CHAIN_PROOF);
    assert.equal(advancedRow.crawl_seen_count, 2);
    await db.query(`UPDATE nodes SET ping_ms=999,crawl_seen_count=999,crawl_miss_count=999,degree=999
      WHERE ip='192.0.2.5'`);
    const reliabilityRes = { set() {}, setHeader() {}, json(body) { responses.reliability = body; }, status() { return this; } };
    await router.stack.find(l=>l.route?.path==='/api/network/nodes/reliability').route.stack[0].handle(req,reliabilityRes);
    assert.equal(responses.reliability.latency.measured, 1, 'legacy latency on a peer-only row is not a qualified sample');
    assert.equal(responses.reliability.latency.median, 25);
    assert.equal(responses.reliability.leaderboard.length, 0, 'legacy counters cannot enter qualified reliability');
    assert.equal(responses.reliability.maxSeen, 2);
    const foreignProof = { ...advanced, node_info: [{ ...advanced.node_info[0], chain_block_hash: '0'.repeat(64) }] };
    await ingestCrawl({ ...options, rpc: async () => foreignProof });
    assert.equal((await db.query('SELECT last_chain_verified_at FROM nodes WHERE id=1')).rows[0].last_chain_verified_at.getTime(), nextProof);
    // A failed peer poll retains the observation time; expiry removes it at read time.
    await ingestCrawl({ ...options, peerRpc: async () => { throw new Error('offline'); } });
    assert.equal((await db.query("SELECT last_peer_seen_at FROM nodes WHERE ip='192.0.2.5'")).rows[0].last_peer_seen_at.getTime(), peerAt);
    await db.query("UPDATE nodes SET last_peer_seen_at=now()-interval '16 minutes'");
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${require('../lib/node-census').censusTable('crawl')} n WHERE census_active`)).rows[0].n, 1);
    // Both crawlers can fail while fresh live peers still get recorded.
    await ingestCrawl({ ...combinedOptions, rpc: async () => { throw new Error('offline'); } });
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${require('../lib/node-census').censusTable('crawl')} n WHERE census_active`)).rows[0].n, 3);

    // A first qualified proof with no agent must not launder old Flux metadata.
    await db.query(`INSERT INTO nodes(id,ip,user_agent,client_impl,client_version,last_verified_at)
      VALUES(16,'192.0.2.16','/MagicBean:9.1.0/','zcashd','9.1.0',now())`);
    const unknownAt = Date.now() - 500;
    const unknownMetrics = { ...metrics, generated_at_ms: Date.now(), node_info: [{
      ...metrics.node_info[0], addr: '192.0.2.16:8233', user_agent: null,
      last_verified_at_ms: unknownAt - 100, chain_verified_at_ms: unknownAt,
    }] };
    await ingestCrawl({ ...options, rpc: async () => unknownMetrics });
    const unknownIdentity = (await db.query('SELECT user_agent,client_impl,client_version FROM nodes WHERE id=16')).rows[0];
    assert.deepEqual(unknownIdentity, { user_agent: null, client_impl: 'Unknown', client_version: null });

    // An independently fresh peer identity can still supply an honest client
    // label; a newer unidentified crawler proof must not replace that evidence.
    const trustedPeer = (await db.query("SELECT user_agent,client_impl,client_version FROM nodes WHERE ip='192.0.2.5'")).rows[0];
    await ingestCrawl({ ...options, rpc: async () => ({ ...unknownMetrics, node_info: [{
      ...unknownMetrics.node_info[0], addr: '192.0.2.5:8233',
    }] }) });
    assert.deepEqual((await db.query("SELECT user_agent,client_impl,client_version FROM nodes WHERE ip='192.0.2.5'")).rows[0], trustedPeer);
    await ingestCrawl({ ...options,
      rpc: async () => { throw new Error('offline'); },
      peerRpc: async () => [{ addr: '192.0.2.5:40001', version: 170160, subver: null }],
    });
    assert.deepEqual((await db.query("SELECT user_agent,client_impl,client_version FROM nodes WHERE ip='192.0.2.5'")).rows[0],
      { user_agent: null, client_impl: 'Unknown', client_version: null },
      'a fresh peer observation without an agent cannot extend the old client identity');

    // Old proofs cannot keep latency/counters measurable forever through a
    // fresh peer observation, even though that separate peer remains active.
    await db.query("UPDATE nodes SET last_chain_verified_at=now()-interval '2 hours', last_verified_at=now()-interval '2 hours', last_peer_seen_at=now() WHERE ip='192.0.2.5'");
    const measured = (await db.query(`SELECT census_active,census_crawl_qualified FROM ${require('../lib/node-census').censusTable('crawl')} census WHERE ip='192.0.2.5'`)).rows[0];
    assert.deepEqual(measured, { census_active: true, census_crawl_qualified: false });

    // A failed provider must retain known row-level evidence, while its public
    // aggregate is unavailable. A later valid list can honestly establish zero.
    await db.query("UPDATE nodes SET is_tor=true,tor_type='exit' WHERE id=1");
    await ingestCrawl({ ...options, torExits: async () => { throw new Error('ECONNRESET'); } });
    assert.deepEqual((await db.query('SELECT is_tor,tor_type FROM nodes WHERE id=1')).rows[0],
      { is_tor: true, tor_type: 'exit' });
    assert.equal(classifications.at(-1).available, false);
    await ingestCrawl({ ...options, torExits: async () => new Set(['192.0.2.250']) });
    assert.deepEqual((await db.query('SELECT is_tor,tor_type FROM nodes WHERE id=1')).rows[0],
      { is_tor: false, tor_type: null });
    assert.equal(classifications.at(-1).available, true);
    assert.equal(classifications.at(-1).classifiedTorNodes, 0, 'valid provider with no matching active IPs is a measured zero');
    const beforeRollback = classifications.length;
    await assert.rejects(ingestCrawl({ ...options, dbPool: { connect: async () => ({
      async query(sql, params) { if (sql === 'COMMIT') throw new Error('commit failed'); return writerClient.query(sql, params); },
      release() {},
    }) } }), /commit failed/);
    assert.equal(classifications.length, beforeRollback, 'a failed transaction cannot publish status');
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});

test('migration 038 is additive and idempotent without backfilling chain evidence', {
  skip: !process.env.TEST_NODE_CENSUS_DATABASE_URL,
}, async () => {
  const db = new Client({ connectionString: process.env.TEST_NODE_CENSUS_DATABASE_URL });
  await db.connect();
  try {
    await db.query('CREATE TEMP TABLE nodes(id int,last_verified_at timestamptz); CREATE TEMP TABLE nodes_crawl(id int); CREATE TEMP TABLE node_snapshots(census_version smallint); INSERT INTO nodes VALUES(1,now())');
    const migration = require('node:fs').readFileSync(require('node:path').join(__dirname, '../deploy/sql/038_chain_qualified_node_census.sql'), 'utf8');
    await db.query(migration);
    await db.query(migration);
    const row = (await db.query('SELECT last_verified_at,last_peer_seen_at,last_chain_verified_at,chain_block_hash,chain_proof FROM nodes')).rows[0];
    assert.ok(row.last_verified_at);
    assert.deepEqual({ ...row, last_verified_at: null }, { last_verified_at: null, last_peer_seen_at: null,
      last_chain_verified_at: null, chain_block_hash: null, chain_proof: null });
  } finally { await db.end(); }
});


test('migration 031 is additive and idempotent without inventing peer observations', {
  skip: !process.env.TEST_NODE_CENSUS_DATABASE_URL,
}, async () => {
  const db = new Client({ connectionString: process.env.TEST_NODE_CENSUS_DATABASE_URL });
  await db.connect();
  try {
    await db.query('CREATE TEMP TABLE nodes(id int); CREATE TEMP TABLE nodes_crawl(id int); CREATE TEMP TABLE node_snapshots(census_version smallint); INSERT INTO nodes VALUES(1)');
    const migration = require('node:fs').readFileSync(require('node:path').join(__dirname, '../deploy/sql/031_combined_node_census.sql'), 'utf8');
    await db.query(migration);
    await db.query(migration);
    assert.equal((await db.query('SELECT last_peer_seen_at FROM nodes')).rows[0].last_peer_seen_at, null);
  } finally { await db.end(); }
});
