const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { starters, analysisSchema } = require('../../lib/ask/contract');

function load(file, imports = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => name in imports ? imports[name] : require(name), module, module.exports);
  return module.exports;
}
const { formatValue, summarizeEvidence, fetchEvidence } = load('lib/ask/evidence.ts', {
  '@/lib/api-client': load('lib/api-client.ts'), '@/lib/api-config': { getApiUrl: () => 'https://test.invalid' },
  './data': require('../../lib/ask/data'),
  './sources': require('../../lib/ask/sources'),
});
const sample = starters[0].spec;
test('chart handoff carries a validated selection, with no page text or supplied facts', t => {
  const originalWindow = global.window;
  t.after(() => { if (originalWindow === undefined) delete global.window; else global.window = originalWindow; });
  let event;
  global.window = { location: { pathname: '/pools' }, dispatchEvent: value => { event = value; } };
  const { openAskChart } = load('lib/ask/widget-context.ts', { './contract': require('../../lib/ask/contract') });
  const selected = { ...sample, metric: 'flows', pool: 'orchard', period: '90d', view: 'bar' };
  openAskChart(selected);
  assert.deepEqual(event.detail, { pathname: '/pools', spec: selected });
  assert.throws(() => openAskChart({ ...selected, pool: 'secret', facts: 'untrusted' }));
  assert.match(require('../../lib/ask/follow-ups').analysisFollowUps(selected)[0], /busiest day/);
});
test('local dummy verification cannot activate in production, on remote hosts or with real keys', async t => {
  const originalEnv = process.env.NODE_ENV;
  const originalWindow = global.window;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  });
  for (const [environment, hostname, siteKey, local] of [
    ['development', 'localhost', '1x00000000000000000000AA', true],
    ['development', '127.0.0.1', '1x00000000000000000000AA', true],
    ['production', 'localhost', '1x00000000000000000000AA', false],
    ['test', 'localhost', '1x00000000000000000000AA', false],
    ['development', 'zecblock.com', '1x00000000000000000000AA', false],
    ['development', 'localhost.evil.test', '1x00000000000000000000AA', false],
    ['development', 'localhost', 'real-site-key', false],
  ]) {
    process.env.NODE_ENV = environment;
    let effect; let rendered = 0;
    const tokens = [];
    global.window = { location: { hostname }, turnstile: { render: () => { rendered++; return 'widget'; }, remove: () => {} } };
    const { AskChallenge } = load('components/ask/AskChallenge.tsx', {
      react: { useEffect: fn => { effect = fn; }, useRef: () => ({ current: {} }), useState: () => [false, () => {}] },
    });
    AskChallenge({ siteKey, onToken: token => tokens.push(token), reset: 0 });
    const cleanup = effect();
    await Promise.resolve();
    assert.equal(tokens.includes('XXXX.DUMMY.TOKEN.XXXX'), local, `${environment}/${hostname}/${siteKey}`);
    assert.equal(rendered, local ? 0 : 1);
    cleanup();
    if (local) assert.equal(tokens.at(-1), '');
  }
});
const evidence = { unit: 'ZEC', series: [{ key: 'orchard', label: 'Orchard', color: 'orchard' }], points: [
  { date: '2026-08-01', values: { orchard: '90071992547409930000' } },
  { date: '2026-08-02', values: { orchard: null } },
  { date: '2026-08-03', values: { orchard: '90071992547409930001' } },
] };

test('calculations preserve single-zatoshi changes above JavaScript integer precision', () => {
  const result = summarizeEvidence(evidence, sample);
  assert.equal(result.totals[0].change, '1');
  assert.equal(result.totals[0].value, '90071992547409930001');
  assert.equal(formatValue('100500000', 'ZEC'), '1.01');
  assert.equal(formatValue('-100500000', 'ZEC', true), '−1.01');
  assert.equal(formatValue('0', 'ZEC'), '0.00');
  assert.equal(formatValue(null, 'ZEC'), 'Unavailable');
});

test('balance comparisons require both boundaries and flow totals never coerce missing to zero', () => {
  assert.equal(summarizeEvidence(evidence, { ...sample, metric: 'flows' }).totals[0].value, null);
  const partial = summarizeEvidence(evidence, sample, '2026-08-02');
  assert.equal(partial.totals[0].change, null);
  const empty = summarizeEvidence(evidence, sample, '2026-08-04');
  assert.equal(empty.totals[0].value, null); assert.equal(empty.start, null);
  const oneDay = summarizeEvidence(evidence, sample, '2026-08-03');
  assert.equal(oneDay.totals[0].change, null);
});

test('manual date windows are part of the validated recipe and use inclusive UTC boundaries', () => {
  const spec = analysisSchema.parse({ ...sample, start: '2026-08-01', end: '2026-08-01' });
  assert.equal(summarizeEvidence(evidence, spec, spec.start, spec.end).points.length, 1);
  for (const range of [{ start: '2026-02-30', end: null }, { start: '2026-08-03', end: '2026-08-01' }]) assert.equal(analysisSchema.safeParse({ ...sample, ...range }).success, false);
});

test('valid zero counts are distinct from missing counts and are summed exactly', () => {
  const counts = { ...evidence, unit: 'flows', points: [{ date: '2026-08-01', values: { orchard: '0' } }, { date: '2026-08-03', values: { orchard: '3' } }] };
  assert.equal(summarizeEvidence(counts, { ...sample, metric: 'activity' }).totals[0].value, '3');
  assert.equal(formatValue('0', 'flows'), '0');
});

test('evidence transport enforces mainnet, exact encoding and unavailable pool breakdowns', async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const meta = { requestId: 'test', network: 'mainnet', freshness: { status: 'stale' }, source: { observedAt: null } };
  const point = { date: '2026-08-01T00:00:00.000Z', orchardZat: '0', hasPoolBreakdown: true };
  global.fetch = async url => { assert.ok(url.includes('format=zatoshi')); return Response.json({ data: { points: [point] }, meta }); };
  const data = await fetchEvidence({ ...sample, pool: 'orchard' }, new AbortController().signal);
  assert.equal(data.points[0].values.orchard, '0'); assert.equal(data.meta.freshness.status, 'stale');
  for (const raw of [{ ...point, orchardZat: '' }, { ...point, orchardZat: 9007199254740992 }, { ...point, hasPoolBreakdown: false }]) {
    global.fetch = async () => Response.json({ data: { points: [raw] }, meta });
    assert.equal((await fetchEvidence({ ...sample, pool: 'orchard' }, new AbortController().signal)).points[0].values.orchard, null);
  }
  global.fetch = async () => Response.json({ data: { points: [point] }, meta: { ...meta, network: 'testnet' } });
  await assert.rejects(fetchEvidence(sample, new AbortController().signal));
  global.fetch = async () => Response.json({ data: { points: [point, point] }, meta });
  await assert.rejects(fetchEvidence(sample, new AbortController().signal));
});

test('Ask is discoverable on mainnet, with dated sitemap metadata and no testnet navigation', () => {
  const { getNavigation } = load('lib/navigation.ts');
  for (const network of ['mainnet', 'testnet', 'crosslink']) assert.equal(getNavigation(network).flatMap(group => group.items).some(item => item.href === '/zift'), network === 'mainnet');
  const { getStaticSitemapEntries } = load('lib/sitemaps.ts');
  const entry = getStaticSitemapEntries('core', 'https://zecblock.com', []).find(item => item.url.endsWith('/zift'));
  assert.equal(entry.lastModified, '2026-10-29'); assert.equal(entry.changeFrequency, 'weekly');
});

test('Ask server rendering and metadata enforce the mainnet-only page policy', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  for (const network of ['mainnet', 'testnet', 'crosslink-testnet']) {
    const seo = load('lib/seo.ts', {
      '@/lib/network': { getConfiguredNetwork: () => network },
      '@/lib/api-config': {}, '@/lib/api-client': {}, '@/lib/server-fetch': {},
    });
    const page = load('app/zift/page.tsx', {
      '@/lib/seo': seo, '../ask/ask.module.css': { page: 'ask-page' },
      '../ask/AskExperience': { AskExperience: () => React.createElement('div', null, 'Interactive workspace') },
      '@/components/ask/ZiftMark': { ZiftMark: () => null },
      'next/link': ({ children, ...props }) => React.createElement('a', props, children),
    });
    assert.equal(page.metadata.robots.index, network === 'mainnet');
    assert.equal(page.metadata.robots.follow, true);
    assert.equal(page.metadata.alternates.canonical, `${seo.getBaseUrl()}/zift`);
    const html = renderToStaticMarkup(React.createElement(page.default));
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
    assert.ok(html.includes('Explore Zcash mainnet data'));
    assert.equal(html.includes('Interactive workspace'), network === 'mainnet');
    assert.equal(html.includes('Zift is available on mainnet'), network !== 'mainnet');
    assert.ok(html.includes('application/ld+json'));
  }
});

test('new examples enforce dataset-specific pool and period support', () => {
  const { resolveShortcut } = require('../../lib/ask/contract');
  for (const starter of starters) assert.equal(analysisSchema.safeParse(resolveShortcut(starter.title)).success, true);
  const swap = starters.find(item => item.id === 'swap-volume').spec;
  assert.equal(analysisSchema.safeParse({ ...swap, period: '1y' }).success, false);
  assert.equal(resolveShortcut('show one year', swap), null);
  assert.equal(resolveShortcut('just Orchard', swap), null);
  assert.equal(resolveShortcut('How much ZEC is entering and leaving?').metric, 'flows');
  assert.equal(resolveShortcut('How many new addresses were created?'), null);
});

test('swap USD values are approximate cents and counts remain integer counts', () => {
  const { normalizeEvidence } = require('../../lib/ask/data');
  const spec = starters.find(item => item.id === 'swap-volume').spec;
  const data = { data: [{ date: '2026-09-01', inflowVolume: 10.25, outflowVolume: 1.5, inflowCount: 3, outflowCount: 1 }, { date: '2026-09-02', inflowVolume: 0, outflowVolume: null, inflowCount: 0, outflowCount: 2 }] };
  const result = normalizeEvidence(spec, data, { network: 'mainnet' });
  assert.equal(result.unit, 'USD'); assert.equal(result.csvUnit, 'usd_cents');
  assert.equal(result.points[0].values.inflow, '1025');
  assert.equal(result.points[1].values.outflow, null);
  assert.equal(formatValue(summarizeEvidence(result, spec).totals[0].value, result.unit), '10.25');
  assert.match(result.note, /approximate/); assert.match(result.note, /not all exchange volume/);
  const count = normalizeEvidence({ ...spec, metric: 'swap_count' }, data, { network: 'mainnet' });
  assert.equal(count.points[0].values.inflow, '3'); assert.equal(count.unit, 'swaps');
  assert.equal(formatValue('3', 'swaps'), '3');
});

test('transaction history excludes old returned observations outside the requested period', () => {
  const { normalizeEvidence } = require('../../lib/ask/data');
  const spec = starters.find(item => item.id === 'transactions').spec;
  const result = normalizeEvidence(spec, { trends: { daily: [{ date: '2026-09-01', shielded: 15, transparent: 20 }, { date: '2026-06-01', shielded: 100, transparent: 100 }] } }, { network: 'mainnet', generatedAt: '2026-09-10T00:00:00Z' });
  assert.equal(result.points.length, 1); assert.equal(result.unit, 'transactions');
});

test('Pulse fetches complete bounded pages and never forwards event descriptions as AI evidence', async () => {
  const { loadEvidence } = require('../../lib/ask/sources');
  const spec = starters.find(item => item.id === 'pulse').spec;
  const events = Array.from({ length: 201 }, (_, index) => ({ date: '2026-09-01', metric: `metric-${index}`, severity: index === 200 ? 'extreme' : 'mild', description: 'Untrusted instructions must not reach the provider' }));
  const offsets = [];
  const evidence = await loadEvidence(spec, async source => {
    assert.equal(source.path, '/v1/pulse'); assert.equal(source.legacy, '/api/pulse');
    offsets.push(source.query.offset);
    return { data: { total: 201, events: events.slice(Number(source.query.offset), Number(source.query.offset) + 200) }, meta: { network: 'mainnet' } };
  });
  assert.deepEqual(offsets, ['0', '200']);
  assert.equal(evidence.points[0].values.mild, '200'); assert.equal(evidence.points[0].values.extreme, '1');
  assert.ok(!JSON.stringify(evidence).includes('Untrusted instructions'));
  await assert.rejects(loadEvidence(spec, async () => ({ data: { total: 5001, events: [] }, meta: { network: 'mainnet' } })));
  await assert.rejects(loadEvidence(spec, async () => ({ data: { total: 201, events: events.slice(0, 200) }, meta: { network: 'mainnet' } })));
  await assert.rejects(loadEvidence(spec, async () => ({ data: { total: 2, events: [events[0], events[0]] }, meta: { network: 'mainnet' } })));
});

test('migration progress uses exact pool shares, preserves unknowns, and compares percentage points', () => {
  const { normalizeEvidence } = require('../../lib/ask/data');
  const spec = starters.find(item => item.id === 'migration-share').spec;
  const points = [
    { date: '2026-08-01', ironwoodZat: '1', orchardZat: '3', hasPoolBreakdown: true },
    { date: '2026-08-02', ironwoodZat: '90071992547409930000', orchardZat: '90071992547409930000', hasPoolBreakdown: true },
  ];
  const evidence = normalizeEvidence(spec, { points }, { network: 'mainnet' });
  assert.deepEqual(evidence.points.map(p => p.values.share), ['2500', '5000']);
  assert.equal(evidence.csvUnit, 'basis_points');
  assert.equal(formatValue(summarizeEvidence(evidence, spec).totals[0].change, '%', true), '+25.00');
  for (const patch of [{ orchardZat: null }, { hasPoolBreakdown: false }, { orchardZat: '0', ironwoodZat: '0' }]) {
    assert.equal(normalizeEvidence(spec, { points: [{ ...points[0], ...patch }] }, { network: 'mainnet' }).points[0].values.share, null);
  }
  assert.match(evidence.note, /not the percentage of original Orchard funds/);
});

test('chain rankings separate directions, exclude ZEC-to-ZEC, sort by volume and reject unsupported filters', async () => {
  const { normalizeEvidence, snapshotInput } = require('../../lib/ask/data');
  const { sourceRequest } = require('../../lib/ask/sources');
  const { resolveShortcut } = require('../../lib/ask/contract');
  const spec = starters.find(item => item.id === 'chain-inflows').spec;
  const chains = [
    { chain: 'btc', direction: 'inflow', volumeUsd: 5 },
    { chain: 'eth', direction: 'inflow', volumeUsd: 10.01 },
    { chain: 'zec', direction: 'inflow', volumeUsd: 100 },
    { chain: 'tron', direction: 'outflow', volumeUsd: 20 },
  ];
  const data = normalizeEvidence(spec, { period: '30d', chains }, { network: 'mainnet' });
  assert.equal(data.dimension, 'chain');
  assert.deepEqual(data.points.map(p => p.date), ['eth', 'btc']);
  assert.equal(summarizeEvidence(data, spec).totals[0].value, '1501');
  assert.equal(summarizeEvidence(data, spec).start, null);
  assert.equal(sourceRequest(spec).path, '/v1/crosschain/volume-by-chain');
  assert.equal(resolveShortcut('show 90 days', spec), null);
  assert.equal(resolveShortcut('show as a line chart', spec), null);
  assert.equal(resolveShortcut('show as a table', spec).view, 'table');
  for (const patch of [{ period: '90d' }, { start: '2026-08-01' }, { pool: 'ironwood' }, { view: 'line' }]) assert.equal(analysisSchema.safeParse({ ...spec, ...patch }).success, false);
  assert.notEqual(snapshotInput(spec, data), snapshotInput(spec, { ...data, points: [{ ...data.points[0], date: 'sol' }, data.points[1]] }));
  const outflow = normalizeEvidence({ ...spec, metric: 'chain_outflows' }, { period: '30d', chains }, { network: 'mainnet' });
  assert.deepEqual(outflow.points.map(p => p.date), ['tron']);
  for (const bad of [[...chains, chains[0]], [{ chain: '=EXEC()', direction: 'inflow', volumeUsd: 1 }]]) assert.throws(() => normalizeEvidence(spec, { period: '30d', chains: bad }, { network: 'mainnet' }));
});

test('Ask sources separate observed dates, retrieval time and guide review dates', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { AskSources } = load('components/ask/AskSources.tsx');
  const html = renderToStaticMarkup(React.createElement(AskSources, {
    sources: [{ id: 'pools', title: 'Pool methodology', url: '/pools', reviewed: '2026-09-29' }],
    dataContext: { start: '2026-08-01', end: '2026-08-31', retrievedAt: '2026-09-29T02:00:00Z', source: '/pools#flows', label: 'Public flows' },
  }));
  assert.match(html, /observations through 2026-08-31/);
  assert.match(html, /2026-09-29 02:00:00/);
  assert.match(html, /Guide reviewed/);
  assert.match(html, /href="\/pools#flows"/);
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /Freshness: unknown/);
});

test('Ask client presents actionable safe failures and never echoes upstream text', () => {
  const api = load('lib/api-client.ts');
  const { askErrorMessage } = load('lib/ask/client.ts', { '@/lib/api-client': api, './api-base': {} });
  const error = (status, code) => new api.ApiError('private backend secret', status, undefined, undefined, null, code);
  assert.match(askErrorMessage(error(403, 'ask-verification')), /Verification/);
  assert.match(askErrorMessage(error(429, 'ask-quota')), /allowance/);
  assert.match(askErrorMessage(error(503, 'ask-source')), /Source data/);
  assert.match(askErrorMessage(error(503, 'ask-answer')), /validate/);
  assert.match(askErrorMessage(error(503, 'ask-provider')), /provider/);
  assert.match(askErrorMessage(error(504, 'ask-timeout')), /too long/);
  assert.doesNotMatch(askErrorMessage(error(500)), /private backend secret/);
});

test('transaction cards link exact IDs, distinguish pending and preserve fee precision', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { AskTransactions } = load('components/ask/AskTransactions.tsx', { 'next/link': ({ href, children, ...props }) => React.createElement('a', { href, className: props.className }, children) });
  const id = 'a'.repeat(64);
  const html = renderToStaticMarkup(React.createElement(AskTransactions, { expanded: true, result: { query: { mode: 'detail', txid: id, limit: 1 }, status: 'found', retrievedAt: new Date().toISOString(), rows: [{ txid: id, status: 'pending', blockHeight: null, blockHash: null, timestamp: null, confirmations: null, size: 100, feeZat: null, coinbase: false, pools: ['Orchard'], componentsKnown: false, transparentInputs: null, transparentOutputs: null }] } }));
  assert.ok(html.includes(`href="/tx/${id}"`)); assert.match(html, /Pending/); assert.match(html, /Fee: unavailable/); assert.doesNotMatch(html, /confirmations|Block timestamp/);
  const exact = renderToStaticMarkup(React.createElement(AskTransactions, { result: { rows: [{ txid: id, status: 'indexed', pools: [], feeZat: '9007199254740993', size: null, blockHeight: 1, confirmations: null, timestamp: null }] } }));
  assert.match(exact, /90071992\.54740993 ZEC/);
});

test('every mainnet navigation destination has a reviewed, page-specific Ask guide', () => {
  const { getNavigation } = load('lib/navigation.ts');
  const { describePage, pageById, pageIds } = require('../../lib/ask/pages');
  const { getKnowledge, knowledgeIds } = require('../api/v1/lib/ask-knowledge');
  const { guidedReply } = require('../api/v1/lib/ask-chat');
  assert.equal(new Set(knowledgeIds).size, knowledgeIds.length);
  const destinations = getNavigation('mainnet', 'footer').flatMap(section => section.items);
  for (const { href } of destinations) {
    const page = describePage(href);
    assert.ok(pageIds.includes(page.id), href);
    if (href !== '/zift') assert.notEqual(page.topic, 'explorer', href);
    assert.equal(pageById(page.id).topic, page.topic, href);
    const [guide] = getKnowledge([page.topic]);
    assert.ok(guide?.text.length > 100, href);
    assert.ok(guide.url.startsWith('/'), href);
    const reply = guidedReply({ question: 'Explain this page', page: page.id, context: null, history: [], locale: 'auto' });
    assert.ok(reply.answer.includes(guide.text), href);
    for (const question of page.questions || []) {
      assert.ok(guide.questions?.[question], `${href}: ${question}`);
      const answer = guidedReply({ question, page: page.id, context: null, history: [], locale: 'auto' });
      assert.equal(answer.answer, guide.questions[question]);
      assert.equal(answer.spec, null);
    }
  }
});

test('page mapping separates metrics, handles known child routes and never serializes form data', () => {
  const { describePage } = require('../../lib/ask/pages');
  const { guidedReply } = require('../api/v1/lib/ask-chat');
  for (const [path, topic] of [['/network', 'network'], ['/network/nodes', 'nodes'], ['/privacy', 'privacy_score'], ['/privacy/wallets', 'wallet_signals'], ['/mempool/live', 'mempool'], ['/blocks/latest', 'blocks'], ['/txs/latest', 'transactions'], ['/charts/shielded-supply', 'chart_shielded_supply'], ['/governance/nu7', 'governance'], ['/newsletter/example-issue', 'newsletter'], ['/address/' + 'a'.repeat(35), 'address']]) assert.equal(describePage(path).topic, topic, path);
  for (const path of ['/decrypt', '/tools/broadcast', '/tools/decode']) {
    const page = describePage(path);
    assert.deepEqual(Object.keys(page).sort(), ['id', 'questions', 'title', 'topic']);
    const reply = guidedReply({ question: 'Explain this page', page: page.id, context: null, history: [], locale: 'auto' });
    assert.equal(reply.spec, null);
    assert.doesNotMatch(reply.answer, /ZecBlock indexes public Zcash data/);
  }
  assert.equal(describePage('/network/private-admin').id, 'explorer');
  assert.equal(describePage('/mining/').topic, 'mining');
  assert.match(guidedReply({ question: 'Explain this page', page: 'nodes', context: null, history: [], locale: 'auto' }).answer, /not all Zcash nodes/);
});


test('individual chart guides track the catalogue and reject unknown chart routes', () => {
  const { CHART_CATALOG } = load('lib/chart-catalog.ts', { './network-overview': load('lib/network-overview.ts') });
  const snapshot = require('../../lib/ask/chart-pages.json');
  assert.deepEqual(snapshot, CHART_CATALOG.map(({ id, title, description, unit, window, href }) => ({ id, title, description, unit, window, source: href })), 'Regenerate with write-ask-chart-guides.js when chart metadata changes');
  const { describePage } = require('../../lib/ask/pages');
  const { getKnowledge } = require('../api/v1/lib/ask-knowledge');
  for (const chart of snapshot) {
    const page = describePage(`/charts/${chart.id}`);
    assert.equal(page.title, chart.title);
    assert.ok(getKnowledge([page.topic])[0].text.includes(chart.description));
  }
  assert.equal(describePage('/charts/not-a-real-chart').id, 'explorer');
});
