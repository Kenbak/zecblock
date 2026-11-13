import init, { GlobalPirBrowser } from '/wasm/zecblock_pir_browser.js';

const REQUEST_BYTES = 20992, LAYER_REPLY_BYTES = 81920, PUBLIC_BYTES = 360448;
let browser, manifest, busy = false;
const options = signal => ({ credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer', signal });
async function bounded(response, maximum) {
  if (!response.ok || !response.body) throw new Error('transport');
  const reader = response.body.getReader(), parts = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > maximum) { await reader.cancel(); throw new Error('length'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
async function initialize() {
  await init();
  const signal = AbortSignal.timeout(120_000);
  const bytes = await bounded(await fetch('/publication/manifest.json', options(signal)), 2 * 1024 * 1024);
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (value.schema !== 'zecblock-private-global-v1' || !Number.isSafeInteger(value.layerCount) || value.layerCount < 1
    || value.layerCount > 128 || value.layers?.length !== value.layerCount || !/^[a-f0-9]{64}$/.test(value.publicationId)) throw new Error('manifest');
  // Every setup is fetched in public layer order before there is a selection.
  const setups = new Uint8Array(value.layerCount * PUBLIC_BYTES);
  for (let index = 0; index < value.layerCount; index++) {
    const setup = await bounded(await fetch(`/publication/layers/${index}/public.bin`, options(signal)), PUBLIC_BYTES);
    if (setup.length !== PUBLIC_BYTES) throw new Error('setup'); setups.set(setup, index * PUBLIC_BYTES);
  }
  browser = new GlobalPirBrowser(JSON.stringify(value), setups); manifest = value;
  self.postMessage({ type: 'ready', manifest: value, samples: [] });
  self.postMessage({ type: 'publication-warning', message: 'Experimental global index. Each returned record keeps its original captured snapshot. Full-history coverage and independent cryptographic review are pending.' });
}
async function lookup(data) {
  if (busy || !browser || !manifest) return;
  busy = true;
  const { requestId } = data, started = performance.now();
  try {
    self.postMessage({ type: 'stage', requestId, stage: 'query' });
    const query = browser.make_query(data.txid);
    if (query.length !== REQUEST_BYTES) throw new Error('query');
    const encrypted = performance.now();
    self.postMessage({ type: 'stage', requestId, stage: 'server' });
    const responsePending = fetch('/pir/query', { ...options(AbortSignal.timeout(900_000)), method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': manifest.publicationId }, body: query });
    // Observe rejection immediately while local CPU work runs, avoiding an
    // unhandled fetch rejection. This adds no request, retry or acknowledgement.
    responsePending.catch(() => {});
    const preparationStarted = performance.now();
    let preparationFailed = false;
    try { if (typeof browser.prepare_decode === 'function') browser.prepare_decode(); }
    catch { preparationFailed = true; }
    const decodePrepareMs = performance.now() - preparationStarted;
    const response = await responsePending;
    // The complete fixed bundle is consumed before a row is decoded or checked.
    const reply = await bounded(response, manifest.layerCount * LAYER_REPLY_BYTES);
    if (reply.length !== manifest.layerCount * LAYER_REPLY_BYTES) throw new Error('reply');
    const received = performance.now();
    self.postMessage({ type: 'stage', requestId, stage: 'decode' });
    if (preparationFailed) throw new Error('local preparation');
    const result = JSON.parse(browser.decode_response(reply));
    const decoded = performance.now();
    if (result.found !== true) {
      self.postMessage({ type: 'error', requestId, message: 'This transaction is absent from the pinned global publication. No additional lookup was made.' }); return;
    }
    self.postMessage({ type: 'result', requestId, result, measurements: { publicationId: manifest.publicationId,
      queryBytes: query.length, responseBytes: reply.length, layerCount: manifest.layerCount, chunkCount: 1,
      encryptMs: encrypted - started, requestMs: received - encrypted, decodePrepareMs,
      decoderCoefficientBytes: browser.decoder_coefficient_bytes ?? 0,
      decodeMs: decoded - received, totalMs: decoded - started } });
  } catch {
    browser?.cancel_query();
    self.postMessage({ type: 'error', requestId, message: 'The private response could not be verified. No retry or public lookup was made.' });
  } finally { busy = false; }
}
self.addEventListener('message', event => {
  if (event.data?.type === 'initialize') initialize().catch(() => self.postMessage({ type: 'error', message: 'The experimental global publication could not be initialized.' }));
  else if (event.data?.type === 'lookup') lookup(event.data);
});
