import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startPrototype } from '../server.mjs';

async function fixture(t, evaluate = async () => Buffer.from([9, 8, 7])) {
  const dir = await mkdtemp(join(tmpdir(), 'private-tx-http-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schema: 'test', catalogue: [] }));
  await writeFile(join(dir, 'public.bin'), Buffer.from([1, 2, 3]));
  const app = await startPrototype({ port: 0, fixtureDir: dir, evaluator: { evaluate } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return app;
}

test('loopback-only server serves generic shell with noindex and restricted CSP', async t => {
  const app = await fixture(t);
  const response = await fetch(app.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('binary evaluator gets exactly the encrypted request bytes', async t => {
  const query = Buffer.from([7, 2, 4, 9, 0]);
  let seen;
  const app = await fixture(t, async bytes => { seen = bytes; return Buffer.from([11, 12]); });
  const response = await fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: query });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, query);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([11, 12]));
});

test('rejects cleartext lookups, foreign origins, hostile host and wrong methods', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; return Buffer.alloc(1); });
  const cases = [
    ['/pir/query?txid=abc', { method: 'POST' }, 400],
    ['/tx/abc', {}, 404],
    ['/api/transactions/abc', {}, 404],
    ['/fixture/expected.json', {}, 404],
    ['/fixture/database.bin', {}, 404],
    ['/fixture/../../server.mjs', {}, 404],
    ['/pir/query', {}, 404],
    ['/pir/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"txid":"abc"}' }, 415],
    ['/pir/query', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/octet-stream' }, body: 'abc' }, 403],
    ['/', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
  ];
  for (const [path, options, status] of cases) {
    const response = await fetch(`${app.url}${path}`, options);
    assert.equal(response.status, status, `${path} ${JSON.stringify(options)}`);
  }
  // Fetch may normalize Host, so exercise DNS-rebinding protection with raw HTTP.
  const hostileStatus = await new Promise((resolveStatus, reject) => {
    const request = httpRequest(app.url, { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolveStatus(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(hostileStatus, 403);
  assert.equal(calls, 0);
});

test('rejects empty and oversized queries before native evaluation', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; return Buffer.alloc(1); });
  for (const [body, expected] of [[Buffer.alloc(0), 400], [Buffer.alloc(4 * 1024 * 1024 + 1), 413]]) {
    const response = await fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
    assert.equal(response.status, expected);
  }
  assert.equal(calls, 0);
});

test('evaluator failures return a generic error without fallback or identifier echo', async t => {
  let calls = 0;
  const secret = 'f'.repeat(64);
  const app = await fixture(t, async () => { calls++; throw new Error(secret); });
  const response = await fetch(`${app.url}/pir/query`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from([1]) });
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.ok(!text.includes(secret));
  assert.match(text, /No public lookup was attempted/);
  assert.equal(calls, 1);
});
