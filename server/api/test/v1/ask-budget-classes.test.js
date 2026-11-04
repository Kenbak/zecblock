'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { createHmac } = require('node:crypto');
const { createClient } = require('redis');
const { admit, admitWork, reserve, maximumCost, billedCost, budgetConfig, REQUEST_LIMITS, WORK_LIMITS } = require('../../v1/lib/ask-budget');
const R = REQUEST_LIMITS, W = WORK_LIMITS;

const NOW = Date.UTC(2026, 9, 27, 12, 34, 56, 100);
const config = { abuseSecret: 'isolated-budget-fixture-secret-at-least-32-characters', authenticatedStaging: true, dailyCalls: 200, dailyBudget: 1e6, monthlyBudget: 5e6, inputRate: 0.25, outputRate: 0.75 };
const request = (ip = '203.0.113.7') => ({ ip, body: {}, v1: { authenticatedStaging: true, abortSignal: new AbortController().signal } });
const resetAfter = (now, window) => Math.max(1, Math.ceil((window - now % window) / 1000));
const quota = (code, retryAfter) => error => error.quota === true && error.quotaCode === code && Number.isInteger(error.retryAfter) && error.retryAfter === retryAfter;
function keys(req, now = NOW) {
  const day = new Date(now).toISOString().slice(0, 10), minute = Math.floor(now / 60000);
  const identity = createHmac('sha256', config.abuseSecret).update(`${day}:${req.ip}`).digest('hex');
  const pair = prefix => [`${prefix}:${minute}`, `${prefix}:day`];
  return { ordinary: [...pair(`ask:{mainnet}:requests:ip:${identity}`), `ask:{mainnet}:requests:hour:${new Date(now).toISOString().slice(0, 13)}`, `ask:{mainnet}:requests:day:${day}`], ai: pair(`ask:{mainnet}:work:ai:${identity}`), sql: pair(`ask:{mainnet}:work:sql:${identity}`), legacy: pair(`ask:{mainnet}:ip:${identity}`) };
}
async function fixture(t) {
  // Only this disposable Unix-socket Redis is touched; never use TEST_REDIS_URL.
  const directory = await mkdtemp('/tmp/ask-budget-classes-'), socket = `${directory}/redis.sock`;
  let child, redis, closing;
  const exitedWithin = milliseconds => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const exited = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', exited); resolve(false); }, milliseconds);
    child.once('exit', exited);
  });
  const close = () => closing ??= (async () => {
    if (redis?.isOpen) redis.destroy();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!await exitedWithin(1000)) { child.kill('SIGKILL'); assert.equal(await exitedWithin(1000), true, 'Disposable Redis must exit'); }
    }
    await rm(directory, { recursive: true, force: true });
  })();
  t.after(close);
  try {
    child = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', () => {}); child.stderr.resume();
    await new Promise((resolve, reject) => {
      let output = '';
      const finish = error => { clearTimeout(timer); child.off('error', failed); child.off('exit', exited); child.stdout.off('data', data); child.stdout.resume(); if (error) reject(error); else resolve(); };
      const failed = error => finish(error), exited = () => finish(Error('Disposable Redis exited before readiness'));
      const data = chunk => { output = (output + chunk.toString()).slice(-2048); if (/ready to accept connections/i.test(output)) finish(); };
      const timer = setTimeout(() => finish(Error('Disposable Redis readiness timeout')), 5000);
      child.once('error', failed); child.once('exit', exited); child.stdout.on('data', data);
    });
    redis = createClient({ socket: { path: socket, connectTimeout: 2000, reconnectStrategy: false } });
    redis.on('error', () => {}); await redis.connect(); return redis;
  } catch (error) { await close(); throw error; }
}

test('ordinary requests atomically admit their per-minute limit without spending AI, SQL or legacy allowances', async t => {
  const redis = await fixture(t), req = request(), bucket = keys(req); t.mock.method(Date, 'now', () => NOW);
  const results = await Promise.allSettled(Array.from({ length: R.minute + 20 }, () => admit(redis, config, req)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, R.minute);
  for (const result of results.filter(result => result.status === 'rejected')) assert.ok(quota('ask-request-minute', 4)(result.reason));
  assert.deepEqual(await redis.mGet(bucket.ordinary), Array(4).fill(String(R.minute)));
  assert.deepEqual(await redis.mGet([...bucket.ai, ...bucket.sql, ...bucket.legacy]), Array(6).fill(null));
  assert.equal(await redis.exists('ask:{mainnet}:calls:2026-10-27'), 0);
  await assert.rejects(admit(redis, config, req), quota('ask-request-minute', 4));
  assert.deepEqual(await redis.mGet(bucket.ordinary), Array(4).fill(String(R.minute)));
});

test('AI and SQL work each retain independent per-minute allowances under simultaneous requests', async t => {
  const redis = await fixture(t), req = request(), bucket = keys(req);
  for (const kind of ['ai', 'sql']) {
    const results = await Promise.allSettled(Array.from({ length: W[kind].minute + 20 }, () => admitWork(redis, config, req, kind, NOW)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, W[kind].minute);
    for (const result of results.filter(result => result.status === 'rejected')) assert.ok(quota(`ask-${kind}-minute`, 4)(result.reason));
    assert.deepEqual(await redis.mGet(bucket[kind]), Array(2).fill(String(W[kind].minute)));
  }
  assert.deepEqual(await redis.mGet(bucket.ordinary), Array(4).fill(null));
  assert.deepEqual(await redis.mGet(bucket.legacy), [null, null]);
  assert.equal(await redis.exists('ask:{mainnet}:calls:2026-10-27'), 0);
});

test('historical admission is a read-only maximum baseline for each work class, including concurrent daily exhaustion', async t => {
  const redis = await fixture(t), req = request(), bucket = keys(req);
  for (const kind of ['ai', 'sql']) {
    await redis.set(bucket.legacy[0], '4'); await redis.set(bucket.legacy[1], String(W[kind].day - 1));
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => admitWork(redis, config, req, kind, NOW)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    for (const result of results.filter(result => result.status === 'rejected')) assert.ok(quota(`ask-${kind}-day`, resetAfter(NOW, 86400000))(result.reason));
    assert.deepEqual(await redis.mGet(bucket[kind]), ['5', String(W[kind].day)]);
    assert.deepEqual(await redis.mGet(bucket.legacy), ['4', String(W[kind].day - 1)]);
  }
  // A newer work counter cannot be reduced by a smaller historical counter.
  const other = request('203.0.113.8'), next = keys(other);
  await redis.set(next.legacy[0], '1'); await redis.set(next.legacy[1], '8');
  await redis.set(next.ai[0], '3'); await redis.set(next.ai[1], '10');
  await admitWork(redis, config, other, 'ai', NOW);
  assert.deepEqual(await redis.mGet(next.ai), ['4', '11']);
  assert.deepEqual(await redis.mGet(next.legacy), ['1', '8']);
});

test('work day allowance survives minute changes and naturally changes at the UTC day boundary', async t => {
  const redis = await fixture(t), req = request();
  for (const kind of ['ai', 'sql']) {
    const { minute: perMinute, day } = W[kind], minutes = Math.ceil(day / perMinute);
    for (let minute = 0, used = 0; minute < minutes; minute++) for (let i = 0; i < perMinute && used < day; i++, used++) await admitWork(redis, config, req, kind, NOW + minute * 60000);
    const later = NOW + minutes * 60000;
    await assert.rejects(admitWork(redis, config, req, kind, later), quota(`ask-${kind}-day`, resetAfter(later, 86400000)));
    await admitWork(redis, config, req, kind, Date.UTC(2026, 9, 28));
    assert.equal((await redis.mGet(keys(req)[kind]))[1], String(day));
    assert.deepEqual(await redis.mGet(keys(req, Date.UTC(2026, 9, 28))[kind]), ['1', '1']);
  }
});

test('ordinary day exhaustion is atomic and denied traffic changes none of its four counters', async t => {
  const redis = await fixture(t), req = request(), bucket = keys(req); t.mock.method(Date, 'now', () => NOW);
  await redis.set(bucket.ordinary[1], String(R.day - 1));
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => admit(redis, config, req)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.ok(quota('ask-request-day', resetAfter(NOW, 86400000))(result.reason));
  assert.deepEqual(await redis.mGet(bucket.ordinary), ['1', String(R.day), '1', '1']);
});

for (const [name, index, count, window] of [['hour', 2, R.globalHour, 3600000], ['day', 3, R.globalDay, 86400000]]) {
  test(`site-wide ordinary ${name} cap is shared across IPs and denial creates no per-IP usage`, async t => {
    const redis = await fixture(t), shared = keys(request()).ordinary; t.mock.method(Date, 'now', () => NOW);
    await redis.set(shared[index], String(count - 1));
    const requests = Array.from({ length: 30 }, (_, i) => request(`198.51.100.${i + 1}`));
    const results = await Promise.allSettled(requests.map(req => admit(redis, config, req)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await redis.get(shared[index]), String(count));
    assert.equal(await redis.get(shared[index === 2 ? 3 : 2]), '1');
    for (const [i, result] of results.entries()) {
      const own = keys(requests[i]).ordinary.slice(0, 2);
      if (result.status === 'fulfilled') assert.deepEqual(await redis.mGet(own), ['1', '1']);
      else { assert.ok(quota(`ask-request-global-${name}`, resetAfter(NOW, window))(result.reason)); assert.deepEqual(await redis.mGet(own), [null, null]); }
    }
  });
}

test('paid reservations atomically enforce spend, retain failure/cancel charges, and release only active leases', async t => {
  const redis = await fixture(t), cost = maximumCost(config, '{}');
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => reserve(redis, { ...config, dailyBudget: cost * 2 }, '{}', NOW)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  for (const result of results.filter(result => result.status === 'rejected')) assert.ok(quota('ask-ai-budget-day', resetAfter(NOW, 86400000))(result.reason));
  for (const result of results.filter(result => result.status === 'fulfilled')) await result.value();
  assert.deepEqual(await redis.mGet(['ask:{mainnet}:calls:2026-10-27', 'ask:{mainnet}:usd:2026-10-27', 'ask:{mainnet}:usd:2026-10']), ['2', String(cost * 2), String(cost * 2)]);
  assert.equal(await redis.zCard('ask:{mainnet}:active'), 0);
  await assert.rejects(reserve(redis, { ...config, dailyBudget: cost * 2 }, '{}', NOW), quota('ask-ai-budget-day', resetAfter(NOW, 86400000)));
  assert.equal(await redis.get('ask:{mainnet}:calls:2026-10-27'), '2');
});

test('paid busy response uses the earliest unexpired lease and is bounded to sixty seconds', async t => {
  const redis = await fixture(t), active = 'ask:{mainnet}:active';
  const releases = await Promise.all(Array.from({ length: 3 }, () => reserve(redis, config, '{}', NOW)));
  const leases = await redis.zRange(active, 0, -1);
  await redis.zAdd(active, { score: NOW + 1100, value: leases[0] });
  await assert.rejects(reserve(redis, config, '{}', NOW), quota('ask-ai-busy', 2));
  assert.equal(await redis.get('ask:{mainnet}:calls:2026-10-27'), '3');
  await redis.zAdd(active, leases.map(value => ({ score: NOW + 120000, value })));
  await assert.rejects(reserve(redis, config, '{}', NOW), quota('ask-ai-busy', 60));
  for (const release of releases) await release();
  assert.equal(await redis.zCard(active), 0);
});

for (const code of ['ask-ai-calls-day', 'ask-ai-budget-month']) {
  test(`${code} reports its actual UTC reset without charging the denied attempt`, async t => {
    const redis = await fixture(t), cost = maximumCost(config, '{}');
    const setting = code === 'ask-ai-calls-day' ? { ...config, dailyCalls: 1 } : { ...config, monthlyBudget: cost };
    const release = await reserve(redis, setting, '{}', NOW); await release();
    const retry = code === 'ask-ai-calls-day' ? resetAfter(NOW, 86400000) : Math.ceil((Date.UTC(2026, 10, 1) - NOW) / 1000);
    await assert.rejects(reserve(redis, setting, '{}', NOW), quota(code, retry));
    assert.equal(await redis.get('ask:{mainnet}:calls:2026-10-27'), '1');
    assert.equal(await redis.get('ask:{mainnet}:usd:2026-10'), String(cost));
  });
}

test('verification succeeds before ordinary admission and never consumes a work allowance', async t => {
  const redis = await fixture(t), req = request(), bucket = keys(req); t.mock.method(Date, 'now', () => NOW);
  await assert.rejects(admit(redis, config, { ...req, v1: { ...req.v1, authenticatedStaging: false } }), error => error.askKind === 'verification');
  const production = { ...config, authenticatedStaging: false, challengeSecret: 'fixture-only', challengeHostname: 'example.test' };
  const challenged = { ...req, body: { challenge: 'fixture-only' } };
  await assert.rejects(admit(redis, production, challenged, async () => Response.json({ success: true, action: 'ask', hostname: 'wrong.test' })), error => error.askKind === 'verification');
  await admit(redis, production, challenged, async () => Response.json({ success: true, action: 'ask', hostname: 'example.test' }));
  assert.deepEqual(await redis.mGet(bucket.ordinary), ['1', '1', '1', '1']);
  assert.deepEqual(await redis.mGet([...bucket.ai, ...bucket.sql]), [null, null, null, null]);
});

test('rejected public challenges and spoofed staging metadata never touch Redis', async () => {
  const redis = { eval: async () => assert.fail('Unverified requests must not reach Redis') };
  const req = request(), production = { ...config, authenticatedStaging: false, challengeSecret: 'fixture-only', challengeHostname: 'example.test' };
  for (const challenge of [undefined, '', 'x'.repeat(2049), true]) {
    await assert.rejects(admit(redis, production, { ...req, body: { challenge } }, () => assert.fail('Invalid challenge must not be sent')), error => error.askKind === 'verification');
  }
  for (const response of [
    { success: false, action: 'ask', hostname: 'example.test' },
    { success: true, action: 'other', hostname: 'example.test' },
    { success: true, action: 'ask', hostname: 'wrong.test' },
  ]) await assert.rejects(admit(redis, production, { ...req, body: { challenge: 'rejected-fixture-token' } }, async () => Response.json(response)), error => error.askKind === 'verification');
  await assert.rejects(admit(redis, production, { ...req, body: { challenge: 'fixture-token' } }, async () => new Response('', { status: 503 })), error => error.askKind === 'verification');
  await assert.rejects(admit(redis, config, { ...req, v1: { ...req.v1, authenticatedStaging: false }, headers: { 'x-authenticated-staging': 'true' }, body: { authenticatedStaging: true } }), error => error.askKind === 'verification');
});

test('a verified request charges its actual post-verification UTC window before work admission', async t => {
  const before = Date.UTC(2026, 9, 27, 23, 59, 59, 900), after = Date.UTC(2026, 9, 28, 0, 0, 0, 100);
  let clock = before; t.mock.method(Date, 'now', () => clock);
  const req = { ...request(), body: { challenge: 'verified-fixture-token' } }, production = { ...config, authenticatedStaging: false, challengeSecret: 'fixture-only', challengeHostname: 'example.test' };
  const stages = [], redis = { eval: async (_script, options) => {
    assert.ok(clock === after, 'Verification must complete before admission');
    if (!stages.length) { assert.deepEqual(options.keys, keys(req, after).ordinary); stages.push('request'); }
    else { assert.deepEqual(options.keys.slice(0, 2), keys(req, after).ai); stages.push('ai'); }
    return 1;
  } };
  await admit(redis, production, req, async () => { clock = after; return Response.json({ success: true, action: 'ask', hostname: 'example.test' }); });
  await admitWork(redis, production, req, 'ai');
  assert.deepEqual(stages, ['request', 'ai']);
});

test('invalid work classes never reach Redis; Redis errors and unknown replies fail closed', async () => {
  let calls = 0; const redis = { eval: async () => { calls++; return 1; } };
  for (const kind of [undefined, null, 'AI', 'request', 'sql:admin', {}, '__proto__']) await assert.rejects(admitWork(redis, config, request(), kind, NOW), TypeError);
  assert.equal(calls, 0);
  for (const operation of [r => admitWork(r, config, request(), 'ai', NOW), r => admit(r, config, request()), r => reserve(r, config, '{}', NOW)]) {
    await assert.rejects(operation({ eval: async () => { throw Error('Isolated Redis unavailable'); } }));
    await assert.rejects(operation({ eval: async () => 0 }), error => error.askKind === 'unavailable');
  }
});

test('a reservation is replaced by the billed cost once usage is reported, in the day and month totals', async t => {
  const redis = await fixture(t), body = JSON.stringify({ max_completion_tokens: 4000 }), day = '2026-10-27', month = '2026-10';
  const reserved = maximumCost(config, body);
  const usage = { prompt_tokens: 6000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 5000 } };
  const billed = billedCost(config, usage);
  assert.equal(billed, Math.ceil(6000 * 0.25 + 300 * 0.75), 'cached tokens bill at the input rate unless a cached rate is configured');
  const release = await reserve(redis, config, body, NOW);
  assert.equal(Number(await redis.get(`ask:{mainnet}:usd:${day}`)), reserved);
  await release({ choices: [], usage });
  assert.equal(Number(await redis.get(`ask:{mainnet}:usd:${day}`)), billed);
  assert.equal(Number(await redis.get(`ask:{mainnet}:usd:${month}`)), billed);
  assert.equal(Number(await redis.get(`ask:{mainnet}:calls:${day}`)), 1, 'the call still counts');
  assert.equal(await redis.zCard('ask:{mainnet}:active'), 0, 'the lease is released');
});

test('calls without usage keep their full reservation, and a refund never goes below zero', async t => {
  const redis = await fixture(t), body = JSON.stringify({ max_completion_tokens: 4000 }), key = 'ask:{mainnet}:usd:2026-10-27';
  const reserved = maximumCost(config, body);
  for (const response of [undefined, null, {}, { usage: { prompt_tokens: -1, completion_tokens: 1 } }, { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } } }, { usage: { prompt_tokens: '10', completion_tokens: 1 } }]) {
    await (await reserve(redis, config, body, NOW))(response);
  }
  assert.equal(Number(await redis.get(key)), reserved * 6, 'failed, cancelled or malformed usage keeps the reservation');
  // A refund larger than what is left (e.g. after a manual correction) stops at zero.
  const release = await reserve(redis, config, body, NOW);
  await redis.set(key, '5');
  await release({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert.equal(Number(await redis.get(key)), 0);
});

test('billed cost reads OpenAI and Anthropic usage and an optional cached-input price', () => {
  const env = { ASK_DAILY_BUDGET_USD: '25', ASK_MONTHLY_BUDGET_USD: '400', ASK_MAX_INPUT_USD_PER_MILLION: '1', ASK_MAX_OUTPUT_USD_PER_MILLION: '5', ASK_ABUSE_SECRET: 'x'.repeat(32), ASK_TURNSTILE_SECRET: 's', ASK_TURNSTILE_HOSTNAME: 'h', ASK_TURNSTILE_SITE_KEY: 'k' };
  const plain = budgetConfig(env), cached = budgetConfig({ ...env, ASK_CACHED_INPUT_USD_PER_MILLION: '0.05' });
  assert.equal(plain.cachedInputRate, 1);
  const openai = { prompt_tokens: 6000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 5000 } };
  assert.equal(billedCost(plain, openai), 6000 + 1500);
  assert.equal(billedCost(cached, openai), 1000 + 250 + 1500);
  assert.equal(billedCost(cached, { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 300 }), 1000 + 250 + 1500);
  for (const usage of [undefined, {}, { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: 1e8, completion_tokens: 1 }]) assert.equal(billedCost(plain, usage), null);
  assert.equal(budgetConfig({ ...env, ASK_CACHED_INPUT_USD_PER_MILLION: '2' }), null, 'a cached price above the input price is rejected');
  assert.equal(budgetConfig({ ...env, ASK_CACHED_INPUT_USD_PER_MILLION: 'cheap' }), null);
});
