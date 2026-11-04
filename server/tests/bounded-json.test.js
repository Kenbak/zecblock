const test = require('node:test');
const assert = require('node:assert/strict');
const { readBoundedJson } = require('../../lib/bounded-json');

test('JSON reader accepts multibyte data at the decoded byte boundary', async () => {
  const json = JSON.stringify({ title: 'Zcash 日本語' });
  const bytes = new TextEncoder().encode(json);
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }));
  assert.deepEqual(await readBoundedJson(response, bytes.length), JSON.parse(json));
});

test('JSON reader stops oversized decoded and chunked responses before buffering the tail', async () => {
  for (const headers of [{}, { 'Content-Length': '1', 'Content-Encoding': 'br' }]) {
    let cancelled = false;
    let reads = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(16));
      },
      cancel() { cancelled = true; },
    }), { headers });
    await assert.rejects(readBoundedJson(response, 20), /byte limit/);
    assert.equal(cancelled, true);
    assert.ok(reads <= 3, 'must not drain an unbounded response');
  }
});

test('JSON reader cancels a stalled response after headers without waiting for stream completion', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(readBoundedJson(response, 100, 20), /deadline/);
  assert.equal(cancelled, true);
});

test('a rejected stream cancellation cannot mask the original response deadline', async () => {
  const response = new Response(new ReadableStream({ cancel() { return Promise.reject(new Error('Cancellation failed')); } }));
  await assert.rejects(readBoundedJson(response, 100, 20), /JSON response deadline exceeded/);
});

test('invalid JSON is rejected rather than returned as page data', async () => {
  await assert.rejects(readBoundedJson(new Response('{unfinished')), SyntaxError);
});
