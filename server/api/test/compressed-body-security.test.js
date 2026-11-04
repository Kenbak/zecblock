const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

// Isolate the parser in a subprocess: the vulnerable release throws outside
// Express's error handler and must fail this test without crashing the runner.
const fixture = `
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.post('/trailing', (req, res) => {
    req.once('end', () => res.json(req.body));
    process.send('parsed');
  });
  app.post('/echo', (req, res) => res.json(req.body));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use((error, req, res, next) => res.status(400).json({ error: 'Invalid body' }));
  app.listen(0, '127.0.0.1', function () { process.send(this.address().port); });
`;

test('compressed-body trailing bytes cannot terminate the default Express parser process', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['-e', fixture], {
    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => child.kill());
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
  const [port] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  const url = `http://127.0.0.1:${port}`;
  const json = Buffer.from(JSON.stringify({ value: 'compressed JSON remains supported' }));
  for (const [encoding, compress] of [['deflate', zlib.deflateSync], ['gzip', zlib.gzipSync], ['br', zlib.brotliCompressSync]]) {
    const response = await fetch(`${url}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding }, body: compress(json) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), JSON.parse(json));
  }

  // The zero byte finishes the deflate decoder before the HTTP body is done.
  // Keep the remaining bytes separate, as in the upstream advisory regression.
  const first = Buffer.concat([zlib.deflateSync(json), Buffer.from([0])]);
  const trailing = Buffer.alloc(1024);
  const parsed = once(child, 'message', { signal: AbortSignal.timeout(2000) });
  let request;
  const completed = new Promise((resolve, reject) => {
    request = http.request(`${url}/trailing`, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate', 'Content-Length': first.length + trailing.length } }, response => {
      assert.equal(response.statusCode, 200);
      response.resume();
      response.once('end', resolve);
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Parser did not finish the valid frame')));
    request.write(first);
  });
  await parsed;
  request.end(trailing);
  await completed;

  // A larger gzip tail arrives in decoder chunks after the first frame ends.
  const gzipWithTail = Buffer.concat([zlib.gzipSync(json), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
  await new Promise((resolve, reject) => {
    const request = http.request(`${url}/echo`, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': gzipWithTail.length } }, response => {
      assert.equal(response.statusCode, 200);
      response.resume();
      response.once('end', resolve);
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Parser did not finish the gzip frame')));
    request.end(gzipWithTail);
  });

  // A fresh request must succeed after the decoder sees the late tail. Merely
  // receiving the first response does not prove the old stream stayed safe.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(child.exitCode, null, diagnostic);
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200, diagnostic);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(child.exitCode, null, diagnostic);
});

test('API batch validation rejects an oversized array before touching its elements', () => {
  const { schemas } = require('../validation');
  const txids = new Array(101);
  Object.defineProperty(txids, 0, { get() { throw new Error('Oversized element was visited'); } });
  const result = schemas.txRawBatch.body.safeParse({ txids });
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
});

test('Ask history rejects an oversized array before touching its elements', () => {
  const { chatRequestSchema } = require('../../../lib/ask/chat');
  const history = new Array(5);
  Object.defineProperty(history, 0, { get() { throw new Error('Oversized element was visited'); } });
  const result = chatRequestSchema.safeParse({ question: 'Explain this page', page: 'home', context: null, history });
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
});
