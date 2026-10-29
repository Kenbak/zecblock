import test from 'node:test';
import assert from 'node:assert/strict';
import { exportLive, readIndexedTip } from '../export-live.mjs';

const hash = value => BigInt(value).toString(16).padStart(64, '0');

// Synthetic provider-shape fixtures test capture and admission, not raw-byte
// validation or PIR cryptography. Native/browser tests own those boundaries.
function indexedSource(options = {}) {
  const paths = [];
  let readDetails = false;
  let tipSummaryReads = 0;
  const tip = options.tip ?? 12;
  const count = options.transactionsPerBlock ?? 1;
  const heightFor = txid => Number(BigInt(`0x${txid}`) / 10000n);
  const read = async path => {
    paths.push(path);
    let data;
    let network = 'mainnet';
    if (path === '/v1/network/info') data = { height: String(options.invalidTip ?? tip) };
    else if (path.startsWith('/v1/network/price/at')) {
      if (options.priceUnavailable) throw new Error('Fixture price unavailable');
      data = { price_usd: 12.5, exact: false, actual_date: '2026-10-27' };
    } else if (path.startsWith('/v1/blocks/')) {
      const blockHeight = Number(path.match(/blocks\/(\d+)/)[1]);
      const summary = path.endsWith('?summary=1');
      if (summary && blockHeight === tip) tipSummaryReads++;
      const changed = options.reorgAfterRaw && readDetails && summary
        || options.reorgBeforeCapture && blockHeight === tip && tipSummaryReads >= 2;
      data = {
        height: String(blockHeight), hash: changed ? hash(999) : hash(blockHeight),
        previous_block_hash: hash(options.brokenChain && blockHeight === tip ? 999 : blockHeight - 1),
        transactionCount: count + (options.incomplete ? 1 : 0),
        transactions: Array.from({ length: count }, (_, index) => ({ txid: hash(options.duplicate ? 100001 : blockHeight * 10000 + index + 1) })),
        isOrphaned: options.orphanTip && blockHeight === tip,
      };
    } else {
      const txid = path.match(/transactions\/([a-f0-9]{64})/)[1];
      const blockHeight = heightFor(txid);
      if (path.endsWith('/verbose')) data = { txid, hex: '00', decoded: { txid, blockhash: hash(blockHeight) } };
      else {
        readDetails = true;
        if (options.detailUnavailable) throw new Error('Fixture detail unavailable');
        if (options.wrongDetailNetwork) network = 'testnet';
        data = {
          txid, blockHeight: String(blockHeight), blockHash: hash(blockHeight), blockTime: '1793248333',
          confirmations: 99, status: 'confirmed', isCanonical: !options.noncanonical,
          feeZat: options.floatFee ? 1.5 : '10000', totalInputZat: '9007199254740993', totalOutputZat: null,
          inputs: [{ value: '9007199254740993' }], outputs: [{ value: null, spent: Boolean(options.spent) }],
        };
      }
    }
    return { data, meta: { network, generatedAt: '2026-10-29T04:00:00.000Z' } };
  };
  return { read, paths };
}

test('captures the entire explicit floor through the latest indexed tip without a depth delay', async () => {
  const provider = indexedSource();
  const times = ['2026-10-29T04:00:00.000Z', '2026-10-29T04:00:01.000Z'];
  const source = await exportLive({ read: provider.read, startHeight: 10, now: () => times.shift(), sourceOrigin: 'primary-fixture', sourceAuthority: 'One SQL fixture snapshot; separate raw fixture observations.' });
  assert.equal(source.schema, 'zecblock-private-tx-source-v1');
  assert.deepEqual(source.snapshot, { height: 12, hash: hash(12), publishedAt: '2026-10-29T04:00:01.000Z' });
  assert.equal(source.coverage.startHeight, 10);
  assert.equal(source.coverage.endHeight, 12);
  assert.equal(source.coverage.complete, true);
  assert.equal(source.coverage.transactionCount, 3);
  assert.deepEqual(source.records.map(record => record.detail.blockHeight), ['10', '11', '12']);
  assert.deepEqual(source.records.map(record => record.detail.confirmations), [3, 2, 1]);
  assert.equal(source.records[0].detail.totalInputZat, '9007199254740993');
  assert.equal(source.records[0].source.origin, 'primary-fixture');
  assert.equal(source.records[0].source.observedConfirmations, 99);
  assert.equal(source.coverage.authority, 'One SQL fixture snapshot; separate raw fixture observations.');
  assert.match(source.coverage.scope, /Bounded cumulative/);
  assert.equal(provider.paths.filter(path => path.startsWith('/v1/network/price/at')).length, 1);
  for (const blockHeight of [10, 11, 12]) assert.ok(provider.paths.includes(`/v1/blocks/${blockHeight}?summary=1`));
});

test('a later capture retains old IDs and refreshes their detail observations', async () => {
  const first = await exportLive({ read: indexedSource({ tip: 12 }).read, startHeight: 10 });
  const secondProvider = indexedSource({ tip: 13, spent: true });
  const second = await exportLive({ read: secondProvider.read, startHeight: first.coverage.startHeight });
  assert.equal(second.coverage.startHeight, 10);
  assert.equal(second.coverage.endHeight, 13);
  assert.deepEqual(second.records.slice(0, 3).map(record => record.txid), first.records.map(record => record.txid));
  assert.equal(second.records[0].detail.outputs[0].spent, true);
  assert.equal(second.records[0].detail.confirmations, 4);
  assert.ok(secondProvider.paths.includes(`/v1/transactions/${first.records[0].txid}`));
});

test('record admission is the table maximum rather than an arbitrary 64-record cutoff', async () => {
  const source = await exportLive({ read: indexedSource({ tip: 12, transactionsPerBlock: 65 }).read, startHeight: 12 });
  assert.equal(source.records.length, 65);
  assert.equal(source.coverage.transactionCount, 65);
});

test('explicit target keeps the persisted floor and uses the captured tip for confirmations', async () => {
  const source = await exportLive({ read: indexedSource({ tip: 13 }).read, startHeight: 10, endHeight: 12 });
  assert.equal(source.snapshot.height, 13);
  assert.equal(source.coverage.endHeight, 12);
  assert.deepEqual(source.records.map(record => record.detail.confirmations), [4, 3, 2]);
});

test('bounds reject the whole candidate without shrinking or rolling its coverage', async () => {
  const provider = indexedSource();
  await assert.rejects(exportLive({ read: provider.read, startHeight: 10, maxBlocks: 2 }), /previous coverage must be retained/);
  assert.ok(provider.paths.every(path => !path.startsWith('/v1/transactions/')));
  await assert.rejects(exportLive({ read: indexedSource({ transactionsPerBlock: 2 }).read, startHeight: 10, maxRecords: 5 }), /bounded publication capacity/);
  await assert.rejects(exportLive({ read: indexedSource().read, startHeight: 10, endHeight: 13 }), /outside the committed/);
});

for (const [option, expected] of [
  ['reorgBeforeCapture', /tip changed before capture/], ['reorgAfterRaw', /Canonical identity changed/],
  ['brokenChain', /not contiguous/], ['incomplete', /Incomplete source block/],
  ['duplicate', /duplicate source transaction/], ['noncanonical', /not canonically confirmed/],
  ['floatFee', /Inexact monetary/], ['wrongDetailNetwork', /network\/envelope mismatch/],
  ['detailUnavailable', /Fixture detail unavailable/], ['orphanTip', /canonical indexed tip/],
]) {
  test(`rejects ${option} without publishing a partial record set`, async () => {
    await assert.rejects(exportLive({ read: indexedSource({ [option]: true }).read, startHeight: 10 }), expected);
  });
}

test('unavailable optional price does not delay or remove confirmed records', async () => {
  const source = await exportLive({ read: indexedSource({ priceUnavailable: true }).read, startHeight: 10 });
  assert.equal(source.records.length, 3);
  assert.ok(source.records.every(record => record.price.available === false));
});

test('indexed tip includes its canonical hash so a same-height replacement is observable', async () => {
  const tip = await readIndexedTip({ read: indexedSource({ tip: 12 }).read });
  assert.deepEqual(tip, { height: 12, hash: hash(12) });
  await assert.rejects(readIndexedTip({ read: indexedSource({ invalidTip: '9007199254740993' }).read }), /Invalid indexed source height/);
  await assert.rejects(readIndexedTip(), /source reader is required/);
});

test('requires explicit valid floor and finite capacity bounds', async () => {
  for (const startHeight of [undefined, 0, -1, '10', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(exportLive({ read: indexedSource().read, startHeight }), /explicit positive coverage/);
  }
  for (const maxBlocks of [0, -1, 2049, Infinity]) await assert.rejects(exportLive({ read: indexedSource().read, startHeight: 10, maxBlocks }), /block limit/);
  for (const maxRecords of [0, -1, 2049, Infinity]) await assert.rejects(exportLive({ read: indexedSource().read, startHeight: 10, maxRecords }), /record limit/);
});
