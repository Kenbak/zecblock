'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

// Testnet's schema-only rebuild has every recorded migration but none of the
// crawler columns mainnet received out of band. Migration 040 must make the
// node-intelligence routes answer there instead of returning 500.
const ROUTES = ['/api/network/nodes/list', '/api/network/nodes/health-score', '/api/network/nodes/reliability',
  '/api/network/nodes/upgrade-readiness', '/api/network/nodes/concentration'];

test('migration 040 restores testnet node-intelligence routes on a schema without crawler columns', {
  skip: !process.env.TEST_NODE_CENSUS_DATABASE_URL && process.env.NODE_CENSUS_POSTGRES !== '1',
}, async () => {
  process.env.NODE_SOURCE = 'peer';
  process.env.NETWORK = 'testnet';
  const db = new Client(process.env.TEST_NODE_CENSUS_DATABASE_URL
    ? { connectionString: process.env.TEST_NODE_CENSUS_DATABASE_URL } : { host: '/tmp', database: 'postgres' });
  await db.connect();
  try {
    await db.query('BEGIN');
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/node-census.sql'), 'utf8');
    // Base tables plus recorded migrations 029/031/038; drop the crawler-only ALTER.
    const crawler = fixture.indexOf('ALTER TABLE nodes ADD COLUMN onion_address');
    const after = fixture.indexOf('ALTER TABLE node_snapshots ADD COLUMN tor_hidden_nodes');
    await db.query(fixture.slice(0, crawler) + fixture.slice(after));
    await db.query(`ALTER TABLE nodes ADD COLUMN last_verified_at timestamptz, ADD COLUMN last_peer_seen_at timestamptz,
      ADD COLUMN last_chain_verified_at timestamptz, ADD COLUMN chain_block_hash text, ADD COLUMN chain_proof text`);
    await db.query(`INSERT INTO nodes(id, ip, port, observed_via, is_active, client_impl, protocol_version, country_code, isp, last_peer_seen_at)
      VALUES (1,'192.0.2.1',18233,'peer',true,'Zakura',170180,'JP','Example',now()),
             (2,'192.0.2.2',18233,'peer',true,'Zebra',170160,'FI','Example',now())`);
    const router = require('../api/routes/network');
    const req = { app: { locals: { pool: db, redisClient: null } }, query: {}, headers: {} };
    router.stack[0].handle(req, {}, () => {});
    const call = async route => {
      let status = 200, body;
      const res = { set() { return this; }, setHeader() {}, status(code) { status = code; return this; }, json(value) { body = value; } };
      await db.query('SAVEPOINT route');
      await router.stack.find(layer => layer.route?.path === route).route.stack[0].handle(req, res);
      await db.query(status === 200 ? 'RELEASE SAVEPOINT route' : 'ROLLBACK TO SAVEPOINT route');
      return { status, body };
    };
    const before = [];
    for (const route of ROUTES) before.push([route, (await call(route)).status]);
    assert.ok(before.every(([, status]) => status === 500), `reproduces the testnet failures: ${JSON.stringify(before)}`);

    const migration = fs.readFileSync(path.join(__dirname, '../deploy/sql/040_node_crawler_columns.sql'), 'utf8')
      .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
    await db.query(migration);
    await db.query(migration); // re-runnable
    for (const route of ROUTES) assert.equal((await call(route)).status, 200, route);
    const readiness = (await call('/api/network/nodes/upgrade-readiness')).body;
    assert.equal(readiness.referenceUpgrade, 'NU7');
    assert.equal(readiness.latestProtocol, 170180);
    assert.equal(readiness.latestCount, 1);
    assert.equal(readiness.readinessPct, 50);
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
});
