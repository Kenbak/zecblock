'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { options, checkTotals, applyDay } = require('../scripts/repair-mining-attribution');
const databaseUrl = process.env.TEST_ANALYTICS_DATABASE_URL || process.env.TEST_UTXO_DATABASE_URL;

test('repair requires bounded completed dates, explicit apply backup and safe pacing', () => {
  const dates = ['--from=2026-10-01','--to=2026-10-02'];
  assert.equal(options(dates).apply, false);
  assert.equal(options([...dates,'--apply','--report=/tmp/audit.jsonl']).dates.length, 2);
  for (const args of [[], [...dates,'--apply'], [...dates,'--pause-ms=0'], ['--from=2016-10-28','--to=2026-10-09'], ['--from=2026-02-30','--to=2026-03-01'], ['--from=2026-10-01','--to=2999-01-01']]) assert.throws(() => options(args));
});

function data() {
  return { date: '2026-10-01', anchor: { height: 2, hash: 'tip' }, poolCounts: { 'Binance Pool': 1, Unknown: 1 },
    earned: { 'Binance Pool': { address: 'historical-binance', earned: 9007199254740993n, spent: 1n, blocks: 1, outputsSpent: 1, outputsTotal: 2 } },
    flows: { 'Binance Pool': { shielded: 1n, exchange: 0n, bridge: 0n, other: 0n } } };
}

test('independent pool, earned and destination totals reject lost blocks or mismatched movements', () => {
  const d = data();
  const totals = checkTotals(d.poolCounts, 2, d.earned, d.flows);
  assert.equal(totals.held, 9007199254740992n);
  assert.equal(totals.spent, totals.destinations);
  assert.throws(() => checkTotals(d.poolCounts, 3, d.earned, d.flows));
  assert.throws(() => checkTotals(d.poolCounts, 2, d.earned, {}));
  assert.throws(() => checkTotals(d.poolCounts, 2, d.earned, { 'Binance Pool': { shielded: 2n } }));
});

test('PostgreSQL repair is repeatable, preserves financial rows, backs up exact values and rolls back stale/failed days', { skip: !databaseUrl }, async () => {
  const { Client } = require('pg'); const c = new Client({ connectionString: databaseUrl }); await c.connect();
  try {
    await c.query(`CREATE TEMP TABLE blocks(height bigint PRIMARY KEY,hash text);
      CREATE TEMP TABLE analytics_history_daily(date date PRIMARY KEY,anchor_height bigint,anchor_hash text,mining_pool_blocks jsonb,fees jsonb,financial numeric,computed_at timestamptz);
      CREATE TEMP TABLE mining_behavior_daily(date date,pool_name text,miner_address text,earned_zat bigint,spent_zat bigint,held_zat bigint,blocks_mined int,outputs_spent int,outputs_total int);
      CREATE TEMP TABLE miner_destination_daily(date date,pool_name text,shielded_zat bigint,exchange_zat bigint,bridge_zat bigint,other_zat bigint,updated_at timestamptz,PRIMARY KEY(date,pool_name));
      INSERT INTO blocks VALUES(1,'day'),(2,'tip');
      INSERT INTO analytics_history_daily VALUES('2026-10-01',1,'day','{"Mining Dutch":2}','{"minerDestinationRows":1,"blockCount":2,"median":123}',123.456,'2026-10-02T00:00:00Z');
      INSERT INTO mining_behavior_daily VALUES('2026-10-01','Mining Dutch','historical-binance',9007199254740993,1,9007199254740992,1,1,2);
      INSERT INTO miner_destination_daily VALUES('2026-10-01','Mining Dutch',1,0,0,0,now());`);
    const d = data(); d.totals = checkTotals(d.poolCounts, 2, d.earned, d.flows);
    const reports = [];
    for (let i = 0; i < 2; i++) await applyDay(c, d, record => reports.push(record));
    const row = (await c.query('SELECT * FROM analytics_history_daily')).rows[0];
    assert.deepEqual(row.mining_pool_blocks, d.poolCounts);
    assert.deepEqual(row.fees, { minerDestinationRows: 1, blockCount: 2, median: 123 });
    assert.equal(row.financial, '123.456'); assert.equal(row.computed_at.toISOString(), '2026-10-02T00:00:00.000Z');
    assert.equal(reports[0].before.behavior[0].earned_zat, '9007199254740993');
    assert.equal(reports[0].before.behavior[0].pool_name, 'Mining Dutch');
    const snapshot = (await c.query('SELECT * FROM mining_behavior_daily')).rows;
    for (const bad of [
      { ...d, anchor: { height: 2, hash: 'reorg' } },
      { ...d, totals: { ...d.totals, earned: 1n } },
    ]) {
      await assert.rejects(applyDay(c, bad, () => {}));
      assert.deepEqual((await c.query('SELECT * FROM mining_behavior_daily')).rows, snapshot);
    }
    await assert.rejects(applyDay(c, d, () => { throw new Error('Backup write failed'); }));
    assert.deepEqual((await c.query('SELECT * FROM mining_behavior_daily')).rows, snapshot);
    await c.query("UPDATE analytics_history_daily SET anchor_hash='old-fork'");
    await assert.rejects(applyDay(c, d, () => assert.fail('Must fail before backup/write')));
  } finally { await c.end(); }
});
