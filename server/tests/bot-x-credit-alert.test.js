'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCreditAlert, isCreditError, TEXT } = require('../bot/lib/x-credit-alert');
const { XClient } = require('../bot/lib/x-client');

const quiet = { info() {}, warn() {}, error() {} };
const xError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('only an empty credit balance counts', () => {
  assert.equal(isCreditError(xError(402, 'X API 402: CreditsDepleted')), true);
  assert.equal(isCreditError(xError(403, 'X API 403: Your enrolled account does not have any credits to fulfill this request.')), true);
  assert.equal(isCreditError(xError(429, 'X API 429: Too Many Requests')), false);
  assert.equal(isCreditError(xError(401, 'X API 401: Unauthorized')), false);
  assert.equal(isCreditError(xError(403, 'X API 403: Forbidden')), false);
  assert.equal(isCreditError(new Error('X API request timed out')), false);
  assert.equal(isCreditError(null), false);
});

test('one alert every six hours, and a failed alert is tried again', async () => {
  let clock = 0;
  const sent = [];
  const alert = createCreditAlert({ send: async text => { sent.push(text); }, logger: quiet, now: () => clock });
  assert.equal(await alert(xError(429, 'X API 429: Too Many Requests')), false);
  assert.equal(await alert(xError(402, 'X API 402: CreditsDepleted')), true);
  assert.equal(await alert(xError(402, 'X API 402: CreditsDepleted')), false, 'not on every failed post');
  clock = 6 * 3600_000;
  assert.equal(await alert(xError(402, 'X API 402: CreditsDepleted')), true);
  assert.deepEqual(sent, [TEXT, TEXT]);
  assert.doesNotMatch(TEXT, /[_*`[]/, 'no characters Telegram Markdown would misread');

  let fail = true;
  const flaky = createCreditAlert({ send: async () => { if (fail) throw new Error('Signal Telegram is not configured'); }, logger: quiet, now: () => 0 });
  assert.equal(await flaky(xError(402, 'CreditsDepleted')), false);
  fail = false;
  assert.equal(await flaky(xError(402, 'CreditsDepleted')), true, 'the next failure alerts once Telegram works');
});

test('the X client reports failures without changing what the caller sees', async () => {
  const seen = [];
  const x = new XClient({ accessToken: 'unit-test-placeholder', refreshToken: 'unit-test-placeholder', clientId: 'unit-test', logger: quiet,
    onError: async error => { seen.push(error.statusCode); throw new Error('a broken hook must not matter'); } });
  x._doRefresh = async () => {};
  x._postTweet = async () => { throw xError(402, 'X API 402: CreditsDepleted'); };
  await assert.rejects(x.post('hello'), /402/);
  await assert.rejects(x.reply('hello', '123'), /402/);
  // A 401 that survives the token refresh is reported once, as the final error.
  let calls = 0;
  x._postTweet = async () => { calls++; throw xError(calls === 1 ? 401 : 402, 'X API: refused'); };
  await assert.rejects(x.post('hello'), /refused/);
  // A refresh that fixes the request reports nothing.
  calls = 0;
  x._postTweet = async () => { if (++calls === 1) throw xError(401, 'X API 401: expired'); return { id: '1', text: 'hello' }; };
  assert.equal((await x.post('hello')).id, '1');
  await settle();
  assert.deepEqual(seen, [402, 402, 402]);
  const plain = new XClient({ accessToken: 'unit-test-placeholder', logger: quiet });
  plain._postTweet = async () => { throw xError(402, 'X API 402: CreditsDepleted'); };
  await assert.rejects(plain.post('hello'), /402/, 'no hook configured is fine');
});
