import { createHash } from 'node:crypto';

export const COLLECTION_SCHEMA = 'zecblock-private-tx-collection-v1';
export const MAX_SEGMENTS = 8;
export const MAX_COLLECTION_CHUNKS = 64;
export const MAX_COLLECTION_BYTES = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const assert = (value, message) => { if (!value) throw new Error(message); };
const height = value => Number.isSafeInteger(value) && value >= 0;

// JSON objects are sorted recursively; array order is part of the commitment.
// This is also implemented by the network-free browser worker before setup.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const result = JSON.stringify(value);
  assert(result !== undefined && !(typeof value === 'number' && !Number.isFinite(value)), 'Invalid collection JSON.');
  return result;
}

export function collectionIdentity(value) {
  const { schema, network, snapshot, coverage, segments } = value;
  return createHash('sha256').update(canonicalJson({ schema, network, snapshot, coverage, segments })).digest('hex');
}

function describe(segments) {
  assert(Array.isArray(segments) && segments.length > 0 && segments.length <= MAX_SEGMENTS, 'Collection segment capacity exceeded.');
  const ids = new Set(), txids = new Set(), blocks = new Map();
  let chunks = 0;
  const ranges = [];
  for (const segment of segments) {
    const manifest = segment?.manifest;
    assert(segment && Object.keys(segment).sort().join(',') === 'manifest,publicationId'
      && HASH.test(segment.publicationId) && manifest?.publicationId === segment.publicationId
      && !ids.has(segment.publicationId), 'Invalid or duplicate collection segment.');
    ids.add(segment.publicationId);
    assert(manifest.schema === 'zecblock-private-tx-full-v1' && manifest.network === 'mainnet'
      && manifest.packing === 'compact-v1' && manifest.coverRow === 2047
      && manifest.geometry === 'full-2k-8k' && manifest.rows === 2048 && manifest.rowBytes === 8192
      && manifest.scheme?.request_bytes === 20992 && manifest.scheme?.response_bytes === 10240
      && manifest.scheme?.public_bytes === 45056
      && Number.isSafeInteger(manifest.chunkCount) && manifest.chunkCount > 0 && manifest.chunkCount <= 64,
    'Unsupported collection segment geometry.');
    chunks += manifest.chunkCount;
    assert(chunks <= MAX_COLLECTION_CHUNKS, 'Collection fixed-query budget exceeded.');
    const coverage = manifest.coverage;
    assert(height(coverage?.startHeight) && height(coverage?.endHeight) && coverage.endHeight >= coverage.startHeight
      && Array.isArray(coverage.blocks) && coverage.blocks.length === coverage.endHeight - coverage.startHeight + 1
      && Array.isArray(manifest.catalogue) && manifest.catalogue.length > 0 && manifest.catalogue.length <= 2048,
    'Incomplete collection segment coverage.');
    assert(height(manifest.snapshot?.height) && manifest.snapshot.height >= coverage.endHeight
      && HASH.test(manifest.snapshot.hash) && Number.isFinite(Date.parse(manifest.snapshot.publishedAt)), 'Invalid segment snapshot.');
    let transactionCount = 0;
    for (let index = 0; index < coverage.blocks.length; index++) {
      const block = coverage.blocks[index];
      assert(block.height === coverage.startHeight + index && HASH.test(block.hash) && !blocks.has(block.height)
        && Number.isSafeInteger(block.transactionCount) && block.transactionCount > 0, 'Overlapping or incomplete collection blocks.');
      blocks.set(block.height, { height: block.height, hash: block.hash, transactionCount: block.transactionCount });
      transactionCount += block.transactionCount;
    }
    assert(transactionCount === manifest.catalogue.length, 'Collection transaction count mismatch.');
    const perBlock = new Map();
    for (const entry of manifest.catalogue) {
      assert(HASH.test(entry?.txid) && !txids.has(entry.txid) && height(entry.height)
        && entry.height >= coverage.startHeight && entry.height <= coverage.endHeight, 'Duplicate or out-of-range collection transaction.');
      txids.add(entry.txid);
      perBlock.set(entry.height, (perBlock.get(entry.height) ?? 0) + 1);
    }
    for (const block of coverage.blocks) assert(perBlock.get(block.height) === block.transactionCount, 'Collection block completeness mismatch.');
    ranges.push({ startHeight: coverage.startHeight, endHeight: coverage.endHeight, transactionCount });
  }
  const ordered = [...blocks.values()].sort((a, b) => a.height - b.height);
  const orderedRanges = [...ranges].sort((a, b) => a.startHeight - b.startHeight);
  assert(ranges.every((item, index) => item === orderedRanges[index]), 'Collection segments must be in height order.');
  const startHeight = ordered[0].height, endHeight = ordered.at(-1).height;
  return { startHeight, endHeight, transactionCount: txids.size, complete: ordered.length === endHeight - startHeight + 1,
    ranges, blocks: ordered };
}

export function collectionManifest({ segments, snapshot } = {}) {
  const ordered = [...segments].sort((a, b) => a.manifest.coverage.startHeight - b.manifest.coverage.startHeight);
  const coverage = describe(ordered);
  snapshot ??= ordered.map(item => item.manifest.snapshot).sort((a, b) => b.height - a.height || b.publishedAt.localeCompare(a.publishedAt))[0];
  assert(height(snapshot?.height) && snapshot.height >= coverage.endHeight && HASH.test(snapshot.hash)
    && Number.isFinite(Date.parse(snapshot.publishedAt)), 'Invalid collection snapshot.');
  const result = { schema: COLLECTION_SCHEMA, network: 'mainnet', snapshot, coverage, segments: ordered };
  result.collectionId = collectionIdentity(result);
  assert(Buffer.byteLength(JSON.stringify(result)) <= MAX_COLLECTION_BYTES, 'Collection manifest byte budget exceeded.');
  return result;
}

export function validateCollection(value) {
  assert(value?.schema === COLLECTION_SCHEMA && value.network === 'mainnet' && HASH.test(value.collectionId)
    && Object.keys(value).sort().join(',') === 'collectionId,coverage,network,schema,segments,snapshot', 'Unsupported collection manifest.');
  const rebuilt = collectionManifest({ segments: value.segments, snapshot: value.snapshot });
  assert(canonicalJson(value.coverage) === canonicalJson(rebuilt.coverage)
    && value.collectionId === rebuilt.collectionId, 'Collection identity or coverage mismatch.');
  return value;
}
