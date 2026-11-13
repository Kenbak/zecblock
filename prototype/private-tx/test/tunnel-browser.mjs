// Audit an already running isolated pilot through an explicit SSH loopback
// tunnel. This script never opens SSH or calls a production explorer API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originInput = process.env.PRIVATE_TX_TEST_ORIGIN;
const sourceInput = process.env.PRIVATE_TX_TEST_SOURCE;
assert.ok(originInput && sourceInput, 'Set PRIVATE_TX_TEST_ORIGIN=http://127.0.0.1:<tunnel-port> and PRIVATE_TX_TEST_SOURCE=/absolute/path/to/copied-source.json.');
const parsedOrigin = new URL(originInput);
assert.ok(parsedOrigin.protocol === 'http:' && parsedOrigin.hostname === '127.0.0.1' && parsedOrigin.port
  && parsedOrigin.pathname === '/' && !parsedOrigin.search && !parsedOrigin.hash && !parsedOrigin.username && !parsedOrigin.password,
'Only an explicit HTTP 127.0.0.1 port with no path, credentials or query is accepted.');
const origin = parsedOrigin.origin;
const sourcePath = resolve(sourceInput);
const sourceBytes = await readFile(sourcePath);
const source = JSON.parse(sourceBytes.toString('utf8'));
assert.equal(source.network, 'mainnet');
assert.ok(Array.isArray(source.records) && source.records.length >= 2, 'At least two published records are needed to test distinct selections.');
const selectedLimit = Number(process.env.PRIVATE_TX_TEST_RECORD_LIMIT ?? '4');
assert.ok(Number.isInteger(selectedLimit) && selectedLimit >= 2 && selectedLimit <= 16, 'Record limit must be 2–16.');
const output = resolve(process.env.PRIVATE_TX_TEST_OUTPUT ?? resolve(ROOT, 'test-results', `tunnel-${new Date().toISOString().replaceAll(':', '-')}`));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const directProbes = [];
const trace = [], responseTasks = [], consoleErrors = [], browserErrors = [], blockedExternal = [], blockedRequests = [], websockets = [];
const requestMap = new Map();
const lookups = [], labFaults = [];
const observationGaps = [];
let phase = 'initialization', fault = null, browser, context, page;
let activeManifest;
let report;

function observe(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DevTools observation unavailable.')), 2000); })])
    .finally(() => clearTimeout(timer));
}

async function probe(path, options = {}) {
  const response = await fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(20_000), ...options });
  const body = Buffer.from(await response.arrayBuffer());
  directProbes.push({ path, method: options.method ?? 'GET', status: response.status, responseBytes: body.length });
  return { response, body };
}

function queryRequests(name) { return trace.filter(request => request.phase === name && new URL(request.url).pathname === '/pir/query'); }

function checkRequestPrivacy(request, manifest) {
  const url = new URL(request.url);
  assert.equal(url.origin, origin, 'Browser HTTP traffic must remain within the explicit tunnel origin.');
  assert.equal(url.search, '', 'Query strings are excluded.');
  assert.equal(url.hash, '');
  const allowed = new Set(['/', '/app.js', '/worker.js', '/style.css', '/fonts/geist-sans.woff2', '/fonts/geist-mono.woff2', '/wasm/zecblock_pir_browser.js', '/wasm/zecblock_pir_browser_bg.wasm', '/publication/manifest.json', '/publication/status.json', '/pir/query']);
  assert.ok(allowed.has(url.pathname) || /^\/publication\/[a-f0-9]{64}\/public.bin$/.test(url.pathname), `Unexpected browser path: ${url.pathname}`);
  assert.equal(request.headers.cookie, undefined, 'Fresh browser context must send no cookies.');
  assert.equal(request.headers.authorization, undefined, 'No account credentials belong in the pilot.');
  for (const header of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) assert.equal(request.headers[header], undefined, 'Browser must not attach client-IP forwarding headers.');
  if (request.method === 'POST') assert.ok(Buffer.isBuffer(request.body) && request.body.length > 0, 'Encrypted upload capture is required for selector inspection.');
  for (const record of source.records) {
    const id = record.txid;
    assert.ok(!request.url.toLowerCase().includes(id), 'A catalogue transaction ID escaped in a request URL.');
    assert.ok(!JSON.stringify(request.headers).toLowerCase().includes(id), 'A catalogue transaction ID escaped in request headers.');
    if (request.body) {
      for (const encoding of [Buffer.from(id), Buffer.from(id.toUpperCase()), Buffer.from(id, 'hex'), Buffer.from(id, 'hex').reverse()]) {
        assert.equal(request.body.indexOf(encoding), -1, 'A catalogue transaction ID escaped in request body bytes.');
      }
    }
  }
  if (request.body) {
    assert.equal(url.pathname, '/pir/query');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    assert.equal(request.headers['x-pir-publication'], manifest.publicationId);
    assert.equal(request.body.length, manifest.scheme.request_bytes);
  }
}

async function auditPhase(name, expectedQueries, { realAnswers = true } = {}) {
  await Promise.all(responseTasks);
  const requests = trace.filter(request => request.phase === name);
  const queries = queryRequests(name);
  assert.equal(queries.length, expectedQueries, `${name}: fixed encrypted query count`);
  for (const request of requests) checkRequestPrivacy(request, activeManifest);
  if (realAnswers) for (const query of queries) {
    assert.equal(query.status, 200, `${name}: real tunnel answer status`);
    if (query.responseBytes !== undefined) assert.equal(query.responseBytes, activeManifest.scheme.response_bytes, `${name}: observed fixed encrypted answer size`);
    else observationGaps.push({ phase: name, path: '/pir/query', detail: 'Dedicated-worker response size unavailable to DevTools. Exact aggregate received bytes and successful decode of every chunk are checked in the reviewed client.' });
    assert.match(query.responseType, /^application\/octet-stream/);
  }
  assert.equal(page.url(), `${origin}/`, 'Entered IDs must not alter the page URL.');
  return queries;
}

async function waitForClient() {
  await page.waitForFunction(() => document.querySelector('[role="alert"]')
    || (document.querySelector('#lookup-button') && !document.querySelector('#lookup-button').disabled), null, { timeout: 120_000 });
  assert.deepEqual(await page.locator('[role="alert"]').allTextContents(), [], 'Browser initialization must not stop at an error boundary.');
}

async function lookup(record, name) {
  phase = name;
  console.log(`Checking tunneled browser lookup: ${name}`);
  await page.evaluate(() => { window.__pirTunnelAudit.result = null; });
  await page.locator('#txid').fill(record.txid);
  await page.locator('#lookup-button').click();
  await page.waitForFunction(() => document.querySelector('#result-section') || document.querySelector('[role="alert"]'), null, { timeout: 180_000 });
  assert.deepEqual(await page.locator('[role="alert"]').allTextContents(), [], 'Full transaction rendering must not stop at an error boundary.');
  const decoded = await page.evaluate(() => window.__pirTunnelAudit.result);
  assert.ok(decoded?.result?.found === true, 'A complete record must be found; an echoed input ID is insufficient.');
  assert.equal(decoded.result.txid, record.txid);
  assert.equal(decoded.result.publicationId, activeManifest.publicationId);
  assert.deepEqual(decoded.result.detail, record.detail, 'All indexed detail facts must match the separately copied source oracle.');
  assert.deepEqual(decoded.result.raw, record.raw, 'All raw bytes and decoded transaction fields must match the source oracle.');
  assert.deepEqual(decoded.result.price, record.price);
  assert.deepEqual(decoded.result.source, record.source);
  assert.deepEqual(decoded.result.snapshot, source.snapshot);
  assert.deepEqual(decoded.result.coverage, source.coverage);
  assert.equal(await page.locator('#result-txid').textContent(), record.txid);
  assert.equal(decoded.measurements.queryBytes, activeManifest.chunkCount * activeManifest.scheme.request_bytes);
  assert.equal(decoded.measurements.responseBytes, activeManifest.chunkCount * activeManifest.scheme.response_bytes);
  console.log(`Verified complete decoded-record parity: ${name}`);
  const queries = await auditPhase(name, activeManifest.chunkCount);
  const result = { name, txid: record.txid, inputCount: record.detail.inputs.length, outputCount: record.detail.outputs.length, rawBytes: record.raw.hex.length / 2, measurements: decoded.measurements };
  lookups.push(result);
  return queries;
}

try {
  const { response: healthResponse, body: healthBytes } = await probe('/health');
  assert.equal(healthResponse.status, 200);
  assert.equal(JSON.parse(healthBytes.toString('utf8')).local, true);
  const { response: manifestResponse, body: manifestBytes } = await probe('/publication/manifest.json');
  assert.equal(manifestResponse.status, 200);
  activeManifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(activeManifest.schema, 'zecblock-private-tx-full-v1');
  assert.equal(activeManifest.network, 'mainnet');
  assert.match(activeManifest.publicationId, /^[a-f0-9]{64}$/);
  if (process.env.PRIVATE_TX_TEST_PUBLICATION) assert.equal(activeManifest.publicationId, process.env.PRIVATE_TX_TEST_PUBLICATION);
  assert.deepEqual(activeManifest.snapshot, source.snapshot, 'Oracle and running publication must refer to the same snapshot.');
  assert.deepEqual(activeManifest.coverage, source.coverage);
  assert.deepEqual(activeManifest.catalogue.map(record => record.txid).sort(), source.records.map(record => record.txid).sort());

  // These hit the actual isolated service, not a local mock. No real txid is
  // placed in a probe URL, header or malformed payload.
  for (const path of ['/source.json', '/database.bin', '/expected.json', `/publication/${activeManifest.publicationId}/source.json`, `/publication/${activeManifest.publicationId}/database.bin`, `/publication/${activeManifest.publicationId}/expected.json`, '/api/transactions/not-a-selector']) {
    assert.equal((await probe(path)).response.status, 404, `Private artifact must be inaccessible: ${path}`);
  }
  const unknown = await probe('/pir/query', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': '0'.repeat(64) }, body: Buffer.from([1, 2, 3]) });
  assert.equal(unknown.response.status, 409, 'Unknown publications must be rejected before evaluation.');
  const malformed = await probe('/pir/query', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': activeManifest.publicationId }, body: Buffer.from([1, 2, 3]) });
  assert.ok([400, 503].includes(malformed.response.status), 'Malformed binary query must be rejected.');
  assert.equal((await probe('/pir/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).response.status, 415);
  assert.equal((await probe('/pir/query', { method: 'POST', headers: { Origin: 'https://audit.invalid', 'Content-Type': 'application/octet-stream' }, body: Buffer.from([1]) })).response.status, 403);

  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 30_000 });
  context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.__pirTunnelAudit = { result: null, manifest: null, stages: [] };
    const OriginalWorker = window.Worker;
    // Test-only result observation. No application debug hook or private
    // cryptographic state is exposed by the shipping browser module.
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'result') window.__pirTunnelAudit.result = data;
          if (data.type === 'ready') window.__pirTunnelAudit.manifest = data.manifest;
          if (data.type === 'stage') window.__pirTunnelAudit.stages.push({ stage: data.stage, chunk: data.chunk, chunks: data.chunks, observedAtMs: performance.now() });
        });
      }
    };
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === 'data:') { await route.continue(); return; }
    if (url.origin !== origin) { blockedExternal.push({ phase, origin: url.origin }); await route.abort('blockedbyclient'); return; }
    try {
      checkRequestPrivacy({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() }, activeManifest);
    } catch (error) {
      blockedRequests.push({ phase, path: url.pathname, reason: error instanceof Error ? error.message : String(error) });
      await route.abort('blockedbyclient'); return;
    }
    if (url.pathname === '/pir/query' && fault) {
      await route.fulfill(fault === '503'
        ? { status: 503, contentType: 'text/plain', body: 'Injected test-only outage.' }
        : { status: 200, contentType: 'application/octet-stream', body: Buffer.from([0, 1, 2]) });
      return;
    }
    await route.continue();
  });
  context.on('request', request => {
    if (new URL(request.url()).protocol === 'data:') return;
    const item = { phase, url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer(), startedAtMs: performance.now() };
    trace.push(item); requestMap.set(request, item);
  });
  context.on('response', response => {
    const item = requestMap.get(response.request());
    if (!item) return;
    item.status = response.status();
    item.responseType = response.headers()['content-type'] ?? '';
    responseTasks.push((async () => {
      try { await observe(response.finished()); } catch { item.finishObservationUnavailable = true; }
      try {
        const body = await observe(response.body());
        item.responseBytes = body.length;
        item.responseSha256 = sha256(body);
        item.responseSizeSource = 'body';
      } catch {
        // Chromium can discard a dedicated worker's response body before
        // DevTools exposes it. Encoded transfer size can include HTTP chunk
        // framing, so retain it separately from decoded payload byte length.
        try {
          const sizes = await observe(response.request().sizes());
          if (sizes.responseBodySize > 0) item.encodedTransferBytes = sizes.responseBodySize;
          item.responseUnavailable = true;
        } catch { item.responseUnavailable = true; }
      }
      item.completedAtMs = performance.now();
    })());
  });
  page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ phase, text: message.text() }); });
  page.on('websocket', socket => websockets.push({ phase, url: socket.url() }));
  const initializedAt = performance.now();
  const initialResponse = await page.goto(`${origin}/`, { timeout: 30_000 });
  assert.equal(initialResponse.status(), 200);
  assert.match(initialResponse.headers()['x-robots-tag'], /noindex/);
  assert.match(initialResponse.headers()['content-security-policy'], /connect-src 'self'/);
  assert.equal(initialResponse.headers()['cache-control'], 'no-store');
  await waitForClient();
  const initializationMs = performance.now() - initializedAt;
  const browserManifest = await page.evaluate(() => window.__pirTunnelAudit.manifest);
  assert.equal(browserManifest.publicationId, activeManifest.publicationId, 'Publication changed during initialization; copy the matching oracle and rerun.');
  assert.equal(await page.locator('h1').count(), 1);
  const staticShell = await initialResponse.text();
  for (const record of source.records) assert.ok(!staticShell.includes(record.txid), 'Initial server HTML must not contain catalogue identifiers.');
  for (const request of trace) checkRequestPrivacy(request, activeManifest);

  const selected = [];
  function select(record) { if (record && !selected.some(item => item.txid === record.txid) && selected.length < selectedLimit) selected.push(record); }
  const requested = (process.env.PRIVATE_TX_TEST_SELECTED_IDS ?? '').split(',').filter(Boolean);
  assert.ok(requested.length <= selectedLimit && new Set(requested).size === requested.length);
  for (const identifier of requested) {
    assert.match(identifier, /^[a-f0-9]{64}$/);
    const record = source.records.find(item => item.txid === identifier);
    assert.ok(record, 'Explicit acceptance selection must belong to the copied source oracle.');
    select(record);
  }
  select(source.records.find(record => record.detail.isCoinbase));
  select(source.records.find(record => (record.detail.ironwoodActions ?? 0) > 0 || (record.detail.orchardActions ?? 0) > 0));
  select([...source.records].sort((a, b) => b.detail.inputs.length - a.detail.inputs.length)[0]);
  select([...source.records].sort((a, b) => b.detail.outputs.length - a.detail.outputs.length)[0]);
  for (const record of source.records) select(record);
  assert.ok(selected.length >= 2);
  phase = 'typing';
  const beforeTyping = queryRequests('typing').length;
  await page.locator('#txid').fill(selected[0].txid);
  await page.waitForTimeout(300);
  assert.equal(queryRequests('typing').length, beforeTyping, 'Typing must not perform a selected query.');
  let first;
  for (const [index, record] of selected.entries()) {
    const queries = await lookup(record, `record-${index + 1}`);
    first ??= queries;
    await page.locator('#tx-tabs').getByText('Inputs / Outputs', { exact: true }).click();
    const io = await page.locator('#result-facts').innerText();
    for (const input of record.detail.inputs) if (input.address) assert.ok(io.includes(input.address), 'Every resolved transparent input must remain in the local view.');
    for (const output of record.detail.outputs) if (output.address) assert.ok(io.includes(output.address), 'Every transparent output must remain in the local view.');
    await page.locator('#tx-tabs').getByText('Raw', { exact: true }).click();
    assert.deepEqual(JSON.parse(await page.locator('#raw-decoded').innerText()), record.raw.decoded);
    await page.getByRole('tab', { name: 'Hex', exact: true }).click();
    assert.equal(await page.locator('#raw-hex').textContent(), record.raw.hex);
    await auditPhase(`record-${index + 1}`, activeManifest.chunkCount);
  }
  const repeated = await lookup(selected[0], 'repeat');
  assert.equal(first.length, repeated.length);
  for (let index = 0; index < first.length; index++) assert.notDeepEqual(first[index].body, repeated[index].body, 'Every corresponding repeat chunk must use fresh ciphertext.');
  assert.equal(new Set([...first, ...repeated].map(query => sha256(query.body))).size, first.length + repeated.length);
  assert.equal(await page.locator('a[href]').count(), 0, 'Selected references must remain inert.');

  for (const [name, value] of [['invalid', 'invalid'], ['outside', 'f'.repeat(64)]]) {
    assert.ok(!source.records.some(record => record.txid === value));
    phase = name;
    await page.locator('#txid').fill(value);
    await page.locator('#lookup-button').click();
    await page.locator('#lookup-error').waitFor({ state: 'visible', timeout: 20_000 });
    await auditPhase(name, 0);
    assert.equal(await page.locator('#result-section').count(), 0);
  }
  for (const failure of ['503', 'malformed']) {
    phase = `lab-${failure}`; fault = failure;
    await page.locator('#txid').fill(selected[0].txid);
    await page.locator('#lookup-button').click();
    await page.locator('#lookup-error').waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await page.locator('#result-section').count(), 0);
    await auditPhase(phase, activeManifest.chunkCount, { realAnswers: false });
    labFaults.push({ name: failure, scope: 'Browser route injection; query was not forwarded to the remote evaluator.', error: await page.locator('#lookup-error').innerText() });
  }
  fault = null;
  await lookup(selected[0], 'recovery');
  const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie, indexedDb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : null, caches: (await caches.keys()).length }));
  assert.deepEqual(storage, { local: 0, session: 0, cookies: '', indexedDb: 0, caches: 0 });
  assert.deepEqual(blockedExternal, [], 'No non-tunnel HTTP requests may be attempted.');
  assert.deepEqual(blockedRequests, [], 'No unallowlisted or selector-bearing request may be attempted.');
  assert.deepEqual(websockets, []);
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(consoleErrors.filter(error => !(error.phase === 'lab-503' && /Failed to load resource.*503/.test(error.text))), []);
  await Promise.all(responseTasks);
  for (const request of trace) checkRequestPrivacy(request, activeManifest);
  const assets = [
    ['/app.js', resolve(ROOT, 'web/app.js')], ['/style.css', resolve(ROOT, 'web/style.css')], ['/worker.js', resolve(ROOT, 'web/worker.js')],
    ['/wasm/zecblock_pir_browser.js', resolve(ROOT, '../pir-browser/pkg/zecblock_pir_browser.js')],
    ['/wasm/zecblock_pir_browser_bg.wasm', resolve(ROOT, '../pir-browser/pkg/zecblock_pir_browser_bg.wasm')],
  ];
  const assetHashes = [];
  for (const [path, file] of assets) {
    const observed = trace.find(request => new URL(request.url).pathname === path);
    assert.ok(observed?.status === 200, `Browser must receive ${path}`);
    const expectedSha256 = sha256(await readFile(file));
    let actualSha256 = observed.responseSha256;
    let bytes = observed.responseBytes;
    let hashSource = 'original-browser-response';
    if (!actualSha256) {
      phase = 'asset-verification';
      const verification = await page.evaluate(async path => {
        const response = await fetch(path, { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('Asset verification fetch failed.');
        const buffer = await response.arrayBuffer();
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
        return { bytes: buffer.byteLength, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
      }, path);
      actualSha256 = verification.sha256; bytes = verification.bytes;
      hashSource = 'separate-same-browser-verification-get';
      observationGaps.push({ path, detail: 'Original dedicated-worker response body unavailable; hash verified through a separate generic same-browser GET. This does not prove identical delivery to every client or request destination.' });
    }
    assert.equal(actualSha256, expectedSha256, `Deployed asset differs from the locally reviewed build: ${path}`);
    assetHashes.push({ path, sha256: expectedSha256, bytes, hashSource });
  }
  await Promise.all(responseTasks);
  for (const request of trace) checkRequestPrivacy(request, activeManifest);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'tunnel-private-transaction-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'tunnel-private-transaction-mobile.png'), fullPage: true });
  report = {
    status: 'passed', scope: 'Browser audit of an explicit loopback pilot endpoint; no direct production explorer requests by this test. SSH forwarding and remote process identity require separate operator evidence.',
    completedAt: new Date().toISOString(), origin, publicationId: activeManifest.publicationId,
    snapshot: source.snapshot, coverage: source.coverage, sourceOracle: { path: sourcePath, sha256: sha256(sourceBytes), authority: 'Copied publication source; exact parity oracle, not independent chain validation.' },
    browserVersion: browser.version(), initializationMs, chunkCount: activeManifest.chunkCount, lookups, endpointProbes: directProbes, browserLabFaults: labFaults, storage, assetHashes, observationGaps,
    requestTrace: trace.map(({ body, headers, ...request }) => ({ ...request, bodyBytes: body?.length ?? 0, bodySha256: body ? sha256(body) : null, headerNames: Object.keys(headers).sort(), publicationHeader: headers['x-pir-publication'] ?? null })),
    leakage: {
      manifest: { catalogueRecords: activeManifest.catalogue.length, fields: Object.keys(activeManifest.catalogue[0] ?? {}).sort(), description: 'All users receive public txids, coverage, record sizes/digests and row placement. Query privacy is conditional on this shared publication domain.' },
      network: 'The service can observe publication ID, request counts/lengths, timing and browser headers. The SSH tunnel changes the HTTP peer to loopback; SSH infrastructure still knows the operator connection. This is not an IP-anonymity test.',
      timing: 'Measured trace is retained for inspection. Uniform counts and lengths do not prove timing or traffic-analysis resistance.',
      logging: 'Code excludes a request logger and payload reflection. This browser audit does not inspect remote journald, SSH logs, process/core dumps, infrastructure capture or retention.',
      trustedClient: 'Reviewed asset hashes match this test. A malicious frontend distributor or compromised browser can still capture selectors or decrypted data; this is not a cryptographic/security audit.',
    },
    checks: ['complete selected-record parity', 'all tabs and full transparent IO/raw parity', 'actual endpoint encrypted replies', 'uniform query count/upload lengths and exact aggregate received reply bytes', 'individual network reply sizes where observable', 'fresh ciphertext for every repeated chunk', 'no txid in URL/header/text/raw/reversed upload bytes', 'allowlisted loopback paths only', 'private artifacts inaccessible', 'unknown publication and malformed binary rejected by endpoint', 'browser-only 503/malformed fault injection without fallback', 'recovery', 'empty storage', 'reviewed asset hashes with capture method recorded', 'desktop/mobile layout'],
  };
  await writeFile(resolve(output, 'tunnel-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, publicationId: report.publicationId, testedRecords: selected.length, lookups: lookups.length, chunkCount: report.chunkCount, initializationMs, output }, null, 2));
} catch (error) {
  await mkdir(output, { recursive: true });
  const failure = { status: 'failed', phase, error: error instanceof Error ? error.message : String(error), origin, publicationId: activeManifest?.publicationId ?? null, endpointProbes: directProbes, browserErrors, consoleErrors, blockedExternal, blockedRequests, queryCounts: Object.fromEntries([...new Set(trace.map(request => request.phase))].map(name => [name, queryRequests(name).length])) };
  if (page) { try { failure.visibleAlerts = await page.locator('[role="alert"]').allTextContents(); failure.statusText = await page.locator('#lookup-status').allTextContents(); } catch {} }
  await writeFile(resolve(output, 'tunnel-browser-failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
  console.error(JSON.stringify(failure, null, 2));
  throw error;
} finally { await browser?.close(); }
