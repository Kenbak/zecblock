'use strict';
// Provider request size. The fixed prompts must leave room under
// FIXED_PROMPT_BYTES as datasets are added, and the largest request a visitor
// and the agent's repairs can produce must still fit MAX_CONTEXT_BYTES.
const test = require('node:test');
const assert = require('node:assert/strict');
const { agentStep, interpret, analysisInstruction } = require('../../v1/routes/ask');
const { chat } = require('../../v1/lib/ask-chat');
const { MAX_STEPS, toolsFor, instructionFor } = require('../../v1/lib/ask-agent');
const { coreCatalogue } = require('../../v1/lib/ask-core-catalogue');
const { chatRequestSchema } = require('../../../../lib/ask/chat');
const { ASK_BODY_BYTES, FIXED_PROMPT_BYTES, REPAIR_TURNS, MAX_CONTEXT_BYTES, maximumCost } = require('../../v1/lib/ask-budget');

const config = { provider: 'openai', key: 'fixture', model: 'fixture-model', reasoningEffort: null, planningEffort: null, inputRate: 0.25, outputRate: 0.75 };
const research = { catalogue: coreCatalogue, researchEnabled: true, researchExtended: true };
const minimal = { question: 'q', page: 'ask', context: null, history: [], locale: 'en' };

// A quote is the costliest character per visitor byte: 2 bytes in the /ask
// body, 4 once the provider body encodes the already-encoded user message.
function worstVisitor(page) {
  const input = { question: '"'.repeat(1000), page, context: null, history: Array(4).fill('"'.repeat(1000)), locale: 'en', challenge: 'c'.repeat(2048), currentResearch: { version: 3, sql: '"', limit: 200 } };
  const room = ASK_BODY_BYTES - Buffer.byteLength(JSON.stringify(input));
  input.currentResearch.sql += '"'.repeat(Math.min(8191, Math.floor(room / 2)));
  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ASK_BODY_BYTES);
  return chatRequestSchema.parse(input);
}

async function agentBytes(input, turns = []) {
  let bytes;
  const fetchImpl = async (_url, options) => { bytes = Buffer.byteLength(options.body); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ call: { tool: 'decline', reason: 'off_topic', locale: 'en' } }) } }] }); };
  const widget = input.page !== 'ask';
  const user = { question: input.question, history: input.history, page: input.page, selectedLocale: input.locale, todayUTC: '2026-11-03', currentResearch: input.currentResearch?.sql || null, currentChart: null, carriedScope: null };
  await agentStep(config, { instruction: instructionFor(true, widget), user, turns, tools: toolsFor(widget) }, AbortSignal.timeout(5000), fetchImpl);
  return bytes;
}

async function classifierBytes(input, analytics) {
  let bytes;
  const fetchImpl = async (_url, options) => { bytes = Buffer.byteLength(options.body); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }); };
  const run = (value, task) => interpret(config, value, AbortSignal.timeout(5000), fetchImpl, task);
  await chat(input, run, null, AbortSignal.timeout(5000), analysisInstruction, null, analytics).catch(() => {});
  return bytes;
}

// Two failed run_sql calls of maximum length with the largest feedback.
const repairs = Array.from({ length: REPAIR_TURNS }, (_, index) => ({
  call: { id: `call_${index + 1}`, name: 'run_sql', args: { sql: '"'.repeat(8192), locale: 'en' } },
  result: { ok: false, stage: 'database', error: 'resource', message: '"'.repeat(320), hint: '"'.repeat(240), advice: 'Bound every large table by the requested window first and aggregate before joining.' },
}));

test('repair turns match the agent step limit', () => {
  assert.equal(REPAIR_TURNS, MAX_STEPS - 1);
});

test('fixed prompts stay under FIXED_PROMPT_BYTES', async () => {
  const sizes = {
    agent: await agentBytes(minimal),
    agentWidget: await agentBytes({ ...minimal, page: 'network' }),
    classifier: await classifierBytes(minimal, research),
    classifierWidget: await classifierBytes({ ...minimal, page: 'network' }, research),
    classifierPlans: await classifierBytes(minimal, { catalogue: coreCatalogue }),
  };
  for (const [name, bytes] of Object.entries(sizes)) {
    assert.ok(Number.isInteger(bytes), `${name} made no provider request`);
    assert.ok(bytes <= FIXED_PROMPT_BYTES, `${name} fixed prompt is ${bytes} bytes; limit ${FIXED_PROMPT_BYTES}`);
  }
});

test('the research classifier is not sent the unused plan catalogue', async () => {
  let sent;
  const run = async value => { sent = value; throw Error('stop'); };
  await chat(minimal, run, null, AbortSignal.timeout(5000), analysisInstruction, null, research).catch(() => {});
  assert.equal(sent.analyticsCatalogue, undefined);
  await chat({ ...minimal, page: 'network' }, run, null, AbortSignal.timeout(5000), analysisInstruction, null, research).catch(() => {});
  assert.deepEqual(sent.analyticsCatalogue, coreCatalogue);
});

test('the largest visitor request with every repair fits MAX_CONTEXT_BYTES', async () => {
  const visitor = worstVisitor('ask');
  const sizes = { agent: await agentBytes(visitor, repairs), classifier: await classifierBytes(visitor, research) };
  for (const [name, bytes] of Object.entries(sizes)) {
    assert.ok(bytes <= MAX_CONTEXT_BYTES, `${name} worst case is ${bytes} bytes; limit ${MAX_CONTEXT_BYTES}`);
    assert.doesNotThrow(() => maximumCost(config, 'x'.repeat(bytes)));
  }
  assert.throws(() => maximumCost(config, 'x'.repeat(MAX_CONTEXT_BYTES + 1)), /Context too large/);
});

test('drafting guidance names the number of result columns the answer sees', () => {
  const { MAX_FACT_COLUMNS } = require('../../v1/lib/ask-research-reply');
  const { researchDraftingGuidance } = require('../../v1/lib/ask-chat');
  assert.equal(MAX_FACT_COLUMNS, 12);
  assert.match(researchDraftingGuidance, /Only the first twelve result columns reach the written answer/);
});
