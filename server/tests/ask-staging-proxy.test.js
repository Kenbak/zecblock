'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
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
const { createStagingProxy } = load('lib/ask/staging-proxy.js', { 'server-only': {} });
const enabled = {
  VERCEL: '1', VERCEL_ENV: 'preview', ASK_STAGING_ENABLED: 'true',
  ASK_STAGING_ORIGIN: 'https://135.181.17.198:8443',
  ASK_STAGING_CA_PEM: 'fixture-ca', ASK_STAGING_CLIENT_CERT_PEM: 'fixture-cert', ASK_STAGING_CLIENT_KEY_PEM: 'fixture-key',
};
function incoming(path = '/chat', { body = '{}', headers = {}, signal, method = 'POST' } = {}) {
  return new Request(`https://review.vercel.app/api/ask-staging/v1/ask${path}`, {
    method, headers: { 'content-type': 'application/json', origin: 'https://review.vercel.app', 'sec-fetch-site': 'same-origin', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }), signal,
  });
}
function fixture({ status = 200, body = '{"data":{}}', headers = {}, error, hang = false } = {}) {
  const calls = [];
  function transport(url, options, receive) {
    const req = new EventEmitter(), call = { url, options, destroyed: false };
    calls.push(call);
    req.destroy = () => { call.destroyed = true; };
    req.end = payload => {
      call.body = payload;
      queueMicrotask(() => {
        if (error) { req.emit('error', Object.assign(Error('private TLS detail'), { code: error })); return; }
        if (hang) return;
        const response = new PassThrough(); call.response = response;
        response.statusCode = status;
        response.headers = { 'content-type': 'application/json', ...headers };
        receive(response);
        queueMicrotask(() => { if (!response.destroyed) response.end(body); });
      });
    };
    return req;
  }
  return { transport, calls };
}
function privateResponse(response) {
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
}

test('gateway is off by default and refuses production, nonfixed origins and missing TLS material before transport', async () => {
  const f = fixture();
  for (const env of [{}, { ...enabled, ASK_STAGING_ENABLED: 'false' }, { ...enabled, VERCEL_ENV: 'production' }, { ...enabled, VERCEL_ENV: 'development' },
    { ...enabled, ASK_STAGING_ORIGIN: 'http://135.181.17.198:8443' }, { ...enabled, ASK_STAGING_ORIGIN: 'https://elsewhere.test' },
    { ...enabled, ASK_STAGING_ORIGIN: 'https://135.181.17.198:8443/path' }, { ...enabled, ASK_STAGING_ORIGIN: 'https://user@135.181.17.198:8443' },
    ...['ASK_STAGING_CA_PEM', 'ASK_STAGING_CLIENT_CERT_PEM', 'ASK_STAGING_CLIENT_KEY_PEM'].map(key => ({ ...enabled, [key]: '' }))]) {
    const response = await createStagingProxy(env, f.transport)(incoming());
    assert.equal(response.status, 404); privateResponse(response);
  }
  assert.equal(f.calls.length, 0);
});

test('only capability GET and exact Ask POST paths are admitted; query, origin and cross-site variants fail', async () => {
  const f = fixture(), proxy = createStagingProxy(enabled, f.transport);
  for (const [request, status] of [
    [incoming('/chat', { method: 'GET' }), 405], [incoming('', { body: '{}' }), 405], [incoming('/chat', { method: 'PUT' }), 405],
    [incoming('/unknown'), 404], [incoming('/chat?target=https://elsewhere.test'), 404],
    [incoming('/chat', { headers: { origin: 'https://elsewhere.test' } }), 403],
    [incoming('/chat', { headers: { origin: 'https://review.vercel.app.evil.test' } }), 403],
    [incoming('/chat', { headers: { origin: 'null' } }), 403],
    [incoming('/chat', { headers: { 'sec-fetch-site': 'cross-site' } }), 403],
    [incoming('/chat', { headers: { 'content-type': 'text/plain' } }), 415],
  ]) { const response = await proxy(request); assert.equal(response.status, status); privateResponse(response); }
  assert.equal(f.calls.length, 0);
  for (const path of ['/chat', '/research/plan', '/research/query', '/research/jobs', '/research/jobs/status', '/research/jobs/cancel', '/research/jobs/explain', '/feedback']) assert.equal((await proxy(incoming(path))).status, 200);
  assert.equal((await proxy(incoming('', { method: 'GET' }))).status, 200);
  assert.equal(f.calls.length, 9);
});

test('mTLS and strict IP SAN checks remain enabled; upstream request and response headers use allowlists', async () => {
  const f = fixture({ status: 429, headers: { 'retry-after': '60', 'set-cookie': 'secret=value', 'access-control-allow-origin': '*', location: 'https://elsewhere.test' } });
  const response = await createStagingProxy(enabled, f.transport)(incoming('/chat', { headers: {
    cookie: 'session=private', authorization: 'Bearer private', 'x-forwarded-for': '192.0.2.99', 'x-sim-ip': '192.0.2.98',
    'x-ask-staging-client-ip': '192.0.2.97', 'x-vercel-forwarded-for': '203.0.113.7',
  } }));
  assert.equal(response.status, 429); privateResponse(response);
  assert.equal(response.headers.get('retry-after'), '60');
  for (const name of ['set-cookie', 'location', 'access-control-allow-origin']) assert.equal(response.headers.get(name), null);
  const { url, options, body } = f.calls[0];
  assert.equal(url.href, 'https://135.181.17.198:8443/v1/ask/chat');
  assert.deepEqual(options.headers, { accept: 'application/json', host: '135.181.17.198:8443', 'x-ask-staging-client-ip': '203.0.113.7', 'content-type': 'application/json', 'content-length': '2' });
  assert.equal(body.toString(), '{}');
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.minVersion, 'TLSv1.2');
  assert.equal(options.ca, enabled.ASK_STAGING_CA_PEM); assert.equal(options.cert, enabled.ASK_STAGING_CLIENT_CERT_PEM); assert.equal(options.key, enabled.ASK_STAGING_CLIENT_KEY_PEM);
  assert.equal(Object.hasOwn(options, 'checkServerIdentity'), false);
  assert.equal(options.agent, false);
});

test('only a valid platform IP on Vercel receives a separate admission identity; missing, lists and spoofed hints share one bucket', async () => {
  for (const [env, value, expected] of [
    [enabled, '2001:db8::7', '2001:db8::7'], [enabled, '', '198.18.0.1'], [enabled, '203.0.113.1, 203.0.113.2', '198.18.0.1'],
    [enabled, 'invalid', '198.18.0.1'], [{ ...enabled, VERCEL: undefined }, '203.0.113.7', '198.18.0.1'],
  ]) {
    const f = fixture();
    await createStagingProxy(env, f.transport)(incoming('/chat', { headers: { 'x-vercel-forwarded-for': value, 'x-forwarded-for': '203.0.113.3' } }));
    assert.equal(f.calls[0].options.headers['x-ask-staging-client-ip'], expected);
  }
});

test('request bodies are bounded before transport and malformed JSON is rejected', async () => {
  const f = fixture(), proxy = createStagingProxy(enabled, f.transport);
  for (const request of [incoming('/chat', { body: 'x'.repeat(16385) }), incoming('/chat', { headers: { 'content-length': '16385' } })]) assert.equal((await proxy(request)).status, 413);
  assert.equal((await proxy(incoming('/chat', { body: '{broken' }))).status, 400);
  assert.equal(f.calls.length, 0);
});

test('Ask quota problem JSON preserves the status, code and retry time through the mTLS bridge', async () => {
  const problem = { type: 'rate-limit', code: 'ask-quota-minute', detail: 'Request limit reached.' };
  const f = fixture({ status: 429, body: JSON.stringify(problem), headers: { 'content-type': 'application/problem+json; charset=utf-8', 'retry-after': '60' } });
  const response = await createStagingProxy(enabled, f.transport)(incoming());
  assert.equal(response.status, 429); privateResponse(response);
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await response.json(), problem);
});

test('monthly quota retry windows survive the bridge while invalid or unbounded values are discarded', async () => {
  for (const [value,expected] of [['2678400','2678400'],['100000','100000'],['0',null],['2678401',null],['-1',null],['Infinity',null],['999999999',null]]) {
    const problem={code:'ask-ai-budget-month',detail:'Monthly AI allowance reached.'};
    const f=fixture({status:429,body:JSON.stringify(problem),headers:{'content-type':'application/problem+json','retry-after':value}});
    const response=await createStagingProxy(enabled,f.transport)(incoming());
    assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),expected);assert.deepEqual(await response.json(),problem);
  }
});

test('TLS failures, redirects, non-JSON and oversized upstream replies fail safely without following a location', async () => {
  for (const options of [
    { error: 'ERR_TLS_CERT_ALTNAME_INVALID' }, { error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    { status: 302, headers: { location: 'https://elsewhere.test' } }, { status: 205 }, { headers: { 'content-type': 'text/html' } },
    { body: '{invalid' }, { body: 'x'.repeat(307201) }, { headers: { 'content-length': '307201' } },
  ]) {
    const f = fixture(options), response = await createStagingProxy(enabled, f.transport)(incoming());
    assert.equal(response.status, 502); privateResponse(response); assert.equal(f.calls.length, 1);
    assert.doesNotMatch(await response.text(), /private TLS|fixture-(?:ca|cert|key)|elsewhere/);
    assert.equal(f.calls[0].destroyed, true);
  }
});

test('client cancellation and the overall deadline stop upstream work, including stalled request bodies', async () => {
  const controller = new AbortController(), f = fixture({ hang: true });
  const pending = createStagingProxy(enabled, f.transport)(incoming('/chat', { signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal((await pending).status, 499); assert.equal(f.calls[0].destroyed, true);
  const timed = fixture({ hang: true });
  assert.equal((await createStagingProxy(enabled, timed.transport, 10)(incoming())).status, 504);
  assert.equal(timed.calls[0].destroyed, true);
  const untouched = fixture();
  const stalled = new Request('https://review.vercel.app/api/ask-staging/v1/ask/chat', { method: 'POST', headers: { origin: 'https://review.vercel.app', 'content-type': 'application/json' }, body: new ReadableStream({}), duplex: 'half' });
  assert.equal((await createStagingProxy(enabled, untouched.transport, 10)(stalled)).status, 504);
  assert.equal(untouched.calls.length, 0);
});

test('client staging switch affects only Ask and bypasses challenge only with authenticated capability', t => {
  const original = process.env.NEXT_PUBLIC_ASK_STAGING;
  t.after(() => { if (original === undefined) delete process.env.NEXT_PUBLIC_ASK_STAGING; else process.env.NEXT_PUBLIC_ASK_STAGING = original; });
  const api = load('lib/ask/api-base.ts', { '@/lib/api-config': { getApiUrl: () => 'https://public.invalid' } });
  for (const value of [undefined, 'false', 'true']) {
    if (value === undefined) delete process.env.NEXT_PUBLIC_ASK_STAGING; else process.env.NEXT_PUBLIC_ASK_STAGING = value;
    assert.equal(api.getAskApiUrl(), value === 'true' ? '/api/ask-staging/v1/ask' : 'https://public.invalid/v1/ask');
    assert.equal(api.isAuthenticatedAskStaging({ authenticatedStaging: true }), value === 'true');
    assert.equal(api.isAuthenticatedAskStaging({}), false);
    assert.equal(api.isAuthenticatedAskStaging({ authenticatedStaging: false }), false);
  }
});

test('route imports the server-only boundary; browser Ask modules never import the gateway or credentials', () => {
  const route = fs.readFileSync(path.join(root, 'app/api/ask-staging/[[...path]]/route.ts'), 'utf8');
  assert.match(route, /import 'server-only'/); assert.match(route, /runtime = 'nodejs'/);
  const proxy = () => Response.json({ fixture: true });
  const handlers = load('app/api/ask-staging/[[...path]]/route.ts', { 'server-only': {}, '@/lib/ask/staging-proxy': { proxyAskStaging: proxy } });
  for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) assert.equal(handlers[method], proxy);
  for (const file of ['lib/ask/api-base.ts', 'lib/ask/client.ts', 'lib/ask/research-client.ts', 'app/ask/AskWorkspace.tsx', 'components/ask/AskPanel.tsx']) assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /staging-proxy|ASK_STAGING_(?:ORIGIN|CA_PEM|CLIENT_CERT_PEM|CLIENT_KEY_PEM)/);
});

test('all-route noindex and no-store headers require the server preview gate, never a public flag alone', async t => {
  const originals = [process.env.VERCEL_ENV, process.env.ASK_STAGING_ENABLED];
  t.after(() => { for (const [i, key] of ['VERCEL_ENV', 'ASK_STAGING_ENABLED'].entries()) if (originals[i] === undefined) delete process.env[key]; else process.env[key] = originals[i]; });
  const config = load('next.config.ts').default;
  const seo = load('lib/seo.ts', { '@/lib/network': { getConfiguredNetwork: () => 'mainnet' }, '@/lib/api-config': {}, '@/lib/api-client': {}, '@/lib/server-fetch': {} });
  const robots = load('app/robots.ts', { '@/lib/seo': seo }).default;
  for (const [environment, flag, active] of [['production', 'true', false], ['preview', 'false', false], ['preview', 'true', true]]) {
    process.env.VERCEL_ENV = environment; process.env.ASK_STAGING_ENABLED = flag;
    const rules = await config.headers();
    assert.equal(rules.length, active ? 1 : 0);
    if (active) { assert.equal(rules[0].source, '/:path*'); const headers = Object.fromEntries(rules[0].headers.map(({ key, value }) => [key.toLowerCase(), value])); assert.match(headers['x-robots-tag'], /noindex/); assert.match(headers['cache-control'], /no-store/); }
    const metadata = seo.buildPageMetadata({ title: 'Ask ZecBlock', description: 'Public analytics.', path: '/ask', index: true });
    assert.equal(metadata.robots.index, !active); assert.equal(metadata.robots.googleBot.index, !active);
    assert.equal(metadata.alternates.canonical, 'https://zecblock.com/ask');
    assert.equal(robots().sitemap, active ? undefined : 'https://zecblock.com/sitemap.xml');
  }
});
