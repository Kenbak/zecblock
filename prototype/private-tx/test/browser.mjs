import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeEvaluator, startPrototype } from '../server.mjs';

const require = createRequire(import.meta.url);
// Standard local npm dependency; NODE_PATH can reuse an existing Playwright
// installation without changing the explorer's dependencies.
const { chromium } = require('playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const root = resolve(HERE, '..');
const fixtureDir = resolve(root, '.local/fixture');
const outputDir = resolve(root, 'test-results');
const manifest = JSON.parse(await readFile(resolve(fixtureDir, 'manifest.json'), 'utf8'));
const expected = manifest.catalogue;
// Private-to-the-test oracle from the checked raw transaction fixtures. The
// server never serves this file; success requires retrieved facts, not an ID echo.
const oracle = JSON.parse(await readFile(resolve(fixtureDir, 'expected.json'), 'utf8'));
assert.ok(expected.length >= 2, 'Multiple fixture choices are needed to test selection privacy.');
const evaluator = nativeEvaluator(resolve(root, '../pir-browser/target/release/zecblock-pir-fixture'), fixtureDir);
const app = await startPrototype({ port: 0, fixtureDir, evaluator });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, serviceWorkers: 'block' });
const requests = [];
const replies = [];
const errors = [];
let blockQueries = false;
let truncateReply = false;
let activePhase = 'initialization';

// These independent browser controls ensure no test can accidentally contact
// production, even if application code regresses. Worker traffic is included.
await context.route('**/*', async route => {
  const request = route.request();
  if (new URL(request.url()).origin !== app.url) {
    errors.push('Non-local request attempted.');
    await route.abort('blockedbyclient'); return;
  }
  if (request.url().endsWith('/pir/query') && blockQueries) {
    await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Evaluator unavailable.' }); return;
  }
  if (request.url().endsWith('/pir/query') && truncateReply) {
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from([0, 1, 2]) }); return;
  }
  await route.continue();
});
context.on('request', request => {
  requests.push({ phase: activePhase, url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer() });
});
context.on('response', response => {
  if (response.url().endsWith('/pir/query')) replies.push(response.status());
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text());
});

async function lookup(txid) {
  await page.locator('#txid').fill(txid);
  await page.locator('#lookup-button').click();
  await page.locator('#result-section').waitFor({ state: 'visible', timeout: 120_000 });
  const text = await page.locator('#result-facts').innerText();
  assert.ok(text.includes(txid), 'The selected full identifier must be decoded and rendered.');
  const facts = await page.locator('#result-facts .result-fact').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])));
  const expectedFacts = oracle[txid];
  assert.ok(expectedFacts, 'Fixture must have a checked raw-transaction oracle.');
  assert.equal(facts.Found, 'true', 'A selected ID echo is insufficient: the record must be found.');
  assert.equal(facts.Coinbase, String(expectedFacts.coinbase));
  assert.equal(facts['Fee (zatoshis)'], expectedFacts.feeZatoshis);
  assert.equal(facts['Input Count'], String(expectedFacts.inputCount));
  assert.equal(facts['Output Count'], String(expectedFacts.outputCount));
  assert.deepEqual(JSON.parse(facts.Outputs), expectedFacts.outputs);
  assert.equal(page.url(), `${app.url}/`);
  return text;
}

function assertPrivateRequests(phase, { queryExpected = true } = {}) {
  const selected = requests.filter(request => request.phase === phase);
  const queries = selected.filter(request => new URL(request.url).pathname === '/pir/query');
  assert.equal(queries.length, queryExpected ? 1 : 0, phase);
  for (const request of selected) {
    assert.equal(new URL(request.url).origin, app.url);
    assert.equal(new URL(request.url).search, '');
    for (const { txid } of expected) {
      assert.ok(!request.url.includes(txid), 'Selector leaked in request URL.');
      assert.ok(!JSON.stringify(request.headers).includes(txid), 'Selector leaked in request headers.');
      if (request.body) {
        assert.equal(request.body.indexOf(Buffer.from(txid, 'utf8')), -1, 'Selector leaked as text.');
        assert.equal(request.body.indexOf(Buffer.from(txid, 'hex')), -1, 'Selector leaked as raw bytes.');
        assert.equal(request.body.indexOf(Buffer.from(txid, 'hex').reverse()), -1, 'Selector leaked as reversed bytes.');
      }
    }
    if (request.body) assert.equal(request.headers['content-type'], 'application/octet-stream');
  }
  return queries[0]?.body;
}

try {
  const start = performance.now();
  const initialResponse = await page.goto(app.url);
  assert.equal(initialResponse.status(), 200);
  assert.match(initialResponse.headers()['x-robots-tag'], /noindex/);
  await page.locator('#lookup-button').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#lookup-button').disabled, null, { timeout: 120_000 });
  const initializationMs = performance.now() - start;
  assert.equal(await page.locator('h1').count(), 1);
  const noInputRequests = requests.length;
  await page.locator('#txid').fill(expected[0].txid);
  assert.equal(requests.length, noInputRequests, 'Typing must not trigger a network lookup.');

  activePhase = 'first';
  const firstFacts = await lookup(expected[0].txid);
  const first = assertPrivateRequests('first');
  const firstMetrics = await page.locator('#metrics').innerText();
  activePhase = 'repeat';
  await lookup(expected[0].txid);
  const repeated = assertPrivateRequests('repeat');
  assert.equal(first.length, repeated.length, 'Same profile has fixed query length.');
  assert.notDeepEqual(first, repeated, 'Repeated queries must use fresh cryptographic randomness.');

  activePhase = 'second';
  const secondFacts = await lookup(expected[1].txid);
  const second = assertPrivateRequests('second');
  assert.equal(first.length, second.length, 'Both selected rows use the same query shape.');
  assert.notDeepEqual(first, second);

  activePhase = 'invalid';
  await page.locator('#txid').fill('invalid');
  await page.locator('#lookup-button').click();
  await page.locator('#lookup-error').waitFor({ state: 'visible' });
  assertPrivateRequests('invalid', { queryExpected: false });

  activePhase = 'unavailable';
  blockQueries = true;
  await page.locator('#txid').fill(expected[0].txid);
  await page.locator('#lookup-button').click();
  await page.locator('#lookup-error').waitFor({ state: 'visible', timeout: 120_000 });
  assert.equal(await page.locator('#result-section').isVisible(), false, 'Old result must not survive a failed lookup.');
  assertPrivateRequests('unavailable');
  assert.equal(requests.filter(request => request.phase === 'unavailable').length, 1, 'Failure must not trigger fallback traffic.');

  activePhase = 'malformed';
  blockQueries = false;
  truncateReply = true;
  await page.locator('#txid').fill(expected[0].txid);
  await page.locator('#lookup-button').click();
  await page.locator('#lookup-error').waitFor({ state: 'visible', timeout: 120_000 });
  assert.equal(await page.locator('#result-section').isVisible(), false);
  assertPrivateRequests('malformed');
  assert.equal(requests.filter(request => request.phase === 'malformed').length, 1);

  activePhase = 'recovery';
  truncateReply = false;
  await lookup(expected[0].txid);
  assertPrivateRequests('recovery');
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
  assert.deepEqual(storage, { local: 0, session: 0, cookie: '' });
  // Expected 503 in the negative test can produce Chromium's resource message.
  const unexpectedErrors = errors.filter(error => !/Failed to load resource.*503/.test(error));
  assert.deepEqual(unexpectedErrors, []);
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: resolve(outputDir, 'private-transaction-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(outputDir, 'private-transaction-mobile.png'), fullPage: true });
  const report = {
    scope: 'Local bounded public-chain fixture transaction PIR; no production requests.',
    initializationMs, queryBytes: first.length, firstMetrics, firstFacts, secondFacts,
    checks: ['browser WASM encryption and decode', 'native upstream evaluator', 'two distinct record selections', 'randomized repeat query', 'no cleartext selector in URL/header/body', 'identical query length', 'no request on typing/invalid input', '503 without fallback', 'malformed response rejected', 'recovery after failure', 'empty browser storage', 'desktop and mobile layout'],
    requests: requests.map(({ body, ...request }) => ({ ...request, bodyBytes: body?.length ?? 0 })),
    replyStatuses: replies,
  };
  await writeFile(resolve(outputDir, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.checks, initializationMs, queryBytes: first.length, outputDir }, null, 2));
} finally {
  await browser.close();
  await app.close();
}
