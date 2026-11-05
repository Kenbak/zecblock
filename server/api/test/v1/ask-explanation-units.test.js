'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { renderExplanation, explanationTaskFor, loadExplanationEvidence } = require('../../v1/lib/ask-explanation');
const { createAskRouter } = require('../../v1/routes/ask');
const prose = (summary, observations = [], limitation = '') => ({ summary, observations, limitation });
const facts = Object.freeze({ amount: '123.00000001 ZEC', dollars: '456.12 USD', share: '12.50%', movement: '+1.25 percentage points', count: '123 transactions', date: '17 Oct 2026', bare_amount: '0.0039373711', bare_count: '0', bare_date: '2026-10-17', asset: 'ZEC' });

test('unit-bearing facts render one unit in every explanation field', () => {
  const raw = prose('The balance was {{amount}} ZEC.', ['Its tracked valuation was {{dollars}} USD.'], 'The observed share was {{share}}%.');
  const rendered = renderExplanation(raw, facts);
  assert.deepEqual(rendered, prose('The balance was 123.00000001 ZEC.', ['Its tracked valuation was 456.12 USD.'], 'The observed share was 12.50%.'));
  assert.equal(raw.summary, 'The balance was {{amount}} ZEC.');
  assert.equal(facts.amount, '123.00000001 ZEC');
});

test('constrained provider decoding admits a repeated suffix and the renderer resolves it using the fact', () => {
  const raw = explanationTaskFor(facts).validator.parse(prose('The balance was {{amount}} ZEC.'));
  assert.equal(renderExplanation(raw, facts).summary, 'The balance was 123.00000001 ZEC.');
});

test('adjacent equivalent units handle case, horizontal spacing and multiple facts without changing numeric precision', () => {
  for (const gap of ['', ' ', '\t', '\u00a0', '\u202f']) {
    const rendered = renderExplanation(prose(`The balance was {{amount}}${gap}zec; valuation was {{dollars}}${gap}USD.`), facts);
    assert.equal(rendered.summary, 'The balance was 123.00000001 ZEC; valuation was 456.12 USD.');
  }
  assert.equal(renderExplanation(prose('The balance was {{amount}} ZEC ZEC.'), facts).summary, 'The balance was 123.00000001 ZEC.');
  assert.equal(renderExplanation(prose('The balance was {{amount}} ZEC, observed on {{date}}.'), facts).summary, 'The balance was 123.00000001 ZEC, observed on 17 Oct 2026.');
  const exact = '90,071,992.5474099300001 ZEC';
  assert.equal(renderExplanation(prose('The exact balance was {{amount}} ZEC.'), { amount: exact }).summary, `The exact balance was ${exact}.`);
});

test('percent, percentage-point, monetary-subunit and count facts retain their own dimensions', () => {
  for (const [value, suffix, expected] of [
    ['12.50%', '%', '12.50%'], ['12.50 %', 'percent', '12.50 %'],
    ['+1.25 percentage points', 'percentage points', '+1.25 percentage points'],
    ['123 transactions', 'transactions', '123 transactions'], ['1 transaction', 'transactions', '1 transaction'],
    ['1 address', 'addresses', '1 address'], ['75 seconds', 'seconds', '75 seconds'],
    ['123 zatoshis', 'zats', '123 zatoshis'], ['\u2212123.00 ZEC', 'ZEC', '\u2212123.00 ZEC'],
  ]) assert.equal(renderExplanation(prose(`The measured value was {{value}} ${suffix}.`), { value }).summary, `The measured value was ${expected}.`);
  for (const [id, suffix] of [['share', 'percentage points'], ['movement', '%'], ['count', 'ZEC'], ['amount', 'transactions']]) {
    assert.throws(() => renderExplanation(prose(`The measure was {{${id}}} ${suffix}.`), facts), /Conflicting evidence unit/);
  }
});

test('a conflicting unit is rejected rather than removed or hidden behind a repeated correct unit', () => {
  for (const [id, suffix] of [['amount', 'USD'], ['dollars', 'ZEC'], ['amount', 'zatoshis'], ['amount', 'ZEC USD'], ['dollars', 'USD ZEC']]) {
    assert.throws(() => renderExplanation(prose(`The amount was {{${id}}} ${suffix}.`), facts), /Conflicting evidence unit/);
  }
  for (const field of ['summary', 'observations', 'limitation']) {
    const raw = prose('The source observation is {{date}}.');
    if (field === 'observations') raw.observations = ['The amount was {{amount}} USD.'];
    else raw[field] = 'The amount was {{amount}} USD.';
    assert.throws(() => renderExplanation(raw, facts), /Conflicting evidence unit/);
  }
});

test('bare SQL cells, dates and text labels keep their surrounding prose units exactly', () => {
  for (const suffix of ['ZEC', 'USD', '%', 'transactions']) {
    assert.equal(renderExplanation(prose(`The returned value was {{bare_amount}} ${suffix}.`), facts).summary, `The returned value was 0.0039373711 ${suffix}.`);
  }
  assert.equal(renderExplanation(prose('There were {{bare_count}} transactions on {{bare_date}}.'), facts).summary, 'There were 0 transactions on 2026-10-17.');
  assert.equal(renderExplanation(prose('As of {{date}}, ZEC remains the named asset.'), facts).summary, 'As of 17 Oct 2026, ZEC remains the named asset.');
  assert.equal(renderExplanation(prose('The asset label is {{asset}} ZEC.'), facts).summary, 'The asset label is ZEC ZEC.');
});

test('unit substitution is local and does not rewrite adjectives, separate clauses or line breaks', () => {
  for (const [suffix, expected] of [
    [' ZEC-denominated observations', ' ZEC-denominated observations'],
    [' ZECs', ' ZECs'], [' ZEC_name', ' ZEC_name'],
    [', with ZEC named separately', ', with ZEC named separately'],
    ['\nZEC is the asset', '\nZEC is the asset'],
  ]) assert.equal(renderExplanation(prose(`The balance was {{amount}}${suffix}.`), facts).summary, `The balance was 123.00000001 ZEC${expected}.`);
});

test('original numerical, date, link, markup and placeholder guards run before unit substitution', () => {
  for (const invalid of [
    '{{amount}} ZEC plus 42.', '{{amount}} ZEC on 2026-10-17.', '{{amount}} ZEC plus ١٢.',
    '{{amount}} ZEC plus １２.', '{{amount}} ZEC plus Ⅻ.', '{{amount}} ZEC plus ².',
    '{{amount}} ZEC 🪙.', '{{amount}} ZEC <b>balance</b>.', '{{amount}} ZEC https://example.test',
    '{{amount}} ZEC www.example.test', '{{amount}} ZEC [source](https://example.test)',
    '{{missing}} ZEC.', '{{amount}} ZEC {unvalidated}.', '{{AMOUNT}} ZEC.',
  ]) {
    for (const field of ['summary', 'observations', 'limitation']) {
      const raw = prose('The source observation is {{date}}.');
      if (field === 'observations') raw.observations = [invalid]; else raw[field] = invalid;
      assert.throws(() => renderExplanation(raw, facts), /Unknown evidence reference|Unvalidated numerical claim or markup/);
    }
  }
});

test('chart explanation router renders one unit from server evidence with a stubbed provider', async t => {
  const spec = { version: 1, metric: 'balances', period: '30d', pool: 'orchard', view: 'line', start: null, end: null };
  const internalClient = { dispatch: async () => ({ ok: true, body: { points: [{ date: '2026-08-01', orchardZat: '100000000', hasPoolBreakdown: true }, { date: '2026-08-02', orchardZat: '200000000', hasPoolBreakdown: true }] } }) };
  const evidence = await loadExplanationEvidence(spec, internalClient, new AbortController().signal);
  const env = { ASK_ENABLED: 'true', ASK_PROVIDER: 'openai', ASK_MODEL: 'fixture', ASK_API_KEY: 'fixture', ASK_DAILY_CALL_LIMIT: '50', ASK_DAILY_BUDGET_USD: '1', ASK_MONTHLY_BUDGET_USD: '5', ASK_MAX_INPUT_USD_PER_MILLION: '0.25', ASK_MAX_OUTPUT_USD_PER_MILLION: '0.75', ASK_ABUSE_SECRET: 'x'.repeat(32), ASK_TURNSTILE_SECRET: 'fixture', ASK_TURNSTILE_HOSTNAME: 'example.test', ASK_TURNSTILE_SITE_KEY: 'fixture' };
  let providerCalls = 0;
  const router = createAskRouter(env, {
    redis: { isReady: true, eval: async () => 1, zRem: async () => {}, get: async () => null, set: async () => {} }, internalClient,
    challengeFetch: async () => Response.json({ success: true, action: 'ask', hostname: 'example.test' }),
    fetch: async (url, init) => {
      providerCalls++;
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(JSON.parse(JSON.parse(init.body).messages[1].content).facts.orchard_value, '2.00 ZEC');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(prose('Orchard held {{orchard_value}} ZEC.', ['Its balance changed by {{orchard_change}} ZEC.'])) } }] });
    },
  });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.v1 = { network: 'mainnet', requestId: 'units-fixture', abortSignal: new AbortController().signal }; next(); });
  app.use('/ask', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await router.stop(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/ask/explain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec, evidenceKey: evidence.evidenceKey, challenge: 'fixture-token' }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.equal(body.data.explanation.summary, 'Orchard held 2.00 ZEC.');
  assert.deepEqual(body.data.explanation.observations, ['Its balance changed by +1.00 ZEC.']);
  assert.equal(body.data.evidenceKey, evidence.evidenceKey); assert.equal(providerCalls, 1);
});

test('a sign that only repeats its direction word is dropped; a contradicting one is kept', () => {
  const { renderExplanation } = require('../../v1/lib/ask-explanation');
  const facts = { fall_change: '−35,638.54 ZEC', rise_change: '+12 ZEC', odd_change: '−3 ZEC' };
  const { summary } = renderExplanation({ summary: 'It fell by {{fall_change}} and rose by {{rise_change}}; it rose by {{odd_change}}. Net {{fall_change}}.', observations: [], limitation: '' }, facts);
  assert.equal(summary, 'It fell by 35,638.54 ZEC and rose by 12 ZEC; it rose by −3 ZEC. Net −35,638.54 ZEC.');
});
