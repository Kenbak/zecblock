const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { readBoundedJson } = require('../../lib/bounded-json');

function upstream(fetchImpl, decode = readBoundedJson) {
  let now = 1_000_000;
  const Clock = class extends Date { static now() { return now; } };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/governance-upstream.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, Date: Clock,
    setTimeout: (fn, delay) => { now += delay; queueMicrotask(fn); },
    require: name => ({
      './server-fetch': { fetchWithDeadline: (...args) => fetchImpl({ advance: milliseconds => { now += milliseconds; }, now: () => now }, ...args) },
      './bounded-json': { readBoundedJson: decode },
      './governance': { GOVERNANCE_API: 'https://vote.example/shielded-vote/v1' },
    })[name],
  });
  return exports;
}

test('transient retries and body decoding share the original endpoint budget', async () => {
  let calls = 0;
  const budgets = [];
  const bodyBudgets = [];
  const api = upstream(async (clock, url, init, budget) => {
    budgets.push(budget);
    assert.equal(init.cache, 'no-store');
    if (++calls === 1) {
      clock.advance(3_900);
      throw new DOMException('Server-render fetch deadline exceeded', 'TimeoutError');
    }
    clock.advance(2_000);
    return Response.json({ rounds: [] });
  }, async (response, bytes, budget) => {
    bodyBudgets.push(budget);
    assert.equal(bytes, 2 * 1024 * 1024);
    return response.json();
  });
  assert.deepEqual(await api.fetchGovernanceJson('rounds'), { rounds: [] });
  assert.deepEqual(budgets, [4_000, 4_000]);
  assert.deepEqual(bodyBudgets, [2_000]);
});

test('simultaneous callers share one request and its bounded retry', async () => {
  let release;
  let calls = 0;
  const api = upstream(async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return Response.json({ rounds: [] });
  });
  const first = api.fetchGovernanceJson('rounds');
  const second = api.fetchGovernanceJson('rounds');
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  const third = api.fetchGovernanceJson('rounds');
  release();
  await third;
  assert.equal(calls, 2, 'single-flight work must not act as an unbounded response cache');
});

test('HTTP 4xx, invalid JSON and decoded size failures do not retry', async () => {
  for (const [response, reason] of [
    [() => new Response('missing', { status: 404 }), 'http'],
    [() => new Response('{unfinished'), 'invalid-json'],
    [() => new Response(' '.repeat(2 * 1024 * 1024 + 1)), 'response-too-large'],
  ]) {
    let calls = 0;
    const api = upstream(async () => { calls++; return response(); });
    await assert.rejects(api.fetchGovernanceJson('rounds'), error => error.reason === reason);
    assert.equal(calls, 1, reason);
  }
});

test('transient HTTP failures retry once and respect provider Retry-After', async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    let calls = 0;
    const api = upstream(async () => ++calls === 1 ? new Response('temporary', { status, headers: { 'Retry-After': '0' } }) : Response.json({ ok: true }));
    assert.deepEqual(await api.fetchGovernanceJson('rounds'), { ok: true });
    assert.equal(calls, 2);
  }
  for (const retry of ['600', 'invalid']) {
    let calls = 0;
    const api = upstream(async () => { calls++; return new Response('temporary', { status: 503, headers: { 'Retry-After': retry } }); });
    await assert.rejects(api.fetchGovernanceJson('rounds'), error => error.status === 503 && error.reason === 'http');
    assert.equal(calls, 1, 'must not retry before a provider backoff longer than the request budget');
  }
});

test('network diagnostics retain known error codes without exposing raw messages or causes', async () => {
  let calls = 0;
  const api = upstream(async () => { calls++; throw new Error('private origin and credential material', { cause: { code: 'ECONNRESET', secret: 'secret' } }); });
  let failure;
  try { await api.fetchGovernanceJson('rounds'); } catch (error) { failure = error; }
  assert.equal(calls, 2);
  assert.equal(failure.reason, 'network');
  assert.equal(failure.code, 'ECONNRESET');
  assert.equal(failure.cause, undefined);
  assert.doesNotMatch(failure.message, /private|credential|secret/);
  assert.deepEqual(JSON.parse(JSON.stringify(api.governanceFailureDetails(failure))), { endpoint: 'rounds', reason: 'network', code: 'ECONNRESET' });
});
