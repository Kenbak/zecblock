'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createAskRouter, RELEASE_EXPLANATION } = require('../../v1/routes/ask');
const { ADMIT, ADMIT_WORK, RESERVE } = require('../../v1/lib/ask-budget');
const { compileResearchSQL, researchEvidence } = require('../../v1/lib/ask-research-sql');
const { coreCatalogue } = require('../../v1/lib/ask-core-catalogue');

const env = {
  ASK_ENABLED: 'true', ASK_PROVIDER: 'openai', ASK_MODEL: 'gpt-6-luna', ASK_REASONING_EFFORT: 'none',
  ASK_DAILY_CALL_LIMIT: '100', ASK_DAILY_BUDGET_USD: '1', ASK_MONTHLY_BUDGET_USD: '5',
  ASK_MAX_INPUT_USD_PER_MILLION: '0.25', ASK_MAX_OUTPUT_USD_PER_MILLION: '0.75',
  ASK_API_KEY: 'fixture-provider-key', ASK_ABUSE_SECRET: 'a'.repeat(32),
  ASK_TURNSTILE_SECRET: 'fixture-verification-key', ASK_TURNSTILE_HOSTNAME: 'example.test', ASK_TURNSTILE_SITE_KEY: 'fixture-site',
  ASK_RESEARCH_ENABLED: 'true', ASK_RESEARCH_EXTENDED: 'true', ASK_RESEARCH_JOBS_ENABLED: 'true', ASK_ANALYTICS_STORE: 'logical_public_core',
};
const query = { version: 3, sql: 'SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 2', limit: 2 };
const chatBody = { question: 'Rank recent blocks by their recorded fees', page: 'ask', context: null, history: [], locale: 'en', challenge: 'fixture-challenge' };
async function evidence(input) {
  const compiled = await compileResearchSQL(input, { extended: true });
  return { result: researchEvidence(compiled, [['100', '100000'], ['99', '200000']], [{ name: 'height', dataTypeID: 20 }, { name: 'fees', dataTypeID: 1700 }], { indexed_through: '2026-10-27T00:00:00Z' }, '2026-10-27T00:00:01Z') };
}
async function fixture(t, { jobsEnabled = true } = {}) {
  const saved = new Map(), jobs = new Map();
  const state = { requests: 0, attempts: { ai: 0, sql: 0 }, admitted: { ai: 0, sql: 0 }, denial: { ai: 0, sql: 0, request: 0, provider: 0 }, reserved: 0, provider: 0, verified: 0, executed: 0, submitted: 0, cancelled: 0, source: 0, receiptFailure: false, providerFailure: false, reservationAccepted: 0, claimReleases: 0, releasedClaims: 0, replaceClaimBeforeRelease: false };
  const redis = {
    isReady: true,
    async eval(script, options) {
      if (script === ADMIT) { state.requests++; return state.denial.request || 1; }
      if (script === ADMIT_WORK) {
        const kind = /:work:(ai|sql):/.exec(options.keys[0])?.[1];
        assert.ok(kind, 'work admission must select a server-owned lane');
        state.attempts[kind]++;
        if (state.denial[kind]) return state.denial[kind];
        state.admitted[kind]++; return 1;
      }
      if (script === RELEASE_EXPLANATION) {
        state.claimReleases++;
        assert.match(options.keys[0], /:job-explanation:[a-f0-9]{64}:attempt$/);
        assert.match(options.arguments[0], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        if (state.replaceClaimBeforeRelease) saved.set(options.keys[0], randomUUID());
        if (saved.get(options.keys[0]) !== options.arguments[0]) return 0;
        saved.delete(options.keys[0]); state.releasedClaims++; return 1;
      }
      assert.equal(script, RESERVE, 'unexpected Redis policy script');
      state.reserved++;
      if (state.denial.provider) return state.denial.provider;
      state.reservationAccepted++; return 1;
    },
    get: async key => saved.get(key) ?? null,
    async set(key, value, options) { if (state.receiptFailure && key.startsWith('ask:{mainnet}:job-ai-admission:')) return null; if (options?.NX && saved.has(key)) return null; saved.set(key, value); return 'OK'; },
    zRem: async () => 1,
  };
  const lookup = ticket => {
    const job = jobs.get(ticket.id);
    if (!job || job.token !== ticket.token) throw Object.assign(Error('Fixture job unavailable'), { askKind: 'job' });
    return job;
  };
  const analytics = {
    jobsEnabled, catalogue: coreCatalogue,
    execute: async input => { state.executed++; return evidence(input); },
    async submit(input) {
      state.submitted++;
      const ticket = { id: randomUUID(), token: String(state.submitted).padStart(64, '0') };
      jobs.set(ticket.id, { ...ticket, result: (await evidence(input)).result }); return ticket;
    },
    async status(ticket) {
      const job = lookup(ticket);
      return { id: ticket.id, state: 'succeeded', createdAt: '2026-10-27T00:00:00Z', startedAt: '2026-10-27T00:00:00Z', finishedAt: '2026-10-27T00:00:01Z', queuePosition: 0, maxRunSeconds: 30, error: null, result: job.result };
    },
    async cancel(ticket) { state.cancelled++; return this.status(ticket); },
  };
  const router = createAskRouter(env, {
    redis, analytics,
    internalClient: { dispatch: async (_method, path) => { state.source++; if (path === '/api/network/pool-history') return { ok: true, body: { points: ['2026-10-25', '2026-10-26'].map((date, i) => ({ date, hasPoolBreakdown: true, orchardZat: String((i + 1) * 100000000), ironwoodZat: '0', saplingZat: '0', sproutZat: '0' })) } }; return { ok: true, body: { success: true, blocks: [{ height: '100', hash: 'a'.repeat(64), timestamp: '1700000000', transaction_count: 3, size: 10000, total_fees: '12345' }] } }; } },
    challengeFetch: async () => { state.verified++; return Response.json({ success: true, action: 'ask', hostname: 'example.test' }); },
    fetch: async (_url, options) => {
      state.provider++;
      if (state.providerFailure) throw Error('Fixture provider transport failure');
      const input = JSON.parse(options.body), task = input.response_format.json_schema.name;
      const value = JSON.parse(input.messages[1].content).evidence?.facts?.orchard_value ? { summary: 'The selected Orchard balance is {{orchard_value}}.', observations: [], limitation: '', sources: ['pools'] } : task === 'contextual_intent' ? { intent: 'research', sql: query.sql, spec: null, blockQuery: null, transactionQuery: null, flowQuery: null, topics: [], locale: 'en' } : task === 'research_sql' ? { sql: query.sql } : task === 'research_caption' ? { finding: 'The first returned fee is {{row_a_b}} zatoshis.', interpretation: '' } : { summary: 'The first returned fee is {{row_a_b}} zatoshis.', observations: [], limitation: '', sources: ['block'] };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
    },
  });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.v1 = { network: 'mainnet', requestId: 'fixture', abortSignal: new AbortController().signal }; next(); });
  app.use('/ask', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await router.stop(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/ask`;
  async function post(path, body, headers = {}) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
  }
  return { state, post };
}

// Redis Lua limit/reset behavior has separate native Redis tests. These fixtures
// exercise which real HTTP paths select each admission/reservation policy.
test('direct block and reviewed-guide answers remain available after the AI allowance is exhausted', async t => {
  const { state, post } = await fixture(t); state.denial.ai = -2;
  const block = await post('/chat', { ...chatBody, question: 'Tell me about the latest block' });
  assert.equal(block.status, 200); assert.equal(block.body.data.blocks.rows[0].height, 100);
  const guide = await post('/chat', { ...chatBody, page: 'unit_converter', question: 'What is a zatoshi?' });
  assert.equal(guide.status, 200); assert.match(guide.body.data.answer, /zatoshi|hundred million/i);
  assert.equal(state.requests, 2); assert.equal(state.verified, 2); assert.equal(state.source, 1);
  assert.deepEqual(state.attempts, { ai: 0, sql: 0 }); assert.equal(state.provider, 0); assert.equal(state.reserved, 0);
});

test('manual synchronous and queued SQL use only SQL work even after AI denial', async t => {
  const { state, post } = await fixture(t); state.denial.ai = -2;
  const sync = await post('/research/query', { ...query, challenge: 'fixture-challenge' });
  assert.equal(sync.status, 200); assert.equal(sync.body.data.result.rows[0][1], '100000');
  const queued = await post('/research/jobs', { ...query, challenge: 'fixture-challenge' });
  assert.equal(queued.status, 200); assert.ok(queued.body.data.job);
  assert.deepEqual(state.admitted, { ai: 0, sql: 2 }); assert.equal(state.executed, 1); assert.equal(state.submitted, 1);
  assert.equal(state.requests, 2); assert.equal(state.provider, 0); assert.equal(state.reserved, 0);
});

test('AI denial occurs before provider traffic and does not deny subsequent manual SQL', async t => {
  const { state, post } = await fixture(t); state.denial.ai = -2;
  const denied = await post('/chat', chatBody);
  assert.equal(denied.status, 429); assert.equal(denied.body.code, 'ask-ai-day'); assert.ok(Number(denied.retryAfter) > 0);
  assert.equal(state.provider, 0); assert.equal(state.reserved, 0); assert.equal(state.submitted, 0); assert.equal(state.executed, 0);
  assert.equal((await post('/research/query', { ...query, challenge: 'fixture-challenge' })).status, 200);
  assert.deepEqual(state.admitted, { ai: 0, sql: 1 });
});

test('SQL denial stops manual execution and AI-selected SQL without charging SQL twice', async t => {
  const { state, post } = await fixture(t); state.denial.sql = -2;
  const manual = await post('/research/query', { ...query, challenge: 'fixture-challenge' });
  assert.equal(manual.status, 429); assert.equal(manual.body.code, 'ask-sql-day');
  const ai = await post('/chat', chatBody);
  assert.equal(ai.status, 429); assert.equal(ai.body.code, 'ask-sql-day');
  assert.deepEqual(state.attempts, { ai: 1, sql: 2 }); assert.deepEqual(state.admitted, { ai: 1, sql: 0 });
  assert.equal(state.provider, 1); assert.equal(state.reserved, 1); assert.equal(state.submitted, 0); assert.equal(state.executed, 0);
});

test('synchronous AI research consumes AI and SQL work once across selection and narration', async t => {
  const { state, post } = await fixture(t, { jobsEnabled: false });
  const response = await post('/chat', chatBody);
  assert.equal(response.status, 200); assert.ok(response.body.data.research);
  assert.deepEqual(state.admitted, { ai: 1, sql: 1 }); assert.equal(state.requests, 1); assert.equal(state.verified, 1);
  assert.equal(state.provider, 2); assert.equal(state.reserved, 2); assert.equal(state.executed, 1);
});

test('an AI-submitted job can finish explanation after AI exhaustion without a second AI-work charge', async t => {
  const { state, post } = await fixture(t);
  const response = await post('/chat', chatBody); assert.equal(response.status, 200);
  const ticket = response.body.data.job; assert.ok(ticket);
  assert.deepEqual(state.admitted, { ai: 1, sql: 1 }); assert.equal(state.provider, 1);
  state.denial.ai = -2; state.denial.sql = -2;
  const body = { ...ticket, question: chatBody.question, locale: 'en' };
  const explained = await post('/research/jobs/explain', body);
  assert.equal(explained.status, 200); assert.ok(explained.body.data.research); assert.match(explained.body.data.answer, /100,000/);
  // The explanation carries the scope of what ran, for the next question.
  assert.equal(explained.body.data.turnScope.kind, 'sql'); assert.ok(explained.body.data.turnScope.datasets.length);
  assert.deepEqual(state.attempts, { ai: 1, sql: 1 }); assert.equal(state.provider, 2); assert.equal(state.reserved, 2);
  for (const path of ['/research/jobs/status', '/research/jobs/cancel']) assert.equal((await post(path, ticket)).status, 200);
  assert.equal((await post('/research/jobs/explain', body)).status, 200);
  assert.deepEqual(state.attempts, { ai: 1, sql: 1 }); assert.equal(state.provider, 2); assert.equal(state.requests, 1);
});

test('manual-job explanation requires AI work and preserves data when its AI allowance is exhausted', async t => {
  const { state, post } = await fixture(t);
  const submitted = await post('/research/jobs', { ...query, challenge: 'fixture-challenge' });
  const ticket = submitted.body.data.job;
  state.denial.ai = -2;
  const explanation = await post('/research/jobs/explain', { ...ticket, question: 'Explain these fees', locale: 'en' });
  assert.equal(explanation.status, 429); assert.equal(explanation.body.code, 'ask-ai-day');
  assert.deepEqual(state.admitted, { ai: 0, sql: 1 }); assert.equal(state.provider, 0); assert.equal(state.reserved, 0);
  const status = await post('/research/jobs/status', ticket); assert.equal(status.status, 200); assert.equal(status.body.data.result.rows[0][1], '100000');
});

test('manual-job explanation admits AI once and cached completion does not admit or spend again', async t => {
  const { state, post } = await fixture(t);
  const submitted = await post('/research/jobs', { ...query, challenge: 'fixture-challenge' });
  const body = { ...submitted.body.data.job, question: 'Explain these fees', locale: 'en' };
  assert.equal((await post('/research/jobs/explain', body)).status, 200);
  assert.equal((await post('/research/jobs/explain', body)).status, 200);
  assert.deepEqual(state.admitted, { ai: 1, sql: 1 }); assert.equal(state.provider, 1); assert.equal(state.reserved, 1); assert.equal(state.requests, 1);
});

test('provider financial denial remains independent of manual SQL allowance', async t => {
  const { state, post } = await fixture(t); state.denial.provider = -2;
  const response = await post('/chat', chatBody);
  assert.equal(response.status, 429); assert.equal(response.body.code, 'ask-ai-budget-day'); assert.equal(state.provider, 0);
  assert.equal((await post('/research/query', { ...query, challenge: 'fixture-challenge' })).status, 200);
  assert.deepEqual(state.admitted, { ai: 1, sql: 1 }); assert.equal(state.reserved, 1);
});

test('ordinary global request admission still protects direct and manual paths', async t => {
  const { state, post } = await fixture(t); state.denial.request = -3;
  for (const [path, body] of [['/chat', { ...chatBody, question: 'Tell me about the latest block' }], ['/research/query', { ...query, challenge: 'fixture-challenge' }]]) {
    const response = await post(path, body); assert.equal(response.status, 429); assert.equal(response.body.code, 'ask-request-global-hour'); assert.ok(Number(response.retryAfter) > 0);
  }
  assert.equal(state.source, 0); assert.equal(state.executed, 0); assert.equal(state.provider, 0); assert.deepEqual(state.admitted, { ai: 0, sql: 0 });
});

test('client flags, forged job capabilities and invalid SQL cannot authorize an admission bypass', async t => {
  const { state, post } = await fixture(t); state.denial.ai = -2;
  for (const extra of [{ aiAdmitted: true }, { admission: 'ai' }, { authenticatedStaging: true }, { skipQuota: true }]) assert.equal((await post('/chat', { ...chatBody, ...extra })).status, 400);
  assert.equal((await post('/research/query', { ...query, sql: 'DELETE FROM blocks', challenge: 'fixture-challenge' })).status, 400);
  assert.deepEqual(state.attempts, { ai: 0, sql: 0 }); assert.equal(state.requests, 0);
  const spoofed = await post('/chat', chatBody, { 'x-ask-ai-admitted': 'true', 'x-ask-staging-authenticated': 'true' });
  assert.equal(spoofed.status, 429); assert.equal(spoofed.body.code, 'ask-ai-day'); assert.equal(state.provider, 0);
  const guessed = await post('/research/jobs/explain', { id: randomUUID(), token: 'f'.repeat(64), question: 'Explain' });
  assert.equal(guessed.status, 404); assert.equal(state.provider, 0); assert.equal(state.reserved, 0);
});


test('an explicit chart explanation preserves measured context instead of returning a static guide', async t => {
  const { state, post } = await fixture(t);
  const context = { version: 1, metric: 'balances', period: '30d', pool: 'orchard', view: 'line', start: '2026-10-25', end: '2026-10-26' };
  const response = await post('/chat', { ...chatBody, question: 'Explain this chart', page: 'pools', context });
  assert.equal(response.status, 200); assert.equal(response.body.data.mode, 'ai');
  assert.deepEqual(response.body.data.spec, context); assert.ok(response.body.data.evidenceKey); assert.ok(response.body.data.dataContext);
  assert.match(response.body.data.answer, /selected Orchard balance/);
  assert.deepEqual(state.admitted, { ai: 1, sql: 0 }); assert.equal(state.source, 1); assert.equal(state.provider, 1); assert.equal(state.reserved, 1);
});

test('AI job admission receipts are bound to their exact ticket, not other valid manual jobs', async t => {
  const { state, post } = await fixture(t);
  const ai = await post('/chat', chatBody), manual = await post('/research/jobs', { ...query, challenge: 'fixture-challenge' });
  state.denial.ai = -2;
  const refused = await post('/research/jobs/explain', { ...manual.body.data.job, question: 'Explain these fees' });
  assert.equal(refused.status, 429); assert.equal(refused.body.code, 'ask-ai-day');
  const allowed = await post('/research/jobs/explain', { ...ai.body.data.job, question: chatBody.question });
  assert.equal(allowed.status, 200); assert.deepEqual(state.admitted, { ai: 1, sql: 2 }); assert.equal(state.provider, 2);
});

test('a failed AI-admission receipt write cancels the submitted job rather than returning an untracked ticket', async t => {
  const { state, post } = await fixture(t); state.receiptFailure = true;
  const response = await post('/chat', chatBody);
  assert.equal(response.status, 503); assert.equal(response.body.data?.job, undefined);
  assert.equal(state.submitted, 1); assert.equal(state.cancelled, 1); assert.equal(state.provider, 1);
  assert.deepEqual(state.admitted, { ai: 1, sql: 1 });
});


test('a pre-provider AI-minute denial releases its claim so the same manual job can be explained later', async t => {
  const { state, post } = await fixture(t);
  const submitted = await post('/research/jobs', { ...query, challenge: 'fixture-challenge' });
  const body = { ...submitted.body.data.job, question: 'Explain these fees', locale: 'en' };
  state.denial.ai = -1;
  const denied = await post('/research/jobs/explain', body);
  assert.equal(denied.status, 429); assert.equal(denied.body.code, 'ask-ai-minute');
  assert.equal(state.provider, 0); assert.equal(state.reserved, 0); assert.equal(state.claimReleases, 1); assert.equal(state.releasedClaims, 1);
  state.denial.ai = 0; // Only this fixture changes; no live allowance is reset.
  const retry = await post('/research/jobs/explain', body);
  assert.equal(retry.status, 200); assert.ok(retry.body.data.research);
  assert.deepEqual(state.admitted, { ai: 1, sql: 1 }); assert.deepEqual(state.attempts, { ai: 2, sql: 1 });
  assert.equal(state.submitted, 1); assert.equal(state.executed, 0); assert.equal(state.requests, 1);
  assert.equal(state.provider, 1); assert.equal(state.reservationAccepted, 1);
});

test('a pre-provider budget denial retries the same manual job without charging admitted AI work twice', async t => {
  const { state, post } = await fixture(t);
  const submitted = await post('/research/jobs', { ...query, challenge: 'fixture-challenge' });
  const body = { ...submitted.body.data.job, question: 'Explain these fees', locale: 'en' };
  state.denial.provider = -2;
  const denied = await post('/research/jobs/explain', body);
  assert.equal(denied.status, 429); assert.equal(denied.body.code, 'ask-ai-budget-day');
  assert.equal(state.provider, 0); assert.equal(state.reservationAccepted, 0); assert.equal(state.releasedClaims, 1);
  assert.deepEqual(state.admitted, { ai: 1, sql: 1 });
  state.denial.provider = 0; state.denial.ai = -2; // Persisted admission receipt must allow completion.
  const retry = await post('/research/jobs/explain', body);
  assert.equal(retry.status, 200); assert.ok(retry.body.data.research);
  assert.deepEqual(state.attempts, { ai: 1, sql: 1 }); assert.deepEqual(state.admitted, { ai: 1, sql: 1 });
  assert.equal(state.submitted, 1); assert.equal(state.executed, 0); assert.equal(state.provider, 1);
  assert.equal(state.reserved, 2); assert.equal(state.reservationAccepted, 1);
});

test('failure after provider dispatch retains the attempt claim and cannot reserve a second attempt', async t => {
  const { state, post } = await fixture(t);
  const submitted = await post('/research/jobs', { ...query, challenge: 'fixture-challenge' });
  const body = { ...submitted.body.data.job, question: 'Explain these fees', locale: 'en' };
  state.providerFailure = true;
  const failed = await post('/research/jobs/explain', body);
  assert.equal(failed.status, 503); assert.equal(failed.body.code, 'ask-provider');
  state.providerFailure = false;
  const retried = await post('/research/jobs/explain', body);
  assert.equal(retried.status, 503); assert.equal(retried.body.code, 'ask-answer');
  assert.equal(state.claimReleases, 0); assert.equal(state.provider, 1); assert.equal(state.reserved, 1); assert.equal(state.reservationAccepted, 1);
  assert.deepEqual(state.attempts, { ai: 1, sql: 1 }); assert.equal(state.submitted, 1); assert.equal(state.executed, 0);
});

test('an expired request cannot release an explanation claim owned by a newer request', async t => {
  const { state, post } = await fixture(t);
  const submitted = await post('/research/jobs', { ...query, challenge: 'fixture-challenge' });
  const body = { ...submitted.body.data.job, question: 'Explain these fees', locale: 'en' };
  state.denial.ai = -1; state.replaceClaimBeforeRelease = true;
  assert.equal((await post('/research/jobs/explain', body)).status, 429);
  assert.equal(state.claimReleases, 1); assert.equal(state.releasedClaims, 0);
  state.denial.ai = 0; state.replaceClaimBeforeRelease = false;
  const response = await post('/research/jobs/explain', body);
  assert.equal(response.status, 503); assert.equal(response.body.code, 'ask-answer');
  assert.equal(state.provider, 0); assert.equal(state.reserved, 0); assert.deepEqual(state.attempts, { ai: 1, sql: 1 });
});


test('an exact standalone concept remains a direct answer within a conversation after AI exhaustion', async t => {
  const { state, post } = await fixture(t); state.denial.ai = -2;
  const response = await post('/chat', { ...chatBody, question: 'What is a viewing key?', history: ['Rank recent blocks by their recorded fees', 'Compare those results'] });
  assert.equal(response.status, 200); assert.equal(response.body.data.mode, 'guided');
  assert.match(response.body.data.answer, /[Vv]iewing keys/); assert.equal(response.body.data.sources[0].id, 'unified_addresses');
  assert.equal(state.requests, 1); assert.equal(state.verified, 1); assert.equal(state.source, 0);
  assert.deepEqual(state.attempts, { ai: 0, sql: 0 }); assert.equal(state.provider, 0); assert.equal(state.reserved, 0);
});
