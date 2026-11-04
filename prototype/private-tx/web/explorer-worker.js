// Worker for the private explorer. The txid, its rows and decryption secrets
// stay inside WASM in this worker; requests carry only opaque encrypted bytes.
// No public API is ever called.
//
// Two publications answer every lookup: the large base snapshot and a small
// recent table (blocks since the base, rebuilt every few minutes, plus
// "spent since the base" markers). Both are always asked with the same shape,
// so the server cannot tell an old transaction from a new one or a miss.
import init, { ExplorerPirBrowser } from '/wasm/zecblock_pir_browser.js';

const SCHEMA = 'zecblock-private-explorer-test-v2';
let base, baseInfo, recent = null, busy = false, last = null;
const options = signal => ({ credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer', signal });
class Gone extends Error {}
async function bytes(path, init = {}) {
  const response = await fetch(path, { ...options(AbortSignal.timeout(300_000)), ...init });
  if (response.status === 410) throw new Gone();
  if (!response.ok) throw new Error('transport');
  return { body: new Uint8Array(await response.arrayBuffer()), response };
}
const zec = zat => zat == null ? null : Number(BigInt(zat)) / 1e8;
const tip = () => recent?.tip ?? baseInfo.snapshotTip;

function publication() {
  const builtAt = recent?.builtAt ?? baseInfo.builtAt;
  return {
    schema: SCHEMA,
    publicationId: `explorer-${baseInfo.snapshotTip}-${baseInfo.records}`,
    network: 'mainnet',
    snapshot: { height: tip(), hash: '', publishedAt: Number.isSafeInteger(builtAt) ? new Date(builtAt * 1000).toISOString() : new Date(0).toISOString() },
    coverage: { startHeight: 0, endHeight: tip(), complete: true },
    sourceSummary: { recordCount: baseInfo.records + (recent?.records ?? 0) },
  };
}

async function initialize() {
  await init();
  const text = new TextDecoder().decode((await bytes('/manifest')).body);
  baseInfo = JSON.parse(text);
  if (baseInfo.schema !== SCHEMA || !Number.isSafeInteger(baseInfo.snapshotTip)) throw new Error('manifest');
  // Public parameters are fetched for every table before any selection exists.
  const [main, overflow] = await Promise.all([bytes('/publics/main'), bytes('/publics/overflow')]);
  base = new ExplorerPirBrowser(text, main.body, overflow.body);
  await refreshRecent().catch(() => {});
  self.postMessage({ type: 'ready', manifest: publication(), samples: [] });
}

// Same public manifest for everyone; fetched before each lookup.
async function refreshRecent() {
  const response = await fetch('/recent/manifest', options(AbortSignal.timeout(30_000)));
  if (response.status === 404) { if (recent) { recent = null; self.postMessage({ type: 'tip', manifest: publication() }); } return; }
  if (!response.ok) throw new Error('transport');
  const text = await response.text();
  const value = JSON.parse(text);
  if (value.id === recent?.id) return;
  if (value.schema !== SCHEMA || value.baseTip !== baseInfo.snapshotTip || !Number.isSafeInteger(value.snapshotTip) || !/^[a-f\d]{24}$/.test(value.id)) throw new Error('recent manifest');
  const [main, overflow] = await Promise.all([bytes(`/recent/${value.id}/publics/main`), bytes(`/recent/${value.id}/publics/overflow`)]);
  recent = { browser: new ExplorerPirBrowser(text, main.body, overflow.body), id: value.id, tip: value.snapshotTip, records: value.records, builtAt: value.builtAt };
  self.postMessage({ type: 'tip', manifest: publication() });
}

async function ask(path, upload) {
  const { body, response } = await bytes(path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: upload });
  return { body, serverMs: Number(response.headers.get('x-server-ns') || 0) / 1e6 };
}

function markSpent(result, spent) {
  if (!spent?.length) return result;
  const set = new Set(spent);
  return { ...result, outputs: result.outputs.map(output => set.has(output.vout_index) ? { ...output, spent: true } : output) };
}

function toRecord(result) {
  const detail = {
    ...result,
    isCanonical: true,
    confirmations: tip() - result.blockHeight + 1,
    fee: zec(result.feeZat) ?? 0,
    totalInput: zec(result.totalInputZat),
    totalOutput: zec(result.totalOutputZat),
    valueBalance: zec(result.valueBalanceZat),
    valueBalanceSapling: zec(result.valueBalanceSaplingZat),
    valueBalanceOrchard: zec(result.valueBalanceOrchardZat),
    valueBalanceIronwood: zec(result.valueBalanceIronwoodZat),
    hasShielded: Boolean(result.hasSprout || result.hasSapling || result.hasOrchard || result.hasIronwood),
  };
  const manifest = publication();
  return {
    schema: 'zecblock-private-tx-record-v1', found: true, publicationId: manifest.publicationId, network: 'mainnet',
    snapshot: manifest.snapshot, coverage: manifest.coverage, txid: result.txid, detail, raw: null, price: null,
  };
}

function partialOf(result) {
  return result.partial ? {
    rows: result.fullRows, shownInputs: result.inputs.length, shownOutputs: result.outputs.length,
    totalInputs: result.vinCount ?? result.inputs.length, totalOutputs: result.voutCount ?? result.outputs.length,
  } : null;
}

async function lookupOnce(txid) {
  await refreshRecent();
  const started = performance.now();
  const used = recent;
  const baseUpload = base.query_main(txid);
  const recentUpload = used?.browser.query_main(txid);
  const encrypted = performance.now();
  const [baseReply, recentReply] = await Promise.all([
    ask('/query/main', baseUpload),
    used ? ask(`/recent/${used.id}/query/main`, recentUpload) : null,
  ]);
  const received = performance.now();
  const fromBase = JSON.parse(base.decode_main(baseReply.body));
  const fromRecent = used ? JSON.parse(used.browser.decode_main(recentReply.body)) : null;
  const decoded = performance.now();
  const owner = fromRecent?.found === true ? 'recent' : fromBase.found === true ? 'base' : null;
  const spent = owner === 'base' ? fromRecent?.outputsSpentSinceBase : undefined;
  last = owner ? { owner, used, spent } : null;
  const measurements = {
    queryBytes: baseUpload.length + (recentUpload?.length ?? 0), responseBytes: baseReply.body.length + (recentReply?.body.length ?? 0),
    encryptMs: encrypted - started, requestMs: received - encrypted, serverMs: baseReply.serverMs + (recentReply?.serverMs ?? 0),
    decodeMs: decoded - received, totalMs: decoded - started,
  };
  return { owner, result: owner === 'recent' ? fromRecent : markSpent(fromBase, spent), measurements };
}

async function lookup({ requestId, txid }) {
  if (busy || !base) return;
  busy = true;
  try {
    let outcome;
    // A rebuild can land between the manifest and the query; retry once.
    try { outcome = await lookupOnce(txid); } catch (error) { if (!(error instanceof Gone)) throw error; outcome = await lookupOnce(txid); }
    if (!outcome.owner) {
      self.postMessage({ type: 'notfound', requestId, snapshotHeight: tip() });
      return;
    }
    self.postMessage({ type: 'result', requestId, result: toRecord(outcome.result), partial: partialOf(outcome.result), measurements: outcome.measurements });
  } catch {
    self.postMessage({ type: 'error', requestId, message: 'The private lookup could not complete. No retry or public lookup was made.' });
  } finally { busy = false; }
}

// Only on an explicit request: the padded full form of a previewed record.
// The other publication receives the same number of dummy row queries.
async function loadFull({ requestId }) {
  if (busy || !base || !last) return;
  busy = true;
  const started = performance.now();
  try {
    const { owner, used, spent } = last;
    const ownerBrowser = owner === 'recent' ? used.browser : base;
    const upload = ownerBrowser.query_full();
    const count = new DataView(upload.buffer, upload.byteOffset).getUint32(0, true);
    const ownerPath = owner === 'recent' ? `/recent/${used.id}/query/overflow` : '/query/overflow';
    const other = owner === 'recent' ? { browser: base, path: '/query/overflow' } : used ? { browser: used.browser, path: `/recent/${used.id}/query/overflow` } : null;
    const dummy = other?.browser.query_dummy(count);
    const encrypted = performance.now();
    const [reply, dummyReply] = await Promise.all([ask(ownerPath, upload), other ? ask(other.path, dummy) : null]);
    const received = performance.now();
    const result = markSpent(JSON.parse(ownerBrowser.decode_full(reply.body)), spent);
    const decoded = performance.now();
    self.postMessage({ type: 'result', requestId, result: toRecord(result), partial: null, measurements: {
      queryBytes: upload.length + (dummy?.length ?? 0), responseBytes: reply.body.length + (dummyReply?.body.length ?? 0),
      encryptMs: encrypted - started, requestMs: received - encrypted, serverMs: reply.serverMs + (dummyReply?.serverMs ?? 0),
      decodeMs: decoded - received, totalMs: decoded - started, overflowRows: count } });
  } catch {
    self.postMessage({ type: 'error', requestId, message: 'The full inputs and outputs could not be retrieved. No retry or public lookup was made.' });
  } finally { busy = false; }
}

self.addEventListener('message', event => {
  if (event.data?.type === 'initialize') initialize().catch(() => self.postMessage({ type: 'error', message: 'The private explorer publication could not be initialized.' }));
  else if (event.data?.type === 'lookup') lookup(event.data);
  else if (event.data?.type === 'loadFull') loadFull(event.data);
});
