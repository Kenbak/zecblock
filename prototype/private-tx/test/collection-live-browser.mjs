// Acceptance of an already-running collection using an explicit loopback
// origin and a copied offline archive. No SSH, source API or service mutation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../collection.mjs';
import { copiedPublicationOracle, sha256 } from './published-oracle.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.PRIVATE_TX_TEST_ORIGIN && process.env.PRIVATE_TX_TEST_ARCHIVE,
  'Set PRIVATE_TX_TEST_ORIGIN=http://127.0.0.1:<port> and PRIVATE_TX_TEST_ARCHIVE=/absolute/path/to/copied-archive.');
const url = new URL(process.env.PRIVATE_TX_TEST_ORIGIN);
assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/'
  && !url.search && !url.hash && !url.username && !url.password, 'An explicit HTTP loopback origin without credentials/path/query is required.');
const origin = url.origin, archive = resolve(process.env.PRIVATE_TX_TEST_ARCHIVE);
const quietMs = Number(process.env.PRIVATE_TX_TEST_QUIET_MS ?? 35_000);
assert.ok(Number.isSafeInteger(quietMs) && quietMs >= 0 && quietMs <= 60_000);
const output = resolve(process.env.PRIVATE_TX_TEST_OUTPUT ?? resolve(ROOT, 'test-results', `collection-live-${new Date().toISOString().replaceAll(':', '-')}`));
await mkdir(output, { recursive: true });
const oracle = await copiedPublicationOracle(archive, { selectedIds: (process.env.PRIVATE_TX_TEST_SELECTED_IDS ?? '').split(',').filter(Boolean) });
const { collection, samples } = oracle;
if (process.env.PRIVATE_TX_TEST_COLLECTION) assert.equal(collection.collectionId, process.env.PRIVATE_TX_TEST_COLLECTION);
const schedule = collection.segments.flatMap(segment => Array(segment.manifest.chunkCount).fill(segment.publicationId));
assert.ok(schedule.length > 0 && schedule.length <= 64);
const catalogueIds = collection.segments.flatMap(segment => segment.manifest.catalogue.map(entry => entry.txid));
const ids = new Set(catalogueIds);
const allowed = new Set(['/', '/app.js', '/worker.js', '/style.css', '/fonts/geist-sans.woff2', '/fonts/geist-mono.woff2',
  '/wasm/zecblock_pir_browser.js', '/wasm/zecblock_pir_browser_bg.wasm', '/publication/manifest.json', '/publication/status.json', '/pir/query',
  ...collection.segments.map(segment => `/publication/${segment.publicationId}/public.bin`)]);
const trace = [], responseTasks = [], blocked = [], external = [], consoleErrors = [], browserErrors = [], websockets = [], lookups = [], observationGaps = [];
const requests = new Map();
let browser, page, phase = 'initialize';

function checkRequest(request) {
  const address = new URL(request.url);
  assert.equal(address.origin, origin); assert.equal(address.search, ''); assert.equal(address.hash, '');
  assert.ok(allowed.has(address.pathname), `Unallowlisted browser path: ${address.pathname}`);
  for (const header of ['cookie', 'authorization', 'forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) assert.equal(request.headers[header], undefined);
  assert.equal(request.method, address.pathname === '/pir/query' ? 'POST' : 'GET');
  for (const id of catalogueIds) {
    assert.ok(!request.url.toLowerCase().includes(id) && !JSON.stringify(request.headers).toLowerCase().includes(id), 'Catalogue txid escaped in URL/headers.');
    if (request.body) for (const bytes of [Buffer.from(id), Buffer.from(id.toUpperCase()), Buffer.from(id, 'hex'), Buffer.from(id, 'hex').reverse()]) {
      assert.equal(request.body.indexOf(bytes), -1, 'Catalogue txid escaped in upload bytes.');
    }
  }
  if (address.pathname === '/pir/query') {
    assert.equal(request.headers['content-type'], 'application/octet-stream');
    assert.ok(collection.segments.some(segment => segment.publicationId === request.headers['x-pir-publication']));
    assert.equal(request.body?.length, 20_992);
  } else assert.ok(!request.body?.length);
}

async function observe(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DevTools body unavailable')), 2000); })]); }
  finally { clearTimeout(timer); }
}
const phaseRequests = name => trace.filter(item => item.phase === name);
async function checkBatch(name, expectedQueries = schedule.length) {
  await Promise.all(responseTasks);
  const batch = phaseRequests(name);
  assert.equal(batch.length, expectedQueries, 'A lookup must contain only its complete fixed encrypted schedule.');
  const queryCalls = batch.filter(item => new URL(item.url).pathname === '/pir/query');
  assert.equal(queryCalls.length, expectedQueries);
  if (expectedQueries) assert.deepEqual(queryCalls.map(item => item.headers['x-pir-publication']), schedule);
  for (const item of queryCalls) {
    checkRequest(item); assert.equal(item.status, 200); assert.match(item.responseType, /^application\/octet-stream/);
    if (item.responseBytes !== undefined) assert.equal(item.responseBytes, 10_240);
    else observationGaps.push({ phase: name, path: '/pir/query', detail: 'Dedicated-worker body unavailable to DevTools; reviewed client and successful decode enforce exact per-slot and aggregate reply bytes.' });
  }
  assert.equal(page.url(), `${origin}/`);
  return queryCalls;
}
function feeLabel(detail) {
  if (typeof detail.feeZat === 'string' && /^(0|[1-9]\d*)$/.test(detail.feeZat)) {
    const digits = detail.feeZat.padStart(9, '0'); return `${digits.slice(0, -8)}.${digits.slice(-8)} ZEC`;
  }
  return detail.isCoinbase === true ? 'Not applicable (coinbase)' : 'Unavailable';
}
async function lookup(sample, name) {
  phase = name;
  await page.evaluate(() => { window.__collectionLiveAudit.outcome = null; window.__collectionLiveAudit.stages = []; });
  await page.locator('#txid').fill(sample.txid); await page.locator('#lookup-button').click();
  await page.waitForFunction(() => window.__collectionLiveAudit.outcome !== null, null, { timeout: 180_000 });
  const observed = await page.evaluate(() => window.__collectionLiveAudit);
  assert.equal(observed.outcome.type, 'result', observed.outcome.message);
  assert.deepEqual(observed.outcome.result, sample.record, 'PIR result must match the entire locally decoded published-record envelope.');
  const measurements = observed.outcome.measurements;
  assert.equal(measurements.collectionId, collection.collectionId);
  assert.equal(measurements.segmentCount, collection.segments.length);
  assert.equal(measurements.queryBytes, schedule.length * 20_992);
  assert.equal(measurements.responseBytes, schedule.length * 10_240);
  assert.equal(measurements.chunkCount, schedule.length);
  await page.locator('#result-section').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#result-txid').textContent(), sample.txid);
  assert.deepEqual(await page.locator('[role="alert"]').allTextContents(), []);
  await page.locator('#tx-tabs').getByText('Overview', { exact: true }).click();
  assert.equal(await page.locator('#private-fee').textContent(), feeLabel(sample.record.detail));
  await page.locator('#tx-tabs').getByText('Inputs / Outputs', { exact: true }).click();
  const io = await page.locator('#result-facts').innerText();
  for (const entry of [...sample.record.detail.inputs, ...sample.record.detail.outputs]) if (entry.address) assert.ok(io.includes(entry.address));
  await page.locator('#tx-tabs').getByText('Raw', { exact: true }).click();
  assert.deepEqual(JSON.parse(await page.locator('#raw-decoded').innerText()), sample.record.raw.decoded);
  await page.getByRole('tab', { name: 'Hex', exact: true }).click();
  assert.equal(await page.locator('#raw-hex').textContent(), sample.record.raw.hex);
  assert.equal(await page.locator('a[href]').count(), 0, 'Selected references must remain inert.');
  const queries = await checkBatch(name);
  lookups.push({ name, publicTestTxid: sample.txid, publicationId: sample.publicationId, inputCount: sample.record.detail.inputs.length,
    outputCount: sample.record.detail.outputs.length, rawBytes: sample.record.raw.hex.length / 2, feeZat: sample.record.detail.feeZat ?? null,
    publishedRecordSha256: sha256(Buffer.from(canonicalJson(sample.record))), measurements, stages: observed.stages });
  console.log(`Verified installed collection: ${name}, ${schedule.length} encrypted queries.`);
  return queries;
}

try {
  const actual = await fetch(`${origin}/publication/manifest.json`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  assert.equal(actual.status, 200);
  assert.equal(canonicalJson(await actual.json()), canonicalJson(collection), 'The service and copied offline archive must have the same pinned collection.');
  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 30_000 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.__collectionLiveAudit = { outcome: null, manifest: null, stages: [] };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args); this.addEventListener('message', ({ data }) => {
          if (data.type === 'ready') window.__collectionLiveAudit.manifest = data.manifest;
          if (data.type === 'result' || data.type === 'error') window.__collectionLiveAudit.outcome = data;
          if (data.type === 'stage') window.__collectionLiveAudit.stages.push({ stage: data.stage, chunk: data.chunk, chunks: data.chunks });
        });
      }
    };
  });
  await context.route('**/*', async route => {
    const request = route.request(), address = new URL(request.url());
    if (address.protocol === 'data:') return route.continue();
    if (address.origin !== origin) { external.push(address.origin); return route.abort('blockedbyclient'); }
    try { checkRequest({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() }); }
    catch (error) { blocked.push({ phase, path: address.pathname, reason: error.message }); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  context.on('request', request => {
    if (new URL(request.url()).protocol === 'data:') return;
    const item = { phase, url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() };
    trace.push(item); requests.set(request, item);
  });
  context.on('response', response => {
    const item = requests.get(response.request()); if (!item) return;
    item.status = response.status(); item.responseType = response.headers()['content-type'] ?? '';
    responseTasks.push((async () => {
      try { const bytes = await observe(response.body()); item.responseBytes = bytes.length; item.responseSha256 = sha256(bytes); }
      catch { item.responseObservationUnavailable = true; }
    })());
  });
  page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('websocket', socket => websockets.push(socket.url()));
  const started = performance.now(), response = await page.goto(`${origin}/`);
  assert.equal(response.status(), 200); assert.match(response.headers()['x-robots-tag'], /noindex/);
  assert.match(response.headers()['content-security-policy'], /connect-src 'self'/); assert.equal(response.headers()['cache-control'], 'no-store');
  await page.waitForFunction(() => document.querySelector('[role="alert"]') || document.querySelector('#lookup-button') && !document.querySelector('#lookup-button').disabled, null, { timeout: 180_000 });
  assert.deepEqual(await page.locator('[role="alert"]').allTextContents(), []);
  const initializationMs = performance.now() - started;
  assert.equal((await page.evaluate(() => window.__collectionLiveAudit.manifest)).collectionId, collection.collectionId);
  assert.equal(await page.locator('h1').count(), 1);
  const initialHtml = await response.text(); for (const id of catalogueIds) assert.ok(!initialHtml.includes(id));
  assert.deepEqual(trace.filter(item => /\/public\.bin$/.test(new URL(item.url).pathname)).map(item => new URL(item.url).pathname),
    collection.segments.map(segment => `/publication/${segment.publicationId}/public.bin`));
  phase = 'typing'; const beforeTyping = trace.length;
  await page.locator('#txid').fill(samples[0].txid); await page.waitForTimeout(300); assert.equal(trace.length, beforeTyping);
  let first;
  for (const [index, sample] of samples.entries()) { const batch = await lookup(sample, `segment-${index + 1}`); first ??= batch; }
  const repeat = await lookup(samples[0], 'repeat');
  for (let index = 0; index < first.length; index++) assert.notDeepEqual(first[index].body, repeat[index].body);
  assert.equal(new Set([...first, ...repeat].map(item => sha256(item.body))).size, first.length + repeat.length);
  await page.locator('#tx-tabs').getByText('Overview', { exact: true }).click();
  await page.screenshot({ path: resolve(output, 'collection-live-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(output, 'collection-live-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await checkBatch('repeat');
  for (const [name, input] of [['invalid', 'invalid'], ['outside', 'f'.repeat(64)]]) {
    assert.ok(!ids.has(input)); phase = name;
    await page.locator('#txid').fill(input); await page.locator('#lookup-button').click();
    await page.locator('#lookup-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#result-section').count(), 0); await checkBatch(name, 0);
  }
  phase = 'quiet'; const quietBefore = trace.length; await page.waitForTimeout(quietMs); assert.equal(trace.length, quietBefore, 'No automatic polling, retry or fallback follows local failure.');
  const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie,
    indexedDb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : null, caches: (await caches.keys()).length }));
  assert.deepEqual(storage, { local: 0, session: 0, cookies: '', indexedDb: 0, caches: 0 });
  phase = 'assets';
  const assets = [];
  for (const [path, file] of [['/app.js', 'web/app.js'], ['/worker.js', 'web/worker.js'], ['/style.css', 'web/style.css'],
    ['/wasm/zecblock_pir_browser.js', '../pir-browser/pkg/zecblock_pir_browser.js'], ['/wasm/zecblock_pir_browser_bg.wasm', '../pir-browser/pkg/zecblock_pir_browser_bg.wasm']]) {
    await Promise.all(responseTasks);
    const item = trace.find(request => new URL(request.url).pathname === path);
    assert.equal(item?.status, 200);
    let actualHash = item.responseSha256, hashSource = 'initial-browser-response';
    if (!actualHash) {
      actualHash = await page.evaluate(async path => {
        const response = await fetch(path, { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('Generic asset hash observation failed.');
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
        return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      }, path);
      hashSource = 'separate-generic-browser-get';
    }
    const expectedHash = sha256(await readFile(resolve(ROOT, file))); assert.equal(actualHash, expectedHash);
    assets.push({ path, sha256: expectedHash, hashSource });
  }
  await Promise.all(responseTasks); for (const item of trace) checkRequest(item);
  assert.deepEqual(external, []); assert.deepEqual(blocked, []); assert.deepEqual(websockets, []); assert.deepEqual(browserErrors, []); assert.deepEqual(consoleErrors, []);
  const report = { status: 'passed', completedAt: new Date().toISOString(), origin, collectionId: collection.collectionId, browserVersion: browser.version(),
    scope: 'Read-only browser acceptance of explicit loopback collection. Expected envelopes decoded locally from copied plaintext published tables; this proves published-table to PIR result parity, not independent source/chain correctness.',
    oracle: { directory: archive, files: oracle.files }, coverage: collection.coverage, segments: collection.segments.map(segment => ({ publicationId: segment.publicationId,
      records: segment.manifest.catalogue.length, chunks: segment.manifest.chunkCount, snapshot: segment.manifest.snapshot })),
    initializationMs, fixedQueries: schedule.length, lookups, quietWindow: { milliseconds: quietMs, requests: 0 }, storage, assets, observationGaps,
    requestTrace: trace.map(({ body, headers, ...item }) => ({ ...item, bodyBytes: body?.length ?? 0, bodySha256: body ? sha256(body) : null,
      headerNames: Object.keys(headers).sort(), publicationHeader: headers['x-pir-publication'] ?? null })),
    checks: ['one explicit public example per copied segment, maximum three', 'whole-envelope parity with locally decoded committed rows', 'all tabs, raw hex/JSON and exact fee/unavailable display',
      'fixed complete all-segment publication/count/length schedule', 'fresh ciphertext in every repeated real and cover slot', 'no selector in requests', 'allowlisted loopback-only traffic',
      'no traffic on typing/invalid/outside input or quiet window', 'empty browser storage', 'reviewed asset hashes', 'desktop/mobile rendering'],
    limits: 'No SSH, source/API reads, remote mutation, remote poisoning or service lifecycle control. The server still sees IP/timing/headers and public publication IDs. Browser observations do not prove server logs/retention, constant-time execution, independent chain correctness, full-history routing or client-delivery trust.' };
  await writeFile(resolve(output, 'collection-live-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, collectionId: collection.collectionId, samples: samples.length, lookups: lookups.length, fixedQueries: schedule.length, output }, null, 2));
} catch (error) {
  await writeFile(resolve(output, 'collection-live-browser-failure.json'), `${JSON.stringify({ status: 'failed', phase, error: error.message,
    origin, collectionId: collection.collectionId, blocked, external, browserErrors, consoleErrors,
    queryCounts: Object.fromEntries([...new Set(trace.map(item => item.phase))].map(name => [name, phaseRequests(name).length])) }, null, 2)}\n`);
  throw error;
} finally { await browser?.close(); }
