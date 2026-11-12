'use strict';
// Real PostgreSQL fixture for shielded-rate classification (migration 044).
// Run: CROSSCHAIN_SHIELDING_POSTGRES=1 DB_HOST=... DB_NAME=<disposable> npm run test:crosschain-shielding-postgres
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifySwaps, findUnclassified, findOpen, findChanged, readShielding, parseShieldingFilters } = require('../lib/crosschain/shielding');

const enabled = process.env.CROSSCHAIN_SHIELDING_POSTGRES === '1' || Boolean(process.env.TEST_CROSSCHAIN_SHIELDING_DATABASE_URL);
const strip = (sql) => sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
const v2Sql = strip(fs.readFileSync(path.join(__dirname, '../scripts/create-crosschain-v2.sql'), 'utf8'));
const migration = strip(fs.readFileSync(path.join(__dirname, '../deploy/sql/044_crosschain_shielding.sql'), 'utf8'));

const T = (n) => n.toString(16).padStart(64, '0');
const ARRIVE = 1793000000; // fixed epoch seconds
const TADDR = 't1RecipientAAAAAAAAAAAAAAAAAAAAAAAA';

async function withFixture(fn) {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.TEST_CROSSCHAIN_SHIELDING_DATABASE_URL,
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await db.connect();
  // classifySwaps manages its own transaction, so isolate with a temp schema.
  const schema = `cs_test_${process.pid}_${Date.now()}`;
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}, pg_temp`);
    await db.query(`
      CREATE TABLE transactions (txid text PRIMARY KEY, block_height bigint, block_time bigint);
      CREATE TABLE transaction_outputs (txid text, vout_index int, address text, value bigint, PRIMARY KEY (txid, vout_index));
      CREATE TABLE transaction_inputs (txid text, vout_index int, prev_txid text, prev_vout int, PRIMARY KEY (txid, vout_index));
      CREATE TABLE shielded_flows (id serial, txid text, flow_type text, pool text, amount_zat bigint, block_time bigint);
      CREATE TABLE address_labels (address text PRIMARY KEY, category text);`);
    await db.query(v2Sql.replace(/public\./g, ''));
    await db.query(migration.replace(/public\./g, ''));
    await fn(db);
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await db.end();
  }
}

async function swap(db, id, { recipient = TADDR, zecTx = null, status = 'SUCCESS', amount = '1.5', chain = 'eth', created = '2026-11-01T00:00:00Z', recipientType = 'DESTINATION_CHAIN' } = {}) {
  const payload = { recipient, recipientType, destinationChainTxHashes: zecTx ? [zecTx] : [], originChainTxHashes: ['0xsrc' + id] };
  await db.query(`INSERT INTO crosschain_swaps_v2 (deposit_address, deposit_memo, status, swap_created_at, source_chain, source_token,
    dest_chain, dest_token, dest_amount, payload) VALUES ($1,'',$2,$3,$4,'ETH','zec','ZEC',$5,$6)`,
  [`dep${id}`, status, created, chain, amount, payload]);
}
const tx = (db, txid, time = ARRIVE) => db.query('INSERT INTO transactions VALUES ($1, 1, $2)', [txid, time]);
const out = (db, txid, vout, address, value) => db.query('INSERT INTO transaction_outputs VALUES ($1,$2,$3,$4)', [txid, vout, address, value]);
const spend = (db, txid, prev, vout = 0) => db.query('INSERT INTO transaction_inputs VALUES ($1,0,$2,$3)', [txid, prev, vout]);
const flow = (db, txid, type) => db.query("INSERT INTO shielded_flows (txid, flow_type, pool, amount_zat, block_time) VALUES ($1,$2,'orchard',1,1)", [txid, type]);
const row = async (db, id) => (await db.query("SELECT * FROM crosschain_shielding WHERE deposit_address=$1", [`dep${id}`])).rows[0];

test('period validation', () => {
  assert.equal(parseShieldingFilters({}).period, '90d');
  assert.throws(() => parseShieldingFilters({ period: '7d' }), /Invalid period/);
  assert.throws(() => parseShieldingFilters({ period: ['30d'] }), /single strings/);
});

test('classifies arrivals and one-hop outcomes with exact zatoshis', { skip: !enabled }, async () => {
  await withFixture(async (db) => {
    // 1: transparent, shielded on next spend 30 minutes later
    await swap(db, 1, { zecTx: T(1) }); await tx(db, T(1)); await out(db, T(1), 0, TADDR, 150000000);
    await out(db, T(1), 1, 't1NearChangeXXXXXXXXXXXXXXXXXXXXXXX', 999);
    await tx(db, T(101), ARRIVE + 1800); await spend(db, T(101), T(1)); await flow(db, T(101), 'shield');
    // 2: transparent, held
    await swap(db, 2, { zecTx: T(2), amount: '2' }); await tx(db, T(2)); await out(db, T(2), 0, TADDR, 200000000);
    // 3: transparent, sent to exchange
    await swap(db, 3, { zecTx: T(3), amount: '1' }); await tx(db, T(3)); await out(db, T(3), 0, TADDR, 100000000);
    await tx(db, T(103)); await spend(db, T(103), T(3)); await out(db, T(103), 0, 't1Exchange', 99990000);
    await db.query("INSERT INTO address_labels VALUES ('t1Exchange','exchange')");
    // 4: direct shielded delivery to a unified address (provider amount)
    await swap(db, 4, { zecTx: T(4), recipient: 'u1shieldedrecipient', amount: '0.25' }); await tx(db, T(4)); await flow(db, T(4), 'shield');
    // 5: no Zcash hash reported; 6: hash not indexed; 7: UA without shield flow; 8: failed swap
    await swap(db, 5); await swap(db, 6, { zecTx: T(6) });
    await swap(db, 7, { zecTx: T(7), recipient: 'u1other' }); await tx(db, T(7));
    await swap(db, 8, { zecTx: T(8), status: 'REFUNDED' });
    // 9: credited to a NEAR Intents balance (never on Zcash); 10: NEAR hash reported as the destination tx
    await swap(db, 9, { recipient: 'dc61c06abe9332fb539f7e0738e3d268c64ba8ee74214557a096534749b94b77', recipientType: 'INTENTS' });
    await swap(db, 10, { zecTx: '5oA4ALFbSmryHbf7ehiz9iSJzaFfoLgFkgLDQbQf72oY' });

    const targets = await findUnclassified(db, { v2: true, limit: 100 });
    assert.equal(targets.length, 8, 'refunded and Intents-balance swaps are not candidates');
    assert.equal(await classifySwaps(db, targets, { v2: true }), 8);
    assert.equal(await row(db, 9), undefined);
    assert.equal((await row(db, 10)).arrival, 'no_zec_tx', 'a NEAR hash is not a Zcash delivery');
    assert.equal((await row(db, 10)).zec_txid, null);

    const r1 = await row(db, 1);
    assert.equal(r1.arrival, 'transparent');
    assert.equal(r1.delivered_zat, '150000000', 'only recipient outputs count, not change');
    assert.equal(r1.shielded_zat, '150000000');
    assert.equal(r1.first_shield_block_time - r1.arrival_block_time, 1800);
    assert.equal((await row(db, 2)).held_zat, '200000000');
    assert.equal((await row(db, 3)).exchange_zat, '100000000');
    const r4 = await row(db, 4);
    assert.deepEqual([r4.arrival, r4.delivered_zat, r4.amount_source], ['shielded', '25000000', 'provider_reported']);
    assert.equal((await row(db, 5)).arrival, 'no_zec_tx');
    assert.equal((await row(db, 6)).arrival, 'tx_not_indexed');
    assert.equal((await row(db, 7)).arrival, 'unmatched');

    // Held output later shielded; late-indexed tx; both are rechecked as open rows.
    await tx(db, T(102), ARRIVE + 60); await spend(db, T(102), T(2)); await flow(db, T(102), 'shield');
    await tx(db, T(6)); await out(db, T(6), 0, TADDR, 50000000);
    await db.query("UPDATE crosschain_shielding SET classified_at = now() - interval '1 hour'");
    const open = await findOpen(db, { limit: 100, days: 100000 });
    assert.deepEqual(open.map((o) => o.address).sort(), ['dep2', 'dep6', 'dep7']);
    await classifySwaps(db, open, { v2: true });
    assert.equal((await row(db, 2)).shielded_zat, '200000000');
    assert.equal((await row(db, 6)).arrival, 'transparent');

    // Provider status change removes the row on recheck.
    await db.query("UPDATE crosschain_swaps_v2 SET status='REFUNDED', last_seen_at=now() WHERE deposit_address='dep3'");
    const changed = await findChanged(db, { v2: true, limit: 100 });
    assert.ok(changed.some((c) => c.address === 'dep3'));
    await classifySwaps(db, changed, { v2: true });
    assert.equal(await row(db, 3), undefined);

    // Reader: covered = 1 (1.5) + 2 (2) + 4 (0.25) + 6 (0.5) = 4.25 ZEC; shielded = 1.5 + 2 + 0.25.
    const result = await readShielding(db, { period: 'all' }, { v2: true });
    const s = result.summary;
    assert.equal(s.swaps, 7);
    assert.equal(s.coveredSwaps, 4);
    assert.deepEqual(s.uncovered, { noZecTx: 2, txNotIndexed: 0, unmatched: 1 });
    assert.equal(s.coveredZat, '425000000');
    assert.equal(s.shieldedZat, '375000000');
    assert.equal(s.shieldedRate, 0.8823);
    assert.equal(s.breakdownZat.held, '50000000');
    assert.equal(result.coverage.sourceSwaps, 7);
    assert.equal(result.coverage.intentsBalanceSwaps, 1);
    assert.equal(result.coverage.pendingClassification, 0);
    assert.equal(result.timeToShield.samples, 2);
    assert.equal(result.daily.length, 1);
  });
});

test('empty index returns null rates, not zero', { skip: !enabled }, async () => {
  await withFixture(async (db) => {
    const result = await readShielding(db, { period: '30d' }, { v2: true });
    assert.equal(result.summary.swaps, 0);
    assert.equal(result.summary.shieldedRate, null);
    assert.equal(result.summary.shieldedZat, null);
    assert.equal(result.summary.swapCoverage, null);
    assert.deepEqual(result.daily, []);
  });
});
