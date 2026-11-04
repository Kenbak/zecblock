'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { once } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const createV1Router = require('../../v1');
const { createReader } = require('../../v1/mcp/reader');
const { getTools } = require('../../v1/mcp/catalog');

async function serve(t, overrides = {}, parentParses = false) {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    calls.push({ url: req.url, headers: req.headers, method: req.method });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/info') return res.end(JSON.stringify({ height: 42 }));
    if (req.url === '/api/block/42') return res.end(JSON.stringify({ height: 42, total_fees: '123456789123456', hash: 'a'.repeat(64) }));
    if (req.url === '/api/block/43') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'Block not found.' })); }
    if (req.url.startsWith('/api/blocks/list')) {
      const query = new URL(req.url, 'http://upstream').searchParams;
      const limit = Number(query.get('limit'));
      return res.end(JSON.stringify({ success: true, blocks: [42, 41, 40].slice(0, limit).map(height => ({ height, timestamp: height * 75, total_fees: '12345' })), pagination: { total: 3 } }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'Not found.' }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const app = express();
  if (parentParses) app.use(express.json({ limit: '1mb' }));
  const router = createV1Router({
    API_V1_ENABLED: 'true', API_V1_LAUNCHED: 'true', NEXT_PUBLIC_NETWORK: 'mainnet', ASK_ENABLED: 'false',
    V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, V1_INTERNAL_SERVICE_KEY: 'internal-only', ...overrides,
  });
  app.use('/v1', router);
  // A parent parser runs outside the version router's own error boundary.
  // Match the production host's sanitized status without logging test stacks.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: 'Invalid request.' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { router.__stopRateLimiters(); for (const s of [server, upstream]) { s.closeAllConnections(); s.close(); } });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  return { base, calls, async client() {
    const client = new Client({ name: 'zecblock-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    t.after(() => client.close());
    return client;
  } };
}

test('official SDK initializes the stateless endpoint and discovers only curated read tools', async t => {
  const api = await serve(t);
  const client = await api.client();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 20);
  assert.equal(tools.some(tool => /sql|broadcast|scan|private|ask/.test(tool.name)), false);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(api.calls.length, 0);
});

test('MCP reuses REST adapters and preserves exact amounts, network, source and missing-resource errors', async t => {
  const api = await serve(t);
  const client = await api.client();
  const result = await client.callTool({ name: 'block', arguments: { heightOrHash: 42 } });
  const rest = await (await fetch(`${api.base}/blocks/42`)).json();
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.data, rest.data);
  assert.equal(result.structuredContent.data.total_fees, '123456789123456');
  assert.equal(result.structuredContent.meta.network, 'mainnet');
  assert.deepEqual(result.structuredContent.meta.units, rest.meta.units);
  assert.deepEqual(result.structuredContent.meta.source, rest.meta.source);
  assert.equal(result.structuredContent.endpoint, 'https://api.zecblock.com/v1/blocks/42');
  const missing = await client.callTool({ name: 'block', arguments: { heightOrHash: 43 } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.httpStatus, 404);
  assert.equal(missing.structuredContent.data, undefined);
  for (const call of api.calls) assert.equal(call.method, 'GET');
});

test('cursor metadata survives and invalid inputs cannot reach arbitrary routes or upstreams', async t => {
  const api = await serve(t);
  const client = await api.client();
  const list = await client.callTool({ name: 'blocks', arguments: { limit: 2 } });
  assert.equal(list.structuredContent.data.length, 2);
  assert.equal(list.structuredContent.meta.page.hasNext, true);
  assert(list.structuredContent.meta.page.nextCursor);
  const before = api.calls.length;
  for (const args of [{ limit: 26 }, { limit: 1, url: 'http://private.invalid' }, { cursor: 'x'.repeat(4097) }]) {
    const result = await client.callTool({ name: 'blocks', arguments: args });
    assert.equal(result.isError, true);
  }
  const invalid = await client.callTool({ name: 'block', arguments: { heightOrHash: '../health' } });
  assert.equal(invalid.isError, true);
  assert.equal(api.calls.length, before);
});

test('tip metadata uses the bounded tool client and combined cancellation instead of the outer resolver', async () => {
  const controller = new AbortController();
  let tipStarted;
  const started = new Promise(resolve => { tipStarted = resolve; });
  const read = createReader({ config: { network: 'mainnet' }, internalClient: {
    async dispatch(method, path, options) {
      assert.equal(options.parentSignal, controller.signal);
      if (path === '/api/block/42') return { ok: true, status: 200, body: { height: 42 }, headers: {} };
      assert.equal(path, '/api/info'); tipStarted();
      await new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  } });
  const pending = read(getTools('mainnet').find(tool => tool.name === 'block'), { heightOrHash: 42 }, {
    v1: { network: 'mainnet', indexedHeight: null, requestId: 'test', resolveIndexedHeight() { assert.fail('Must not reuse the outer resolver.'); } },
  }, controller.signal);
  await started; controller.abort();
  const result = await pending;
  assert.equal(result.data.height, 42);
  assert.equal(result.meta.indexedHeight, null);
});

test('mainnet-only venue tools are absent on testnet; endpoint keeps gate and transport boundaries', async t => {
  const api = await serve(t, { NEXT_PUBLIC_NETWORK: 'testnet' });
  const client = await api.client();
  assert.equal((await client.listTools()).tools.length, 15);
  const testnetAddress = 't2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu';
  await client.callTool({ name: 'address', arguments: { address: testnetAddress } });
  assert(api.calls.some(call => call.url.includes(testnetAddress)), 'A valid testnet P2SH address must reach authoritative validation.');
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await fetch(`${api.base}/mcp`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, follow');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const origin = await fetch(`${api.base}/mcp`, { method: 'POST', headers: { Origin: 'https://evil.invalid' } });
  assert.equal(origin.status, 403);
  const disabled = await serve(t, { API_V1_ENABLED: 'false' });
  assert.equal((await fetch(`${disabled.base}/mcp`)).status, 404);
  const preview = await serve(t, { API_V1_LAUNCHED: 'false', API_V1_PREVIEW_KEY: 'preview-only' });
  assert.equal((await fetch(`${preview.base}/mcp`, { headers: { 'X-Service-Key': 'internal-only', Cookie: 'preview-only' } })).status, 401);
});

test('malformed, oversized and repeated requests fail without upstream work, including parsed hosts', async t => {
  for (const parentParses of [false, true]) {
    const api = await serve(t, {}, parentParses);
    const post = body => fetch(`${api.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body });
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify(Array.from({ length: 40 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'chain_info', arguments: {} } }))))).status, 400);
    assert.equal((await post(JSON.stringify({ padding: 'x'.repeat(17000) }))).status, 413);
    assert.equal(api.calls.length, 0);
  }
  const api = await serve(t);
  for (let i = 0; i < 60; i++) assert.equal((await fetch(`${api.base}/mcp`)).status, 405);
  const limited = await fetch(`${api.base}/mcp`, { headers: { 'X-Forwarded-For': '1.2.3.4' } });
  assert.equal(limited.status, 429);
  assert(limited.headers.get('retry-after'));
  assert.equal(api.calls.length, 0);
});
