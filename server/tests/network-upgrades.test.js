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
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
    if (name.startsWith('@/') || name.startsWith('.')) {
      const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(filename), name);
      if (base.endsWith('.json')) return JSON.parse(fs.readFileSync(base, 'utf8'));
      return load(fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`, overrides);
    }
    return require(name);
  };
  new Function('module', 'exports', 'require', output)(module, module.exports, localRequire);
  return module.exports;
}
const config = load('lib/config.ts', { '@/lib/network': { getConfiguredNetwork: () => 'testnet' } });
const overrides = { './config': config, '@/lib/config': config };
const helpers = load('lib/network-upgrades.ts', overrides);
const { readUpgradeSnapshot, getBlockUpgrade, estimateBlockArrival } = helpers;
const activation = 4465026;
function stats(height = activation - 100, chain = 'test', nu7Height = activation, avgBlockTime = 9) {
  return { blockchain: { height }, mining: { avgBlockTime, schedule: {
    network: chain, source: 'node-upgrade-schedule', nu7Height,
    eras: [{ height: 0, seconds: 150 }, { height: chain === 'main' ? 653600 : 584000, seconds: 75 },
      ...(nu7Height == null ? [] : [{ height: nu7Height, seconds: 25 }])],
  } } };
}
function renderComponent(file, name, props, data, error = null) {
  const component = load(file, { ...overrides, '@/lib/network-upgrades': helpers,
    '@/hooks/useApiQuery': { useApiQuery: () => ({ data, error }) },
  })[name];
  return renderToStaticMarkup(React.createElement(component, props));
}

test('activation identity requires a valid serving-node schedule for this network', () => {
  const snapshot = readUpgradeSnapshot(stats(), 'testnet');
  assert.equal(getBlockUpgrade(activation, 'testnet', snapshot).name, 'NU7 activation');
  assert.equal(getBlockUpgrade(activation - 1, 'testnet', snapshot), null);
  for (const input of [null, {}, stats(null), stats(-1), stats(activation, 'main'), { ...stats(), mining: { schedule: { ...stats().mining.schedule, nu7Height: undefined } } },
    { ...stats(), mining: { schedule: { ...stats().mining.schedule, source: 'guess' } } },
    { ...stats(), mining: { schedule: { ...stats().mining.schedule, eras: [] } } }]) {
    assert.equal(readUpgradeSnapshot(input, 'testnet'), null);
  }
  assert.equal(readUpgradeSnapshot(stats(), 'crosslink-testnet'), null);
  const main = readUpgradeSnapshot(stats(3503108, 'main', null), 'mainnet');
  assert.equal(main.schedule.nu7Height, null);
  assert.equal(getBlockUpgrade(activation, 'mainnet', main), null);
  assert.equal(getBlockUpgrade(4134000, 'mainnet', main), null);
  assert.equal(getBlockUpgrade(3459350, 'testnet', snapshot), null);
  assert.equal(getBlockUpgrade(4134000, 'testnet', snapshot).name, 'Ironwood (NU6.3)');
});

test('time is an observation-based estimate and follows announced spacing changes', () => {
  const snapshot = readUpgradeSnapshot(stats(), 'testnet');
  assert.equal(estimateBlockArrival(snapshot, activation).seconds, 900);
  assert.equal(estimateBlockArrival(snapshot, activation + 3).seconds, 909);
  assert.equal(estimateBlockArrival(snapshot, activation).basis, 'recent block times');
  const targetOnly = readUpgradeSnapshot(stats(activation - 100, 'test', activation, null), 'testnet');
  assert.equal(estimateBlockArrival(targetOnly, activation).seconds, 7500);
  assert.equal(estimateBlockArrival(targetOnly, activation).basis, 'target spacing');
  assert.equal(estimateBlockArrival(null, activation), null);
  assert.equal(estimateBlockArrival(snapshot, activation - 101), null);
});

test('announcement time is readable and explicitly approximate', () => {
  assert.equal(helpers.formatUpgradeTime(86400 * 4.3), '4 days');
  assert.equal(helpers.formatUpgradeTime(86400), '1 day');
  assert.equal(helpers.formatUpgradeTime(3600 * 7.2), '7 hours');
  assert.equal(helpers.formatUpgradeTime(45), '1 minute');
});

test('future activation server HTML has one meaningful H1, full height and seeded countdown', () => {
  const html = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: activation, currentHeight: activation - 100, initialStats: stats(),
  }, stats());
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(html, /NU7 Activation.*4,465,026/);
  assert.match(html, /NU7 ACTIVATION/);
  assert.match(html, /About 15 minutes/);
  assert.match(html, /recent block times/);
  assert.match(html, /100<\/span> blocks/);
  const unavailable = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: activation, currentHeight: activation - 100,
  }, stats(), 'Offline');
  assert.match(unavailable, /time estimate is paused/);
  assert.match(unavailable, /Time unavailable/);
  assert.match(unavailable, /NU7 ACTIVATION/);
});

test('site banner has remaining blocks/time, disappears at activation and returns after a reorg', () => {
  const file = 'components/GovernanceBanner.tsx';
  for (const height of [activation - 100, activation - 1, activation - 2]) {
    const html = renderComponent(file, 'GovernanceBanner', {}, stats(height));
    assert.match(html, /NU7 activation countdown/);
    assert.match(html, />NU7<.*in about .*blocks? to go/);
    assert.match(html, /Dismiss NU7 activation countdown/);
    assert.match(html, /href="\/block\/4465026"/);
  }
  for (const data of [stats(activation), stats(activation + 1), stats(3503108, 'main', null), null]) {
    assert.equal(renderComponent(file, 'GovernanceBanner', {}, data), '');
  }
  assert.equal(renderComponent(file, 'GovernanceBanner', {}, stats(), 'Offline'), '');
});

test('mined activation tag persists and orphan blocks never claim activation', () => {
  const file = 'app/block/[height]/components/NetworkUpgradeBanner.tsx';
  const props = { data: { height: activation, isOrphaned: false } };
  const html = renderComponent(file, 'NetworkUpgradeBanner', props, stats(activation + 10));
  assert.match(html, /NU7 activation/);
  assert.match(html, />ACTIVATED</);
  const orphan = renderComponent(file, 'NetworkUpgradeBanner', { data: { ...props.data, isOrphaned: true } }, stats(activation + 10));
  assert.match(orphan, />ORPHANED</);
  assert.match(orphan, /not the canonical activation block/);
  assert.doesNotMatch(orphan, />ACTIVATED</);
  const reached = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: activation, currentHeight: activation - 100,
  }, stats(activation));
  assert.match(reached, /Block #4,465,026 has been reached/);
  assert.match(reached, /check the latest status/);
  assert.doesNotMatch(reached, /has activated/);
});

test('future activation metadata and JSON-LD use the same network, height and noindex identity', async () => {
  const seo = {
    getNetwork: () => 'testnet', getBaseUrl: () => 'https://testnet.zecblock.com',
    getApiUrl: () => 'https://api.invalid', getBlockResolution: async () => ({ state: 'absent' }),
    formatNumber: value => value.toLocaleString('en-US'), buildPageMetadata: options => options,
  };
  const imports = { ...overrides, '@/lib/seo': seo, '@/lib/network-upgrades': helpers,
    '@/lib/network-upgrades-server': { getUpgradeStats: async () => stats() },
    '@/lib/api-client': { readApiData: async () => ({ height: activation - 100 }) },
    '@/lib/server-fetch': { fetchWithDeadline: async () => ({ ok: true }) },
    '@/lib/isr-fallback': {}, './BlockPageClient': { __esModule: true, default: () => null },
    './FutureBlockView': { FutureBlockView: () => null },
  };
  const layout = load('app/block/[height]/layout.tsx', imports);
  const params = Promise.resolve({ height: String(activation) });
  const metadata = await layout.generateMetadata({ params });
  assert.match(metadata.title, /NU7 Activation on Zcash testnet #4,465,026/);
  assert.equal(metadata.index, false);
  assert.notEqual(metadata.canonical, false);
  assert.equal(metadata.path, '/block/4465026');
  const page = load('app/block/[height]/page.tsx', imports);
  const html = renderToStaticMarkup(await page.default({ params }));
  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.equal(schema.url, 'https://testnet.zecblock.com/block/4465026');
  assert.equal(schema.mainEntity.identifier.value, String(activation));
  assert.match(schema.description, /pending.*100 blocks/);
  assert.equal(schema.isPartOf['@id'], 'https://testnet.zecblock.com/#website');
});
