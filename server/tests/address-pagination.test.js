const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { getFirstFunding } = require('../api/lib/address-first-funding');
const router = require('../api/routes/address');
const ADDRESS = 't3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow';

test('first funding falls back only when the history table is absent', async () => {
  let calls = 0;
  const result = await getFirstFunding(async () => {
    if (++calls === 1) throw Object.assign(new Error('missing table'), { code: '42P01' });
    return { rows: [{ txid: 'legacy' }] };
  }, ADDRESS);
  assert.equal(calls, 2);
  assert.equal(result.rows[0].txid, 'legacy');
  calls = 0;
  await assert.rejects(getFirstFunding(async () => {
    calls++;
    throw Object.assign(new Error('timeout'), { code: '57014' });
  }, ADDRESS), { code: '57014' });
  assert.equal(calls, 1, 'a timeout must not start a legacy scan');
});

test('address page 2 preserves pagination and funding units; funding failure remains optional', async () => {
  let fundingFails = false;
  const offsets = [];
  const app = express();
  app.locals.pool = { async connect() { return { query: this.query.bind(this), release() {} }; }, async query(sql, params) {
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql)) return { rows: [] };
    if (sql.includes('FROM blocks')) return { rows: [{ height: 1000, hash: 'a'.repeat(64) }] };
    if (sql.includes('FROM addresses')) return { rows: [{ address: ADDRESS, total_received: '12500000', total_sent: '0', balance: '12500000', tx_count: '75' }] };
    if (sql.includes('WITH first_receive')) {
      if (fundingFails) throw Object.assign(new Error('timeout'), { code: '57014' });
      return { rows: [{ txid: 'funding', block_time: '1732359779', amount_zat: '12500000', is_coinbase: true }] };
    }
    if (sql.includes('WITH paged')) {
      offsets.push(params);
      return { rows: Array.from({ length: 25 }, (_, i) => ({ txid: i === 0 ? 'page-2' : String(i), tx_index: i, block_height: 100, block_time: '1732359779', input_value: '0', output_value: '12500000' })) };
    }
    throw new Error('Unexpected query');
  } };
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/address/${ADDRESS}?page=2&limit=25`;
    let response = await fetch(url);
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.pagination.page, 2);
    assert.equal(body.pagination.totalPages, 3);
    assert.equal(body.transactions[0].netChange, 12500000);
    assert.equal(body.firstFunding.amountZec, 0.125);
    assert.equal(body.firstFunding.isCoinbase, true);
    fundingFails = true;
    response = await fetch(url);
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.firstFunding, null);
    assert.equal(body.transactions[0].txid, 'page-2');
    assert.deepEqual(offsets, [[ADDRESS, 25, 25, 1000], [ADDRESS, 25, 25, 1000]]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('TEX addresses (ZIP 320) serve the history and graph of the P2PKH address they re-encode', async () => {
  const TEX = 'tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte';
  const P2PKH = 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC';
  const queried = [];
  const app = express();
  app.locals.pool = { async connect() { return { query: this.query.bind(this), release() {} }; }, async query(sql, params) {
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql)) return { rows: [] };
    if (params) queried.push(params[0]);
    if (sql.includes('FROM blocks')) return { rows: [{ height: 1000, hash: 'a'.repeat(64) }] };
    if (sql.includes('FROM addresses')) return { rows: [{ address: P2PKH, total_received: '12500000', total_sent: '0', balance: '12500000', tx_count: '1' }] };
    if (sql.includes('WITH paged')) return { rows: [{ txid: 'tex-payment', tx_index: 0, block_height: 100, block_time: '1732359779', input_value: '0', output_value: '12500000' }] };
    return { rows: [] };
  } };
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/address`;
    let response = await fetch(`${base}/${TEX}`);
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.address, TEX, 'the response keeps the address that was asked for');
    assert.equal(body.transparentAddress, P2PKH);
    assert.equal(body.balanceZat, '12500000');
    assert.equal(body.transactions[0].txid, 'tex-payment');
    response = await fetch(`${base}/${TEX}/graph`);
    body = await response.json();
    assert.equal(body.address, P2PKH);
    assert.ok(queried.length > 0 && queried.every(value => value === P2PKH), 'every lookup uses the P2PKH form');
    for (const invalid of [`${TEX.slice(0, -1)}q`, 'tex1not-an-address']) {
      response = await fetch(`${base}/${invalid}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'Invalid TEX address' });
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('PostgreSQL: earliest inbound follows chain order and preserves zero outputs and funder labels', {
  skip: !process.env.ADDRESS_TEST_DATABASE_URL,
}, async t => {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.ADDRESS_TEST_DATABASE_URL });
  await db.connect();
  t.after(() => db.end());
  // Session-local tables only; never alter real address history.
  await db.query(`
    CREATE TEMP TABLE address_transactions(address text, txid text, block_height int, tx_index int, block_time bigint, is_output boolean);
    CREATE TEMP TABLE transactions(txid text, block_height int, block_time bigint, is_coinbase boolean);
    CREATE TEMP TABLE transaction_outputs(txid text, address text, vout_index int, value bigint);
    CREATE TEMP TABLE transaction_inputs(txid text, address text, value bigint);
    CREATE TEMP TABLE address_labels(address text, label text);
    INSERT INTO address_transactions VALUES ('a','spend',1,0,100,false), ('a','later',2,2,200,true), ('a','first',2,1,200,true), ('a','new',3,0,300,true);
    INSERT INTO transactions VALUES ('spend',1,100,false), ('later',2,200,false), ('first',2,200,false), ('new',3,300,true);
    INSERT INTO transaction_outputs VALUES ('later','a',0,999), ('first','other',0,111), ('first','a',2,55), ('first','a',1,0), ('new','a',0,12500000);
    INSERT INTO transaction_inputs VALUES ('first','a',1000), ('first','small',20), ('first','funder',30);
    INSERT INTO address_labels VALUES ('funder','Known funder');
  `);
  const query = db.query.bind(db);
  let { rows } = await getFirstFunding(query, 'a');
  assert.deepEqual(rows[0], { txid: 'first', block_time: '200', amount_zat: '0', is_coinbase: false, funder_address: 'funder', funder_label: 'Known funder' });
  assert.deepEqual((await getFirstFunding(query, 'empty')).rows, []);
  await db.query("DELETE FROM address_transactions WHERE block_height < 3");
  ({ rows } = await getFirstFunding(query, 'a'));
  assert.equal(rows[0].txid, 'new');
  assert.equal(rows[0].is_coinbase, true);
  assert.equal(rows[0].funder_address, null);
  await db.query('DROP TABLE address_transactions');
  ({ rows } = await getFirstFunding(query, 'a'));
  assert.equal(rows[0].txid, 'later', 'pre-migration installations retain the legacy query');
});
