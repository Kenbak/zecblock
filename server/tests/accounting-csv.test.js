const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, context) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../lib', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, BigInt, Date, ...context });
  return exports;
}

const csv = load('csv.ts');
const { accountingCsv } = load('accounting-csv.ts', { require: name => { if (name === './csv') return csv; throw new Error(name); } });

test('NSM accounting CSV keeps exact zatoshis and leaves unavailable amounts blank', () => {
  const out = accountingCsv([{
    timestamp: 1795382400, firstHeight: 3601000, lastHeight: 3601047, blocks: 48, feeBlocks: 47, missingBlocks: 1, nsmSamples: 2,
    feesPaidZat: '9007199254740993', feesToNsmZat: '-81090248', minerFeeAllocationZat: null, minerReceiptsZat: 'n/a',
    nsmBalanceZat: '100000000', cumulativeRemovalZat: '1', nsmSampleHeight: 3601040, nsmSampleHash: 'ab'.repeat(32),
  }], 'ZEC');
  assert.equal(JSON.stringify(out.headers.slice(7, 11)), JSON.stringify(['feesPaid_zat', 'feesPaid_zec', 'feesToNsm_zat', 'feesToNsm_zec']));
  const row = Object.fromEntries(out.headers.map((h, i) => [h, out.rows[0][i]]));
  assert.equal(row.bucket_start_utc, '2026-11-22T21:20:00.000Z');
  assert.equal(row.feesPaid_zat, '9007199254740993');
  assert.equal(row.feesPaid_zec, '90071992.54740993');
  assert.equal(row.feesToNsm_zec, '-0.81090248');
  assert.equal(row.minerFeeAllocation_zat, '');
  assert.equal(row.minerFeeAllocation_zec, '');
  assert.equal(row.minerReceipts_zat, '');
  assert.equal(row.nsmBalance_zec, '1');
  assert.equal(row.cumulativeRemoval_zec, '0.00000001');
  assert.equal(row.nsm_sample_height, 3601040);
  assert.equal(accountingCsv([], 'TAZ'), null);
});
