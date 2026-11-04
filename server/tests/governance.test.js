const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { readBoundedJson } = require('../../lib/bounded-json');

function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, atob, URL, setTimeout, clearTimeout, console, require: name => dependencies[name] ?? (name === './bounded-json' ? { readBoundedJson } : name === './governance-upstream' ? load('lib/governance-upstream.ts', dependencies) : require(name)) });
  return exports;
}
const nu7 = load('lib/nu7-vote-results.ts');
const model = load('lib/governance.ts', { './nu7-vote-results': nu7 });
const { roundSchema, parseRoundVote, selectTrustedRounds, selectAnnouncement, TRUSTED_ENDORSER, roundHex, isGrantsRound, roundHref, GRANTS } = model;
const { ProposalList } = load('app/governance/ProposalList.tsx');
function fixture() {
  const summary = structuredClone(require('./fixtures/nu7/summary.json'));
  const tally = structuredClone(require('./fixtures/nu7/tally.json'));
  const round = roundSchema.parse({ ...summary, title: 'NU7 Scope', snapshot_height: 3459350, snapshot_blockhash: Buffer.alloc(32).toString('base64') });
  return { round, summary, tally };
}
const registry = { endorsers: [{ endorser_id: TRUSTED_ENDORSER.id, address: TRUSTED_ENDORSER.address }] };

function oversizedArray(maximum) {
  const values = new Array(maximum + 1);
  Object.defineProperty(values, 0, { get() { throw new Error('Oversized array element was visited'); } });
  return values;
}

test('governance size limits reject before parsing collection elements', () => {
  const { round, summary, tally } = fixture();
  const limits = model.GOVERNANCE_LIMITS;
  for (const [directory, endorsers, endorsements] of [
    [{ rounds: oversizedArray(limits.rounds) }, registry, {}],
    [{ rounds: [round] }, { endorsers: oversizedArray(limits.endorsers) }, {}],
    [{ rounds: [round] }, registry, { vote_round_ids: oversizedArray(limits.rounds) }],
  ]) {
    assert.throws(() => selectTrustedRounds(directory, endorsers, endorsements), error => error.issues?.length === 1 && error.issues[0].code === 'too_big');
  }
  for (const oversized of [
    { ...round, proposals: oversizedArray(limits.proposals) },
    { ...round, proposals: [{ ...round.proposals[0], options: oversizedArray(limits.options) }] },
  ]) {
    const parsed = roundSchema.safeParse(oversized);
    assert.equal(parsed.success, false);
    assert.equal(parsed.error.issues.length, 1);
    assert.equal(parsed.error.issues[0].code, 'too_big');
  }
  assert.equal(parseRoundVote(round, { ...summary, proposals: oversizedArray(limits.proposals) }, tally, 0).state, 'unavailable');
  assert.equal(parseRoundVote(round, summary, { results: oversizedArray(limits.results) }, 0).state, 'unavailable');
});

test('discovery admits reviewed NU7 and pinned-identity endorsements, not arbitrary production rounds', () => {
  const { round } = fixture();
  const other = { ...round, vote_round_id: Buffer.alloc(32, 1).toString('base64'), title: 'Test vote' };
  const directory = { rounds: [round, other] };
  assert.equal(selectTrustedRounds(directory, registry, { vote_round_ids: [] }).length, 1);
  assert.equal(selectTrustedRounds(directory, registry, { vote_round_ids: [other.vote_round_id] }).length, 2);
  assert.equal(selectTrustedRounds(directory, { endorsers: [{ endorser_id: TRUSTED_ENDORSER.id, address: 'replaced-address' }] }, { vote_round_ids: [other.vote_round_id] }).length, 1);
  assert.throws(() => selectTrustedRounds({ rounds: [round, round] }, registry, {}));
  assert.throws(() => selectTrustedRounds({ rounds: [{ ...round, proposals: [] }] }, registry, {}));
});

test('state transitions use chain status, closing time never fabricates results, timeout overrides finalized', () => {
  const { round, summary, tally } = fixture();
  for (const [status, state] of [[1, 'active'], [2, 'tallying'], [3, 'results'], [4, 'upcoming'], [5, 'failed'], [99, 'unavailable']]) {
    assert.equal(parseRoundVote({ ...round, status }, summary, tally, 0).state, state);
  }
  assert.equal(parseRoundVote({ ...round, status: 1 }, summary, tally, round.vote_end_time * 1000).state, 'tallying');
  assert.equal(parseRoundVote({ ...round, tally_timed_out: true }, summary, tally, 0).state, 'failed');
});

test('finalized results require exact round, registered options and matching nonzero totals', () => {
  const mutations = [
    (s, t) => { t.results.pop(); },
    (s, t) => { t.results.push(t.results[0]); },
    (s, t) => { t.results[0].total_value++; },
    (s) => { s.proposals[0].title = 'Different question'; },
    (s) => { s.proposals[0].options[0].label = 'Changed option'; },
    (s) => { s.proposals[0].options[0].index = 1; },
    (s) => { s.proposals[1] = s.proposals[0]; },
    (s) => { s.vote_round_id = Buffer.alloc(32, 1).toString('base64'); },
    (s) => { s.vote_end_time++; },
    (s) => { s.proposals[0].options[0].total_value = '9007199254740992'; },
  ];
  for (const mutate of mutations) {
    const { round, summary, tally } = fixture();
    mutate(summary, tally);
    assert.equal(parseRoundVote(round, summary, tally, 0).state, 'unavailable', mutate.toString());
  }
});

test('generic renderer supports 37 proposals, quantized ZEC and all-zero finalized choices', () => {
  const { round, summary, tally } = fixture();
  const newId = Buffer.alloc(32, 2).toString('base64');
  round.vote_round_id = summary.vote_round_id = newId;
  round.proposals = summary.proposals = Array.from({ length: 37 }, (_, n) => ({ id: n + 1, title: `Grant ${n + 1}`, description: 'Completed work', options: [{ index: 0, label: 'Accept', description: '', total_value: 0 }, { index: 1, label: 'Reject', description: '', total_value: 0 }] }));
  tally.results = summary.proposals.flatMap(p => p.options.map(o => ({ vote_round_id: newId, proposal_id: p.id, vote_decision: o.index, total_value: 0 })));
  const vote = parseRoundVote(round, summary, tally, 0);
  assert.equal(vote.state, 'results');
  assert.equal(vote.zecPerUnit, 0.125);
  const html = renderToStaticMarkup(React.createElement(ProposalList, { proposals: vote.proposals, published: true, zecPerUnit: vote.zecPerUnit }));
  assert.equal((html.match(/<details/g) || []).length, 37);
  assert.match(html, /Search proposals/);
  assert.match(html, /0\.00%/);
  assert.doesNotMatch(html, /NaN|Infinity|Top choice|Approved/);
});

test('official discussion identity connects an announcement without ambiguous title matching', () => {
  const { round } = fixture();
  assert.equal(isGrantsRound({ ...round, title: GRANTS.title }), false);
  assert.equal(isGrantsRound({ ...round, discussion_url: GRANTS.source }), true);
  assert.equal(isGrantsRound({ ...round, discussion_url: GRANTS.source.replace('forum.zcashcommunity.com', 'evil.example') }), false);
  assert.equal(isGrantsRound({ ...round, discussion_url: GRANTS.source.replace('57056', '570560') }), false);
  assert.equal(roundHref(round), '/governance/nu7');
  const next = { ...round, vote_round_id: Buffer.alloc(32, 1).toString('base64'), discussion_url: GRANTS.source };
  assert.equal(roundHref(next), `/governance/${roundHex(next.vote_round_id)}`);
});

test('announcements prioritize active voting, expire, and suppress stale actionable claims', () => {
  const { round, summary, tally } = fixture();
  const now = Date.parse('2026-09-15T00:00:00Z');
  const result = parseRoundVote(round, summary, tally, now);
  const catalog = { votes: [result], checkedAt: now, unavailable: false };
  assert.equal(selectAnnouncement(catalog, now).key, `${GRANTS.slug}:upcoming`);
  const active = { ...result, id: 'other', state: 'active', round: { ...round, vote_end_time: now / 1000 + 3600 } };
  assert.equal(selectAnnouncement({ ...catalog, votes: [result, active] }, now).key, 'other:active');
  const afterOpening = Date.parse('2026-09-17T12:00:00Z');
  assert.equal(selectAnnouncement({ ...catalog, checkedAt: afterOpening }, afterOpening).key, `${result.id}:results`);
  assert.equal(selectAnnouncement({ ...catalog, checkedAt: 0 }, afterOpening), null);
  const afterExpiry = Date.parse('2026-09-20T00:00:00Z');
  assert.equal(selectAnnouncement({ ...catalog, checkedAt: afterExpiry }, afterExpiry), null);
  assert.equal(selectAnnouncement({ ...catalog, votes: [{ ...result, state: 'unavailable' }], checkedAt: afterOpening }, afterOpening), null);
});

test('directory freshness decides whether a missing round is authoritative independently of tally freshness', () => {
  const now = Date.now();
  const oldTally = { votes: [], checkedAt: now - 600_001, directoryCheckedAt: now, unavailable: false };
  assert.equal(model.catalogIsStale(oldTally, now), true);
  assert.equal(model.catalogDirectoryIsStale(oldTally, now), false);
  assert.equal(model.catalogDirectoryIsStale({ ...oldTally, directoryCheckedAt: now - 600_001 }, now), true);
  assert.equal(model.catalogDirectoryIsStale({ ...oldTally, unavailable: true }, now), true);
});

test('governance pages keep a one-minute ISR boundary when catalog work is shared across requests', () => {
  for (const file of ['app/governance/page.tsx', 'app/governance/[slug]/page.tsx']) {
    assert.match(fs.readFileSync(file, 'utf8'), /export const revalidate = 60;/);
  }
});

test('new governance routes resolve missing resources and non-mainnet before HTML streaming', async () => {
  const { round } = fixture();
  let calls = 0;
  const request = load('lib/governance-request.ts', {
    './refresh-cache': { createRefreshCache: ({ load }) => load },
    './governance': model, './nu7-vote-results': nu7,
    './server-fetch': { fetchWithDeadline: async url => {
      calls++;
      const body = url.endsWith('/rounds') ? { rounds: [round] } : url.endsWith('/endorsers') ? registry : { vote_round_ids: [round.vote_round_id] };
      return Response.json(body);
    } },
  });
  for (const network of ['testnet', 'crosslink-testnet']) {
    assert.equal((await request.resolveGovernanceRequest('/governance', network)).status, 404);
  }
  assert.equal((await request.resolveGovernanceRequest('/governance/not-a-vote', 'mainnet')).status, 404);
  assert.equal(calls, 0);
  assert.equal((await request.resolveGovernanceRequest(`/governance/${nu7.NU7_ROUND_ID}`, 'mainnet')).status, 308);
  assert.equal((await request.resolveGovernanceRequest(`/governance/${'0'.repeat(64)}`, 'mainnet')).status, 404);
  assert.equal(calls, 3);
  const outage = load('lib/governance-request.ts', {
    './refresh-cache': { createRefreshCache: () => async () => { throw new Error('offline'); } },
    './governance': model, './nu7-vote-results': nu7, './server-fetch': {},
  });
  assert.equal((await outage.resolveGovernanceRequest(`/governance/${'0'.repeat(64)}`, 'mainnet')).status, 503);
  assert.equal((await outage.resolveGovernanceRequest(`/governance/${GRANTS.slug}`, 'mainnet')).status, 200);
});

test('a failed historical tally fetch does not suppress discovery of an active vote', async () => {
  const { round } = fixture();
  const active = { ...round, vote_round_id: Buffer.alloc(32, 8).toString('base64'), status: 1, vote_end_time: Math.floor(Date.now() / 1000) + 3600 };
  const data = load('lib/governance-data.ts', {
    react: { cache: fn => fn }, 'next/cache': { unstable_cache: fn => fn }, './governance': model,
    './server-fetch': { fetchWithDeadline: async url => {
      const payload = url.endsWith('/rounds') ? { rounds: [round, active] } : url.endsWith('/endorsers') ? registry : url.includes('/endorsed-rounds/') ? { vote_round_ids: [active.vote_round_id] } : null;
      return Response.json(payload, { status: payload === null ? 503 : 200 });
    } },
  });
  const catalog = await data.getGovernanceCatalog();
  assert.equal(catalog.unavailable, false);
  assert.equal(catalog.votes.length, 2);
  assert.equal(catalog.votes.find(v => v.id === roundHex(active.vote_round_id)).state, 'active');
  assert.equal(catalog.votes.find(v => v.id === nu7.NU7_ROUND_ID).state, 'unavailable');
});

function grantsFixture() {
  return {
    round: roundSchema.parse(structuredClone(require('./fixtures/grants-q3/round.json'))),
    summary: structuredClone(require('./fixtures/grants-q3/summary.json')),
    tally: structuredClone(require('./fixtures/grants-q3/tally.json')),
  };
}

test('published Q3 grants accept a sparse zero-vote tally and announce all 37 results', () => {
  const { round, summary, tally } = grantsFixture();
  const now = round.vote_end_time * 1000 + 3600_000;
  assert.equal(tally.results.length, 147);
  const vote = parseRoundVote(round, summary, tally, now);
  assert.equal(vote.state, 'results');
  assert.equal(vote.proposals.length, 37);
  assert.equal(vote.proposals.find(p => p.id === 3).options.find(o => o.index === 2).total_value, 0);
  const announcement = selectAnnouncement({ votes: [vote], checkedAt: now, unavailable: false }, now);
  assert.equal(announcement.key, `${vote.id}:results`);
  assert.match(announcement.text, /results are live/);
  const html = renderToStaticMarkup(React.createElement(ProposalList, { proposals: vote.proposals, published: true, zecPerUnit: vote.zecPerUnit }));
  assert.equal((html.match(/<details/g) || []).length, 37);
  assert.match(html, /0\.00%/);
  assert.match(html, /CipherPay/);
});

test('sparse tallies still reject missing nonzero, mismatched, duplicate and unknown results', () => {
  const mutations = [
    (s, t) => { t.results.shift(); },
    (s, t) => { t.results.push(t.results[0]); },
    (s, t) => { t.results.push({ ...t.results[0], proposal_id: 999 }); },
    (s, t) => { t.results.push({ ...t.results[0], vote_decision: 99 }); },
    (s, t) => { t.results[0].total_value++; },
    (s) => { s.proposals.find(p => p.id === 3).options.find(o => o.index === 2).total_value = 1; },
    (s) => { s.proposals.find(p => p.id === 3).options.pop(); },
  ];
  for (const mutate of mutations) {
    const { round, summary, tally } = grantsFixture();
    mutate(summary, tally);
    assert.equal(parseRoundVote(round, summary, tally, 0).state, 'unavailable', mutate.toString());
  }
});

test('catalog publishes the live Q3 sparse tally instead of falling back to unavailable', async () => {
  const { round, summary, tally } = grantsFixture();
  const data = load('lib/governance-data.ts', {
    react: { cache: fn => fn }, 'next/cache': { unstable_cache: fn => fn }, './governance': model,
    './server-fetch': { fetchWithDeadline: async url => {
      const payload = url.endsWith('/rounds') ? { rounds: [round] }
        : url.endsWith('/endorsers') ? registry
        : url.includes('/endorsed-rounds/') ? { vote_round_ids: [round.vote_round_id] }
        : url.includes('/vote-summary/') ? summary : tally;
      return Response.json(payload);
    } },
  });
  const catalog = await data.getGovernanceCatalog();
  assert.equal(catalog.unavailable, false);
  assert.equal(catalog.votes[0].state, 'results');
});
