import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ZcashWASM } from '../dist/index.js';
import init, { ScanSession, batch_filter_compact_outputs } from '../wasm/zcash_wasm.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/synthetic.json', import.meta.url)));
const wasm = await ZcashWASM.init();
const action = (index) => {
  const r = Buffer.from(fixture.records.slice(index * 149, (index + 1) * 149));
  return { pool: index ? 'ironwood' : 'orchard', nullifier: r.subarray(1, 33).toString('hex'),
    cmx: r.subarray(33, 65).toString('hex'), ephemeralKey: r.subarray(65, 97).toString('hex'),
    ciphertext: r.subarray(97).toString('hex') };
};
const block = (actions) => ({ height: '3543405', hash: 'fixture', time: 1,
  vtx: [{ hash: 'public-synthetic-transaction', actions }] });

test('Node initializes local packaged WASM without network or key logging', async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network request'); };
  try { assert.equal((await ZcashWASM.init()).detectKeyType(fixture.key), 'ufvk-mainnet'); }
  finally { globalThis.fetch = priorFetch; }
  assert.equal(wasm.detectKeyType('uview1-invalid-checksum'), 'unknown');
});

test('v5 NU5, v6 NU6.3 and NU7 decrypt without rewriting bytes', async () => {
  for (const tx of [fixture.tx_v5, fixture.tx, fixture.tx_nu7]) {
    assert.deepEqual(await wasm.decryptMemo(tx, fixture.key), { memo: 'hello', amount: 0.00000123 });
  }
  const session = new ScanSession(fixture.key);
  try {
    const outputs = JSON.parse(session.decrypt_memos(fixture.tx_nu7));
    assert.deepEqual(outputs.map(({ pool, amount_zatoshis, output_index }) =>
      [pool, amount_zatoshis, output_index]), [['orchard', 123, 0], ['ironwood', 124, 1]]);
  } finally { session.free(); }
});

test('tagged and legacy compact outputs match both pools and deduplicate TXs', async () => {
  const progress = [];
  assert.deepEqual(await wasm.filterCompactBlocks([block([action(0), action(1)])], fixture.key,
    (p) => progress.push(p)), [{ txid: 'public-synthetic-transaction', height: 3543405, timestamp: 1 }]);
  assert.deepEqual(progress, [{ blocksProcessed: 1, totalBlocks: 1, matchesFound: 1 }]);
  const legacy = [action(0), action(1)].map(({ pool, ...rest }) => rest);
  assert.equal((await wasm.filterCompactBlocks([block(legacy)], fixture.key)).length, 1);
});

test('large input splits calls by output count while preserving progress and deduplication', async () => {
  const actions = Array.from({ length: 4097 }, () => action(0));
  assert.equal((await wasm.filterCompactBlocks([block(actions)], fixture.key)).length, 1);
});

test('mixed compact blocks retain Orchard matches; Sapling-only input is explicitly unsupported', async () => {
  const b = block([action(0)]); b.vtx[0].outputs = [{ cmu: '', ephemeralKey: '', ciphertext: '' }];
  assert.equal((await wasm.filterCompactBlocks([b], fixture.key)).length, 1);
  b.vtx[0].actions = [];
  await assert.rejects(wasm.filterCompactBlocks([b], fixture.key), /Sapling compact.*not supported/);
  await assert.rejects(wasm.decryptMemo('0400008085202f89', fixture.key), /Sapling memo.*not supported/);
});

test('malformed/unknown branches, trailing and truncated bytes are rejected', async () => {
  for (const tx of ['', 'zz', '0', fixture.tx.slice(0, -2), fixture.tx + '00',
    fixture.tx.slice(0, 8) + '00000000' + fixture.tx.slice(16),
    fixture.tx.slice(0, 16) + 'ffffffff' + fixture.tx.slice(24),
    fixture.tx.slice(0, 40) + 'ffffffffffffffffff']) {
    await assert.rejects(wasm.decryptMemo(tx, fixture.key));
  }
  await assert.rejects(wasm.decryptMemo('00'.repeat(2_000_001), fixture.key), /at most 2 MB/);
  await assert.rejects(wasm.decryptMemo(fixture.tx, 'invalid-key'));
});

test('compact metadata/field sizes are validated and direct WASM calls are bounded', async () => {
  const b = block([action(0)]); b.height = '1junk';
  await assert.rejects(wasm.filterCompactBlocks([b], fixture.key), /metadata/);
  await assert.rejects(wasm.filterCompactBlocks([block([{ ...action(0), cmx: '00' }])], fixture.key), /field/);
  const session = new ScanSession(fixture.key);
  try {
    assert.throws(() => session.filter_compact(new Uint8Array(149 * 4097)), /Too many compact/);
    assert.throws(() => session.filter_compact(new Uint8Array(148)), /length/);
  } finally { session.free(); }
  assert.throws(() => batch_filter_compact_outputs(' '.repeat(4_000_001), fixture.key), /4 MB/);
});
