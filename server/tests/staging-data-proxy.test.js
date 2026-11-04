'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function load(file, imports = {}) {
  const filename = path.join(root, file), m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = m.require.bind(m);
  m.require = name => Object.hasOwn(imports, name) ? imports[name] : original(name);
  const source = fs.readFileSync(filename, 'utf8');
  m._compile(file.endsWith('.ts') ? ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText : source, filename);
  return m.exports;
}
const { createStagingDataProxy } = load('lib/staging-data-proxy.js', { 'server-only': {} });
const enabled = { VERCEL_ENV: 'preview', ASK_STAGING_ENABLED: 'true' };
const incoming = (suffix = '/v1/blocks', init = {}) => new Request(`https://review.vercel.app/api/staging-data${suffix}`, init);
function fixture(response = () => Response.json({ data: [] })) {
  const calls = [];
  return { calls, fetch: async (url, options) => { calls.push({ url, options }); return response(url, options); } };
}
function privateResponse(response) {
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
}

test('public data proxy is disabled by default and in production, even with the browser flag set', async () => {
  const f = fixture();
  for (const env of [{}, { NEXT_PUBLIC_ASK_STAGING: 'true' }, { ...enabled, VERCEL_ENV: 'production' }, { ...enabled, VERCEL_ENV: 'development' }, { ...enabled, ASK_STAGING_ENABLED: 'false' }]) {
    const response = await createStagingDataProxy(env, f.fetch)(incoming());
    assert.equal(response.status, 404); privateResponse(response);
  }
  assert.equal(f.calls.length, 0);
});

test('current Ask starter evidence, labels, stats and freshness reads are admitted through exact public GET paths', async () => {
  const { starters } = require('../../lib/ask/contract');
  const { sourceRequest } = require('../../lib/ask/sources');
  const paths = new Set(['/health', '/v1/blocks', '/v1/mempool', '/v1/labels', '/v1/network/price', '/v1/network/stats', '/v1/network/info']);
  for (const starter of starters) { const source = sourceRequest(starter.spec); paths.add(source.path); paths.add(source.legacy); }
  const f = fixture(), proxy = createStagingDataProxy(enabled, f.fetch);
  for (const path of paths) assert.equal((await proxy(incoming(path))).status, 200, path);
  assert.equal(f.calls.length, paths.size);
});

test('Ask, arbitrary API paths, URL targets, encoded separators and path traversal cannot select an upstream route', async () => {
  const f = fixture(), proxy = createStagingDataProxy(enabled, f.fetch);
  for (const suffix of ['/v1/ask', '/v1/ask/chat', '/v1/ask/research/jobs/status', '/api/ask', '/api/private', '/v1/scan', '/v1/labels/private', '/v1/transactions/example', '//elsewhere.test/v1/blocks', '/https://elsewhere.test/v1/blocks', '/v1/%2fblocks', '/v1/%2e%2e/ask', '/v1/blocks/../../ask']) {
    assert.equal((await proxy(incoming(suffix))).status, 404, suffix);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await proxy(incoming('/v1/blocks', { method }))).status, 405);
  assert.equal(f.calls.length, 0);
});

test('queries remain bounded data on the fixed public origin; visitor credentials and origin hints are never forwarded', async () => {
  const f = fixture(() => Response.json({ data: [] }, { status: 429, headers: { 'retry-after': '60', 'set-cookie': 'private=value', location: 'https://elsewhere.test', 'access-control-allow-origin': '*' } }));
  const response = await createStagingDataProxy({ ...enabled, CIPHERSCAN_API_URL: 'https://elsewhere.test', SERVICE_API_KEY: 'private' }, f.fetch)(incoming('/v1/blocks?limit=1&url=https%3A%2F%2Felsewhere.test', { headers: { cookie: 'private=value', authorization: 'Bearer private', origin: 'https://review.vercel.app', 'x-service-key': 'private', 'x-forwarded-for': '192.0.2.7' } }));
  assert.equal(response.status, 429); privateResponse(response);
  assert.equal(response.headers.get('retry-after'), '60');
  for (const header of ['set-cookie', 'location', 'access-control-allow-origin']) assert.equal(response.headers.get(header), null);
  const { url, options } = f.calls[0];
  assert.equal(url.origin, 'https://api.zecblock.com'); assert.equal(url.pathname, '/v1/blocks');
  assert.equal(url.searchParams.get('url'), 'https://elsewhere.test');
  assert.deepEqual(options.headers, { accept: 'application/json' });
  assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store');
  assert.equal((await createStagingDataProxy(enabled, f.fetch)(incoming('/v1/blocks?q=' + 'x'.repeat(4096)))).status, 414);
  assert.equal(f.calls.length, 1);
});

test('one MiB JSON response limit applies to declared and streamed bytes, including the exact boundary', async () => {
  const max = 1024 * 1024;
  for (const [size, status] of [[max, 200], [max + 1, 502]]) {
    const f = fixture(() => new Response(JSON.stringify('x'.repeat(size - 2)), { headers: { 'content-type': 'application/json' } }));
    assert.equal((await createStagingDataProxy(enabled, f.fetch)(incoming())).status, status);
    assert.equal(f.calls[0].options.signal.aborted, true);
  }
  const f = fixture(() => Response.json({}, { headers: { 'content-length': String(max + 1) } }));
  assert.equal((await createStagingDataProxy(enabled, f.fetch)(incoming())).status, 502);
});

test('public API quota problem JSON preserves status, code and Retry-After without forwarding other headers', async () => {
  const problem = { type: 'rate-limit', code: 'request-limit', detail: 'Request limit reached.' };
  const f = fixture(() => new Response(JSON.stringify(problem), { status: 429, headers: { 'content-type': 'application/problem+json; charset=utf-8', 'retry-after': '60', 'set-cookie': 'private=value' } }));
  const response = await createStagingDataProxy(enabled, f.fetch)(incoming());
  assert.equal(response.status, 429); privateResponse(response);
  assert.equal(response.headers.get('content-type'), 'application/problem+json'); assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(response.headers.get('set-cookie'), null); assert.deepEqual(await response.json(), problem);
});

test('redirects, non-JSON, malformed JSON and upstream errors produce a safe bounded failure', async () => {
  for (const response of [
    () => new Response('{}', { status: 302, headers: { 'content-type': 'application/json', location: 'https://elsewhere.test' } }),
    () => new Response('<html>private upstream</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => { throw Error('private upstream credential'); },
  ]) {
    const f = fixture(response), result = await createStagingDataProxy(enabled, f.fetch)(incoming());
    assert.equal(result.status, 502); privateResponse(result);
    assert.doesNotMatch(await result.text(), /private upstream|credential|elsewhere/);
    assert.equal(f.calls.length, 1);
  }
});

test('client cancellation and the overall deadline abort both pending fetches and stalled response bodies', async () => {
  const controller = new AbortController(), f = fixture(() => new Promise(() => {}));
  const pending = createStagingDataProxy(enabled, f.fetch)(incoming('/v1/blocks', { signal: controller.signal }));
  controller.abort(); assert.equal((await pending).status, 499); assert.equal(f.calls[0].options.signal.aborted, true);
  const preaborted = fixture();
  assert.equal((await createStagingDataProxy(enabled, preaborted.fetch)(incoming('/v1/blocks', { signal: controller.signal }))).status, 499);
  assert.equal(preaborted.calls.length, 0);
  let cancelled = false;
  const stalled = fixture(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
  const result = await createStagingDataProxy(enabled, stalled.fetch, 10)(incoming());
  assert.equal(result.status, 504); assert.equal(stalled.calls[0].options.signal.aborted, true); assert.equal(cancelled, true);
});

test('browser mainnet staging base changes independently of SSR and keeps the dedicated Ask transport', t => {
  const keys = ['NEXT_PUBLIC_ASK_STAGING', 'CIPHERSCAN_API_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_NETWORK'];
  const before = keys.map(key => process.env[key]), previousWindow = global.window;
  t.after(() => { keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; }); if (previousWindow === undefined) delete global.window; else global.window = previousWindow; });
  process.env.NEXT_PUBLIC_NETWORK = 'mainnet';
  process.env.CIPHERSCAN_API_URL = 'https://server.invalid';
  process.env.NEXT_PUBLIC_API_URL = 'https://browser.invalid';
  const network = load('lib/network.ts');
  const config = load('lib/api-config.ts', { '@/lib/network': network });
  process.env.NEXT_PUBLIC_ASK_STAGING = 'true'; delete global.window;
  assert.equal(config.getApiUrlForNetwork('mainnet'), 'https://server.invalid');
  global.window = { location: { hostname: 'review.vercel.app', origin: 'https://review.vercel.app' } };
  assert.equal(config.getApiUrlForNetwork('mainnet'), '/api/staging-data');
  assert.equal(config.getApiUrlForNetwork('testnet'), 'https://browser.invalid');
  const ask = load('lib/ask/api-base.ts', { '@/lib/api-config': config });
  assert.equal(ask.getAskApiUrl(), '/api/ask-staging/v1/ask');
  process.env.NEXT_PUBLIC_ASK_STAGING = 'false';
  assert.equal(config.getApiUrlForNetwork('mainnet'), 'https://browser.invalid');
  delete process.env.NEXT_PUBLIC_API_URL;
  assert.equal(config.getApiUrlForNetwork('mainnet'), 'https://api.zecblock.com');
  assert.equal(config.getApiUrlForNetwork('testnet'), 'https://api.testnet.zecblock.com');
});

test('data route keeps the server-only boundary and rejects non-GET methods through the same handler', () => {
  const proxy = () => Response.json({ fixture: true });
  const handlers = load('app/api/staging-data/[[...path]]/route.ts', { 'server-only': {}, '@/lib/staging-data-proxy': { proxyStagingData: proxy } });
  assert.equal(handlers.runtime, 'nodejs');
  for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) assert.equal(handlers[method], proxy);
  assert.match(fs.readFileSync(path.join(root, 'lib/staging-data-proxy.js'), 'utf8'), /require\('server-only'\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'lib/api-config.ts'), 'utf8'), /staging-data-proxy/);
});
