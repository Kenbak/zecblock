// Test-only oracle for copied plaintext publication files. This does not query
// a node or validate the publisher's indexed facts against the chain.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { canonicalJson, validateCollection } from '../collection.mjs';

const HASH = /^[a-f0-9]{64}$/;
const ROW_BYTES = 8192, PAYLOAD_BYTES = 8064, MAX_ENCODED = 64 * PAYLOAD_BYTES, MAX_DECODED = 8 * 1024 ** 2;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function ordinaryFile(path, maximum) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'Oracle input must be a bounded ordinary file.');
  const bytes = await readFile(path);
  assert.ok(bytes.length <= maximum);
  return bytes;
}

export function decodePublishedRecord(database, manifest, entry) {
  assert.ok(HASH.test(entry.txid) && HASH.test(entry.recordSha256));
  assert.ok(Number.isSafeInteger(entry.recordBytes) && entry.recordBytes > 0 && entry.recordBytes <= MAX_ENCODED);
  assert.equal(entry.rows.length, Math.ceil(entry.recordBytes / PAYLOAD_BYTES));
  const payloads = entry.rows.map((number, index) => {
    assert.ok(Number.isSafeInteger(number) && number >= 0 && number < 2047);
    const row = database.subarray(number * ROW_BYTES, (number + 1) * ROW_BYTES);
    const length = Math.min(PAYLOAD_BYTES, entry.recordBytes - index * PAYLOAD_BYTES);
    assert.equal(row.length, ROW_BYTES);
    assert.equal(row.subarray(0, 8).toString(), 'ZBFTX001');
    assert.equal(row.subarray(8, 40).toString('hex'), manifest.publicationId);
    assert.deepEqual(row.subarray(40, 72), Buffer.from(entry.txid, 'hex').reverse());
    assert.deepEqual([72, 76, 80, 84].map(offset => row.readUInt32LE(offset)), [index, entry.rows.length, length, entry.recordBytes]);
    assert.equal(row.subarray(88, 120).toString('hex'), entry.recordSha256);
    assert.ok(row.subarray(120, 128).every(byte => byte === 0));
    assert.ok(row.subarray(128 + length).every(byte => byte === 0));
    return row.subarray(128, 128 + length);
  });
  const stored = Buffer.concat(payloads);
  assert.equal(stored.length, entry.recordBytes);
  assert.equal(sha256(stored), entry.recordSha256);
  let record;
  if (manifest.recordCodec === undefined) record = JSON.parse(stored.toString('utf8'));
  else {
    assert.equal(manifest.recordCodec, 'json-context-zlib-v1');
    assert.ok(stored.length > 16);
    assert.equal(stored.subarray(0, 8).toString(), 'ZBTXZ001');
    assert.ok(stored[12] === 0 || stored[12] === 1);
    assert.ok(stored.subarray(13, 16).every(byte => byte === 0));
    const length = stored.readUInt32LE(8);
    assert.ok(length > 0 && length <= MAX_DECODED);
    const inflated = inflateSync(stored.subarray(16), { maxOutputLength: length, info: true });
    assert.equal(inflated.buffer.length, length);
    assert.equal(inflated.engine.bytesWritten, stored.length - 16, 'Trailing zlib data is not part of an oracle record.');
    record = JSON.parse(inflated.buffer.toString('utf8'));
    for (const key of ['schema', 'network', 'snapshot', 'coverage', 'found', 'publicationId']) assert.ok(!Object.hasOwn(record, key));
    if (stored[12] === 1) {
      assert.ok(typeof record.raw.hex === 'string' && record.raw.decoded && !Object.hasOwn(record.raw.decoded, 'hex'));
      record.raw.decoded.hex = record.raw.hex;
    }
    Object.assign(record, { schema: 'zecblock-private-tx-record-v1', network: manifest.network,
      snapshot: manifest.snapshot, coverage: manifest.coverage });
  }
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= MAX_DECODED);
  assert.equal(record.schema, 'zecblock-private-tx-record-v1');
  assert.equal(record.network, 'mainnet');
  assert.equal(record.txid, entry.txid);
  assert.equal(record.detail.txid, entry.txid);
  assert.equal(record.detail.status, 'confirmed');
  assert.equal(record.detail.isCanonical, true);
  assert.equal(Number(record.detail.blockHeight), entry.height);
  assert.deepEqual(record.snapshot, manifest.snapshot);
  assert.deepEqual(record.coverage, manifest.coverage);
  assert.ok(Array.isArray(record.detail.inputs) && Array.isArray(record.detail.outputs));
  assert.match(record.raw.hex, /^(?:[a-f0-9]{2})+$/);
  for (const key of ['feeZat', 'totalInputZat', 'totalOutputZat', 'valueBalanceZat', 'valueBalanceSaplingZat', 'valueBalanceOrchardZat', 'valueBalanceIronwoodZat']) {
    if (record.detail[key] !== undefined && record.detail[key] !== null) assert.match(record.detail[key], /^-?(0|[1-9]\d*)$/);
  }
  return { ...record, found: true, publicationId: manifest.publicationId };
}

export async function copiedPublicationOracle(directory, { selectedIds = [] } = {}) {
  const collectionBytes = await ordinaryFile(resolve(directory, 'collection.json'), 8 * 1024 ** 2);
  const collection = validateCollection(JSON.parse(collectionBytes.toString('utf8')));
  assert.ok(collection.segments.length <= 3, 'Installed acceptance is bounded to one public example per segment, at most three segments.');
  assert.ok(selectedIds.length === 0 || selectedIds.length === collection.segments.length, 'Explicit selections require exactly one transaction per segment.');
  const samples = [], files = [{ file: 'collection.json', bytes: collectionBytes.length, sha256: sha256(collectionBytes) }];
  for (const [index, segment] of collection.segments.entries()) {
    const manifest = segment.manifest, base = resolve(directory, 'segments', segment.publicationId);
    const manifestBytes = await ordinaryFile(resolve(base, 'manifest.json'), 1024 ** 2);
    assert.equal(canonicalJson(JSON.parse(manifestBytes.toString('utf8'))), canonicalJson(manifest));
    const publicBytes = await ordinaryFile(resolve(base, 'public.bin'), 45056);
    assert.equal(publicBytes.length, 45056); assert.equal(sha256(publicBytes), manifest.publicSha256);
    const database = await ordinaryFile(resolve(base, 'database.bin'), 2048 * ROW_BYTES);
    assert.equal(database.length, 2048 * ROW_BYTES); assert.equal(sha256(database), manifest.databaseSha256);
    assert.ok(database.subarray(2047 * ROW_BYTES).every(byte => byte === 0));
    for (const [name, bytes] of [['manifest.json', manifestBytes], ['public.bin', publicBytes], ['database.bin', database]]) {
      files.push({ file: `segments/${segment.publicationId}/${name}`, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const entry = selectedIds.length ? manifest.catalogue.find(item => item.txid === selectedIds[index])
      : [...manifest.catalogue].sort((a, b) => b.recordBytes - a.recordBytes)[0];
    assert.ok(entry, 'Explicit public test example must belong to its copied segment.');
    samples.push({ publicationId: segment.publicationId, txid: entry.txid, record: decodePublishedRecord(database, manifest, entry) });
  }
  return { collection, collectionBytes, samples, files };
}
