// Actual native/WASM selective-failure test. All HTTP services are ephemeral
// loopback fixtures. It never contacts production or the user's browser tab.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeEvaluator, startPrototype } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.PRIVATE_TX_REPLY_CLEAN_DIR, 'Set PRIVATE_TX_REPLY_CLEAN_DIR to a complete frozen publication directory containing manifest/public/database/source.');
const cleanDir = resolve(process.env.PRIVATE_TX_REPLY_CLEAN_DIR);
const native = resolve(process.env.PRIVATE_TX_REPLY_NATIVE ?? resolve(ROOT, '../pir-browser/target/release/zecblock-pir-fixture'));
const helper = resolve(process.env.PRIVATE_TX_REPLY_ATTACK_HELPER ?? resolve(ROOT, '../pir-browser/target/release/examples/reply-attack-fixture'));
const oldBundle = process.env.PRIVATE_TX_REPLY_OLD_BUNDLE ? resolve(process.env.PRIVATE_TX_REPLY_OLD_BUNDLE) : null;
const output = resolve(process.env.PRIVATE_TX_REPLY_OUTPUT ?? resolve(ROOT, 'test-results', `reply-privacy-${new Date().toISOString().replaceAll(':', '-')}`));
const cleanManifest = JSON.parse(await readFile(resolve(cleanDir, 'manifest.json'), 'utf8'));
const source = JSON.parse(await readFile(resolve(cleanDir, 'source.json'), 'utf8'));
assert.equal(cleanManifest.schema, 'zecblock-private-tx-full-v1');
assert.ok(cleanManifest.chunkCount >= 3 && cleanManifest.chunkCount <= 64);
assert.ok(cleanManifest.catalogue.length >= 2);
const targetId = process.env.PRIVATE_TX_REPLY_TARGET_TXID ?? [...cleanManifest.catalogue].sort((a, b) => b.recordBytes - a.recordBytes)[0].txid;
const unaffectedId = [...cleanManifest.catalogue].sort((a, b) => a.recordBytes - b.recordBytes).find(record => record.txid !== targetId).txid;
const expected = new Map(source.records.map(record => [record.txid, record]));
assert.ok(expected.has(targetId) && expected.has(unaffectedId));
await mkdir(output, { recursive: true });
const variants = [{ name: 'clean', dir: cleanDir, corruptOrdinal: null }];
for (const [name, ordinal] of [['first', 0], ['middle', Math.floor(cleanManifest.chunkCount / 2)], ['last', cleanManifest.chunkCount - 1]]) {
  const dir = resolve(output, `poisoned-${name}`);
  const prepared = spawnSync(helper, [cleanDir, dir, targetId, String(ordinal)], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(prepared.status, 0, `Build the offline reply-attack-fixture example first. ${prepared.error?.message ?? prepared.stderr ?? ''}`);
  const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(resolve(dir, 'attack-receipt.json'), 'utf8'));
  assert.equal(manifest.publicationId, cleanManifest.publicationId);
  assert.deepEqual(manifest.catalogue, cleanManifest.catalogue, 'Attack keeps honest record commitments and lookup placement.');
  assert.notEqual(manifest.publicSha256, cleanManifest.publicSha256, 'Poisoned database uses an actual rebuilt native setup.');
  assert.equal(receipt.targetTxid, targetId);
  assert.equal(receipt.chunkOrdinal, ordinal);
  variants.push({ name: `poisoned-${name}`, dir, corruptOrdinal: ordinal, receipt });
}

let browser;
const cases = [];
const negativeCases = [];
const quietWindows = [];
const allErrors = [];
function shape(requests) { return requests.map(request => ({ path: request.path, method: request.method, publication: request.headers['x-pir-publication'] ?? null, bodyBytes: request.body?.length ?? 0 })); }

async function runVariant(variant, { legacy = false } = {}) {
  let phase = 'initialize';
  const received = [];
  const manifestBytes = await readFile(resolve(variant.dir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const evaluator = nativeEvaluator(native, variant.dir);
  const publication = { manifest, manifestBytes, publicBytes: await readFile(resolve(variant.dir, 'public.bin')), evaluator };
  const publications = { current: async () => publication, get: id => id === manifest.publicationId ? publication : undefined, status: async () => ({ state: 'ready' }), close: () => evaluator.close() };
  const app = await startPrototype({ port: 0, publications, onRequest(request) { received.push({ ...request, phase, atEpochMs: Date.now() }); } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, serviceWorkers: 'block' });
  const requests = [], messages = [], consoleErrors = [], externalAttempts = [];
  let page;
  try {
    await context.addInitScript(() => {
      window.__replyPrivacy = { outcome: null, result: null, events: [] };
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            const event = { type: data.type, stage: data.stage, chunk: data.chunk, chunks: data.chunks, atEpochMs: performance.timeOrigin + performance.now() };
            window.__replyPrivacy.events.push(event);
            if (data.type === 'result' || data.type === 'error') {
              window.__replyPrivacy.outcome = data;
              if (data.type === 'result') window.__replyPrivacy.result = data.result;
            }
          });
        }
      };
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') { await route.continue(); return; }
      if (url.origin !== app.url) { externalAttempts.push(url.origin); await route.abort('blockedbyclient'); return; }
      if (legacy) {
        const overrides = new Map([
          ['/worker.js', [resolve(oldBundle, 'prototype/private-tx/web/worker.js'), 'text/javascript']],
          ['/wasm/zecblock_pir_browser.js', [resolve(oldBundle, 'prototype/pir-browser/pkg/zecblock_pir_browser.js'), 'text/javascript']],
          ['/wasm/zecblock_pir_browser_bg.wasm', [resolve(oldBundle, 'prototype/pir-browser/pkg/zecblock_pir_browser_bg.wasm'), 'application/wasm']],
        ]);
        const replacement = overrides.get(url.pathname);
        if (replacement) { await route.fulfill({ status: 200, contentType: replacement[1], body: await readFile(replacement[0]) }); return; }
      }
      await route.continue();
    });
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol === 'data:') return;
      const item = { phase, path: url.pathname, url: request.url(), method: request.method(), headers: request.headers(), body: request.postDataBuffer(), atEpochMs: Date.now() };
      requests.push(item);
      for (const record of source.records) {
        assert.ok(!item.url.includes(record.txid));
        assert.ok(!JSON.stringify(item.headers).includes(record.txid));
        if (item.body) for (const encoding of [Buffer.from(record.txid), Buffer.from(record.txid, 'hex'), Buffer.from(record.txid, 'hex').reverse()]) assert.equal(item.body.indexOf(encoding), -1);
      }
    });
    page = await context.newPage();
    page.on('pageerror', error => allErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelector('[role="alert"]') || (document.querySelector('#lookup-button') && !document.querySelector('#lookup-button').disabled), null, { timeout: 120_000 });
    assert.deepEqual(await page.locator('[role="alert"]').allTextContents(), []);

    async function lookup(txid, affected) {
      phase = affected ? 'affected' : 'unaffected';
      console.log(`Checking real selective reply: ${legacy ? 'old-negative-control/' : ''}${variant.name}/${phase}`);
      await page.evaluate(() => { window.__replyPrivacy.outcome = null; window.__replyPrivacy.result = null; window.__replyPrivacy.events = []; });
      await page.locator('#txid').fill(txid);
      await page.locator('#lookup-button').click();
      await page.waitForFunction(() => window.__replyPrivacy.outcome !== null, null, { timeout: 180_000 });
      const outcome = await page.evaluate(() => window.__replyPrivacy);
      const selected = requests.filter(request => request.phase === phase);
      const queries = selected.filter(request => request.path === '/pir/query');
      assert.ok(outcome.events.some(event => event.type === 'stage' && event.stage === 'decode'), 'The real worker must accept the HTTP reply batch and enter content decoding; a transport failure is not a selective-content attack.');
      const expectedQueries = legacy && affected ? 1 : manifest.chunkCount;
      assert.equal(queries.length, expectedQueries, legacy ? 'The retained old first-row failure must reproduce its premature one-query stop.' : 'Content corruption must never truncate the padded HTTP batch.');
      const receiverQueries = received.filter(request => request.phase === phase && request.path === '/pir/query');
      assert.equal(receiverQueries.length, expectedQueries, 'The local receiver must actually observe the entire query budget, not merely queued browser fetch calls.');
      assert.deepEqual(receiverQueries.map(({ method, path }) => ({ method, path })), queries.map(({ method, path }) => ({ method, path })), 'Receiver-side request route/method/order must match the browser trace.');
      if (!legacy) assert.equal(selected.length, manifest.chunkCount, 'No source fallback, automatic retry or metadata request may reveal the outcome.');
      assert.ok(queries.every(request => request.method === 'POST' && request.headers['content-type'] === 'application/octet-stream' && request.headers['x-pir-publication'] === manifest.publicationId && request.body?.length === manifest.scheme.request_bytes));
      assert.equal(page.url(), `${app.url}/`);
      const shouldReject = affected && variant.corruptOrdinal !== null;
      if (shouldReject) {
        assert.equal(outcome.outcome.type, 'error');
        assert.equal(outcome.result, null);
        await page.locator('#lookup-error').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#result-section').count(), 0);
      } else {
        assert.equal(outcome.outcome.type, 'result');
        assert.equal(outcome.result.found, true);
        assert.equal(outcome.result.txid, txid);
        assert.deepEqual(outcome.result.detail, expected.get(txid).detail);
        assert.deepEqual(outcome.result.raw, expected.get(txid).raw);
        assert.deepEqual(outcome.result.price, expected.get(txid).price);
        assert.deepEqual(outcome.result.source, expected.get(txid).source);
        assert.deepEqual(outcome.result.snapshot, source.snapshot);
        assert.deepEqual(outcome.result.coverage, source.coverage);
        await page.locator('#result-section').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#result-txid').textContent(), txid);
      }
      const countAfterOutcome = requests.length;
      await page.waitForTimeout(350);
      if (!legacy) assert.equal(requests.length, countAfterOutcome, 'No automatic request may follow acceptance/rejection.');
      if (!legacy && variant.name === 'poisoned-first' && affected) {
        const beforeBrowser = requests.length;
        const beforeReceiver = received.length;
        await page.waitForTimeout(35_000);
        assert.equal(requests.length, beforeBrowser, 'The former 30-second metadata poll must not follow content rejection.');
        assert.equal(received.length, beforeReceiver, 'The receiver must observe no delayed automatic metadata/query request.');
        quietWindows.push({ variant: variant.name, selectorClass: phase, durationMs: 35_000, browserRequestDelta: requests.length - beforeBrowser, receiverRequestDelta: received.length - beforeReceiver });
      }
      const summary = {
        variant: variant.name, legacyNegativeControl: legacy, selectorClass: phase, txid, outcome: outcome.outcome.type,
        error: outcome.outcome.type === 'error' ? outcome.outcome.message : null,
        requestShape: shape(selected),
        receiverRequestShape: receiverQueries.map(({ method, path }) => ({ method, path })),
        workerEvents: outcome.events,
        requestTimesEpochMs: queries.map(request => request.atEpochMs),
      };
      (legacy ? negativeCases : cases).push(summary);
      return summary;
    }
    await lookup(targetId, true);
    await lookup(unaffectedId, false);
    assert.deepEqual(externalAttempts, []);
    assert.deepEqual(consoleErrors, []);
    assert.equal(await page.locator('a[href]').count(), 0);
    messages.push(...await page.evaluate(() => window.__replyPrivacy.events));
  } catch (error) {
    if (page) {
      await writeFile(resolve(output, `${variant.name}-failure.json`), `${JSON.stringify({ error: error.message, phase, alerts: await page.locator('[role="alert"]').allTextContents(), status: await page.locator('#lookup-status').allTextContents(), requestShape: shape(requests), consoleErrors, externalAttempts }, null, 2)}\n`);
    }
    throw error;
  } finally { await context.close(); await app.close(); }
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 30_000 });
  for (const variant of variants) await runVariant(variant);
  if (oldBundle) await runVariant(variants.find(variant => variant.name === 'poisoned-first'), { legacy: true });
  const baseline = cases[0].requestShape;
  for (const result of cases) assert.deepEqual(result.requestShape, baseline, `${result.variant}/${result.selectorClass} has the same observable request shape.`);
  for (const result of cases) assert.deepEqual(result.receiverRequestShape, cases[0].receiverRequestShape, 'The receiver observes the same padded POST count and route/method order.');
  const rejectionMessages = cases.filter(result => result.outcome === 'error').map(result => result.error);
  assert.equal(rejectionMessages.length, 3);
  assert.equal(new Set(rejectionMessages).size, 1, 'Content rejection must not disclose a failed chunk ordinal.');
  assert.deepEqual(allErrors, []);
  if (oldBundle) {
    assert.equal(negativeCases.length, 2);
    assert.equal(negativeCases.find(result => result.selectorClass === 'affected').requestShape.length, 1);
    assert.equal(negativeCases.find(result => result.selectorClass === 'unaffected').requestShape.length, cleanManifest.chunkCount);
  }
  const report = {
    status: 'passed', completedAt: new Date().toISOString(), publicationId: cleanManifest.publicationId,
    chunkCount: cleanManifest.chunkCount, targetId, unaffectedId,
    attack: 'Actual native database row corruption at first/middle/last padded chunk, re-preprocessed with updated setup hashes but original publication identity, catalogue and record commitments.',
    cases, quietWindows,
    oldNegativeControl: { performed: oldBundle !== null, bundle: oldBundle, cases: negativeCases, interpretation: oldBundle ? 'Retained old worker+WASM stop after one query for the poisoned target and complete N for an unaffected record; the selective-failure count leak is reproduced separately from the corrected passing matrix.' : 'Not run; set PRIVATE_TX_REPLY_OLD_BUNDLE to the retained pre-fix bundle for a real regression negative control.' },
    checks: ['real upstream native evaluator and browser WASM', 'affected-record rejection with unaffected-record full parity', 'first/middle/last selected-row corruption', 'all padded requests despite content failure', 'identical route/method/publication/body-length/order traces', 'receiver-observed padded POST count and route/method order', 'no selected identifier in HTTP requests', 'no fallback/retry/automatic request after outcome', 'actual 35-second quiet window after first-chunk content rejection', 'uniform content-error text'],
    limits: 'This is a targeted selective-failure regression, not a cryptographic audit, proof of constant-time networking, IP anonymity or protection against a malicious delivered client. Browser connection scheduling and total decode time can vary. The VM test independently enforces all-fetch-before-decode and advances virtual time to check absence of delayed metadata traffic.',
  };
  await writeFile(resolve(output, 'reply-privacy-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, publicationId: report.publicationId, chunkCount: report.chunkCount, cases: cases.length, output }, null, 2));
} finally { await browser?.close(); }
