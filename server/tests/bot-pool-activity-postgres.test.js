'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { readPoolActivity } = require('../bot/lib/pool-activity-source');

test('canonical pool activity history and fail-closed coverage against PostgreSQL', {
  skip: process.env.ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_ACTIVITY_DATABASE_URL,
}, async t => {
  const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
  const database = `pool_activity_bot_test_${process.pid}_${Date.now()}`;
  const admin = new Pool(connection ? { connectionString: connection, max: 1 }
    : { host: '/tmp', database: 'postgres', max: 1 });
  let db;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const url = connection ? new URL(connection) : null;
    if (url) url.pathname = `/${database}`;
    db = new Pool({ ...(url ? { connectionString: url.toString() } : { host: '/tmp', database }),
      max: 2, options: '-c timezone=Asia/Tokyo' });
    await db.query(`CREATE TABLE blocks(height bigint PRIMARY KEY,hash text NOT NULL,timestamp bigint NOT NULL,transaction_count integer);
      CREATE TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_hash text,block_time bigint,
        is_coinbase boolean DEFAULT false,has_sprout boolean DEFAULT false,has_sapling boolean DEFAULT false,
        has_orchard boolean DEFAULT false,has_ironwood boolean DEFAULT false,
        sprout_joinsplit_count integer DEFAULT 0,sapling_spend_count integer DEFAULT 0,sapling_output_count integer DEFAULT 0,
        orchard_actions integer DEFAULT 0,ironwood_actions integer DEFAULT 0);
      INSERT INTO blocks SELECT 3428143+i,repeat(md5(i::text),2),
        extract(epoch FROM timestamptz '2026-07-28T00:01:00Z')+i*86400,1 FROM generate_series(-366,91) i;
      UPDATE blocks SET timestamp=extract(epoch FROM timestamptz '2026-10-26T23:59:59Z') WHERE height=3428233;
      UPDATE blocks SET timestamp=extract(epoch FROM timestamptz '2026-10-27T07:50:00Z') WHERE height=3428234;
      INSERT INTO transactions(txid,block_height,block_hash,block_time,is_coinbase,has_orchard,has_ironwood)
        SELECT 'coinbase-'||height,height,hash,timestamp,true,true,true FROM blocks;
      INSERT INTO transactions(txid,block_height,block_hash,block_time,has_orchard,has_ironwood,orchard_actions,ironwood_actions)
        SELECT v.txid,b.height,b.hash,b.timestamp,v.orchard,v.ironwood,v.orchard_actions,v.ironwood_actions
        FROM blocks b CROSS JOIN (VALUES
          ('orchard',true,false,0,0),('ironwood',false,true,0,0),('overlap',true,true,0,0),
          ('transparent',false,false,0,0),('action-fallback',false,false,1,2)
        ) AS v(txid,orchard,ironwood,orchard_actions,ironwood_actions) WHERE b.height=3428233;
      UPDATE blocks SET transaction_count=6 WHERE height=3428233;
      -- Transaction timestamps cannot override their canonical block's UTC day.
      UPDATE transactions SET block_time=extract(epoch FROM timestamptz '2026-10-27T00:00:00Z') WHERE txid='overlap';
      INSERT INTO transactions(txid,block_height,block_hash,block_time,has_orchard,has_ironwood)
        VALUES('retained-orphan',3428233,repeat('f',64),extract(epoch FROM timestamptz '2026-10-26T23:59:59Z'),true,true);
      CREATE TABLE fixture_blocks AS TABLE blocks;
      CREATE TABLE fixture_transactions AS TABLE transactions;`);
    const now = new Date('2026-10-27T08:00:00Z');
    const queries = [];
    // Only the isolated fixture's database-name probe is mapped. Every count,
    // canonical join, coverage check and transaction executes real PostgreSQL.
    const reader = { connect: async () => {
      const client = await db.connect();
      return { query: (sql, args) => {
        queries.push(sql);
        return client.query(sql.replace('current_database() AS name', "'zcash_explorer_mainnet' AS name"), args);
      }, release: () => client.release() };
    } };
    const reset = () => db.query(`TRUNCATE blocks,transactions;
      INSERT INTO blocks SELECT * FROM fixture_blocks;
      INSERT INTO transactions SELECT * FROM fixture_transactions;`);
    const rejectsMutation = async (name, sql, pattern = /Incomplete canonical pool activity/) => {
      await t.test(name, async () => {
        await db.query(sql);
        try { await assert.rejects(readPoolActivity(reader, now), pattern); }
        finally { await reset(); }
      });
    };

    await t.test('overlap, actions fallback, transparent denominator, coinbase and orphan exclusion use UTC', async () => {
      const result = await readPoolActivity(reader, now);
      assert.equal(result.historyStart, '2025-07-28');
      assert.equal(result.days.length, 456);
      assert.deepEqual(result.days[0], { date: '2025-07-28', totalTransactions: 0, orchard: 0, ironwood: 0, complete: true });
      assert.deepEqual(result.days.at(-1), { date: '2026-10-26', totalTransactions: 5, orchard: 3, ironwood: 3, complete: true });
      assert.ok(result.days.at(-1).orchard + result.days.at(-1).ironwood > result.days.at(-1).totalTransactions);
      assert.deepEqual(result.activation, { height: 3428143, timestamp: Date.parse('2026-07-28T00:01:00Z') / 1000, date: '2026-07-28' });
      assert.equal(result.tip.height, 3428234);
      assert.equal(result.tip.timestamp, Date.parse('2026-10-27T07:50:00Z') / 1000);
      assert.equal(result.capturedAt, now.toISOString());
      assert.ok(queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
      assert.equal(queries.at(-1), 'COMMIT');
    });
    await t.test('an unmapped fixture/testnet database is refused', async () => {
      await assert.rejects(readPoolActivity(db, now), /mainnet-only/);
    });
    await rejectsMutation('stale source tip is refused',
      'UPDATE blocks SET timestamp=timestamp-3600 WHERE height=3428234', /tip unavailable or stale/);
    await rejectsMutation('source tip more than two hours in the future is refused',
      'UPDATE blocks SET timestamp=timestamp+10800 WHERE height=3428234', /tip unavailable or stale/);
    await rejectsMutation('missing activation block is refused',
      'DELETE FROM blocks WHERE height=3428143', /activation block unavailable/);
    await rejectsMutation('activation UTC date must match verified mainnet activation',
      'UPDATE blocks SET timestamp=timestamp-86400 WHERE height=3428143', /does not match verified mainnet activation/);
    await rejectsMutation('missing canonical transaction is not replaced by retained orphan data',
      "DELETE FROM transactions WHERE txid='ironwood'");
    await rejectsMutation('wrong canonical block hash makes a transaction unavailable',
      "UPDATE transactions SET block_hash=repeat('e',64) WHERE txid='ironwood'");
    await rejectsMutation('missing interior block invalidates the entire historical comparison',
      'DELETE FROM blocks WHERE height=3428100');
    await rejectsMutation('missing enclosing left shoulder invalidates coverage',
      'DELETE FROM blocks WHERE height=3427777');
    await rejectsMutation('exactly one coinbase is required in every canonical block',
      "UPDATE transactions SET is_coinbase=false WHERE txid='coinbase-3428233'");
    await rejectsMutation('nullable coinbase classification cannot become an excluded denominator row',
      "UPDATE transactions SET is_coinbase=null WHERE txid='transparent'");
    await rejectsMutation('unknown Ironwood metadata fails closed',
      "UPDATE transactions SET has_ironwood=null,ironwood_actions=null WHERE txid='transparent'");
    await rejectsMutation('unknown Orchard metadata fails closed',
      "UPDATE transactions SET has_orchard=null,orchard_actions=null WHERE txid='transparent'");
    await rejectsMutation('unknown Sprout metadata fails closed even for an Ironwood story',
      "UPDATE transactions SET has_sprout=null,sprout_joinsplit_count=null WHERE txid='transparent'");
    await rejectsMutation('partially unknown Sapling metadata fails closed',
      "UPDATE transactions SET has_sapling=null,sapling_spend_count=0,sapling_output_count=null WHERE txid='transparent'");
    await t.test('known positive Sapling action proves pool membership despite a missing companion count', async () => {
      await db.query("UPDATE transactions SET has_sapling=null,sapling_spend_count=1,sapling_output_count=null WHERE txid='transparent'");
      try { assert.equal((await readPoolActivity(reader, now)).days.at(-1).totalTransactions, 5); }
      finally { await reset(); }
    });
    await t.test('failed reads roll back and release connections for a subsequent healthy read', async () => {
      await db.query("UPDATE transactions SET has_ironwood=null,ironwood_actions=null WHERE txid='transparent'");
      await assert.rejects(readPoolActivity(reader, now), /Incomplete canonical pool activity/);
      assert.equal(queries.at(-1), 'ROLLBACK');
      await reset();
      assert.equal((await readPoolActivity(reader, now)).days.at(-1).ironwood, 3);
    });
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
});
