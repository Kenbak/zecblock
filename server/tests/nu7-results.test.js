const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => dependencies[name] ?? require(name) });
  return exports;
}
const moduleUnderTest = load('lib/nu7-vote-results.ts');
const { parseVoteResults, ZEC_PER_VOTE_UNIT, NU7_ROUND_ID } = moduleUnderTest;
const copyable = load('app/governance/CopyableValue.tsx', { '@/components/CopyButton': load('components/CopyButton.tsx') });
const { VoteResults } = load('app/governance/nu7/VoteResults.tsx', { '@/lib/nu7-vote-results': moduleUnderTest, '../CopyableValue': copyable });
const fixture = () => [structuredClone(require('./fixtures/nu7/summary.json')), structuredClone(require('./fixtures/nu7/tally.json'))];

test('NU7 rejects oversized proposal, option and tally collections before walking elements', () => {
  const oversized = maximum => {
    const values = new Array(maximum + 1);
    Object.defineProperty(values, 0, { get() { throw new Error('Oversized element was visited'); } });
    return values;
  };
  const [summary, tally] = fixture();
  for (const [s, t] of [
    [{ ...summary, proposals: oversized(5) }, tally],
    [{ ...summary, proposals: [{ ...summary.proposals[0], options: oversized(4) }] }, tally],
    [summary, { results: oversized(19) }],
  ]) assert.equal(parseVoteResults(s, t).state, 'unavailable');
});

test('published NU7 API data produces 19 results with exact quantized ZEC units', () => {
  const results = parseVoteResults(...fixture());
  assert.equal(results.state, 'published');
  assert.equal(results.proposals.flatMap(p => p.options).length, 19);
  assert.equal(results.proposals[0].options[1].total_value * ZEC_PER_VOTE_UNIT, 2375932.375);
  assert.equal(results.proposals[0].options.reduce((s, o) => s + o.total_value, 0) * ZEC_PER_VOTE_UNIT, 2403537);
});

test('active and tallying rounds are pending, API errors and unknown states unavailable', () => {
  for (const status of [1, 2]) {
    const [s, t] = fixture(); s.status = status;
    assert.equal(parseVoteResults(s, t).state, 'pending');
  }
  for (const data of [null, {}, { status: 3 }]) assert.equal(parseVoteResults(data, null).state, 'unavailable');
  const [s, t] = fixture(); s.status = 5;
  assert.equal(parseVoteResults(s, t).state, 'unavailable');
});

test('wrong round, incomplete/duplicate tuples, mismatches and unsafe amounts fail closed', () => {
  const mutations = [
    (s) => { s.vote_round_id = 'another-round'; },
    (s) => { s.vote_end_time++; },
    (s, t) => { t.results.pop(); },
    (s, t) => { t.results[1] = t.results[0]; },
    (s, t) => { t.results[0].total_value++; },
    (s) => { s.proposals.pop(); },
    (s) => { s.proposals[0].options[1].index = 0; },
    (s) => { s.proposals[0].options[0].total_value = -1; },
    (s) => { s.proposals[0].options[0].total_value = '9007199254740992'; },
  ];
  for (const mutate of mutations) {
    const [s, t] = fixture(); mutate(s, t);
    assert.equal(parseVoteResults(s, t).state, 'unavailable', mutate.toString());
  }
});

test('protobuf omitted zero and string totals are supported without treating missing tuples as zero', () => {
  const [s, t] = fixture();
  delete s.proposals[0].options[0].total_value; delete t.results[0].total_value;
  s.proposals[0].options[1].total_value = String(s.proposals[0].options[1].total_value);
  t.results[1].total_value = String(t.results[1].total_value);
  assert.equal(parseVoteResults(s, t).state, 'published');
});

test('server HTML exposes all options, threshold, exact round and independent verification', () => {
  const html = renderToStaticMarkup(React.createElement(VoteResults, { results: parseVoteResults(...fixture()) }));
  assert.equal((html.match(/<article/g) || []).length, 5);
  assert.match(html, /2,403,537 ZEC participating/);
  assert.match(html, /98\.85%/);
  assert.equal((html.match(/>Top choice</g) || []).length, 5);
  assert.ok(html.indexOf('Preserve halvings.') < html.indexOf('Smooth issuance curve.'));
  assert.match(html, /threshold: <strong>met/);
  assert.ok(html.includes(NU7_ROUND_ID));
  assert.match(html, /svoted query vote verify-tally/);
  assert.match(html, /has not independently verified/);
  assert.match(html, /Raw finalized tally/);
});

test('unavailable and zero participation remain distinct; no division by zero or invented turnout', () => {
  const unavailable = renderToStaticMarkup(React.createElement(VoteResults, { results: parseVoteResults(null, null) }));
  assert.match(unavailable, /temporarily unavailable/);
  assert.ok(!unavailable.includes('ZEC participating'));
  assert.ok(unavailable.includes(NU7_ROUND_ID));
  const [s, t] = fixture();
  s.proposals.forEach(p => p.options.forEach(o => { o.total_value = 0; }));
  t.results.forEach(r => { r.total_value = 0; });
  const zero = renderToStaticMarkup(React.createElement(VoteResults, { results: parseVoteResults(s, t) }));
  assert.match(zero, /threshold: <strong>not met/);
  assert.ok(!zero.includes('NaN'));
  assert.ok(!zero.includes('Top choice'));
});

test('NU7 page remains unavailable on testnet and Crosslink before any upstream request', async () => {
  for (const network of ['testnet', 'crosslink-testnet']) {
    const { default: Page } = load('app/governance/nu7/page.tsx', {
      './NU7VoteClient': {}, './VoteResults': {}, '../GovernanceRefresh': {},
      '@/lib/seo': { getNetwork: () => network },
      '@/lib/api-client': { readApiData: () => { throw new Error('Unexpected API decode'); } },
      '@/lib/nu7-vote-config': {}, '@/lib/nu7-vote-results': moduleUnderTest,
      '@/lib/server-fetch': { fetchWithDeadline: () => { throw new Error('Unexpected fetch'); } },
      '@/lib/bounded-json': require('../../lib/bounded-json'),
      'next/cache': { unstable_cache: fn => fn },
      'next/navigation': { notFound: () => { throw new Error('NOT_FOUND'); } },
    });
    await assert.rejects(Page(), /NOT_FOUND/);
  }
});


test('snapshot comparison uses the historical Ironwood balance and separate question totals', () => {
  const stats = moduleUnderTest.getParticipationStats(parseVoteResults(...fixture()));
  assert.equal(stats.snapshotZec, 3731959.40650354);
  assert.equal(stats.minZec, 2399146.25);
  assert.equal(stats.maxZec, 2403537);
  assert.equal(stats.minShare.toFixed(1), '64.3');
  assert.equal(stats.maxShare.toFixed(1), '64.4');
  assert.equal(moduleUnderTest.getParticipationStats(parseVoteResults(null, null)), null);
  const html = renderToStaticMarkup(React.createElement(VoteResults, { results: parseVoteResults(...fixture()) }));
  assert.match(html, /3,731,959.40650354/);
  assert.match(html, /64.3–64.4%/);
  assert.match(html, /not an exact eligible-voter turnout rate/);
});

test('results announcement lasts five days and is independent of the old dismissal', () => {
  const config = load('lib/nu7-vote-config.ts');
  const banner = load('lib/nu7-vote-banner.ts', { './nu7-vote-config': config });
  const start = Date.parse(banner.NU7_RESULTS_ANNOUNCEMENT.startsAt);
  const end = Date.parse(banner.NU7_RESULTS_ANNOUNCEMENT.endsAt);
  assert.equal(end - start, 5 * 86400000);
  assert.equal(banner.getVoteBannerPhase(start - 1), 'ended');
  assert.equal(banner.getVoteBannerPhase(start), 'results');
  assert.equal(banner.getVoteBannerPhase(end - 1), 'results');
  assert.equal(banner.getVoteBannerPhase(end), 'ended');
  assert.notEqual(banner.voteBannerDismissKey('results'), banner.voteBannerDismissKey('active'));
});
