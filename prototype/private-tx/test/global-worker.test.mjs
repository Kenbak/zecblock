import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import vm from 'node:vm';

// Execute the real worker after replacing only its WASM import boundary.
// The primitive is mocked: these tests verify transport/control flow, while
// native/WASM acceptance separately checks encryption and row authentication.
const worker = await readFile(new URL('../web/global-worker.js', import.meta.url), 'utf8');
const IMPORT = /^import init, \{ GlobalPirBrowser \} from ['"]\/wasm\/zecblock_pir_browser\.js['"];$/gm;
assert.equal([...worker.matchAll(IMPORT)].length, 1, 'Update the harness if the WASM import boundary changes.');
const source = worker.replace(IMPORT, 'const { init, GlobalPirBrowser } = __testPirModule;');
const REQUEST_BYTES = 20_992, LAYER_REPLY_BYTES = 81_920, PUBLIC_BYTES = 360_448;
const READ_BYTES = 8192;
const PUBLICATION = 'd'.repeat(64);
const IDS = [1, 2, 3].map(index => createHash('sha256').update(`global-worker-private-selection-${index}`).digest('hex'));

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
  clearTimeout = id => this.timers.delete(id);
  setInterval = (callback, delay) => {
    this.intervals.push(delay);
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + delay, callback, interval: delay });
    return id;
  };
  clearInterval = this.clearTimeout;
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
  async until(predicate) {
    for (let step = 0; step < 1000; step++) {
      await yieldTurn(); // Drain stream/worker microtasks before advancing time.
      if (predicate()) return;
      assert.ok(this.tick(), 'Worker must have a bounded completion path.');
    }
    assert.fail('Worker did not finish within the bounded virtual timer steps.');
  }
  async advanceTo(target) {
    for (let step = 0; step < 1000; step++) {
      await yieldTurn();
      if (Math.min(...[...this.timers.values()].map(timer => timer.at)) > target) {
        this.now = target;
        return;
      }
      this.tick();
    }
    assert.fail('Unexpected automatic worker timer cadence.');
  }
}

function publication(layerCount = 3) {
  return {
    schema: 'zecblock-private-global-v1', publicationId: PUBLICATION, network: 'mainnet', layerCount,
    layers: Array.from({ length: Math.max(0, layerCount) }, (_, index) => ({ index })),
    sourceSummary: { recordCount: 2 },
  };
}

async function harness({ manifest = publication(), fault = null, outcome = 'found', holdEof = false, setupFault = -1,
  prepareDecode = false, preparationFault = false, holdFetch = false } = {}) {
  const clock = new Clock(), requests = [], messages = [], generated = [], decodes = [], constructors = [], streams = [], budgets = [], preparations = [], events = [];
  let listener, selected, pending = false, cancellations = 0, requestId = 0, releaseEof, releaseFetch;
  const eofGate = new Promise(resolve => { releaseEof = resolve; });
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  const responseBytes = manifest.layerCount * LAYER_REPLY_BYTES;
  const abortable = signal => new Promise((_, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
  });

  function response(path, bytes, { signal, ok = true, body = true, query = false } = {}) {
    const slot = { path, bytesRead: 0, reads: 0, eof: false, cancelled: false, released: false, waitingAtEof: false };
    streams.push(slot);
    let offset = 0;
    return {
      ok,
      body: body ? { getReader() { return {
        async read() {
          slot.reads++;
          if (query && offset > 0 && fault === 'read') throw new TypeError('Interrupted body.');
          if (query && offset > 0 && fault === 'body-timeout') return abortable(signal);
          if (offset === bytes.length) {
            if (query && holdEof) { slot.waitingAtEof = true; await eofGate; }
            slot.eof = true;
            return { done: true };
          }
          const value = bytes.slice(offset, offset + READ_BYTES);
          offset += value.length;
          slot.bytesRead += value.length;
          return { done: false, value };
        },
        async cancel() { slot.cancelled = true; },
        releaseLock() { slot.released = true; },
      }; } } : null,
    };
  }

  class Client {
    constructor(json, setups) {
      const value = JSON.parse(json);
      constructors.push({ manifest: value, setupBytes: setups.length });
      assert.equal(value.publicationId, manifest.publicationId);
      assert.equal(value.layerCount, manifest.layerCount);
      assert.equal(requests.length, 1 + manifest.layerCount, 'Every public setup must arrive before client construction.');
      assert.ok(streams.every(slot => slot.eof && slot.released), 'All initialization bodies must be fully consumed.');
      assert.equal(setups.length, manifest.layerCount * PUBLIC_BYTES);
      for (let index = 0; index < manifest.layerCount; index++) {
        assert.ok(setups.subarray(index * PUBLIC_BYTES, (index + 1) * PUBLIC_BYTES).every(byte => byte === index + 1),
          'Setup concatenation must preserve public layer order.');
      }
    }
    make_query(txid) {
      assert.equal(constructors.length, 1);
      assert.equal(pending, false, 'Selections may not overlap inside one client.');
      if (!/^[a-f0-9]{64}$/i.test(txid)) throw new Error('Invalid local identifier.');
      selected = txid;
      pending = true;
      // Deterministic opaque bytes isolate forwarding from cryptographic safety.
      const query = new Uint8Array(REQUEST_BYTES).fill(0x90 + generated.length);
      generated.push({ txid, query: Buffer.from(query) });
      return query;
    }
    decode_response(bytes) {
      // Record entry before assertions so an early/short decode cannot hide
      // behind the worker's generic error handler and look like no decoding.
      decodes.push({ bytes: bytes.length, txid: selected });
      const slot = streams.findLast(stream => stream.path === '/pir/query');
      assert.ok(slot?.eof && slot.released, 'Decoding must wait for response EOF and reader release.');
      assert.equal(slot.bytesRead, responseBytes, 'Every layer must arrive before any content decoding.');
      assert.equal(bytes.length, responseBytes);
      for (let index = 0; index < manifest.layerCount; index++) {
        assert.ok(bytes.subarray(index * LAYER_REPLY_BYTES, (index + 1) * LAYER_REPLY_BYTES).every(byte => byte === index + 11),
          'The complete response must retain the original layer order.');
      }
      pending = false; // The real primitive consumes its secret even on failure.
      if (fault === 'decode') throw new Error('Authentication failed.');
      if (fault === 'json') return '{';
      return JSON.stringify(outcome === 'absent'
        ? { found: false, publicationId: PUBLICATION }
        : { found: true, publicationId: PUBLICATION, txid: selected });
    }
    cancel_query() { pending = false; cancellations++; }
  }
  if (prepareDecode) {
    Client.prototype.prepare_decode = function () {
      events.push('prepare-decode');
      preparations.push({ queryRequests: requests.filter(request => request.path === '/pir/query').length,
        queryResponseStreams: streams.filter(stream => stream.path === '/pir/query').length });
      assert.equal(pending, true, 'Preparation must use the pending locally generated query.');
      clock.now += 17; // Simulate synchronous CPU work, without advancing HTTP.
      if (preparationFault) throw new Error('Local decoder preparation failed.');
    };
    Object.defineProperty(Client.prototype, 'decoder_coefficient_bytes', { get: () => 4096 });
  }

  const fetch = (path, options = {}) => {
    requests.push({ path, method: options.method ?? 'GET', headers: { ...options.headers },
      body: options.body === undefined ? undefined : Buffer.from(options.body),
      options: { credentials: options.credentials, redirect: options.redirect, cache: options.cache,
        mode: options.mode, referrerPolicy: options.referrerPolicy }, at: clock.now });
    if (path === '/publication/manifest.json') return Promise.resolve(response(path, new TextEncoder().encode(JSON.stringify(manifest))));
    const setup = /^\/publication\/layers\/(\d+)\/public\.bin$/.exec(path);
    if (setup) {
      assert.equal(generated.length, 0, 'Public hints must never be selected by a transaction ID.');
      const index = Number(setup[1]);
      return Promise.resolve(response(path, new Uint8Array(PUBLIC_BYTES - Number(index === setupFault)).fill(index + 1)));
    }
    assert.equal(path, '/pir/query', 'No acknowledgement, catalogue, status refresh, selected route or public fallback is allowed.');
    events.push('fetch-dispatched');
    assert.equal(generated.length, requests.filter(request => request.path === '/pir/query').length,
      'Each explicit selection must generate exactly one opaque query.');
    if (fault === 'fetch') return Promise.reject(new TypeError('Network unavailable.'));
    if (fault === 'fetch-timeout') return abortable(options.signal);
    const length = responseBytes + (fault === 'short' ? -1 : fault === 'oversize' ? READ_BYTES * 2 : 0);
    const bytes = new Uint8Array(length);
    for (let index = 0; index < manifest.layerCount; index++) bytes.fill(index + 11, index * LAYER_REPLY_BYTES, (index + 1) * LAYER_REPLY_BYTES);
    const deliver = () => {
      events.push('fetch-response');
      return response(path, bytes, { signal: options.signal, query: true, ok: fault !== '503', body: fault !== 'missing-body' });
    };
    return holdFetch ? fetchGate.then(deliver) : Promise.resolve(deliver());
  };
  const context = vm.createContext({
    Uint8Array, TextDecoder, TextEncoder, AbortController, DOMException, fetch,
    performance: { now: () => clock.now },
    AbortSignal: { timeout(ms) {
      budgets.push(ms);
      const controller = new AbortController();
      clock.setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), ms);
      return controller.signal;
    } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    self: {
      addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; },
      postMessage(message) { messages.push(message); },
    },
    __testPirModule: { init: async () => {}, GlobalPirBrowser: Client },
  });
  vm.runInContext(source, context, { filename: 'global-worker-under-test.js' });
  listener({ data: { type: 'initialize' } });
  await clock.until(() => messages.some(message => ['ready', 'error'].includes(message.type)));
  const initialRequests = requests.length, initialMessages = messages.length;
  return {
    clock, requests, messages, generated, decodes, constructors, streams, budgets, preparations, events, manifest, initialRequests, initialMessages,
    get cancellations() { return cancellations; },
    releaseEof, releaseFetch,
    startLookup(txid = IDS[0]) {
      const id = ++requestId;
      listener({ data: { type: 'lookup', requestId: id, txid } });
      return id;
    },
    async settleLookup(id) {
      await clock.until(() => messages.some(message => message.requestId === id && ['result', 'error'].includes(message.type)));
    },
    async lookup(txid = IDS[0]) { const id = this.startLookup(txid); await this.settleLookup(id); return id; },
    trace() { return requests.slice(initialRequests).map(request => ({ path: request.path, method: request.method,
      headers: request.headers, bytes: request.body?.length, options: request.options })); },
  };
}

function assertPrivateQuery(run, count = 1) {
  const queries = run.requests.slice(run.initialRequests);
  assert.equal(queries.length, count, 'Only explicitly requested opaque queries may use HTTP.');
  for (const [index, request] of queries.entries()) {
    assert.equal(request.path, '/pir/query');
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.headers, { 'Content-Type': 'application/octet-stream', 'X-PIR-Publication': PUBLICATION });
    assert.deepEqual(request.body, run.generated[index].query, 'The encrypted query must be forwarded unchanged.');
    assert.equal(request.body.length, REQUEST_BYTES);
    assert.deepEqual(request.options, { credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer' });
  }
  for (const request of run.requests) for (const txid of IDS) {
    const metadata = JSON.stringify({ path: request.path, method: request.method, headers: request.headers });
    assert.ok(!metadata.includes(txid));
    if (request.body) {
      assert.equal(request.body.indexOf(Buffer.from(txid)), -1, 'HTTP must not contain the selected display identifier.');
      assert.equal(request.body.indexOf(Buffer.from(txid, 'hex')), -1, 'HTTP must not contain the selected binary identifier.');
      assert.equal(request.body.indexOf(Buffer.from(txid, 'hex').reverse()), -1, 'HTTP must not contain a reversed wire identifier.');
    }
  }
}

async function assertQuiet(run) {
  const count = run.requests.length, generated = run.generated.length, outcomes = run.messages.filter(message => ['result', 'error'].includes(message.type)).length;
  await run.clock.advanceTo(run.clock.now + 1_000_000);
  assert.equal(run.requests.length, count, 'No retry, acknowledgement, refresh, poll or fallback may follow an outcome.');
  assert.equal(run.generated.length, generated);
  assert.equal(run.messages.filter(message => ['result', 'error'].includes(message.type)).length, outcomes);
  assert.deepEqual(run.clock.intervals, []);
}

test('global initialization consumes every ordered public hint before accepting a selection', async () => {
  for (const layers of [1, 3, 8]) {
    const run = await harness({ manifest: publication(layers) });
    assert.deepEqual(run.requests.map(request => request.path), ['/publication/manifest.json',
      ...Array.from({ length: layers }, (_, index) => `/publication/layers/${index}/public.bin`)]);
    assert.equal(run.constructors.length, 1);
    assert.equal(run.constructors[0].setupBytes, layers * PUBLIC_BYTES);
    assert.equal(run.generated.length, 0);
    assert.equal(run.decodes.length, 0);
    const ready = run.messages.find(message => message.type === 'ready');
    assert.equal(ready.manifest.publicationId, PUBLICATION);
    assert.equal(ready.samples.length, 0, 'The global worker must not publish a transaction catalogue.');
    assert.deepEqual(run.budgets, [120_000]);
    await assertQuiet(run);
  }
});

test('one opaque query receives the complete ordered all-layer body before decoding', async () => {
  const run = await harness();
  await run.lookup();
  assertPrivateQuery(run);
  assert.equal(run.generated.length, 1);
  assert.equal(run.decodes.length, 1);
  assert.equal(run.decodes[0].bytes, 3 * LAYER_REPLY_BYTES);
  const result = run.messages.find(message => message.type === 'result');
  assert.equal(result.result.txid, IDS[0]);
  assert.equal(result.measurements.queryBytes, REQUEST_BYTES);
  assert.equal(result.measurements.responseBytes, 3 * LAYER_REPLY_BYTES);
  assert.equal(result.measurements.layerCount, 3);
  assert.equal(result.measurements.decodePrepareMs, 0, 'Older WASM clients without the optional preparation hook remain supported.');
  assert.equal(result.measurements.decoderCoefficientBytes, 0);
  assert.deepEqual(run.budgets, [120_000, 900_000]);
  await assertQuiet(run);
});

test('optional local decoder preparation overlaps the dispatched HTTP fetch without another request', async () => {
  const run = await harness({ prepareDecode: true, holdFetch: true });
  const requestId = run.startLookup();
  await yieldTurn();
  assert.deepEqual(run.events, ['fetch-dispatched', 'prepare-decode']);
  assert.deepEqual(run.preparations, [{ queryRequests: 1, queryResponseStreams: 0 }],
    'CPU preparation must run while the single fetch is still awaiting a response.');
  assert.equal(run.decodes.length, 0);
  assert.equal(run.cancellations, 0);
  assert.ok(!run.messages.some(message => message.requestId === requestId && ['result', 'error'].includes(message.type)));
  assertPrivateQuery(run);
  run.releaseFetch();
  await run.settleLookup(requestId);
  assert.deepEqual(run.events, ['fetch-dispatched', 'prepare-decode', 'fetch-response']);
  assert.equal(run.decodes.length, 1);
  const result = run.messages.find(message => message.type === 'result');
  assert.equal(result.result.txid, IDS[0]);
  assert.equal(result.measurements.decodePrepareMs, 17);
  assert.equal(result.measurements.decoderCoefficientBytes, 4096);
  assert.equal(result.measurements.queryBytes, REQUEST_BYTES);
  assert.equal(result.measurements.responseBytes, 3 * LAYER_REPLY_BYTES);
  assertPrivateQuery(run);
  await assertQuiet(run);
});

test('preparation failure waits for the complete bounded reply and EOF before any local failure feedback', async () => {
  const run = await harness({ prepareDecode: true, preparationFault: true, holdFetch: true, holdEof: true });
  const requestId = run.startLookup();
  await yieldTurn();
  assert.deepEqual(run.events, ['fetch-dispatched', 'prepare-decode']);
  assert.equal(run.preparations.length, 1);
  assert.equal(run.cancellations, 0, 'A local CPU failure must not cancel an in-flight public reply.');
  assert.ok(!run.messages.some(message => message.requestId === requestId && ['result', 'error'].includes(message.type)));
  run.releaseFetch();
  await yieldTurn();
  const slot = run.streams.find(stream => stream.path === '/pir/query');
  assert.equal(slot.bytesRead, 3 * LAYER_REPLY_BYTES, 'All layer bytes must be consumed despite the earlier preparation exception.');
  assert.equal(slot.waitingAtEof, true);
  assert.equal(slot.eof, false);
  assert.equal(slot.cancelled, false);
  assert.equal(run.decodes.length, 0);
  assert.equal(run.cancellations, 0);
  assert.deepEqual(run.messages.filter(message => message.requestId === requestId).map(message => message.type === 'stage' ? message.stage : message.type),
    ['query', 'server'], 'No failure or decode feedback may precede complete response EOF.');
  assertPrivateQuery(run);
  run.releaseEof();
  await run.settleLookup(requestId);
  assert.equal(slot.eof, true); assert.equal(slot.released, true); assert.equal(slot.cancelled, false);
  assert.equal(run.decodes.length, 0, 'A failed preparation must never enter content decoding.');
  assert.equal(run.cancellations, 1);
  const outcomes = run.messages.filter(message => message.requestId === requestId && ['result', 'error'].includes(message.type));
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].type, 'error');
  assert.match(outcomes[0].message, /could not be verified.*No retry or public lookup/);
  assert.deepEqual(run.messages.filter(message => message.requestId === requestId).map(message => message.type === 'stage' ? message.stage : message.type),
    ['query', 'server', 'decode', 'error']);
  assertPrivateQuery(run);
  await assertQuiet(run);
});

test('even a full-sized body cannot decode before EOF and concurrent selections are ignored', async () => {
  const run = await harness({ holdEof: true });
  const first = run.startLookup();
  await yieldTurn();
  const slot = run.streams.find(stream => stream.path === '/pir/query');
  assert.equal(slot.bytesRead, 3 * LAYER_REPLY_BYTES);
  assert.equal(slot.waitingAtEof, true);
  assert.equal(slot.eof, false);
  assert.equal(run.decodes.length, 0);
  assert.ok(!run.messages.some(message => message.requestId === first && ['result', 'error'].includes(message.type)));
  run.startLookup(IDS[1]);
  await yieldTurn();
  assert.equal(run.generated.length, 1);
  assertPrivateQuery(run);
  run.releaseEof();
  await run.settleLookup(first);
  assert.equal(run.decodes.length, 1);
  await assertQuiet(run);
});

test('different identifiers, absence and decode failures retain one identical HTTP shape without follow-up', async () => {
  let expected;
  for (const txid of IDS) for (const scenario of [{}, { outcome: 'absent' }, { fault: 'decode' }, { fault: 'json' }]) {
    const run = await harness(scenario);
    await run.lookup(txid);
    assertPrivateQuery(run);
    expected ??= run.trace();
    assert.deepEqual(run.trace(), expected);
    assert.equal(run.decodes.length, 1);
    const outcomes = run.messages.slice(run.initialMessages).filter(message => ['result', 'error'].includes(message.type));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].type, Object.keys(scenario).length ? 'error' : 'result');
    if (scenario.outcome === 'absent') assert.match(outcomes[0].message, /absent/);
    assert.equal(run.cancellations, scenario.fault ? 1 : 0);
    await assertQuiet(run);
  }
});

test('short, oversized, interrupted and unavailable replies never reach the decoder or trigger more HTTP', async t => {
  for (const fault of ['short', 'oversize', '503', 'missing-body', 'fetch', 'read', 'fetch-timeout', 'body-timeout']) await t.test(fault, async () => {
    const run = await harness({ fault });
    await run.lookup();
    assertPrivateQuery(run);
    assert.equal(run.decodes.length, 0);
    assert.equal(run.cancellations, 1);
    assert.equal(run.messages.at(-1).type, 'error');
    assert.deepEqual(run.budgets, [120_000, 900_000]);
    const slot = run.streams.find(stream => stream.path === '/pir/query');
    if (fault === 'oversize') {
      assert.equal(slot.cancelled, true);
      assert.equal(slot.released, true);
      assert.ok(slot.bytesRead > 3 * LAYER_REPLY_BYTES && slot.bytesRead <= 3 * LAYER_REPLY_BYTES + READ_BYTES);
    }
    if (['short', 'read', 'body-timeout'].includes(fault)) assert.equal(slot.released, true);
    await assertQuiet(run);
  });
});

test('after an error a second explicit user lookup generates one new opaque query', async () => {
  const run = await harness({ fault: 'decode' });
  await run.lookup(IDS[0]);
  await assertQuiet(run);
  await run.lookup(IDS[1]);
  assertPrivateQuery(run, 2);
  assert.equal(run.generated.length, 2);
  assert.notDeepEqual(run.generated[0].query, run.generated[1].query, 'The harness must observe a new primitive call, not replay the first upload.');
  assert.equal(run.decodes.length, 2);
  assert.equal(run.cancellations, 2);
  await assertQuiet(run);
});

test('invalid local identifiers cannot enter HTTP', async () => {
  const run = await harness();
  await run.lookup('not-a-transaction');
  assert.equal(run.requests.length, run.initialRequests);
  assert.equal(run.generated.length, 0);
  assert.equal(run.decodes.length, 0);
  assert.equal(run.messages.at(-1).type, 'error');
  await assertQuiet(run);
});

test('invalid manifest bounds and incomplete public hints stop initialization without a query', async () => {
  const invalid = [publication(0), publication(129), { ...publication(), layerCount: 1.5 },
    { ...publication(), layers: [] }, { ...publication(), publicationId: 'invalid' }];
  for (const manifest of invalid) {
    const run = await harness({ manifest });
    assert.deepEqual(run.requests.map(request => request.path), ['/publication/manifest.json']);
    assert.equal(run.constructors.length, 0);
    assert.ok(!run.messages.some(message => message.type === 'ready'));
    run.startLookup();
    await yieldTurn();
    assert.equal(run.generated.length, 0);
    await assertQuiet(run);
  }
  const run = await harness({ setupFault: 1 });
  assert.deepEqual(run.requests.map(request => request.path), ['/publication/manifest.json',
    '/publication/layers/0/public.bin', '/publication/layers/1/public.bin']);
  assert.equal(run.constructors.length, 0);
  assert.equal(run.generated.length, 0);
  assert.ok(!run.messages.some(message => message.type === 'ready'));
  await assertQuiet(run);
});
