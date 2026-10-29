// The transaction selector and pending decryption secret remain in this worker.
// All network paths are fixed and independent of the selected transaction.
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SETUP_BYTES = 128 * 1024 * 1024;
const MAX_QUERY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
let client = null;
let initializing = null;
let lookupInProgress = false;

class LookupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const errors = {
  unsupported: 'This browser cannot run the local private lookup client. Use a browser with WebAssembly and secure browser cryptography.',
  manifest: 'The local fixture manifest is unavailable or incompatible. Rebuild and restart the prototype.',
  setup: 'The local public setup is unavailable, too large or does not match its published checksum. Lookup stopped.',
  initialize: 'The browser PIR client could not initialize. Check the local prototype build and reload this page.',
  invalid: 'Enter exactly 64 hexadecimal characters. Validation stays in this browser.',
  busy: 'A private lookup is already running. Wait for it to finish.',
  query: 'The browser could not prepare a valid encrypted query. No transaction identifier was sent to an ordinary API.',
  network: 'The local evaluator did not return a valid encrypted response. No ordinary lookup fallback was attempted.',
  decode: 'The response did not resolve to a supported fixture transaction. It may be missing, malformed or incompatible. No ordinary lookup fallback was attempted.',
};

async function boundedBytes(response, maximum, code) {
  if (!response.ok || !response.body) throw new LookupError(code);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximum) throw new LookupError(code);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new LookupError(code);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function options() {
  return {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    mode: 'same-origin',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(45_000),
  };
}

async function initialize() {
  if (typeof WebAssembly !== 'object' || !globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new LookupError('unsupported');
  const manifestResponse = await fetch('/fixture/manifest.json', options());
  const manifestBytes = await boundedBytes(manifestResponse, MAX_MANIFEST_BYTES, 'manifest');
  let manifest;
  const manifestJson = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    throw new LookupError('manifest');
  }
  if (manifest.schema !== 'zecblock-private-tx-fixture-v1' || manifest.geometry !== 'fixture-2k'
      || manifest.rows !== 2048 || manifest.rowBytes !== 2048 || !/^[a-f\d]{64}$/.test(manifest.publicSha256)) {
    throw new LookupError('manifest');
  }
  const publicResponse = await fetch('/fixture/public.bin', options());
  const publicSetup = await boundedBytes(publicResponse, MAX_SETUP_BYTES, 'setup');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicSetup));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== manifest.publicSha256) throw new LookupError('setup');

  const module = await import('/wasm/zecblock_pir_browser.js');
  await module.default({ module_or_path: '/wasm/zecblock_pir_browser_bg.wasm' });
  client = new module.PirBrowser(manifestJson, publicSetup);
  postMessage({ type: 'ready', samples: Array.isArray(manifest.catalogue) ? manifest.catalogue : [] });
}

async function lookup(txid, requestId) {
  if (!client) throw new LookupError('initialize');
  if (lookupInProgress) throw new LookupError('busy');
  if (typeof txid !== 'string' || !/^[a-f\d]{64}$/.test(txid)) throw new LookupError('invalid');
  lookupInProgress = true;
  let phase = 'query';
  try {
    const started = performance.now();
    const query = client.make_query(txid);
    // This local string is not needed after the client creates its private query state.
    txid = '';
    if (!(query instanceof Uint8Array) || query.byteLength === 0 || query.byteLength > MAX_QUERY_BYTES) throw new LookupError('query');
    const encrypted = performance.now();
    phase = 'network';
    postMessage({ type: 'stage', requestId, stage: 'server' });
    const response = await fetch('/pir/query', {
      ...options(),
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: query,
    });
    if (!response.headers.get('content-type')?.startsWith('application/octet-stream')) throw new LookupError('network');
    const answer = await boundedBytes(response, MAX_RESPONSE_BYTES, 'network');
    if (answer.byteLength === 0) throw new LookupError('network');
    const received = performance.now();
    phase = 'decode';
    postMessage({ type: 'stage', requestId, stage: 'decode' });
    const decoded = client.decode_response(answer);
    const result = JSON.parse(decoded);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new LookupError('decode');
    const finished = performance.now();
    postMessage({
      type: 'result', requestId, result,
      measurements: {
        queryBytes: query.byteLength,
        responseBytes: answer.byteLength,
        encryptMs: encrypted - started,
        requestMs: received - encrypted,
        decodeMs: finished - received,
        totalMs: finished - started,
      },
    });
  } catch (error) {
    throw error instanceof LookupError ? error : new LookupError(phase);
  } finally {
    client.cancel_query();
    lookupInProgress = false;
  }
}

self.addEventListener('message', async ({ data }) => {
  const requestId = data?.requestId;
  try {
    if (data?.type === 'initialize') {
      initializing ||= initialize();
      await initializing;
    } else if (data?.type === 'lookup') {
      await lookup(data.txid, requestId);
    }
  } catch (error) {
    const code = error instanceof LookupError ? error.code : 'initialize';
    postMessage({ type: 'error', requestId, message: errors[code] || errors.initialize });
  }
});
