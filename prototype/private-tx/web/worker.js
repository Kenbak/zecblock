// Selection, private query secrets and plaintext result assembly stay here.
// Only generic manifest/setup downloads and fixed binary queries leave it.
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SETUP_BYTES = 128 * 1024 * 1024;
const MAX_QUERY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
let client, manifest, initializing, timer;
let lookupInProgress = false;
let refreshing = false;
class LookupError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const errors = {
  initialize: 'The local private publication could not initialize. Publish recent data and reload.',
  manifest: 'The local publication is unavailable or incompatible. No public lookup was attempted.',
  setup: 'The publication setup failed validation. No public lookup was attempted.',
  invalid: 'Enter exactly 64 hexadecimal characters. Validation stays in this browser.',
  outside: 'This transaction is outside the published confirmed range. This does not mean it is missing from Zcash.',
  query: 'The browser could not create the encrypted request. No public lookup was attempted.',
  network: 'The local query service is unavailable or the publication was retired. Reload the catalogue and try again. No public lookup was attempted.',
  decode: 'The response was incomplete, changed or incompatible. The result was rejected without a public lookup fallback.',
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
const options = () => ({ cache: 'no-store', credentials: 'omit', redirect: 'error', mode: 'same-origin', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60_000) });
async function refreshPublication() {
  if (lookupInProgress || refreshing) return;
  refreshing = true;
  try {
    const bytes = await boundedBytes(await fetch('/publication/manifest.json', options()), MAX_MANIFEST_BYTES, 'manifest');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const next = JSON.parse(json);
    if (next.schema !== 'zecblock-private-tx-full-v1' || !/^[a-f0-9]{64}$/.test(next.publicationId) || !Array.isArray(next.catalogue)) throw new LookupError('manifest');
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
  clearInterval(timer);
  // Refresh is uniform metadata traffic, independent of the selected record.
  timer = setInterval(() => {
    refreshPublication().catch(() => postMessage({ type: 'publication-warning', message: 'Publication refresh is unavailable. Displayed results remain tied to their captured snapshot.' }));
  }, 30_000);
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
    if (chunks !== manifest.chunkCount) throw new LookupError('query');
    let result;
    for (let index = 0; index < chunks; index++) {
      phase = 'query';
      const t0 = performance.now();
      const query = client.make_chunk_query(index);
      encryptMs += performance.now() - t0;
      if (!(query instanceof Uint8Array) || !query.length || query.length > MAX_QUERY_BYTES) throw new LookupError('query');
      phase = 'network';
      postMessage({ type: 'stage', requestId, stage: 'server', chunk: index + 1, chunks });
      const t1 = performance.now();
      const response = await fetch('/pir/query', { ...options(), method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': manifest.publicationId }, body: query });
      if (!response.headers.get('content-type')?.startsWith('application/octet-stream')) throw new LookupError('network');
      const answer = await boundedBytes(response, MAX_RESPONSE_BYTES, 'network');
      requestMs += performance.now() - t1;
      queryBytes += query.length;
      responseBytes += answer.length;
      phase = 'decode';
      postMessage({ type: 'stage', requestId, stage: 'decode', chunk: index + 1, chunks });
      const t2 = performance.now();
      const decoded = client.decode_chunk_response(answer);
      decodeMs += performance.now() - t2;
      if (decoded !== undefined && decoded !== null) result = JSON.parse(decoded);
    }
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
