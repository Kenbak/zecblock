import { writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const EXACT = /^-?\d+$/;
export const SOURCE_ORIGIN = 'https://api.zecblock.com';

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function integer(value) {
  requireCondition((typeof value === 'number' || /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0, 'Invalid source integer.');
  return Number(value);
}

export async function readPublicData(path) {
  // The exporter is independent of browser requests and accepts no search ID.
  // Every source operation is an unauthenticated GET to an explicit public API.
  requireCondition(/^\/v1\/(network\/info|blocks\/\d+(\?summary=1)?|transactions\/[a-f0-9]{64}(\/verbose)?|network\/price\/at\?date=\d{4}-\d{2}-\d{2})$/.test(path), 'Unsupported source read.');
  const response = await fetch(`${SOURCE_ORIGIN}${path}`, {
    method: 'GET', redirect: 'error', credentials: 'omit',
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/json' },
  });
  requireCondition(response.ok, `Public read returned HTTP ${response.status}.`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    requireCondition(bytes <= 8 * 1024 * 1024, 'Public response exceeded local capture limit.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireCondition(body.meta?.network === 'mainnet' && body.data !== undefined, 'Source network/envelope mismatch.');
  return body;
}

function validateDetail(detail, txid, block) {
  requireCondition(detail.txid === txid && detail.status === 'confirmed' && detail.isCanonical === true, 'Source transaction is not canonically confirmed.');
  requireCondition(integer(detail.blockHeight) === integer(block.height) && detail.blockHash === block.hash, 'Source transaction/block mismatch.');
  requireCondition(Array.isArray(detail.inputs) && Array.isArray(detail.outputs), 'Full inputs/outputs unavailable.');
  for (const field of ['feeZat', 'totalInputZat', 'totalOutputZat', 'valueBalanceZat', 'valueBalanceSaplingZat', 'valueBalanceOrchardZat', 'valueBalanceIronwoodZat']) {
    requireCondition(detail[field] === null || detail[field] === undefined || typeof detail[field] === 'string' && EXACT.test(detail[field]), 'Inexact monetary source field.');
  }
  requireCondition(typeof detail.feeZat === 'string' && /^\d+$/.test(detail.feeZat), 'Authoritative fee unavailable.');
  for (const item of [...detail.inputs, ...detail.outputs]) {
    requireCondition(item.value === null || item.value === undefined || typeof item.value === 'string' && EXACT.test(item.value), 'Inexact input/output amount.');
  }
}

export async function exportRecent({ read = readPublicData, blockCount = 4, tipDepth = 2, maxRecords = 64, now = () => new Date().toISOString() } = {}) {
  requireCondition(Number.isInteger(blockCount) && blockCount >= 1 && blockCount <= 8, 'Choose 1–8 recent blocks.');
  requireCondition(Number.isInteger(tipDepth) && tipDepth >= 1 && tipDepth <= 100, 'Choose a confirmation depth from 1–100.');
  const captureStartedAt = now();
  const network = await read('/v1/network/info');
  const height = integer(network.data.height ?? network.data.blocks);
  const endHeight = height - tipDepth;
  const startHeight = endHeight - blockCount + 1;
  return exportConfirmedRange({ read, height, startHeight, endHeight, maxRecords, now, captureStartedAt });
}

// Shared full-range capture. The caller owns source connection/snapshot lifetime;
// this helper does not establish a SQL transaction or choose a coverage floor.
export async function exportConfirmedRange({
  read, height, startHeight, endHeight, maxRecords = 2048,
  now = () => new Date().toISOString(), captureStartedAt = now(),
  expectedSnapshotHash,
  sourceOrigin = SOURCE_ORIGIN,
  sourceAuthority = 'Read-only public ZecBlock indexed detail and serving-node verbose API; block identities checked before and after capture. Independent HTTP observations, not an atomic database snapshot.',
  scope = 'Bounded recent confirmed mainnet range; no mempool or full-history coverage.',
}) {
  requireCondition(typeof read === 'function', 'An indexed source reader is required.');
  requireCondition(Number.isSafeInteger(height) && height >= 0 && Number.isSafeInteger(startHeight) && Number.isSafeInteger(endHeight)
    && endHeight >= startHeight && endHeight <= height, 'Invalid indexed coverage boundaries.');
  requireCondition(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= 2048, 'Choose a record limit from 1–2048.');
  requireCondition(startHeight > 0, 'Insufficient indexed coverage.');
  const anchor = (await read(`/v1/blocks/${height}?summary=1`)).data;
  requireCondition(HASH.test(anchor.hash) && integer(anchor.height) === height, 'Invalid indexed tip anchor.');
  requireCondition(expectedSnapshotHash === undefined || anchor.hash === expectedSnapshotHash, 'Canonical indexed tip changed before capture.');
  const blocks = [];
  let recordCount = 0;
  // Bounded sequential block reads and at most two transaction reads at once.
  for (let h = startHeight; h <= endHeight; h++) {
    const block = (await read(`/v1/blocks/${h}`)).data;
    requireCondition(integer(block.height) === h && HASH.test(block.hash) && block.isOrphaned !== true, 'Non-canonical source block.');
    requireCondition(Array.isArray(block.transactions) && block.transactions.length === integer(block.transactionCount ?? block.transaction_count), 'Incomplete source block transaction list.');
    if (blocks.length) requireCondition(block.previous_block_hash === blocks.at(-1).hash, 'Source block range is not contiguous.');
    recordCount += block.transactions.length;
    requireCondition(recordCount <= maxRecords, 'Indexed range exceeds bounded publication capacity; previous coverage must be retained.');
    blocks.push(block);
  }
  const records = [];
  const seen = new Set();
  const prices = new Map();
  for (const block of blocks) {
    for (const item of block.transactions) {
      const txid = typeof item === 'string' ? item : item.txid;
      requireCondition(HASH.test(txid) && !seen.has(txid), 'Invalid or duplicate source transaction.');
      seen.add(txid);
      const [detailResponse, rawResponse] = await Promise.all([
        read(`/v1/transactions/${txid}`), read(`/v1/transactions/${txid}/verbose`),
      ]);
      const detail = detailResponse.data;
      const raw = rawResponse.data;
      validateDetail(detail, txid, block);
      requireCondition(raw.txid === txid && raw.decoded?.txid === txid && typeof raw.hex === 'string' && /^(?:[a-f0-9]{2})+$/.test(raw.hex), 'Raw transaction identity/bytes mismatch.');
      requireCondition(raw.decoded.blockhash === undefined || raw.decoded.blockhash === block.hash, 'Verbose block identity mismatch.');
      const date = new Date(integer(detail.blockTime) * 1000).toISOString().slice(0, 10);
      if (!prices.has(date)) {
        try { prices.set(date, { available: true, ...(await read(`/v1/network/price/at?date=${date}`)).data }); }
        catch { prices.set(date, { available: false, reason: 'Historical price unavailable during capture.' }); }
      }
      records.push({
        txid,
        // Confirmations are explicitly tied to this captured indexed tip.
        // Preserve the API's own observation separately rather than implying
        // these independent HTTP reads formed one database transaction.
        detail: { ...detail, confirmations: height - integer(block.height) + 1 },
        raw,
        price: prices.get(date),
        source: {
          origin: sourceOrigin,
          detailObservedAt: detailResponse.meta.generatedAt,
          rawObservedAt: rawResponse.meta.generatedAt,
          observedConfirmations: detail.confirmations,
          confirmationBasis: 'captured-indexed-tip',
        },
      });
    }
  }
  // Bracket chain membership. A reorg or source mismatch aborts publication
  // and leaves the previous local generation in place.
  for (const block of [...blocks, anchor]) {
    const after = (await read(`/v1/blocks/${integer(block.height)}?summary=1`)).data;
    requireCondition(after.hash === block.hash && after.isOrphaned !== true, 'Canonical identity changed during capture; publication aborted.');
  }
  const captureCompletedAt = now();
  return {
    schema: 'zecblock-private-tx-source-v1', network: 'mainnet',
    snapshot: { height, hash: anchor.hash, publishedAt: captureCompletedAt },
    coverage: {
      startHeight, endHeight, transactionCount: records.length, complete: true,
      blocks: blocks.map(block => ({ height: integer(block.height), hash: block.hash, transactionCount: block.transactions.length })),
      captureStartedAt, captureCompletedAt,
      authority: sourceAuthority,
      scope,
    },
    records,
  };
}

export async function saveSource(source, path) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(source)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = await exportRecent({ blockCount: Number(process.env.PRIVATE_TX_BLOCKS ?? 4), tipDepth: Number(process.env.PRIVATE_TX_DEPTH ?? 2) });
  await saveSource(source, resolve(HERE, '.local/source.json'));
  console.log(JSON.stringify({ readOnly: true, records: source.records.length, coverage: source.coverage, snapshot: source.snapshot }, null, 2));
}
