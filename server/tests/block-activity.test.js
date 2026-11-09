'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

async function request(rows) {
  const queries = [];
  const app = express();
  app.locals.redisClient = null;
  app.locals.pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows }; } };
  app.use(require('../api/routes/analytics'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/network/block-activity`);
    return { status: response.status, body: await response.json(), queries };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const day = date => Date.parse(`${date}T00:00:00Z`) / 86400000;
const row = (overrides = {}) => ({ day: String(day('2026-11-08')), blocks: 4, tx_blocks: 4, transactions: '10', fee_blocks: 4, total_fees: '132000', ...overrides });

test('daily means use every block and keep the exact zatoshi sum', async () => {
  const { status, body } = await request([row()]);
  assert.equal(status, 200);
  assert.equal(body.method, 'completed_utc_days');
  assert.deepEqual(body.points, [{ date: '2026-11-08', blocks: 4, transactions: 10, txPerBlock: 2.5, totalFeesZat: '132000', feesPerBlockZec: 0.00033 }]);
});

test('the query covers 400 whole UTC days and excludes the partial current day', async () => {
  const { queries } = await request([]);
  const [from, until] = queries[0].params;
  assert.equal(until % 86400, 0);
  assert.equal(until, Math.floor(Date.now() / 86400000) * 86400);
  assert.equal(until - from, 400 * 86400);
  assert.match(queries[0].sql, /"timestamp" >= \$1 AND "timestamp" < \$2/);
});

test('a day with an unknown value is a gap for that measure, not a lower mean', async () => {
  const { body } = await request([row({ fee_blocks: 3 }), row({ day: String(day('2026-11-09')), tx_blocks: 3 })]);
  assert.equal(body.points[0].totalFeesZat, null);
  assert.equal(body.points[0].feesPerBlockZec, null);
  assert.equal(body.points[0].txPerBlock, 2.5);
  assert.equal(body.points[1].txPerBlock, null);
  assert.equal(body.points[1].transactions, null);
  assert.equal(body.points[1].feesPerBlockZec, 0.00033);
});

test('zero activity stays zero and an empty chain returns no points', async () => {
  const { body } = await request([row({ transactions: '0', total_fees: '0' })]);
  assert.equal(body.points[0].txPerBlock, 0);
  assert.equal(body.points[0].totalFeesZat, '0');
  assert.deepEqual((await request([])).body.points, []);
});
