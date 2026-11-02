import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomFillSync } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import vm from 'node:vm';

// Exercise the actual worker's collection scheduling. Cryptographic primitives
// are mocked here; real native/WASM tests qualify cover decryption separately.
const worker = await readFile(new URL('../web/worker.js', import.meta.url), 'utf8');
const IMPORT = /import\(['"]\/wasm\/zecblock_pir_browser\.js['"]\)/g;
assert.equal([...worker.matchAll(IMPORT)].length, 1);
const source = worker.replace(IMPORT, '__loadTestPirModule()');
const ID = number => number.toString(16).padStart(64, '0');
const REQUEST_BYTES = 20_992, RESPONSE_BYTES = 10_240, SETUP_BYTES = 45_056;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function bind(collection) {
  const { schema, network, snapshot, coverage, segments } = collection;
  collection.collectionId = createHash('sha256').update(canonical({ schema, network, snapshot, coverage, segments })).digest('hex');
  return collection;
}
function collectionFor(chunks = [2, 3, 1]) {
  const snapshot = { height: Math.max(102, 99 + chunks.length), hash: ID(999), publishedAt: '2026-11-02T12:00:00.000Z' };
  const blocks = chunks.map((_, index) => ({ height: 100 + index, hash: ID(500 + index), transactionCount: 1 }));
  return bind({
    schema: 'zecblock-private-tx-collection-v1', network: 'mainnet', snapshot,
    coverage: { startHeight: 100, endHeight: 99 + chunks.length, transactionCount: chunks.length, blocks, complete: true, ranges: chunks.map((_, index) => ({ startHeight: 100 + index, endHeight: 100 + index, transactionCount: 1 })) },
    segments: chunks.map((chunkCount, index) => ({
      publicationId: ID(index + 100), manifest: {
        schema: 'zecblock-private-tx-full-v1', network: 'mainnet', publicationId: ID(index + 100),
        packing: 'compact-v1', coverRow: 2047, chunkCount, snapshot,
        geometry: 'full-2k-8k', rows: 2048, rowBytes: 8192,
        coverage: { startHeight: 100 + index, endHeight: 100 + index, blocks: [{ ...blocks[index] }] },
        catalogue: [{ txid: ID(index + 1), height: 100 + index }],
        scheme: { request_bytes: REQUEST_BYTES, response_bytes: RESPONSE_BYTES, public_bytes: SETUP_BYTES },
      },
    })),
  });
}

class Clock {
  now = 0; sequence = 0; timers = new Map();
  setTimeout = (callback, delay = 0) => { const id = ++this.sequence; this.timers.set(id, { at: this.now + delay, callback }); return id; };
  clearTimeout = id => this.timers.delete(id);
  setInterval = (callback, delay) => { const id = ++this.sequence; this.timers.set(id, { at: this.now + delay, callback, interval: delay }); return id; };
  clearInterval = this.clearTimeout;
  tick() {
    const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) return false;
    const [id, timer] = next; this.now = timer.at; this.timers.delete(id);
    if (timer.interval) this.timers.set(id, { ...timer, at: this.now + timer.interval });
    timer.callback(); return true;
  }
  async settle(promise) {
    let done = false, failure;
    promise.then(() => { done = true; }, error => { done = true; failure = error; });
    for (let step = 0; !done && step < 1000; step++) {
      await yieldTurn();
      if (!done && !this.tick()) throw new Error('Worker has no bounded completion path.');
    }
    assert.ok(done);
    if (failure) throw failure;
  }
  async advanceTo(target) {
    for (let step = 0; step < 1000; step++) {
      await yieldTurn();
      if (Math.min(...[...this.timers.values()].map(timer => timer.at)) > target) { this.now = target; return; }
      if (!this.tick()) { this.now = target; return; }
    }
    throw new Error('Unexpected automatic network cadence.');
  }
}

async function harness({ collection = collectionFor(), fault, faultIndex = 0, setupFailureIndex = -1, constructorFailureIndex = -1, missingCoverIndex = -1, spuriousCoverResult = false } = {}) {
  const clock = new Clock(), requests = [], messages = [], generated = [], decodes = [], slots = [], clients = [], budgets = [];
  let listener;
  const total = collection.segments.reduce((count, segment) => count + segment.manifest.chunkCount, 0);
  const TestAbortSignal = { timeout(ms) {
    budgets.push(ms); const controller = new AbortController();
    clock.setTimeout(() => controller.abort(new DOMException('Deadline', 'TimeoutError')), ms);
    return controller.signal;
  } };
  class Client {
    constructor(json) {
      this.manifest = JSON.parse(json); this.index = clients.length; this.cancelled = 0; this.freed = 0;
      if (this.index === constructorFailureIndex) throw new Error('Invalid setup primitive.');
      clients.push(this);
      if (this.index === missingCoverIndex) this.begin_cover_query = undefined;
    }
    begin_query(txid) { assert.ok(this.manifest.catalogue.some(record => record.txid === txid)); this.selected = txid; this.ordinal = 0; this.cover = false; return this.manifest.chunkCount; }
    begin_cover_query() { this.ordinal = 0; this.cover = true; return this.manifest.chunkCount; }
    make_chunk_query(index) {
      assert.equal(slots.length, 0, 'Prepare every segment secret before any HTTP query.');
      generated.push({ client: this.index, index });
      return randomFillSync(new Uint8Array(REQUEST_BYTES));
    }
    decode_chunk_response(answer) {
      assert.equal(slots.length, total);
      assert.ok(slots.every(slot => slot.done), 'No collection content may decode before all segments settle.');
      decodes.push({ client: this.index, cover: this.cover, ordinal: this.ordinal });
      if (answer[0] === 255) throw new Error('Bad real or cover plaintext.');
      this.ordinal++;
      if (this.ordinal !== this.manifest.chunkCount) return undefined;
      if (this.cover && !spuriousCoverResult) return undefined;
      return JSON.stringify({ found: true, publicationId: this.manifest.publicationId, txid: this.selected ?? ID(1), detail: {}, raw: {} });
    }
    cancel_query() { this.cancelled++; }
    free() { this.freed++; }
  }
  const fetch = (path, options = {}) => {
    requests.push({ path, method: options.method ?? 'GET', publicationId: options.headers?.['X-PIR-Publication'], body: options.body, at: clock.now });
    if (path === '/publication/manifest.json') return Promise.resolve(new Response(JSON.stringify(collection)));
    if (path === '/publication/status.json') return Promise.resolve(new Response('{"state":"ready"}'));
    const setup = collection.segments.findIndex(segment => path === `/publication/${segment.publicationId}/public.bin`);
    if (setup !== -1) return Promise.resolve(new Response(new Uint8Array(setup === setupFailureIndex ? SETUP_BYTES - 1 : SETUP_BYTES)));
    assert.equal(path, '/pir/query', 'No selected-segment metadata request or fallback is allowed.');
    assert.equal(generated.length, total);
    const index = slots.length, affected = index === faultIndex;
    const slot = { done: false, cancelled: false, signal: options.signal, bytesRead: 0 }; slots.push(slot);
    if (affected && fault === 'fetch') { slot.done = true; return Promise.reject(new TypeError('Unavailable')); }
    if (affected && fault === 'timeout') return new Promise((_, reject) => {
      const fail = () => { slot.done = true; reject(slot.signal.reason); };
      if (slot.signal.aborted) fail(); else slot.signal.addEventListener('abort', fail, { once: true });
    });
    const size = affected && fault === 'short' ? RESPONSE_BYTES - 1 : affected && fault === 'oversize' ? RESPONSE_BYTES + 1 : RESPONSE_BYTES;
    const bytes = new Uint8Array(size); if (affected && fault === 'corrupt') bytes[0] = 255;
    let offset = 0;
    const finish = () => { slot.done = true; };
    return Promise.resolve({
      ok: !(affected && fault === '503'), headers: new Headers({ 'Content-Type': affected && fault === 'type' ? 'text/html' : 'application/octet-stream' }),
      body: {
        async cancel() { slot.cancelled = true; finish(); },
        getReader() { return {
          async read() {
            if (offset === bytes.length) { finish(); return { done: true }; }
            const value = bytes.slice(offset, offset + 1024); offset += value.length; slot.bytesRead += value.length;
            return { done: false, value };
          },
          async cancel() { slot.cancelled = true; finish(); }, releaseLock() {},
        }; },
      },
    });
  };
  const context = vm.createContext({
    Uint8Array, TextDecoder, TextEncoder, Headers, Response, ReadableStream, AbortController, DOMException, Date, WebAssembly,
    crypto: { subtle: { digest: async (algorithm, bytes) => {
      assert.equal(algorithm, 'SHA-256');
      return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
    } } }, fetch, AbortSignal: TestAbortSignal, performance: { now: () => clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    postMessage(message) { messages.push({ ...message, dispatched: slots.length, settled: slots.filter(slot => slot.done).length }); },
    self: { addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; } },
    __loadTestPirModule: async () => ({ default: async () => {}, FullPirBrowser: Client }),
  });
  vm.runInContext(source, context);
  await clock.settle(listener({ data: { type: 'initialize' } }));
  const initialRequests = requests.length, initialMessages = messages.length, initialBudgets = budgets.length;
  return {
    clock, requests, messages, generated, decodes, slots, clients, budgets, collection, context, initialRequests, initialMessages, initialBudgets, total,
    async lookup(txid = ID(1)) { await clock.settle(listener({ data: { type: 'lookup', requestId: 7, txid } })); },
    trace() { return requests.slice(initialRequests).map(request => ({ path: request.path, method: request.method, publicationId: request.publicationId, bytes: request.body?.length, at: request.at })); },
  };
}

function fixedTrace(run) {
  const expected = run.collection.segments.flatMap(segment => Array(segment.manifest.chunkCount).fill(segment.publicationId));
  const requests = run.requests.slice(run.initialRequests);
  assert.equal(requests.length, run.total);
  assert.deepEqual(requests.map(request => request.publicationId), expected);
  assert.ok(requests.every(request => request.path === '/pir/query' && request.method === 'POST' && request.body.length === REQUEST_BYTES));
  assert.equal(new Set(requests.map(request => request.at)).size, 1);
  assert.ok(run.clients.every(client => client.cancelled === 1));
  for (const outcome of run.messages.slice(run.initialMessages).filter(message => ['result', 'error'].includes(message.type))) {
    assert.equal(outcome.dispatched, run.total); assert.equal(outcome.settled, run.total);
  }
  for (const request of requests) for (const record of run.collection.segments.flatMap(segment => segment.manifest.catalogue)) {
    assert.equal(request.body.indexOf(Buffer.from(record.txid)), -1);
    assert.equal(request.body.indexOf(Buffer.from(record.txid, 'hex')), -1);
    assert.ok(!request.path.includes(record.txid) && request.publicationId !== record.txid);
  }
}

test('canonical collection identity uses recursively sorted keys and preserved arrays', async () => {
  const run = await harness();
  const encoded = vm.runInContext('canonicalJson({z:[3,{b:2,a:1}],a:"line\\nquote\\\""})', run.context);
  assert.equal(encoded, '{"a":"line\\nquote\\\"","z":[3,{"a":1,"b":2}]}');
  assert.equal(createHash('sha256').update(encoded).digest('hex'), 'ae4fcf35e02fe4f116caf44867ed981452902c21742b39a062e827ee80a1d3c3');
  assert.throws(() => vm.runInContext('canonicalJson({bad:Infinity})', run.context));
  assert.equal(run.messages.find(message => message.type === 'ready')?.manifest.publicationId, run.collection.collectionId);
  assert.deepEqual(run.requests.map(request => request.path), ['/publication/manifest.json', '/publication/status.json', ...run.collection.segments.map(segment => `/publication/${segment.publicationId}/public.bin`)]);
  assert.equal(run.messages.find(message => message.type === 'ready').catalogue.length, 3);
});

test('selecting any segment produces the same complete fixed collection request schedule', async () => {
  let reference;
  for (const target of [1, 2, 3]) {
    const run = await harness(); await run.lookup(ID(target)); fixedTrace(run);
    const trace = run.trace(); reference ??= trace; assert.deepEqual(trace, reference);
    assert.equal(run.generated.length, 6); assert.equal(run.decodes.length, 6);
    assert.deepEqual(run.clients.map(client => client.cover), [target !== 1, target !== 2, target !== 3]);
    const results = run.messages.filter(message => message.type === 'result'); assert.equal(results.length, 1);
    assert.equal(results[0].result.publicationId, ID(99 + target));
    assert.equal(results[0].measurements.collectionId, run.collection.collectionId);
    assert.equal(results[0].measurements.publicationId, run.collection.collectionId);
    assert.equal(results[0].measurements.queryBytes, 6 * REQUEST_BYTES);
    assert.equal(results[0].measurements.responseBytes, 6 * RESPONSE_BYTES);
  }
});

test('real or cover corruption in first, middle and last slots cannot shorten the collection schedule', async () => {
  const clean = await harness(); await clean.lookup();
  for (const target of [1, 2, 3]) for (const faultIndex of [0, 2, 5]) {
    const run = await harness({ fault: 'corrupt', faultIndex }); await run.lookup(ID(target)); fixedTrace(run);
    assert.deepEqual(run.trace(), clean.trace());
    assert.equal(run.messages.filter(message => message.type === 'result').length, 0);
    assert.equal(run.messages.filter(message => message.type === 'error').length, 1);
  }
});

test('transport failures settle every segment with one bounded deadline and no content decode', async () => {
  const clean = await harness(); await clean.lookup();
  for (const fault of ['short', 'oversize', '503', 'type', 'fetch', 'timeout']) for (const faultIndex of [0, 2, 5]) {
    const run = await harness({ fault, faultIndex }); await run.lookup(ID(2)); fixedTrace(run);
    assert.deepEqual(run.trace(), clean.trace()); assert.equal(run.decodes.length, 0);
    assert.deepEqual(run.budgets.slice(run.initialBudgets), [30_000]);
    if (fault === 'oversize') assert.equal(run.slots[faultIndex].cancelled, true);
  }
});

test('success and corrupt content have no automatic collection refresh, retry or follow-up', async () => {
  for (const fault of [undefined, 'corrupt', '503', 'timeout']) {
    const run = await harness({ fault }); await run.lookup(); fixedTrace(run);
    const count = run.requests.length;
    await run.clock.advanceTo(120_000); assert.equal(run.requests.length, count);
  }
});

test('unknown local identifier makes no network request or crypto selection', async () => {
  const run = await harness(); await run.lookup(ID(777));
  assert.equal(run.requests.length, run.initialRequests); assert.equal(run.generated.length, 0);
  assert.equal(run.messages.at(-1).type, 'error');
});

test('failed collection initialization frees every constructed primitive', async () => {
  for (const options of [{ setupFailureIndex: 2 }, { constructorFailureIndex: 2 }, { missingCoverIndex: 1 }]) {
    const run = await harness(options);
    assert.ok(run.clients.length > 0 && run.clients.every(client => client.freed === 1));
    assert.ok(!run.messages.some(message => message.type === 'ready'));
    assert.equal(run.messages.at(-1).type, 'error');
  }
});

test('a cover primitive returning a selected record is rejected after the complete batch', async () => {
  const run = await harness({ spuriousCoverResult: true }); await run.lookup(); fixedTrace(run);
  assert.equal(run.messages.filter(message => message.type === 'result').length, 0);
  assert.equal(run.messages.at(-1).type, 'error');
});

test('collection caps, duplicate selectors, legacy cover and identity tampering fail before setups', async () => {
  const invalid = [];
  for (const mutate of [
    value => { value.snapshot.height++; },
    value => { value.extra = true; bind(value); },
    value => { value.segments[1] = structuredClone(value.segments[0]); bind(value); },
    value => { value.segments[1].manifest.catalogue[0].txid = ID(1); bind(value); },
    value => { delete value.segments[1].manifest.packing; bind(value); },
    value => { value.segments[1].manifest.coverRow = 2046; bind(value); },
    value => { value.segments[0].manifest.chunkCount = 64; bind(value); },
    value => { value.coverage.complete = false; bind(value); },
    value => { value.coverage.transactionCount++; bind(value); },
    value => { value.coverage.blocks[0].hash = ID(777); bind(value); },
    value => { value.coverage.ranges.reverse(); bind(value); },
    value => { value.segments.reverse(); bind(value); },
  ]) { const value = collectionFor(); mutate(value); invalid.push(value); }
  invalid.push(collectionFor(Array(9).fill(1)));
  for (const collection of invalid) {
    const run = await harness({ collection });
    assert.ok(!run.messages.some(message => message.type === 'ready'));
    assert.deepEqual(run.requests.map(request => request.path), ['/publication/manifest.json']);
    assert.equal(run.clients.length, 0);
  }
  const accepted = await harness({ collection: collectionFor([31, 33]) });
  await accepted.lookup(); fixedTrace(accepted); assert.equal(accepted.generated.length, 64);
});
