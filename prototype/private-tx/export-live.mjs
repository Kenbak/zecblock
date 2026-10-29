import { exportConfirmedRange } from './export-recent.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MAX_TABLE_RECORDS = 2048;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function height(value) {
  requireCondition((typeof value === 'number' || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0, 'Invalid indexed source height.');
  return Number(value);
}
function mainnet(response) {
  requireCondition(response?.meta?.network === 'mainnet' && response.data && typeof response.data === 'object', 'Indexed source network/envelope mismatch.');
  return response.data;
}

// This reader must be supplied by the publisher's primary-source provider.
// There is deliberately no public HTTP default or browser-selected endpoint.
export async function readIndexedTip({ read } = {}) {
  requireCondition(typeof read === 'function', 'A primary indexed source reader is required.');
  const network = mainnet(await read('/v1/network/info'));
  const tipHeight = height(network.height ?? network.blocks);
  const anchor = mainnet(await read(`/v1/blocks/${tipHeight}?summary=1`));
  requireCondition(height(anchor.height) === tipHeight && HASH.test(anchor.hash) && anchor.isOrphaned !== true, 'Invalid canonical indexed tip.');
  return { height: tipHeight, hash: anchor.hash };
}

// The persisted startHeight is an explicit caller-owned coverage floor. Exceeding
// any bound fails the complete candidate; it never moves that floor or drops a tx.
// The caller owns the SQL snapshot and must verify it against a fresh canonical
// source after separate raw reads and immediately before activating artifacts.
export async function exportLive({
  read, startHeight, endHeight, maxBlocks = 16, maxRecords = MAX_TABLE_RECORDS,
  now = () => new Date().toISOString(),
  sourceOrigin = 'injected-indexed-source',
  sourceAuthority = 'Injected indexed source and separately observed raw transaction data; block identities checked before and after capture. This exporter does not establish a database snapshot; the publisher must supply and verify its source scope.',
} = {}) {
  requireCondition(Number.isSafeInteger(startHeight) && startHeight > 0, 'An explicit positive coverage startHeight is required.');
  requireCondition(Number.isSafeInteger(maxBlocks) && maxBlocks >= 1 && maxBlocks <= MAX_TABLE_RECORDS, 'Choose a block limit from 1–2048.');
  requireCondition(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= MAX_TABLE_RECORDS, 'Choose a record limit from 1–2048.');
  const captureStartedAt = now();
  const tip = await readIndexedTip({ read });
  const target = endHeight === undefined ? tip.height : height(endHeight);
  requireCondition(target >= startHeight && target <= tip.height, 'Target height is outside the committed indexed source.');
  requireCondition(target - startHeight + 1 <= maxBlocks, 'Cumulative coverage exceeds the block bound; previous coverage must be retained.');
  const checkedRead = async path => {
    const response = await read(path);
    mainnet(response);
    return response;
  };
  return exportConfirmedRange({
    read: checkedRead, height: tip.height, startHeight, endHeight: target, maxRecords, now,
    captureStartedAt, expectedSnapshotHash: tip.hash, sourceOrigin, sourceAuthority,
    scope: 'Bounded cumulative confirmed mainnet pilot range from a persisted coverage floor; no mempool or full-history coverage. A candidate exceeding capacity is rejected without omitting older or newly indexed transactions.',
  });
}
