// Worker for the private explorer. Search terms, rows and decryption secrets
// stay inside WASM in this worker; requests carry only opaque encrypted bytes.
// No public API is ever called.
//
// Each kind of record (transactions, blocks) is a pair of publications: a
// large base snapshot and a small recent table (blocks since the base,
// rebuilt every few minutes; for transactions also "spent since the base"
// markers). Both are always asked with the same shape, so the server cannot
// tell an old record from a new one or a miss. Every publication is signed
// with the pinned ZecBlock key and every row is checked against its roots.
import init, { ExplorerPirBrowser, address_key, address_page_key, block_key } from '/wasm/zecblock_pir_browser.js';

const SCHEMA = 'zecblock-private-explorer-v3';
// pair: { name, baseSet, recentSet, base, recent }, each publication { browser, id, info }.
const tx = { name: 'tx', baseSet: 'base', recentSet: 'recent', base: null, recent: null };
const blocks = { name: 'block', baseSet: 'blocks', recentSet: 'blocks-recent', base: null, recent: null };
const addresses = { name: 'address', baseSet: 'addresses', recentSet: 'addresses-recent', base: null, recent: null };
// Older address history pages: one publication built with the address base.
let pages = null, lastAddress = null;
const ADDRESS = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;
let busy = false, last = null, ready = null, feed = null;
// Where encrypted queries go: this page's own origin, or the HTTPS origin
// named by the page (`explorer-worker.js?pir=https://pir.example`) when the
// page and the PIR service are hosted apart. No cookies are ever sent.
const PIR = (() => {
  const value = new URL(self.location.href).searchParams.get('pir');
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value.replace(/\/$/, '')) throw new Error('PIR origin must be an https origin');
  return url.origin;
})();
const at = path => PIR + path;
const options = signal => ({ credentials: 'omit', redirect: 'error', cache: 'no-store', mode: PIR ? 'cors' : 'same-origin', referrerPolicy: 'no-referrer', signal });
class Gone extends Error {}
async function bytes(path, init = {}) {
  const response = await fetch(at(path), { ...options(AbortSignal.timeout(300_000)), ...init });
  if (response.status === 410) throw new Gone();
  if (!response.ok) throw new Error('transport');
  return { body: new Uint8Array(await response.arrayBuffer()), response };
}
const zec = zat => zat == null ? null : Number(BigInt(zat)) / 1e8;
const tipOf = pair => pair.recent?.info.snapshotTip ?? pair.base?.info.snapshotTip ?? 0;
const tip = () => Math.max(tipOf(tx), tipOf(blocks));
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async data => hex(await crypto.subtle.digest('SHA-256', data));
const publicationId = async manifest => (await sha256(manifest)).slice(0, 24);

// Fetches a signed publication. The WASM constructor rejects it unless the
// signature is from the pinned ZecBlock key; rows are then checked against
// its roots on every decode. Returns null when the server has none.
async function open(set, manifestPath) {
  const response = await fetch(at(manifestPath), options(AbortSignal.timeout(30_000)));
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
  const builtAt = tx.recent?.info.builtAt ?? tx.base.info.builtAt;
  return {
    schema: SCHEMA,
    publicationId: tx.base.id,
    network: 'mainnet',
    snapshot: { height: tip(), hash: '', publishedAt: Number.isSafeInteger(builtAt) ? new Date(builtAt * 1000).toISOString() : new Date(0).toISOString() },
    coverage: { startHeight: 0, endHeight: tip(), complete: true },
    sourceSummary: { recordCount: tx.base.info.records + (tx.recent?.info.records ?? 0) },
    blocks: Boolean(blocks.base),
    addresses: Boolean(addresses.base),
  };
}

// The homepage feed: the same signed bytes for every visitor.
async function loadFeed() {
  const source = blocks.recent ? [blocks.recentSet, blocks.recent] : blocks.base ? [blocks.baseSet, blocks.base] : null;
  if (!source || !source[1].info.feedSha256) return;
  const [set, publication] = source;
  if (feed?.id === publication.id) return;
  const { body } = await bytes(`/${set}/${publication.id}/feed.json`);
  if (await sha256(body) !== publication.info.feedSha256) throw new Error('feed does not match the signed manifest');
  feed = { id: publication.id, data: JSON.parse(new TextDecoder().decode(body)) };
  self.postMessage({ type: 'feed', feed: feed.data });
}

async function refreshPair(pair) {
  if (!pair.base) return;
  const response = await fetch(at(`/${pair.recentSet}/manifest`), options(AbortSignal.timeout(30_000)));
  if (response.status === 404) { pair.recent = null; return; }
  if (!response.ok) throw new Error('transport');
  const manifest = new Uint8Array(await response.arrayBuffer());
  if (await publicationId(manifest) === pair.recent?.id) return;
  const next = await open(pair.recentSet, `/${pair.recentSet}/manifest`);
  if (next && next.info.baseTip !== pair.base.info.snapshotTip) throw new Error('recent table is for another base');
  pair.recent = next;
}

// Tables published after the page opened (blocks, addresses) are picked up
// here, with the same public manifest requests for every visitor.
async function openMissing() {
  if (!blocks.base) blocks.base = await open('blocks', '/blocks/manifest').catch(() => null);
  if (!addresses.base) addresses.base = await open('addresses', '/addresses/manifest').catch(() => null);
  if (addresses.base && !pages) pages = await openPages().catch(() => null);
}

async function refresh() {
  const before = JSON.stringify([tip(), Boolean(blocks.base), Boolean(addresses.base)]);
  await openMissing();
  await Promise.all([refreshPair(tx), refreshPair(blocks), refreshPair(addresses)]);
  await loadFeed().catch(() => {});
  if (JSON.stringify([tip(), Boolean(blocks.base), Boolean(addresses.base)]) !== before) self.postMessage({ type: 'tip', manifest: publication() });
}

// A replaced base answers 410: load the new one, then its recent table.
async function reloadPair(pair) {
  ready = null;
  pair.base = await open(pair.baseSet, pair.baseSet === 'base' ? '/manifest' : `/${pair.baseSet}/manifest`);
  pair.recent = null;
  if (pair === addresses) pages = await openPages();
  await refreshPair(pair);
  self.postMessage({ type: 'tip', manifest: publication() });
}

async function initialize() {
  await init();
  // Public parameters are fetched for every table before any search exists.
  tx.base = await open('base', '/manifest');
  if (!tx.base) throw new Error('no base publication');
  await refresh().catch(() => {});
  self.postMessage({ type: 'ready', manifest: publication(), samples: [] });
  if (feed) self.postMessage({ type: 'feed', feed: feed.data });
  // The same public manifests for everyone, polled independently of searches.
  setInterval(() => { if (!busy) refresh().catch(() => {}); }, 20_000);
}

async function ask(path, upload) {
  const { body, response } = await bytes(path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: upload });
  return { body, serverMs: Number(response.headers.get('x-server-ns') || 0) / 1e6 };
}

// Encrypted selections for one key in both publications of a pair. With
// `ahead`, decoding products are computed too, before anything is sent.
function prepare(pair, key, ahead) {
  if (ready?.pair === pair && ready.key === key && ready.used === pair.recent && ready.usedBase === pair.base) return ready;
  const started = performance.now();
  const used = pair.recent, usedBase = pair.base;
  const baseUpload = usedBase.browser.query_main(key);
  const recentUpload = used?.browser.query_main(key);
  if (ahead) { usedBase.browser.prepare_decode(); used?.browser.prepare_decode(); }
  const prepared = { pair, key, used, usedBase, baseUpload, recentUpload, ahead, encryptMs: performance.now() - started };
  if (pair === tx) ready = prepared;
  return prepared;
}

// One same-shape request to both publications of a pair.
async function queryPair(pair, key) {
  const started = performance.now();
  const { used, usedBase, baseUpload, recentUpload, encryptMs, ahead } = prepare(pair, key, false);
  if (pair === tx) ready = null;
  const encrypted = performance.now();
  const replies = Promise.all([
    ask(`/${pair.baseSet}/${usedBase.id}/query/main`, baseUpload),
    used ? ask(`/${pair.recentSet}/${used.id}/query/main`, recentUpload) : null,
  ]);
  // No-ops when prepared ahead; otherwise overlaps the network round trip.
  usedBase.browser.prepare_decode();
  used?.browser.prepare_decode();
  const [baseReply, recentReply] = await replies;
  const received = performance.now();
  const fromBase = JSON.parse(usedBase.browser.decode_main(baseReply.body));
  const fromRecent = used ? JSON.parse(used.browser.decode_main(recentReply.body)) : null;
  const decoded = performance.now();
  const owner = fromRecent?.found === true ? 'recent' : fromBase.found === true ? 'base' : null;
  return {
    owner, used, usedBase, fromBase, fromRecent,
    result: owner === 'recent' ? fromRecent : owner === 'base' ? fromBase : null,
    measurements: {
      queryBytes: baseUpload.length + (recentUpload?.length ?? 0), responseBytes: baseReply.body.length + (recentReply?.body.length ?? 0),
      encryptMs: ahead ? 0 : encryptMs, preparedAheadMs: ahead ? encryptMs : 0, requestMs: received - encrypted,
      serverMs: baseReply.serverMs + (recentReply?.serverMs ?? 0), decodeMs: decoded - received, totalMs: decoded - started,
    },
  };
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

const blockPartialOf = block => block.partial ? { rows: block.fullRows, shownTransactions: block.transactions.length, totalTransactions: block.transaction_count } : null;

async function lookupTx(txid) {
  const outcome = await queryPair(tx, txid);
  const spent = outcome.owner === 'base' ? outcome.fromRecent?.outputsSpentSinceBase : undefined;
  return { ...outcome, spent, result: outcome.owner === 'base' ? markSpent(outcome.result, spent) : outcome.result };
}

// Always two rounds to both block publications. Round one asks for the
// search key: a height key returns the record, a hash key returns a pointer
// to the height. Round two asks for that height, or for a random key when
// round one already has the record, so every block search looks the same.
async function lookupBlock(key) {
  const first = await queryPair(blocks, key);
  const pointer = first.result?.pointer;
  if (Number.isSafeInteger(pointer)) {
    const second = await queryPair(blocks, block_key(pointer));
    const measurements = Object.fromEntries(Object.keys(first.measurements).map(k => [k, first.measurements[k] + second.measurements[k]]));
    return { ...second, result: second.result && !Number.isSafeInteger(second.result.pointer) ? second.result : null, measurements };
  }
  // Same requests as a real second round; the replies are not needed, and
  // the first round's pending state (a preview to load in full) is kept.
  const started = performance.now();
  await Promise.all([
    ask(`/${blocks.baseSet}/${first.usedBase.id}/query/main`, first.usedBase.browser.query_dummy_main()),
    first.used ? ask(`/${blocks.recentSet}/${first.used.id}/query/main`, first.used.browser.query_dummy_main()) : null,
  ]);
  return { ...first, measurements: { ...first.measurements, totalMs: first.measurements.totalMs + performance.now() - started } };
}

// History pages must come from the same snapshot as the address base.
async function openPages() {
  const next = await open('address-pages', '/address-pages/manifest');
  return next && next.info.snapshotTip === addresses.base?.info.snapshotTip ? next : null;
}

const add = (a, b) => (BigInt(a ?? 0) + BigInt(b ?? 0)).toString();

// One same-shape request to both address publications. The base summary
// covers history up to its snapshot and the recent entry everything after,
// so totals add up and the recent transactions come first.
async function lookupAddress(address) {
  const outcome = await queryPair(addresses, address_key(address));
  // A summary cut short in a crowded bucket: fetch its full form now, with
  // the same padded request (and dummy to the other table) as "Load all".
  for (const side of ['fromBase', 'fromRecent']) {
    if (outcome[side]?.found && outcome[side].partial) {
      const owner = side === 'fromBase' ? 'base' : 'recent';
      outcome[side] = await fetchFull({ pair: addresses, owner, used: outcome.used, usedBase: outcome.usedBase });
    }
  }
  const base = outcome.fromBase?.found ? outcome.fromBase : null;
  const recent = outcome.fromRecent?.found ? outcome.fromRecent : null;
  if (!base && !recent) return { ...outcome, result: null };
  const received = add(base?.total_received, recent?.total_received);
  const sent = add(base?.total_sent, recent?.total_sent);
  return { ...outcome, result: {
    address, total_received: received, total_sent: sent, balance: (BigInt(received) - BigInt(sent)).toString(),
    tx_count: (base?.tx_count ?? 0) + (recent?.tx_count ?? 0),
    first_seen: base?.first_seen ?? recent?.first_seen ?? 0, last_seen: recent?.last_seen ?? base?.last_seen ?? 0,
    pages: base?.pages ?? 0, loadedPages: 0, recentTruncated: Boolean(recent && recent.tx_count > recent.transactions.length),
    transactions: [...(recent?.transactions ?? []), ...(base?.transactions ?? [])],
  } };
}

// Only on request: the next older page of the last address, one query.
async function loadMore({ requestId }) {
  if (busy || !lastAddress || !pages || lastAddress.loadedPages >= lastAddress.pages) return;
  busy = true;
  const started = performance.now();
  try {
    const page = lastAddress.loadedPages + 1;
    const upload = pages.browser.query_main(address_page_key(lastAddress.address, page));
    const reply = ask(`/address-pages/${pages.id}/query/main`, upload);
    pages.browser.prepare_decode();
    const { body } = await reply;
    const result = JSON.parse(pages.browser.decode_main(body));
    if (!result.found) throw new Error('page');
    lastAddress = { ...lastAddress, loadedPages: page, transactions: [...lastAddress.transactions, ...result.transactions] };
    self.postMessage({ type: 'address', requestId, address: lastAddress, measurements: { totalMs: performance.now() - started } });
  } catch {
    self.postMessage({ type: 'error', requestId, message: 'More history could not be retrieved. No retry or public lookup was made.' });
  } finally { busy = false; }
}

// Retries once when a base was replaced mid-search (same for every client).
async function withReload(run, pairs) {
  try { return await run(); } catch (error) {
    if (!(error instanceof Gone)) throw error;
    for (const pair of pairs) await reloadPair(pair);
    return run();
  }
}

// A search: digits are a block height; 64 hex characters are a txid or a
// block hash, so both are always looked up for them.
async function lookup({ requestId, txid, query }) {
  if (busy || !tx.base) return;
  busy = true;
  const term = String(query ?? txid ?? '').trim().toLowerCase();
  try {
    const original = String(query ?? txid ?? '').trim();
    if (ADDRESS.test(original)) {
      if (!addresses.base) throw new Error('addresses unavailable');
      const outcome = await withReload(() => lookupAddress(original), [addresses]);
      if (!outcome.result) { lastAddress = null; self.postMessage({ type: 'notfound', requestId, snapshotHeight: tip(), kind: 'address' }); return; }
      lastAddress = outcome.result;
      self.postMessage({ type: 'address', requestId, address: lastAddress, measurements: outcome.measurements });
      return;
    }
    const isHeight = /^\d{1,10}$/.test(term) && Number(term) <= 0xffffffff;
    if (!isHeight && !/^[a-f\d]{64}$/.test(term)) throw new Error('search');
    if (isHeight && !blocks.base) throw new Error('blocks unavailable');
    const [txOutcome, blockOutcome] = await withReload(() => Promise.all([
      isHeight ? null : lookupTx(term),
      blocks.base ? lookupBlock(isHeight ? block_key(Number(term)) : term) : null,
    ]), isHeight ? [blocks] : [tx, ...(blocks.base ? [blocks] : [])]);
    if (txOutcome?.owner) {
      last = { pair: tx, owner: txOutcome.owner, used: txOutcome.used, usedBase: txOutcome.usedBase, spent: txOutcome.spent };
      self.postMessage({ type: 'result', requestId, result: toRecord(txOutcome.result), partial: partialOf(txOutcome.result), measurements: txOutcome.measurements });
    } else if (blockOutcome?.result) {
      last = { pair: blocks, owner: blockOutcome.owner, used: blockOutcome.used, usedBase: blockOutcome.usedBase };
      const block = { ...blockOutcome.result, confirmations: tip() - blockOutcome.result.height + 1 };
      self.postMessage({ type: 'block', requestId, block, partial: blockPartialOf(block), measurements: blockOutcome.measurements });
    } else {
      last = null;
      self.postMessage({ type: 'notfound', requestId, snapshotHeight: tip(), kind: isHeight ? 'block' : 'any' });
    }
  } catch {
    self.postMessage({ type: 'error', requestId, message: 'The private lookup could not complete. No retry or public lookup was made.' });
  } finally { busy = false; }
}

// The padded full form of a previewed record from `owner`; the other
// publication of the pair receives the same number of dummy row queries.
async function fetchFull({ pair, owner, used, usedBase }) {
  const ownerBrowser = owner === 'recent' ? used.browser : usedBase.browser;
  const upload = ownerBrowser.query_full();
  const count = new DataView(upload.buffer, upload.byteOffset).getUint32(0, true);
  const ownerPath = owner === 'recent' ? `/${pair.recentSet}/${used.id}/query/overflow` : `/${pair.baseSet}/${usedBase.id}/query/overflow`;
  const other = owner === 'recent' ? { browser: usedBase.browser, path: `/${pair.baseSet}/${usedBase.id}/query/overflow` }
    : used ? { browser: used.browser, path: `/${pair.recentSet}/${used.id}/query/overflow` } : null;
  const replies = Promise.all([ask(ownerPath, upload), other ? ask(other.path, other.browser.query_dummy(count)) : null]);
  ownerBrowser.prepare_decode();
  const [reply] = await replies;
  return JSON.parse(ownerBrowser.decode_full(reply.body));
}

// Only on an explicit request: the padded full form of a previewed record.
// The other publication receives the same number of dummy row queries.
async function loadFull({ requestId }) {
  if (busy || !last) return;
  busy = true;
  const started = performance.now();
  try {
    const { pair, owner, used, usedBase, spent } = last;
    const ownerBrowser = owner === 'recent' ? used.browser : usedBase.browser;
    const upload = ownerBrowser.query_full();
    const count = new DataView(upload.buffer, upload.byteOffset).getUint32(0, true);
    const ownerPath = owner === 'recent' ? `/${pair.recentSet}/${used.id}/query/overflow` : `/${pair.baseSet}/${usedBase.id}/query/overflow`;
    const other = owner === 'recent' ? { browser: usedBase.browser, path: `/${pair.baseSet}/${usedBase.id}/query/overflow` }
      : used ? { browser: used.browser, path: `/${pair.recentSet}/${used.id}/query/overflow` } : null;
    const dummy = other?.browser.query_dummy(count);
    const encrypted = performance.now();
    const replies = Promise.all([ask(ownerPath, upload), other ? ask(other.path, dummy) : null]);
    ownerBrowser.prepare_decode();
    const [reply, dummyReply] = await replies;
    const received = performance.now();
    const full = JSON.parse(ownerBrowser.decode_full(reply.body));
    const decoded = performance.now();
    const measurements = {
      queryBytes: upload.length + (dummy?.length ?? 0), responseBytes: reply.body.length + (dummyReply?.body.length ?? 0),
      encryptMs: encrypted - started, requestMs: received - encrypted, serverMs: reply.serverMs + (dummyReply?.serverMs ?? 0),
      decodeMs: decoded - received, totalMs: decoded - started, overflowRows: count };
    if (pair === tx) self.postMessage({ type: 'result', requestId, result: toRecord(markSpent(full, spent)), partial: null, measurements });
    else self.postMessage({ type: 'block', requestId, block: { ...full, confirmations: tip() - full.height + 1 }, partial: null, measurements });
  } catch {
    self.postMessage({ type: 'error', requestId, message: 'The full record could not be retrieved. No retry or public lookup was made.' });
  } finally { busy = false; }
}

self.addEventListener('message', event => {
  const data = event.data;
  if (data?.type === 'initialize') initialize().catch(() => self.postMessage({ type: 'error', message: 'The private explorer publication could not be initialized.' }));
  else if (data?.type === 'lookup') lookup(data);
  else if (data?.type === 'prepare' && tx.base && !busy && /^[a-f\d]{64}$/.test(data.txid)) { try { prepare(tx, data.txid, true); } catch { ready = null; } }
  else if (data?.type === 'loadFull') loadFull(data);
  else if (data?.type === 'loadMore') loadMore(data);
});
