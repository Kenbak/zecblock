'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { compilePlan } = require('../../v1/lib/ask-analytics-plan');
const { catalogue } = require('../../v1/lib/ask-query-plan');
const { queryEvidence, decimal } = require('../../v1/lib/ask-query-evidence');
const { chat } = require('../../v1/lib/ask-chat');
const now = Date.UTC(2026, 9, 3);
const plan = { version: 2, dataset: 'flows', start: '2026-01-01', end: '2026-10-01', bucket: 'week', dimensions: [], filters: [{ field: 'direction', op: 'eq', value: 'deshield' }], measures: [{ field: 'records', operation: 'count', filters: [] }, { field: 'amount', operation: 'sum', filters: [] }], calculations: [], order: { column: 1, direction: 'desc' }, limit: 5 };
test('general plans compile indexed time predicates, grouping, multi-measures and bound filters', () => {
    const c = compilePlan(plan, now);
    assert.match(c.text, /ask_public.flows_v2/);
    assert.match(c.text, /timestamp >= .*::bigint/);
    assert.match(c.text, /GROUP BY/);
    assert.match(c.text, /sum\(amount::numeric\)/);
    assert.match(c.text, /calculated.m0 DESC/);
    assert.ok(c.values.includes('deshield'));
    assert.doesNotMatch(c.text, /deshield/);
    const injected = compilePlan({ ...plan, filters: [{ field: 'pool', op: 'eq', value: "x'; SELECT pg_read_file('/etc/passwd');--" }] }, now);
    assert.doesNotMatch(injected.text, /pg_read_file|passwd/);
    assert.ok(injected.values.some(v => String(v).includes('pg_read_file')));
    assert.equal(catalogue.length, 5);
});
test('untrusted plans cannot select private objects, execute expressions, change privileges, expand scans or sum stocks', () => {
    for (const change of [{ sql: 'DELETE FROM blocks' }, { dataset: 'pg_catalog' }, { join: 'paper_portfolio' }, { dimensions: ['pg_read_file'] }, { bucket: "week');DROP TABLE blocks;--" }, { filters: [{ field: 'amount', op: 'gte', value: '0; SELECT pg_sleep(5)' }] }, { measures: [{ field: 'amount', operation: 'last', filters: [] }] }, { measures: [{ field: 'pg_read_file', operation: 'sum', filters: [] }] }, { limit: 26 }, { start: '2024-01-01' }, { end: '2026-10-03' }, { end: '2026-02-30' }, { order: { column: 8, direction: 'desc' } }, { calculations: [{ operation: 'ratio', left: 0, right: 1 }] }])
        assert.throws(() => compilePlan({ ...plan, ...change }, now), JSON.stringify(change));
    assert.throws(() => compilePlan({ ...plan, dataset: 'daily', filters: [], measures: [{ field: 'ironwood', operation: 'sum', filters: [] }] }, now));
});
test('exact decimal evidence preserves large zatoshis, signed differences, null ratios and sparse event semantics', () => {
    assert.equal(decimal('399789745000001.000000', 'ZEC'), '3,997,897.45000001 ZEC');
    assert.equal(decimal('-1.000000', 'ZEC'), '-0.00000001 ZEC');
    assert.equal(decimal('2.700000', '%'), '2.7 %');
    const compiled = compilePlan(plan, now), e = queryEvidence(compiled, [{ d0: '2026-09-14', m0: '100.000000', m1: '9007199254740993.000000', u0: '0', u1: '0' }], { observed_days: null, indexed_through: '2026-10-02T23:59:00Z' }, '2026-10-03T00:00:00Z');
    assert.equal(e.result.coverage.missingDays, null);
    assert.equal(e.result.rows[0].m1.value, '9007199254740993.000000');
    assert.equal(e.facts.row_a_mb, '90,071,992.54740993 ZEC');
    assert.match(e.result.methodology, /completeness is not certified/);
    assert.throws(() => queryEvidence(compiled, [{ d0: '2026-09-14', m0: 'NaN', m1: '1', u0: '0', u1: '0' }], { observed_days: null, indexed_through: '2026-10-02' }, '2026-10-03'));
});
test('custom query chat passes previous plan as untrusted context and returns verified multi-measure narrative', async () => {
    const compiled = compilePlan(plan, now), e = queryEvidence(compiled, [{ d0: '2026-09-14', m0: '100', m1: '50000000000', u0: '0', u1: '0' }], { observed_days: null, indexed_through: '2026-10-02T23:59:00Z' }, '2026-10-03T00:00:00Z');
    let calls = 0;
    const reply = await chat({ question: 'What about the busiest deshielding week in 2026?', page: 'ask', context: null, locale: 'auto', history: ['Rank shielding weeks'], currentAnalytics: plan, challenge: 'secret' }, async (input, task) => {
        if (++calls === 1) {
            assert.deepEqual(input.currentAnalytics, plan);
            assert.doesNotMatch(JSON.stringify(input), /secret/);
            return task.validator.parse({ intent: 'analytics', analyticsPlan: plan, spec: null, flowQuery: null, blockQuery: null, transactionQuery: null, topics: ['pools'], locale: 'en' });
        }
        assert.match(input.evidence.facts.row_a_da, /14.*20 Sept/);
        return task.validator.parse({ summary: 'The busiest observed deshielding week was {{row_a_da}}, with {{row_a_ma}} totaling {{row_a_mb}}.', observations: [], limitation: '', sources: ['pools'] });
    }, null, new AbortController().signal, '', { redis: {} }, { catalogue, execute: async () => e });
    assert.match(reply.answer, /100 records totaling 500 ZEC/);
    assert.equal(reply.analytics.plan.version, 2);
});
module.exports = { plan };

test('narrative rounds money with explicit approximation and preserves tiny fees and large exact values',()=>{
 const {narrativeDecimal}=require('../../v1/lib/ask-query-reply');
 assert.equal(narrativeDecimal('55388103348791.000000','ZEC'),'≈553,881.03 ZEC');
 assert.equal(narrativeDecimal('22073.250695','ZEC'),'≈0.00022073 ZEC');
 assert.equal(narrativeDecimal('-1.000000','ZEC'),'-0.00000001 ZEC');
 assert.equal(narrativeDecimal('50000000000','ZEC'),'500 ZEC');
});

 test('provider prose rejects numeral-script evasions and custom-query rendering classifies invalid prose', async () => {
 const { evidenceProse } = require('../../v1/lib/ask-explanation');
 const prose = evidenceProse({window_start:'2026-09-01'});
 for (const value of ['2026','२०२६','٢٠٢٦','۲۰۲۶','２０２６','𝟚𝟘𝟚𝟞','Ⅵ','²']) assert.equal(prose.safeParse('September '+value).success, false, value);
 assert.equal(prose.safeParse('Septembre {{window_start}}').success,true);
 const { queryReply } = require('../../v1/lib/ask-query-reply'), { answerTaskFor } = require('../../v1/lib/ask-chat');
 const compiled = compilePlan(plan, now), e = queryEvidence(compiled, [{ d0:'2026-09-14',m0:'100',m1:'1',u0:'0',u1:'0' }], {observed_days:null,indexed_through:'2026-10-02'}, '2026-10-03');
 await assert.rejects(queryReply(e,{question:'Explain',history:[]},async()=>({summary:'www.example.com',observations:[],limitation:''}),'fr',answerTaskFor),err=>err.askKind==='answer');
 });
