'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planSchema, compilePlan } = require('../../v1/lib/ask-analytics-plan');
const { createAnalytics, analyticsConfig, checkGuard, evidenceFor } = require('../../v1/lib/ask-analytics');
const { chat } = require('../../v1/lib/ask-chat');
const now = Date.UTC(2026,9,2);
const plan = { version: 1, metric: 'transactions', start: '2026-09-01', end: '2026-09-30', bucket: 'week', order: 'highest', limit: 5 };
const env = { ASK_ANALYTICS_ENABLED: 'true', ASK_ANALYTICS_DATABASE_URL: 'postgresql://ask_analytics_reader:fixture@replica.invalid/test', ASK_ANALYTICS_DAILY_QUERY_LIMIT: '100' };
const guard = { standby: true, identity: true, replay_age: '1', restricted: true, disk_bounded: true, no_memberships: true, no_create: true, only_public_view: true, no_sequences: true, no_definers: true };
const rows = [{ bucket: '2026-09-07', value: '6000', observed_days: 7, observed_through: '2026-09-13' }];
function fixture(overrides = {}) {
  const queries = []; const releases = []; let connects = 0;
  const client = { release: error => releases.push(error || false), query: async (text, values) => {
    queries.push({ text, values });
    if (text.startsWith('SELECT pg_catalog.pg_is_in_recovery')) return { rows: [overrides.guard || guard] };
    if (text.startsWith('SELECT count')) return { rows: [{ observed_days: 30 }] };
    if (text.startsWith('WITH observed')) { if (overrides.queryError) throw new Error('postgres://private-password'); return { rows: overrides.rows || rows }; }
    return { rows: [] };
  } };
  const pool = { connect: async () => { connects++; return client; }, end: async () => {}, on: () => {} };
  const redis = { isReady: true, eval: async () => overrides.quota === false ? 0 : 1, zRem: async () => {} };
  return { service: createAnalytics(env, { pool }), redis, queries, releases, connects: () => connects };
}
test('strict plans block SQL, programs, files, catalogs, joins, malformed and unbounded windows before pool access', async () => {
  const f = fixture();
  for (const payload of [
    { sql: 'DELETE FROM transactions' }, { sql: "COPY (SELECT 1) TO PROGRAM 'id'" }, { metric: 'pg_read_file' }, { metric: "transactions; DROP TABLE blocks;--" },
    { bucket: "day'); SELECT pg_sleep(99)--" }, { order: 'DELETE' }, { dataset: 'paper_portfolio' }, { join: 'social_post_outbox' }, { expressions: ['dblink'] },
    { start: '2026-02-30' }, { start: '2020-01-01' }, { end: '2026-10-02' }, { start: '2026-09-30', end: '2026-09-01' }, { limit: 26 }, { limit: 0 }, { limit: 1.5 },
  ]) await assert.rejects(f.service.execute({ ...plan, ...payload }, { redis: f.redis, now }));
  assert.equal(f.connects(), 0);
  const compiled = compilePlan(plan, now);
  assert.deepEqual(compiled.values, ['2026-09-01','2026-09-30',5]);
  assert.match(compiled.text, /sum\(value\)/); assert.doesNotMatch(compiled.text, /2026-09/);
  assert.match(compilePlan({ ...plan, metric: 'ironwood_balance' }, now).text, /DISTINCT ON/);
  assert.equal(planSchema.safeParse({ ...plan, filters: {} }).success, false);
});
test('dedicated config rejects primary credentials, URL settings and incomplete activation', () => {
  assert.ok(analyticsConfig(env));
  for (const extra of [{ ASK_ANALYTICS_ENABLED: 'false' }, { ASK_ANALYTICS_DATABASE_URL: 'postgres://zcash_user@host/db' }, { ASK_ANALYTICS_DATABASE_URL: env.ASK_ANALYTICS_DATABASE_URL + '?options=unsafe' }, { ASK_ANALYTICS_DAILY_QUERY_LIMIT: '0' }, { ASK_ANALYTICS_DAILY_QUERY_LIMIT: '10001' }]) assert.equal(analyticsConfig({ ...env, ...extra }), null);
});
test('runtime rejects promotion, writer grants, memberships, column access, unsafe functions and stale replay', async () => {
  for (const key of Object.keys(guard).filter(key => key !== 'replay_age')) {
    const f = fixture({ guard: { ...guard, [key]: false } });
    await assert.rejects(f.service.execute(plan, { redis: f.redis, now }), error => error.askKind === 'source');
    assert.equal(f.queries.some(query => query.text.startsWith('WITH observed')), false);
    assert.deepEqual(f.releases, [true]);
  }
  for (const replay_age of [null, 'NaN', '121', '-6']) assert.throws(() => checkGuard({ ...guard, replay_age }));
  checkGuard(guard);
});
test('shared quota and unavailable Redis fail closed; no primary fallback or raw errors', async () => {
  const denied = fixture({ quota: false }); await assert.rejects(denied.service.execute(plan, { redis: denied.redis, now }), error => error.quota);
  assert.equal(denied.connects(), 0);
  await assert.rejects(denied.service.execute(plan, { redis: { isReady: false }, now }));
  const failed = fixture({ queryError: true }); await assert.rejects(failed.service.execute(plan, { redis: failed.redis, now }), error => error.askKind === 'source' && !error.message.includes('password'));
  assert.deepEqual(failed.releases, [true]);
});
test('counts and snapshots retain exact values, coverage and provenance', async () => {
  const f = fixture(); const evidence = await f.service.execute(plan, { redis: f.redis, now });
  assert.equal(evidence.facts.row_a_value, '6,000 transactions');
  assert.equal(evidence.result.coverage.missingDays, 0); assert.equal(evidence.result.rows[0].observedThrough, '2026-09-13');
  assert.match(f.queries[0].text, /READ ONLY/); assert.match(f.queries[1].text, /statement_timeout='3s'/); assert.equal(f.queries.at(-1).text, 'ROLLBACK'); assert.deepEqual(f.releases, [false]);
  const snapshot = evidenceFor(compilePlan({ ...plan, metric: 'ironwood_balance' }, now), [{ ...rows[0], value: '399789745000001' }], { observed_days: 29 }, '2026-10-02T00:00:00Z');
  assert.equal(snapshot.facts.row_a_value, '3997897.45000001 ZEC'); assert.equal(snapshot.result.coverage.missingDays, 1);
  const partial = evidenceFor(compilePlan(plan, now), [{ bucket: '2026-08-31', value: '48158', observed_days: 6, observed_through: '2026-09-06' }], { observed_days: 30 }, '2026-10-02T00:00:00Z');
  assert.equal(partial.facts.row_a_date, '2026-08-31');
  assert.equal(partial.facts.row_a_window_start, '2026-09-01');
  assert.equal(partial.facts.row_a_days, '6');
  assert.equal(evidence.facts.row_a_window_start, '2026-09-07');
  assert.throws(() => evidenceFor(compilePlan(plan, now), [{ ...rows[0], value: '<script>' }], { observed_days: 30 }, 'now'));
});
test('local concurrency and cancellation destroy the connection, including late pool checkout', async () => {
  let resolveConnect; const releases = [];
  const pool = { on() {}, end() {}, connect: () => new Promise(resolve => { resolveConnect = resolve; }) };
  const service = createAnalytics(env, { pool }); const redis = { isReady: true, eval: async () => 1, zRem: async () => {} };
  const a = new AbortController(); const pending = service.execute(plan, { redis, signal: a.signal, now });
  await new Promise(resolve => setImmediate(resolve)); a.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
  resolveConnect({ release: value => releases.push(value) }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(releases, [true]);
  const b = new AbortController(); const c = new AbortController();
  const first = service.execute(plan, { redis, signal: b.signal, now }); const second = service.execute(plan, { redis, signal: c.signal, now });
  await assert.rejects(service.execute(plan, { redis, now }), error => error.quota); b.abort(); c.abort(); await Promise.allSettled([first,second]);
});
test('contextual analytics uses approved plan and verified facts, with no challenge/DSN sent to model', async () => {
  const evidence = evidenceFor(compilePlan(plan, now), rows, { observed_days: 30 }, '2026-10-02T00:00:00Z'); let calls = 0;
  const analytics = { catalogue: [{ metric:'transactions' }], execute: async (query, context) => { assert.deepEqual(query, plan); assert.ok(context.redis); return evidence; } };
  const reply = await chat({ question: 'Rank the five busiest weeks during September', page: 'ask', context:null, locale:'auto', history:[], challenge:'secret-challenge' }, async (input, task) => {
    assert.doesNotMatch(JSON.stringify(input), /secret-challenge|postgres:/); calls++;
    if (calls === 1) return task.validator.parse({ intent:'analytics', analyticsPlan:plan, spec:null, transactionQuery:null, blockQuery:null, flowQuery:null, topics:['transactions'], locale:'en' });
    return task.validator.parse({ summary:'The busiest observed week started on {{row_a_date}}, with {{row_a_value}}.', observations:[], limitation:'', sources:['transactions'] });
  }, null, new AbortController().signal, '', {redis:{}}, analytics);
  assert.equal(calls, 2); assert.equal(reply.analytics.rows.length, 1); assert.match(reply.answer, /6,000 transactions/);
});
test('ranked narrative uses localized periods, preserves full results and cannot dump all ranks', async () => {
  const ranking = [
    { bucket:'2026-09-14',value:'62379',observed_days:7,observed_through:'2026-09-20' },
    { bucket:'2026-09-21',value:'60731',observed_days:7,observed_through:'2026-09-27' },
    { bucket:'2026-08-31',value:'48158',observed_days:6,observed_through:'2026-09-06' },
  ];
  const evidence = evidenceFor(compilePlan(plan,now),ranking,{observed_days:30},'2026-10-02T00:00:00Z');
  const analytics = { catalogue:[],execute:async()=>evidence }; let calls=0;
  const reply = await chat({question:'Classe les semaines de septembre',page:'ask',context:null,locale:'fr',history:[]},async(input,task)=>{
    if (++calls===1) return task.validator.parse({intent:'analytics',analyticsPlan:plan,spec:null,transactionQuery:null,blockQuery:null,flowQuery:null,topics:['transactions'],locale:'fr'});
    assert.equal(input.evidence.rows.length,3);
    assert.match(input.evidence.facts.row_a_period,/sept\./);
    assert.equal(input.evidence.facts.lead_comparison,undefined);
    assert.equal(input.evidence.facts.lead_margin_relative,undefined);
    assert.equal(input.evidence.facts.row_c_value,undefined);
    assert.equal(task.validator.safeParse({summary:'{{row_c_value}}',observations:[],limitation:'',sources:['transactions']}).success,false);
    return task.validator.parse({summary:'Le maximum observé est celui du {{row_a_period}}, avec {{row_a_value}}.',observations:[],limitation:'',sources:['transactions']});
  },null,new AbortController().signal,'',{redis:{}},analytics);
  assert.equal(reply.analytics.rows.length,3); assert.match(reply.answer,/sept\./); assert.doesNotMatch(reply.answer,/2026-09/);
  assert.match(reply.answer,/La période en tête compte 2\.7% de transactions de plus que la suivante\./);
});
