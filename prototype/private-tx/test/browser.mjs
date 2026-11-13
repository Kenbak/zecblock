import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPublications, startPrototype } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pointer = JSON.parse(await readFile(resolve(ROOT, '.local/current.json'), 'utf8'));
const dir = resolve(ROOT, '.local/publications', pointer.directory);
const source = JSON.parse(await readFile(resolve(dir, 'source.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'));
const publications = localPublications({ localDir: resolve(ROOT, '.local') });
const app = await startPrototype({ port: 0, publications });
let browser;
const requests = [], errors = [], records = [];
let phase = 'initialization', failQuery = false, malformedQuery = false;

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const OriginalWorker = window.Worker;
    // Test-only observation of the decrypted worker result. No application
    // debug hook, secret exposure or request interception is added to the UI.
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'result') window.__pirTestResult = data;
        });
      }
    };
  });
  await context.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== app.url) { errors.push('Non-local browser request attempted.'); await route.abort(); return; }
    if (request.url().endsWith('/pir/query') && failQuery) { await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable' }); return; }
    if (request.url().endsWith('/pir/query') && malformedQuery) { await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from([0, 1, 2]) }); return; }
    await route.continue();
  });
  context.on('request', request => requests.push({ phase, url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() }));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const started = performance.now();
  const response = await page.goto(app.url);
  assert.equal(response.status(), 200);
  assert.match(response.headers()['x-robots-tag'], /noindex/);
  await page.waitForFunction(() => !document.querySelector('#lookup-button')?.disabled || document.querySelector('#lookup-error'), null, { timeout: 120_000 });
  assert.equal(await page.locator('#lookup-error').count(), 0, 'Browser initialization must succeed.');
  const initializationMs = performance.now() - started;
  assert.equal(await page.locator('h1').count(), 1);

  function audit(lookupPhase, expectedCount) {
    const selected = requests.filter(request => request.phase === lookupPhase);
    const queries = selected.filter(request => new URL(request.url).pathname === '/pir/query');
    assert.equal(queries.length, expectedCount, lookupPhase);
    for (const request of selected) {
      const path = new URL(request.url).pathname;
      assert.equal(new URL(request.url).origin, app.url);
      assert.equal(new URL(request.url).search, '');
      assert.ok(path === '/pir/query' || path === '/publication/manifest.json' || path === '/publication/status.json' || /^\/publication\/[a-f0-9]{64}\/public.bin$/.test(path), `Unexpected lookup-dependent request: ${path}`);
      for (const record of source.records) {
        const id = record.txid;
        assert.ok(!request.url.includes(id), 'Transaction ID leaked in URL.');
        assert.ok(!JSON.stringify(request.headers).includes(id), 'Transaction ID leaked in headers.');
        if (request.body) {
          for (const encoding of [Buffer.from(id), Buffer.from(id, 'hex'), Buffer.from(id, 'hex').reverse()]) {
            assert.equal(request.body.indexOf(encoding), -1, 'Transaction ID leaked in request body.');
          }
        }
      }
      if (request.body) {
        assert.equal(request.headers['content-type'], 'application/octet-stream');
        assert.equal(request.headers['x-pir-publication'], manifest.publicationId);
        assert.equal(request.body.length, manifest.scheme.request_bytes);
      }
    }
    return queries;
  }

  async function lookup(record, name) {
    phase = name;
    console.log(`Checking local browser lookup: ${name}`);
    await page.evaluate(() => { window.__pirTestResult = null; });
    await page.locator('#txid').fill(record.txid);
    await page.locator('#lookup-button').click();
    await page.waitForFunction(() => document.querySelector('#result-section') || document.querySelector('[role="alert"]'), null, { timeout: 180_000 });
    const alert = await page.locator('[role="alert"]').allTextContents();
    assert.deepEqual(alert, [], 'Full transaction rendering must not hit the error boundary.');
    assert.equal(await page.locator('#lookup-error').count(), 0, await page.locator('#lookup-status').innerText());
    assert.equal(await page.locator('#result-txid').textContent(), record.txid);
    const decoded = await page.evaluate(() => window.__pirTestResult);
    assert.equal(decoded.result.found, true);
    assert.equal(decoded.result.txid, record.txid);
    assert.equal(decoded.result.publicationId, manifest.publicationId);
    assert.deepEqual(decoded.result.detail, record.detail, 'Full indexed detail must match the read-only source.');
    assert.deepEqual(decoded.result.raw, record.raw, 'Full raw and decoded bytes must match the read-only source.');
    assert.deepEqual(decoded.result.price, record.price);
    assert.deepEqual(decoded.result.source, record.source);
    assert.deepEqual(decoded.result.snapshot, source.snapshot);
    assert.equal(page.url(), `${app.url}/`);
    const queries = audit(name, manifest.chunkCount);
    records.push({ txid: record.txid, measurements: decoded.measurements, inputs: record.detail.inputs.length, outputs: record.detail.outputs.length, rawBytes: record.raw.hex.length / 2 });
    return queries;
  }

  const mixed = source.records.find(record => (record.detail.ironwoodActions ?? 0) > 0);
  const manyInputs = [...source.records].sort((a, b) => b.detail.inputs.length - a.detail.inputs.length)[0];
  const manyOutputs = [...source.records].sort((a, b) => b.detail.outputs.length - a.detail.outputs.length)[0];
  const coinbase = source.records.find(record => record.detail.isCoinbase === true);
  assert.ok(mixed && coinbase && manyInputs && manyOutputs, 'Live window needs representative confirmed records.');
  const beforeTyping = requests.filter(r => new URL(r.url).pathname === '/pir/query').length;
  await page.locator('#txid').fill(mixed.txid);
  assert.equal(requests.filter(r => new URL(r.url).pathname === '/pir/query').length, beforeTyping);
  const firstQueries = await lookup(mixed, 'mixed');
  const repeated = await lookup(mixed, 'repeat');
  assert.notDeepEqual(firstQueries[0].body, repeated[0].body, 'Repeated queries require fresh randomness.');
  await lookup(manyInputs, 'many-inputs');
  await page.locator('#tx-tabs').getByText('Inputs / Outputs', { exact: true }).click();
  assert.ok((await page.locator('#result-facts').innerText()).length > 0);
  audit('many-inputs', manifest.chunkCount);
  await lookup(manyOutputs, 'many-outputs');
  await page.locator('#tx-tabs').getByText('Inputs / Outputs', { exact: true }).click();
  const ioText = await page.locator('#result-facts').innerText();
  for (const output of manyOutputs.detail.outputs) if (output.address) assert.ok(ioText.includes(output.address), 'Every output address must remain available in the local view.');
  await page.locator('#tx-tabs').getByText('Raw', { exact: true }).click();
  assert.deepEqual(JSON.parse(await page.locator('#raw-decoded').innerText()), manyOutputs.raw.decoded);
  await page.getByRole('tab', { name: 'Hex', exact: true }).click();
  assert.equal(await page.locator('#raw-hex').textContent(), manyOutputs.raw.hex);
  audit('many-outputs', manifest.chunkCount);
  await lookup(coinbase, 'coinbase');
  assert.equal(await page.locator('a[href]').count(), 0, 'Selected block/address/transaction links must not navigate outside the private view.');

  phase = 'outside';
  await page.locator('#txid').fill('f'.repeat(64));
  await page.locator('#lookup-button').click();
  await page.locator('#lookup-error').waitFor({ state: 'visible' });
  assert.match(await page.locator('#lookup-error').innerText(), /outside|coverage|publication/i);
  audit('outside', 0);
  phase = 'invalid';
  await page.locator('#txid').fill('invalid');
  await page.locator('#lookup-button').click();
  await page.locator('#lookup-error').waitFor({ state: 'visible' });
  audit('invalid', 0);
  for (const failure of ['unavailable', 'malformed']) {
    phase = failure;
    failQuery = failure === 'unavailable'; malformedQuery = failure === 'malformed';
    await page.locator('#txid').fill(coinbase.txid);
    await page.locator('#lookup-button').click();
    await page.locator('#lookup-error').waitFor({ state: 'visible', timeout: 120_000 });
    assert.equal(await page.locator('#result-section').isVisible(), false);
    audit(failure, manifest.chunkCount);
  }
  failQuery = false; malformedQuery = false;
  await lookup(mixed, 'recovery');
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
  assert.deepEqual(storage, { local: 0, session: 0, cookie: '' });
  assert.deepEqual(errors.filter(error => !/Failed to load resource.*503/.test(error)), []);
  const output = resolve(ROOT, 'test-results');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'private-full-tx-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'private-full-tx-mobile.png'), fullPage: true });
  const report = {
    scope: 'Local full transaction view over recent confirmed mainnet data captured through independent public GET reads. Browser traffic restricted to loopback.',
    publicationId: manifest.publicationId, snapshot: source.snapshot, coverage: source.coverage,
    browserVersion: browser.version(), initializationMs, chunkCount: manifest.chunkCount, records,
    checks: ['full detail/raw/price/source parity in browser', 'Ironwood/mixed, many-input, many-output and coinbase records', 'same design components reused', 'all three tabs and exact full raw hex/JSON', 'uniform query count and lengths', 'randomized repeat queries', 'no selected ID in URLs/headers/text/raw/reversed request bodies', 'no ordinary API or external navigation', 'no queries on typing/outside/invalid input', '503 and malformed response rejected without fallback', 'successful recovery', 'empty browser storage', 'desktop and mobile layout'],
    requests: requests.map(({ body, ...request }) => ({ ...request, bodyBytes: body?.length ?? 0 })),
  };
  await writeFile(resolve(output, 'browser-full-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.checks, publicationId: report.publicationId, chunkCount: report.chunkCount, records: records.length, initializationMs, output }, null, 2));
} finally { await browser?.close(); await app.close(); }
