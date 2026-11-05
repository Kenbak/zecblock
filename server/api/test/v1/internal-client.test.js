/**
 * Unit tests for lib/internal-client.js: configurable response-size cap,
 * response-header allowlisting, and internal-hop timing.
 *
 * Run: node --test server/api/test/v1/internal-client.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { loadV1Config, DEFAULT_MAX_RESPONSE_BYTES } = require('../../v1/config');
const {
  createInternalClient,
  UpstreamError,
  isAllowedResponseHeader,
  pickAllowedHeaders,
} = require('../../v1/lib/internal-client');

test('config uses the API server network identity when no frontend variable exists', () => {
  assert.equal(loadV1Config({ NETWORK: 'mainnet' }).network, 'mainnet');
  assert.equal(loadV1Config({ ZCASH_NETWORK: 'testnet' }).network, 'testnet');
  assert.equal(
    loadV1Config({ NEXT_PUBLIC_NETWORK: 'crosslink-testnet', NETWORK: 'mainnet' }).network,
    'crosslink-testnet',
  );
});

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withServer(handler, fn) {
  const server = await startServer(handler);
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------
// Configurable cap, default aligned with the 50MB upstream Zebra RPC cap
// ---------------------------------------------------------------------------

test('config: default maxResponseBytes is 50MB, matching server/lib/zebra-rpc.js MAX_RPC_RESPONSE_BYTES', () => {
  const config = loadV1Config({});
  assert.equal(config.maxResponseBytes, 50 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 50 * 1024 * 1024);
});

test('config: maxResponseBytes is overridable via V1_INTERNAL_MAX_RESPONSE_BYTES', () => {
  const config = loadV1Config({ V1_INTERNAL_MAX_RESPONSE_BYTES: '12345' });
  assert.equal(config.maxResponseBytes, 12345);
});

test('internal-client: a body just over a small configured cap is rejected (fails closed)', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blob: 'x'.repeat(2000) }));
  }, async (port) => {
    const config = loadV1Config({ V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${port}`, V1_INTERNAL_MAX_RESPONSE_BYTES: '1000' });
    const client = createInternalClient(config);
    await assert.rejects(() => client.dispatch('GET', '/api/info'), UpstreamError);
  });
});

test('internal-client: a body under a small configured cap is accepted', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blob: 'x'.repeat(50) }));
  }, async (port) => {
    const config = loadV1Config({ V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${port}`, V1_INTERNAL_MAX_RESPONSE_BYTES: '1000' });
    const client = createInternalClient(config);
    const result = await client.dispatch('GET', '/api/info');
    assert.equal(result.ok, true);
    assert.equal(result.body.blob.length, 50);
  });
});

test('internal-client: a >10.4MB body is accepted under the DEFAULT cap (no config override) — real payloads must not be rejected', async () => {
  const targetBytes = 11 * 1024 * 1024;
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blob: 'x'.repeat(targetBytes) }));
  }, async (port) => {
    const config = loadV1Config({ V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${port}` }); // no cap override — real default
    const client = createInternalClient(config);
    const result = await client.dispatch('GET', '/api/info');
    assert.equal(result.ok, true);
    assert.equal(result.body.blob.length, targetBytes);
  });
});

test('internal-client: rejects a body that exceeds even the 50MB default cap', async () => {
  const overCap = 51 * 1024 * 1024;
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blob: 'x'.repeat(overCap) }));
  }, async (port) => {
    const config = loadV1Config({ V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${port}` });
    const client = createInternalClient(config);
    await assert.rejects(() => client.dispatch('GET', '/api/info'), UpstreamError);
  });
}, { timeout: 20_000 });

// ---------------------------------------------------------------------------
// Response header allowlist
// ---------------------------------------------------------------------------

test('isAllowedResponseHeader: allows the documented safe set (case-insensitively)', () => {
  for (const name of ['Cache-Control', 'ETag', 'Retry-After', 'RateLimit-Limit', 'X-RateLimit-Remaining', 'X-CipherScan-Cache', 'x-cipherscan-anything-future']) {
    assert.equal(isAllowedResponseHeader(name), true, `expected ${name} to be allowed`);
  }
});

test('isAllowedResponseHeader: rejects everything else', () => {
  for (const name of ['Set-Cookie', 'Server', 'X-Powered-By', 'Authorization', 'X-Service-Key', 'Content-Length', 'Connection']) {
    assert.equal(isAllowedResponseHeader(name), false, `expected ${name} to be rejected`);
  }
});

test('internal-client: dispatch() returns only allowlisted headers, and a timingMs number', async () => {
  await withServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=10',
      'Set-Cookie': 'a=b',
      'X-Powered-By': 'Express',
    });
    res.end(JSON.stringify({ ok: true }));
  }, async (port) => {
    const config = loadV1Config({ V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${port}` });
    const client = createInternalClient(config);
    const result = await client.dispatch('GET', '/api/info');
    assert.deepEqual(Object.keys(result.headers).sort(), ['cache-control']);
    assert.equal(result.headers['cache-control'], 'public, max-age=10');
    assert.equal(typeof result.timingMs, 'number');
    assert.ok(result.timingMs >= 0);
  });
});

test('pickAllowedHeaders: works directly against a fetch Headers-like object', () => {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Set-Cookie': 'x=y', ETag: '"1"' });
  const picked = pickAllowedHeaders(headers);
  assert.deepEqual(Object.keys(picked).sort(), ['cache-control', 'etag']);
});


test('internal-client preserves exact pool units and the requested period on the upstream wire',async()=>{
 await withServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  assert.equal(url.pathname,'/api/network/pool-history');
  assert.equal(url.searchParams.get('period'),'1y');
  assert.equal(url.searchParams.get('format'),'zatoshi');
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({points:[{date:'2026-10-07',ironwoodZat:'407241573265078',hasPoolBreakdown:true}]}));
 },async(port)=>{
  const client=createInternalClient(loadV1Config({V1_INTERNAL_API_BASE_URL:`http://127.0.0.1:${port}`}));
  const result=await client.dispatch('GET','/api/network/pool-history',{query:{period:'1y',format:'zatoshi'}});
  assert.equal(result.body.points[0].ironwoodZat,'407241573265078');
 });
});
