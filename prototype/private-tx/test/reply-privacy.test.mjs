import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomFillSync, webcrypto } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import vm from 'node:vm';

// This executes the real worker transport with a mocked cryptographic client.
// It tests control flow and observable HTTP shape, not PIR cryptographic safety.
// The separate reply-privacy-browser test uses real native/WASM poisoned rows.
const workerSource = await readFile(process.env.PRIVATE_TX_REPLY_WORKER_SOURCE ?? new URL('../web/worker.js', import.meta.url), 'utf8');
const IMPORT = /import\(['"]\/wasm\/zecblock_pir_browser\.js['"]\)/g;
assert.equal([...workerSource.matchAll(IMPORT)].length, 1, 'Update the harness if the single WASM import boundary changes.');
const source = workerSource.replace(IMPORT, '__loadTestPirModule()');
const IDS = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
const PUBLICATION = 'd'.repeat(64);
const REQUEST_BYTES = 20_992;
const RESPONSE_BYTES = 10_240;
const READ_SEGMENT = 1024;

class Clock {
  now = 0;
  sequence = 0;
  timers = new Map();
  intervals = [];
  setTimeout = (callback, delay = 0, ...args) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + Math.max(0, Number(delay)), callback: () => callback(...args) });
    return id;
  };
  clearTimeout = id => { this.timers.delete(id); };
  setInterval = (callback, delay) => {
    this.intervals.push(delay);
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + delay, callback, interval: delay });
    return id;
  };
  clearInterval = id => { this.timers.delete(id); };
  tick() {
    const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) return false;
    const [id, timer] = next;
    this.now = timer.at;
    this.timers.delete(id);
    if (timer.interval) this.timers.set(id, { ...timer, at: this.now + timer.interval });
    timer.callback();
    return true;
  }
  async settle(promise) {
    let settled = false, value, failure;
    promise.then(result => { settled = true; value = result; }, error => { settled = true; failure = error; });
    for (let steps = 0; !settled && steps < 1000; steps++) {
      await yieldTurn(); // Flush all response-reader microtasks before advancing time.
      if (!settled && !this.tick()) throw new Error('Worker is waiting without a deadline.');
    }
    assert.ok(settled, 'Worker must finish within a bounded number of timer steps.');
    if (failure) throw failure;
    return value;
  }
  async advanceTo(target) {
    for (let steps = 0; steps < 1000; steps++) {
      await yieldTurn();
      const next = Math.min(...[...this.timers.values()].map(timer => timer.at));
      if (next > target) { this.now = target; return; }
      if (!this.tick()) { this.now = target; return; }
    }
    throw new Error('Unexpected automatic request/timer loop.');
  }
}

async function harness({ chunks = 5, fault = null, faultIndex = 0, selectiveTarget = null } = {}) {
  const clock = new Clock();
  const requests = [], messages = [], generated = [], decodes = [], slots = [], timeoutBudgets = [];
  let listener, selected, decodeOrdinal = 0, cancellations = 0;
  const manifest = {
    schema: 'zecblock-private-tx-full-v1', publicationId: PUBLICATION,
    network: 'mainnet', geometry: 'full-2k-8k', rows: 2048, rowBytes: 8192,
    chunkCount: chunks, scheme: { request_bytes: REQUEST_BYTES, response_bytes: RESPONSE_BYTES },
    snapshot: { height: 123, hash: 'e'.repeat(64), publishedAt: new Date().toISOString() },
    catalogue: IDS.map(txid => ({ txid })),
  };
  const client = {
    begin_query(txid) { selected = txid; decodeOrdinal = 0; return chunks; },
    make_chunk_query(index) {
      assert.equal(requests.filter(request => request.path === '/pir/query').length, 0, 'Every secret/query must be prepared before any HTTP dispatch.');
      assert.equal(index, generated.length);
      generated.push({ index, at: clock.now });
      return randomFillSync(new Uint8Array(REQUEST_BYTES));
    },
    decode_chunk_response(answer) {
      assert.equal(slots.length, chunks, 'All requests must exist before content-dependent decoding.');
      assert.ok(slots.every(slot => slot.done), 'Every response slot must settle before content-dependent decoding.');
      decodes.push({ index: decodeOrdinal, at: clock.now });
      if (answer[0] === 0xff && (!selectiveTarget || selected === selectiveTarget)) throw new Error('Corrupted selected record.');
      decodeOrdinal++;
      return decodeOrdinal === chunks ? JSON.stringify({ found: true, publicationId: PUBLICATION, txid: selected, detail: { txid: selected }, raw: { hex: '00', decoded: {} } }) : undefined;
    },
    cancel_query() { cancellations++; },
    free() {},
  };
  const TestAbortSignal = {
    timeout(ms) {
      timeoutBudgets.push(ms);
      const controller = new AbortController();
      clock.setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), ms);
      return controller.signal;
    },
  };

  function binaryResponse(slot, bytes, { status = 200, type = 'application/octet-stream', bodyTimeout = false } = {}) {
    let offset = 0;
    const finish = () => { slot.done = true; slot.finishedAt = clock.now; };
    return {
      status, ok: status >= 200 && status < 300,
      headers: new Headers({ 'Content-Type': type }),
      body: {
        cancel() { slot.cancelled = true; finish(); return Promise.resolve(); },
        getReader() {
          return {
            async read() {
              slot.reads++;
              if (bodyTimeout) return new Promise((_, reject) => {
                const fail = () => { finish(); reject(slot.signal.reason); };
                if (slot.signal.aborted) fail(); else slot.signal.addEventListener('abort', fail, { once: true });
              });
              if (offset === bytes.length) { finish(); return { done: true }; }
              const value = bytes.slice(offset, offset + READ_SEGMENT);
              offset += value.length; slot.bytesRead += value.length;
              return { done: false, value };
            },
            async cancel() { slot.cancelled = true; finish(); },
            releaseLock() {},
          };
        },
      },
    };
  }

  const fetch = (path, options = {}) => {
    requests.push({ path, method: options.method ?? 'GET', publication: options.headers?.['X-PIR-Publication'] ?? null, bodyBytes: options.body?.length ?? 0, at: clock.now });
    if (path === '/publication/manifest.json') return Promise.resolve(new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
    if (path === '/publication/status.json') return Promise.resolve(new Response('{"state":"ready"}', { headers: { 'Content-Type': 'application/json' } }));
    if (path === `/publication/${PUBLICATION}/public.bin`) return Promise.resolve(new Response(new Uint8Array([1])));
    assert.equal(path, '/pir/query', 'No fallback, selected lookup or other request is allowed.');
    assert.equal(generated.length, chunks, 'All queries must be prepared before the first fetch.');
    const index = slots.length;
    const slot = { index, signal: options.signal, done: false, cancelled: false, bytesRead: 0, reads: 0 };
    slots.push(slot);
    const affected = index === faultIndex;
    if (affected && fault === 'fetch-throw') { slot.done = true; return Promise.reject(new TypeError('Network unavailable.')); }
    if (affected && fault === 'timeout') return new Promise((_, reject) => {
      const fail = () => { slot.done = true; slot.finishedAt = clock.now; reject(slot.signal.reason); };
      if (slot.signal.aborted) fail(); else slot.signal.addEventListener('abort', fail, { once: true });
    });
    const length = affected && fault === 'short' ? RESPONSE_BYTES - 1 : affected && fault === 'oversize' ? RESPONSE_BYTES + 3 * READ_SEGMENT : RESPONSE_BYTES;
    const bytes = new Uint8Array(length).fill(index + 1);
    if (affected && fault === 'corrupt') bytes[0] = 0xff;
    return Promise.resolve(binaryResponse(slot, bytes, {
      status: affected && fault === '503' ? 503 : 200,
      type: affected && fault === 'wrong-type' ? 'text/html' : 'application/octet-stream',
      bodyTimeout: affected && fault === 'body-timeout',
    }));
  };
  const context = vm.createContext({
    Uint8Array, TextDecoder, Headers, Response, ReadableStream, AbortController, DOMException,
    crypto: webcrypto, WebAssembly, fetch,
    AbortSignal: TestAbortSignal,
    performance: { now: () => clock.now },
    Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    postMessage(message) { messages.push({ ...message, observedAt: clock.now, dispatchedQueries: slots.length, settledSlots: slots.filter(slot => slot.done).length }); },
    self: { addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; } },
    __loadTestPirModule: async () => ({ default: async () => {}, FullPirBrowser: class { constructor() { return client; } } }),
  });
  vm.runInContext(source, context, { filename: 'private-worker-under-test.js' });
  await clock.settle(listener({ data: { type: 'initialize' } }));
  assert.ok(messages.some(message => message.type === 'ready'), 'Mocked primitive must initialize through the real worker.');
  const initialRequests = requests.length;
  const initialMessages = messages.length;
  const initialTimeouts = timeoutBudgets.length;
  return {
    clock, requests, messages, generated, decodes, slots, timeoutBudgets,
    initialRequests, initialMessages, initialTimeouts,
    get cancellations() { return cancellations; },
    async lookup(txid = IDS[0]) { await clock.settle(listener({ data: { type: 'lookup', requestId: 1, txid } })); },
    queryTrace() { return requests.slice(initialRequests).map(request => ({ ...request, relativeAt: request.at - requests[initialRequests].at })); },
  };
}

function assertFixedTrace(run, chunks) {
  const requests = run.requests.slice(run.initialRequests);
  assert.equal(requests.length, chunks, 'No response-dependent retry, metadata refresh or source fallback.');
  assert.deepEqual(requests.map(request => request.path), Array(chunks).fill('/pir/query'));
  assert.deepEqual(requests.map(request => request.method), Array(chunks).fill('POST'));
  assert.deepEqual(requests.map(request => request.publication), Array(chunks).fill(PUBLICATION));
  assert.deepEqual(requests.map(request => request.bodyBytes), Array(chunks).fill(REQUEST_BYTES));
  assert.equal(new Set(requests.map(request => request.at)).size, 1, 'All logical fetches are dispatched before responses can gate later requests.');
  for (const message of run.messages.slice(run.initialMessages).filter(message => message.type === 'result' || message.type === 'error')) {
    assert.equal(message.dispatchedQueries, chunks, 'No early observable outcome before full dispatch.');
    assert.equal(message.settledSlots, chunks, 'No result/rejection before the entire response batch settles.');
  }
  assert.equal(run.cancellations, 1);
}

test('all padded queries are prepared and dispatched before any successful decode', async () => {
  for (const chunks of [3, 5, 64]) {
    const run = await harness({ chunks });
    await run.lookup();
    assertFixedTrace(run, chunks);
    assert.equal(run.generated.length, chunks);
    assert.equal(run.decodes.length, chunks);
    assert.equal(run.messages.filter(message => message.type === 'result').length, 1);
    assert.equal(run.messages.filter(message => message.type === 'error').length, 0);
  }
});

test('first, middle and last content corruption cannot truncate or change the request trace', async () => {
  const clean = await harness(); await clean.lookup();
  const trace = clean.queryTrace();
  for (const txid of IDS) for (const index of [0, 2, 4]) {
    const run = await harness({ fault: 'corrupt', faultIndex: index });
    await run.lookup(txid);
    assertFixedTrace(run, 5);
    assert.deepEqual(run.queryTrace(), trace);
    assert.ok(run.decodes.length > 0);
    assert.equal(run.messages.filter(message => message.type === 'result').length, 0);
    assert.equal(run.messages.filter(message => message.type === 'error').length, 1);
  }
});

test('selective content failure has the same network shape for affected and unaffected records', async () => {
  for (const index of [0, 2, 4]) {
    const affected = await harness({ fault: 'corrupt', faultIndex: index, selectiveTarget: IDS[0] });
    const unaffected = await harness({ fault: 'corrupt', faultIndex: index, selectiveTarget: IDS[0] });
    await affected.lookup(IDS[0]); await unaffected.lookup(IDS[1]);
    assertFixedTrace(affected, 5); assertFixedTrace(unaffected, 5);
    assert.deepEqual(affected.queryTrace(), unaffected.queryTrace());
    assert.equal(affected.messages.filter(message => message.type === 'error').length, 1);
    assert.equal(unaffected.messages.filter(message => message.type === 'result').length, 1);
  }
});

test('wrong sizes, types and HTTP/network failures still settle the entire bounded batch', async () => {
  const clean = await harness(); await clean.lookup();
  for (const fault of ['short', 'oversize', 'wrong-type', '503', 'fetch-throw', 'timeout', 'body-timeout']) {
    for (const index of [0, 2, 4]) {
      const run = await harness({ fault, faultIndex: index });
      await run.lookup(IDS[index % IDS.length]);
      assertFixedTrace(run, 5);
      assert.deepEqual(run.queryTrace(), clean.queryTrace(), `${fault} at ${index}`);
      assert.equal(run.decodes.length, 0, 'Transport-invalid response batches must not enter the content decoder.');
      assert.equal(run.messages.filter(message => message.type === 'result').length, 0);
      assert.equal(run.messages.filter(message => message.type === 'error').length, 1);
      assert.ok(run.slots.every(slot => slot.done));
      assert.ok(run.slots[index].bytesRead <= RESPONSE_BYTES + READ_SEGMENT, 'An oversized stream must be cut off at the exact reply budget plus its final stream segment.');
      if (fault === 'oversize') assert.equal(run.slots[index].cancelled, true);
      const deadlines = run.timeoutBudgets.slice(run.initialTimeouts);
      assert.deepEqual(deadlines, [30_000], 'Use one bounded deadline for the whole batch, not N attacker-amplified timeouts.');
      if (fault === 'timeout' || fault === 'body-timeout') assert.equal(run.clock.now, 30_000);
    }
  }
});

test('success and rejection have no automatic response-dependent follow-up or refresh', async () => {
  for (const fault of [null, 'corrupt', 'short', '503', 'timeout']) {
    const run = await harness({ fault });
    await run.lookup();
    const count = run.requests.length;
    const outcomes = run.messages.filter(message => message.type === 'result' || message.type === 'error').length;
    await run.clock.advanceTo(120_000);
    assert.equal(run.requests.length, count, 'No metadata cadence or automatic retry may reveal decode completion.');
    assert.equal(run.messages.filter(message => message.type === 'result' || message.type === 'error').length, outcomes);
  }
});
