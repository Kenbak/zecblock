// Dedicated real Chrome/native/WASM collection audit. It reads a frozen local
// public-chain fixture and starts only ephemeral loopback services; no source
// API, production database, SSH session or user's existing browser is accessed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishCollection } from '../pilot/publish-archive.mjs';
import { collectionPublications } from '../collection-server.mjs';
import { startPrototype } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(process.env.PRIVATE_TX_COLLECTION_SOURCE ?? resolve(ROOT, '.local/live-evidence/compact-final/source.json'));
const native = resolve(process.env.PRIVATE_TX_COLLECTION_NATIVE ?? resolve(ROOT, '../pir-browser/target/release/zecblock-pir-fixture'));
const helper = resolve(process.env.PRIVATE_TX_COLLECTION_ATTACK_HELPER ?? resolve(ROOT, '../pir-browser/target/release/examples/reply-attack-fixture'));
const output = resolve(process.env.PRIVATE_TX_COLLECTION_OUTPUT ?? resolve(ROOT, 'test-results', `collection-${new Date().toISOString().replaceAll(':', '-')}`));
const quietMs = Number(process.env.PRIVATE_TX_COLLECTION_QUIET_MS ?? 35_000);
assert.ok(Number.isInteger(quietMs) && quietMs >= 0 && quietMs <= 60_000);
const frozen = JSON.parse(await readFile(sourcePath, 'utf8'));
assert.equal(frozen.network, 'mainnet');
assert.ok(frozen.coverage.complete && frozen.coverage.blocks.length >= 2 && frozen.records.length >= 2);
await mkdir(output, { recursive: true });
const canonicalBlocks = new Map(frozen.coverage.blocks.map(block => [block.height, block.hash]));
const verifyCanonical = async manifest => {
  for (const block of manifest.coverage.blocks) assert.equal(block.hash, canonicalBlocks.get(block.height));
};
const withLocalFixtureLock = async (_directory, operation) => operation(); // One disposable, single-writer test process; no Linux flock on macOS.

function subset(blocks) {
  const startHeight = blocks[0].height, endHeight = blocks.at(-1).height;
  const records = frozen.records.filter(record => Number(record.detail.blockHeight) >= startHeight && Number(record.detail.blockHeight) <= endHeight);
  const coverage = { ...frozen.coverage, startHeight, endHeight, blocks, transactionCount: records.length,
    scope: 'Offline complete-block subset of retained real public-chain capture; no new source reads or current-chain availability claim.' };
  delete coverage.primaryFingerprint;
  return { ...frozen, coverage, records };
}
const split = Math.floor(frozen.coverage.blocks.length / 2);
const sources = [subset(frozen.coverage.blocks.slice(0, split)), subset(frozen.coverage.blocks.slice(split))];
const cleanDir = resolve(output, 'clean');
console.log('Preparing two immutable collection segments from frozen local mainnet records.');
const clean = await publishCollection({ localDir: cleanDir, binary: native, sources,
  withLock: withLocalFixtureLock, beforeActivate: verifyCanonical });
assert.equal(clean.collection.segments.length, 2);
assert.equal(clean.collection.coverage.complete, true);
assert.equal(clean.collection.coverage.transactionCount, frozen.records.length);
const totalQueries = clean.collection.segments.reduce((count, segment) => count + segment.manifest.chunkCount, 0);
assert.ok(totalQueries <= 64);
const expected = new Map(sources.flatMap(source => source.records.map(record => [record.txid, { record, source }])));
const targets = clean.collection.segments.map(segment => [...segment.manifest.catalogue].sort((a, b) => b.recordBytes - a.recordBytes)[0].txid);

async function poison(mode) {
  const first = clean.collection.segments[0];
  const attackDir = resolve(output, `attack-${mode}`);
  const result = spawnSync(helper, [resolve(cleanDir, 'segments', first.publicationId), attackDir, targets[0], mode === 'real' ? '0' : 'cover'], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, RAYON_NUM_THREADS: '2' } });
  assert.equal(result.status, 0, `Build the current offline reply-attack-fixture example first. ${result.error?.message ?? result.stderr ?? ''}`);
  const manifest = JSON.parse(await readFile(resolve(attackDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.publicationId, first.publicationId);
  assert.deepEqual(manifest.catalogue, first.manifest.catalogue);
  assert.notEqual(manifest.publicSha256, first.manifest.publicSha256);
  const directory = resolve(output, `poisoned-${mode}`);
  for (const entry of clean.collection.segments) {
    const destination = resolve(directory, 'segments', entry.publicationId);
    await mkdir(destination, { recursive: true });
    const from = entry.publicationId === first.publicationId ? attackDir : resolve(cleanDir, 'segments', entry.publicationId);
    for (const file of ['manifest.json', 'database.bin', 'public.bin']) await cp(resolve(from, file), resolve(destination, file));
    try { await cp(resolve(from, 'source.json'), resolve(destination, 'source.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; } // Finalized tables may prune redundant build inputs.
  }
  const retainedSegments = clean.collection.segments.map(segment => segment.publicationId === first.publicationId ? { ...segment, manifest } : segment);
  const published = await publishCollection({ localDir: directory, retainedSegments, withLock: withLocalFixtureLock, beforeActivate: verifyCanonical });
  return { name: `poisoned-${mode}`, localDir: directory, collection: published.collection,
    receipt: JSON.parse(await readFile(resolve(attackDir, 'attack-receipt.json'), 'utf8')) };
}
const variants = [{ name: 'clean', localDir: cleanDir, collection: clean.collection }, await poison('real'), await poison('cover')];

const cases = [], quietWindows = [], browserErrors = [];
let browser;
const shape = requests => requests.map(request => ({ path: request.path, method: request.method, publicationId: request.headers['x-pir-publication'] ?? null, bytes: request.body?.length ?? 0 }));
const publicIds = clean.collection.segments.flatMap(segment => Array(segment.manifest.chunkCount).fill(segment.publicationId));
const distribution = items => [...items.reduce((counts, id) => counts.set(id, (counts.get(id) ?? 0) + 1), new Map())].sort(([a], [b]) => a.localeCompare(b));

async function runVariant(variant) {
  let phase = 'initialize';
  const received = [], evaluations = [], requests = [], externals = [], consoleErrors = [];
  const publications = collectionPublications({ localDir: variant.localDir, binary: native, verifyCanonical });
  const get = publications.get;
  publications.get = id => {
    const publication = get(id);
    if (!publication) return publication;
    return { ...publication, evaluator: { evaluate: async query => {
      const observation = { phase, publicationId: id, queryBytes: query.length, replyBytes: null };
      evaluations.push(observation);
      const reply = await publication.evaluator.evaluate(query);
      observation.replyBytes = reply.length;
      return reply;
    } } };
  };
  const app = await startPrototype({ port: 0, publications, onRequest(request) { received.push({ ...request, phase }); } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, serviceWorkers: 'block' });
  let page;
  try {
    await context.addInitScript(() => {
      window.__collectionAudit = { outcome: null, events: [] };
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            window.__collectionAudit.events.push({ type: data.type, stage: data.stage, chunk: data.chunk, chunks: data.chunks });
            if (data.type === 'result' || data.type === 'error') window.__collectionAudit.outcome = data;
          });
        }
      };
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.origin !== app.url) { externals.push(url.origin); return route.abort('blockedbyclient'); }
      await route.continue();
    });
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol === 'data:') return;
      const item = { phase, path: url.pathname, method: request.method(), headers: request.headers(), body: request.postDataBuffer() };
      requests.push(item);
      assert.equal(url.origin, app.url); assert.equal(url.search, ''); assert.equal(url.hash, '');
      assert.equal(item.headers.cookie, undefined); assert.equal(item.headers.authorization, undefined);
      for (const entry of expected.keys()) {
        assert.ok(!request.url().includes(entry) && !JSON.stringify(item.headers).includes(entry));
        if (item.body) for (const bytes of [Buffer.from(entry), Buffer.from(entry, 'hex'), Buffer.from(entry, 'hex').reverse()]) assert.equal(item.body.indexOf(bytes), -1);
      }
    });
    page = await context.newPage();
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelector('[role="alert"]') || document.querySelector('#lookup-button') && !document.querySelector('#lookup-button').disabled, null, { timeout: 120_000 });
    assert.deepEqual(await page.locator('[role="alert"]').allTextContents(), []);
    assert.deepEqual(requests.filter(request => /\/public\.bin$/.test(request.path)).map(request => request.path), variant.collection.segments.map(segment => `/publication/${segment.publicationId}/public.bin`));
    const batches = [];
    async function lookup(targetIndex, repetition = false) {
      phase = `${targetIndex === 0 ? 'old' : 'new'}${repetition ? '-repeat' : ''}`;
      console.log(`Checking real collection: ${variant.name}/${phase}`);
      await page.evaluate(() => { window.__collectionAudit.outcome = null; window.__collectionAudit.events = []; });
      await page.locator('#txid').fill(targets[targetIndex]); await page.locator('#lookup-button').click();
      await page.waitForFunction(() => window.__collectionAudit.outcome !== null, null, { timeout: 120_000 });
      const observed = await page.evaluate(() => window.__collectionAudit);
      const batch = requests.filter(request => request.phase === phase);
      const queryCalls = batch.filter(request => request.path === '/pir/query');
      const receiverCalls = received.filter(request => request.phase === phase && request.path === '/pir/query');
      const nativeCalls = evaluations.filter(item => item.phase === phase);
      assert.equal(batch.length, totalQueries, 'No selected setup, metadata retry or ordinary fallback may follow a lookup.');
      assert.equal(queryCalls.length, totalQueries); assert.equal(receiverCalls.length, totalQueries); assert.equal(nativeCalls.length, totalQueries);
      assert.deepEqual(queryCalls.map(request => request.headers['x-pir-publication']), publicIds);
      assert.deepEqual(distribution(nativeCalls.map(item => item.publicationId)), distribution(publicIds));
      assert.ok(nativeCalls.every(item => item.queryBytes === 20_992 && item.replyBytes === 10_240));
      assert.ok(queryCalls.every(request => request.method === 'POST' && request.headers['content-type'] === 'application/octet-stream' && request.body?.length === 20_992));
      assert.ok(observed.events.some(event => event.type === 'stage' && event.stage === 'decode'), 'Poison must reach real content decoding, not merely fail transport.');
      const reject = variant.name === 'poisoned-real' ? targetIndex === 0 : variant.name === 'poisoned-cover' && targetIndex === 1;
      assert.equal(observed.outcome.type, reject ? 'error' : 'result');
      if (!reject) {
        const result = observed.outcome.result, oracle = expected.get(targets[targetIndex]);
        assert.equal(result.txid, oracle.record.txid); assert.equal(result.found, true);
        for (const field of ['detail', 'raw', 'price', 'source']) assert.deepEqual(result[field], oracle.record[field]);
        assert.deepEqual(result.snapshot, oracle.source.snapshot); assert.deepEqual(result.coverage, oracle.source.coverage);
        assert.equal(result.publicationId, variant.collection.segments[targetIndex].publicationId);
        assert.equal(observed.outcome.measurements.collectionId, variant.collection.collectionId);
        assert.equal(observed.outcome.measurements.queryBytes, totalQueries * 20_992);
        assert.equal(observed.outcome.measurements.responseBytes, totalQueries * 10_240);
        await page.locator('#result-section').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#result-txid').textContent(), result.txid);
      } else {
        assert.equal(await page.locator('#result-section').count(), 0);
        await page.locator('#lookup-error').waitFor({ state: 'visible' });
      }
      assert.equal(page.url(), `${app.url}/`);
      const count = requests.length; await page.waitForTimeout(250); assert.equal(requests.length, count);
      if (variant.name === 'poisoned-cover' && reject && quietMs > 0) {
        const beforeBrowser = requests.length, beforeReceiver = received.length;
        await page.waitForTimeout(quietMs);
        assert.equal(requests.length, beforeBrowser); assert.equal(received.length, beforeReceiver);
        quietWindows.push({ milliseconds: quietMs, browserRequests: 0, receiverRequests: 0 });
      }
      batches.push(queryCalls);
      cases.push({ variant: variant.name, selector: phase, targetTxid: targets[targetIndex], outcome: observed.outcome.type,
        error: reject ? observed.outcome.message : null, requestShape: shape(batch), receiverRequests: receiverCalls.length,
        nativeQueries: nativeCalls, events: observed.events });
    }
    await lookup(0); await lookup(1);
    if (variant.name === 'clean') {
      await lookup(0, true);
      for (let index = 0; index < totalQueries; index++) assert.notDeepEqual(batches[0][index].body, batches[2][index].body, 'Every repeated real/cover selector must use fresh query randomness.');
    }
    assert.deepEqual(externals, []); assert.deepEqual(consoleErrors, []);
    assert.equal(await page.locator('a[href]').count(), 0);
  } catch (error) {
    await writeFile(resolve(output, `${variant.name}-failure.json`), `${JSON.stringify({ error: error.message, phase,
      alerts: page ? await page.locator('[role="alert"]').allTextContents() : [], status: page ? await page.locator('#lookup-status').allTextContents() : [],
      requestShape: shape(requests), evaluations, consoleErrors, externals }, null, 2)}\n`);
    throw error;
  } finally { await context.close(); await app.close(); }
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 30_000 });
  for (const variant of variants) await runVariant(variant);
  for (const result of cases) assert.deepEqual(result.requestShape, cases[0].requestShape, 'Every target, real corruption and cover corruption has one observable fixed collection schedule.');
  assert.equal(new Set(cases.filter(item => item.outcome === 'error').map(item => item.error)).size, 1);
  assert.deepEqual(browserErrors, []);
  const report = { status: 'passed', completedAt: new Date().toISOString(), sourcePath,
    collection: { collectionId: clean.collection.collectionId, records: frozen.records.length, coverage: clean.collection.coverage, segments: clean.collection.segments.map(segment => ({ publicationId: segment.publicationId, records: segment.manifest.catalogue.length, chunks: segment.manifest.chunkCount })) },
    fixedQueries: totalQueries, cases, quietWindows,
    checks: ['real upstream native evaluator and WASM', 'old/new full-record parity', 'cover-only queries to every unselected segment', 'fresh randomness for all repeated query slots', 'actual selected-row and shared-cover database poisoning with rebuilt setup', 'fixed routes/publication IDs/count/byte sizes independent of target and content', 'receiver/evaluator observed complete request budget', 'all setup downloads generic before lookup', 'no external traffic, selector in requests, ordinary fallback, retry or automatic refresh'],
    limits: 'Two explicit immutable segments from frozen captured public records. This is bounded collection retrieval, not full-history routing, production capacity, current-chain verification, constant-time execution, IP anonymity or a general cryptographic audit. VM tests independently enforce prepare-all/settle-all before decoding and 120-second quiet. The local fixture bypasses the Linux writer-lock utility under one single-writer process.' };
  await writeFile(resolve(output, 'collection-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, fixedQueries: totalQueries, cases: cases.length, output }, null, 2));
} finally { await browser?.close(); }
