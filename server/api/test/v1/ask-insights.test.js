'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInsights } = require('../../v1/lib/ask-insights');
const { summarizeEvidence } = require('../../../../lib/ask/data');
const { loadExplanationEvidence, explanationTaskFor, renderExplanation } = require('../../v1/lib/ask-explanation');
const { answerTaskFor, chat } = require('../../v1/lib/ask-chat');
const { interpret } = require('../../v1/routes/ask');
const { maximumCost } = require('../../v1/lib/ask-budget');
const spec = { version: 1, metric: 'balances', pool: 'all', period: '90d', view: 'line', start: null, end: null };
const day = index => new Date(Date.UTC(2026, 7, 1 + index)).toISOString().slice(0, 10);
const zat = value => (BigInt(value) * 100000000n).toString();
function sample(metric = 'balances', count = 15) {
  const keys = metric === 'balances' ? ['ironwood', 'orchard'] : ['shield', 'deshield'];
  return { unit: 'ZEC', series: keys.map(key => ({ key, label: key })), points: Array.from({ length: count }, (_, i) => ({ date: day(i), values: Object.fromEntries(keys.map((key, k) => [key, zat(k ? 1000 - i * 50 : i * 80)])) })) };
}
const analyze = (evidence, metric = 'balances') => buildInsights(evidence, { ...spec, metric }, summarizeEvidence(evidence, { ...spec, metric }));

test('pool comparison derives exact combined growth, shares and observed timing', () => {
  const { facts, analysis } = analyze(sample());
  assert.equal(facts.combined_movement, '420.00 ZEC');
  assert.equal(facts.combined_relative_change, '42.00 %');
  assert.equal(facts.ironwood_end_share, '78.87 %');
  assert.equal(facts.ironwood_start_share, '0.00 %');
  assert.equal(analysis.series[0].relativeChange, null); // Undefined growth from zero.
  assert.equal(facts.ironwood_first_lead_date, '2026-08-09');
  assert.equal(facts.ironwood_strongest_start, '2026-08-01');
  assert.equal(facts.ironwood_strongest_end, '2026-08-08');
  assert.equal(facts.ironwood_strongest_movement, '560.00 ZEC');
  assert.equal(facts.ironwood_recent_value, '560.00 ZEC');
  assert.equal(facts.ironwood_previous_value, '560.00 ZEC');
  assert.equal(analysis.series[0].recentComparison.pattern, 'same positive pace');
  assert.match(analysis.comparison.denominator, /not all shielded/);
});

test('overview totals and concentration use every selected pool, not only the migration pair', () => {
  const evidence = sample('balances', 2);
  evidence.series.push({ key: 'sapling', label: 'Sapling' });
  evidence.points[0].values.sapling = zat(2000);
  evidence.points[1].values.sapling = zat(2000);
  const { facts, analysis } = analyze(evidence);
  assert.equal(facts.selected_pools_balance, '3,030.00 ZEC');
  assert.equal(facts.selected_pools_movement, '30.00 ZEC');
  assert.equal(facts.selected_pools_relative_change, '1.00 %');
  assert.equal(facts.selected_pools_leader, 'Sapling');
  assert.equal(facts.selected_pools_leader_share, '66.01 %');
  assert.equal(analysis.selectedPools.denominator, 'ironwood + orchard + Sapling');
  evidence.points[0].values.sapling = null;
  assert.equal(analyze(evidence).analysis.selectedPools, null);
});

test('page explanations receive analytical instructions and facts without another selection call', async () => {
  let calls = 0;
  const rows = Array.from({ length: 15 }, (_, i) => ({ date: day(i), ironwoodZat: zat(i * 80), orchardZat: zat(1000 - i * 50), saplingZat: zat(100), sproutZat: zat(10), hasPoolBreakdown: true }));
  const source = { dispatch: async () => ({ ok: true, body: { points: rows } }) };
  const result = await chat({ question: 'Explain this page', page: 'pools', context: spec, history: [], locale: 'en' }, async (body, task) => {
    calls++;
    assert.ok(body.evidence.analysis.selectedPools);
    assert.equal(body.evidence.pool, spec.pool);
    assert.match(body.page.scope, /Interpret the server-fetched/);
    assert.match(task.instruction, /fact placeholders in the opening sentence/);
    return { summary: 'Selected pools increased by {{selected_pools_movement}}.', observations: [], limitation: '', sources: ['pools'] };
  }, source, AbortSignal.timeout(1000), '');
  assert.equal(calls, 1);
  assert.match(result.answer, /420.00 ZEC/);
  assert.deepEqual(result.spec, spec);
});

test('suggested follow-ups retain the exact chart recipe without classification', async () => {
  const { analysisFollowUps } = require('../../../../lib/ask/follow-ups');
  const selected = { ...spec, pool: 'orchard', start: day(0), end: day(14) };
  const rows = Array.from({ length: 15 }, (_, i) => ({ date: day(i), orchardZat: zat(1000 - i * 50), hasPoolBreakdown: true }));
  let calls = 0;
  const result = await chat({ question: analysisFollowUps(selected)[1], page: 'pools', context: selected, history: ['Explain this chart'], locale: 'auto' }, async (body, task) => {
    calls++;
    assert.equal(task.name, 'contextual_answer');
    assert.equal(body.evidence.pool, 'orchard');
    assert.equal(body.evidence.period, '90d');
    return { summary: 'Orchard decreased by {{orchard_movement}}.', observations: [], limitation: '', sources: ['pools'] };
  }, { dispatch: async () => ({ ok: true, body: { points: rows } }) }, AbortSignal.timeout(1000), '');
  assert.equal(calls, 1);
  assert.deepEqual(result.spec, selected);
  assert.match(result.answer, /700.00 ZEC/);
});

test('missing observations never create daily windows or a false exact crossover', () => {
  const evidence = sample();
  evidence.points.splice(7, 1);
  evidence.points[1].values.ironwood = null;
  const { facts, analysis } = analyze(evidence);
  assert.equal(facts.missing_dates, '1');
  assert.equal(facts.ironwood_missing, '1');
  assert.equal(analysis.coverage.completeDates, false);
  assert.equal(analysis.series[0].recentComparison, undefined);
  assert.equal(analysis.series[0].strongestWeek, undefined);
  assert.match(analysis.comparison.firstObservedIronwoodLead.scope, /missing observations can hide/);
  assert.equal(facts.combined_movement, '420.00 ZEC'); // Valid endpoints still compare.
});

test('unknown endpoints, zero denominators and single snapshots do not invent comparisons', () => {
  const evidence = sample();
  evidence.points[0].values.orchard = null;
  assert.equal(analyze(evidence).analysis.comparison, null);
  for (const point of evidence.points) point.values = { ironwood: '0', orchard: '0' };
  const zero = analyze(evidence);
  assert.equal(zero.analysis.comparison.ironwoodEndShare, null);
  assert.equal(zero.analysis.comparison.combinedRelativeChange, null);
  assert.equal(zero.analysis.comparison.firstObservedIronwoodLead, undefined);
  assert.equal(zero.analysis.series[0].strongestWeek, undefined);
  assert.equal(analyze(sample('balances', 1)).analysis.comparison, null);
  assert.equal(analyze(sample('balances', 1)).analysis.selectedPools, null);
});

test('negative stock changes keep their direction, and already-leading pools get no invented crossover', () => {
  const evidence = sample();
  for (const [i, point] of evidence.points.entries()) point.values = { ironwood: zat(2000 - i * 80), orchard: zat(100) };
  const { facts, analysis } = analyze(evidence);
  assert.equal(analysis.series[0].direction, 'decreased');
  assert.equal(facts.ironwood_movement, '1,120.00 ZEC');
  assert.equal(facts.ironwood_relative_change, '56.00 %');
  assert.equal(analysis.series[0].recentComparison.recent.direction, 'decreased');
  assert.doesNotMatch(analysis.series[0].recentComparison.pattern, /growth accelerated/);
  assert.equal(analysis.comparison.firstObservedIronwoodLead, undefined);
});

test('percentages and changes preserve integer precision beyond JavaScript safe numbers', () => {
  const evidence = sample('balances', 2);
  evidence.points[0].values = { ironwood: '90071992547409930000', orchard: '90071992547409930000' };
  evidence.points[1].values = { ironwood: '90071992547410930000', orchard: '90071992547409930000' };
  const { facts } = analyze(evidence);
  assert.equal(facts.combined_movement, '0.01 ZEC');
  assert.equal(facts.ironwood_start_share, '50.00 %');
});

test('flow explanations compare bucket totals, peak concentration and public direction imbalance', () => {
  const evidence = sample('flows');
  const { facts, analysis } = analyze(evidence, 'flows');
  assert.equal(facts.shield_recent_value, '6,160.00 ZEC'); // Days 8 through 14 inclusive.
  assert.equal(facts.shield_previous_value, '2,240.00 ZEC'); // Days 1 through 7.
  assert.equal(facts.shield_peak_share, '13.33 %');
  assert.equal(analysis.series[0].recentComparison.pattern, 'higher recent total');
  assert.equal(analysis.series[0].strongestWeek, undefined);
  assert.equal(analysis.comparison.larger, 'deshield');
  evidence.points[4].values.shield = null;
  const missing = analyze(evidence, 'flows');
  assert.equal(missing.analysis.comparison, null);
  assert.equal(missing.analysis.series[0].peak.shareOfReturnedTotal, undefined);
});

test('migration-share changes use percentage points and rankings use only complete known denominators', () => {
  const evidence = { unit: '%', series: [{ key: 'share', label: 'Ironwood share' }], points: [{ date: day(0), values: { share: '1000' } }, { date: day(1), values: { share: '4000' } }] };
  assert.equal(analyze(evidence, 'migration_share').facts.share_movement, '30.00 percentage points');
  const ranking = { dimension: 'chain', unit: 'USD', series: [{ key: 'volume', label: 'Into ZEC' }], points: [{ date: 'btc', values: { volume: '300' } }, { date: 'eth', values: { volume: '100' } }] };
  assert.equal(analyze(ranking, 'chain_inflows').facts.leading_chain_share, '75.00 %');
  ranking.points[1].values.volume = null;
  assert.equal(analyze(ranking, 'chain_inflows').analysis.ranking, null);
});

test('server evidence limits insights to the selected date range and pool', async () => {
  const source = { dispatch: async () => ({ ok: true, body: { points: sample().points.map(point => ({ date: point.date, ironwoodZat: point.values.ironwood, orchardZat: point.values.orchard, hasPoolBreakdown: true })) } }) };
  const evidence = await loadExplanationEvidence({ ...spec, pool: 'orchard', start: day(7) }, source, AbortSignal.timeout(1000));
  assert.equal(evidence.input.analysis.comparison, null);
  assert.equal(evidence.input.analysis.series.length, 1);
  assert.equal(evidence.facts.orchard_start, '650.00 ZEC');
  assert.equal(evidence.facts.orchard_movement, '350.00 ZEC');
  assert.equal(evidence.facts.calendar_days, '8');
  assert.equal(evidence.input.analysis.series[0].recentComparison, undefined);
});

test('enriched evidence stays within provider request budget and both narrative paths retain provenance', async () => {
  const rows = Array.from({ length: 366 }, (_, i) => ({ date: day(i), ironwoodZat: zat(i), orchardZat: zat(2000 - i), saplingZat: zat(1000 - i), sproutZat: zat(500), hasPoolBreakdown: true }));
  const source = { dispatch: async () => ({ ok: true, body: { points: rows } }) };
  const evidence = await loadExplanationEvidence({ ...spec, period: '1y' }, source, AbortSignal.timeout(1000));
  const prose = { summary: 'Their combined balance was {{combined_balance}}.', observations: ['Ironwood held {{ironwood_end_share}} of that pair.'], limitation: '' };
  const tasks = [explanationTaskFor(evidence.facts), answerTaskFor(evidence.facts, [{ id: 'pools' }])];
  for (const task of tasks) {
    const answer = task.name === 'contextual_answer' ? { ...prose, sources: ['pools'] } : prose;
    assert.equal(task.validator.safeParse(answer).success, true);
    assert.equal(task.validator.safeParse({ ...answer, summary: 'Invented 42%.' }).success, false);
    await interpret({ provider: 'openai', model: 'fixture' }, { evidence: evidence.input }, AbortSignal.timeout(1000), async (url, init) => {
      assert.ok(Buffer.byteLength(init.body) < 48000);
      assert.ok(maximumCost({ inputRate: 0.125, outputRate: 0.5 }, init.body) > 0);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] });
    }, task);
  }
  assert.match(renderExplanation(prose, evidence.facts).summary, /2,000.00 ZEC/);
  assert.equal(renderExplanation(prose, evidence.facts).limitation, '');
  let calls = 0;
  const result = await chat({ question: 'Compare Orchard and Ironwood', page: 'ask', context: null, history: [], locale: 'en' }, async (body, task) => {
    if (++calls === 1) return { intent: 'analysis', transactionQuery: null, blockQuery: null, spec, topics: ['pools'], locale: 'en' };
    assert.ok(body.evidence.analysis.comparison);
    assert.match(task.instruction, /strongest relevant finding/);
    return task.validator.parse({ ...prose, sources: ['pools'] });
  }, source, AbortSignal.timeout(1000), '');
  assert.equal(calls, 2);
  assert.match(result.answer, /combined balance/);
});

test('combined daily ranking uses exact sums, completed UTC days, ties and requested coverage', () => {
  const evidence = { unit: 'transactions', meta: { generatedAt: '2026-08-05T14:00:00Z' },
    series: [{ key: 'shielded', label: 'Shielded' }, { key: 'transparent', label: 'Transparent' }],
    points: [
      { date: '2026-08-01', values: { shielded: '100', transparent: '1' } },
      { date: '2026-08-02', values: { shielded: '90', transparent: '90' } },
      { date: '2026-08-03', values: { shielded: '80', transparent: '100' } },
      { date: '2026-08-04', values: { shielded: null, transparent: '200' } },
      { date: '2026-08-05', values: { shielded: '999999', transparent: '999999' } },
    ] };
  const selected = { ...spec, metric: 'transactions', start: '2026-08-01', end: '2026-08-05' };
  const result = buildInsights(evidence, selected, summarizeEvidence(evidence, selected));
  assert.equal(result.facts.daily_rank_a_date, '2026-08-02');
  assert.equal(result.facts.daily_rank_a_value, '180 transactions');
  assert.equal(result.facts.daily_rank_b_date, '2026-08-03');
  assert.equal(result.facts.ranking_missing_days, '1');
  assert.equal(result.facts.ranking_end, '2026-08-04');
  assert.equal(result.analysis.dailyRanking.completeWindow, false);
  assert.equal(result.analysis.dailyRanking.rows.length, 3);
  evidence.points[3].values.shielded = '90071992547409930000';
  const precise = buildInsights(evidence, selected, summarizeEvidence(evidence, selected));
  assert.equal(precise.facts.daily_rank_a_value, '90,071,992,547,409,930,200 transactions');
  assert.equal(precise.analysis.dailyRanking.completeWindow, true);
  evidence.points.splice(1, 1);
  assert.equal(buildInsights(evidence, selected, summarizeEvidence(evidence, selected)).facts.ranking_missing_days, '1');
});

test('yearly busiest-day question routes directly and evidence fits the capped provider request', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = Array.from({ length: 366 }, (_, i) => ({ date: new Date(Date.parse(today) - i * 86400000).toISOString().slice(0, 10), shielded: i === 20 ? 500 : 10, transparent: i === 20 ? 400 : 20 }));
  let calls = 0;
  const result = await chat({ question: 'What was the busiest day for Zcash in the last year?', page: 'ask', context: null, history: [], locale: 'auto' }, async (body, task) => {
    calls++;
    assert.equal(task.name, 'contextual_answer');
    assert.equal(body.evidence.analysis.dailyRanking.rows.length, 5);
    assert.equal(body.evidence.analysis.dailyRanking.completeWindow, true);
    assert.equal(body.evidence.facts.ranking_missing_days, '0');
    const raw = { summary: 'The busiest completed day was {{daily_rank_a_date}}, with {{daily_rank_a_value}}, excluding mining rewards.', observations: [], limitation: '', sources: ['transactions'] };
    await interpret({ provider: 'openai', model: 'fixture' }, body, AbortSignal.timeout(1000), async (url, init) => {
      assert.ok(Buffer.byteLength(init.body) < 48000);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] });
    }, task);
    return raw;
  }, { dispatch: async (method, path, options) => {
    assert.equal(options.query.days, '366');
    return { ok: true, body: { trends: { daily: rows } } };
  } }, AbortSignal.timeout(1000), '');
  assert.equal(calls, 1);
  assert.match(result.answer, /900 transactions/);
  assert.equal(result.spec.period, '1y');
  assert.equal(result.dataContext.end, today);
  assert.ok(result.dataContext.retrievedAt);
});

test('weekly count comparisons exclude the unfinished current UTC day', () => {
  const evidence = sample('flows', 15);
  evidence.meta = { generatedAt: day(14) + 'T12:00:00Z' };
  evidence.points[14].values.shield = zat(999999);
  const result = analyze(evidence, 'flows');
  assert.equal(result.facts.shield_recent_end, day(13));
  assert.equal(result.facts.shield_previous_start, day(0));
  assert.equal(result.facts.shield_recent_value, '5,600.00 ZEC');
});


test('pool evidence distinguishes a wrong response format from genuinely unknown historical breakdowns',async()=>{
 const source=points=>({dispatch:async(method,path,{query})=>{assert.equal(query.format,'zatoshi');assert.equal(query.period,'1y');return {ok:true,body:{points}};}});
 const annual={...spec,period:'1y'};
 await assert.rejects(loadExplanationEvidence(annual,source([{date:day(0),orchard:100,ironwood:0,hasPoolBreakdown:true}]),AbortSignal.timeout(1000)),/exact zatoshi format/);
 const unknown=await loadExplanationEvidence(annual,source([{date:day(0),hasPoolBreakdown:false}]),AbortSignal.timeout(1000));
 assert.equal(unknown.input.analysis.coverage.observedDays,1);
 assert.equal(unknown.input.analysis.series[0].hasObservedValues,false);
 assert.equal(unknown.input.analysis.selectedPools,null);
});

test('overall recent pace cancels pool redistribution and excludes unknown combined observations',()=>{
 const evidence=sample('balances',15);
 evidence.points.forEach((point,i)=>{point.values.ironwood=zat(i*50);point.values.orchard=zat(1000-i*50+i*2);});
 const {analysis,facts}=analyze(evidence);
 assert.equal(analysis.coverage.observedDays,15);
 assert.equal(analysis.series[0].observedValues,15);
 assert.equal(analysis.series[0].hasObservedValues,true);
 assert.equal(analysis.series[1].direction,'decreased');
 assert.equal(analysis.selectedPools.recentComparison.recent.direction,'increased');
 assert.equal(facts.selected_pools_recent_movement,'14.00 ZEC');
 assert.equal(facts.selected_pools_previous_movement,'14.00 ZEC');
 assert.match(answerTaskFor(facts,[{id:'pools'}],true).instruction,/conditional outlook/);
 evidence.points[8].values.orchard=null;
 const partial=analyze(evidence);
 assert.equal(partial.analysis.selectedPools.recentComparison,undefined);
 assert.equal(partial.analysis.series[1].observedValues,14);
});

test('the page widget offers Zift for custom-query questions without compiling or running SQL', async () => {
  const selection = intent => ({ intent, spec: null, flowQuery: null, blockQuery: null, transactionQuery: null, topics: [], locale: 'en', sql: null });
  const analytics = { researchEnabled: true, jobsEnabled: true, catalogue: [{ dataset: 'daily' }], submit: () => assert.fail('the widget never submits SQL'), execute: () => assert.fail('the widget never executes SQL') };
  const source = { dispatch: async () => assert.fail('no source read') };
  const tasks = [];
  const ask = (intent, page) => chat({ question: 'How has the Orchard pool balance changed this month?', page, context: spec, history: [], locale: 'en' }, async (body, task) => { tasks.push(task); return selection(intent); }, source, AbortSignal.timeout(1000), '', undefined, analytics);
  const research = await ask('needs_query', 'pools');
  assert.equal(research.handoff, 'zift'); assert.match(research.answer, /Zift can try it/);
  const unsupported = await ask('unsupported', 'pools');
  assert.equal(unsupported.handoff, 'try-zift'); assert.match(unsupported.answer, /cannot answer that/);
  assert.equal((await ask('unsupported', 'ask')).handoff, undefined, 'Zift itself does not offer to open Zift');
  assert.ok(tasks[0].validator.shape.intent.options.includes('needs_query') && /needs_query/.test(tasks[0].instruction), 'the widget can say a question needs a custom query');
  assert.ok(!tasks.at(-1).validator.shape.intent.options.includes('needs_query'), 'Zift itself plans SQL instead');
});
