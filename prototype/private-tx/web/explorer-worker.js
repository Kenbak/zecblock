// Worker for the all-transactions private explorer test. The txid, its row and
// decryption secrets stay inside WASM in this worker; requests carry only
// opaque encrypted bytes. No public API is ever called.
import init, { ExplorerPirBrowser } from '/wasm/zecblock_pir_browser.js';

let browser, manifest, busy = false;
const options = signal => ({ credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer', signal });
async function bytes(path, init = {}) {
  const response = await fetch(path, { ...options(AbortSignal.timeout(300_000)), ...init });
  if (!response.ok) throw new Error('transport');
  return { body: new Uint8Array(await response.arrayBuffer()), response };
}
const zec = zat => zat == null ? null : Number(BigInt(zat)) / 1e8;

async function initialize() {
  await init();
  const text = new TextDecoder().decode((await bytes('/manifest')).body);
  const value = JSON.parse(text);
  if (value.schema !== 'zecblock-private-explorer-test-v1' || !Number.isSafeInteger(value.snapshotTip)) throw new Error('manifest');
  // Public parameters are fetched for every table before any selection exists.
  const [main, overflow] = await Promise.all([bytes('/publics/main'), bytes('/publics/overflow')]);
  browser = new ExplorerPirBrowser(text, main.body, overflow.body);
  manifest = {
    schema: value.schema,
    publicationId: `explorer-${value.snapshotTip}-${value.records}`,
    network: 'mainnet',
    snapshot: { height: value.snapshotTip, hash: '', publishedAt: value.builtAt ?? new Date(0).toISOString() },
    coverage: { startHeight: 0, endHeight: value.snapshotTip, complete: true },
    sourceSummary: { recordCount: value.records },
    tables: { main: value.main.instances, overflow: value.overflow.instances },
  };
  self.postMessage({ type: 'ready', manifest, samples: [] });
}

async function ask(table, upload) {
  const { body, response } = await bytes(`/query/${table}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: upload });
  return { body, serverMs: Number(response.headers.get('x-server-ns') || 0) / 1e6 };
}

async function lookup({ requestId, txid }) {
  if (busy || !browser) return;
  busy = true;
  const started = performance.now();
  try {
    self.postMessage({ type: 'stage', requestId, stage: 'query' });
    const upload = browser.query_main(txid);
    const encrypted = performance.now();
    self.postMessage({ type: 'stage', requestId, stage: 'server' });
    const main = await ask('main', upload);
    const received = performance.now();
    self.postMessage({ type: 'stage', requestId, stage: 'decode' });
    let result = JSON.parse(browser.decode_main(main.body));
    let queryBytes = upload.length, responseBytes = main.body.length, overflowMs = 0, overflowRows = 0, serverMs = main.serverMs;
    if (result.needsOverflow) {
      overflowRows = result.needsOverflow;
      const t = performance.now();
      self.postMessage({ type: 'stage', requestId, stage: 'server', chunk: 2, chunks: 2 });
      const more = browser.query_overflow();
      const reply = await ask('overflow', more);
      result = JSON.parse(browser.decode_overflow(reply.body));
      queryBytes += more.length; responseBytes += reply.body.length; serverMs += reply.serverMs;
      overflowMs = performance.now() - t;
    }
    const decoded = performance.now();
    if (result.found !== true) {
      self.postMessage({ type: 'error', requestId, message: `No confirmed transaction with this ID up to block ${manifest.snapshot.height.toLocaleString()}. The server cannot tell this lookup from a found one, and no public lookup was made.` });
      return;
    }
    const detail = {
      ...result,
      isCanonical: true,
      confirmations: manifest.snapshot.height - result.blockHeight + 1,
      fee: zec(result.feeZat) ?? 0,
      totalInput: zec(result.totalInputZat),
      totalOutput: zec(result.totalOutputZat),
      valueBalance: zec(result.valueBalanceZat),
      valueBalanceSapling: zec(result.valueBalanceSaplingZat),
      valueBalanceOrchard: zec(result.valueBalanceOrchardZat),
      valueBalanceIronwood: zec(result.valueBalanceIronwoodZat),
      hasShielded: Boolean(result.hasSprout || result.hasSapling || result.hasOrchard || result.hasIronwood),
    };
    const record = {
      schema: 'zecblock-private-tx-record-v1', found: true, publicationId: manifest.publicationId, network: 'mainnet',
      snapshot: manifest.snapshot, coverage: manifest.coverage, txid: result.txid, detail, raw: null, price: null,
    };
    self.postMessage({ type: 'result', requestId, result: record, measurements: {
      queryBytes, responseBytes, encryptMs: encrypted - started, requestMs: received - encrypted,
      serverMs, overflowRows, overflowMs, decodeMs: decoded - received - overflowMs, totalMs: decoded - started } });
  } catch {
    self.postMessage({ type: 'error', requestId, message: 'The private response could not be decoded. No retry or public lookup was made.' });
  } finally { busy = false; }
}

self.addEventListener('message', event => {
  if (event.data?.type === 'initialize') initialize().catch(() => self.postMessage({ type: 'error', message: 'The private explorer publication could not be initialized.' }));
  else if (event.data?.type === 'lookup') lookup(event.data);
});
