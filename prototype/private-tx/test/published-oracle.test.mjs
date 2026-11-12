import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePublishedRecord, sha256 } from './published-oracle.mjs';

// Plaintext codec/row fixtures only. These do not exercise or replace PIR and
// do not claim that the synthetic block/snapshot belongs to the real chain.
function fixture({ compressed = true, trailing = false, length = null } = {}) {
  const txid = '22'.repeat(32), publicationId = '11'.repeat(32);
  const manifest = { publicationId, network: 'mainnet', snapshot: { height: 1, hash: '33'.repeat(32), publishedAt: '2026-11-02T00:00:00Z' },
    coverage: { startHeight: 1, endHeight: 1 } };
  const original = { schema: 'zecblock-private-tx-record-v1', network: 'mainnet', snapshot: manifest.snapshot, coverage: manifest.coverage, txid,
    detail: { txid, blockHeight: 1, status: 'confirmed', isCanonical: true, feeZat: '10000', inputs: [], outputs: [] },
    raw: { hex: '00', decoded: { txid, hex: '00' } } };
  let stored = Buffer.from(JSON.stringify(original));
  if (compressed) {
    manifest.recordCodec = 'json-context-zlib-v1';
    const payload = structuredClone(original);
    for (const key of ['schema', 'network', 'snapshot', 'coverage']) delete payload[key];
    delete payload.raw.decoded.hex;
    const bytes = Buffer.from(JSON.stringify(payload)), header = Buffer.alloc(16);
    header.write('ZBTXZ001'); header.writeUInt32LE(length ?? bytes.length, 8); header[12] = 1;
    stored = Buffer.concat([header, deflateSync(bytes), ...(trailing ? [Buffer.from([0])] : [])]);
  }
  const entry = { txid, height: 1, rows: [0], recordBytes: stored.length, recordSha256: sha256(stored) };
  const database = Buffer.alloc(2048 * 8192), row = database.subarray(0, 8192);
  row.write('ZBFTX001'); Buffer.from(publicationId, 'hex').copy(row, 8); Buffer.from(txid, 'hex').reverse().copy(row, 40);
  [0, 1, stored.length, stored.length].forEach((value, index) => row.writeUInt32LE(value, 72 + index * 4));
  Buffer.from(entry.recordSha256, 'hex').copy(row, 88); stored.copy(row, 128);
  return { database, manifest, entry, expected: { ...original, found: true, publicationId } };
}

test('copied plaintext oracle restores whole legacy and compressed envelopes exactly', () => {
  for (const compressed of [false, true]) {
    const { database, manifest, entry, expected } = fixture({ compressed });
    assert.deepEqual(decodePublishedRecord(database, manifest, entry), expected);
  }
});

test('copied plaintext oracle checks row binding, lengths, padding and stored checksum', () => {
  for (const offset of [0, 8, 40, 72, 76, 80, 84, 88, 120, 128, 8191]) {
    const { database, manifest, entry } = fixture(); database[offset] ^= 1;
    assert.throws(() => decodePublishedRecord(database, manifest, entry));
  }
  const { database, manifest, entry } = fixture(); entry.recordSha256 = '44'.repeat(32);
  assert.throws(() => decodePublishedRecord(database, manifest, entry));
});

test('copied plaintext oracle rejects trailing streams, expansion and unsupported codec', () => {
  for (const options of [{ trailing: true }, { length: 1 }, { length: 8 * 1024 ** 2 + 1 }]) {
    const { database, manifest, entry } = fixture(options);
    assert.throws(() => decodePublishedRecord(database, manifest, entry));
  }
  const { database, manifest, entry } = fixture(); manifest.recordCodec = 'unknown';
  assert.throws(() => decodePublishedRecord(database, manifest, entry));
});
