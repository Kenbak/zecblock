'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {classifyFailure,askStage} = require('../../v1/lib/ask-errors');

const cases = [
  ['ask-request-attempts',/submission or verification attempts.*connection/],
  ['ask-request-minute',/per-minute request allowance across all visitors/],
  ['ask-request-day',/daily request allowance across all visitors/],
  ['ask-request-global-hour',/site-wide hourly request limit/],
  ['ask-request-global-day',/site-wide daily request limit/],
  ['ask-ai-minute',/AI has reached its per-minute allowance across all visitors/],
  ['ask-ai-day',/AI has reached its daily allowance across all visitors/],
  ['ask-sql-minute',/SQL has reached its per-minute allowance across all visitors/],
  ['ask-sql-day',/SQL has reached its daily allowance across all visitors/],
  ['ask-ai-calls-day',/site-wide daily call limit/],
  ['ask-ai-budget-day',/site-wide daily usage allowance/],
  ['ask-ai-budget-month',/site-wide monthly usage allowance/],
  ['ask-ai-busy',/simultaneous requests/],
  ['ask-sql-global-day',/site-wide daily query allowance/],
  ['ask-sql-busy',/simultaneous queries/],
  ['ask-sql-queue',/SQL queue is full/],
  ['ask-sql-status-minute',/research status, cancellation or explanation requests/],
];
const failure = (quotaCode,retryAfter = 60,extra = {}) => Object.assign(new Error('postgres://private-secret'),{quota:true,quotaCode,retryAfter,detail:'private-secret',queuePosition:1234,...extra});

test('fixed quota categories expose only their checked code, safe copy and bounded retry window', () => {
  for (const [code,copy] of cases) {
    const result = classifyFailure(failure(code));
    assert.deepEqual(Object.keys(result).sort(),['code','detail','retryAfter','status','type']);
    assert.equal(result.code,code); assert.equal(result.status,429); assert.equal(result.type,'rate-limited'); assert.equal(result.retryAfter,60); assert.match(result.detail,copy);
    assert.doesNotMatch(JSON.stringify(result),/private-secret|postgres|queuePosition|1234|\$|20 requests|5 requests/);
    if (code.startsWith('ask-ai-')) assert.match(result.detail,/SQL directly or use starter charts, subject to their own limits/);
    if (code.startsWith('ask-sql-')) assert.match(result.detail,/query and current results are kept/);
    if (code.startsWith('ask-request-')) assert.match(result.detail,/Ask and SQL/);
  }
});
test('monthly and daily quota retry windows are not truncated to one day', () => {
  assert.equal(classifyFailure(failure('ask-ai-budget-month',2678400)).retryAfter,2678400);
  assert.equal(classifyFailure(failure('ask-ai-budget-day',86400)).retryAfter,86400);
});
test('submission-attempt and research-update limits expose only a bounded sliding minute retry', () => {
  for (const code of ['ask-request-attempts','ask-sql-status-minute']) {
    assert.equal(classifyFailure(failure(code,1)).retryAfter,1);
    assert.equal(classifyFailure(failure(code,60)).retryAfter,60);
    const invalid=classifyFailure(failure(code,61));assert.equal(invalid.code,'ask-quota');assert.equal(invalid.retryAfter,undefined);
  }
});
test('unknown or malformed quota metadata cannot select a category or forward raw diagnostics', () => {
  for (const quotaCode of ['ask-ai-secret','constructor','__proto__','toString','ASK-AI-DAY',null,{},['ask-ai-day']]) {
    const result = classifyFailure(failure(quotaCode));
    assert.equal(result.code,'ask-quota'); assert.equal(result.retryAfter,undefined); assert.doesNotMatch(JSON.stringify(result),/private-secret|postgres/);
  }
  for (const retryAfter of [0,-1,1.5,2678401,Infinity,NaN,'60',null,undefined]) {
    const result = classifyFailure(failure('ask-ai-budget-month',60,{retryAfter}));
    assert.equal(result.code,'ask-quota'); assert.equal(result.retryAfter,undefined);
  }
  for (const quota of [false,1,'true']) assert.notEqual(classifyFailure(failure('ask-ai-day',60,{quota})).code,'ask-ai-day');
  assert.equal(classifyFailure(failure('unknown',60,{askLimit:'day'})).code,'ask-quota');
});
test('legacy shared admission metadata remains compatible without claiming modern bucket limits', () => {
  for (const askLimit of ['minute','day']) {
    const result = classifyFailure(Object.assign(new Error('secret'),{quota:true,askLimit,retryAfter:60}));
    assert.equal(result.code,'ask-quota-'+askLimit); assert.equal(result.retryAfter,60); assert.match(result.detail,/previous shared/); assert.match(result.detail,/legacy allowance/); assert.doesNotMatch(result.detail,/20|5 requests|secret/);
  }
  assert.equal(classifyFailure(Object.assign(new Error('secret'),{quota:true,askLimit:'day',retryAfter:86401})).code,'ask-quota');
});
test('stage wrapping preserves checked quota metadata and never promotes ordinary upstream messages', async () => {
  const error = failure('ask-ai-busy',5);
  await assert.rejects(askStage('provider',async () => { throw error; }),actual => actual === error && classifyFailure(actual).code === 'ask-ai-busy');
  await assert.rejects(askStage('provider',async () => { throw new Error('private-secret'); }),actual => classifyFailure(actual).code === 'ask-provider' && !actual.message.includes('private-secret'));
});
