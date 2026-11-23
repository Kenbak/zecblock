'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const x = require('../lib/exchange-flows');
const store = require('../lib/exchange-flow-store');
const botX = require('../bot/lib/exchange-flows');

const T0 = 1795371364; // 2026-11-22T13:36:04Z
const USER = 't1ejN4MbrPtM8TSJ1aaj1aXnoaANFUZt3hv', DEPOSIT = 't1Tos7k6RuBQsa2nG73BHpT4BMYyQfkWhzD';
const HOT = 't1KbKkQ7WisJF52sSepMjYokQJbkJCJ1i3C', KRAKEN = 't1g47g7wNA55q5PWYHWb6X5JxzhMqwaknjC', OUT = 't1Sid7L2pEMzsU4T9raxqztJYjupQf6c4aY';
const BINANCE = 't1SzbuFRuPa5upV6c9ZgKb9V7fxn2b8NAKg', NEWKRAKEN = 't1NewKrakenWa11etAddre55xxxxxxxxxxx';
const MIGRATION = fs.readFileSync(path.join(__dirname, '../deploy/migrations/026_exchange_flows.sql'), 'utf8');

async function withDatabase(fn) {
  const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
  const admin = new Pool(connection ? { connectionString: connection } : { host: '/tmp', database: 'postgres' });
  const name = `xf_store_${process.pid}_${Date.now()}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = connection ? new URL(connection) : null; if (url) url.pathname = `/${name}`;
    db = new Pool({ ...(url ? { connectionString: url.toString() } : { host: '/tmp', database: name }), max: 3 });
    await fn(db);
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  }
}

const SCHEMA = `CREATE TABLE blocks(height bigint PRIMARY KEY, hash text, timestamp bigint);
  CREATE TABLE transactions(txid text PRIMARY KEY, block_height bigint, block_hash text, block_time bigint, is_coinbase boolean DEFAULT false,
    has_sprout boolean DEFAULT false, value_balance_sapling bigint DEFAULT 0, value_balance_orchard bigint DEFAULT 0, value_balance_ironwood bigint DEFAULT 0);
  CREATE TABLE transaction_inputs(txid text, vout_index int, address text, value bigint, PRIMARY KEY(txid, vout_index));
  CREATE TABLE transaction_outputs(txid text, vout_index int, address text, value bigint, PRIMARY KEY(txid, vout_index));
  CREATE TABLE address_transactions(address text, txid text, block_height integer, tx_index integer DEFAULT 0, block_time bigint,
    PRIMARY KEY(address, block_height, tx_index, txid));
  CREATE TABLE address_labels(address text PRIMARY KEY, label text, category text);`;

function writer(db) {
  const tx = async (txid, height, time, ins, outs, { hash = `h${height}`, vb = 0 } = {}) => {
    await db.query('INSERT INTO blocks VALUES ($1,$2,$3) ON CONFLICT (height) DO UPDATE SET hash = EXCLUDED.hash, timestamp = EXCLUDED.timestamp', [height, hash, time]);
    await db.query(`INSERT INTO transactions(txid,block_height,block_hash,block_time,value_balance_orchard) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (txid) DO UPDATE SET block_height = EXCLUDED.block_height, block_hash = EXCLUDED.block_hash, block_time = EXCLUDED.block_time`, [txid, height, hash, time, vb]);
    await db.query('DELETE FROM transaction_inputs WHERE txid = $1', [txid]);
    await db.query('DELETE FROM transaction_outputs WHERE txid = $1', [txid]);
    for (const [i, [address, value]] of ins.entries()) await db.query('INSERT INTO transaction_inputs VALUES ($1,$2,$3,$4)', [txid, i, address, value]);
    for (const [i, [address, value]] of outs.entries()) await db.query('INSERT INTO transaction_outputs VALUES ($1,$2,$3,$4)', [txid, i, address, value]);
    for (const address of new Set([...ins, ...outs].map(l => l[0]))) await db.query('INSERT INTO address_transactions VALUES ($1,$2,$3,0,$4) ON CONFLICT DO NOTHING', [address, txid, height, time]);
  };
  const block = (height, time, hash = `h${height}`) => db.query('INSERT INTO blocks VALUES ($1,$2,$3) ON CONFLICT (height) DO UPDATE SET hash = EXCLUDED.hash', [height, hash, time]);
  return { tx, block };
}

const txid = c => c.repeat(64);
const rowsOf = async db => (await db.query(`SELECT left(txid, 4) AS t, entity, direction, amount_zat::text AS z, block_height AS h, day::text, counterparty
  FROM exchange_flows ORDER BY block_height, txid, entity`)).rows.map(r => [r.t, r.entity, r.direction, r.z, Number(r.h), r.day, r.counterparty]);
const dailyOf = async db => (await db.query(`SELECT day::text, entity, deposits_zat::text AS d, withdrawals_zat::text AS w, deposit_count AS dn, withdrawal_count AS wn
  FROM exchange_flow_daily ORDER BY day, entity`)).rows.map(r => [r.day, r.entity, r.d, r.w, r.dn, r.wn]);

test('exchange flow store on PostgreSQL: rebuild, incremental, reorg, label repair, readers', {
  skip: process.env.ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_ACTIVITY_DATABASE_URL,
}, async () => withDatabase(async db => {
  await db.query(SCHEMA);
  await db.query(MIGRATION);
  await db.query(`INSERT INTO address_labels VALUES ('${DEPOSIT}','Hyperunit Deposit','exchange'),('${HOT}','Hyperunit Hot Wallet','exchange'),
    ('${KRAKEN}','Kraken Hot Wallet','exchange'),('${BINANCE}','Binance Hot Wallet','exchange'),('t1unknownexch','Some New Exchange','exchange'),('t3x','NEAR Intent Bridge','bridge')`);
  const { tx, block } = writer(db);
  const client = await db.connect();
  try {
    // Unavailable before any rebuild: never zero.
    assert.equal((await store.status(db)).status, 'unavailable');
    await assert.rejects(store.dailyFlows(db, { from: '2026-11-21', to: '2026-11-22' }, { now: T0 * 1000 }), e => e.status === 503);
    assert.equal((await store.refresh(client, { labels: await x.loadLabels(db) })).action, 'not-built');

    await block(1, T0 - 3 * 86400);
    await tx(txid('a'), 100, T0 - 86400, [[USER, '134299980000']], [[DEPOSIT, '60200000000'], [USER, '74099970000']]); // deposit, previous day
    await tx(txid('b'), 101, T0, [[DEPOSIT, '60200000000']], [[HOT, '60199990000']]); // sweep: internal
    await tx(txid('c'), 102, T0 + 10, [[KRAKEN, '2014865455163']], [[OUT, '2000000000000'], [KRAKEN, '14864383239']]); // withdrawal
    await tx(txid('d'), 103, T0 + 20, [[BINANCE, '150010000000']], [[BINANCE, '0']], { vb: -150000000000 }); // into a shielded pool
    await tx(txid('e'), 104, T0 + 30, [[KRAKEN, '500']], [[BINANCE, '400']]); // between entities: skipped
    await tx(txid('f'), 105, T0 + 40, [[USER, '7']], [['t1unknownexch', '7']]); // unnamed entity: not stored
    await block(110, T0 + 100);

    const labels = await x.loadLabels(db);
    const r = await store.rebuild(client, { labels, batchBlocks: 3 });
    assert.ok(r.batches >= 30, 'batched over the full height range');
    assert.deepEqual(r.skipped, { internal: 1, 'between-entities': 1 });
    assert.deepEqual(await rowsOf(db), [
      ['aaaa', 'hyperunit', 'deposit', '60200000000', 100, '2026-11-21', 'transparent'],
      ['cccc', 'kraken', 'withdrawal', '2000000000000', 102, '2026-11-22', 'transparent'],
      ['dddd', 'binance', 'withdrawal', '150000000000', 103, '2026-11-22', 'shielded'],
    ]);
    assert.deepEqual(await dailyOf(db), [
      ['2026-11-21', 'hyperunit', '60200000000', '0', 1, 0],
      ['2026-11-22', 'binance', '0', '150000000000', 0, 1],
      ['2026-11-22', 'kraken', '0', '2000000000000', 0, 1],
    ]);
    let st = await store.status(db);
    assert.equal(st.status, 'ok');
    assert.equal(st.state.through_height, 110);

    // Readers: covered zero days are zero, uncovered days are null, totals null if any day is uncovered.
    const daily = await store.dailyFlows(db, { from: '2026-11-18', to: '2026-11-23' }, { now: (T0 + 86400) * 1000 });
    assert.deepEqual(daily.days.map(d => [d.date, d.coverage, d.depositsZat, d.netZat]), [
      ['2026-11-18', 'none', null, null],
      ['2026-11-19', 'complete', '0', '0'],
      ['2026-11-20', 'complete', '0', '0'],
      ['2026-11-21', 'complete', '60200000000', '60200000000'],
      ['2026-11-22', 'partial', '0', '-2150000000000'],
      ['2026-11-23', 'none', null, null],
    ]);
    assert.equal(daily.totals, null);
    const kraken = await store.dailyFlows(db, { entity: 'kraken', from: '2026-11-21', to: '2026-11-22' }, { now: T0 * 1000 });
    assert.deepEqual(kraken.totals, { depositsZat: '0', withdrawalsZat: '2000000000000', netZat: '-2000000000000', depositCount: 0, withdrawalCount: 1 });
    assert.equal(kraken.status, 'ok');

    // Incremental: a new block, then a tip reorg that replaces block 111 and orphans its withdrawal.
    await tx(txid('1'), 111, T0 + 200, [[KRAKEN, '900000000000']], [[OUT, '900000000000']]);
    let inc = await store.refresh(client, { labels });
    assert.equal(inc.action, 'incremental');
    assert.equal((await rowsOf(db)).length, 4);
    await db.query(`UPDATE blocks SET hash = 'h111b' WHERE height = 111`);
    await tx(txid('2'), 111, T0 + 210, [[USER, '300000000000']], [[HOT, '300000000000']], { hash: 'h111b' });
    inc = await store.refresh(client, { labels });
    assert.equal(inc.reorged, true);
    assert.deepEqual((await rowsOf(db)).map(r => r[0]), ['aaaa', 'cccc', 'dddd', '2222'], 'orphaned withdrawal gone, replacement deposit in');
    assert.deepEqual((await dailyOf(db)).find(d => d[1] === 'kraken'), ['2026-11-22', 'kraken', '0', '2000000000000', 0, 1]);

    // Behind the tip: stale.
    for (let h = 112; h <= 140; h++) await block(h, T0 + 300 + h);
    assert.deepEqual([(await store.status(db)).status, (await store.status(db)).reason], ['stale', 'behind-tip']);
    await store.refresh(client, { labels });
    assert.equal((await store.status(db)).status, 'ok');

    // Rank and 24h net from stored rows match the in-memory contract.
    const stored = await store.recentEvents(db, 0, T0 + 10_000);
    for (const event of stored) assert.deepEqual(await store.rankStored(db, event), botX.rankEvent(event, stored));
    assert.deepEqual(await store.netStored(db, T0 + 1000), botX.netFlow(stored, T0 + 1000));
    assert.deepEqual(await store.netStored(db, T0 + 1000, 'kraken'), botX.netFlow(stored, T0 + 1000, 'kraken'));

    // A label added later applies retroactively: the stored data reads stale until repaired,
    // and the repair matches a full rebuild exactly.
    await tx(txid('3'), 141, T0 + 500, [[NEWKRAKEN, '42000000000']], [[OUT, '42000000000']]);
    await tx(txid('4'), 142, T0 + 600, [[USER, '10000000000']], [[NEWKRAKEN, '10000000000']]);
    await store.refresh(client, { labels });
    await db.query(`INSERT INTO address_labels VALUES ('${NEWKRAKEN}','Kraken Cold Wallet','exchange')`);
    assert.deepEqual([(await store.status(db)).status, (await store.status(db)).reason], ['stale', 'labels-changed']);
    const labels2 = await x.loadLabels(db);
    const deferred = await store.refresh(client, { labels: labels2, maxAffected: 1 });
    assert.equal(deferred.deferred, true);
    assert.equal((await store.status(db)).reason, 'labels-changed', 'deferred repair stays stale');
    const repaired = await store.refresh(client, { labels: labels2 });
    assert.equal(repaired.repair.affected, 2);
    assert.equal((await store.status(db)).status, 'ok');
    const afterRepair = [await rowsOf(db), await dailyOf(db)];
    assert.ok(afterRepair[0].some(r => r[0] === '3333' && r[1] === 'kraken' && r[2] === 'withdrawal'));
    assert.ok(afterRepair[0].some(r => r[0] === '4444' && r[1] === 'kraken' && r[2] === 'deposit'));
    await store.rebuild(client, { labels: labels2, batchBlocks: 50 });
    assert.deepEqual([await rowsOf(db), await dailyOf(db)], afterRepair, 'targeted repair equals full rebuild');
    const versions = await db.query('SELECT DISTINCT label_version FROM exchange_flows UNION SELECT DISTINCT label_version FROM exchange_flow_daily');
    assert.deepEqual(versions.rows.map(r => r.label_version), [labels2.version]);

    // An interrupted rebuild blocks incremental runs and reads stale; --rebuild resumes it.
    await client.query(`UPDATE exchange_flow_state SET rebuild_label_version = $1, rebuild_next_height = 100`, [labels2.version]);
    assert.equal((await store.refresh(client, { labels: labels2 })).action, 'rebuild-in-progress');
    assert.equal((await store.status(db)).reason, 'rebuild-in-progress');
    const resumed = await store.rebuild(client, { labels: labels2, batchBlocks: 50 });
    assert.equal(resumed.batches, 1);
    assert.deepEqual([await rowsOf(db), await dailyOf(db)], afterRepair);
    assert.equal((await store.status(db)).status, 'ok');
  } finally {
    client.release();
  }
}));

test('stored rank on PostgreSQL: other events in the same block count, the ranked row and later blocks do not', {
  skip: process.env.ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_ACTIVITY_DATABASE_URL,
}, async () => withDatabase(async db => {
  await db.query(SCHEMA);
  await db.query(MIGRATION);
  const zec = n => (BigInt(n) * 100000000n).toString();
  const row = (t, entity, amount, height, time) => ({ txid: txid(t), entity, direction: 'deposit', amountZat: zec(amount), blockHeight: height, blockHash: `h${height}`, blockTime: time, counterparty: 'transparent' });
  const history = Array.from({ length: 40 }, (_, i) => row(i.toString(16).padStart(2, '0').repeat(32).slice(0, 64), 'kraken', 10 + i, 1000 + i, T0 - 86400 + i * 60));
  const small = row('a', 'hyperunit', 600, 2000, T0), big = row('b', 'hyperunit', 2000, 2000, T0);
  const sameTxOtherEntity = row('a', 'kraken', 50, 2000, T0); // same txid, other entity: counts
  const later = row('c', 'binance', 5000, 2001, T0);           // later block, same timestamp: never counts
  const all = [...history, small, big, sameTxOtherEntity, later];
  for (const e of all) await db.query(`INSERT INTO exchange_flows VALUES ($1,$2,$3,$4,$5,$6::bigint,(to_timestamp($6::bigint) AT TIME ZONE 'UTC')::date,$7,$8,'v')`,
    [e.txid, e.entity, e.direction, e.blockHeight, e.blockHash, e.blockTime, e.amountZat, e.counterparty]);

  const r = await store.rankStored(db, small);
  assert.equal(r.sample_count, 42, 'history, the same-block 2,000 ZEC deposit and the same-tx kraken row; not itself, not the later block');
  assert.equal(r.greater_count, 1, 'the 2,000 ZEC deposit in the same block outranks it');
  assert.equal(r.distribution.total, 42);
  assert.equal((await store.rankStored(db, big)).greater_count, 0);
  // Same sample as the in-memory rank (which has no later-block rows to exclude by timestamp alone).
  const inMemory = all.filter(e => e !== later);
  for (const e of [small, big]) assert.deepEqual(await store.rankStored(db, e), botX.rankEvent(e, inMemory));
}));
