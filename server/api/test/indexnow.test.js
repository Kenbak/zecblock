const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createIndexNowNotifier,
  resolveIndexNowConfig,
  isEligibleIndexNowPath,
  pathForEvent,
} = require('../indexnow');

const KEY = 'indexnow-test-key';
const TX_A = 'a'.repeat(64);
const TX_B = 'b'.repeat(64);
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const HASH_3 = '3'.repeat(64);

// Manual timers + clock so batching, TTLs and the hourly cap are deterministic.
function harness(options = {}) {
  let now = options.startAt ?? 1_000_000;
  const timers = [];
  const requests = [];
  const errors = [];
  const statuses = [...(options.statuses || [])];
  const notifier = createIndexNowNotifier({
    key: KEY,
    host: 'zecblock.com',
    endpoint: 'https://api.indexnow.org/indexnow',
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    fetchImpl: options.fetchImpl || (async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return { status: statuses.length ? statuses.shift() : 200 };
    }),
    onError: (context, err) => errors.push({ context, message: err.message }),
    ...options.config,
  });
  return {
    notifier,
    requests,
    errors,
    timers,
    advance(ms) { now += ms; },
    urls: () => requests.flatMap((request) => request.body.urlList),
  };
}

test('only explicit mainnet configuration with a valid key and host is enabled', () => {
  const base = { INDEXNOW_KEY: KEY, INDEXNOW_HOST: 'zecblock.com', NETWORK: 'mainnet' };
  assert.deepEqual(resolveIndexNowConfig(base), {
    enabled: true, key: KEY, host: 'zecblock.com', endpoint: 'https://api.indexnow.org/indexnow',
  });
  assert.equal(resolveIndexNowConfig({ ...base, ZCASH_NETWORK: 'mainnet', NETWORK: 'testnet' }).enabled, true);
  for (const env of [
    { ...base, NETWORK: undefined }, // Missing network is never assumed to be mainnet.
    { ...base, NETWORK: 'testnet' },
    { ...base, NETWORK: 'crosslink-testnet' },
    { ...base, ZCASH_NETWORK: 'testnet' },
    { ...base, INDEXNOW_KEY: '' },
    { ...base, INDEXNOW_KEY: 'short' },
    { ...base, INDEXNOW_KEY: 'has/slash/in-the-key' },
    { ...base, INDEXNOW_HOST: '' },
    { ...base, INDEXNOW_HOST: 'zecblock.com/path' },
    { ...base, INDEXNOW_ENDPOINT: 'http://api.indexnow.org/indexnow' },
  ]) {
    assert.equal(resolveIndexNowConfig(env).enabled, false, JSON.stringify(env));
  }
});

test('a disabled notifier never calls fetch', async () => {
  let called = false;
  const notifier = createIndexNowNotifier({ enabled: false, key: KEY, host: 'zecblock.com', fetchImpl: async () => { called = true; } });
  notifier.blockConnected({ height: 10, hash: HASH_1 });
  notifier.mempoolAdded(TX_A);
  assert.deepEqual(await notifier.flush(), []);
  assert.equal(called, false);
});

test('URL eligibility admits only canonical content page shapes', () => {
  for (const path of ['/block/0', '/block/3500000', `/block/${HASH_1}`, `/tx/${TX_A}`, '/newsletter/weekly-2026-10-25']) {
    assert.equal(isEligibleIndexNowPath(path), true, path);
  }
  for (const path of [
    '/', '/blocks', '/blocks?page=2', '/block/3500000?tab=txs', '/block/0123', '/block/1000000000',
    `/block/${'AB'.repeat(32)}`, `/tx/${TX_A.toUpperCase()}`, `/tx/${TX_A}/`, `/tx/${TX_A}#x`,
    '/api/blocks', '/api/v1/tx', '/v1/blocks/1', '/address/t1abc', '/name/alice', '/mempool',
    '/newsletter/../secrets', '/newsletter/', 'https://zecblock.com/block/1',
  ]) {
    assert.equal(isEligibleIndexNowPath(path), false, path);
  }
});

test('events map to canonical paths; canonical block hashes are not representable', () => {
  assert.equal(pathForEvent({ type: 'block-canonical', height: '3500000' }), '/block/3500000');
  assert.equal(pathForEvent({ type: 'block-canonical', hash: HASH_1 }), null);
  assert.equal(pathForEvent({ type: 'block-orphaned', hash: HASH_1.toUpperCase() }), `/block/${HASH_1}`);
  assert.equal(pathForEvent({ type: 'tx-pending', txid: TX_A.toUpperCase() }), `/tx/${TX_A}`);
  assert.equal(pathForEvent({ type: 'tx-pending', txid: 'xyz' }), null);
  assert.equal(pathForEvent({ type: 'newsletter', slug: 'weekly-2026-10-25' }), '/newsletter/weekly-2026-10-25');
  assert.equal(pathForEvent({ type: 'newsletter', slug: '../etc' }), null);
  for (const type of ['poll', 'address', 'search', 'api', 'testnet-block']) {
    assert.equal(pathForEvent({ type, height: 1, txid: TX_A }), null, type);
  }
});

test('events are batched into one request with absolute mainnet URLs and the key location', async () => {
  const h = harness();
  h.notifier.blockConnected({ height: 100, hash: HASH_1 });
  h.notifier.mempoolAdded(TX_A);
  h.notifier.newsletterPublished('weekly-2026-10-25');
  assert.equal(h.requests.length, 0, 'nothing is sent on the event path');
  assert.equal(h.timers.length, 1, 'one flush timer per batch window');
  assert.equal(h.timers[0].ms, 30_000);

  h.timers[0].fn();
  await h.notifier.flush();
  assert.equal(h.requests.length, 1);
  const [request] = h.requests;
  assert.equal(request.url, 'https://api.indexnow.org/indexnow');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(request.body, {
    host: 'zecblock.com',
    key: KEY,
    keyLocation: `https://zecblock.com/${KEY}.txt`,
    urlList: [
      'https://zecblock.com/block/100',
      `https://zecblock.com/tx/${TX_A}`,
      'https://zecblock.com/newsletter/weekly-2026-10-25',
    ],
  });
});

test('repeated broadcasts of one state are deduplicated; a new state of the same URL is not', async () => {
  const h = harness();
  h.notifier.blockConnected({ height: 100, hash: HASH_1 }); // partial row
  h.notifier.blockConnected({ height: 100, hash: HASH_1, transaction_count: 3 }); // self-correction
  h.notifier.mempoolAdded(TX_A);
  h.notifier.mempoolAdded(TX_A); // relay/duplicate stream event
  await h.notifier.flush();
  assert.deepEqual(h.urls(), ['https://zecblock.com/block/100', `https://zecblock.com/tx/${TX_A}`]);

  h.advance(60_000);
  h.notifier.mempoolAdded(TX_A); // still the same pending state
  h.notifier.transactionMined(TX_A); // confirmation is a new state
  await h.notifier.flush();
  assert.deepEqual(h.urls().slice(2), [`https://zecblock.com/tx/${TX_A}`]);
  // The same-tip self-correction is ignored before queueing; both pending repeats are dropped.
  assert.equal(h.notifier.stats().droppedDuplicate, 2);
});

test('a dedupe entry expires so a later reconfirmation is announced again', async () => {
  const h = harness();
  h.notifier.transactionMined(TX_A);
  await h.notifier.flush();
  h.advance(15 * 60_000 + 1);
  h.notifier.transactionMined(TX_A);
  await h.notifier.flush();
  assert.equal(h.urls().length, 2);
});

test('drops are announced only for transactions previously announced as pending', async () => {
  const h = harness();
  h.notifier.mempoolDropped(TX_B); // never announced: a missing URL, not a state change
  h.notifier.mempoolAdded(TX_A);
  await h.notifier.flush();
  h.notifier.mempoolDropped(TX_A);
  h.notifier.mempoolDropped(TX_A);
  await h.notifier.flush();
  assert.deepEqual(h.urls(), [`https://zecblock.com/tx/${TX_A}`, `https://zecblock.com/tx/${TX_A}`]);

  h.notifier.mempoolAdded(TX_B);
  h.notifier.transactionMined(TX_B);
  await h.notifier.flush();
  h.notifier.mempoolDropped(TX_B); // mined, no longer a pending announcement
  await h.notifier.flush();
  assert.deepEqual(h.urls().slice(2), [`https://zecblock.com/tx/${TX_B}`]);
});

test('same-height reorg announces the height page and the orphaned hash page', async () => {
  const h = harness();
  h.notifier.blockConnected({ height: 100, hash: HASH_1 });
  await h.notifier.flush();
  h.notifier.blockConnected({ height: 100, hash: HASH_2 });
  await h.notifier.flush();
  assert.deepEqual(h.urls().slice(1), ['https://zecblock.com/block/100', `https://zecblock.com/block/${HASH_1}`]);
});

test('a child whose parent is not the previous tip announces the replaced height', async () => {
  const h = harness();
  h.notifier.blockConnected({ height: 100, hash: HASH_1 });
  await h.notifier.flush();
  h.notifier.blockConnected({ height: 101, hash: HASH_3, previous_block_hash: HASH_2 });
  await h.notifier.flush();
  assert.deepEqual(h.urls().slice(1), [
    'https://zecblock.com/block/100',
    `https://zecblock.com/block/${HASH_1}`,
    'https://zecblock.com/block/101',
  ]);
});

test('a parent mismatch learned from a later full row is still announced once', async () => {
  const h = harness();
  h.notifier.blockConnected({ height: 100, hash: HASH_1 });
  h.notifier.blockConnected({ height: 101, hash: HASH_3 }); // partial row, parent unknown
  await h.notifier.flush();
  h.notifier.blockConnected({ height: 101, hash: HASH_3, previous_block_hash: HASH_2 });
  h.notifier.blockConnected({ height: 101, hash: HASH_3, previous_block_hash: HASH_2 });
  await h.notifier.flush();
  assert.deepEqual(h.urls().slice(2), ['https://zecblock.com/block/100', `https://zecblock.com/block/${HASH_1}`]);
});

test('a linear chain announces no reorg and canonical hashes are never submitted', async () => {
  const h = harness();
  h.notifier.blockConnected({ height: 100, hash: HASH_1 });
  h.notifier.blockConnected({ height: 101, hash: HASH_2, previous_block_hash: HASH_1 });
  await h.notifier.flush();
  assert.deepEqual(h.urls(), ['https://zecblock.com/block/100', 'https://zecblock.com/block/101']);
  assert.ok(h.urls().every((url) => !/[0-9a-f]{64}$/.test(url)));
});

test('deep backward reorgs are bounded and stale events are ignored', async () => {
  const h = harness({ config: { maxReorgDepth: 3 } });
  h.notifier.blockConnected({ height: 200, hash: HASH_1 });
  await h.notifier.flush();
  h.notifier.blockConnected({ height: 90, hash: HASH_2 }); // older than the reorg window
  await h.notifier.flush();
  assert.equal(h.urls().length, 1);
  h.notifier.blockConnected({ height: 198, hash: HASH_3 });
  await h.notifier.flush();
  assert.deepEqual(h.urls().slice(1), [
    'https://zecblock.com/block/198',
    'https://zecblock.com/block/199',
    'https://zecblock.com/block/200',
    `https://zecblock.com/block/${HASH_1}`,
  ]);
});

test('batches are split by size and capped per trailing hour', async () => {
  const h = harness({ config: { maxBatchSize: 2, maxUrlsPerHour: 5 } });
  for (let i = 0; i < 8; i++) h.notifier.blockConnected({ height: 1000 + i, hash: (i + 1).toString(16).padStart(64, '0') });
  await h.notifier.flush();
  assert.deepEqual(h.requests.map((request) => request.body.urlList.length), [2, 2, 1]);
  assert.equal(h.notifier.stats().droppedRateLimit, 3);
  assert.equal(h.notifier.stats().pending, 0, 'the backlog does not grow while capped');

  h.notifier.mempoolAdded(TX_A);
  await h.notifier.flush();
  assert.equal(h.requests.length, 3, 'still capped inside the hour');
  h.advance(3_600_001);
  h.notifier.mempoolAdded(TX_B);
  await h.notifier.flush();
  assert.deepEqual(h.requests.at(-1).body.urlList, [`https://zecblock.com/tx/${TX_B}`]);
});

test('HTTP 202 is success; errors and rejections never throw to the caller', async () => {
  const accepted = harness({ statuses: [202] });
  accepted.notifier.mempoolAdded(TX_A);
  const [result] = await accepted.notifier.flush();
  assert.deepEqual(result, { ok: true, status: 202, count: 1 });
  assert.equal(accepted.errors.length, 0);

  const rejected = harness({ statuses: [403] });
  rejected.notifier.mempoolAdded(TX_A);
  assert.deepEqual(await rejected.notifier.flush(), [{ ok: false, status: 403, count: 1 }]);
  assert.match(rejected.errors[0].message, /HTTP 403/);

  const failing = harness({ fetchImpl: async () => { throw new Error('network down'); } });
  failing.notifier.blockConnected({ height: 1, hash: HASH_1 });
  assert.deepEqual(await failing.notifier.flush(), [{ ok: false, status: null, count: 1 }]);
  assert.equal(failing.notifier.stats().failedBatches, 1);
  assert.deepEqual(failing.errors, [{ context: 'submit', message: 'network down' }]);

  const throwingHook = createIndexNowNotifier({
    key: KEY, host: 'zecblock.com', fetchImpl: async () => { throw new Error('x'); },
    onError: () => { throw new Error('logger broke'); }, setTimer: () => null, clearTimer: () => {},
  });
  throwingHook.mempoolAdded(TX_A);
  await assert.doesNotReject(throwingHook.flush());
});

test('malformed event inputs are ignored without throwing', async () => {
  const h = harness();
  for (const block of [null, {}, { height: -1, hash: HASH_1 }, { height: 1.5, hash: HASH_1 }, { height: 1, hash: 'nothex' }]) {
    assert.doesNotThrow(() => h.notifier.blockConnected(block));
  }
  for (const txid of [undefined, null, 42, 'abc', `${TX_A}00`]) {
    assert.doesNotThrow(() => h.notifier.mempoolAdded(txid));
    assert.doesNotThrow(() => h.notifier.transactionMined(txid));
  }
  h.notifier.newsletterPublished('../../etc/passwd');
  await h.notifier.flush();
  assert.equal(h.requests.length, 0);
});

test('stop cancels the pending flush timer and ignores later events', async () => {
  const h = harness();
  h.notifier.mempoolAdded(TX_A);
  assert.equal(h.timers.length, 1);
  await h.notifier.stop();
  assert.equal(h.timers.length, 0);
  h.notifier.mempoolAdded(TX_B);
  assert.equal(h.timers.length, 0);
});

test('the API wires the notifier into block and mempool events only', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /function broadcastNewBlock\(block\) \{[\s\S]*?indexNow\.blockConnected\(block\);\n\}/);
  assert.match(source, /change\.type === 'ADDED'\) \{\n\s+indexNow\.mempoolAdded\(change\.txid\);/);
  assert.match(source, /change\.type === 'MINED'\) \{\n\s+indexNow\.transactionMined\(change\.txid\);/);
  assert.match(source, /change\.type === 'INVALIDATED'\) \{\n\s+indexNow\.mempoolDropped\(change\.txid\);/);
  assert.equal((source.match(/indexNow\.\w+\(/g) || []).length, 5, 'no other call sites (polls, routes, relays)');
});
