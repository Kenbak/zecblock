// Worker for the private explorer. The txid, its rows and decryption secrets
// stay inside WASM in this worker; requests carry only opaque encrypted bytes.
// No public API is ever called.
//
// Two publications answer every lookup: the large base snapshot and a small
// recent table (blocks since the base, rebuilt every few minutes, plus
// "spent since the base" markers). Both are always asked with the same shape,
// so the server cannot tell an old transaction from a new one or a miss.
import init, { ExplorerPirBrowser } from '/wasm/zecblock_pir_browser.js';

const SCHEMA = 'zecblock-private-explorer-v3';
// `base` and `recent` are { browser, id, info } for verified publications.
let base, recent = null, busy = false, last = null, ready = null;
const options = signal => ({ credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer', signal });
class Gone extends Error {}
async function bytes(path, init = {}) {
  const response = await fetch(path, { ...options(AbortSignal.timeout(300_000)), ...init });
  if (response.status === 410) throw new Gone();
  if (!response.ok) throw new Error('transport');
  return { body: new Uint8Array(await response.arrayBuffer()), response };
}
const zec = zat => zat == null ? null : Number(BigInt(zat)) / 1e8;
const tip = () => recent?.info.snapshotTip ?? base.info.snapshotTip;
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const publicationId = async manifest => hex(await crypto.subtle.digest('SHA-256', manifest)).slice(0, 24);

// Fetches a signed publication. The WASM constructor rejects it unless the
// signature is from the pinned ZecBlock key; rows are then checked against
// its roots on every decode. Returns null when the server has none.
async function open(set, manifestPath) {
  const response = await fetch(manifestPath, options(AbortSignal.timeout(30_000)));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('transport');
  const manifest = new Uint8Array(await response.arrayBuffer());
  const id = await publicationId(manifest);
  const [signature, main, overflow] = await Promise.all([bytes(`/${set}/${id}/manifest.sig`), bytes(`/${set}/${id}/publics/main`), bytes(`/${set}/${id}/publics/overflow`)]);
  const browser = new ExplorerPirBrowser(manifest, signature.body, main.body, overflow.body);
  if (browser.publication_id !== id) throw new Error('publication id');
  const info = JSON.parse(new TextDecoder().decode(manifest));
  if (info.schema !== SCHEMA || !Number.isSafeInteger(info.snapshotTip)) throw new Error('manifest');
  return { browser, id, info };
}

function publication() {
  const builtAt = recent?.info.builtAt ?? base.info.builtAt;
  return {
    schema: SCHEMA,
    publicationId: base.id,
    network: 'mainnet',
    snapshot: { height: tip(), hash: '', publishedAt: Number.isSafeInteger(builtAt) ? new Date(builtAt * 1000).toISOString() : new Date(0).toISOString() },
    coverage: { startHeight: 0, endHeight: tip(), complete: true },
    sourceSummary: { recordCount: base.info.records + (recent?.info.records ?? 0) },
  };
}

async function initialize() {
  await init();
  // Public parameters are fetched for every table before any selection exists.
  base = await open('base', '/manifest');
  if (!base) throw new Error('no base publication');
  await refreshRecent().catch(() => {});
  self.postMessage({ type: 'ready', manifest: publication(), samples: [] });
  // The same public manifest for everyone, polled independently of lookups.
  setInterval(() => { if (!busy) refreshRecent().catch(() => {}); }, 20_000);
}

// Same public manifest for everyone; fetched before each lookup.
async function refreshRecent() {
  const response = await fetch('/recent/manifest', options(AbortSignal.timeout(30_000)));
  if (response.status === 404) { if (recent) { recent = null; self.postMessage({ type: 'tip', manifest: publication() }); } return; }
  if (!response.ok) throw new Error('transport');
  const manifest = new Uint8Array(await response.arrayBuffer());
  if (await publicationId(manifest) === recent?.id) return;
  const next = await open('recent', '/recent/manifest');
  if (next && next.info.baseTip !== base.info.snapshotTip) throw new Error('recent table is for another base');
  recent = next;
  self.postMessage({ type: 'tip', manifest: publication() });
}

// A replaced base answers 410: load the new one, then the matching recent table.
async function reloadBase() {
  ready = null;
  base = await open('base', '/manifest');
  recent = null;
  await refreshRecent();
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

// Encrypts the selection and computes its decoding products before anything
// is sent. Called ahead of time when the page has a complete txid, so a
// submitted lookup costs only the network round trip and the final decrypt.
function prepare(txid, ahead) {
  if (ready?.txid === txid && ready.used === recent && ready.usedBase === base) return ready;
  const started = performance.now();
  const used = recent;
  const usedBase = base;
  const baseUpload = usedBase.browser.query_main(txid);
  const recentUpload = used?.browser.query_main(txid);
  if (ahead) { usedBase.browser.prepare_decode(); used?.browser.prepare_decode(); }
  ready = { txid, used, usedBase, baseUpload, recentUpload, ahead, encryptMs: performance.now() - started };
  return ready;
}

async function lookupOnce(txid) {
  const started = performance.now();
  const { used, usedBase, baseUpload, recentUpload, encryptMs, ahead } = prepare(txid, false);
  ready = null;
  const encrypted = performance.now();
  const replies = Promise.all([
    ask(`/base/${usedBase.id}/query/main`, baseUpload),
    used ? ask(`/recent/${used.id}/query/main`, recentUpload) : null,
  ]);
  // No-ops when prepared ahead; otherwise overlaps the network round trip.
  usedBase.browser.prepare_decode();
  used?.browser.prepare_decode();
  const [baseReply, recentReply] = await replies;
  const received = performance.now();
  const fromBase = JSON.parse(usedBase.browser.decode_main(baseReply.body));
  const baseDecoded = performance.now();
  const fromRecent = used ? JSON.parse(used.browser.decode_main(recentReply.body)) : null;
  const decoded = performance.now();
  const owner = fromRecent?.found === true ? 'recent' : fromBase.found === true ? 'base' : null;
  const spent = owner === 'base' ? fromRecent?.outputsSpentSinceBase : undefined;
  last = owner ? { owner, used, usedBase, spent } : null;
  const measurements = {
    queryBytes: baseUpload.length + (recentUpload?.length ?? 0), responseBytes: baseReply.body.length + (recentReply?.body.length ?? 0),
    encryptMs: ahead ? 0 : encryptMs, preparedAheadMs: ahead ? encryptMs : 0, requestMs: received - encrypted, serverMs: baseReply.serverMs + (recentReply?.serverMs ?? 0),
    decodeMs: decoded - received, baseDecodeMs: baseDecoded - received, recentDecodeMs: decoded - baseDecoded, totalMs: decoded - started,
  };
  return { owner, result: owner === 'recent' ? fromRecent : markSpent(fromBase, spent), measurements };
}

async function lookup({ requestId, txid }) {
  if (busy || !base) return;
  busy = true;
  try {
    let outcome;
    // A rebuild can land between the manifest and the query; retry once.
    try { outcome = await lookupOnce(txid); } catch (error) {
      if (!(error instanceof Gone)) throw error;
      // The same recovery for every client after a rebuild; then one retry.
      await reloadBase();
      outcome = await lookupOnce(txid);
    }
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
    const { owner, used, usedBase, spent } = last;
    const ownerBrowser = owner === 'recent' ? used.browser : usedBase.browser;
    const upload = ownerBrowser.query_full();
    const count = new DataView(upload.buffer, upload.byteOffset).getUint32(0, true);
    const ownerPath = owner === 'recent' ? `/recent/${used.id}/query/overflow` : `/base/${usedBase.id}/query/overflow`;
    const other = owner === 'recent' ? { browser: usedBase.browser, path: `/base/${usedBase.id}/query/overflow` } : used ? { browser: used.browser, path: `/recent/${used.id}/query/overflow` } : null;
    const dummy = other?.browser.query_dummy(count);
    const encrypted = performance.now();
    const replies = Promise.all([ask(ownerPath, upload), other ? ask(other.path, dummy) : null]);
    ownerBrowser.prepare_decode();
    const [reply, dummyReply] = await replies;
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
  else if (event.data?.type === 'prepare' && base && !busy && /^[a-f\d]{64}$/.test(event.data.txid)) { try { prepare(event.data.txid, true); } catch { ready = null; } }
  else if (event.data?.type === 'loadFull') loadFull(event.data);
});
