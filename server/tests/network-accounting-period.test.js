'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerNetworkReadinessRoutes } = require('../api/routes/network-readiness');
const { periodPayload, PERIOD_SQL } = require('../api/lib/accounting-period');
const info = { chain: 'test', blocks: 4465027, bestblockhash: 'tip', upgrades: {
  'blossom': { name: 'Blossom', activationheight: 584000 },
  '77190ad9': { name: 'NU7', activationheight: 4465026, status: 'active' },
} };
const totals = { blocks: 2, feeBlocks: 2, missingBlocks: 0, nsmSamples: 2,
  feesPaidZat: '6', feesToNsmZat: '2', minerFeeAllocationZat: '4', firstHeight: 4465026, lastHeight: 4465027 };
const row = { totals, selected: totals, bucket_seconds: '300', points: [],
  baseline: { height: 4465025, hash: 'baseline', balance: '9007199254740993' },
  tip: { height: 4465027, hash: 'tip', balance: '9007199254740995' } };
async function withRoute({ chainInfo = info, result = row, canonical = true } = {}, fn) {
  const queries = []; const rpc = [];
  const app = express(); const router = express.Router();
  app.locals.pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [result] }; } };
  app.locals.callZebraRPC = async (method, params) => { rpc.push({method, params});
    if (method === 'getblockchaininfo') return chainInfo;
    return (typeof canonical === 'function' ? canonical() : canonical) ? params[0] === 4465025 ? 'baseline' : 'tip' : 'orphan';
  };
  registerNetworkReadinessRoutes(router); app.use(router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`, queries, rpc); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('period mode exposes exact values, full activation bounds and separate reserve growth', async () => {
  await withRoute({}, async (base, queries, rpc) => {
    for (const period of ['1d', '7d', '30d', 'all']) {
      const response = await fetch(`${base}/api/network/accounting/history?period=${period}`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.period, period); assert.equal(data.totals.feesToNsmZat, '2');
      assert.equal(data.reserve.growthSinceNu7Zat, '2'); assert.equal(data.reserve.baselineZat, '9007199254740993');
    }
    assert.equal(queries.length, 4);
    assert.deepEqual(queries[3].params, [4465027, 4465026, 'test', null]);
    assert.ok(queries[0].params[3] >= Math.floor(Date.now()/1000)-86402);
    assert.equal(rpc.filter(r => r.method === 'getblockhash').length, 8);
  });
});
test('ambiguous pagination/period combinations and unknown periods are rejected before querying', async () => {
  await withRoute({}, async (base, queries) => {
    for (const query of ['period=30', 'period=1d&limit=120', 'period=all&before=4465027', 'period=all&period=1d']) {
      assert.equal((await fetch(`${base}/api/network/accounting/history?${query}`)).status, 400);
    }
    assert.equal(queries.length, 0);
  });
});
test('preactivation and unscheduled networks never serve NU7 aggregates', async () => {
  for (const chainInfo of [{...info, blocks:4465025}, {...info, upgrades:{}}]) {
    await withRoute({chainInfo}, async (base, queries) => {
      assert.equal((await fetch(`${base}/api/network/accounting/history?period=all`)).status, 503);
      assert.equal(queries.length, 0);
    });
  }
});
test('cache hits coalesce database reads but revalidate canonical anchors', async () => {
  await withRoute({}, async (base, queries, rpc) => {
    await Promise.all(Array.from({length:5}, () => fetch(`${base}/api/network/accounting/history?period=all`)));
    assert.equal(queries.length, 1);
    assert.equal(rpc.filter(r => r.method === 'getblockhash').length, 10);
  });
  let matches = true;
  await withRoute({canonical:() => matches}, async (base, queries) => {
    assert.equal((await fetch(`${base}/api/network/accounting/history?period=all`)).status, 200);
    matches = false;
    assert.equal((await fetch(`${base}/api/network/accounting/history?period=all`)).status, 503);
    assert.equal(queries.length, 1, 'cached anchors are rechecked after a same-height reorg');
  });
});
test('missing baseline/end observations never become zero or inferred fee totals', () => {
  for (const change of [{baseline:null}, {tip:{...row.tip,balance:null}}]) {
    const data = periodPayload({...row,...change}, 'all', {}, info, 'now');
    assert.equal(data.reserve.growthSinceNu7Zat, null);
  }
  assert.match(PERIOD_SQL, /floor\(paid\*3\/5\)/);
  assert.match(PERIOD_SQL, /a\.height=b\.height AND a\.hash=b\.hash AND a\.chain=\$3/);
});

// Run against a temporary PostgreSQL schema to exercise real numeric/window
// semantics, per-block rounding, missing fees and orphan observation exclusion.
test('PostgreSQL buckets retain exact rounding, selected boundaries, gaps and canonical reserve samples',
  {skip: !process.env.TEST_ACCOUNTING_DATABASE_URL}, async () => {
    const { Client } = require('pg'); const client = new Client({connectionString:process.env.TEST_ACCOUNTING_DATABASE_URL});
    await client.connect();
    try {
      await client.query(`BEGIN;
        CREATE TEMP TABLE blocks(height bigint,hash text,timestamp bigint,transaction_count int);
        CREATE TEMP TABLE transactions(txid text,block_height bigint,block_hash text,is_coinbase boolean,fee bigint,
          total_output bigint,value_balance_sapling bigint,value_balance_orchard bigint,value_balance_ironwood bigint);
        CREATE TEMP TABLE node_accounting_observations(height bigint,hash text,chain text,nsm_balance_zat bigint,subsidy jsonb);
        INSERT INTO blocks VALUES(99,'base',599,1),(100,'a',600,2),(101,'b',610,2),(102,'c',920,1);
        INSERT INTO transactions VALUES('ca',100,'a',true,0,100,0,0,0),('ta',100,'a',false,3,0,0,0,0),
          ('cb',101,'b',true,0,100,0,0,0),('tb',101,'b',false,3,0,0,0,0),('cc',102,'c',true,0,100,0,0,0);
        INSERT INTO node_accounting_observations VALUES(99,'base','test',9007199254740993,'{"founders":0,"fundingstreamstotal":0}'),
          (100,'a','test',9007199254740994,'{"founders":0,"fundingstreamstotal":0}'),
          (101,'b','test',9007199254740995,'{"founders":0,"fundingstreamstotal":0}'),
          (102,'orphan','test',1,'{"founders":0,"fundingstreamstotal":0}');`);
      let result = (await client.query(PERIOD_SQL, [102,100,'test',null])).rows[0];
      assert.equal(result.totals.feesPaidZat,'6'); assert.equal(result.totals.feesToNsmZat,'2');
      assert.equal(result.points[0].minerReceiptsZat,'200');
      assert.equal(result.points[0].nsmBalanceZat,'9007199254740995');
      assert.equal(result.points[1].nsmBalanceZat,null); assert.equal(result.tip.balance,null);
      assert.equal(result.points[1].cumulativeRemovalZat,'2');
      result = (await client.query(PERIOD_SQL, [102,100,'test',605])).rows[0];
      assert.equal(result.selected.feesPaidZat,'3'); assert.equal(result.points[0].feesToNsmZat,'1');
      assert.equal(result.points[0].cumulativeRemovalZat,'2');
      await client.query('UPDATE transactions SET fee=NULL WHERE txid=\'tb\'');
      result = (await client.query(PERIOD_SQL, [102,100,'test',null])).rows[0];
      assert.equal(result.totals.feesPaidZat,null); assert.equal(result.points[0].feesToNsmZat,null);
      assert.equal(result.points[1].cumulativeRemovalZat,null);
      await client.query("DELETE FROM blocks WHERE height=101; DELETE FROM transactions WHERE block_height=101;");
      result = (await client.query(PERIOD_SQL, [102,100,'test',null])).rows[0];
      assert.equal(result.totals.missingBlocks,1); assert.equal(result.totals.feesPaidZat,null);
      assert.equal(result.points[1].cumulativeRemovalZat,null);
      await client.query(`TRUNCATE blocks,transactions,node_accounting_observations;
        INSERT INTO blocks SELECT h,'block-'||h,100000+h*25,2 FROM generate_series(100,6100) h;
        INSERT INTO transactions SELECT 'coinbase-'||h,h,'block-'||h,true,0,100,0,0,0 FROM generate_series(100,6100) h;
        INSERT INTO transactions SELECT 'tx-'||h,h,'block-'||h,false,3,0,0,0,0 FROM generate_series(100,6100) h;`);
      result = (await client.query(PERIOD_SQL, [6100,100,'test',null])).rows[0];
      assert.equal(result.totals.blocks,6001); assert.equal(result.totals.feesToNsmZat,'6001');
      assert.ok(result.points.length <= 241); assert.equal(result.points.at(-1).cumulativeRemovalZat,'6001');
      result = (await client.query(PERIOD_SQL, [6100,100,'test',100000+6000*25])).rows[0];
      assert.equal(result.selected.blocks,101); assert.equal(result.selected.feesToNsmZat,'101');
      assert.equal(result.totals.feesToNsmZat,'6001');
    } finally { await client.query('ROLLBACK'); await client.end(); }
  });
