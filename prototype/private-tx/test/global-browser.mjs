// Chrome acceptance of an ALREADY RUNNING immutable global publication. This
// driver never starts/stops services, reads remote sources or modifies artifacts.
// Private keys and encrypted bodies remain transient; reports contain only
// counts, hashes, public publication identity and UI screenshots.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUEST_BYTES = 20_992, PUBLIC_BYTES = 360_448, REPLY_BYTES = 81_920;
const HASH = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const compactError = error => String(error?.message ?? error).split('\n')[0].slice(0, 1000);
// assert's default large-object diff would print the multi-megabyte envelopes.
function exact(actual, expected, label) {
  try { assert.deepStrictEqual(actual, expected, label); }
  catch { throw new Error(`${label}; actual SHA-256 ${sha256(Buffer.from(canonical(actual) ?? 'undefined'))}, expected SHA-256 ${sha256(Buffer.from(canonical(expected) ?? 'undefined'))}`); }
}
function sameText(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}; actual length ${actual?.length}, expected length ${expected.length}`);
}
function keyRow(txid) {
  const bytes = createHash('sha256').update(Buffer.from('ZBGL-KEY-v1\0')).update(Buffer.from(txid, 'hex')).digest();
  return Number(bytes.readBigUInt64LE() % 2048n);
}

assert.ok(process.env.PRIVATE_TX_GLOBAL_ORIGIN && process.env.PRIVATE_TX_GLOBAL_SOURCE,
  'Set PRIVATE_TX_GLOBAL_ORIGIN=http://127.0.0.1:<port> and PRIVATE_TX_GLOBAL_SOURCE=/absolute/path/to/frozen/source.json.');
const address = new URL(process.env.PRIVATE_TX_GLOBAL_ORIGIN);
assert.ok(address.protocol === 'http:' && address.hostname === '127.0.0.1' && address.port && address.pathname === '/'
  && !address.search && !address.hash && !address.username && !address.password, 'An explicit loopback HTTP origin without path/query/credentials is required.');
assert.ok(isAbsolute(process.env.PRIVATE_TX_GLOBAL_SOURCE), 'The frozen source path must be absolute.');
const origin = address.origin, sourcePath = resolve(process.env.PRIVATE_TX_GLOBAL_SOURCE);
const mode = process.env.PRIVATE_TX_GLOBAL_MODE ?? 'clean';
assert.ok(['clean', 'poison-selection', 'poison-unused'].includes(mode), 'Unsupported PRIVATE_TX_GLOBAL_MODE.');
const quietMs = Number(process.env.PRIVATE_TX_GLOBAL_QUIET_MS ?? 35_000);
assert.ok(Number.isSafeInteger(quietMs) && quietMs >= 35_000 && quietMs <= 60_000, 'The post-failure quiet window must be 35–60 seconds.');
const output = resolve(process.env.PRIVATE_TX_GLOBAL_OUTPUT ?? resolve(ROOT, 'test-results', `global-${mode}-${new Date().toISOString().replaceAll(':', '-')}`));
await mkdir(output, { recursive: true });
const trace = [], cdpTrace = [], gaps = [], blocked = [], external = [], consoleErrors = [], pageErrors = [], websockets = [], cases = [], quietWindows = [], assets = [];
const pendingResponses = new Set(), pwRequests = new Map(), cdpRequests = new Map(), pendingCdp = new Map();
let phase = 'operator-preflight', browser, context, page, pageCdp, manifest, source, sourceBytes, initializationMs;
let cdpSequence = 0, cdpCommand = 0, workerSessions = 0, initializationFinishedAt;
const startedAt = new Date().toISOString();
let deadlineExceeded = false;
const deadlineAbort = new AbortController();
const deadlineTimer = setTimeout(() => {
  deadlineExceeded = true; deadlineAbort.abort(); void browser?.close().catch(() => {});
}, 45 * 60_000);
deadlineTimer.unref();
const phaseItems = name => trace.filter(item => item.phase === name);
function gap(value) { if (!gaps.some(item => canonical(item) === canonical(value))) gaps.push(value); }

function checkRequest({ url, method, headers, body }, { allowMissingBody = false } = {}) {
  const target = new URL(url);
  assert.equal(target.origin, origin, 'Browser request must remain on the explicit origin.');
  assert.equal(target.search, '', 'Query strings are forbidden.'); assert.equal(target.hash, '', 'Fragments must never enter HTTP requests.');
  const setup = /^\/publication\/layers\/(0|[1-9]\d*)\/public\.bin$/.exec(target.pathname);
  const staticPaths = ['/', '/app.js', '/worker.js', '/style.css', '/fonts/geist-sans.woff2', '/fonts/geist-mono.woff2',
    '/wasm/zecblock_pir_browser.js', '/wasm/zecblock_pir_browser_bg.wasm', '/publication/manifest.json', '/pir/query'];
  assert.ok(staticPaths.includes(target.pathname) || setup && Number(setup[1]) < manifest.layerCount, `Unallowlisted browser path ${target.pathname}`);
  assert.equal(method, target.pathname === '/pir/query' ? 'POST' : 'GET');
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ['cookie', 'authorization', 'referer', 'forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) assert.equal(normalized[key], undefined, `Forbidden ${key} header`);
  for (const txid of selectionIds) {
    assert.ok(!url.toLowerCase().includes(txid) && !JSON.stringify(normalized).toLowerCase().includes(txid), 'Selection escaped in browser URL/headers.');
    if (body) for (const bytes of [Buffer.from(txid), Buffer.from(txid.toUpperCase()), Buffer.from(txid, 'hex'), Buffer.from(txid, 'hex').reverse()]) {
      assert.equal(body.indexOf(bytes), -1, 'Selection escaped in encrypted upload.');
    }
  }
  if (target.pathname === '/pir/query') {
    assert.equal(normalized['content-type'], 'application/octet-stream');
    assert.equal(normalized['x-pir-publication'], manifest.publicationId);
    exact(Object.keys(normalized).filter(key => key.startsWith('x-')).sort(), ['x-pir-publication'], 'Only the public publication may be sent in a custom header');
    if (body) assert.equal(body.length, REQUEST_BYTES, 'Encrypted query must have fixed length.');
    else assert.ok(allowMissingBody, 'Encrypted upload bytes were unavailable.');
    if (normalized['content-length'] !== undefined) assert.equal(Number(normalized['content-length']), REQUEST_BYTES);
  } else assert.ok(!body?.length, 'Public assets must have no upload.');
}
let selectionIds = [];

async function operatorGet(path) {
  const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30_000), deadlineAbort.signal]) });
  assert.equal(response.status, 200, `Operator preflight ${path}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), headers: Object.fromEntries(response.headers) };
}
async function boundedObservation(promise, milliseconds = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DevTools observation unavailable')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function task(promise) {
  const guarded = promise.catch(error => gap({ phase, kind: 'observer', reason: compactError(error) }));
  pendingResponses.add(guarded); guarded.finally(() => pendingResponses.delete(guarded));
}
async function settle() { while (pendingResponses.size) await Promise.all([...pendingResponses]); }
function headersSummary(headers) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { headerNames: Object.keys(lower).sort(), publicationHeader: lower['x-pir-publication'] ?? null,
    contentType: lower['content-type'] ?? null, contentLength: lower['content-length'] ?? null };
}
function inspectBody(item, bytes, provenance) {
  checkRequest({ url: item.url, method: item.method, headers: item.headers, body: bytes });
  item.bodyBytes = bytes.length; item.bodySha256 = sha256(bytes); item.bodyObservation = provenance;
}
function cdpSend(sessionId, method, params = {}) {
  const id = ++cdpCommand;
  return boundedObservation(new Promise((resolveCommand, reject) => {
    pendingCdp.set(id, { resolve: resolveCommand, reject });
    pageCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
      .catch(error => { pendingCdp.delete(id); reject(error); });
  })).finally(() => pendingCdp.delete(id));
}
async function attachWorkerObservation() {
  pageCdp = await context.newCDPSession(page);
  pageCdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    task((async () => {
      try {
        if (targetInfo.type === 'worker') {
          workerSessions++;
          await cdpSend(sessionId, 'Network.enable', { maxPostDataSize: 1024 * 1024, maxResourceBufferSize: 32 * 1024 * 1024, maxTotalBufferSize: 128 * 1024 * 1024 });
        }
      } finally { await cdpSend(sessionId, 'Runtime.runIfWaitingForDebugger'); }
    })());
  });
  pageCdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    let value; try { value = JSON.parse(message); } catch { return; }
    if (value.id) {
      const pending = pendingCdp.get(value.id);
      if (pending) {
        pendingCdp.delete(value.id);
        if (value.error) pending.reject(new Error(value.error.message));
        else pending.resolve(value.result);
      }
      return;
    }
    const data = value.params ?? {}, key = `${sessionId}:${data.requestId}`;
    if (value.method === 'Network.requestWillBeSent') {
      const request = data.request, item = { phase, sequence: ++cdpSequence, url: request.url, method: request.method, headers: request.headers, atEpochMs: Date.now(), source: 'dedicated-worker-CDP' };
      cdpTrace.push(item); cdpRequests.set(key, item);
      try {
        checkRequest(item, { allowMissingBody: true });
        // postData is UTF-8 text and cannot faithfully represent arbitrary PIR
        // ciphertext. Only CDP's base64 postDataEntries are accepted as bytes.
        if (request.postDataEntries?.length && request.postDataEntries.every(entry => typeof entry.bytes === 'string')) {
          inspectBody(item, Buffer.concat(request.postDataEntries.map(entry => Buffer.from(entry.bytes, 'base64'))), 'CDP postDataEntries');
        }
      } catch (error) { blocked.push({ phase: item.phase, path: new URL(item.url).pathname, reason: compactError(error) }); }
    } else if (value.method === 'Network.responseReceived') {
      const item = cdpRequests.get(key); if (item) {
        item.status = data.response.status; item.responseType = data.response.mimeType;
        item.declaredResponseBytes = Number(data.response.headers?.['Content-Length'] ?? data.response.headers?.['content-length']) || undefined;
      }
    } else if (value.method === 'Network.loadingFinished') {
      const item = cdpRequests.get(key); if (!item) return;
      item.finishedAtEpochMs = Date.now(); item.encodedDataLength = data.encodedDataLength;
      task((async () => {
        try {
          const response = await cdpSend(sessionId, 'Network.getResponseBody', { requestId: data.requestId });
          const bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
          item.responseBytes = bytes.length; item.responseSha256 = sha256(bytes); item.responseObservation = 'worker CDP response body';
        } catch { item.responseObservation = 'unavailable'; }
      })());
    } else if (value.method === 'Network.loadingFailed') {
      const item = cdpRequests.get(key); if (item) item.transportError = data.errorText;
    } else if (value.method === 'Network.webSocketCreated') {
      websockets.push(data.url);
    }
  });
  // Pause new dedicated workers just long enough to enable Network observation;
  // this neither changes their code nor intercepts/replaces their responses.
  await pageCdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
}

async function quiet(name) {
  phase = `quiet-after-${name}`;
  const before = trace.length, beforeCdp = cdpTrace.length;
  await page.waitForTimeout(quietMs);
  assert.equal(trace.length, before, 'No automatic request may follow absence or verification failure.');
  assert.equal(cdpTrace.length, beforeCdp, 'No dedicated-worker request may follow absence or verification failure.');
  quietWindows.push({ after: name, milliseconds: quietMs, browserRequests: 0, workerCdpRequests: 0 });
}
async function checkBatch(name, expectedQueries = 1, { initial = false } = {}) {
  await settle();
  const batch = phaseItems(name), queries = batch.filter(item => item.path === '/pir/query');
  assert.equal(queries.length, expectedQueries, `${name}: one complete fixed query, including absence/failure`);
  if (!initial) assert.equal(batch.length, expectedQueries, `${name}: no selection-dependent asset, metadata, fallback or retry request`);
  const workerQueries = cdpTrace.filter(item => item.phase === name && new URL(item.url).pathname === '/pir/query');
  if (workerSessions) assert.equal(workerQueries.length, expectedQueries, `${name}: worker-CDP query count`);
  for (let index = 0; index < queries.length; index++) {
    const item = queries[index], cdp = workerQueries[index];
    assert.equal(item.status, 200); assert.match(item.responseType, /^application\/octet-stream/);
    const body = item.bodySha256 ? item : cdp?.bodySha256 ? cdp : null;
    if (body) { assert.equal(body.bodyBytes, REQUEST_BYTES); item.bodyBytes = body.bodyBytes; item.bodySha256 = body.bodySha256; item.bodyObservation = body.bodyObservation; }
    else gap({ phase: name, kind: 'encrypted-upload-body', detail: 'Binary worker upload unavailable to Playwright/CDP; no byte-level leakage or fresh-ciphertext pass is claimed for this query.' });
    const reply = item.responseBytes !== undefined ? item : cdp?.responseBytes !== undefined ? cdp : null;
    if (reply) {
      assert.equal(reply.responseBytes, manifest.layerCount * REPLY_BYTES); item.responseBytes = reply.responseBytes; item.responseSha256 = reply.responseSha256;
    } else gap({ phase: name, kind: 'encrypted-reply-body', detail: 'Worker reply body unavailable to DevTools; successful decode/decode-stage verifies client framing, but this is not an observed response-body length.' });
  }
  assert.equal(page.url(), `${origin}/`, 'The wallet fragment must be stripped and never replaced by an identifier URL.');
  return queries;
}
function feeLabel(detail) {
  if (typeof detail.feeZat === 'string' && /^(0|[1-9]\d*)$/.test(detail.feeZat)) {
    const digits = detail.feeZat.padStart(9, '0'); return `${digits.slice(0, -8)}.${digits.slice(-8)} ZEC`;
  }
  return detail.isCoinbase === true ? 'Not applicable (coinbase)' : 'Unavailable';
}
async function noOverflow(label) {
  const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(widths.document <= widths.viewport && widths.body <= widths.viewport, `${label}: horizontal page overflow ${JSON.stringify(widths)}`);
  return widths;
}
async function successUi(record, name) {
  const expected = { ...record, found: true, publicationId: manifest.publicationId };
  const observed = await page.evaluate(() => window.__globalAudit);
  assert.equal(observed.outcome?.type, 'result', `${name}: expected complete verified result`);
  exact(observed.outcome.result, expected, `${name}: complete source envelope parity`);
  exact(observed.partialResults, [], `${name}: no partial UI result before complete authenticated decoding`);
  const measurements = observed.outcome.measurements;
  assert.equal(measurements.publicationId, manifest.publicationId); assert.equal(measurements.layerCount, manifest.layerCount);
  assert.equal(measurements.queryBytes, REQUEST_BYTES); assert.equal(measurements.responseBytes, manifest.layerCount * REPLY_BYTES);
  assert.equal(measurements.chunkCount, 1);
  await page.locator('#result-section').waitFor({ state: 'visible' });
  sameText(await page.locator('#result-txid').textContent(), record.txid, `${name}: complete visible identifier`);
  exact(await page.locator('[role="alert"]').allTextContents(), [], `${name}: no rendering error`);
  await page.locator('#tx-tabs').getByText('Overview', { exact: true }).click();
  sameText(await page.locator('#private-fee').textContent(), feeLabel(record.detail), `${name}: exact/null fee display`);
  assert.ok((await page.locator('.private-snapshot-notice').innerText()).includes(`Block ${record.snapshot.height.toLocaleString('en-US')}`), `${name}: record's original snapshot is visible`);
  await noOverflow(`${name} desktop Overview`);
  await page.locator('#tx-tabs').getByText('Inputs / Outputs', { exact: true }).click();
  await page.locator('#result-facts[aria-label="Inputs / Outputs"]').waitFor({ state: 'visible' });
  await noOverflow(`${name} desktop Inputs/Outputs`);
  await page.locator('#tx-tabs').getByText('Raw', { exact: true }).click();
  sameText(await page.locator('#raw-decoded').textContent(), JSON.stringify(record.raw.decoded, null, 2), `${name}: exact formatted raw decoded JSON`);
  await noOverflow(`${name} desktop Raw JSON`);
  await page.getByRole('tab', { name: 'Hex', exact: true }).click();
  sameText(await page.locator('#raw-hex').textContent(), record.raw.hex, `${name}: exact raw transaction hex`);
  await noOverflow(`${name} desktop Raw hex`);
  assert.equal(await page.locator('a[href]').count(), 0, 'Public transaction/address references must remain inert.');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTitle('Export as JSON', { exact: true }).click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const exportedBytes = await readFile(await download.path());
  exact(JSON.parse(exportedBytes.toString('utf8')), expected, `${name}: full-envelope local JSON export parity`);
  await page.locator('#tx-tabs').getByText('Overview', { exact: true }).click();
  const viewports = [];
  if (['large1', 'large2', 'small', 'unaffected-large1', 'repeat'].includes(name)) {
    await page.screenshot({ path: resolve(output, `${name}-desktop.png`), fullPage: true });
    for (const width of [500, 390]) {
      await page.setViewportSize({ width, height: 900 });
      viewports.push(await noOverflow(`${name} ${width}px Overview`));
      await page.screenshot({ path: resolve(output, `${name}-${width}px.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
  return { measurements, sourceEnvelopeSha256: sha256(Buffer.from(canonical(record))), returnedEnvelopeSha256: sha256(Buffer.from(canonical(expected))),
    exportedJsonSha256: sha256(exportedBytes), sourceEnvelopeBytes: Buffer.byteLength(JSON.stringify(record)), rawBytes: record.raw.hex.length / 2,
    inputCount: record.detail.inputs.length, outputCount: record.detail.outputs.length, originalSnapshot: record.snapshot,
    blockHeight: record.detail.blockHeight, sourcePosition: source.records.indexOf(record), feeZat: record.detail.feeZat ?? null,
    stages: observed.events.filter(event => event.type === 'stage'), viewports };
}
async function lookup({ name, record, txid = record?.txid, expected = 'result', initial = false }) {
  phase = name;
  console.log(`Global Chrome acceptance: ${mode}/${name}`);
  if (!initial) {
    await page.evaluate(() => { window.__globalAudit.outcome = null; window.__globalAudit.events = []; window.__globalAudit.partialResults = []; window.__globalAudit.pending = false; });
    const before = trace.length;
    await page.locator('#txid').fill(txid); await page.waitForTimeout(250);
    assert.equal(trace.length, before, `${name}: typing must be entirely local`);
    await page.locator('#lookup-button').click();
  }
  await page.waitForFunction(() => window.__globalAudit.outcome !== null, null, { timeout: 900_000 });
  const outcome = await page.evaluate(() => ({ type: window.__globalAudit.outcome.type, message: window.__globalAudit.outcome.message,
    events: window.__globalAudit.events, partialResults: window.__globalAudit.partialResults }));
  assert.equal(outcome.type, expected, `${name}: ${outcome.message ?? 'unexpected outcome'}`);
  assert.ok(outcome.events.some(event => event.type === 'stage' && event.stage === 'decode'), `${name}: full HTTP bundle must reach content decoding`);
  exact(outcome.partialResults, [], `${name}: no partial result`);
  const queries = await checkBatch(name, 1, { initial });
  const result = { name, expected, queryShape: { requests: 1, uploadBytes: REQUEST_BYTES, replyBytes: manifest.layerCount * REPLY_BYTES } };
  if (expected === 'result') {
    Object.assign(result, await successUi(record, name));
    await checkBatch(name, 1, { initial });
  }
  else {
    await page.locator('#lookup-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#result-section').count(), 0, `${name}: rejected data must not be rendered`);
    assert.equal(await page.locator('#metrics').count(), 0, `${name}: rejected data must not leave stale measurements`);
    if (name.startsWith('poisoned')) assert.match(outcome.message, /could not be verified/);
    else assert.match(outcome.message, /absent from the pinned global publication/);
    result.error = outcome.message;
    await quiet(name);
  }
  cases.push(result); return queries;
}

try {
  sourceBytes = await readFile(sourcePath); source = JSON.parse(sourceBytes.toString('utf8'));
  assert.equal(source.schema, 'zecblock-private-global-source-v1'); assert.equal(source.network, 'mainnet');
  assert.ok(Array.isArray(source.records) && source.records.length >= 3);
  for (const record of source.records) assert.ok(record.schema === 'zecblock-private-tx-record-v1' && HASH.test(record.txid) && record.raw?.hex && record.raw?.decoded && record.source && record.snapshot);
  const large = [...source.records].sort((a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)));
  const small = source.records.find(record => Number(record.detail.blockHeight) === 0) ?? large.at(-1);
  assert.ok(large[0] !== small && large[1] !== small);
  const ids = new Set(source.records.map(record => record.txid)), occupiedRows = new Set(source.records.map(record => keyRow(record.txid)));
  let absent, occupiedAbsent;
  for (let index = 0; !absent || !occupiedAbsent; index++) {
    assert.ok(index < 1_000_000, 'Could not generate deterministic absence probes.');
    const candidate = sha256(Buffer.from(`ZecBlock global Chrome acceptance absence ${index}`));
    if (ids.has(candidate)) continue;
    if (occupiedRows.has(keyRow(candidate))) occupiedAbsent ??= candidate; else absent ??= candidate;
  }
  selectionIds = [...ids, absent, occupiedAbsent];
  const remote = await operatorGet('/publication/manifest.json'); manifest = JSON.parse(remote.bytes.toString('utf8'));
  assert.equal(manifest.schema, 'zecblock-private-global-v1'); assert.equal(manifest.geometry, 'global-2k-64k');
  assert.equal(manifest.network, 'mainnet'); assert.equal(manifest.hashAlgorithm, 'sha256-display-v1'); assert.equal(manifest.recordCodec, 'full-envelope-zlib-v1');
  assert.equal(manifest.rows, 2048); assert.equal(manifest.rowBytes, 65536); assert.equal(manifest.payloadBytes, 65024);
  assert.ok(Number.isSafeInteger(manifest.layerCount) && manifest.layerCount > 0 && manifest.layerCount <= 128);
  assert.equal(manifest.layers.length, manifest.layerCount);
  assert.equal(manifest.scheme.request_bytes, REQUEST_BYTES); assert.equal(manifest.scheme.response_bytes, REPLY_BYTES); assert.equal(manifest.scheme.public_bytes, PUBLIC_BYTES);
  const { publicationId, ...identity } = manifest;
  assert.equal(sha256(Buffer.from(canonical(identity))), publicationId, 'Publication identity must bind the complete manifest.');
  assert.equal(sha256(Buffer.from(canonical(Object.fromEntries(Object.entries(identity).filter(([key]) => !['contextId', 'layers', 'noiseCertificate'].includes(key)))))), manifest.contextId);
  if (process.env.PRIVATE_TX_GLOBAL_PUBLICATION) assert.equal(publicationId, process.env.PRIVATE_TX_GLOBAL_PUBLICATION, 'Explicit pinned publication differs.');
  assert.equal(manifest.sourceSummary.recordCount, source.records.length);
  for (const id of ids) assert.ok(!remote.bytes.toString('utf8').includes(id), 'Public manifest must contain no transaction catalogue.');
  assert.ok(!/("catalogue"|"samples"|"txid")/.test(remote.bytes.toString('utf8')), 'Public manifest exposes selector metadata.');
  assets.push({ path: '/publication/manifest.json', sha256: sha256(remote.bytes), bytes: remote.bytes.length, operatorPreflight: true });
  for (let index = 0; index < manifest.layerCount; index++) {
    const layer = manifest.layers[index]; assert.equal(layer.index, index); assert.ok(HASH.test(layer.publicSha256));
    const path = `/publication/layers/${index}/public.bin`, result = await operatorGet(path);
    assert.equal(result.bytes.length, PUBLIC_BYTES); assert.equal(sha256(result.bytes), layer.publicSha256);
    assets.push({ path, sha256: layer.publicSha256, bytes: PUBLIC_BYTES, operatorPreflight: true });
  }
  for (const [path, file] of [['/', 'web/global-index.html'], ['/app.js', 'web/app.js'], ['/worker.js', 'web/global-worker.js'], ['/style.css', 'web/style.css'],
    ['/fonts/geist-sans.woff2', 'web/fonts/geist-sans.woff2'], ['/fonts/geist-mono.woff2', 'web/fonts/geist-mono.woff2'],
    ['/wasm/zecblock_pir_browser.js', '../pir-browser/pkg/zecblock_pir_browser.js'], ['/wasm/zecblock_pir_browser_bg.wasm', '../pir-browser/pkg/zecblock_pir_browser_bg.wasm']]) {
    const result = await operatorGet(path), localHash = sha256(await readFile(resolve(ROOT, file)));
    assert.equal(sha256(result.bytes), localHash, `Serving asset differs from the reviewed worktree: ${path}`);
    assets.push({ path, sha256: localHash, bytes: result.bytes.length, operatorPreflight: true });
  }
  const plans = mode === 'clean' ? {
    large1: { record: large[0] }, large2: { record: large[1] }, small: { record: small }, repeat: { record: large[0] },
    absent: { txid: absent, expected: 'error' }, 'occupied-absent': { txid: occupiedAbsent, expected: 'error' }, invalid: { txid: 'invalid' },
  } : { 'poisoned-small': { record: small, expected: 'error' }, 'unaffected-large1': { record: large[0] } };
  const selectedCases = (process.env.PRIVATE_TX_GLOBAL_CASES ?? Object.keys(plans).join(',')).split(',').filter(Boolean);
  assert.ok(selectedCases.length && new Set(selectedCases).size === selectedCases.length);
  for (const name of selectedCases) assert.ok(plans[name], `Unsupported case ${name} for mode ${mode}`);
  const firstName = selectedCases.find(name => name !== 'invalid'); assert.ok(firstName, 'Include at least one fixed-query case.');

  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 30_000 });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', acceptDownloads: true });
  await context.addInitScript(() => {
    window.__globalAudit = { outcome: null, manifest: null, events: [], partialResults: [], pending: false, awaitingBundle: false, readyAt: null };
    const audit = window.__globalAudit, OriginalWorker = window.Worker;
    const partial = where => { if (audit.pending && audit.awaitingBundle && document.querySelector('#result-section')) audit.partialResults.push(where); };
    new MutationObserver(() => partial('DOM during pending bundle')).observe(document, { childList: true, subtree: true });
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args); this.addEventListener('message', ({ data }) => {
          const event = { type: data.type, stage: data.stage, atEpochMs: performance.timeOrigin + performance.now() };
          audit.events.push(event);
          if (data.type === 'ready') { audit.manifest = data.manifest; audit.readyAt = event.atEpochMs; }
          if (data.type === 'stage' && data.stage === 'server') { audit.awaitingBundle = true; partial('server stage'); }
          if (data.type === 'stage' && data.stage === 'decode') { partial('decode stage'); audit.awaitingBundle = false; }
          if (data.type === 'result' || data.type === 'error') { audit.pending = false; audit.awaitingBundle = false; audit.outcome = data; }
        });
      }
      postMessage(data, ...rest) {
        if (data?.type === 'lookup') { audit.pending = true; audit.awaitingBundle = false; audit.outcome = null; }
        return super.postMessage(data, ...rest);
      }
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(), target = new URL(request.url());
    if (target.protocol === 'data:' || target.protocol === 'blob:') return route.continue();
    if (target.origin !== origin) { external.push({ phase, origin: target.origin }); return route.abort('blockedbyclient'); }
    try { checkRequest({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() }, { allowMissingBody: true }); }
    catch (error) { blocked.push({ phase, path: target.pathname, reason: compactError(error) }); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  context.on('request', request => {
    const target = new URL(request.url()); if (['data:', 'blob:'].includes(target.protocol)) return;
    const item = { phase, url: request.url(), path: target.pathname, method: request.method(), headers: request.headers(), atEpochMs: Date.now() };
    trace.push(item); pwRequests.set(request, item);
    try { const body = request.postDataBuffer(); checkRequest({ ...item, body }, { allowMissingBody: true }); if (body) inspectBody(item, body, 'Playwright postDataBuffer'); }
    catch (error) { blocked.push({ phase, path: target.pathname, reason: compactError(error) }); }
  });
  context.on('response', response => {
    const item = pwRequests.get(response.request()); if (!item) return;
    const headers = response.headers(); item.status = response.status(); item.responseType = headers['content-type'] ?? '';
    item.declaredResponseBytes = headers['content-length'] === undefined ? undefined : Number(headers['content-length']);
    item.securityHeaders = { csp: headers['content-security-policy'], cacheControl: headers['cache-control'], referrerPolicy: headers['referrer-policy'], robots: headers['x-robots-tag'] };
    task((async () => {
      try { const bytes = await boundedObservation(response.body()); item.responseBytes = bytes.length; item.responseSha256 = sha256(bytes); item.responseObservation = 'Playwright response body'; }
      catch { item.responseObservation = 'unavailable'; }
    })());
  });
  context.on('requestfinished', request => {
    const item = pwRequests.get(request); if (item) item.finishedAtEpochMs = Date.now();
  });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => pageErrors.push(compactError(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 1000)); });
  page.on('websocket', socket => websockets.push(socket.url()));
  await attachWorkerObservation();
  phase = firstName;
  const fragmentTxid = plans[firstName].txid ?? plans[firstName].record.txid, started = performance.now();
  const response = await page.goto(`${origin}/#tx=${fragmentTxid}`, { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200); assert.equal(response.headers()['cache-control'], 'no-store');
  assert.match(response.headers()['x-robots-tag'], /noindex/); assert.equal(response.headers()['referrer-policy'], 'no-referrer');
  const csp = response.headers()['content-security-policy'];
  for (const directive of ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", "connect-src 'self'", "font-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive), `CSP missing ${directive}`);
  const html = await response.text(); for (const txid of ids) assert.ok(!html.includes(txid), 'Initial server HTML contains a transaction identifier.');
  await page.waitForFunction(() => window.__globalAudit.readyAt !== null || window.__globalAudit.outcome?.type === 'error', null, { timeout: 180_000 });
  const initialized = await page.evaluate(() => ({ manifest: window.__globalAudit.manifest, readyAt: window.__globalAudit.readyAt }));
  assert.ok(initialized.readyAt, 'Browser/WASM initialization did not reach ready.');
  exact(initialized.manifest, manifest, 'Browser must pin the exact immutable operator-preflight manifest');
  initializationMs = performance.now() - started; initializationFinishedAt = initialized.readyAt;
  assert.equal(await page.locator('h1').count(), 1); assert.equal(await page.locator('#sample-area').count(), 0);
  await lookup({ name: firstName, ...plans[firstName], initial: true });
  for (const name of selectedCases) {
    if (name === firstName) continue;
    if (name === 'invalid') {
      phase = name; const before = trace.length;
      await page.locator('#txid').fill(plans[name].txid); await page.locator('#lookup-button').click();
      await page.locator('#lookup-error').waitFor({ state: 'visible' });
      assert.match(await page.locator('#lookup-error').innerText(), /64 hexadecimal/);
      assert.equal(await page.locator('#result-section').count(), 0); assert.equal(trace.length, before);
      await checkBatch(name, 0); cases.push({ name, expected: 'local-validation', browserRequests: 0 });
    } else await lookup({ name, ...plans[name] });
  }
  await settle();
  const publicGets = trace.filter(item => /^\/publication\/layers\//.test(item.path));
  exact(publicGets.map(item => item.path), manifest.layers.map((_, index) => `/publication/layers/${index}/public.bin`), 'All setup layers must be fetched exactly once in public order');
  const firstQuery = trace.findIndex(item => item.path === '/pir/query');
  assert.ok(publicGets.every(item => trace.indexOf(item) < firstQuery), 'All public setup must finish before the first private query.');
  for (const item of publicGets) {
    const observed = item.finishedAtEpochMs !== undefined ? item : cdpTrace.find(entry => new URL(entry.url).pathname === item.path && entry.finishedAtEpochMs !== undefined);
    if (observed) assert.ok(observed.finishedAtEpochMs <= trace[firstQuery].atEpochMs, 'Every public setup response must finish before query creation.');
    else gap({ kind: 'setup-completion', path: item.path, detail: 'Setup GET order observed; completion time unavailable. Worker ready plus successful decoding requires complete setup consumption.' });
  }
  assert.equal(trace.filter(item => item.path === '/publication/manifest.json').length, 1, 'No automatic manifest refresh.');
  for (const asset of assets) {
    const item = trace.find(entry => entry.path === asset.path), cdp = cdpTrace.find(entry => new URL(entry.url).pathname === asset.path);
    if (!item) { gap({ kind: 'optional-asset', path: asset.path, detail: 'Not requested by this browser render; only the operator-preflight hash was checked.' }); continue; }
    assert.equal(item.status, 200);
    const observed = item.responseSha256 ? item : cdp?.responseSha256 ? cdp : null;
    if (observed) { assert.equal(observed.responseSha256, asset.sha256, `Observed browser asset differs: ${asset.path}`); asset.browserObservation = observed.responseObservation; }
    else { asset.browserObservation = 'unavailable'; gap({ kind: 'public-asset-body', path: asset.path, detail: 'Browser GET observed; bytes/hash verified separately by Node operator preflight, not the browser trace.' }); }
  }
  const repeated = cases.find(item => item.name === 'repeat'), original = cases.find(item => item.name === 'large1');
  let freshness = 'not-requested';
  if (repeated && original) {
    const a = phaseItems('large1').find(item => item.path === '/pir/query'), b = phaseItems('repeat').find(item => item.path === '/pir/query');
    if (a.bodySha256 && b.bodySha256) { assert.notEqual(a.bodySha256, b.bodySha256, 'A repeated lookup must use fresh encrypted query bytes.'); freshness = 'observed-distinct-ciphertexts'; }
    else { freshness = 'unobserved'; gap({ kind: 'fresh-ciphertext', detail: 'Repeated lookup completed, but binary upload visibility was insufficient to claim observed freshness.' }); }
  }
  const observedHashes = trace.filter(item => item.path === '/pir/query' && item.bodySha256).map(item => item.bodySha256);
  assert.equal(new Set(observedHashes).size, observedHashes.length, 'Observed encrypted queries must all be fresh.');
  const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie,
    indexedDb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : null, caches: (await caches.keys()).length }));
  exact(storage, { local: 0, session: 0, cookies: '', indexedDb: 0, caches: 0 }, 'No browser storage');
  exact(await context.cookies(), [], 'No browser-context cookies');
  exact(external, [], 'No external origins'); exact(blocked, [], 'No attempted prohibited requests'); exact(websockets, [], 'No websockets');
  exact(pageErrors, [], 'No browser page errors'); exact(consoleErrors, [], 'No browser console errors');
  // Strip full headers and URLs (including hypothetical selectors) from disk.
  const summarize = item => { const { headers, url, ...rest } = item; return { ...rest, path: new URL(url).pathname, ...headersSummary(headers) }; };
  const report = { status: 'passed', observationStatus: gaps.length ? 'completed-with-explicit-observation-gaps' : 'all-requested-observations-available',
    startedAt, completedAt: new Date().toISOString(), mode, origin, publicationId: manifest.publicationId, browserVersion: browser.version(),
    scope: 'Read-only actual Chrome/native/WASM acceptance of a bounded immutable local global publication. Frozen source-envelope parity does not establish independent source/chain correctness, full-history capacity, production release or cryptographic review.',
    oracle: { sourcePath, sourceFileBytes: sourceBytes.length, sourceFileSha256: sha256(sourceBytes), sourceSchema: source.schema, recordCount: source.records.length },
    manifest: { schema: manifest.schema, geometry: manifest.geometry, contextId: manifest.contextId, layerCount: manifest.layerCount, sourceSummary: manifest.sourceSummary },
    wire: { queriesPerLookup: 1, uploadBytes: REQUEST_BYTES, replyBytes: manifest.layerCount * REPLY_BYTES, setupBytes: manifest.layerCount * PUBLIC_BYTES },
    initializationMs, initializationFinishedAt, workerCdpSessions: workerSessions, cases, quietWindows, freshness, storage, assets, observationGaps: gaps,
    browserRequestTrace: trace.map(summarize), workerCdpRequestTrace: cdpTrace.map(summarize),
    checks: ['fragment auto-selection after all public setup; fragment stripped', 'manual entry produces no typing traffic', 'full-envelope deepStrictEqual including original snapshot/source/raw/price/null fees',
      'exact Raw JSON.stringify and hex display; exact local JSON export', 'single fixed POST and complete all-layer reply on success/absence/content failure',
      'no partial result, automatic retry, fallback, metadata refresh or background traffic after failure', 'occupied and empty hash-row absence when requested',
      'allowlisted same-origin traffic and strict CSP', 'empty cookies/storage; no analytics/websockets/external origins', 'desktop, 500px and 390px Overview screenshots and overflow checks'],
    limits: 'Node operator-preflight reads are deliberately distinct from actual browser traces. Missing DevTools bodies are explicit gaps, never an observed-byte/freshness pass. No server log retention, constant-time execution, independent chain truth, delivered-client trust, public/full-history readiness or remote poisoning is proved. No encrypted request/reply bodies, keys or full decrypted envelopes are saved by this driver.' };
  await writeFile(resolve(output, 'global-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, observationStatus: report.observationStatus, mode, publicationId: manifest.publicationId,
    cases: cases.map(item => item.name), observationGaps: gaps.length, output }, null, 2));
} catch (error) {
  const failure = { status: 'failed', startedAt, completedAt: new Date().toISOString(), phase, mode, origin, publicationId: manifest?.publicationId ?? null,
    error: deadlineExceeded ? 'The whole-run 45-minute deadline expired.' : compactError(error), casesCompleted: cases.map(item => item.name), blocked, external, consoleErrors, pageErrors, observationGaps: gaps,
    requestCountsByPhase: Object.fromEntries([...new Set(trace.map(item => item.phase))].map(name => [name, phaseItems(name).map(item => ({ path: item.path, method: item.method, status: item.status, bodyBytes: item.bodyBytes, responseBytes: item.responseBytes }))])) };
  await writeFile(resolve(output, 'global-browser-failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
  console.error(JSON.stringify({ status: 'failed', phase, error: failure.error, output }, null, 2)); process.exitCode = 1;
} finally { clearTimeout(deadlineTimer); await browser?.close(); }
