'use strict';

// Real PostgreSQL fixture for the race-vs-late orphan split. Opt in with
// TEST_ORPHAN_RACE_DATABASE_URL (or ORPHAN_RACE_POSTGRES=1 with DB_* settings).
// Everything runs inside one transaction that is rolled back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { orphanRates } = require('../api/lib/orphan-rates');
const { orphanRateDaily } = require('../api/lib/orphan-rate-daily');

const enabled = Boolean(process.env.TEST_ORPHAN_RACE_DATABASE_URL) || process.env.ORPHAN_RACE_POSTGRES === '1';
const captureMigration = fs.readFileSync(path.join(__dirname, '../deploy/sql/035_live_block_capture.sql'), 'utf8');
// The capture tables exactly as migration 035 defines them.
const captureTables = captureMigration.match(/CREATE TABLE IF NOT EXISTS public\.(?:captured_blocks|block_capture_observers|block_capture_receipts) \([\s\S]*?\n\);/g);

const hash = n => n.toString(16).padStart(64, '0');

async function withFixture(fn) {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.TEST_ORPHAN_RACE_DATABASE_URL,
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await db.connect();
  try {
    await db.query('BEGIN');
    // Minimal shapes of the indexer tables the orphan-rate SQL reads.
    await db.query(`CREATE TEMP TABLE blocks (height bigint, hash text, timestamp bigint, miner_address text, coinbase_hex text)`);
    await db.query(`CREATE TEMP TABLE orphaned_blocks (hash text, timestamp bigint, miner_address text, coinbase_hex text, source text, consensus_valid boolean)`);
    assert.equal(captureTables.length, 3);
    for (const ddl of captureTables) await db.query(ddl);
    const now = Number((await db.query('SELECT floor(extract(epoch FROM now()))::bigint AS now')).rows[0].now);
    await fn(db, now);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
}

/**
 * Heights 101–106 each have a canonical winner. Losers:
 *   101 indexer reorg archive                    → race (our node's tip)
 *   102 0.3s after the winner at A               → race
 *   103 5s late at A but 1s early at B           → race (per-observer)
 *   104 5s late at A, 3s late at B               → late
 *   105 seen only by C, which never got winner   → race
 *   106 exactly 2.0s after the winner at A       → race (window is inclusive)
 */
async function seed(db, now) {
  const t = now - 600;
  // One old canonical block so indexed history covers every window.
  await db.query(`INSERT INTO blocks VALUES (1, $1, $2, 'tOld', NULL)`, [hash(1), now - 40 * 86400]);
  for (let h = 101; h <= 106; h++) {
    await db.query(`INSERT INTO blocks VALUES ($1, $2, $3, 'tWinner', NULL)`, [h, hash(h), t + h]);
  }
  await db.query(`INSERT INTO orphaned_blocks VALUES ($1, $2, 'tLoser', NULL, 'indexer', true)`, [hash(1101), t + 101]);
  for (const o of ['A', 'B', 'C']) {
    await db.query(`INSERT INTO block_capture_observers (observer, network, stream_connected, gaps, pending_records) VALUES ($1, 'mainnet', true, 0, 0)`, [o]);
  }
  const base = new Date((t + 1000) * 1000);
  const at = ms => new Date(base.getTime() + ms);
  const capture = async (h, blockHash) => db.query(
    `INSERT INTO captured_blocks (hash, network, height, previous_block_hash, timestamp, first_seen_at, miner_address, raw_block, raw_pruned)
     VALUES ($1, 'mainnet', $2, $3, $4, $5, 'tLoser', NULL, true)`, [blockHash, h, hash(9999), t + h, base]);
  const receipt = (observer, blockHash, ms) => db.query(
    `INSERT INTO block_capture_receipts (observer, hash, received_at) VALUES ($1, $2, $3)`, [observer, blockHash, at(ms)]);
  for (let h = 102; h <= 106; h++) { await capture(h, hash(h)); await capture(h, hash(1000 + h)); }
  // Winners reach A and B at 0ms; C never receives any winner.
  for (let h = 102; h <= 106; h++) { await receipt('A', hash(h), 0); await receipt('B', hash(h), 0); }
  await receipt('A', hash(1102), 300);
  await receipt('A', hash(1103), 5000); await receipt('B', hash(1103), -1000);
  await receipt('A', hash(1104), 5000); await receipt('B', hash(1104), 3000);
  await receipt('C', hash(1105), 9000);
  await receipt('A', hash(1106), 2000);
}

test('orphan-rate windows split race orphans from late blocks per observer', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await seed(db, now);
    const out = await orphanRates(db);
    assert.equal(out.raceWindowSeconds, 2);
    const day = out.periods.find(p => p.period === '24h');
    assert.equal(day.canonicalBlocks, 6);
    assert.equal(day.orphanedBlocks, 6);
    assert.equal(day.lateOrphanedBlocks, 1);
    assert.equal(day.raceOrphanedBlocks, 5);
    assert.equal(day.rate, 6 / 12);
    assert.equal(day.raceRate, 5 / 11);
    // Test payout addresses are unattributed, so winners and losers share the Unknown pool.
    const unknown = day.pools.find(p => p.name === 'Unknown');
    assert.deepEqual([unknown.orphanedBlocks, unknown.raceOrphanedBlocks, unknown.lateOrphanedBlocks], [6, 5, 1]);
    assert.equal(unknown.raceRate, 5 / 11);
  });
});

test('daily orphan rates carry the same race/late split', { skip: !enabled }, async () => {
  await withFixture(async (db, now) => {
    await seed(db, now);
    const out = await orphanRateDaily(db, { days: 7 });
    assert.equal(out.raceWindowSeconds, 2);
    const totals = out.days.reduce((s, d) => ({ o: s.o + d.orphanedBlocks, late: s.late + d.lateOrphanedBlocks, race: s.race + d.raceOrphanedBlocks }), { o: 0, late: 0, race: 0 });
    assert.deepEqual(totals, { o: 6, late: 1, race: 5 });
    for (const d of out.days) {
      assert.equal(d.raceOrphanedBlocks + d.lateOrphanedBlocks, d.orphanedBlocks);
      if (d.canonicalBlocks > 0) assert.equal(d.raceRate, d.raceOrphanedBlocks / (d.canonicalBlocks + d.raceOrphanedBlocks));
    }
  });
});
