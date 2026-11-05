const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');

// Next initializes these stores from the runtime's global AsyncLocalStorage.
globalThis.AsyncLocalStorage ??= require('node:async_hooks').AsyncLocalStorage;
const { unstable_cache } = require('next/cache');
const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external');
const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external');

function load(file, dependencies = {}, globals = {}) {
  const filename = path.resolve(__dirname, '../..', file);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', ...Object.keys(globals), output)(
    module, module.exports, name => dependencies[name] ?? require(name), ...Object.values(globals),
  );
  return module.exports;
}

function harness() {
  let now = Date.parse('2026-10-28T03:00:00Z');
  const Clock = class extends Date { static now() { return now; } };
  const nu7 = load('lib/nu7-vote-results.ts');
  const model = load('lib/governance.ts', { './nu7-vote-results': nu7 });
  const summary = structuredClone(require('./fixtures/nu7/summary.json'));
  const tally = structuredClone(require('./fixtures/nu7/tally.json'));
  const round = model.roundSchema.parse({
    ...summary, title: 'Reviewed ballot title omitted from cache keys', snapshot_height: 3459350,
    snapshot_blockhash: Buffer.alloc(32).toString('base64'),
  });
  const id = model.roundHex(round.vote_round_id);
  const counts = new Map();
  const entries = new Map();
  const invocationKeys = [];
  const afterCallbacks = [];
  let failPublished = false;
  let directoryGate;
  class GovernanceDataError extends Error {
    constructor(endpoint, reason) { super(reason); this.endpoint = endpoint; this.reason = reason; }
  }
  const upstream = {
    GovernanceDataError,
    governanceFailureDetails: error => ({ endpoint: error.endpoint, reason: error.reason }),
    async fetchGovernanceJson(endpoint) {
      counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
      if (endpoint === 'rounds') {
        if (directoryGate) await directoryGate;
        return { rounds: [round] };
      }
      if (endpoint === 'endorsers') return { endorsers: [{ endorser_id: model.TRUSTED_ENDORSER.id, address: model.TRUSTED_ENDORSER.address }] };
      if (endpoint === `endorsed-rounds/${model.TRUSTED_ENDORSER.id}`) return { vote_round_ids: [round.vote_round_id] };
      if (failPublished) throw new GovernanceDataError(endpoint, 'timeout');
      if (endpoint === `vote-summary/${id}`) return structuredClone(summary);
      if (endpoint === `tally-results/${id}`) return structuredClone(tally);
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  };
  const data = load('lib/governance-data.ts', {
    react: { cache: fn => fn },
    'next/cache': { unstable_cache },
    'next/server': { after: callback => afterCallbacks.push(callback) },
    './governance': model,
    './governance-upstream': upstream,
  }, { Date: Clock });
  const incrementalCache = {
    async generateSimpleCacheKey(value) {
      invocationKeys.push(value);
      return createHash('sha256').update(value).digest('hex');
    },
    async get(key, context) {
      const entry = entries.get(key);
      return entry ? { value: structuredClone(entry.value), isStale: now - entry.writtenAt >= context.revalidate * 1000 } : null;
    },
    async set(key, value) { entries.set(key, { value: structuredClone(value), writtenAt: now }); },
  };
  async function request(callback, type = 'prerender-legacy') {
    const workStore = { route: '/governance', incrementalCache, nextFetchId: 1 };
    const unitStore = type === 'request'
      ? { type, phase: 'render', url: { pathname: '/api/governance/announcement', search: '' } }
      : { type, phase: 'render', revalidate: Infinity, tags: null };
    const result = await workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(unitStore, callback));
    return { result, flush: async () => { await Promise.all(Object.values(workStore.pendingRevalidates ?? {})); } };
  }
  return {
    data, request, counts, invocationKeys, afterCallbacks, id, round,
    now: () => now, advance: milliseconds => { now += milliseconds; },
    failPublished: () => { failPublished = true; },
    holdDirectory: promise => { directoryGate = promise; },
  };
}

test('actual Next cache keeps five-minute finalized tallies across one-minute directory refreshes', async () => {
  const h = harness();
  const first = await h.request(h.data.getGovernanceCatalog);
  await first.flush();
  assert.equal(first.result.votes[0].state, 'results');
  const firstCheck = first.result.checkedAt;
  h.advance(61_000);
  const second = await h.request(h.data.getGovernanceCatalog);
  await second.flush();
  assert.equal(h.counts.get('rounds'), 2, 'directory refreshed after sixty seconds');
  assert.equal(h.counts.get(`vote-summary/${h.id}`), 1, 'nested cache reads must not bypass the published vote TTL');
  assert.equal(h.counts.get(`tally-results/${h.id}`), 1);
  assert.equal(second.result.checkedAt, firstCheck, 'cached tally checks keep their original observation clock');
  assert.ok(h.invocationKeys.every(key => !key.includes(h.round.title)), 'ballot text stays out of cache diagnostics');
});

test('actual Next static revalidation preserves validated results and source time on upstream failure', async t => {
  const revalidationErrors = [];
  t.mock.method(console, 'error', (...args) => revalidationErrors.push(args));
  const h = harness();
  const initial = await h.request(h.data.getGovernanceCatalog);
  await initial.flush();
  h.advance(301_000);
  h.failPublished();
  const stale = await h.request(h.data.getGovernanceCatalog);
  await stale.flush();
  assert.equal(stale.result.votes[0].state, 'results');
  assert.equal(stale.result.checkedAt, initial.result.checkedAt);
  assert.equal(h.counts.get(`vote-summary/${h.id}`), 2, 'stale published results attempted one refresh');
  assert.equal(revalidationErrors.length, 1, 'Next reports the failed revalidation while retaining the old result');
  assert.ok(revalidationErrors.every(args => !String(args[0]).includes(h.round.title)));
});

test('cold announcement returns within its page budget while retained work fills the actual Next cache', async () => {
  const h = harness();
  let release;
  h.holdDirectory(new Promise(resolve => { release = resolve; }));
  const started = performance.now();
  const cold = await h.request(h.data.getGovernanceAnnouncementCatalog, 'request');
  assert.equal(cold.result.unavailable, true);
  assert.ok(performance.now() - started < 1_800, 'a stalled voting provider cannot block the banner for eight seconds');
  assert.equal(h.afterCallbacks.length, 1);
  release();
  await Promise.all(h.afterCallbacks.map(callback => callback()));
  await cold.flush();
  const warm = await h.request(h.data.getGovernanceAnnouncementCatalog, 'request');
  await warm.flush();
  assert.equal(warm.result.votes[0].state, 'results');
  assert.equal(h.counts.get('rounds'), 1);
  assert.equal(h.counts.get(`vote-summary/${h.id}`), 1);
});
