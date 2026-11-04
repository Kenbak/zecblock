const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('lib/navigation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const navigationModule = { exports: {} };
new Function('module', 'exports', code)(navigationModule, navigationModule.exports);
const { getNavigation, getActiveNavigationHref } = navigationModule.exports;

test('every menu destination has a page and bypasses retired route aliases', () => {
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const items = getNavigation(network, 'footer').flatMap(category => category.items);
    assert.equal(new Set(items.map(item => item.href)).size, items.length);
    for (const item of items) {
      assert.ok(fs.existsSync(`app${item.href}/page.tsx`), `${network}: ${item.href}`);
      assert.ok(item.label && item.desc);
      assert.ok(!['/migration', '/flows', '/privacy-stats', '/privacy/risks', '/blend-check', '/swap'].includes(item.href));
    }
  }
});

test('network-specific navigation keeps unsupported destinations out', () => {
  const links = network => getNavigation(network).flatMap(category => category.items.map(item => item.href));
  for (const path of ['/crosschain', '/zodl', '/usage-clock', '/governance']) {
    assert.ok(links('mainnet').includes(path));
    assert.ok(!links('testnet').includes(path));
    assert.ok(!links('crosslink').includes(path));
  }
  for (const path of ['/chain', '/validators', '/bootstrap', '/fork-monitor', '/learn/crosslink']) {
    assert.ok(links('crosslink').includes(path));
    assert.ok(!links('mainnet').includes(path));
    assert.ok(!links('testnet').includes(path));
  }
  for (const path of ['/network/block-speed', '/network/upgrades']) {
    assert.ok(links('mainnet').includes(path));
    assert.ok(links('testnet').includes(path));
    assert.ok(!links('crosslink').includes(path));
  }
  assert.ok(!getNavigation('crosslink').some(category => category.id === 'analytics'));
});

test('current navigation selects the most specific route and respects path boundaries', () => {
  const mainnet = getNavigation('mainnet');
  for (const path of ['/network/block-speed', '/network/upgrades', '/network/nodes', '/privacy/wallets', '/tools/blend-check']) {
    assert.equal(getActiveNavigationHref(path, mainnet), path);
    assert.equal(getActiveNavigationHref(`${path}/`, mainnet), path);
  }
  assert.equal(getActiveNavigationHref('/newsletter/an-issue', mainnet), '/newsletter');
  assert.equal(getActiveNavigationHref('/privacy-policy', mainnet), undefined);
  assert.equal(getActiveNavigationHref('/networking', mainnet), undefined);
});

 test('header and footer share core names and order, with press reserved for the footer', () => {
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const header = getNavigation(network).flatMap(category => category.items);
    const footer = getNavigation(network, 'footer').flatMap(category => category.items);
    assert.deepEqual(header, footer.filter(item => !item.footerOnly));
    assert.ok(!header.some(item => item.href === '/press'));
    assert.ok(footer.some(item => item.href === '/press'));
  }
});

test('nested menu/support scroll locks preserve each other and the original body style', () => {
  const effects = [];
  const doc = { body: { style: { overflow: 'clip' } } };
  const hookModule = { exports: {} };
  const hookCode = ts.transpileModule(fs.readFileSync('hooks/useBodyScrollLock.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('module', 'exports', 'require', 'document', hookCode)(
    hookModule, hookModule.exports, () => ({ useEffect: effect => effects.push(effect()) }), doc,
  );
  const { useBodyScrollLock } = hookModule.exports;
  useBodyScrollLock(false);
  assert.equal(doc.body.style.overflow, 'clip', 'an inactive control must not clear another lock');
  useBodyScrollLock(true);
  useBodyScrollLock(true);
  assert.equal(doc.body.style.overflow, 'hidden');
  effects[1](); // The parent can unmount before its child.
  assert.equal(doc.body.style.overflow, 'hidden');
  effects[2]();
  assert.equal(doc.body.style.overflow, 'clip');
});
