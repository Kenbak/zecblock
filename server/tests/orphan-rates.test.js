const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { formatOrphanRates, orphanRates } = require('../api/lib/orphan-rates');

const viaBTC = 't1MKn34KBa8Xh4g8qU8psibBXvURafphVn7';
function fixture(patch = {}) {
  return ['24h', '7d', '30d'].map(period => ({
    period, window_start: 1000000, window_end: 4000000, history_start: 0,
    indexed_height: 123, indexed_hash: 'tip', indexed_timestamp: 3999999,
    miner_address: viaBTC, tag: null, canonical_blocks: '100', orphaned_blocks: '2', ...patch,
  }));
}

test('rates use canonical plus observed orphans, preserve unknown and combine known public tags', () => {
  const rows = [...fixture(), ...fixture({ miner_address: null, canonical_blocks: '0', orphaned_blocks: '1' }),
    ...fixture({ miner_address: null, tag: 'sluicey', canonical_blocks: '10', orphaned_blocks: '0' })];
  const data = formatOrphanRates(rows);
  assert.equal(data.periods.length, 3);
  for (const p of data.periods) {
    assert.equal(p.canonicalBlocks, 110);
    assert.equal(p.orphanedBlocks, 3);
    assert.equal(p.rate, 3 / 113);
    assert.equal(p.pools.find(p => p.name === 'Unknown').rate, 1);
    assert.equal(p.pools.find(p => p.name === 'ViaBTC').rate, 2 / 102);
    assert.equal(p.pools.find(p => p.name === 'Sluicey Pool').rate, 0);
    assert.equal(p.pools.reduce((n, p) => n + p.canonicalBlocks, 0), p.canonicalBlocks);
    assert.equal(p.pools.reduce((n, p) => n + p.orphanedBlocks, 0), p.orphanedBlocks);
  }
  assert.deepEqual(data.coverage, { status: 'unverified', collectionStart: null, uptimeVerified: false });
});

test('observed zero differs from absent or insufficient canonical history', () => {
  assert.equal(formatOrphanRates(fixture({ orphaned_blocks: '0' })).periods[0].rate, 0);
  for (const patch of [{ history_start: null }, { history_start: 1000001 }, { canonical_blocks: '0' }]) {
    const window = formatOrphanRates(fixture(patch)).periods[0];
    assert.equal(window.rate, null);
    assert.ok(window.unavailableReason);
    assert.equal(window.orphanedBlocks, 2);
    assert.ok(window.pools.every(p => p.rate === null));
  }
  assert.throws(() => formatOrphanRates([]));
  assert.throws(() => formatOrphanRates(fixture().slice(0, 1)));
  assert.throws(() => formatOrphanRates(fixture({ orphaned_blocks: '-1' })));
});

test('public rate route returns snapshots and fails closed without leaking database errors', async t => {
  const app = express();
  let fail = false;
  app.locals.pool = { query: async () => { if (fail) throw new Error('private connection details'); return { rows: fixture() }; } };
  app.use(require('../api/routes/mining'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/mining/orphan-rates`;
  let response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=30');
  assert.equal((await response.json()).periods.length, 3);
  fail = true;
  response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error, 'Observed orphan rates unavailable');
});

test('real PostgreSQL filters restored hashes, external reports, invalid archives and timestamp boundaries', {
  skip: process.env.ORPHAN_RATES_POSTGRES !== '1' && !process.env.MINING_TEST_DATABASE_URL,
}, async t => {
  const { Client } = require('pg');
  const db = new Client(process.env.MINING_TEST_DATABASE_URL
    ? { connectionString: process.env.MINING_TEST_DATABASE_URL }
    : { host: '/tmp', database: 'postgres' });
  await db.connect();
  t.after(async () => { await db.query('ROLLBACK'); await db.end(); });
  await db.query(`BEGIN;
    CREATE TEMP TABLE blocks(height bigint, hash text UNIQUE, timestamp bigint, miner_address text, coinbase_hex text);
    CREATE TEMP TABLE orphaned_blocks(hash text UNIQUE, timestamp bigint, miner_address text, coinbase_hex text, source text, consensus_valid boolean);
    INSERT INTO blocks(height,hash,timestamp,miner_address) SELECT i, 'canonical-'||i,
      floor(extract(epoch FROM now()))::bigint + seconds, '${viaBTC}'
    FROM (VALUES (0,-2678400),(1,-100),(2,-86400),(3,-86401),(4,-604800),(5,-2592000),(6,0),(7,1)) v(i,seconds);
    INSERT INTO orphaned_blocks(hash,timestamp,source,consensus_valid) SELECT hash,
      floor(extract(epoch FROM now()))::bigint + seconds, source, valid
    FROM (VALUES ('observed',-10,'indexer',true),('null-valid',-86400,'indexer',null),
      ('outside-24h',-86401,'indexer',null),('30d-edge',-2592000,'indexer',null),
      ('canonical-1',-100,'indexer',null),('external',-10,'external',true),
      ('invalid',-10,'indexer',false),('missing-time',null,'indexer',null),
      ('future',1,'indexer',null),('end',0,'indexer',null)) v(hash,seconds,source,valid);`);
  const data = await orphanRates(db);
  assert.deepEqual(data.periods.map(p => p.canonicalBlocks), [2, 4, 5]);
  assert.deepEqual(data.periods.map(p => p.orphanedBlocks), [2, 3, 4]);
  assert.deepEqual(data.periods.map(p => p.rate), [2 / 4, 3 / 7, 4 / 9]);
  // A hash becoming canonical again must disappear from both network and pool losses.
  await db.query(`INSERT INTO blocks VALUES(8,'observed',floor(extract(epoch FROM now()))::bigint-10,null,null)`);
  const restored = await orphanRates(db);
  assert.equal(restored.periods[0].orphanedBlocks, 1);
  assert.equal(restored.periods[0].canonicalBlocks, 3);
  assert.equal(restored.periods[0].rate, 1 / 4);
  await db.query('TRUNCATE blocks, orphaned_blocks');
  const empty = await orphanRates(db);
  assert.ok(empty.periods.every(p => p.rate === null && p.canonicalBlocks === 0 && p.orphanedBlocks === 0 && !p.pools.length));
});
