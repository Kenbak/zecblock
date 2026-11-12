import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRecent } from '../export-recent.mjs';

const hash = n => n.toString(16).padStart(64, '0');
function fakeSource(options = {}) {
  const paths = [];
  const read = async path => {
    paths.push(path);
    let data;
    if (path === '/v1/network/info') data = { height: 12 };
    else if (path.startsWith('/v1/network/price/at')) {
      if (options.priceUnavailable) throw new Error('Unavailable');
      data = { price_usd: 12.5, exact: false, actual_date: '2026-10-27' };
    } else if (path.startsWith('/v1/blocks/')) {
      const height = Number(path.match(/blocks\/(\d+)/)[1]);
      data = { height, hash: options.reorg && height === 9 && path.endsWith('?summary=1') ? hash(999) : hash(height), previous_block_hash: hash(height - 1), transactionCount: options.incomplete ? 2 : 1, transactions: [{ txid: hash(height + 100) }], isOrphaned: false };
    } else {
      const txid = path.match(/transactions\/([a-f0-9]{64})/)[1];
      const height = parseInt(txid, 16) - 100;
      if (path.endsWith('/verbose')) data = { txid, hex: '00', decoded: { txid, blockhash: hash(height) } };
      else data = { txid, blockHeight: height, blockHash: hash(height), blockTime: '1793248333', confirmations: 99, status: options.stale ? 'stale' : 'confirmed', isCanonical: !options.stale, feeZat: options.floatFee ? 1.5 : '10000', totalInputZat: '9007199254740993', totalOutputZat: null, inputs: [{ value: '9007199254740993' }], outputs: [{ value: null }] };
    }
    return { data, meta: { network: 'mainnet', generatedAt: '2026-10-29T04:00:00.000Z' } };
  };
  return { read, paths };
}
test('exports complete confirmed range independently of user lookups, with exact amounts and bracketed identities', async () => {
  const mock = fakeSource();
  const source = await exportRecent({ read: mock.read, blockCount: 2, tipDepth: 2 });
  assert.equal(source.records.length, 2);
  assert.equal(source.snapshot.height, 12);
  assert.equal(source.snapshot.hash, hash(12));
  assert.equal(source.coverage.startHeight, 9);
  assert.equal(source.coverage.endHeight, 10);
  assert.deepEqual(source.records.map(r => r.detail.confirmations), [4, 3]);
  assert.equal(source.records[0].source.observedConfirmations, 99);
  assert.equal(source.records[0].detail.totalInputZat, '9007199254740993');
  assert.equal(source.records[0].detail.totalOutputZat, null);
  assert.equal(mock.paths.filter(p => p.startsWith('/v1/network/price/at')).length, 1);
  assert.ok(mock.paths.includes('/v1/blocks/9?summary=1'));
  assert.ok(mock.paths.includes('/v1/blocks/10?summary=1'));
  assert.equal(mock.paths.filter(p => p === '/v1/blocks/12?summary=1').length, 2);
  assert.ok(mock.paths.every(path => !/broadcast|mempool|address/.test(path)));
});
for (const [option, message] of [['reorg', /Canonical identity changed/], ['incomplete', /Incomplete source block/], ['stale', /not canonically confirmed/], ['floatFee', /Inexact monetary/]]) {
  test(`rejects ${option} rather than publishing an inaccurate or partial range`, async () => {
    await assert.rejects(exportRecent({ read: fakeSource({ [option]: true }).read, blockCount: 2 }), message);
  });
}
test('unavailable price stays explicitly unavailable without blocking confirmed chain data', async () => {
  const source = await exportRecent({ read: fakeSource({ priceUnavailable: true }).read, blockCount: 2 });
  assert.equal(source.records[0].price.available, false);
  assert.equal(source.records.length, 2);
});
test('rejects capacity overflow without silently dropping transactions', async () => {
  await assert.rejects(exportRecent({ read: fakeSource().read, blockCount: 2, maxRecords: 1 }), /bounded publication capacity/);
});
