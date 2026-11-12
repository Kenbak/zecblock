// Selection, private query secrets and plaintext result assembly stay here.
// Only generic manifest/setup downloads and fixed binary queries leave it.
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COLLECTION_MANIFEST_BYTES = 8 * MAX_MANIFEST_BYTES;
const MAX_COLLECTION_SEGMENTS = 8;
const COLLECTION_SETUP_BYTES = 45_056;
const MAX_SETUP_BYTES = 128 * 1024 * 1024;
const MAX_QUERY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_CHUNKS = 64;
const BATCH_TIMEOUT_MS = 30_000;
const REQUEST_BYTES = 20_992;
const RESPONSE_BYTES = 10_240;
let clients = [], manifest, initializing;
let lookupInProgress = false;
let refreshing = false;
class LookupError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const errors = {
  initialize: 'The private publication could not initialize. Publish recent data and reload.',
  manifest: 'The publication is unavailable or incompatible. No public lookup was attempted.',
  setup: 'The publication setup failed validation. No public lookup was attempted.',
  invalid: 'Enter exactly 64 hexadecimal characters. Validation stays in this browser.',
  outside: 'This transaction is outside the published confirmed range. This does not mean it is missing from Zcash.',
  query: 'The browser could not create the encrypted request. No public lookup was attempted.',
  network: 'The query service is unavailable or the publication was retired. Reload the catalogue and try again. No public lookup was attempted.',
  decode: 'The private lookup did not produce a complete valid record. Refresh the publication or try again manually. No public lookup was attempted.',
  busy: 'Wait for the current private lookup to finish.',
};
async function boundedBytes(response, maximum, code) {
  if (!response.ok || !response.body) throw new LookupError(code);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new LookupError(code); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
const options = signal => ({ cache: 'no-store', credentials: 'omit', redirect: 'error', mode: 'same-origin', referrerPolicy: 'no-referrer', signal: signal ?? AbortSignal.timeout(60_000) });

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new LookupError('manifest');
  return encoded;
}
const publicationIdentity = value => value?.collectionId ?? value?.publicationId;
const validHeight = value => Number.isSafeInteger(value) && value >= 0;
function collectionCoverage(segments) {
  const blocks = new Map(), ranges = [];
  let records = 0, previousStart = -1;
  for (const segment of segments) {
    const inner = segment.manifest, coverage = inner.coverage;
    if (!validHeight(coverage?.startHeight) || !validHeight(coverage?.endHeight)
        || coverage.endHeight < coverage.startHeight || coverage.startHeight <= previousStart
        || !Array.isArray(coverage.blocks) || coverage.blocks.length !== coverage.endHeight - coverage.startHeight + 1
        || inner.catalogue.length < 1 || inner.catalogue.length > 2048
        || !validHeight(inner.snapshot?.height) || inner.snapshot.height < coverage.endHeight
        || !/^[a-f0-9]{64}$/.test(inner.snapshot.hash) || !Number.isFinite(Date.parse(inner.snapshot.publishedAt))) throw new LookupError('manifest');
    previousStart = coverage.startHeight;
    let transactionCount = 0;
    const perBlock = new Map();
    for (const entry of inner.catalogue) {
      if (!validHeight(entry.height) || entry.height < coverage.startHeight || entry.height > coverage.endHeight) throw new LookupError('manifest');
      perBlock.set(entry.height, (perBlock.get(entry.height) ?? 0) + 1);
    }
    for (let index = 0; index < coverage.blocks.length; index++) {
      const block = coverage.blocks[index];
      if (block?.height !== coverage.startHeight + index || !/^[a-f0-9]{64}$/.test(block.hash)
          || blocks.has(block.height) || !Number.isSafeInteger(block.transactionCount) || block.transactionCount < 1
          || perBlock.get(block.height) !== block.transactionCount) throw new LookupError('manifest');
      blocks.set(block.height, { height: block.height, hash: block.hash, transactionCount: block.transactionCount });
      transactionCount += block.transactionCount;
    }
    if (transactionCount !== inner.catalogue.length) throw new LookupError('manifest');
    records += transactionCount;
    ranges.push({ startHeight: coverage.startHeight, endHeight: coverage.endHeight, transactionCount });
  }
  const ordered = [...blocks.values()].sort((a, b) => a.height - b.height);
  const startHeight = ordered[0].height, endHeight = ordered.at(-1).height;
  return { startHeight, endHeight, transactionCount: records, complete: ordered.length === endHeight - startHeight + 1, ranges, blocks: ordered };
}
function validateFullManifest(value) {
  if (value?.schema !== 'zecblock-private-tx-full-v1' || value.network !== 'mainnet'
      || !/^[a-f0-9]{64}$/.test(value.publicationId) || !Array.isArray(value.catalogue)
      || !Number.isSafeInteger(value.chunkCount) || value.chunkCount < 1 || value.chunkCount > MAX_BATCH_CHUNKS
      || value.scheme?.request_bytes !== REQUEST_BYTES || value.scheme?.response_bytes !== RESPONSE_BYTES) throw new LookupError('manifest');
}
async function segmentPlan(value, manifestBytes) {
  if (value?.schema !== 'zecblock-private-tx-collection-v1') {
    if (manifestBytes > MAX_MANIFEST_BYTES) throw new LookupError('manifest');
    validateFullManifest(value);
    return [{ publicationId: value.publicationId, manifest: value }];
  }
  const fields = ['schema', 'network', 'snapshot', 'coverage', 'segments', 'collectionId'];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
      || value.network !== 'mainnet' || !/^[a-f0-9]{64}$/.test(value.collectionId)
      || !Number.isSafeInteger(value.snapshot?.height) || !/^[a-f0-9]{64}$/.test(value.snapshot?.hash)
      || !Number.isFinite(Date.parse(value.snapshot?.publishedAt))
      || !Number.isSafeInteger(value.coverage?.startHeight) || !Number.isSafeInteger(value.coverage?.endHeight)
      || value.coverage.startHeight < 0 || value.coverage.startHeight > value.coverage.endHeight
      || value.coverage.endHeight > value.snapshot.height || typeof value.coverage.complete !== 'boolean'
      || !Array.isArray(value.coverage.ranges) || !Array.isArray(value.segments)
      || value.segments.length < 1 || value.segments.length > MAX_COLLECTION_SEGMENTS) throw new LookupError('manifest');
  const identity = { schema: value.schema, network: value.network, snapshot: value.snapshot, coverage: value.coverage, segments: value.segments };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(identity))));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== value.collectionId) throw new LookupError('manifest');
  const publications = new Set(), records = new Set();
  let chunks = 0;
  for (const segment of value.segments) {
    if (Object.keys(segment ?? {}).length !== 2 || !Object.hasOwn(segment, 'publicationId') || !Object.hasOwn(segment, 'manifest')) throw new LookupError('manifest');
    validateFullManifest(segment?.manifest);
    const inner = segment.manifest;
    if (segment.publicationId !== inner.publicationId || publications.has(segment.publicationId)
        || inner.packing !== 'compact-v1' || inner.coverRow !== 2047
        || inner.scheme.public_bytes !== COLLECTION_SETUP_BYTES) throw new LookupError('manifest');
    publications.add(segment.publicationId);
    chunks += inner.chunkCount;
    for (const entry of inner.catalogue) {
      if (!/^[a-f0-9]{64}$/.test(entry?.txid) || records.has(entry.txid)) throw new LookupError('manifest');
      records.add(entry.txid);
    }
  }
  if (chunks > MAX_BATCH_CHUNKS) throw new LookupError('manifest');
  if (canonicalJson(value.coverage) !== canonicalJson(collectionCoverage(value.segments))) throw new LookupError('manifest');
  return value.segments;
}

async function refreshPublication() {
  if (lookupInProgress || refreshing) return;
  refreshing = true;
  try {
    const bytes = await boundedBytes(await fetch('/publication/manifest.json', options()), MAX_COLLECTION_MANIFEST_BYTES, 'manifest');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const next = JSON.parse(json);
    const plan = await segmentPlan(next, bytes.length);
    const statusBytes = await boundedBytes(await fetch('/publication/status.json', options()), 8192, 'manifest');
    const status = JSON.parse(new TextDecoder().decode(statusBytes));
    const age = Date.now() - Date.parse(next.snapshot?.publishedAt);
    postMessage({ type: 'publication-warning', message: status.state === 'capacity-blocked'
      ? 'Publishing has reached its configured capacity. Newer transactions may be outside the published coverage.'
      : status.state === 'unavailable' ? 'The read-only publisher could not refresh. Results remain tied to the last captured snapshot.'
        : age > 600_000 ? 'This publication is more than ten minutes old. Confirmation counts and spent flags may have changed.' : '' });
    if (publicationIdentity(next) === publicationIdentity(manifest)) return;
    const pirModule = await import('/wasm/zecblock_pir_browser.js');
    await pirModule.default({ module_or_path: '/wasm/zecblock_pir_browser_bg.wasm' });
    const replacements = [];
    try {
      for (const segment of plan) {
        const collection = next.schema === 'zecblock-private-tx-collection-v1';
        const setup = await boundedBytes(await fetch(`/publication/${segment.publicationId}/public.bin`, options()), collection ? COLLECTION_SETUP_BYTES : MAX_SETUP_BYTES, 'setup');
        if (collection && setup.length !== COLLECTION_SETUP_BYTES) throw new LookupError('setup');
        const replacement = new pirModule.FullPirBrowser(JSON.stringify(segment.manifest), setup);
        replacements.push({ ...segment, client: replacement });
        if (collection && typeof replacement.begin_cover_query !== 'function') throw new LookupError('setup');
      }
    } catch (error) {
      for (const segment of replacements) segment.client.free();
      throw error;
    }
    for (const segment of clients) segment.client.free();
    clients = replacements;
    manifest = next;
    const catalogue = plan.flatMap(segment => segment.manifest.catalogue);
    // These aliases are UI-only. The canonical collection bytes and inner
    // publication identities remain unchanged for validation and transport.
    const presentation = next.schema === 'zecblock-private-tx-collection-v1'
      ? { ...next, publicationId: next.collectionId, catalogue } : next;
    postMessage({ type: 'ready', manifest: presentation, samples: catalogue, catalogue });
  } finally { refreshing = false; }
}
async function initialize() {
  if (!globalThis.crypto?.subtle || typeof WebAssembly !== 'object') throw new LookupError('initialize');
  await refreshPublication();
  // Pin metadata for this page session. Automatic polling in this worker would
  // be delayed differently by successful and failed private-content decoding.
  // A user may explicitly reload to select a fresh publication.
}

async function collectReplies(queries, requestId) {
  const signal = AbortSignal.timeout(BATCH_TIMEOUT_MS);
  let completed = 0;
  // Invoke every fetch before awaiting any response. The browser may queue HTTP
  // connections, but private reply contents never choose our dispatch plan.
  const tasks = queries.map(async ({ query, publicationId }) => {
    try {
      const response = await fetch('/pir/query', { ...options(signal), method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': publicationId }, body: query });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
        await response.body?.cancel();
        throw new LookupError('decode');
      }
      const answer = await boundedBytes(response, RESPONSE_BYTES, 'decode');
      if (answer.length !== RESPONSE_BYTES) throw new LookupError('decode');
      return answer;
    } finally {
      postMessage({ type: 'stage', requestId, stage: 'server', chunk: ++completed, chunks: queries.length });
    }
  });
  // A failed slot must not reject the batch early or cancel other requests.
  const settled = await Promise.allSettled(tasks);
  if (settled.some(slot => slot.status !== 'fulfilled')) throw new LookupError('decode');
  return settled.map(slot => slot.value);
}
async function lookup(txid, requestId) {
  if (!clients.length || !manifest) throw new LookupError('initialize');
  if (lookupInProgress || refreshing) throw new LookupError('busy');
  if (typeof txid !== 'string' || !/^[a-f0-9]{64}$/.test(txid)) throw new LookupError('invalid');
  const target = clients.find(segment => segment.manifest.catalogue.some(record => record.txid === txid));
  if (!target) throw new LookupError('outside');
  lookupInProgress = true;
  let phase = 'query';
  const started = performance.now();
  let encryptMs = 0, requestMs = 0, decodeMs = 0, queryBytes = 0, responseBytes = 0;
  try {
    const queries = [];
    const t0 = performance.now();
    for (const segment of clients) {
      const chunks = segment === target ? segment.client.begin_query(txid) : segment.client.begin_cover_query();
      if (chunks !== segment.manifest.chunkCount || chunks < 1 || queries.length + chunks > MAX_BATCH_CHUNKS) throw new LookupError('query');
      for (let index = 0; index < chunks; index++) {
        const query = segment.client.make_chunk_query(index);
        if (!(query instanceof Uint8Array) || query.length !== REQUEST_BYTES || query.length > MAX_QUERY_BYTES) throw new LookupError('query');
        queries.push({ query, publicationId: segment.publicationId, segment });
        queryBytes += query.length;
      }
    }
    txid = '';
    const chunks = queries.length;
    encryptMs = performance.now() - t0;
    phase = 'decode';
    postMessage({ type: 'stage', requestId, stage: 'server', chunk: 0, chunks });
    const t1 = performance.now();
    const replies = await collectReplies(queries, requestId);
    requestMs = performance.now() - t1;
    responseBytes = replies.reduce((total, answer) => total + answer.length, 0);
    // Only after every transport slot settles may any content be decrypted,
    // parsed, validated or exposed. Failure emits no partial result or retry.
    postMessage({ type: 'stage', requestId, stage: 'decode', chunks });
    const t2 = performance.now();
    let result;
    for (let index = 0; index < replies.length; index++) {
      const segment = queries[index].segment;
      const decoded = segment.client.decode_chunk_response(replies[index]);
      if (decoded !== undefined && decoded !== null) {
        if (segment !== target || result) throw new LookupError('decode');
        result = JSON.parse(decoded);
      }
    }
    decodeMs = performance.now() - t2;
    if (!result || result.found !== true || !result.detail || !result.raw || result.publicationId !== target.publicationId) throw new LookupError('decode');
    postMessage({ type: 'result', requestId, result, measurements: { queryBytes, responseBytes, encryptMs, requestMs, decodeMs, totalMs: performance.now() - started, chunkCount: chunks, publicationId: publicationIdentity(manifest), ...(manifest.collectionId ? { collectionId: manifest.collectionId, segmentCount: clients.length } : {}) } });
  } catch (error) { throw error instanceof LookupError ? error : new LookupError(phase); }
  finally { for (const segment of clients) segment.client.cancel_query(); lookupInProgress = false; }
}
self.addEventListener('message', async ({ data }) => {
  try {
    if (data?.type === 'initialize') { initializing ??= initialize(); await initializing; }
    if (data?.type === 'lookup') await lookup(data.txid, data.requestId);
  } catch (error) {
    const code = error instanceof LookupError ? error.code : 'initialize';
    postMessage({ type: 'error', requestId: data?.requestId, message: errors[code] ?? errors.initialize });
  }
});
