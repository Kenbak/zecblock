// Selection, private query secrets and plaintext result assembly stay here.
// Only generic manifest/setup downloads and fixed binary queries leave it.
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SETUP_BYTES = 128 * 1024 * 1024;
const MAX_QUERY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_CHUNKS = 64;
const BATCH_TIMEOUT_MS = 30_000;
const REQUEST_BYTES = 20_992;
const RESPONSE_BYTES = 10_240;
let client, manifest, initializing;
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
async function refreshPublication() {
  if (lookupInProgress || refreshing) return;
  refreshing = true;
  try {
    const bytes = await boundedBytes(await fetch('/publication/manifest.json', options()), MAX_MANIFEST_BYTES, 'manifest');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const next = JSON.parse(json);
    if (next.schema !== 'zecblock-private-tx-full-v1' || !/^[a-f0-9]{64}$/.test(next.publicationId) || !Array.isArray(next.catalogue)) throw new LookupError('manifest');
    if (!Number.isSafeInteger(next.chunkCount) || next.chunkCount < 1 || next.chunkCount > MAX_BATCH_CHUNKS
        || next.scheme?.request_bytes !== REQUEST_BYTES || next.scheme?.response_bytes !== RESPONSE_BYTES) throw new LookupError('manifest');
    const statusBytes = await boundedBytes(await fetch('/publication/status.json', options()), 8192, 'manifest');
    const status = JSON.parse(new TextDecoder().decode(statusBytes));
    const age = Date.now() - Date.parse(next.snapshot?.publishedAt);
    postMessage({ type: 'publication-warning', message: status.state === 'unavailable' ? 'The read-only publisher could not refresh. Results remain tied to the last captured snapshot.' : age > 600_000 ? 'This publication is more than ten minutes old. Confirmation counts and spent flags may have changed.' : '' });
    if (next.publicationId === manifest?.publicationId) return;
    const setup = await boundedBytes(await fetch(`/publication/${next.publicationId}/public.bin`, options()), MAX_SETUP_BYTES, 'setup');
    const pirModule = await import('/wasm/zecblock_pir_browser.js');
    await pirModule.default({ module_or_path: '/wasm/zecblock_pir_browser_bg.wasm' });
    const replacement = new pirModule.FullPirBrowser(json, setup);
    client?.free();
    client = replacement;
    manifest = next;
    postMessage({ type: 'ready', manifest, samples: next.catalogue, catalogue: next.catalogue });
  } finally { refreshing = false; }
}
async function initialize() {
  if (!globalThis.crypto?.subtle || typeof WebAssembly !== 'object') throw new LookupError('initialize');
  await refreshPublication();
  // Pin metadata for this page session. Automatic polling in this worker would
  // be delayed differently by successful and failed private-content decoding.
  // A user may explicitly reload to select a fresh publication.
}

async function collectReplies(queries, publicationId, requestId) {
  const signal = AbortSignal.timeout(BATCH_TIMEOUT_MS);
  let completed = 0;
  // Invoke every fetch before awaiting any response. The browser may queue HTTP
  // connections, but private reply contents never choose our dispatch plan.
  const tasks = queries.map(async query => {
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
  if (!client || !manifest) throw new LookupError('initialize');
  if (lookupInProgress || refreshing) throw new LookupError('busy');
  if (typeof txid !== 'string' || !/^[a-f0-9]{64}$/.test(txid)) throw new LookupError('invalid');
  if (!manifest.catalogue.some(record => record.txid === txid)) throw new LookupError('outside');
  lookupInProgress = true;
  let phase = 'query';
  const started = performance.now();
  let encryptMs = 0, requestMs = 0, decodeMs = 0, queryBytes = 0, responseBytes = 0;
  try {
    const chunks = client.begin_query(txid);
    txid = '';
    if (chunks !== manifest.chunkCount || chunks < 1 || chunks > MAX_BATCH_CHUNKS) throw new LookupError('query');
    const queries = [];
    const t0 = performance.now();
    for (let index = 0; index < chunks; index++) {
      const query = client.make_chunk_query(index);
      if (!(query instanceof Uint8Array) || query.length !== REQUEST_BYTES || query.length > MAX_QUERY_BYTES) throw new LookupError('query');
      queries.push(query);
      queryBytes += query.length;
    }
    encryptMs = performance.now() - t0;
    phase = 'decode';
    postMessage({ type: 'stage', requestId, stage: 'server', chunk: 0, chunks });
    const t1 = performance.now();
    const replies = await collectReplies(queries, manifest.publicationId, requestId);
    requestMs = performance.now() - t1;
    responseBytes = replies.reduce((total, answer) => total + answer.length, 0);
    // Only after every transport slot settles may any content be decrypted,
    // parsed, validated or exposed. Failure emits no partial result or retry.
    postMessage({ type: 'stage', requestId, stage: 'decode', chunks });
    const t2 = performance.now();
    let result;
    for (const answer of replies) {
      const decoded = client.decode_chunk_response(answer);
      if (decoded !== undefined && decoded !== null) result = JSON.parse(decoded);
    }
    decodeMs = performance.now() - t2;
    if (!result || result.found !== true || !result.detail || !result.raw || result.publicationId !== manifest.publicationId) throw new LookupError('decode');
    postMessage({ type: 'result', requestId, result, measurements: { queryBytes, responseBytes, encryptMs, requestMs, decodeMs, totalMs: performance.now() - started, chunkCount: chunks, publicationId: manifest.publicationId } });
  } catch (error) { throw error instanceof LookupError ? error : new LookupError(phase); }
  finally { client.cancel_query(); lookupInProgress = false; }
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
