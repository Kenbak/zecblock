import { createHash } from 'node:crypto';

export const MAINNET_GENESIS_HASH = '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08';
export const PRIMARY_SNAPSHOT_SCHEMA = 'zecblock-private-primary-snapshot-v1';
export const PRIMARY_SOURCE_AUTHORITY = 'Canonical indexed block, transaction and input/output facts from one bounded primary PostgreSQL repeatable-read READ ONLY snapshot; raw transaction bytes are separately observed through the fixed loopback API. Optional external enrichment is unavailable unless explicitly bundled.';
const HASH = /^[a-f0-9]{64}$/;
const EXACT = /^-?(0|[1-9]\d*)$/;
const MAX_IO = 200_000;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
function requireCondition(ok, message) { if (!ok) throw new Error(message); }
function integer(value, name = 'source integer') {
  requireCondition(typeof value === 'number' || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), `Invalid ${name}.`);
  const result = Number(value);
  requireCondition(Number.isSafeInteger(result) && result >= 0, `Invalid ${name}.`);
  return result;
}
function bounds({ startHeight, endHeight, maxBlocks = 16, maxRecords = 2048 }) {
  const start = integer(startHeight, 'coverage floor');
  requireCondition(start >= 0, 'Coverage floor must be nonnegative.');
  requireCondition(Number.isSafeInteger(maxBlocks) && maxBlocks >= 1 && maxBlocks <= 2048, 'Invalid block bound.');
  requireCondition(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= 2048, 'Invalid record bound.');
  const end = endHeight === undefined ? null : integer(endHeight, 'coverage end');
  requireCondition(end === null || end >= start && end - start + 1 <= maxBlocks, 'Coverage exceeds block bound.');
  return { start, end, maxBlocks, maxRecords };
}

// Execute only through the collector's existing local Unix peer connection.
// PostgreSQL 16 psql binds values through the extended protocol. Only validated
// integer/boolean tokens appear in the separate \bind command, never in SQL.
export function buildPrimarySnapshotSql(options) {
  const { start, end, maxBlocks, maxRecords } = bounds(options);
  const textRow = alias => `(SELECT jsonb_object_agg(cell.key,cell.value) FROM jsonb_each_text(to_jsonb(${alias})) cell)`;
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='3s';
SET LOCAL lock_timeout='200ms';
SET LOCAL idle_in_transaction_session_timeout='5s';
SET LOCAL work_mem='8MB';
WITH tip AS MATERIALIZED (SELECT height,hash FROM public.blocks ORDER BY height DESC LIMIT 1),
bounds AS (SELECT $1::bigint AS start_height,CASE WHEN $3::boolean THEN $2::bigint ELSE tip.height END AS end_height FROM tip),
selected_blocks AS MATERIALIZED (SELECT b.* FROM public.blocks b,bounds x WHERE b.height BETWEEN x.start_height AND x.end_height ORDER BY b.height LIMIT $4::integer),
selected_transactions AS MATERIALIZED (SELECT t.* FROM public.transactions t JOIN selected_blocks b ON b.height=t.block_height AND b.hash=t.block_hash ORDER BY t.block_height,t.tx_index,t.txid LIMIT $5::integer),
selected_inputs AS MATERIALIZED (SELECT i.* FROM public.transaction_inputs i JOIN selected_transactions t USING(txid) ORDER BY i.txid,i.vout_index LIMIT $6::integer),
selected_outputs AS MATERIALIZED (SELECT o.* FROM public.transaction_outputs o JOIN selected_transactions t USING(txid) ORDER BY o.txid,o.vout_index LIMIT $6::integer)
SELECT jsonb_build_object(
'schema','${PRIMARY_SNAPSHOT_SCHEMA}','network','mainnet',
'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
'database',current_database(),'isPrimary',NOT pg_is_in_recovery(),'readOnly',current_setting('transaction_read_only')='on',
'genesisHash',(SELECT hash FROM public.blocks WHERE height=0),'snapshotId',pg_current_snapshot()::text,
'limits',jsonb_build_object('maxBlocks',$7::integer,'maxRecords',$8::integer,'maxIoRows',$9::integer),
'coverage',(SELECT jsonb_build_object('startHeight',start_height::text,'endHeight',end_height::text) FROM bounds),
'tip',(SELECT jsonb_build_object('height',height::text,'hash',hash) FROM tip),
'blocks',COALESCE((SELECT jsonb_agg(${textRow('b')} ORDER BY b.height) FROM selected_blocks b),'[]'::jsonb),
'transactions',COALESCE((SELECT jsonb_agg(${textRow('t')} ORDER BY t.block_height,t.tx_index,t.txid) FROM selected_transactions t),'[]'::jsonb),
'inputs',COALESCE((SELECT jsonb_agg(${textRow('i')} ORDER BY i.txid,i.vout_index) FROM selected_inputs i),'[]'::jsonb),
'outputs',COALESCE((SELECT jsonb_agg(${textRow('o')} ORDER BY o.txid,o.vout_index) FROM selected_outputs o),'[]'::jsonb))
\\bind ${start} ${end ?? 0} ${end !== null} ${maxBlocks + 1} ${maxRecords + 1} ${MAX_IO + 1} ${maxBlocks} ${maxRecords} ${MAX_IO}
\\g
ROLLBACK;
`;
}

function textRows(rows, name, limit) {
  requireCondition(Array.isArray(rows) && rows.length <= limit, `Invalid or oversized ${name}.`);
  for (const row of rows) {
    requireCondition(row && typeof row === 'object' && !Array.isArray(row) && Object.values(row).every(value => value === null || typeof value === 'string'), `Non-text ${name} value; exact database values required.`);
  }
}
function exact(value) { requireCondition(value === null || typeof value === 'string' && EXACT.test(value), 'Invalid exact monetary value.'); return value; }
function bool(value, fallback = false) { if (value === undefined || value === null) return fallback; requireCondition(value === 'true' || value === 'false' || value === 't' || value === 'f', 'Invalid database boolean.'); return value === 'true' || value === 't'; }
function cellInt(row, name, fallback = null) { return row[name] === undefined || row[name] === null ? fallback : integer(row[name], name); }
function validateIo(rows, transactions, side) {
  const seen = new Set(); const counts = new Map();
  for (const row of rows) {
    requireCondition(transactions.has(row.txid), 'Input/output references an uncaptured transaction.');
    const index = integer(row.vout_index, 'input/output index');
    const key = `${row.txid}:${index}`;
    requireCondition(!seen.has(key), 'Duplicate input/output key.'); seen.add(key);
    exact(row.value);
    counts.set(row.txid, (counts.get(row.txid) ?? 0) + 1);
  }
  for (const tx of transactions.values()) {
    const serializedCount = integer(tx[side === 'inputs' ? 'vin_count' : 'vout_count'], 'transaction input/output count');
    // The indexer counts the serialized coinbase vin but intentionally skips
    // writing it to transaction_inputs (postgres.rs bulk input filter).
    const coinbaseInputs = side === 'inputs' && bool(tx.is_coinbase);
    if (coinbaseInputs) requireCondition(serializedCount === 1, 'Invalid serialized coinbase input count.');
    const expected = coinbaseInputs ? 0 : serializedCount;
    requireCondition((counts.get(tx.txid) ?? 0) === expected, 'Incomplete transaction input/output capture.');
    for (let i = 0; i < expected; i++) requireCondition(seen.has(`${tx.txid}:${i}`), 'Noncontiguous input/output indices.');
  }
}
export function decodePrimarySnapshot(stdout, { expectedGenesisHash = MAINNET_GENESIS_HASH } = {}) {
  requireCondition(typeof stdout === 'string' && Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES, 'Invalid or oversized primary snapshot.');
  const capture = JSON.parse(stdout);
  requireCondition(capture.schema === PRIMARY_SNAPSHOT_SCHEMA && capture.network === 'mainnet' && capture.database === 'zcash_explorer_mainnet' && capture.isPrimary === true && capture.readOnly === true, 'Primary mainnet read-only source identity required.');
  requireCondition(HASH.test(capture.genesisHash) && (expectedGenesisHash === undefined || expectedGenesisHash === capture.genesisHash), 'Source genesis identity mismatch.');
  requireCondition(typeof capture.observedAt === 'string' && Number.isFinite(Date.parse(capture.observedAt)) && typeof capture.snapshotId === 'string' && capture.snapshotId.length > 0, 'Missing source observation/snapshot identity.');
  const b = bounds({ ...capture.coverage, ...capture.limits });
  requireCondition(capture.limits?.maxIoRows === MAX_IO, 'Unsupported snapshot IO bound.');
  capture.coverage = { startHeight: b.start, endHeight: b.end };
  capture.tip.height = integer(capture.tip.height, 'indexed tip');
  requireCondition(b.end !== null && b.end <= capture.tip.height && HASH.test(capture.tip.hash), 'Invalid snapshot tip/coverage.');
  textRows(capture.blocks, 'blocks', b.maxBlocks); textRows(capture.transactions, 'transactions', b.maxRecords);
  textRows(capture.inputs, 'inputs', MAX_IO); textRows(capture.outputs, 'outputs', MAX_IO);
  requireCondition(capture.blocks.length === b.end - b.start + 1, 'Incomplete canonical block range.');
  const blocks = new Map();
  for (const [index, block] of capture.blocks.entries()) {
    const height = integer(block.height);
    requireCondition(height === b.start + index && HASH.test(block.hash) && HASH.test(block.previous_block_hash), 'Invalid canonical block identity.');
    if (index) requireCondition(block.previous_block_hash === capture.blocks[index - 1].hash, 'Broken canonical parent chain.');
    integer(block.transaction_count, 'header transaction count'); blocks.set(height, block);
  }
  if (b.end === capture.tip.height) requireCondition(blocks.get(b.end).hash === capture.tip.hash, 'Tip/range identity mismatch.');
  const transactions = new Map(); const positions = new Set(); const counts = new Map();
  for (const tx of capture.transactions) {
    const height = integer(tx.block_height); const block = blocks.get(height); const index = integer(tx.tx_index);
    requireCondition(HASH.test(tx.txid) && !transactions.has(tx.txid) && block && tx.block_hash === block.hash && tx.block_time === block.timestamp, 'Invalid captured transaction identity.');
    requireCondition(!positions.has(`${height}:${index}`), 'Duplicate transaction position.'); positions.add(`${height}:${index}`);
    for (const field of ['fee','total_input','total_output','value_balance','value_balance_sprout','value_balance_sapling','value_balance_orchard','value_balance_ironwood']) if (tx[field] !== undefined) exact(tx[field]);
    transactions.set(tx.txid, tx); counts.set(height, (counts.get(height) ?? 0) + 1);
  }
  for (const [height, block] of blocks) {
    const count = integer(block.transaction_count);
    requireCondition(count > 0 && counts.get(height) === count, 'Incomplete block transaction capture.');
    for (let i = 0; i < count; i++) requireCondition(positions.has(`${height}:${i}`), 'Noncontiguous transaction positions.');
    const coinbases = capture.transactions.filter(tx => integer(tx.block_height) === height && bool(tx.is_coinbase));
    requireCondition(coinbases.length === 1 && integer(coinbases[0].tx_index) === 0, 'Invalid block coinbase set.');
  }
  validateIo(capture.inputs, transactions, 'inputs'); validateIo(capture.outputs, transactions, 'outputs');
  return capture;
}
function canonical(value) { return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
export function primaryFactsFingerprint(capture) {
  const { database, genesisHash, tip, coverage, blocks, transactions, inputs, outputs } = capture;
  return createHash('sha256').update(canonical({ database, genesisHash, tip, coverage, blocks, transactions, inputs, outputs })).digest('hex');
}
function coinbaseText(hex) { return typeof hex === 'string' && hex.length > 0 && hex.length % 2 === 0 && /^[a-f0-9]+$/i.test(hex) ? Buffer.from(hex, 'hex').toString('utf8').replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, '.') : null; }
function formatDetail(tx, block, capture, inputs, outputs) {
  const monetary = name => tx[name] === undefined ? null : exact(tx[name]);
  const zec = value => value === null ? null : Number(value) / 100_000_000;
  const balances = [['valueBalance','value_balance'],['valueBalanceSprout','value_balance_sprout'],['valueBalanceSapling','value_balance_sapling'],['valueBalanceOrchard','value_balance_orchard'],['valueBalanceIronwood','value_balance_ironwood'],['fee','fee'],['totalInput','total_input'],['totalOutput','total_output']];
  const result = {
    txid: tx.txid, blockHeight: tx.block_height, blockHash: tx.block_hash, blockTime: tx.block_time, confirmations: capture.tip.height - integer(tx.block_height) + 1,
    isCanonical: true, status: 'confirmed', size: cellInt(tx, 'size'), version: cellInt(tx, 'version'), locktime: tx.locktime ?? null, expiryHeight: cellInt(tx, 'expiry_height') || null,
    isCoinbase: bool(tx.is_coinbase), hasSapling: tx.has_sapling == null ? null : bool(tx.has_sapling), hasOrchard: tx.has_orchard == null ? null : bool(tx.has_orchard), hasIronwood: bool(tx.has_ironwood), hasSprout: tx.has_sprout == null ? null : bool(tx.has_sprout),
    orchardActions: cellInt(tx, 'orchard_actions', 0), ironwoodActions: cellInt(tx, 'ironwood_actions', 0), saplingSpendCount: cellInt(tx, 'sapling_spend_count', 0), saplingOutputCount: cellInt(tx, 'sapling_output_count', 0), sproutJoinsplitCount: cellInt(tx, 'sprout_joinsplit_count', 0),
    inputs: inputs.map(row => ({ prev_txid: row.prev_txid, prev_vout: cellInt(row,'prev_vout'), address: row.address, value: row.value, vout_index: cellInt(row,'vout_index') })),
    outputs: outputs.map(row => ({ address: row.address, value: row.value, vout_index: cellInt(row,'vout_index'), spent: bool(row.spent) })),
    inputCount: inputs.length, outputCount: outputs.length,
    coinbaseHex: bool(tx.is_coinbase) ? block.coinbase_hex ?? null : null,
    coinbaseText: bool(tx.is_coinbase) ? coinbaseText(block.coinbase_hex) : null,
    // Omit normal API bridge/ZIP318 outcome fields: absence of enrichment is
    // not authoritative evidence that no bridge or migration exists.
    enrichment: { bridge: { available: false, reason: 'Not captured by indexed-only snapshot.' }, zip318: { available: false, reason: 'Not evaluated by indexed-only snapshot.' } },
    stakingAction: tx.staking_action_type ? { type: tx.staking_action_type, bondKey: tx.staking_bond_key, delegatee: tx.staking_delegatee, amountZats: tx.staking_amount_zats == null ? null : Number(exact(tx.staking_amount_zats)), amountZat: tx.staking_amount_zats == null ? null : exact(tx.staking_amount_zats), amountZec: tx.staking_amount_zats == null ? null : Number(exact(tx.staking_amount_zats)) / 1e8 } : null,
  };
  for (const [publicName, column] of balances) { const value = monetary(column); result[publicName] = zec(value); result[`${publicName}Zat`] = value; }
  return result;
}

export async function createPrimarySnapshotReader({ capture, readRaw, readPrice, verifyCanonical } = {}) {
  const value = typeof capture === 'function' ? await capture() : capture;
  // Revalidate even when caller supplied a decoded object; no mixed-row scope.
  const snapshot = decodePrimarySnapshot(JSON.stringify(value));
  const blocks = new Map(snapshot.blocks.map(block => [integer(block.height), block]));
  const transactions = new Map(snapshot.transactions.map(tx => [tx.txid, tx]));
  let closed = false;
  const envelope = data => ({ meta: { network: 'mainnet', generatedAt: snapshot.observedAt }, data });
  const scope = {
    authority: PRIMARY_SOURCE_AUTHORITY,
    fingerprint: primaryFactsFingerprint(snapshot),
    snapshot,
    async read(path) {
      requireCondition(!closed, 'Primary capture scope is closed.');
      if (path === '/v1/network/info') return envelope({ height: snapshot.tip.height, blocks: snapshot.tip.height });
      let match = /^\/v1\/blocks\/(\d+)(\?summary=1)?$/.exec(path);
      if (match) {
        const height = integer(match[1]); const block = blocks.get(height);
        if (!block && height === snapshot.tip.height && match[2]) return envelope({ ...snapshot.tip, isOrphaned: false });
        requireCondition(block, 'Block is outside captured coverage.');
        return envelope({ ...block, height, hash: block.hash, transactionCount: integer(block.transaction_count), isOrphaned: false, transactions: snapshot.transactions.filter(tx => integer(tx.block_height) === height).map(tx => ({ txid: tx.txid })) });
      }
      match = /^\/v1\/transactions\/([a-f0-9]{64})(\/verbose)?$/.exec(path);
      if (match) {
        const tx = transactions.get(match[1]); requireCondition(tx, 'Transaction is outside captured coverage.');
        if (match[2]) { requireCondition(typeof readRaw === 'function', 'Raw transaction source is unavailable.'); return readRaw(match[1]); }
        return envelope(formatDetail(tx, blocks.get(integer(tx.block_height)), snapshot, snapshot.inputs.filter(row => row.txid === tx.txid), snapshot.outputs.filter(row => row.txid === tx.txid)));
      }
      if (/^\/v1\/network\/price\/at\?date=\d{4}-\d{2}-\d{2}$/.test(path)) { requireCondition(typeof readPrice === 'function', 'Historical price unavailable in indexed-only capture.'); return readPrice(path); }
      throw new Error('Unsupported primary snapshot read.');
    },
    async verifyCanonical() { requireCondition(!closed && typeof verifyCanonical === 'function', 'Fresh canonical verification callback required.'); return verifyCanonical(snapshot); },
    async close() { closed = true; },
  };
  return scope;
}
