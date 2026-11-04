const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const ts = require('typescript');

const API = 'https://api.example.test';
const SENTINEL = 'service-header-test-sentinel';
function load({ apiUrl = API, key = SENTINEL, configError = false } = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/server-fetch.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, URL, Request, Headers, AbortController, DOMException, setTimeout, clearTimeout, fetch,
    process: { env: { SERVICE_API_KEY: key } },
    require: name => {
      if (name === 'next/constants') return { PHASE_PRODUCTION_BUILD: 'phase-production-build' };
      if (name === '@/lib/api-client') return { readApiData: async response => (await response.json()).data };
      if (name === './api-config') return { getApiUrl: () => { if (configError) throw new Error('Invalid configuration'); return apiUrl; } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return exports;
}
async function capture(helper, input, init = {}) {
  let captured;
  await helper.fetchWithDeadline(input, init, 100, async (target, options) => {
    const request = new Request(target, options);
    captured = { url: request.url, headers: request.headers, redirect: request.redirect, options };
    return new Response('{}');
  });
  return captured;
}

test('only the exact configured HTTP origin receives the service credential for string, URL and Request inputs', async () => {
  const helper = load();
  for (const input of [`${API}/v1/network/stats`, new URL(`${API}/v1/network/stats`), new Request(`${API}/v1/network/stats`), 'https://API.EXAMPLE.TEST:443/v1/network/stats']) {
    const result = await capture(helper, input, { headers: { Accept: 'application/json' } });
    assert.equal(result.headers.get('x-service-key'), SENTINEL);
    assert.equal(result.headers.get('accept'), 'application/json');
    assert.equal(result.redirect, 'error');
  }
});

test('public, peer, spoofed, downgraded and different-port destinations never receive an explicit or injected service key', async () => {
  const helper = load();
  const destinations = [
    'https://prod.vote-chain-primary.valargroup.org/shielded-vote/v1/rounds',
    'https://api.peer.example.test/v1/network/stats',
    'https://api.example.test.attacker.invalid/v1/network/stats',
    'blob:https://api.example.test/test-object',
    'http://api.example.test/v1/network/stats',
    'https://api.example.test:8443/v1/network/stats',
  ];
  for (const url of destinations) {
    for (const input of [url, new URL(url), new Request(url, { headers: { 'X-Service-Key': SENTINEL, Accept: 'application/json' } })]) {
      const result = await capture(helper, input);
      assert.equal(result.headers.has('x-service-key'), false);
      if (input instanceof Request) assert.equal(result.headers.get('accept'), 'application/json');
    }
    const result = await capture(helper, url, { headers: { 'X-Service-Key': SENTINEL, 'X-Correlation-Id': 'test-id' } });
    assert.equal(result.headers.has('x-service-key'), false);
    assert.equal(result.headers.get('x-correlation-id'), 'test-id');
  }
});

test('userinfo-bearing URL inputs cannot authorize a service header', async () => {
  const helper = load();
  for (const url of ['https://api.example.test@attacker.invalid/v1/network/stats', 'https://test-user:test-password@api.example.test/v1/network/stats']) {
    for (const input of [url, new URL(url)]) {
      let headers;
      await helper.fetchWithDeadline(input, { headers: { 'x-service-key': SENTINEL, Accept: 'application/json' } }, 100, async (_target, options) => {
        headers = new Headers(options.headers);
        return new Response('{}');
      });
      assert.equal(headers.has('x-service-key'), false);
      assert.equal(headers.get('accept'), 'application/json');
    }
  }
});

test('a URL object is snapshotted before origin validation and dispatch', async () => {
  const url = new URL('https://public.example.test/data');
  let reads = 0;
  url.toString = () => (++reads === 1 ? `${API}/v1/network/stats` : 'https://public.example.test/data');
  const result = await capture(load(), url);
  assert.equal(reads, 1);
  assert.equal(result.url, `${API}/v1/network/stats`);
  assert.equal(result.headers.get('x-service-key'), SENTINEL);
});

test('Request headers are preserved without mutation and explicit RequestInit headers retain native replacement semantics', async () => {
  const helper = load();
  const request = new Request('https://public.example.test/data', { headers: { 'x-service-key': SENTINEL, Accept: 'application/json', 'X-Request-Only': 'retained' } });
  const result = await capture(helper, request);
  assert.equal(result.headers.has('x-service-key'), false);
  assert.equal(result.headers.get('x-request-only'), 'retained');
  assert.equal(request.headers.get('x-service-key'), SENTINEL);

  const headers = new Headers({ 'x-service-key': SENTINEL, 'X-Init-Only': 'replacement' });
  const replacement = await capture(helper, request, { headers });
  assert.equal(replacement.headers.has('x-service-key'), false);
  assert.equal(replacement.headers.has('x-request-only'), false);
  assert.equal(replacement.headers.get('x-init-only'), 'replacement');
  assert.equal(headers.get('x-service-key'), SENTINEL);
});

test('a shadowed Request URL cannot grant trust to its actual public destination', async () => {
  const request = new Request('https://public.example.test/data', { headers: { Accept: 'application/json', 'x-service-key': SENTINEL } });
  Object.defineProperty(request, 'url', { value: `${API}/v1/network/stats` });
  const result = await capture(load(), request);
  assert.equal(result.url, 'https://public.example.test/data');
  assert.equal(result.headers.has('x-service-key'), false);
  assert.equal(result.headers.get('accept'), 'application/json');
});

test('invalid configured API URLs fail closed and never authorize a service header', async () => {
  for (const apiUrl of ['', 'not-a-url', '//api.example.test', 'data:text/plain,test', 'ftp://api.example.test', 'https://user:password@api.example.test']) {
    const result = await capture(load({ apiUrl }), `${API}/v1/network/stats`, { headers: { 'x-service-key': SENTINEL, Accept: 'application/json' } });
    assert.equal(result.headers.has('x-service-key'), false);
    assert.equal(result.headers.get('accept'), 'application/json');
  }
  const result = await capture(load({ configError: true }), `${API}/v1/network/stats`, { headers: { 'x-service-key': SENTINEL } });
  assert.equal(result.headers.has('x-service-key'), false);
});

test('explicit own-API keys are preserved and redirects are refused even when follow was requested', async () => {
  const helper = load();
  const own = await capture(helper, `${API}/v1/network/stats`, { headers: { 'x-service-key': 'caller-test-sentinel' }, redirect: 'follow' });
  assert.equal(own.headers.get('x-service-key'), 'caller-test-sentinel');
  assert.equal(own.redirect, 'error');
  const explicit = await capture(load({ key: '' }), new Request(`${API}/v1/network/stats`, { headers: { 'x-service-key': SENTINEL } }));
  assert.equal(explicit.headers.get('x-service-key'), SENTINEL);
  assert.equal(explicit.redirect, 'error');
  const noKey = await capture(load({ key: '' }), `${API}/v1/network/stats`, { redirect: 'follow' });
  assert.equal(noKey.headers.has('x-service-key'), false);
  assert.equal(noKey.redirect, 'follow');
});

test('HTTP loopback API origins honor their configured port and preserve unrelated fetch options', async () => {
  const helper = load({ apiUrl: 'http://127.0.0.1:3100/v1' });
  const headers = new Headers({ Accept: 'application/json', 'X-Correlation-Id': 'test-id' });
  const options = { headers, method: 'POST', body: '{}', cache: 'no-store', next: { revalidate: 0, tags: ['test'] } };
  const own = await capture(helper, 'http://127.0.0.1:3100/v1/example', options);
  assert.equal(own.headers.get('x-service-key'), SENTINEL);
  assert.equal(own.options.method, 'POST');
  assert.equal(own.options.body, '{}');
  assert.equal(own.options.cache, 'no-store');
  assert.equal(own.options.next, options.next);
  assert.equal(headers.has('x-service-key'), false);
  const other = await capture(helper, 'http://127.0.0.1:3101/v1/example', { headers: { 'x-service-key': SENTINEL } });
  assert.equal(other.headers.has('x-service-key'), false);
});

test('a key-bearing local redirect cannot forward its credential to another origin', { timeout: 5000 }, async t => {
  let targetHits = 0;
  let apiHits = 0;
  let apiReceivedSentinel = false;
  const target = http.createServer((_req, res) => { targetHits++; res.end('{}'); });
  const api = http.createServer((req, res) => {
    apiHits++;
    apiReceivedSentinel = req.headers['x-service-key'] === SENTINEL;
    res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/target` });
    res.end();
  });
  for (const server of [target, api]) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  }
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  await assert.rejects(load({ apiUrl }).fetchWithDeadline(`${apiUrl}/start`, { redirect: 'follow' }, 1000));
  assert.equal(apiHits, 1);
  assert.equal(apiReceivedSentinel, true);
  assert.equal(targetHits, 0);
});
