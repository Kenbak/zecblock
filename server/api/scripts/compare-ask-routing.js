'use strict';
// Operator-only side-by-side comparison of the routing classifier and the
// ASK_AGENT tool loop. Runs the real /v1/ask/chat router in process against
// the real model, with an in-memory Redis that admits everything and counts
// reservations, and reports route, pass/fail, latency and cost per question.
//
// Required: ASK_API_KEY_FILE (a file holding an eval-only key; never printed).
// Optional data path: ASK_ANALYTICS_ENABLED=true, ASK_ANALYTICS_SERVICE_URL,
// ASK_ANALYTICS_SERVICE_KEY (the private worker, usually over an SSH tunnel).
// Without it, SQL is compiled and reviewed but not executed ("offline data"):
// research cases are then graded on routing and a compiled query only.
//
// Usage: node scripts/compare-ask-routing.js [--modes=classifier,agent]
//   [--sets=eval,probes] [--ids=a,b] [--max-usd=3] [--out=file.json]
const express = require('express');
const fs = require('node:fs');
const { once } = require('node:events');
const { createAskRouter } = require('../v1/routes/ask');
const { cases: evalCases } = require('../v1/lib/ask-research-eval-cases');
const { probes } = require('../v1/lib/ask-routing-probe-cases');
const { comparisonQuery, gradeReply } = require('../v1/lib/ask-research-eval');
const { createAnalyticsClient } = require('../v1/lib/ask-analytics-client');
const { coreCatalogue } = require('../v1/lib/ask-core-catalogue');
const { compileResearchSQL } = require('../v1/lib/ask-research-sql');

const PRICE = { input: 0.25, output: 0.75 }; // USD per million tokens, gpt-6-luna standard tier
const intentRoutes = { research: 'sql', analytics: 'sql', analysis: 'chart', knowledge: 'knowledge', blocks: 'block', transactions: 'transaction', transfers: 'transfers', clarify_growth: 'clarify', unsupported: 'decline', needs_query: 'handoff' };
const toolRoutes = { run_sql: 'sql', open_chart: 'chart', explain_topic: 'knowledge', get_block: 'block', get_transaction: 'transaction', clarify: 'clarify', decline: 'decline', needs_query: 'handoff' };
const OFFLINE = 'offline-sql-reached-execution';

function options(args) {
  const get = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  return {
    modes: get('modes', 'classifier,agent').split(','), sets: get('sets', 'eval,probes').split(','),
    ids: get('ids', '') ? get('ids', '').split(',') : null, maxUSD: Number(get('max-usd', '3')), out: get('out', null),
  };
}

function casesFor({ sets, ids }) {
  const list = [];
  if (sets.includes('eval')) for (const item of evalCases) {
    if (item.fixtureOnly) continue;
    list.push({ id: item.id, set: 'eval', question: item.question, page: 'ask', history: [], expect: item.kind === 'research' ? ['sql'] : item.kind === 'clarify' ? ['clarify'] : ['decline'], item });
  }
  if (sets.includes('probes')) for (const probe of probes) list.push({ set: 'probes', page: 'ask', history: [], ...probe });
  return ids ? list.filter(item => ids.includes(item.id)) : list;
}

function baseEnv(mode, key) {
  return {
    ASK_ENABLED: 'true', ASK_PROVIDER: 'openai', ASK_MODEL: process.env.ASK_MODEL || 'gpt-6-luna',
    ASK_REASONING_EFFORT: process.env.ASK_REASONING_EFFORT || 'none', ASK_PLANNING_REASONING_EFFORT: process.env.ASK_PLANNING_REASONING_EFFORT || 'low',
    ASK_DAILY_CALL_LIMIT: '3000', ASK_DAILY_BUDGET_USD: '25', ASK_MONTHLY_BUDGET_USD: '400',
    ASK_MAX_INPUT_USD_PER_MILLION: '0.25', ASK_MAX_OUTPUT_USD_PER_MILLION: '0.75',
    ASK_API_KEY: key, ASK_ABUSE_SECRET: 'e'.repeat(32),
    ASK_TURNSTILE_SECRET: 'eval-only', ASK_TURNSTILE_HOSTNAME: 'eval.invalid', ASK_TURNSTILE_SITE_KEY: 'eval-only',
    ASK_RESEARCH_ENABLED: 'true', ASK_RESEARCH_EXTENDED: 'true', ASK_RESEARCH_JOBS_ENABLED: 'false', ASK_ANALYTICS_STORE: 'logical_public_core',
    ASK_ANALYTICS_ENABLED: process.env.ASK_ANALYTICS_ENABLED, ASK_ANALYTICS_SERVICE_URL: process.env.ASK_ANALYTICS_SERVICE_URL, ASK_ANALYTICS_SERVICE_KEY: process.env.ASK_ANALYTICS_SERVICE_KEY,
    ASK_AGENT: mode === 'agent' ? 'true' : 'false',
  };
}

// The synchronous path, so a research reply carries its result and caption.
function offlineAnalytics() {
  return {
    jobsEnabled: false, catalogue: coreCatalogue,
    async execute(input) {
      const compiled = await compileResearchSQL(input, { extended: true });
      throw Object.assign(Error(OFFLINE), { askKind: 'source', offlineSQL: compiled.request.sql });
    },
    close: async () => {},
  };
}

async function main() {
  const config = options(process.argv.slice(2));
  const key = fs.readFileSync(process.env.ASK_API_KEY_FILE, 'utf8').trim();
  if (!/^sk-/.test(key)) throw Error('ASK_API_KEY_FILE does not hold an OpenAI key');
  const live = createAnalyticsClient({ ...process.env, ASK_RESEARCH_JOBS_ENABLED: 'false' });
  const analytics = live ? Object.assign(live, { jobsEnabled: false }) : offlineAnalytics();
  const dataMode = live ? 'live-worker' : 'offline';
  const cases = casesFor(config);
  let spent = 0;
  const records = [];
  for (const mode of config.modes) for (const item of cases) {
    if (spent >= config.maxUSD) { records.push({ mode, id: item.id, skipped: 'budget' }); continue; }
    const calls = [];
    let offlineSQL = null;
    const fetchImpl = async (url, init) => {
      const request = JSON.parse(init.body);
      const response = await fetch(url, init);
      const text = await response.text();
      let data = null; try { data = JSON.parse(text); } catch { /* counted below */ }
      const usage = data?.usage || {};
      const cost = ((usage.prompt_tokens || 0) * PRICE.input + (usage.completion_tokens || 0) * PRICE.output) / 1e6;
      spent += cost;
      const agentStep = !!(request.tools && request.tool_choice);
      const task = agentStep ? 'agent_step' : request.response_format?.json_schema?.name;
      let route = null;
      try {
        if (agentStep) route = toolRoutes[data.choices[0].message.tool_calls[0].function.name] || 'unknown-tool';
        else if (task === 'contextual_intent') route = intentRoutes[JSON.parse(data.choices[0].message.content).intent] || 'unknown-intent';
      } catch { route = route || (agentStep || task === 'contextual_intent' ? 'invalid' : null); }
      calls.push({ task, route, status: response.status, input: usage.prompt_tokens || 0, cached: usage.prompt_tokens_details?.cached_tokens || 0, reasoning: usage.completion_tokens_details?.reasoning_tokens || 0, output: usage.completion_tokens || 0, cost });
      return new Response(text, { status: response.status, headers: response.headers });
    };
    const saved = new Map();
    const redis = { isReady: true, eval: async () => 1, get: async name => saved.get(name) ?? null, set: async (name, value) => { saved.set(name, value); return 'OK'; }, zRem: async () => 1 };
    const tracked = { ...analytics, execute: async (...args) => { try { return await analytics.execute(...args); } catch (error) { if (error.offlineSQL) offlineSQL = error.offlineSQL; throw error; } } };
    // A fresh router per question keeps the per-IP request limiter out of the way.
    const router = createAskRouter(baseEnv(mode, key), {
      redis, analytics: tracked, fetch: fetchImpl,
      internalClient: { dispatch: async () => ({ ok: false, status: 503, body: {} }) },
      challengeFetch: async () => Response.json({ success: true, action: 'ask', hostname: 'eval.invalid' }),
    });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.v1 = { network: 'mainnet', requestId: 'eval', abortSignal: new AbortController().signal }; next(); });
    app.use('/ask', router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const started = Date.now();
    let status, body;
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/ask/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: item.question, page: item.page, context: null, history: item.history, locale: 'auto', challenge: 'eval' }) });
      status = response.status; body = await response.json();
    } finally { await router.stop(); server.closeAllConnections(); server.close(); }
    const latencyMs = Date.now() - started;
    const routes = calls.map(entry => entry.route).filter(Boolean);
    const reply = body?.data;
    // Final route: the last routing decision, or the no-AI path that answered.
    const route = routes.at(-1) || (reply?.blocks ? 'block' : reply?.transactions ? 'transaction' : reply?.spec ? 'chart' : reply ? 'knowledge' : 'none');
    // Offline, a data route counts once its query compiled (SQL) or its loader
    // was reached (blocks, transactions, charts read the public API).
    const reached = status === 200 || (!live && body?.code === 'ask-source' && (route === 'sql' ? !!offlineSQL : ['block', 'transaction', 'chart'].includes(route)));
    let passed = item.expect.includes(route) && !!reached;
    let grade = null;
    if (item.item && status === 200) {
      let verification = null;
      if (item.item.kind === 'research' && reply?.research && live) {
        try { verification = (await analytics.execute(await comparisonQuery(item.item, reply.research), {})).result; } catch { verification = null; }
      }
      if (item.item.kind !== 'research' || live) { grade = gradeReply(item.item, reply, verification); passed = passed && grade.passed; }
    }
    const record = {
      mode, set: item.set, id: item.id, expect: item.expect, route, routes, status, code: body?.code || null, passed,
      grade: grade ? { passed: grade.passed, checks: grade.checks } : null, offlineSQL: !!offlineSQL,
      steps: calls.filter(entry => entry.task === 'agent_step').length, calls: calls.length, latencyMs,
      tokens: calls.reduce((sum, entry) => ({ input: sum.input + entry.input, cached: sum.cached + entry.cached, output: sum.output + entry.output, reasoning: sum.reasoning + entry.reasoning }), { input: 0, cached: 0, output: 0, reasoning: 0 }),
      costUSD: Number(calls.reduce((sum, entry) => sum + entry.cost, 0).toFixed(6)),
      answer: typeof reply?.answer === 'string' ? reply.answer.slice(0, 240) : null,
    };
    records.push(record);
    console.error(`${mode.padEnd(10)} ${record.passed ? 'PASS' : 'FAIL'} ${item.id.padEnd(40)} route=${route} ${status}${record.code ? ' ' + record.code : ''} ${latencyMs}ms $${record.costUSD}`);
  }
  await analytics.close?.();
  const summary = { kind: 'ask-routing-comparison', dataMode, model: baseEnv('agent', '').ASK_MODEL, planningEffort: baseEnv('agent', '').ASK_PLANNING_REASONING_EFFORT, spentUSD: Number(spent.toFixed(4)), modes: {} };
  for (const mode of config.modes) {
    const rows = records.filter(record => record.mode === mode && !record.skipped);
    const offTopic = rows.filter(record => cases.find(item => item.id === record.id)?.offTopic);
    const onTopic = rows.filter(record => !record.expect.includes('decline'));
    const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    summary.modes[mode] = {
      questions: rows.length, passed: rows.filter(record => record.passed).length,
      passRate: Number((rows.filter(record => record.passed).length / Math.max(rows.length, 1)).toFixed(3)),
      bySet: Object.fromEntries(['eval', 'probes'].map(set => [set, `${rows.filter(record => record.set === set && record.passed).length}/${rows.filter(record => record.set === set).length}`])),
      wrongRefusals: onTopic.filter(record => record.route === 'decline').length,
      offTopicDeclined: `${offTopic.filter(record => record.route === 'decline' && record.status === 200).length}/${offTopic.length}`,
      errors: rows.filter(record => record.status !== 200 && !(record.code === 'ask-source' && dataMode === 'offline')).length,
      avgAgentSteps: Number(mean(rows.map(record => record.steps)).toFixed(2)), avgModelCalls: Number(mean(rows.map(record => record.calls)).toFixed(2)),
      avgLatencyMs: Math.round(mean(rows.map(record => record.latencyMs))), medianLatencyMs: rows.map(record => record.latencyMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)] || 0,
      costPerQuestionUSD: Number(mean(rows.map(record => record.costUSD)).toFixed(5)), costUSD: Number(rows.reduce((sum, record) => sum + record.costUSD, 0).toFixed(4)),
    };
  }
  const output = { summary, records };
  if (config.out) fs.writeFileSync(config.out, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch(error => { console.error('Comparison failed:', error.message); process.exitCode = 1; });
module.exports = { casesFor, options };
