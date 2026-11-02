import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimarySnapshotSql, decodePrimarySnapshot, createPrimarySnapshotReader, primaryFactsFingerprint, MAINNET_GENESIS_HASH, PRIMARY_SNAPSHOT_SCHEMA } from '../primary-source.mjs';

const txid = 'a'.repeat(64);
const hash = 'b'.repeat(64);
function fixture() {
  return {
    schema: PRIMARY_SNAPSHOT_SCHEMA, network: 'mainnet', database: 'zcash_explorer_mainnet', isPrimary: true, readOnly: true, genesisHash: MAINNET_GENESIS_HASH,
    observedAt: '2026-10-29T12:00:00.000Z', snapshotId: '123:123:', limits: { maxBlocks: 16, maxRecords: 2048, maxIoRows: 200_000 },
    tip: { height: '100', hash }, coverage: { startHeight: '100', endHeight: '100' },
    blocks: [{ height: '100', hash, previous_block_hash: 'c'.repeat(64), timestamp: '1793275200', transaction_count: '1', coinbase_hex: '004142' }],
    transactions: [{ txid, block_height: '100', block_hash: hash, block_time: '1793275200', tx_index: '0', version: '5', locktime: '0', expiry_height: '0', size: '100', vin_count: '1', vout_count: '1', is_coinbase: 'true', has_sapling: 'false', has_orchard: 'false', has_ironwood: 'false', has_sprout: 'false', fee: '0', total_input: '0', total_output: '9007199254740993', value_balance: '0', value_balance_sapling: null, value_balance_orchard: '-1', value_balance_ironwood: '0' }],
    // Current indexer deliberately omits coinbase vin rows from indexed inputs.
    inputs: [],
    outputs: [{ txid, vout_index: '0', value: '9007199254740993', address: 'public-address-fixture', spent: 'false' }],
  };
}
function decode(value = fixture()) { return decodePrimarySnapshot(JSON.stringify(value)); }

test('SQL is fixed, bounded and read only; no arbitrary source SQL/identifier is accepted', () => {
  const sql = buildPrimarySnapshotSql({ startHeight: 100 });
  assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(sql, /statement_timeout='3s'/);
  assert.match(sql, /jsonb_each_text/);
  assert.match(sql, /LIMIT \$5::integer/);
  assert.match(sql, /\\bind 100 0 false 17 2049 200001 16 2048 200000\n\\g/);
  assert.match(sql, /ROLLBACK;\n$/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE|pg_create|pg_drop)\b/i);
  for (const options of [{ startHeight: '1;DROP TABLE blocks' }, { startHeight: -1 }, { startHeight: 1, endHeight: 30 }, { startHeight: 1, maxRecords: 2049 }]) assert.throws(() => buildPrimarySnapshotSql(options));
});

test('source decoder pins primary/mainnet/genesis and exact text cells', () => {
  const capture = decode();
  assert.equal(capture.tip.height, 100);
  assert.equal(capture.outputs[0].value, '9007199254740993');
  for (const mutate of [c => { c.isPrimary = false; }, c => { c.readOnly = false; }, c => { c.database = 'other'; }, c => { c.genesisHash = '0'.repeat(64); }, c => { c.transactions[0].total_output = 9007199254740992; }]) { const c = fixture(); mutate(c); assert.throws(() => decode(c)); }
});

test('incomplete rows, wrong canonical identity, duplicate indices and capacity reject capture', () => {
  for (const mutate of [c => { c.outputs = []; }, c => { c.blocks[0].transaction_count = '2'; }, c => { c.transactions[0].block_hash = 'd'.repeat(64); }, c => { c.outputs.push({ ...c.outputs[0] }); }, c => { c.inputs.push({ txid, vout_index: '1', value: null }); }, c => { c.transactions[0].is_coinbase = 'false'; }, c => { c.coverage.endHeight = '101'; }, c => { c.tip.hash = 'd'.repeat(64); }]) { const c = fixture(); mutate(c); assert.throws(() => decode(c)); }
});

test('facts fingerprint excludes observation/snapshot revision but detects corrections and head changes', () => {
  const a = decode(); const b = structuredClone(a); b.observedAt = '2026-10-29T12:00:01.000Z'; b.snapshotId = '124:124:';
  assert.equal(primaryFactsFingerprint(a), primaryFactsFingerprint(b));
  b.outputs[0].spent = 'true'; assert.notEqual(primaryFactsFingerprint(a), primaryFactsFingerprint(b));
  b.outputs[0].spent = 'false'; b.tip.height++;
  assert.notEqual(primaryFactsFingerprint(a), primaryFactsFingerprint(b));
});

test('reader captures once and maps complete detail without a normal transaction API lookup', async () => {
  let captures = 0; let rawReads = 0; let verified = 0;
  const scope = await createPrimarySnapshotReader({ capture: async () => { captures++; return decode(); }, readRaw: async selected => { rawReads++; assert.equal(selected, txid); return { meta: { network: 'mainnet' }, data: { txid, hex: '00', decoded: { txid } } }; }, verifyCanonical: async snapshot => { verified++; assert.equal(snapshot.tip.height, 100); return true; } });
  const detail = (await scope.read(`/v1/transactions/${txid}`)).data;
  assert.equal(detail.totalOutputZat, '9007199254740993'); assert.equal(detail.outputs[0].value, '9007199254740993'); assert.equal(detail.inputs.length, 0); assert.equal(detail.inputCount, 0);
  assert.equal(detail.valueBalanceSaplingZat, null); assert.equal(detail.valueBalanceOrchardZat, '-1'); assert.equal(detail.confirmations, 1); assert.equal(detail.status, 'confirmed'); assert.equal(detail.coinbaseText, '.AB'); assert.equal(detail.expiryHeight, null);
  assert.equal(rawReads, 0); assert.equal(detail.bridge, undefined); assert.equal(detail.zip318, undefined); assert.equal(detail.enrichment.bridge.available, false);
  assert.deepEqual((await scope.read('/v1/blocks/100')).data.transactions, [{ txid }]);
  assert.equal((await scope.read('/v1/network/info')).data.height, 100);
  await scope.read(`/v1/transactions/${txid}/verbose`); assert.equal(rawReads, 1);
  assert.equal(await scope.verifyCanonical(), true); assert.equal(verified, 1); assert.equal(captures, 1);
  await assert.rejects(scope.read(`/v1/transactions/${'d'.repeat(64)}`));
  await assert.rejects(scope.read('/v1/network/price/at?date=2026-10-29'));
  await scope.close(); await assert.rejects(scope.read('/v1/network/info'));
});

test('fresh verification must be explicitly provided; cached reads never impersonate a recheck', async () => {
  const scope = await createPrimarySnapshotReader({ capture: decode() });
  await assert.rejects(scope.verifyCanonical(), /Fresh canonical verification/);
});

test('serialized coinbase vin is omitted from indexed inputs; ordinary missing inputs still fail', () => {
  assert.equal(decode().inputs.length, 0);
  const c = fixture(); c.blocks[0].transaction_count = '2';
  c.transactions.push({ ...c.transactions[0], txid: 'd'.repeat(64), tx_index: '1', is_coinbase: 'false' });
  c.outputs.push({ ...c.outputs[0], txid: 'd'.repeat(64) });
  assert.throws(() => decode(c), /Incomplete transaction input\/output capture/);
  c.inputs.push({ txid: 'd'.repeat(64), vout_index: '0', value: null, address: null, prev_txid: 'e'.repeat(64), prev_vout: '0' });
  assert.equal(decode(c).transactions.length, 2);
});
