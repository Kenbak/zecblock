const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, overrides = {}) {
  const filename = path.resolve(file);
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const localRequire = name => {
    if (name in overrides) return overrides[name];
    if (name === 'server-only') return {};
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => {
      const htmlProps = { ...props };
      delete htmlProps.prefetch;
      return React.createElement('a', htmlProps, children);
    } };
    if (name.startsWith('@/') || name.startsWith('.')) {
      const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(filename), name);
      if (base.endsWith('.json')) return require(base);
      return load(fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`, overrides);
    }
    return require(name);
  };
  new Function('module', 'exports', 'require', output)(module, module.exports, localRequire);
  return module.exports;
}

const { buildUpgradeTrackers } = load('lib/upgrade-trackers.ts');
const { buildUpgradeHistory } = load('lib/upgrade-history.ts');
const { buildUpgradeChanges } = load('lib/upgrade-changes.ts');
const { readUpgradeSnapshot } = load('lib/network-upgrades.ts');
const mainActivation = 3543405;
const testActivation = 4465026;
const timestamp = Date.parse('2026-11-04T23:59:30Z') / 1000;
const stats = (network, height, nu7Height) => ({
  blockchain: { height, latestBlockTime: timestamp },
  mining: { avgBlockTime: 75, targetBlockTime: 75, blocks24h: 1152, schedule: { network: network === 'mainnet' ? 'main' : 'test', source: 'node-upgrade-schedule', nu7Height,
    eras: [{ height: 0, seconds: 150 }, { height: network === 'mainnet' ? 653600 : 584000, seconds: 75 }, ...(nu7Height == null ? [] : [{ height: nu7Height, seconds: 25 }])],
  } },
});
const snapshot = (network, height, activation) => readUpgradeSnapshot(stats(network, height, activation), network);
const escaped = value => renderToStaticMarkup(React.createElement(React.Fragment, null, value));
const anchors = html => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, inner]) => ({
  href: attributes.match(/\bhref="([^"]*)"/)?.[1],
  label: attributes.match(/\baria-label="([^"]*)"/)?.[1],
  content: inner,
}));
function assertAction(html, href, label) {
  const text = escaped(label);
  assert.ok(anchors(html).some(anchor => anchor.href === href && (anchor.label === label
    || anchor.content === text || (anchor.content.startsWith(`${text}<svg`) && anchor.content.endsWith('</svg>')))), `${label}: ${href}`);
}
function renderImpact(upgradeId, network, responses = {}, active = false) {
  const calls = [];
  const { UpgradeImpact } = load('components/network/UpgradeImpact.tsx', {
    '@/hooks/useApiQuery': { useApiQuery: (route, params, options) => {
      calls.push({ route, params, options });
      return responses[route] ?? { data: null, error: null };
    } },
  });
  return { html: renderToStaticMarkup(React.createElement(UpgradeImpact, { upgradeId, network, active })), calls };
}

test('NU7 tracker distinguishes node scheduling, activation, announcement and unavailable testnet status', () => {
  const announced = buildUpgradeTrackers(snapshot('mainnet', mainActivation + 100, null), 'mainnet')[0];
  assert.equal(announced.status, 'announced', 'passing an announcement height does not establish activation');
  assert.equal(announced.authority, 'announcement');
  assert.equal(announced.height, mainActivation);
  const scheduled = buildUpgradeTrackers(snapshot('mainnet', mainActivation - 1, mainActivation), 'mainnet')[0];
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.authority, 'node');
  assert.equal(scheduled.estimatedDate, '2026-11-05');
  const active = buildUpgradeTrackers(snapshot('mainnet', mainActivation, mainActivation), 'mainnet')[0];
  assert.equal(active.status, 'active');
  assert.equal(active.estimatedDate, null);
  const override = buildUpgradeTrackers(snapshot('mainnet', mainActivation, mainActivation + 1000), 'mainnet')[0];
  assert.equal(override.height, mainActivation + 1000, 'the serving-node schedule wins over the announcement');
  assert.equal(override.status, 'scheduled');
  const unavailable = buildUpgradeTrackers(snapshot('testnet', testActivation + 100, null), 'testnet')[0];
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.height, null);
  assert.equal(unavailable.estimatedDate, null);
  assert.deepEqual(buildUpgradeTrackers(null, 'crosslink-testnet'), []);
});

test('upgrade records preserve network heights and distinguish related analytics from direct impact trackers', () => {
  for (const [network, ironwoodHeight, orchardHeight, activation] of [
    ['mainnet', 3428143, 3364600, mainActivation], ['testnet', 4134000, 4052000, testActivation],
  ]) {
    const records = buildUpgradeTrackers(snapshot(network, activation + 100, activation), network);
    assert.deepEqual(records.map(record => record.id), ['nu7', 'nu63', 'nu62']);
    assert.equal(records[0].href, '/network/block-speed');
    assert.equal(records[0].related, false);
    assert.equal(records[1].height, ironwoodHeight);
    assert.equal(records[1].href, '/ironwood');
    assert.equal(records[1].related, false);
    assert.equal(records[2].height, orchardHeight);
    assert.equal(new URL(records[2].href, 'https://example.test').pathname, '/turnstile');
    assert.equal(records[2].related, true, 'Turnstile is related analytics, not a feature introduced by NU6.2');
    assert.equal(records[1].status, 'active');
    assert.equal(records[2].status, 'active');
    for (const record of records) assert.ok(record.sources.length && record.sources.every(source => source.href.startsWith('https://zips.z.cash/')));
    const offline = buildUpgradeTrackers(null, network);
    assert.equal(offline[1].status, 'historical');
    assert.equal(offline[2].status, 'historical');
  }
});

test('major-change tools use existing routes and stable supporting sections', () => {
  for (const network of ['mainnet', 'testnet']) {
    const changes = buildUpgradeHistory(null, network).flatMap(milestone => buildUpgradeChanges(milestone.id, network));
    const sectionSources = {
      '/network': ['app/network/NetworkClient.tsx', 'components/network/MiningIssuance.tsx', 'components/network/NetworkAccounting.tsx'],
      '/mining': ['app/mining/page.tsx'],
      '/pools': ['app/pools/page.tsx'],
      '/ironwood': ['MigrationActivity', 'PrivacyScore', 'MigrationTiers', 'WalletReadiness', 'SupplyVerification'].map(name => `app/ironwood/components/${name}.tsx`),
    };
    for (const href of changes.flatMap(change => change.links.map(link => link.href))) {
      const url = new URL(href, 'https://example.test');
      const route = url.pathname.startsWith('/charts/') ? 'app/charts/[slug]/page.tsx' : `app${url.pathname}/page.tsx`;
      assert.ok(fs.existsSync(route), href);
      if (url.hash) {
        const sources = sectionSources[url.pathname].map(file => fs.readFileSync(file, 'utf8')).join('\n');
        assert.ok(sources.includes(`id="${url.hash.slice(1)}"`), href);
      }
    }
  }
});

test('all eleven upgrades have sourced major changes and associated wallet standards remain explicitly labeled', () => {
  const counts = { overwinter: 4, sapling: 5, blossom: 3, heartwood: 2, canopy: 4, nu5: 6, nu6: 3, nu61: 3, nu62: 3, nu63: 5, nu7: 6 };
  for (const network of ['mainnet', 'testnet']) {
    let total = 0;
    for (const [id, count] of Object.entries(counts)) {
      const changes = buildUpgradeChanges(id, network);
      assert.equal(changes.length, count, id);
      assert.equal(new Set(changes.map(change => change.id)).size, count, `${id} has unique change IDs`);
      for (const change of changes) {
        assert.ok(change.title && change.description && change.sources.length, `${id}/${change.id}`);
        for (const source of change.sources) assert.equal(new URL(source.href).hostname, 'zips.z.cash');
      }
      total += changes.length;
      assert.deepEqual(buildUpgradeChanges(id, 'crosslink-testnet'), []);
    }
    assert.equal(total, 44);
    const expiry = buildUpgradeChanges('blossom', network).find(change => change.id === 'wallet-expiry-default');
    assert.match(expiry.description, /wallet transaction-creation default/);
    assert.match(expiry.description, /consensus expiry limit was unchanged/);
    const unified = buildUpgradeChanges('nu5', network).find(change => change.id === 'unified-wallet-formats');
    assert.match(unified.value, /wallet standard/);
    assert.match(unified.description, /not a consensus activation requirement/);
    assert.deepEqual(unified.links, [], 'the transaction decoder does not decode Unified Addresses');
  }
  for (const unknown of ['missing', 'toString', 'constructor', '__proto__']) assert.deepEqual(buildUpgradeChanges(unknown, 'mainnet'), []);
});

test('NSM links distinguish pending mechanism context, activated accounting and issuance-only projections', () => {
  for (const [network, height] of [['mainnet', '8,939,664'], ['testnet', '7,305,222']]) {
    const pending = buildUpgradeChanges('nu7', network);
    const reserve = pending.find(change => change.id === 'nu7-nsm');
    assert.ok(reserve.description.includes(height));
    const links = pending.flatMap(change => change.links).filter(link => link.href === '/network#nu7-accounting');
    assert.equal(links.length, 2);
    assert.ok(links.every(link => link.note === `${network === 'mainnet' ? 'Mainnet' : 'Testnet'} accounting begins at NU7`));
    assert.ok(buildUpgradeChanges('nu7', network, true).flatMap(change => change.links)
      .filter(link => link.href === '/network#nu7-accounting').every(link => !link.note));
    const projection = reserve.links.find(link => link.href === '/network#issuance');
    assert.match(projection.note, /excludes future removals and NSM reissuance/);
    const fees = pending.find(change => change.id === 'nu7-fee-allocation');
    assert.match(fees.description, /rounded down once per block/);
    assert.match(fees.description, /rather than permanent destruction/);
    const retirement = pending.find(change => change.id === 'nu7-v4-retirement');
    assert.match(retirement.description, /^From activation, version 4 transactions become invalid/);
    const funding = pending.find(change => change.id === 'nu7-funding-streams');
    assert.match(funding.description, network === 'mainnet' ? /Updates the mainnet ZCG address/ : /testnet recipient address remains unchanged/);
  }
});

test('NU7 dashboard separates pending context from verified exact signed accounting', () => {
  for (const [network, activation, chain, currency] of [['mainnet', mainActivation, 'main', 'ZEC'], ['testnet', testActivation, 'test', 'TAZ']]) {
    const responses = {
      '/v1/network/stats': { data: stats(network, activation - 1, activation), error: null },
      '/v1/network/accounting': { data: { schedule: { network: chain, nu7Height: activation }, nodeHeight: activation, nsmBalanceZat: '-1' }, error: null },
    };
    const pending = renderImpact('nu7', network, responses);
    // One unambiguous daily count instead of an average whose window differs by page.
    assert.match(pending.html, /Blocks · last 24h/);
    assert.match(pending.html, />1,152</);
    assert.match(pending.html, /Target 1,152 today · 3,456 with NU7/);
    assert.match(pending.html, /At NU7/);
    assert.match(pending.html, /Accounting begins at activation/);
    assert.ok(pending.html.includes('href="/network#nu7-accounting"'));
    assertAction(pending.html, '/network/block-speed', 'View block speed');
    assertAction(pending.html, '/network#nu7-accounting', 'Explore NSM');
    assert.equal(pending.calls.find(call => call.route === '/v1/network/accounting').options.enabled, false);
    assert.ok(!pending.html.includes(`-0.00000001 ${currency}`));
    const active = renderImpact('nu7', network, responses, true);
    assert.ok(active.html.includes(`-0.00000001 ${currency}`));
    assert.doesNotMatch(active.html, /At NU7|Accounting begins at activation/);
    assert.equal(active.calls.find(call => call.route === '/v1/network/accounting').options.enabled, true);
    for (const invalid of [
      { data: responses['/v1/network/accounting'].data, error: 'observation failed' },
      { data: { ...responses['/v1/network/accounting'].data, schedule: { network: chain === 'main' ? 'test' : 'main', nu7Height: activation } }, error: null },
      { data: { ...responses['/v1/network/accounting'].data, nodeHeight: activation - 1 }, error: null },
      { data: { ...responses['/v1/network/accounting'].data, nsmBalanceZat: Number.MAX_SAFE_INTEGER + 1 }, error: null },
    ]) {
      const result = renderImpact('nu7', network, { ...responses, '/v1/network/accounting': invalid }, true);
      assert.match(result.html, /Unavailable/);
      assert.ok(!result.html.includes(`-0.00000001 ${currency}`));
      assert.ok(!result.html.includes(`>0.00000000 ${currency}<`));
    }
  }
});

test('Ironwood preview normalizes zatoshis, preserves the migration denominator and rejects wrong-network or unsafe snapshots', () => {
  const overview = { network: 'mainnet', poolSizes: { orchardZat: '300000000', ironwoodZat: '200000001' }, inflowSources: { fromOrchardZat: '100000000' } };
  const responses = { '/v1/migration/overview': { data: overview, error: null } };
  const result = renderImpact('nu63', 'mainnet', responses);
  assert.match(result.html, />25\.0%</);
  assert.match(result.html, /title="2\.00000001 ZEC"/);
  assert.ok(result.html.includes('href="/ironwood#supply"'));
  assertAction(result.html, '/ironwood', 'View migration');
  assertAction(result.html, '/ironwood#supply', 'View pool supply');
  assert.equal(result.calls.find(call => call.route === '/v1/migration/overview').options.enabled, true);
  assert.ok(result.calls.filter(call => call.route !== '/v1/migration/overview').every(call => !call.options.enabled));
  const stale = renderImpact('nu63', 'mainnet', { '/v1/migration/overview': { data: overview, error: 'refresh failed' } });
  assert.match(stale.html, /25\.0%/);
  assert.match(stale.html, /Last available/);
  for (const data of [
    { ...overview, network: 'testnet' },
    { ...overview, poolSizes: { ...overview.poolSizes, orchardZat: '9007199254740992' } },
  ]) {
    const invalid = renderImpact('nu63', 'mainnet', { '/v1/migration/overview': { data, error: null } });
    assert.equal((invalid.html.match(/>Unavailable</g) || []).length, 2);
    assert.doesNotMatch(invalid.html, /25\.0%|2\.00000001 ZEC/);
  }
  const empty = renderImpact('nu63', 'mainnet', { '/v1/migration/overview': { data: { ...overview, poolSizes: { orchardZat: '0', ironwoodZat: '0' }, inflowSources: { fromOrchardZat: '0' } }, error: null } });
  assert.match(empty.html, />Unavailable</, 'an empty denominator is not zero-percent migration');
  assert.match(empty.html, /title="0\.00000000 ZEC"/, 'a known empty pool is a valid zero balance');
});

test('NU6.2 preview uses the June 1 exit cohort and matching network without overlapping destination totals', () => {
  const responses = {
    '/v1/network/stats': { data: stats('mainnet', mainActivation - 1, mainActivation), error: null },
    '/v1/shielded-pools/turnstile': { data: { since: '2026-06-01', summary: { totalDeshielded: 100, heldPercent: 30, reshieldedPercent: 20, movedPercent: 70 } }, error: null },
  };
  const valid = renderImpact('nu62', 'mainnet', responses);
  assert.match(valid.html, />30\.0%</);
  assert.match(valid.html, />20\.0%</);
  assert.doesNotMatch(valid.html, /70\.0%/);
  assert.match(valid.html, /Public exits since Jun 1, 2026/);
  assert.ok(valid.html.includes('href="/turnstile?period=nu6.2"'));
  assertAction(valid.html, '/turnstile?period=nu6.2', 'View pool flows');
  assert.deepEqual(valid.calls.find(call => call.route === '/v1/shielded-pools/turnstile').params, { since: '2026-06-01' });
  for (const overrides of [
    { '/v1/network/stats': { data: stats('testnet', testActivation - 1, testActivation), error: null } },
    { '/v1/shielded-pools/turnstile': { data: { ...responses['/v1/shielded-pools/turnstile'].data, since: '2026-06-02' }, error: null } },
    { '/v1/shielded-pools/turnstile': { data: { since: '2026-06-01', summary: { totalDeshielded: 0, heldPercent: 0, reshieldedPercent: 0 } }, error: null } },
  ]) {
    const invalid = renderImpact('nu62', 'mainnet', { ...responses, ...overrides });
    assert.equal((invalid.html.match(/>Unavailable</g) || []).length, 2);
    assert.doesNotMatch(invalid.html, />0\.0%</);
  }
  const stale = renderImpact('nu62', 'mainnet', { ...responses, '/v1/network/stats': { ...responses['/v1/network/stats'], error: 'refresh failed' } });
  assert.match(stale.html, /30\.0%/);
  assert.match(stale.html, /Last available/);
});

test('historical dashboard previews label current coin balances and suppress unsupported network requests', () => {
  const data = { ...stats('testnet', testActivation - 1, testActivation), supply: { chain: 'test', sapling: 12.5, orchard: 25.125 } };
  for (const [id, title, amount] of [['sapling', 'Sapling', '12.5'], ['nu5', 'Orchard', '25.125']]) {
    const result = renderImpact(id, 'testnet', { '/v1/network/stats': { data, error: null } });
    assert.ok(result.html.includes(`Current ${title} balance`));
    assert.ok(result.html.includes(`title="${amount} TAZ"`));
    assert.match(result.html, /Current pool supply/);
    assertAction(result.html, '/pools#supply', 'View pool supply');
    const wrong = renderImpact(id, 'testnet', { '/v1/network/stats': { data: { ...data, supply: { ...data.supply, chain: 'main' } }, error: null } });
    assert.match(wrong.html, />Unavailable</);
  }
  const blossom = renderImpact('blossom', 'testnet', { '/v1/network/stats': { data: { ...data, mining: { ...data.mining, targetBlockTime: 75 } }, error: null } });
  assert.match(blossom.html, /Current block interval/);
  assert.match(blossom.html, /75\.0s/);
  assert.match(blossom.html, /current target 75s/);
  for (const id of ['nu7', 'nu63', 'nu62', 'sapling', 'nu5', 'blossom']) {
    const unsupported = renderImpact(id, 'crosslink-testnet');
    assert.equal(unsupported.html, '');
    assert.ok(unsupported.calls.every(call => !call.options.enabled));
  }
});

test('protocol history preserves canonical network activation heights, including the restored NU5 testnet activation', () => {
  const ids = ['overwinter', 'sapling', 'blossom', 'heartwood', 'canopy', 'nu5', 'nu6', 'nu61', 'nu62', 'nu63', 'nu7'];
  for (const [network, heights] of [
    ['mainnet', [347500, 419200, 653600, 903000, 1046400, 1687104, 2726400, 3146400, 3364600, 3428143, mainActivation]],
    ['testnet', [207500, 280000, 584000, 903800, 1028500, 1842420, 2976000, 3536500, 4052000, 4134000, testActivation]],
  ]) {
    const activation = heights.at(-1);
    const history = buildUpgradeHistory(snapshot(network, activation, activation), network);
    assert.deepEqual(history.map(upgrade => upgrade.id), ids);
    assert.deepEqual(history.map(upgrade => upgrade.height), heights);
    assert.ok(history.every(upgrade => upgrade.status === 'active'));
    assert.ok(history.every(upgrade => upgrade.summary && upgrade.sourceUrl.startsWith('https://zips.z.cash/')));
    const beforeNu5 = buildUpgradeHistory(snapshot(network, heights[5] - 1, activation), network);
    assert.equal(beforeNu5[4].status, 'active');
    assert.equal(beforeNu5[5].status, 'scheduled');
    assert.equal(buildUpgradeHistory(snapshot(network, heights[5], activation), network)[5].status, 'active');
  }
});

test('protocol history does not turn missing observations or an announced NU7 height into activation', () => {
  for (const network of ['mainnet', 'testnet']) {
    const offline = buildUpgradeHistory(null, network);
    assert.ok(offline.slice(0, -1).every(upgrade => upgrade.status === 'historical'));
    assert.equal(offline.at(-1).height, network === 'mainnet' ? mainActivation : null);
    assert.equal(offline.at(-1).status, network === 'mainnet' ? 'announced' : 'unavailable');
  }
  const afterAnnouncement = buildUpgradeHistory(snapshot('mainnet', mainActivation + 100, null), 'mainnet');
  assert.equal(afterAnnouncement.at(-1).status, 'announced');
  assert.equal(buildUpgradeHistory(snapshot('mainnet', mainActivation + 100, mainActivation), 'mainnet').at(-1).status, 'active');
  assert.deepEqual(buildUpgradeHistory(null, 'crosslink-testnet'), []);
});

test('server-rendered timeline requires a serving-node schedule before showing NU7 activation or remaining blocks', () => {
  const { UpgradeTimeline } = load('components/network/UpgradeTimeline.tsx', {
    '@/hooks/useApiQuery': { useApiQuery: () => ({ data: null, error: 'fixture unavailable' }) },
  });
  const render = (network, initialSnapshot) => renderToStaticMarkup(React.createElement(UpgradeTimeline, { network, initialSnapshot }));
  const announcement = render('mainnet', snapshot('mainnet', mainActivation + 100, null));
  assert.match(announcement, /Announced/);
  assert.doesNotMatch(announcement, /Active on this network|blocks? remaining/);
  assert.equal((announcement.match(/<button\b[^>]*aria-controls="upgrade-timeline-detail"/g) || []).length, 11);
  assert.equal((announcement.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(announcement, /aria-controls="upgrade-timeline-detail"/);
  assert.ok(!announcement.includes(`href="/block/${mainActivation}"`));
  const scheduled = render('mainnet', snapshot('mainnet', mainActivation - 1, mainActivation));
  assert.match(scheduled, /1 blocks? remaining/);
  assert.match(scheduled, /Current: NU6\.3/);
  assert.match(scheduled, /class="badge-icon"><svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(scheduled, />Upcoming<|>Now</);
  assert.doesNotMatch(scheduled, /Active on this network/);
  const active = render('mainnet', snapshot('mainnet', mainActivation, mainActivation));
  assert.match(active, /Active on this network/);
  assert.match(active, /class="badge [^"]*badge-green/);
  assert.match(active, /class="badge-icon"><svg[^>]*aria-hidden="true"/);
  assert.match(active, /last available observation/);
  const unavailable = render('testnet', null);
  assert.match(unavailable, /Node observation unavailable|Unscheduled/);
  assert.doesNotMatch(unavailable, /Active on this network|blocks? remaining/);
});

test('timeline hash selection replaces the single details panel and cleans up its navigation listener', () => {
  const previousWindow = global.window;
  const listeners = new Map();
  const location = { hash: '#nu62', hostname: 'zecblock.com', href: 'https://zecblock.com/network/upgrades?view=timeline#nu62' };
  const nextHistoryState = { __NA: true, tree: ['network', 'upgrades'] };
  const historyCalls = [];
  const effects = [];
  let selection;
  try {
    global.window = {
      location,
      history: { state: nextHistoryState, replaceState: (state, title, url) => {
        historyCalls.push({ state, title, url: String(url) });
        location.href = String(url);
        location.hash = new URL(url).hash;
      } },
      addEventListener: (event, listener) => listeners.set(event, listener),
      removeEventListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
    };
    const { UpgradeTimeline } = load('components/network/UpgradeTimeline.tsx', {
      react: { ...React,
        useState: initial => [selection ?? initial, value => { selection = value; }],
        useRef: () => ({ current: null }),
        useEffect: effect => effects.push(effect),
      },
      '@/hooks/useApiQuery': { useApiQuery: () => ({ data: null, error: null }) },
    });
    const tree = () => UpgradeTimeline({ network: 'mainnet', initialSnapshot: snapshot('mainnet', mainActivation - 1, mainActivation) });
    const render = () => renderToStaticMarkup(tree());
    render();
    const cleanup = effects[0]();
    const recovery = render();
    assert.match(recovery, /id="nu62"[^>]*aria-pressed="true"/);
    assert.equal((recovery.match(/id="upgrade-timeline-detail"/g) || []).length, 1);
    assert.match(recovery, /Orchard re-enabled/);
    assert.ok(recovery.includes('href="/turnstile?period=nu6.2"'));
    assert.doesNotMatch(recovery, /A shorter block target, with shorter expected confirmation waits/);
    function findMilestone(element, id) {
      if (Array.isArray(element)) return element.map(child => findMilestone(child, id)).find(Boolean);
      if (!React.isValidElement(element)) return null;
      if (element.type === 'button' && element.props.id === id) return element;
      return findMilestone(element.props.children, id);
    }
    findMilestone(tree(), 'nu7').props.onClick();
    assert.equal(selection, 'nu7');
    assert.equal(location.hash, '#nu7', 'copying the current URL must open the selected upgrade');
    assert.equal(historyCalls.length, 1, 'selection replaces the URL without adding a history entry');
    assert.strictEqual(historyCalls[0].state, nextHistoryState, 'preserve the Next.js router state');
    assert.equal(historyCalls[0].url, 'https://zecblock.com/network/upgrades?view=timeline#nu7');
    assert.match(render(), /id="nu7"[^>]*aria-pressed="true"/);
    location.hash = '#overwinter';
    listeners.get('hashchange')();
    const overwinter = render();
    assert.match(overwinter, /id="overwinter"[^>]*aria-pressed="true"/);
    assert.match(overwinter, /Introduced upgrade-aware transactions and peer rules/);
    assert.ok(!overwinter.includes('href="/turnstile?period=nu6.2"'));
    for (const milestone of buildUpgradeHistory(snapshot('mainnet', mainActivation - 1, mainActivation), 'mainnet')) {
      location.hash = `#${milestone.id}`;
      listeners.get('hashchange')();
      const html = render();
      const changes = buildUpgradeChanges(milestone.id, 'mainnet', milestone.status === 'active');
      assert.ok(html.includes(`href="${milestone.sourceUrl}"`), milestone.sourceUrl);
      const zipNumber = Number(milestone.sourceUrl.match(/zip-(\d+)$/)[1]);
      assertAction(html, milestone.sourceUrl, `Read the full ${milestone.label} upgrade specification, ZIP ${zipNumber}`);
      for (const change of changes) {
        assert.ok(html.includes(escaped(change.title)), change.title);
        assert.ok(!html.includes(escaped(change.description)), `${change.id}: technical detail belongs in the linked specification`);
      }
    }
    const previousSelection = selection;
    location.hash = '#unknown-upgrade';
    listeners.get('hashchange')();
    assert.equal(selection, previousSelection);
    cleanup();
    assert.equal(listeners.has('hashchange'), false);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('tracker loading uses bounded five-minute observations and preserves the directory on unavailable or wrong-network data', async () => {
  let response = stats('mainnet', mainActivation - 1, mainActivation);
  let fail = false;
  const calls = [];
  const { loadUpgradeTrackers } = load('lib/upgrade-trackers-server.ts', {
    './api-config': { getApiUrlForNetwork: network => `https://api.${network}.test` },
    './api-client': { readApiData: result => result.json() },
    './server-fetch': { fetchWithDeadline: async (url, init) => {
      calls.push({ url, init });
      if (fail) throw new Error('fixture unavailable');
      return { ok: true, json: async () => response };
    } },
  });
  const good = await loadUpgradeTrackers('mainnet');
  assert.equal(good.trackers[0].status, 'scheduled');
  assert.equal(calls[0].url, 'https://api.mainnet.test/v1/network/stats');
  assert.equal(calls[0].init.next.revalidate, 300);
  const wrongNetwork = await loadUpgradeTrackers('testnet');
  assert.equal(wrongNetwork.snapshot, null);
  assert.equal(wrongNetwork.trackers[0].status, 'unavailable');
  fail = true;
  const offline = await loadUpgradeTrackers('mainnet');
  assert.equal(offline.snapshot, null);
  assert.equal(offline.trackers.length, 3);
  assert.equal(offline.trackers[0].status, 'announced');
  const count = calls.length;
  assert.deepEqual(await loadUpgradeTrackers('crosslink-testnet'), { trackers: [], snapshot: null });
  assert.equal(calls.length, count, 'Crosslink does not request a standard-network observation');
});

test('upgrade hub metadata uses self canonicals and mainnet-only indexing without adding testnet sitemap URLs', async () => {
  const previous = process.env.NEXT_PUBLIC_NETWORK;
  try {
    for (const [network, base] of [['mainnet', 'https://zecblock.com'], ['testnet', 'https://testnet.zecblock.com'], ['crosslink-testnet', 'https://crosslink.zecblock.com']]) {
      process.env.NEXT_PUBLIC_NETWORK = network;
      const page = load('app/network/upgrades/page.tsx', { '@/lib/upgrade-trackers-server': { loadUpgradeTrackers: async () => ({ trackers: [], snapshot: null }) } });
      const metadata = await page.generateMetadata();
      assert.equal(metadata.alternates.canonical, `${base}/network/upgrades`);
      assert.equal(metadata.robots.index, network === 'mainnet');
      assert.equal(metadata.robots.follow, true);
      assert.match(metadata.title, /Zcash Network Upgrades/);
      assert.equal((metadata.title.match(/ZecBlock/g) || []).length, 1);
      assert.ok(metadata.description);
      assert.equal(metadata.openGraph.url, metadata.alternates.canonical);
      assert.equal(metadata.openGraph.title, metadata.title);
      assert.equal(metadata.openGraph.description, metadata.description);
      assert.ok(metadata.openGraph.images[0].url.startsWith(`${base}/`));
      assert.equal(metadata.openGraph.images[0].width, 1200);
      assert.equal(metadata.openGraph.images[0].height, 630);
      assert.ok(metadata.openGraph.images[0].alt);
      assert.equal(metadata.twitter.card, 'summary_large_image');
      assert.equal(metadata.twitter.title, metadata.title);
      const sitemap = load('app/sitemap.xml/route.ts').GET();
      if (network !== 'mainnet') {
        assert.equal(sitemap.status, 200);
        const xml = await sitemap.text();
        assert.ok(!xml.includes('/network/upgrades'));
        const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
        assert.deepEqual(locations, network === 'testnet' ? [`${base}/`] : []);
      }
    }
    const core = load('lib/sitemaps.ts').getStaticSitemapEntries('core', 'https://zecblock.com', []);
    assert.equal(core.filter(entry => entry.url === 'https://zecblock.com/network/upgrades').length, 1);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_NETWORK;
    else process.env.NEXT_PUBLIC_NETWORK = previous;
  }
});

test('upgrade hub server HTML has one selected NU7 summary, all milestone targets and matching collection structured data', async () => {
  for (const [network, base, activation] of [['mainnet', 'https://zecblock.com', mainActivation], ['testnet', 'https://testnet.zecblock.com', testActivation]]) {
    const data = { snapshot: snapshot(network, activation - 1, activation) };
    data.trackers = buildUpgradeTrackers(data.snapshot, network);
    const page = load('app/network/upgrades/page.tsx', {
      '@/lib/seo': { getNetwork: () => network, getBaseUrl: () => base },
      '@/lib/upgrade-trackers-server': { loadUpgradeTrackers: async () => data },
    });
    const html = renderToStaticMarkup(await page.default());
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /<h1[^>]*>Network upgrades<\/h1>/);
    assert.match(html, /href="\/network"/);
    const selected = data.trackers[0];
    const changes = buildUpgradeChanges('nu7', network);
    const history = buildUpgradeHistory(data.snapshot, network);
    assert.equal((html.match(/id="upgrade-timeline-detail"/g) || []).length, 1);
    assert.equal(html.split('25-second blocks and the Network Sustainability Mechanism.').length - 1, 1, 'the selected dashboard headline is rendered once');
    assert.ok(html.includes(`href="${selected.href}"`));
    for (const change of changes) {
      assert.ok(html.includes(escaped(change.title)), change.id);
      assert.ok(!html.includes(escaped(change.description)), `${change.id}: long descriptions stay out of the dashboard`);
    }
    assert.ok(html.includes(`href="${history.at(-1).sourceUrl}"`));
    for (const milestone of history) {
      assert.ok(html.includes(`#${milestone.height.toLocaleString('en-US')}`), String(milestone.height));
      assert.ok(html.includes(`id="${milestone.id}"`));
    }
    assert.ok(!html.includes(`href="/block/${activation}"`), 'pending activation heights are plain text');
    assert.ok(html.includes('href="/network#nu7-accounting"'));
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1])['@graph'];
    const collection = graph.find(item => item['@type'] === 'CollectionPage');
    assert.equal(collection.url, `${base}/network/upgrades`);
    assert.equal(collection.isPartOf['@id'], `${base}/#website`);
    assert.equal(collection.publisher['@id'], 'https://zecblock.com/#organization');
    const list = graph.find(item => item['@type'] === 'ItemList');
    assert.deepEqual(list.itemListElement.map(item => item.url), history.map(record => `${base}/network/upgrades#${record.id}`));
    data.snapshot = null;
    data.trackers = buildUpgradeTrackers(null, network);
    const offlineHtml = renderToStaticMarkup(await page.default());
    assert.match(offlineHtml, /Node observation unavailable/);
    assert.ok(!offlineHtml.includes(`href="/block/${activation}"`));
    data.snapshot = snapshot(network, activation + 100, activation);
    data.trackers = buildUpgradeTrackers(data.snapshot, network);
    const activeHtml = renderToStaticMarkup(await page.default());
    assert.ok(activeHtml.includes(`href="/block/${activation}"`));
    assert.ok(activeHtml.includes('href="/network#nu7-accounting"'));
    assert.ok(!activeHtml.includes('accounting begins at NU7'));
  }
});

test('unsupported Crosslink hub stops before loading observations', async () => {
  let calls = 0;
  const page = load('app/network/upgrades/page.tsx', {
    '@/lib/seo': { getNetwork: () => 'crosslink-testnet' },
    'next/navigation': { notFound: () => { throw new Error('fixture 404'); } },
    '@/lib/upgrade-trackers-server': { loadUpgradeTrackers: async () => { calls++; return { trackers: [], snapshot: null }; } },
  });
  await assert.rejects(page.default(), /fixture 404/);
  assert.equal(calls, 0);
});

test('Network hub renders a crawlable upgrades link only on supported networks', async () => {
  for (const network of ['mainnet', 'testnet', 'crosslink-testnet']) {
    const page = load('app/network/page.tsx', {
      './NetworkClient': { __esModule: true, default: () => null },
      '@/lib/seo': { getNetwork: () => network, getBaseUrl: () => 'https://example.test', getApiUrl: () => 'https://api.example.test' },
      '@/lib/block-speed-server': { loadBlockSpeedSnapshot: async () => ({ story: null }) },
      '@/lib/api-client': { readApiData: response => response.json() },
      '@/lib/server-fetch': { fetchWithDeadline: async () => ({ ok: true, json: async () => stats('mainnet', mainActivation - 1, mainActivation) }) },
    });
    const html = renderToStaticMarkup(await page.default());
    assert.equal(html.includes('href="/network/upgrades"'), network !== 'crosslink-testnet');
  }
});

test('Ask resolves the upgrades hub and its suggested follow-up to the matching static guide', () => {
  const { describePage } = require('../../lib/ask/pages');
  const { chatRequestSchema } = require('../../lib/ask/chat');
  const { guidedReply } = require('../api/v1/lib/ask-chat');
  const page = describePage('/network/upgrades');
  assert.equal(page.id, 'network_upgrades');
  assert.equal(page.topic, 'network_upgrades');
  assert.equal(page.title, 'Network Upgrades');
  for (const question of ['Explain this page', ...page.questions]) {
    const request = chatRequestSchema.parse({ page: page.id, question, context: null, history: [], locale: 'en' });
    const reply = guidedReply(request);
    assert.equal(reply.spec, null);
    assert.equal(reply.sources[0].id, 'network_upgrades');
    assert.equal(reply.sources[0].url, '/network/upgrades');
    assert.match(reply.answer, /[Aa]ctivation/);
    assert.match(reply.answer, /[Aa]nnouncement/);
    if (question === 'Explain this page') assert.match(reply.answer, /timeline/);
  }
});
