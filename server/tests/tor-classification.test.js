'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOR_CLASSIFICATION_KEY,
  TOR_CLASSIFICATION_TTL_SECONDS,
  parseTorExitList,
  validateTorClassificationStatus,
  readTorClassificationStatus,
  torClassificationForStats,
  torClassificationForSnapshot,
  readLatestTorCensusSnapshot,
  publishTorClassificationStatus,
} = require('../lib/tor-classification');

const NOW = Date.now();
const FRESH_FOR_MS = 600_000;
const status = (overrides = {}) => ({
  version: 1,
  available: true,
  sourceObservedAtMs: NOW - 4_000,
  checkedAtMs: NOW - 3_000,
  committedAtMs: NOW - 2_000,
  snapshotTimeMs: NOW - 2_500,
  classifiedTorNodes: 4,
  ...overrides,
});
const iso = (value) => new Date(value).toISOString();

function expectedFields(value, overrides = {}) {
  return {
    torNodes: value.classifiedTorNodes,
    torClassificationAvailable: value.available,
    torClassificationCheckedAt: iso(value.checkedAtMs),
    ...overrides,
  };
}

const publicStats = value => { const result = { ...value }; delete result.censusSnapshotTime; return result; };

const unavailableFields = {
  torNodes: null,
  torClassificationAvailable: false,
  torClassificationCheckedAt: null,
};

test('classification key and lifetime isolate the qualified census from older counts', () => {
  assert.equal(TOR_CLASSIFICATION_KEY, 'zcash:tor-classification:census-v3');
  assert.equal(TOR_CLASSIFICATION_TTL_SECONDS, 600);
});

test('Tor exit parsing accepts literal IPs, comments and blanks, normalizes IPv6 and deduplicates', () => {
  const exits = parseTorExitList([
    '# Tor exit addresses',
    '',
    '  192.0.2.1  ',
    '192.0.2.1',
    '2001:0DB8:0000:0000:0000:0000:0000:0001',
    '2001:db8::1',
    '198.51.100.2',
    '  # another comment',
    '',
  ].join('\r\n'));
  assert.ok(exits instanceof Set);
  assert.deepEqual([...exits].sort(), ['192.0.2.1', '198.51.100.2', '2001:db8::1']);
});

test('empty, malformed or mixed Tor exit responses cannot become a successful zero classification', () => {
  for (const input of [
    null, undefined, 42, {}, '', ' \n\t', '# comments only\n# unavailable',
    '<html><body>temporarily unavailable</body></html>',
    '192.0.2.1\n<html>error</html>', '192.0.2.1\nnot-an-IP',
    '999.1.2.3', '192.0.2.1:8233', 'seed.example',
    'http://192.0.2.1', 'fe80::1%eth0',
  ]) {
    assert.equal(parseTorExitList(input), null, `should reject ${JSON.stringify(input)}`);
  }
});

test('fresh available classification and a measured zero both validate', () => {
  assert.deepEqual(validateTorClassificationStatus(status(), NOW), status());
  const zero = status({ classifiedTorNodes: 0 });
  assert.deepEqual(validateTorClassificationStatus(zero, NOW), zero);
  const unavailable = status({ available: false, classifiedTorNodes: null });
  assert.deepEqual(validateTorClassificationStatus(unavailable, NOW), unavailable);
});

test('classification requires its schema, a boolean availability flag and a usable count', () => {
  for (const input of [
    null, undefined, 'status', [], {},
    status({ version: 0 }), status({ version: '1' }),
    status({ available: 'false' }), status({ available: null }),
    status({ classifiedTorNodes: null }), status({ classifiedTorNodes: -1 }),
    status({ classifiedTorNodes: 1.5 }), status({ classifiedTorNodes: '4' }),
    status({ classifiedTorNodes: NaN }), status({ classifiedTorNodes: Infinity }),
    status({ classifiedTorNodes: Number.MAX_SAFE_INTEGER + 1 }),
    status({ available: false, classifiedTorNodes: 0 }),
  ]) {
    assert.equal(validateTorClassificationStatus(input, NOW), null);
  }
});

test('every classification clock must be present, finite and a safe integer no later than now', () => {
  const keys = ['sourceObservedAtMs', 'checkedAtMs', 'committedAtMs', 'snapshotTimeMs'];
  for (const key of keys) {
    for (const value of [undefined, null, String(NOW), NaN, Infinity, NOW - 0.5, NOW + 1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(validateTorClassificationStatus(status({ [key]: value }), NOW), null, key);
    }
  }
});

test('classification cannot precede the source observation or appear committed before its clocks', () => {
  for (const input of [
    status({ sourceObservedAtMs: NOW - 2_999 }),
    status({ checkedAtMs: NOW - 1_999 }),
    status({ snapshotTimeMs: NOW - 1_999 }),
  ]) {
    assert.equal(validateTorClassificationStatus(input, NOW), null);
  }
  const simultaneous = status({
    sourceObservedAtMs: NOW, checkedAtMs: NOW, committedAtMs: NOW, snapshotTimeMs: NOW,
  });
  assert.deepEqual(validateTorClassificationStatus(simultaneous, NOW), simultaneous);
});

test('classification and source observation each expire at the ten-minute boundary', () => {
  const boundary = status({
    sourceObservedAtMs: NOW - FRESH_FOR_MS,
    checkedAtMs: NOW - FRESH_FOR_MS,
    snapshotTimeMs: NOW - FRESH_FOR_MS,
  });
  assert.deepEqual(validateTorClassificationStatus(boundary, NOW), boundary);
  assert.equal(validateTorClassificationStatus(status({ sourceObservedAtMs: NOW - FRESH_FOR_MS - 1 }), NOW), null);
  assert.equal(validateTorClassificationStatus(status({
    sourceObservedAtMs: NOW - FRESH_FOR_MS - 1,
    checkedAtMs: NOW - FRESH_FOR_MS - 1,
  }), NOW), null);
});

test('Redis status reads use the census key and return validated JSON only', async () => {
  const value = status({ classifiedTorNodes: 0 });
  const keys = [];
  const redis = { get: async (key) => { keys.push(key); return JSON.stringify(value); } };
  assert.deepEqual(await readTorClassificationStatus(redis, { now: NOW }), value);
  assert.deepEqual(keys, [TOR_CLASSIFICATION_KEY]);
});

test('missing, malformed, stale and failing Redis state all fail closed', async () => {
  for (const value of [
    null, undefined, '', 'not JSON', 'null', '[]', '{}',
    JSON.stringify(status({ classifiedTorNodes: null })),
    JSON.stringify(status({ sourceObservedAtMs: NOW - FRESH_FOR_MS - 1 })),
  ]) {
    assert.equal(await readTorClassificationStatus({ get: async () => value }, { now: NOW }), null);
  }
  assert.equal(await readTorClassificationStatus({ get: async () => { throw new Error('Redis unavailable'); } }, { now: NOW }), null);
  assert.equal(await readTorClassificationStatus(null, { now: NOW }), null);
});

test('stats classification requires the exact source observation clock and preserves other cached fields', () => {
  const value = status();
  const cached = { activeNodes: 300, torNodes: 99, lastUpdated: iso(value.sourceObservedAtMs), censusSnapshotTime: iso(value.snapshotTimeMs) };
  const result = torClassificationForStats(cached, value);
  assert.deepEqual(result, { ...publicStats(cached), ...expectedFields(value) });
  assert.equal(Object.hasOwn(result, 'censusSnapshotTime'), false);
  assert.deepEqual(torClassificationForStats({ ...cached, lastUpdated: new Date(value.sourceObservedAtMs) }, value), {
    ...publicStats(cached), lastUpdated: new Date(value.sourceObservedAtMs), ...expectedFields(value),
  });
  assert.notEqual(result, cached);
  assert.equal(cached.torNodes, 99);
  for (const lastUpdated of [null, undefined, 'invalid date', iso(value.sourceObservedAtMs - 1), iso(value.sourceObservedAtMs + 1)]) {
    assert.deepEqual(torClassificationForStats({ ...cached, lastUpdated }, value), {
      ...publicStats(cached), lastUpdated, ...unavailableFields,
      torClassificationCheckedAt: iso(value.checkedAtMs),
    });
  }
});

test('valid unavailable classification retains its checked time while distinguishing a measured zero', () => {
  const value = status({ available: false, classifiedTorNodes: null });
  const cached = { lastUpdated: iso(value.sourceObservedAtMs), censusSnapshotTime: iso(value.snapshotTimeMs), torNodes: 0 };
  assert.deepEqual(torClassificationForStats(cached, value), {
    ...publicStats(cached), ...expectedFields(value),
  });
  const zero = status({ classifiedTorNodes: 0 });
  assert.deepEqual(torClassificationForStats(cached, zero), {
    ...publicStats(cached), ...expectedFields(zero),
  });
});

test('every-request overlay clears cached zero or positive counts when current classification is absent', () => {
  const value = status({ classifiedTorNodes: 0 });
  const cached = {
    activeNodes: 300,
    lastUpdated: iso(value.sourceObservedAtMs),
    censusSnapshotTime: iso(value.snapshotTimeMs),
    torNodes: 0,
    torClassificationAvailable: true,
    torClassificationCheckedAt: iso(value.checkedAtMs),
  };
  assert.equal(torClassificationForStats(cached, value).torNodes, 0);
  assert.deepEqual(torClassificationForStats(cached, null), { ...publicStats(cached), ...unavailableFields });
  assert.deepEqual(torClassificationForStats({ ...cached, torNodes: 4 }, null), {
    ...publicStats(cached), ...unavailableFields,
  });
  assert.equal(cached.torClassificationAvailable, true);
});

test('snapshot classification requires the exact snapshot clock and never fills another historical point', () => {
  const value = status();
  for (const snapshotTime of [iso(value.snapshotTimeMs), new Date(value.snapshotTimeMs), value.snapshotTimeMs]) {
    assert.deepEqual(torClassificationForSnapshot(snapshotTime, value), expectedFields(value));
  }
  assert.deepEqual(torClassificationForSnapshot(iso(value.snapshotTimeMs - 1), value), unavailableFields);
  assert.deepEqual(torClassificationForSnapshot(iso(value.snapshotTimeMs + 1), value), unavailableFields);
  assert.deepEqual(torClassificationForSnapshot('invalid date', value), unavailableFields);
  assert.deepEqual(torClassificationForSnapshot(iso(value.snapshotTimeMs), null), unavailableFields);
  const unavailable = status({ available: false, classifiedTorNodes: null });
  assert.deepEqual(torClassificationForSnapshot(iso(value.snapshotTimeMs), unavailable), unavailableFields);
});


test('the stats snapshot clock must match even when a later census reuses the same source clock', () => {
  const value = status();
  const cached = { activeNodes: 300, torNodes: 4, lastUpdated: iso(value.sourceObservedAtMs) };
  for (const censusSnapshotTime of [undefined, null, 'invalid', iso(value.snapshotTimeMs - 1), iso(value.snapshotTimeMs + 1)]) {
    assert.deepEqual(torClassificationForStats({ ...cached, censusSnapshotTime }, value), {
      ...cached, ...unavailableFields, torClassificationCheckedAt: iso(value.checkedAtMs),
    });
  }
});

test('Redis reads bound a hung request and do not query disconnected clients', { timeout: 1_000 }, async () => {
  assert.equal(await readTorClassificationStatus({ get: () => new Promise(() => {}) }, { now: () => NOW, timeoutMs: 10 }), null);
  for (const connectionState of [{ isOpen: false }, { isReady: false }]) {
    let calls = 0;
    assert.equal(await readTorClassificationStatus({ ...connectionState, get: async () => { calls += 1; return JSON.stringify(status()); } }, { now: () => NOW }), null);
    assert.equal(calls, 0);
  }
});

function fakeTorRequest({ statusCode = 200, chunks = [], failure = null } = {}) {
  const { EventEmitter } = require('node:events');
  const request = new EventEmitter();
  const calls = { resumed: false, responseDestroyed: false, requestDestroyed: false };
  request.destroy = (error) => {
    calls.requestDestroyed = true;
    queueMicrotask(() => request.emit('error', error));
    return request;
  };
  const get = (url, options, callback) => {
    assert.equal(url, 'https://check.torproject.org/torbulkexitlist');
    assert.ok(options.timeout > 0);
    queueMicrotask(() => {
      if (failure === 'request') { request.emit('error', new Error('request failed')); return; }
      if (failure === 'timeout') { request.emit('timeout'); return; }
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.resume = () => { calls.resumed = true; };
      response.destroy = () => { calls.responseDestroyed = true; };
      callback(response);
      if (failure === 'response') { response.emit('error', new Error('response failed')); return; }
      if (failure === 'aborted') { response.emit('aborted'); return; }
      for (const chunk of chunks) {
        if (calls.responseDestroyed) break;
        response.emit('data', chunk);
      }
      if (!calls.responseDestroyed) response.emit('end');
    });
    return request;
  };
  return { get, calls };
}

test('Tor list fetch returns a checked valid set using the injected transport', async () => {
  const { fetchTorExitNodes } = require('../jobs/ingest-crawl');
  const { get } = fakeTorRequest({ chunks: ['# exits\n192.0.2.1\n', '198.51.100.2\n192.0.2.1\n'] });
  assert.deepEqual(await fetchTorExitNodes({ get, now: () => NOW }), {
    available: true, checkedAtMs: NOW, ips: new Set(['192.0.2.1', '198.51.100.2']),
  });
});

test('Tor list HTTP, transport, response, timeout and invalid-body failures remain unavailable', async () => {
  const { fetchTorExitNodes } = require('../jobs/ingest-crawl');
  for (const options of [
    { statusCode: 503, chunks: ['192.0.2.1\n'] },
    { failure: 'request' }, { failure: 'response' }, { failure: 'aborted' }, { failure: 'timeout' },
    { chunks: [] }, { chunks: ['# no current data\n'] },
    { chunks: ['<html>service unavailable</html>'] },
    { chunks: ['192.0.2.1\n', 'error response'] },
    { chunks: ['192.0.2.1\n', `#${'a'.repeat(1024 * 1024)}`] },
  ]) {
    const { get, calls } = fakeTorRequest(options);
    assert.deepEqual(await fetchTorExitNodes({ get, now: () => NOW }), {
      available: false, checkedAtMs: NOW, ips: new Set(),
    });
    if (options.statusCode === 503) assert.equal(calls.responseDestroyed, true, 'failed HTTP bodies cannot stream without a bound');
    if (options.failure === 'timeout') assert.equal(calls.requestDestroyed, true);
    if (options.chunks?.some(chunk => Buffer.byteLength(chunk) > 1024 * 1024)) {
      assert.equal(calls.responseDestroyed, true, 'oversized body must stop being read');
    }
  }
});


test('latest census snapshot lookup returns the v3 database observation as a Date', async () => {
  const snapshotTime = new Date(status().snapshotTimeMs);
  const queries = [];
  const pool = { query: async (sql) => {
    queries.push(sql);
    return { rows: [{ snapshot_time: snapshotTime }] };
  } };
  assert.equal(await readLatestTorCensusSnapshot(pool), snapshotTime);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /MAX\(snapshot_time\)/i);
  assert.match(queries[0], /FROM node_snapshots/i);
  assert.match(queries[0], /census_version\s*=\s*3/i);
});

test('latest census snapshot lookup fails closed on missing rows, errors and hung queries', { timeout: 1_000 }, async () => {
  for (const result of [null, {}, { rows: [] }, { rows: [{}] }, { rows: [{ snapshot_time: null }] }]) {
    assert.equal(await readLatestTorCensusSnapshot({ query: async () => result }), null);
  }
  assert.equal(await readLatestTorCensusSnapshot({ query: async () => { throw new Error('database unavailable'); } }), null);
  assert.equal(await readLatestTorCensusSnapshot(null), null);
  assert.equal(await readLatestTorCensusSnapshot({ query: () => new Promise(() => {}) }, { timeoutMs: 10 }), null);
});

function fakeClassificationPublisher({ failure = null } = {}) {
  const { EventEmitter } = require('node:events');
  const redis = new EventEmitter();
  const calls = [];
  redis.isOpen = false;
  redis.connect = async () => {
    calls.push(['connect']);
    if (failure === 'connect-before-open') throw new Error('Redis connection refused');
    redis.isOpen = true;
    if (failure === 'connect') {
      redis.emit('error', new Error('Redis handshake failed'));
      throw new Error('Redis handshake failed');
    }
  };
  redis.set = async (...args) => {
    calls.push(['set', ...args]);
    if (failure === 'set') throw new Error('Redis write failed');
    return 'OK';
  };
  redis.disconnect = async () => {
    calls.push(['disconnect']);
    redis.isOpen = false;
  };
  const createClient = (config) => { calls.push(['createClient', config]); return redis; };
  return { createClient, calls, redis };
}

test('classification publisher uses shared Redis environment, the exact census key and a ten-minute TTL', async () => {
  const previousHost = process.env.REDIS_HOST;
  const previousPort = process.env.REDIS_PORT;
  process.env.REDIS_HOST = 'redis-classification.test.internal';
  process.env.REDIS_PORT = '16379';
  try {
    const value = status();
    const { createClient, calls, redis } = fakeClassificationPublisher();
    assert.equal(await publishTorClassificationStatus(value, { createClient }), true);
    assert.deepEqual(calls, [
      ['createClient', { socket: {
        host: 'redis-classification.test.internal', port: 16379,
        connectTimeout: 1000, reconnectStrategy: false,
      } }],
      ['connect'],
      ['set', TOR_CLASSIFICATION_KEY, JSON.stringify(value), { EX: 600 }],
      ['disconnect'],
    ]);
    assert.equal(redis.isOpen, false);
  } finally {
    if (previousHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = previousHost;
    if (previousPort === undefined) delete process.env.REDIS_PORT;
    else process.env.REDIS_PORT = previousPort;
  }
});

test('classification publisher disconnects after write or partially opened connection failure', async () => {
  for (const failure of ['set', 'connect', 'connect-before-open']) {
    const { createClient, calls, redis } = fakeClassificationPublisher({ failure });
    assert.equal(await publishTorClassificationStatus(status(), { createClient }), false);
    const operations = calls.slice(1).map(([operation]) => operation);
    assert.deepEqual(operations, failure === 'set' ? ['connect', 'set', 'disconnect']
      : failure === 'connect' ? ['connect', 'disconnect'] : ['connect']);
    assert.equal(redis.isOpen, false);
  }
});
