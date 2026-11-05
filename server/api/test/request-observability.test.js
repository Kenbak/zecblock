'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRequestObservability, finiteNonNegativeInteger } = require('../request-observability');
const { addRequestTiming } = require('../request-timing-context');

function responseRecorder() {
  const headers = new Map();
  return {
    headersSent: false,
    set(name, value) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    get(name) {
      return headers.get(name.toLowerCase());
    },
    end(value) {
      this.body = value;
      return this;
    },
    headers,
  };
}

test('finiteNonNegativeInteger rejects unsafe, negative, and non-integer values', () => {
  assert.equal(finiteNonNegativeInteger(0), 0);
  assert.equal(finiteNonNegativeInteger('12'), 12);
  assert.equal(finiteNonNegativeInteger(-1), null);
  assert.equal(finiteNonNegativeInteger(1.5), null);
  assert.equal(finiteNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(finiteNonNegativeInteger(Infinity), null);
});

test('middleware emits only aggregate freshness and timing headers', () => {
  const times = [100, 112.34];
  const middleware = createRequestObservability({
    getIndexedHeight: () => 3_470_000,
    getDataAgeBlocks: () => 1,
    createRequestId: () => 'request-id',
    now: () => times.shift(),
  });
  const req = { path: `/api/address/${'a'.repeat(64)}` };
  const res = responseRecorder();

  middleware(req, res, () => {});
  res.end('ok');

  assert.equal(req.requestId, 'request-id');
  assert.equal(res.get('x-request-id'), 'request-id');
  assert.equal(res.get('x-cipherscan-indexed-height'), '3470000');
  assert.equal(res.get('x-cipherscan-data-age-blocks'), '1');
  assert.equal(res.get('x-zecblock-indexed-height'), '3470000');
  assert.equal(res.get('x-zecblock-data-age-blocks'), '1');
  assert.equal(res.get('server-timing'), 'app;dur=12.3');
  assert.equal(JSON.stringify([...res.headers]), JSON.stringify([...res.headers]).replace('a'.repeat(64), ''));
});

test('middleware appends total timing and omits unavailable freshness values', () => {
  const times = [10, 15];
  const middleware = createRequestObservability({
    getIndexedHeight: () => null,
    getDataAgeBlocks: () => Infinity,
    createRequestId: () => 'request-id',
    now: () => times.shift(),
  });
  const req = {};
  const res = responseRecorder();
  res.set('Server-Timing', 'cache;dur=1.0');

  middleware(req, res, () => {});
  res.end();

  assert.equal(res.get('server-timing'), 'cache;dur=1.0, app;dur=5.0');
  assert.equal(res.get('x-cipherscan-indexed-height'), undefined);
  assert.equal(res.get('x-cipherscan-data-age-blocks'), undefined);
  assert.equal(res.get('x-zecblock-indexed-height'), undefined);
});

test('middleware appends aggregate request timings without query details', () => {
  const times = [20, 30];
  const middleware = createRequestObservability({
    createRequestId: () => 'request-id',
    now: () => times.shift(),
  });
  const req = {};
  const res = responseRecorder();

  middleware(req, res, () => {
    addRequestTiming('database', 4.25);
    addRequestTiming('database', 1.25);
    addRequestTiming('serialize', 0.75);
    res.end();
  });

  assert.equal(
    res.get('server-timing'),
    'database;dur=5.5, serialize;dur=0.8, app;dur=10.0',
  );
  assert.equal(res.get('server-timing').includes('SELECT'), false);
});
