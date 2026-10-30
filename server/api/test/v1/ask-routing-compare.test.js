'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, casesFor, options } = require('../../scripts/compare-ask-routing');
const { probes } = require('../../v1/lib/ask-routing-probe-cases');

const orchardSQL = "SELECT date,orchard FROM daily WHERE date >= DATE '2026-09-30' ORDER BY date";
const usage = { prompt_tokens: 6000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 100 } };
// A fixed provider: the agent declines off-topic probes and queries the rest;
// the classifier always picks the preset pool chart.
async function provider(_url, init) {
  const body = JSON.parse(init.body);
  if (body.response_format.json_schema.name === 'agent_step') {
    const question = JSON.parse(body.messages[1].content).question;
    const call = /pasta/.test(question) ? { tool: 'decline', reason: 'off_topic', locale: 'en' } : { tool: 'run_sql', sql: orchardSQL, locale: 'en' };
    return Response.json({ usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ call }) } }] });
  }
  const spec = { version: 1, metric: 'balances', period: '30d', pool: 'orchard', view: 'line', start: null, end: null };
  return Response.json({ usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ intent: 'analysis', spec, sql: null, blockQuery: null, transactionQuery: null, flowQuery: null, topics: [], locale: 'en' }) } }] });
}

test('the comparison runs both modes routing-only and grades routes, steps and cost', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-compare-'));
  const keyFile = path.join(dir, 'key'), out = path.join(dir, 'out.json');
  fs.writeFileSync(keyFile, 'sk-fixture-not-a-key\n');
  const saved = process.env.ASK_API_KEY_FILE; process.env.ASK_API_KEY_FILE = keyFile;
  const print = console.log; const printed = [];
  console.log = line => printed.push(String(line));
  t.after(() => { console.log = print; process.env.ASK_API_KEY_FILE = saved; fs.rmSync(dir, { recursive: true, force: true }); });
  const { summary, records } = await main(['--routing-only', '--sets=probes', '--ids=orchard_30d_change,offtopic_pasta', `--out=${out}`], { providerFetch: provider, log: () => {} });
  assert.equal(summary.dataMode, 'offline');
  const find = (mode, id) => records.find(record => record.mode === mode && record.id === id);
  assert.equal(find('agent', 'orchard_30d_change').route, 'sql'); assert.equal(find('agent', 'orchard_30d_change').passed, true);
  assert.equal(find('agent', 'orchard_30d_change').offlineSQL, true);
  assert.equal(find('classifier', 'orchard_30d_change').route, 'chart'); assert.equal(find('classifier', 'orchard_30d_change').passed, false);
  assert.equal(find('agent', 'offtopic_pasta').route, 'decline'); assert.equal(find('agent', 'offtopic_pasta').passed, true);
  assert.equal(summary.modes.agent.offTopicDeclined, '1/1'); assert.equal(summary.modes.agent.avgAgentSteps, 1);
  assert.equal(summary.modes.classifier.wrongRefusals, 0);
  assert.equal(find('agent', 'offtopic_pasta').costUSD, (6000 * 0.25 + 400 * 0.75) / 1e6);
  assert.ok(summary.spentUSD > 0);
  const written = fs.readFileSync(out, 'utf8');
  assert.ok(!written.includes('sk-fixture') && !printed.join('\n').includes('sk-fixture'), 'the key never reaches output');
});

test('the case list covers eval cases and every probe; a worst-case estimate stays under the cap', () => {
  const all = casesFor(options([]));
  assert.ok(all.some(item => item.set === 'eval' && item.expect[0] === 'clarify'));
  assert.equal(all.filter(item => item.set === 'probes').length, probes.length);
  assert.ok(probes.filter(item => item.offTopic).length >= 5);
  const { estimate } = require('../../scripts/compare-ask-routing');
  const result = estimate(options([]), all);
  assert.ok(result.worstCaseUSD < result.capUSD);
});
