'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTIVITY_SQL, activityWindow, activityResponse,
} = require('../api/lib/pool-activity');

function completeRows(window, values = {}) {
  return Array.from({ length: window.days }, (_, index) => ({
    date: new Date(Date.parse(window.startDate) + index * 86400000).toISOString().slice(0, 10),
    total_transactions: '4', sprout: '1', sapling: '2', orchard: '1', ironwood: '1',
    complete: true, source_height: '108', ...values,
  }));
}

test('activity windows use complete UTC days with a bounded calendar range', () => {
  const window = activityWindow('7d', new Date('2026-10-27T23:59:59-06:00'));
  assert.equal(window.startDate, '2026-10-21');
  assert.equal(window.endDate, '2026-10-27');
  assert.deepEqual(window.params.slice(2), ['2026-10-21', '2026-10-28']);
  assert.equal(activityWindow('1y', new Date('2026-10-27')).days, 365);
  for (const value of ['all', '365d', '', 'constructor']) {
    assert.throws(() => activityWindow(value), /Unsupported/);
  }
});

test('pool counts overlap while totals retain the common non-coinbase denominator', () => {
  const window = activityWindow('7d', new Date('2026-10-27'));
  const data = activityResponse(completeRows(window), window);
  assert.deepEqual(data.totals, { totalTransactions: 28, sprout: 7, sapling: 14, orchard: 7, ironwood: 7 });
  assert.equal(data.overlappingPools, true);
  assert.equal(data.denominator, 'canonical non-coinbase transactions');
  assert.deepEqual(data.coverage, { completeDays: 7, expectedDays: 7 });
  assert.equal(data.sourceHeight, 108);
});

test('empty activity is zero, incomplete coverage and impossible counts are null', () => {
  const window = activityWindow('7d', new Date('2026-10-27'));
  const zero = { total_transactions: '0', sprout: '0', sapling: '0', orchard: '0', ironwood: '0' };
  assert.equal(activityResponse(completeRows(window, zero), window).totals.totalTransactions, 0);
  for (const invalid of [{ complete: false }, { total_transactions: null }, { sapling: '5' }, { orchard: '-1' }]) {
    const rows = completeRows(window);
    Object.assign(rows[2], invalid);
    const data = activityResponse(rows, window);
    assert.equal(data.points[2].complete, false);
    assert.equal(data.points[2].sapling, null);
    assert.equal(data.coverage.completeDays, 6);
    assert.ok(Object.values(data.totals).every(value => value === null));
  }
});

test('activity route rejects unbounded/structured queries and reuses successful cached data', async () => {
  const express = require('express');
  const window = activityWindow('7d');
  let queries = 0;
  const cache = new Map();
  const ttls = [];
  const app = express();
  app.locals.pool = { query: async () => { queries++; return { rows: completeRows(window) }; } };
  app.locals.redisClient = {
    isOpen: true, get: async key => cache.get(key),
    setEx: async (key, ttl, value) => { cache.set(key, value); ttls.push(ttl); },
  };
  app.use(require('../api/routes/pools'));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}/api/pools/activity`;
  try {
    for (const query of ['?period=all', '?period=7d&period=30d', '?period[foo]=7d', '?foo=7d']) {
      assert.equal((await fetch(base + query)).status, 400);
    }
    assert.equal(queries, 0);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(base + '?period=7d');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).totals.sapling, 14);
    }
    assert.equal(queries, 1);
    assert.deepEqual(ttls, [300]);
    cache.clear();
    app.locals.pool.query = async () => ({ rows: completeRows(window, { complete: false }) });
    const missing = await (await fetch(base + '?period=7d')).json();
    assert.equal(missing.totals.sapling, null);
    assert.equal(ttls.at(-1), 15);
    cache.clear();
    app.locals.pool.query = async () => ({ rows: completeRows(window, { source_height: null, complete: false }) });
    assert.equal((await fetch(base + '?period=7d')).status, 503);
    assert.equal(cache.size, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('canonical pool activity and missing coverage execute against PostgreSQL', {
  skip: process.env.POOL_ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_POOL_ACTIVITY_DATABASE_URL,
}, async () => {
  const { Pool } = require('pg');
  const connectionString = process.env.TEST_POOL_ACTIVITY_DATABASE_URL;
  const admin = new Pool(connectionString ? { connectionString, max: 1 } : { host: '/tmp', database: 'postgres', max: 1 });
  const database = `pool_activity_test_${process.pid}_${Date.now()}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const url = connectionString ? new URL(connectionString) : null;
    if (url) url.pathname = `/${database}`;
    db = new Pool({ ...(url ? { connectionString: url.toString() } : { host: '/tmp', database }), max: 1, options: '-c timezone=Asia/Tokyo' });
    await db.query(`CREATE TABLE blocks(height bigint PRIMARY KEY,hash text,timestamp bigint,transaction_count integer);
      CREATE TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_hash text,is_coinbase boolean,
        has_sprout boolean DEFAULT false,has_sapling boolean DEFAULT false,has_orchard boolean DEFAULT false,has_ironwood boolean DEFAULT false,
        sprout_joinsplit_count integer DEFAULT 0,sapling_spend_count integer DEFAULT 0,sapling_output_count integer DEFAULT 0,
        orchard_actions integer DEFAULT 0,ironwood_actions integer DEFAULT 0);
      CREATE INDEX ON blocks(timestamp);
      CREATE INDEX ON transactions(block_height);
      INSERT INTO blocks SELECT 100+i,'block-'||i,extract(epoch FROM timestamptz '2026-10-19T12:00:00Z')+i*86400,5
        FROM generate_series(0,8) i;
      INSERT INTO transactions(txid,block_height,block_hash,is_coinbase,has_ironwood)
        SELECT 'coinbase-'||height,height,hash,true,true FROM blocks;
      INSERT INTO transactions(txid,block_height,block_hash,is_coinbase)
        SELECT 'transparent-'||height,height,hash,false FROM blocks;
      INSERT INTO transactions(txid,block_height,block_hash,is_coinbase,sapling_spend_count)
        SELECT 'sapling-'||height,height,hash,false,2 FROM blocks;
      INSERT INTO transactions(txid,block_height,block_hash,is_coinbase,has_orchard,has_ironwood)
        SELECT 'migration-'||height,height,hash,false,true,true FROM blocks;
      INSERT INTO transactions(txid,block_height,block_hash,is_coinbase,has_sprout,has_sapling)
        SELECT 'sprout-'||height,height,hash,false,true,true FROM blocks;
      INSERT INTO transactions(txid,block_height,block_hash,is_coinbase,has_sapling)
        VALUES ('orphan',103,'replaced-hash',false,true);`);
    const window = activityWindow('7d', new Date('2026-10-27T16:00:00Z'));
    const read = async () => activityResponse((await db.query(ACTIVITY_SQL, window.params)).rows, window);
    const data = await read();
    assert.equal(data.points[0].date, '2026-10-20');
    assert.deepEqual(data.totals, { totalTransactions: 28, sprout: 7, sapling: 14, orchard: 7, ironwood: 7 });
    assert.deepEqual(data.coverage, { completeDays: 7, expectedDays: 7 });
    // A canonical block's day comes from its header, with counts independent
    // of the connection time zone, and retained orphan transactions excluded.
    assert.equal(data.sourceHeight, 108);
    // Legacy NULL pool fields mean unavailable, rather than a measured absence.
    // A flag can classify presence/absence without counts; raw counts can also
    // classify a pool, with both Sapling counts required to establish absence.
    for (const [flag, counts] of [
      ['has_sprout', ['sprout_joinsplit_count']],
      ['has_sapling', ['sapling_spend_count', 'sapling_output_count']],
      ['has_orchard', ['orchard_actions']],
      ['has_ironwood', ['ironwood_actions']],
    ]) {
      const setCounts = value => counts.map(column => `${column}=${value}`).join(',');
      await db.query(`UPDATE transactions SET ${flag}=NULL,${setCounts('NULL')} WHERE txid='transparent-103'`);
      const unknown = await read();
      assert.equal(unknown.points[2].complete, false, flag);
      assert.equal(unknown.points[2].totalTransactions, null, flag);
      assert.ok(Object.values(unknown.totals).every(value => value === null), flag);
      await db.query(`UPDATE transactions SET ${flag}=false WHERE txid='transparent-103'`);
      assert.equal((await read()).points[2].complete, true, `${flag} authoritative absence`);
      await db.query(`UPDATE transactions SET ${flag}=true WHERE txid='transparent-103'`);
      assert.equal((await read()).points[2].complete, true, `${flag} authoritative presence`);
      await db.query(`UPDATE transactions SET ${flag}=NULL,${setCounts('0')} WHERE txid='transparent-103'`);
      assert.equal((await read()).points[2].complete, true, `${flag} count-based absence`);
      await db.query(`UPDATE transactions SET ${flag}=false WHERE txid='transparent-103'`);
    }
    await db.query("UPDATE transactions SET has_sapling=NULL,sapling_spend_count=0,sapling_output_count=NULL WHERE txid='transparent-103'");
    assert.equal((await read()).points[2].complete, false, 'one zero Sapling count cannot establish absence');
    await db.query("UPDATE transactions SET sapling_spend_count=2 WHERE txid='transparent-103'");
    assert.equal((await read()).points[2].complete, true, 'positive Sapling spend establishes presence');
    assert.equal((await read()).points[2].sapling, 3);
    await db.query("UPDATE transactions SET sapling_spend_count=NULL,sapling_output_count=1 WHERE txid='transparent-103'");
    assert.equal((await read()).points[2].complete, true, 'positive Sapling output establishes presence');
    await db.query("UPDATE transactions SET has_sapling=false,sapling_spend_count=0,sapling_output_count=0 WHERE txid='transparent-103'");
    await db.query(`UPDATE blocks SET timestamp = CASE height
      WHEN 102 THEN extract(epoch FROM timestamptz '2026-10-22T23:59:59Z')
      WHEN 103 THEN extract(epoch FROM timestamptz '2026-10-21T00:00:00Z') END
      WHERE height IN (102,103)`);
    assert.equal((await read()).coverage.completeDays, 7);
    await db.query(`UPDATE blocks SET timestamp=extract(epoch FROM timestamptz '2026-10-19T12:00:00Z')+(height-100)*86400
      WHERE height IN (102,103)`);
    await db.query('DELETE FROM transactions WHERE block_height=101 AND is_coinbase=false; UPDATE blocks SET transaction_count=1 WHERE height=101');
    const emptyDay = (await read()).points[0];
    assert.equal(emptyDay.complete, true);
    assert.equal(emptyDay.totalTransactions, 0);
    assert.equal(emptyDay.sapling, 0);
    await db.query("DELETE FROM transactions WHERE txid='sapling-103'");
    const incomplete = await read();
    assert.equal(incomplete.points[2].complete, false);
    assert.equal(incomplete.points[2].totalTransactions, null);
    assert.equal(incomplete.totals.totalTransactions, null);
    assert.equal(incomplete.coverage.completeDays, 6);
    await db.query('DELETE FROM blocks WHERE height=103');
    assert.equal((await read()).coverage.completeDays, 0);
    // A stale indexed tip cannot make the end of the requested window complete.
    await db.query('DELETE FROM blocks WHERE height>=107');
    assert.equal((await read()).coverage.completeDays, 0);
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
});
