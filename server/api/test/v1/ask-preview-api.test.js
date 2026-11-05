'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { once } = require('node:events');
const { createPrivatePreview, DUMMY_SITE_KEY } = require('../../ask-preview-api');
const { sendSuccess } = require('../../v1/lib/envelope');

const privateEnv = { ASK_PRIVATE_PREVIEW: 'true', ASK_TURNSTILE_HOSTNAME: 'localhost' };
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function request(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method, agent: false,
      headers: { Host: '127.0.0.1:3004', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function serve(t, { env = {}, handler = (req, res) => sendSuccess(res, {
  question: req.body?.question ?? null, ip: req.ip, socketIp: req.socket.remoteAddress,
}) } = {}) {
  // Deliberately no Redis methods: this fixture must never contact a real store.
  const redis = Object.freeze({ isReady: true });
  const state = { dispatched: 0, signals: [], stopped: 0 };
  const preview = createPrivatePreview({ ...privateEnv, ...env }, {
    redis,
    routerFactory: (config, dependencies) => {
      state.config = config; state.dependencies = dependencies;
      const router = express.Router();
      router.all('/', (req, res) => {
        state.dispatched++; state.signals.push(req.v1.abortSignal);
        handler(req, res);
      });
      router.stop = () => { state.stopped++; };
      return router;
    },
  });
  const server = preview.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await preview.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(state.stopped, 1);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, state, redis };
}

function assertPrivate(response) {
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(response.headers['x-powered-by'], undefined);
}

test('private Ask preview requires the exact explicit flag and an injected Redis client', () => {
  const routerFactory = () => assert.fail('Invalid startup configuration reached the router');
  for (const flag of [undefined, '', 'false', 'TRUE', 'true ', true]) {
    assert.throws(() => createPrivatePreview({ ASK_PRIVATE_PREVIEW: flag }, { redis: {}, routerFactory }), /Explicit private preview required/);
  }
  assert.throws(() => createPrivatePreview(privateEnv, { routerFactory }), /Explicit private preview required/);
});

test('known database and RPC credential aliases are refused before preview routing is constructed', () => {
  const routerFactory = () => assert.fail('Credential-bearing environment reached the router');
  // DB_PASSWORD configures both db-pool.js readers; REPLICA_DATABASE_URL is
  // pool-routing.js's separate connection-string configuration.
  for (const key of ['DATABASE_URL', 'REPLICA_DATABASE_URL', 'DB_PASSWORD', 'PGPASSWORD', 'ASK_ANALYTICS_DATABASE_URL', 'ZCASH_RPC_PASSWORD']) {
    assert.throws(() => createPrivatePreview({ ...privateEnv, [key]: 'test-only-placeholder' }, { redis: {}, routerFactory }), /Database\/RPC credentials/);
  }
});

test('provider, worker and quota credentials remain available to private preview routing', async t => {
  const credentials = {
    ASK_API_KEY: 'test-only-provider-key',
    ASK_ANALYTICS_SERVICE_KEY: 'test-only-worker-key',
    ASK_ANALYTICS_REDIS_URL: 'redis://test-only:quota-key@127.0.0.1:6391',
  };
  const { url, state } = await serve(t, { env: credentials });
  for (const [key, value] of Object.entries(credentials)) assert.equal(state.config[key], value);
  assert.equal((await request(url + '/v1/ask')).status, 200);
  assert.equal(state.dispatched, 1);
});

test('preview fixtures use the dummy challenge key and cannot dispatch indexed-record reads', async t => {
  const { state, redis } = await serve(t, { env: { ASK_TURNSTILE_SITE_KEY: 'replaced-test-key' } });
  assert.equal(state.config.ASK_TURNSTILE_SITE_KEY, DUMMY_SITE_KEY);
  assert.equal(state.dependencies.redis, redis);
  const challenge = await state.dependencies.challengeFetch();
  assert.equal(challenge.ok, true);
  assert.deepEqual(await challenge.json(), { success: true, action: 'ask', hostname: 'localhost' });
  await assert.rejects(state.dependencies.internalClient.dispatch('GET', '/api/network/stats'), /Indexed record source is not configured/);
});

test('valid questions reach the Ask router with a fresh UUID and a complete private v1 envelope', async t => {
  const { url, state } = await serve(t);
  const question = 'Compare observed Orchard flows for September 2026.';
  const responses = [];
  for (let i = 0; i < 2; i++) {
    const response = await request(url + '/v1/ask', {
      method: 'POST', headers: { Origin: 'http://localhost:3003', 'X-Request-Id': 'untrusted-client-id' }, body: { question },
    });
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.equal(response.body.data.question, question);
    assert.match(response.headers['x-request-id'], uuidV4);
    assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
    assert.equal(response.body.meta.network, 'mainnet');
    assert.equal(response.body.meta.indexedHeight, null);
    assert.equal(response.body.meta.freshness.status, 'unknown');
    assert.ok(Number.isFinite(Date.parse(response.body.meta.generatedAt)));
    responses.push(response);
  }
  assert.notEqual(responses[0].headers['x-request-id'], responses[1].headers['x-request-id']);
  assert.equal(state.dispatched, 2);
  for (const signal of state.signals) { assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); }
});

test('the loopback hosts accept their browser origins and origin-free local requests', async t => {
  const { url } = await serve(t);
  for (const headers of [
    { Host: '127.0.0.1:3004' },
    { Host: 'localhost:3004' },
    { Host: '127.0.0.1:3004', Origin: 'http://127.0.0.1:3003' },
    { Host: 'localhost:3004', Origin: 'http://localhost:3003' },
  ]) {
    const response = await request(url + '/v1/ask', { headers });
    assert.equal(response.status, 200); assertPrivate(response);
  }
});

test('foreign hosts, rebinding hosts and foreign origins cannot reach the Ask router', async t => {
  const { url, state } = await serve(t);
  for (const headers of [
    { Host: 'attacker.example:3004' },
    { Host: 'localhost.attacker.example:3004' },
    { Host: 'localhost:3003' },
    { Host: '127.0.0.1:80' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { Origin: 'http://localhost:3004' },
    { Origin: 'http://localhost:3003/' },
  ]) {
    const response = await request(url + '/v1/ask', { headers });
    assert.equal(response.status, 403); assertPrivate(response);
    assert.deepEqual(response.body, { error: 'private-preview-only' });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(state.dispatched, 0);
});

test('malformed JSON, oversized bodies and missing routes remain private without dispatch', async t => {
  const { url, state } = await serve(t);
  for (const [body, status] of [['{', 400], [JSON.stringify({ question: 'x'.repeat(17000) }), 413]]) {
    const response = await request(url + '/v1/ask', { method: 'POST', body });
    assert.equal(response.status, status); assertPrivate(response);
    assert.deepEqual(response.body, { error: 'invalid-request' });
  }
  const missing = await request(url + '/not-an-ask-route');
  assert.equal(missing.status, 404); assertPrivate(missing);
  assert.deepEqual(missing.body, { error: 'not-found' });
  assert.equal(state.dispatched, 0);
});

test('simulated and forwarded IP headers are ignored without the exact fixture switch', async t => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    const { url } = await serve(t, { env: { ASK_PREVIEW_SIMULATE_IPS: flag } });
    const response = await request(url + '/v1/ask', { headers: { 'X-Sim-IP': '198.18.1.2', 'X-Forwarded-For': '203.0.113.9' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.ip, '127.0.0.1');
    assert.equal(response.body.data.ip, response.body.data.socketIp);
  }
});

test('the explicit IP fixture switch accepts only valid IPv4 addresses in its reserved range', async t => {
  const { url } = await serve(t, { env: { ASK_PREVIEW_SIMULATE_IPS: 'true' } });
  for (const ip of ['198.18.0.0', '198.18.1.2', '198.18.255.255']) {
    const response = await request(url + '/v1/ask', { headers: { 'X-Sim-IP': ip } });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.ip, ip);
    assert.equal(response.body.data.socketIp, '127.0.0.1');
  }
  for (const ip of ['198.18.256.1', '198.18.1.999', '198.18.01.2', '198.19.1.2', '203.0.113.9', '127.0.0.1', '::1', '198.18.1.2, 198.18.1.3', '198.18.1.2.attacker.example']) {
    const response = await request(url + '/v1/ask', { headers: { 'X-Sim-IP': ip } });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.ip, response.body.data.socketIp, ip);
  }
});

test('a browser disconnect aborts the signal supplied to its pending Ask operation', { timeout: 3000 }, async t => {
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const { url } = await serve(t, { handler: req => entered(req.v1.abortSignal) });
  const client = http.request(url + '/v1/ask', { headers: { Host: 'localhost:3004' }, agent: false });
  client.on('error', () => {}); // Destroying the browser socket intentionally resets the request.
  t.after(() => client.destroy());
  client.end();
  const signal = await reached;
  assert.equal(signal.aborted, false);
  const cancelled = once(signal, 'abort', { signal: AbortSignal.timeout(2000) });
  client.destroy();
  await cancelled;
  assert.equal(signal.aborted, true);
});

test('closing a completed browser connection does not abort a successful Ask operation', async t => {
  const { url, state } = await serve(t);
  const response = await request(url + '/v1/ask');
  assert.equal(response.status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.signals[0].aborted, false);
});
