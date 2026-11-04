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
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => {
      const htmlProps = { ...props };
      delete htmlProps.prefetch;
      return React.createElement('a', htmlProps, children);
    } };
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
const { readUpgradeSnapshot, getBlockUpgrade, estimateBlockArrival, getFutureBlockUpgrade,
  getPendingNu7Upgrade, estimateBlockArrivalDate, ANNOUNCED_MAINNET_NU7 } = helpers;
const activation = 4465026;
const announcedHeight = 3543405;
const headerTimestamp = Date.parse('2026-11-04T23:59:30Z') / 1000;
function stats(height = activation - 100, chain = 'test', nu7Height = activation, avgBlockTime = 9, latestBlockTime = headerTimestamp) {
  return { blockchain: { height, latestBlockTime }, mining: { avgBlockTime, schedule: {
    network: chain, source: 'node-upgrade-schedule', nu7Height,
    eras: [{ height: 0, seconds: 150 }, { height: chain === 'main' ? 653600 : 584000, seconds: 75 },
      ...(nu7Height == null ? [] : [{ height: nu7Height, seconds: 25 }])],
  } } };
}
function renderComponent(file, name, props, data, error = null, network = 'testnet') {
  const networkConfig = load('lib/config.ts', { '@/lib/network': { getConfiguredNetwork: () => network } });
  const component = load(file, { ...overrides, '@/lib/config': networkConfig, './config': networkConfig,
    '@/lib/network-upgrades': helpers,
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

test('every canonical historical activation uses the shared network-specific history', () => {
  const { HISTORICAL_UPGRADES } = load('lib/upgrade-history-data.ts');
  assert.equal(HISTORICAL_UPGRADES.length, 10);
  for (const network of ['mainnet', 'testnet']) {
    const other = network === 'mainnet' ? 'testnet' : 'mainnet';
    for (const historical of HISTORICAL_UPGRADES) {
      const upgrade = getBlockUpgrade(historical.heights[network], network, null);
      assert.equal(upgrade.upgradeId, historical.id);
      assert.equal(upgrade.link, `/network/upgrades#${historical.id}`);
      assert.equal(upgrade.description, historical.summary);
      assert.equal(getBlockUpgrade(historical.heights[other], network, null), null);
      assert.equal(getBlockUpgrade(historical.heights[network] - 1, network, null), null);
    }
  }
  assert.equal(getBlockUpgrade(1687104, 'mainnet', null).upgradeId, 'nu5');
  assert.equal(getBlockUpgrade(1599200, 'testnet', null), null, 'rolled-back NU5 height is not a canonical activation');
  for (const height of [-1, NaN, Infinity, 1.5, 0]) assert.equal(getBlockUpgrade(height, 'mainnet', null), null);
});

test('historical activation banners render hub links without needing a live node snapshot', () => {
  const { HISTORICAL_UPGRADES } = load('lib/upgrade-history-data.ts');
  const file = 'app/block/[height]/components/NetworkUpgradeBanner.tsx';
  for (const network of ['mainnet', 'testnet']) {
    for (const historical of HISTORICAL_UPGRADES) {
      const html = renderComponent(file, 'NetworkUpgradeBanner', {
        data: { height: historical.heights[network], isOrphaned: false },
      }, null, 'Offline', network);
      assert.match(html, />ACTIVATED</);
      assert.ok(html.includes(`href="/network/upgrades#${historical.id}"`));
      assert.match(html, /ZIP-\d+/);
      assert.doesNotMatch(html, /ORPHANED|SCHEDULED/);
    }
  }
});

test('all orphaned activation banners distinguish the canonical activation block', () => {
  const { HISTORICAL_UPGRADES } = load('lib/upgrade-history-data.ts');
  const file = 'app/block/[height]/components/NetworkUpgradeBanner.tsx';
  for (const network of ['mainnet', 'testnet']) {
    for (const historical of HISTORICAL_UPGRADES) {
      const html = renderComponent(file, 'NetworkUpgradeBanner', {
        data: { height: historical.heights[network], isOrphaned: true },
      }, null, null, network);
      assert.match(html, />ORPHANED</);
      assert.match(html, /not the canonical activation block/);
      assert.doesNotMatch(html, />ACTIVATED</);
    }
  }
});

test('activation banners retain strong scoped trackers and mainnet snapshot milestones', () => {
  assert.equal(getBlockUpgrade(3428143, 'mainnet', null).trackerLink.href, '/ironwood');
  assert.equal(getBlockUpgrade(3364600, 'mainnet', null).trackerLink.href, '/turnstile?period=nu6.2');
  assert.match(getBlockUpgrade(3364600, 'mainnet', null).trackerLink.label, /Related flows since June 1, 2026/);
  assert.equal(getBlockUpgrade(653600, 'mainnet', null).trackerLink.href, '/network/block-speed');
  const snapshot = getBlockUpgrade(3459350, 'mainnet', null);
  assert.equal(snapshot.badge, 'SNAPSHOT');
  assert.equal(snapshot.link, '/governance/nu7');
  assert.equal(snapshot.upgradeId, undefined);
  assert.equal(getBlockUpgrade(3459350, 'testnet', null), null);
  for (const height of [1687104, 3428143, activation, announcedHeight]) {
    assert.equal(getBlockUpgrade(height, 'crosslink-testnet', readUpgradeSnapshot(stats(), 'testnet')), null);
  }
  const file = 'app/block/[height]/components/NetworkUpgradeBanner.tsx';
  assert.equal(renderComponent(file, 'NetworkUpgradeBanner', { data: { height: 1687104 } }, null, null, 'crosslink-testnet'), '');
});

test('node-authoritative NU7 banners link to the hub and label pending activation accurately', () => {
  const file = 'app/block/[height]/components/NetworkUpgradeBanner.tsx';
  const data = { height: activation, isOrphaned: false };
  const pending = renderComponent(file, 'NetworkUpgradeBanner', { data }, stats(activation - 1));
  assert.match(pending, />SCHEDULED</);
  assert.match(pending, /is scheduled to begin/);
  assert.match(pending, /href="\/network\/upgrades#nu7"/);
  assert.match(pending, /href="\/network\/block-speed"/);
  assert.doesNotMatch(pending, />ACTIVATED</);
  for (const error of [null, 'Offline']) {
    assert.equal(renderComponent(file, 'NetworkUpgradeBanner', { data }, stats(activation + 1, 'main'), error), '');
  }
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

test('mainnet announcement is separate from node-confirmed and mined activation authority', () => {
  assert.deepEqual(ANNOUNCED_MAINNET_NU7, {
    height: announcedHeight, date: '2026-11-05', dateLabel: 'around November 5, 2026',
    sourceUrl: 'https://zakura.com/nu7/',
  });
  const unscheduled = readUpgradeSnapshot(stats(announcedHeight - 100, 'main', null), 'mainnet');
  for (const snapshot of [unscheduled, null]) {
    const preview = getFutureBlockUpgrade(announcedHeight, 'mainnet', snapshot);
    assert.equal(preview.authority, 'announcement');
    assert.equal(preview.badge, 'ANNOUNCED');
    assert.equal(preview.announcedDate, '2026-11-05');
    assert.equal(preview.link, 'https://zakura.com/nu7/');
    assert.match(preview.description, /announced.*3,543,405.*around November 5, 2026/);
    assert.match(preview.description, /pending confirmation from the serving node/);
    assert.equal(getBlockUpgrade(announcedHeight, 'mainnet', snapshot), null);
    assert.equal(getFutureBlockUpgrade(announcedHeight + 1, 'mainnet', snapshot), null);
  }
  assert.equal(unscheduled.schedule.nu7Height, null);
  assert.deepEqual(unscheduled.schedule.eras, [{ height: 0, seconds: 150 }, { height: 653600, seconds: 75 }]);
  assert.equal(getFutureBlockUpgrade(3459350, 'mainnet', unscheduled).authority, 'historical');
  for (const network of ['testnet', 'crosslink-testnet']) {
    assert.equal(getFutureBlockUpgrade(announcedHeight, network, null), null);
    assert.equal(getPendingNu7Upgrade(network, null), null);
  }
});

test('the serving node schedule takes precedence even when its NU7 height conflicts with the announcement', () => {
  for (const nodeHeight of [announcedHeight, announcedHeight - 50, announcedHeight + 50]) {
    const snapshot = readUpgradeSnapshot(stats(announcedHeight - 100, 'main', nodeHeight), 'mainnet');
    const pending = getPendingNu7Upgrade('mainnet', snapshot);
    assert.equal(pending.height, nodeHeight);
    assert.equal(pending.upgrade.authority, 'node');
    assert.equal(pending.upgrade.name, 'NU7 activation');
    assert.equal(pending.upgrade.announcedDate, undefined);
    if (nodeHeight !== announcedHeight) assert.equal(getFutureBlockUpgrade(announcedHeight, 'mainnet', snapshot), null);
    for (const tip of [nodeHeight, nodeHeight + 1]) {
      assert.equal(getPendingNu7Upgrade('mainnet', readUpgradeSnapshot(stats(tip, 'main', nodeHeight), 'mainnet')), null);
    }
  }
  const testnet = readUpgradeSnapshot(stats(), 'testnet');
  assert.equal(getFutureBlockUpgrade(activation, 'testnet', testnet).authority, 'node');
  assert.equal(getPendingNu7Upgrade('testnet', testnet).height, activation);
  assert.equal(getFutureBlockUpgrade(announcedHeight, 'testnet', testnet), null);
});

test('announced pending state disappears at the announced block without claiming activation', () => {
  assert.equal(getPendingNu7Upgrade('mainnet', null).upgrade.authority, 'announcement');
  const pending = getPendingNu7Upgrade('mainnet', readUpgradeSnapshot(stats(announcedHeight - 1, 'main', null), 'mainnet'));
  assert.equal(pending.height, announcedHeight);
  assert.equal(pending.upgrade.authority, 'announcement');
  for (const tip of [announcedHeight, announcedHeight + 1]) {
    const snapshot = readUpgradeSnapshot(stats(tip, 'main', null), 'mainnet');
    assert.equal(getPendingNu7Upgrade('mainnet', snapshot), null);
    assert.equal(getBlockUpgrade(announcedHeight, 'mainnet', snapshot), null);
    assert.equal(getFutureBlockUpgrade(announcedHeight, 'mainnet', snapshot).authority, 'announcement');
  }
});

test('arrival dates use the verified block header and explicit UTC rather than the viewer clock', () => {
  const snapshot = readUpgradeSnapshot(stats(), 'testnet');
  assert.equal(snapshot.tipTimestamp, headerTimestamp);
  const originalNow = Date.now;
  const originalZone = process.env.TZ;
  try {
    Date.now = () => { throw new Error('Viewer wall clock must not anchor a block estimate'); };
    process.env.TZ = 'Pacific/Honolulu';
    const date = estimateBlockArrivalDate(snapshot, activation);
    assert.equal(date.dateTime, '2026-11-05T00:14:30.000Z');
    assert.match(date.label, /November 5, 2026.*00:14.*UTC/);
    const targetOnly = readUpgradeSnapshot(stats(activation - 100, 'test', activation, null), 'testnet');
    assert.equal(estimateBlockArrivalDate(targetOnly, activation).dateTime, '2026-11-05T02:04:30.000Z');
  } finally {
    Date.now = originalNow;
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});

test('missing or invalid header timestamps omit date estimates without discarding valid upgrade identity', () => {
  for (const timestamp of [null, undefined, 0, -1, 1.25, '1793836770', NaN, Infinity, 8640000000000]) {
    const data = stats();
    data.blockchain.latestBlockTime = timestamp;
    const snapshot = readUpgradeSnapshot(data, 'testnet');
    assert.equal(snapshot.tipTimestamp, null);
    assert.equal(getBlockUpgrade(activation, 'testnet', snapshot).name, 'NU7 activation');
    assert.equal(estimateBlockArrivalDate(snapshot, activation), null);
  }
  assert.equal(estimateBlockArrivalDate(null, activation), null);
  assert.equal(estimateBlockArrivalDate(readUpgradeSnapshot(stats(), 'testnet'), activation - 101), null);
});

test('future activation server HTML has one meaningful H1, full height and seeded countdown', () => {
  const html = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: activation, currentHeight: activation - 100, initialStats: stats(),
  }, stats());
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(html, /NU7 Activation.*4,465,026/);
  assert.match(html, /NU7 ACTIVATION/);
  // NU7 ticks toward the estimate on the client; server HTML holds stable placeholders.
  assert.match(html, /role="timer"/);
  assert.match(html, /recent block times/);
  assert.match(html, /100<\/span> blocks/);
  assert.match(html, /<time dateTime="2026-11-05T00:14:30.000Z"/i);
  assert.match(html, /November 5, 2026.*00:14.*UTC/);
  const unavailable = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: activation, currentHeight: activation - 100,
  }, stats(), 'Offline');
  assert.match(unavailable, /time estimate is paused/);
  assert.match(unavailable, /Time unavailable/);
  assert.match(unavailable, /NU7 ACTIVATION/);
  assert.doesNotMatch(unavailable, /Estimated arrival:|2026-11-05T00:14:30.000Z/);
});

test('chain progress uses the last verified height for announced, scheduled and ordinary future blocks', () => {
  const file = 'app/block/[height]/FutureBlockView.tsx';
  for (const [targetHeight, nu7Height, remaining] of [
    [announcedHeight, null, 100],
    [announcedHeight, announcedHeight, 100],
    [announcedHeight + 1, null, 101],
  ]) {
    const data = stats(announcedHeight - 100, 'main', nu7Height);
    for (const error of [null, 'Offline']) {
      const html = renderComponent(file, 'FutureBlockView', {
        targetHeight, currentHeight: 1,
      }, data, error, 'mainnet');
      if (targetHeight === announcedHeight) {
        // NU7 progress spans the NU6.3 → NU7 epoch rather than all of chain history.
        assert.match(html, />NU6\.3 → NU7</);
        assert.match(html, />99\.91%</);
        assert.match(html, /role="progressbar" aria-label="Progress from NU6\.3 to NU7" aria-valuemin="3428143"/);
      } else {
        assert.match(html, />Chain progress</);
        assert.match(html, /99\.9971%/);
        assert.match(html, /role="progressbar" aria-label="Chain progress" aria-valuemin="0"/);
      }
      assert.match(html, new RegExp(`aria-valuemax="${targetHeight}" aria-valuenow="3543305"`));
      assert.match(html, new RegExp(`aria-valuetext="Block 3,543,305 of ${targetHeight.toLocaleString('en-US')}; ${remaining} blocks remaining"`));
      if (error) assert.match(html, /time estimate is paused/);
    }
  }
});

test('chain progress handles genesis and invalid ranges without an invalid progressbar', () => {
  const file = 'app/block/[height]/FutureBlockView.tsx';
  const zero = renderComponent(file, 'FutureBlockView', {
    targetHeight: 200, currentHeight: 0,
  }, null, 'Offline');
  assert.match(zero, /0\.0000%/);
  assert.match(zero, /aria-valuemax="200" aria-valuenow="0"/);
  assert.match(zero, /style="width:0%"/);
  for (const [targetHeight, currentHeight] of [[0, 0], [-1, 0], [Infinity, 0], [200, -1]]) {
    const html = renderComponent(file, 'FutureBlockView', { targetHeight, currentHeight }, null, 'Offline');
    assert.match(html, />Chain progress</);
    assert.doesNotMatch(html, /role="progressbar"|style="width:(?:NaN|Infinity|-)/);
  }
});

test('chain progress reserves displayed completion for reaching the target and clamps its accessible value', () => {
  const file = 'app/block/[height]/FutureBlockView.tsx';
  const almost = renderComponent(file, 'FutureBlockView', {
    targetHeight: announcedHeight, currentHeight: announcedHeight - 1,
  }, null, 'Offline', 'mainnet');
  assert.match(almost, />99\.99%</);
  assert.doesNotMatch(almost, />100\.00%</);
  const reached = renderComponent(file, 'FutureBlockView', {
    targetHeight: 200, currentHeight: 201,
  }, null, 'Offline');
  assert.match(reached, /100\.0000%/);
  assert.match(reached, /aria-valuemax="200" aria-valuenow="200"/);
  assert.match(reached, /style="width:100%"/);
});

test('announced mainnet future preview renders sourced facts and one approximate official date', () => {
  const file = 'app/block/[height]/FutureBlockView.tsx';
  const data = stats(announcedHeight - 100, 'main', null);
  const props = { targetHeight: announcedHeight, currentHeight: announcedHeight - 100, initialStats: data };
  for (const input of [{ data, error: null }, { data, error: 'Offline' }, { data: null, error: 'Offline' }]) {
    const html = renderComponent(file, 'FutureBlockView', props, input.data, input.error, 'mainnet');
    assert.equal((html.match(/<h1/g) || []).length, 1);
    assert.match(html, /NU7 Mainnet Preview.*3,543,405/);
    assert.match(html, />ANNOUNCED</);
    assert.match(html, /href="https:\/\/zakura.com\/nu7\/"/);
    assert.match(html, /pending confirmation from the serving node/);
    assert.match(html, /around November 5, 2026/);
    assert.match(html, /<time dateTime="2026-11-05"/i);
    assert.equal((html.match(/<time\b/gi) || []).length, 1);
    assert.doesNotMatch(html, />ACTIVATED<|>NU7 ACTIVATION<|Estimated arrival:/);
    if (input.error) {
      assert.match(html, /time estimate is paused/);
      assert.match(html, /Time unavailable/);
      assert.doesNotMatch(html, /About 15 minutes|2026-11-05T00:14:30.000Z/);
    } else {
      assert.match(html, /About 15 minutes/);
    }
  }
});

test('announced site banner keeps its clickable block/date during an API error and stops at the known height', () => {
  const file = 'components/GovernanceBanner.tsx';
  const data = stats(announcedHeight - 100, 'main', null);
  for (const input of [{ data, error: null }, { data, error: 'Offline' }, { data: null, error: 'Offline' }]) {
    const html = renderComponent(file, 'GovernanceBanner', {}, input.data, input.error, 'mainnet');
    assert.match(html, /NU7 announced mainnet upgrade/);
    assert.match(html, /href="\/block\/3543405"/);
    assert.match(html, /NU7 announced.*around November 5, 2026/);
    assert.match(html, /#3,543,405/);
    assert.doesNotMatch(html, /NU7 activation countdown|ACTIVATED/);
    if (input.error) {
      assert.match(html, /Live progress unavailable/);
      assert.doesNotMatch(html, /100<\/span> blocks/);
    } else {
      assert.match(html, /100<\/span> blocks/);
    }
  }
  for (const height of [announcedHeight, announcedHeight + 1]) {
    const reached = stats(height, 'main', null);
    assert.equal(renderComponent(file, 'GovernanceBanner', {}, reached, null, 'mainnet'), '');
    assert.equal(renderComponent(file, 'GovernanceBanner', {}, reached, 'Offline', 'mainnet'), '');
  }
  for (const network of ['testnet', 'crosslink-testnet']) {
    assert.equal(renderComponent(file, 'GovernanceBanner', {}, null, null, network), '');
  }
});

test('node-confirmed UI replaces announcement copy and a conflicting node height wins the banner link', () => {
  const data = stats(announcedHeight - 100, 'main', announcedHeight);
  const html = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: announcedHeight, currentHeight: announcedHeight - 100,
  }, data, null, 'mainnet');
  assert.match(html, /NU7 Activation.*3,543,405/);
  assert.match(html, />NU7 ACTIVATION</);
  assert.match(html, /Estimated arrival:/);
  assert.doesNotMatch(html, /NU7 Mainnet Preview|>ANNOUNCED<|Announced date:/);
  const changedHeight = announcedHeight + 50;
  const conflicting = stats(announcedHeight - 100, 'main', changedHeight);
  const banner = renderComponent('components/GovernanceBanner.tsx', 'GovernanceBanner', {}, conflicting, null, 'mainnet');
  assert.match(banner, /NU7 activation countdown/);
  assert.match(banner, /href="\/block\/3543455"/);
  assert.doesNotMatch(banner, /href="\/block\/3543405"|NU7 announced/);
  const oldHeight = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: announcedHeight, currentHeight: announcedHeight - 100,
  }, conflicting, null, 'mainnet');
  assert.match(oldHeight, /Zcash Block.*3,543,405/);
  assert.doesNotMatch(oldHeight, /NU7 Mainnet Preview|>ANNOUNCED<|>NU7 ACTIVATION</);
});

test('reaching the announced height remains unverified and mined banners never inherit announcement authority', () => {
  const data = stats(announcedHeight, 'main', null);
  const reached = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: announcedHeight, currentHeight: announcedHeight - 100,
  }, data, null, 'mainnet');
  assert.match(reached, /Block #3,543,405 has been reached/);
  assert.match(reached, /Activation is unverified/);
  assert.doesNotMatch(reached, />ACTIVATED<|has activated|has reached its scheduled block/);
  for (const isOrphaned of [false, true]) {
    const mined = renderComponent('app/block/[height]/components/NetworkUpgradeBanner.tsx', 'NetworkUpgradeBanner', {
      data: { height: announcedHeight, isOrphaned },
    }, stats(announcedHeight + 10, 'main', null), null, 'mainnet');
    assert.equal(mined, '');
  }
});

test('announcement UI is mainnet-only and unrelated future blocks keep the generic preview', () => {
  for (const network of ['testnet', 'crosslink-testnet']) {
    const data = network === 'testnet' ? stats(announcedHeight - 100, 'test', null) : null;
    const html = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
      targetHeight: announcedHeight, currentHeight: announcedHeight - 100,
    }, data, null, network);
    assert.match(html, /Zcash Block.*3,543,405/);
    assert.doesNotMatch(html, /NU7 Mainnet Preview|>ANNOUNCED<|around November 5/);
  }
  const generic = renderComponent('app/block/[height]/FutureBlockView.tsx', 'FutureBlockView', {
    targetHeight: announcedHeight + 1, currentHeight: announcedHeight - 100,
  }, stats(announcedHeight - 100, 'main', null), null, 'mainnet');
  assert.match(generic, /Zcash Block.*3,543,406/);
  assert.match(generic, /Estimated arrival:/);
  assert.doesNotMatch(generic, /NU7 Mainnet Preview|>ANNOUNCED<|Announced date:/);
});

test('site banner has remaining blocks/time, disappears at activation and returns after a reorg', () => {
  const file = 'components/GovernanceBanner.tsx';
  for (const height of [activation - 100, activation - 1, activation - 2]) {
    const html = renderComponent(file, 'GovernanceBanner', {}, stats(height));
    assert.match(html, /NU7 activation countdown/);
    assert.match(html, /NU7 arrives in about .*blocks? to go/);
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

test('future server snapshots preserve the block-header timestamp used to seed UTC estimates', async () => {
  const data = stats();
  const server = load('lib/network-upgrades-server.ts', {
    ...overrides,
    './seo': { getNetwork: () => 'testnet', getApiUrl: () => 'https://api.invalid' },
    './api-client': { readApiData: async () => data },
    './server-fetch': { fetchWithDeadline: async () => ({ ok: true }) },
    './network-upgrades': helpers,
  });
  const seed = await server.getUpgradeStats();
  assert.equal(seed.blockchain.latestBlockTime, headerTimestamp);
  assert.equal(estimateBlockArrivalDate(readUpgradeSnapshot(seed, 'testnet'), activation).dateTime, '2026-11-05T00:14:30.000Z');
});

function futurePageImports(network, data, tip) {
  const base = network === 'mainnet' ? 'https://zecblock.com'
    : network === 'testnet' ? 'https://testnet.zecblock.com' : 'https://crosslink.zecblock.com';
  const seo = {
    getNetwork: () => network, getBaseUrl: () => base,
    getApiUrl: () => 'https://api.invalid', getBlockResolution: async () => ({ state: 'absent' }),
    formatNumber: value => value.toLocaleString('en-US'), buildPageMetadata: options => options,
  };
  return { ...overrides, '@/lib/seo': seo, '@/lib/network-upgrades': helpers,
    '@/lib/network-upgrades-server': { getUpgradeStats: async () => data },
    '@/lib/api-client': { readApiData: async () => ({ height: tip }) },
    '@/lib/server-fetch': { fetchWithDeadline: async () => ({ ok: true }) },
    '@/lib/isr-fallback': {}, './BlockPageClient': { __esModule: true, default: () => null },
    './FutureBlockView': { FutureBlockView: () => null },
  };
}

test('announced preview metadata and JSON-LD remain sourced, approximate and noindex when node scheduling is absent', async () => {
  for (const data of [stats(announcedHeight - 100, 'main', null), null]) {
    const imports = futurePageImports('mainnet', data, announcedHeight - 100);
    const params = Promise.resolve({ height: String(announcedHeight) });
    const metadata = await load('app/block/[height]/layout.tsx', imports).generateMetadata({ params });
    assert.match(metadata.title, /NU7 Mainnet Preview #3,543,405/);
    assert.match(metadata.description, /announced.*around November 5, 2026/);
    assert.match(metadata.description, /pending confirmation from the serving node/);
    assert.equal(metadata.index, false);
    assert.equal(metadata.path, '/block/3543405');
    assert.notEqual(metadata.canonical, false);
    assert.doesNotMatch(metadata.description, /has activated|NU7 begins/);
    const page = await load('app/block/[height]/page.tsx', imports).default({ params });
    const html = renderToStaticMarkup(page);
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    assert.equal(schema.url, 'https://zecblock.com/block/3543405');
    assert.equal(schema.mainEntity.identifier.value, '3543405');
    assert.match(schema.name, /NU7 announcement.*3,543,405/);
    assert.match(schema.description, /Zcash mainnet.*pending.*100 blocks/);
    assert.match(schema.description, /announced.*around November 5, 2026/);
    assert.doesNotMatch(schema.description, /has activated|NU7 begins/);
    assert.equal(schema.isPartOf['@id'], 'https://zecblock.com/#website');
  }
});

test('announcement metadata cannot leak onto testnet, Crosslink or a conflicting serving-node height', async () => {
  const cases = [
    { network: 'testnet', data: stats(announcedHeight - 100, 'test', null), host: 'https://testnet.zecblock.com' },
    { network: 'crosslink-testnet', data: null, host: 'https://crosslink.zecblock.com' },
    { network: 'mainnet', data: stats(announcedHeight - 100, 'main', announcedHeight + 50), host: 'https://zecblock.com' },
  ];
  for (const { network, data, host } of cases) {
    const imports = futurePageImports(network, data, announcedHeight - 100);
    const params = Promise.resolve({ height: String(announcedHeight) });
    const metadata = await load('app/block/[height]/layout.tsx', imports).generateMetadata({ params });
    assert.match(metadata.title, /Zcash Block #3,543,405/);
    assert.doesNotMatch(metadata.title, /NU7 Mainnet Preview|NU7 Activation/);
    assert.equal(metadata.index, false);
    const html = renderToStaticMarkup(await load('app/block/[height]/page.tsx', imports).default({ params }));
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    assert.equal(schema.url, `${host}/block/3543405`);
    assert.equal(schema.mainEntity.identifier.value, '3543405');
    assert.doesNotMatch(schema.name, /NU7/);
    assert.doesNotMatch(schema.description, /around November 5|announced NU7|NU7 begins/);
  }
});
