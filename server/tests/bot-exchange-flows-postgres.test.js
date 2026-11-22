'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const x = require('../bot/lib/exchange-flows');
const fx = require('../bot/fixtures/exchange-flows');

const T0 = 1795371364;
const USER = 't1ejN4MbrPtM8TSJ1aaj1aXnoaANFUZt3hv', DEPOSIT = 't1Tos7k6RuBQsa2nG73BHpT4BMYyQfkWhzD';
const HOT = 't1KbKkQ7WisJF52sSepMjYokQJbkJCJ1i3C', KRAKEN = 't1g47g7wNA55q5PWYHWb6X5JxzhMqwaknjC', OUT = 't1Sid7L2pEMzsU4T9raxqztJYjupQf6c4aY';
const LOOKALIKE = 't1Sid7L2pEMzsU4T9raxqztJYjupQf6cZZZ', BINANCE = 't1SzbuFRuPa5upV6c9ZgKb9V7fxn2b8NAKg';

test('FLOW_ROWS on PostgreSQL: deposit, sweep, withdrawal, poisoning and orphaned rows', {
  skip: process.env.ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_ACTIVITY_DATABASE_URL,
}, async () => {
  const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
  const admin = new Pool(connection ? { connectionString: connection } : { host: '/tmp', database: 'postgres' });
  const name = `bot_xf_${process.pid}_${Date.now()}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = connection ? new URL(connection) : null; if (url) url.pathname = `/${name}`;
    db = new Pool({ ...(url ? { connectionString: url.toString() } : { host: '/tmp', database: name }), max: 2 });
    await db.query(`CREATE TABLE blocks(height bigint PRIMARY KEY, hash text, timestamp bigint);
      CREATE TABLE transactions(txid text, block_height bigint, block_hash text, block_time bigint, is_coinbase boolean DEFAULT false,
        has_sprout boolean DEFAULT false, value_balance_sapling bigint DEFAULT 0, value_balance_orchard bigint DEFAULT 0,
        value_balance_ironwood bigint DEFAULT 0, PRIMARY KEY(txid, block_height));
      CREATE TABLE transaction_inputs(txid text, vout_index int, address text, value bigint, PRIMARY KEY(txid, vout_index));
      CREATE TABLE transaction_outputs(txid text, vout_index int, address text, value bigint, PRIMARY KEY(txid, vout_index));
      CREATE TABLE address_transactions(address text, txid text, block_height integer, tx_index integer DEFAULT 0, block_time bigint,
        PRIMARY KEY(address, block_height, tx_index, txid));
      CREATE TABLE address_labels(address text PRIMARY KEY, label text, category text);
      INSERT INTO address_labels VALUES ('${DEPOSIT}','Hyperunit Deposit','exchange'),('${HOT}','Hyperunit Hot Wallet','exchange'),
        ('${KRAKEN}','Kraken Hot Wallet','exchange'),('${BINANCE}','Binance Hot Wallet','exchange'),('t3x','NEAR Intent Bridge','bridge');`);
    const tx = async (txid, height, time, ins, outs, { hash = `h${height}`, canonical = true } = {}) => {
      if (canonical) await db.query('INSERT INTO blocks VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [height, hash, time]);
      await db.query('INSERT INTO transactions(txid,block_height,block_hash,block_time) VALUES ($1,$2,$3,$4)', [txid, height, hash, time]);
      for (const [i, [address, value]] of ins.entries()) await db.query('INSERT INTO transaction_inputs VALUES ($1,$2,$3,$4)', [txid, i, address, value]);
      for (const [i, [address, value]] of outs.entries()) await db.query('INSERT INTO transaction_outputs VALUES ($1,$2,$3,$4)', [txid, i, address, value]);
      for (const address of new Set([...ins, ...outs].map(l => l[0]))) await db.query('INSERT INTO address_transactions VALUES ($1,$2,$3,0,$4)', [address, txid, height, time]);
    };
    await tx(fx.HYPERUNIT_DEPOSIT, 100, T0, [[USER, '59600000000'], [USER, '74699980000']], [[DEPOSIT, '60200000000'], [USER, '74099970000']]);
    await tx(fx.HYPERUNIT_SWEEP, 101, T0 + 600, [[DEPOSIT, '60200000000']], [[HOT, '60199990000']]);
    await tx(fx.KRAKEN_WITHDRAWAL, 102, T0 + 700, [[KRAKEN, '1000000000000'], [KRAKEN, '1014865455163']],
      [[OUT, '500000000000'], [OUT, '500000000000'], [OUT, '500000000000'], [OUT, '500000000000'], [KRAKEN, '14864383239']]);
    await tx('d'.repeat(64), 103, T0 + 800, [[LOOKALIKE, '10000']], [[BINANCE, '0']]);
    // A transaction whose block is no longer canonical (hash mismatch) is never read.
    await tx('e'.repeat(64), 104, T0 + 900, [[USER, '900000000000']], [[HOT, '900000000000']], { hash: 'orphan', canonical: false });
    await db.query('INSERT INTO blocks VALUES (104,$1,$2)', ['h104', T0 + 900]);
    // Outside the window.
    await tx('f'.repeat(64), 105, T0 + 5000, [[USER, '900000000000']], [[HOT, '900000000000']]);

    const labels = await x.loadLabels(db);
    assert.equal(labels.addresses.length, 4, 'only exchange-category labels');
    const { events, skipped } = await x.readEvents(db, labels, T0 - 10, T0 + 1000);
    assert.deepEqual(events.map(e => [e.txid.slice(0, 6), e.entity, e.direction, e.amountZat]), [
      ['b81e91', 'hyperunit', 'deposit', '60200000000'],
      ['3b8f3e', 'kraken', 'withdrawal', '2000000000000'],
    ]);
    assert.deepEqual(skipped, { internal: 1, 'no-entity-value': 1 });
    assert.equal(typeof events[0].amountZat, 'string');
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  }
});
