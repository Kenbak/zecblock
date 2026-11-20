const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('lib/navigation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const navigationModule = { exports: {} };
new Function('module', 'exports', code)(navigationModule, navigationModule.exports);
const { getNavigation, getActiveNavigationHref, getHeaderActiveHref, getNestedNavigation, groupNavigationItems,
  getFooterColumns, nestNavigationItems, FOOTER_COLUMN_MAX, PRIVATE_EXPLORER_URL } = navigationModule.exports;

test('every menu destination has a page and bypasses retired route aliases', () => {
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const items = getNavigation(network, 'footer').flatMap(category => category.items);
    assert.equal(new Set(items.map(item => item.href)).size, items.length);
    for (const item of items) {
      assert.ok(item.label && item.desc);
      // An external destination has no local page; every internal one must.
      if (/^https:\/\//.test(item.href)) continue;
      assert.ok(fs.existsSync(`app${item.href}/page.tsx`), `${network}: ${item.href}`);
      assert.ok(!['/migration', '/flows', '/privacy-stats', '/privacy/risks', '/blend-check', '/swap'].includes(item.href));
    }
  }
});

test('network-specific navigation keeps unsupported destinations out', () => {
  const links = (network, surface) => getNavigation(network, surface).flatMap(category => category.items.map(item => item.href));
  for (const path of ['/crosschain', '/governance', '/calendar', '/zift']) {
    assert.ok(links('mainnet').includes(path));
    assert.ok(!links('testnet', 'footer').includes(path));
    assert.ok(!links('crosslink', 'footer').includes(path));
  }
  // Mainnet-only pages that left the masthead stay in the mainnet sitemap only.
  for (const path of ['/zodl', '/usage-clock']) {
    assert.ok(!links('mainnet').includes(path));
    assert.ok(links('mainnet', 'footer').includes(path));
    assert.ok(!links('testnet', 'footer').includes(path));
    assert.ok(!links('crosslink', 'footer').includes(path));
  }
  for (const path of ['/chain', '/validators', '/bootstrap', '/fork-monitor', '/learn/crosslink']) {
    assert.ok(links('crosslink').includes(path));
    assert.ok(!links('mainnet', 'footer').includes(path));
    assert.ok(!links('testnet', 'footer').includes(path));
  }
  for (const path of ['/network/block-speed', '/network/upgrades']) {
    assert.ok(links('mainnet').includes(path));
    assert.ok(links('testnet').includes(path));
    assert.ok(!links('crosslink', 'footer').includes(path));
  }
  assert.ok(!getNavigation('crosslink', 'footer').some(category => category.id === 'privacy'));
});

test('the masthead stays a shortlist: at most four menus and no list longer than six', () => {
  // The network switcher shares the masthead's open-menu state under its own key.
  const navBar = fs.readFileSync('components/NavBar.tsx', 'utf8');
  assert.match(navBar, /toggleDropdown\('network-switch'\)/);
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const ids = getNavigation(network, 'footer').map(category => category.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(!ids.includes('network-switch'));
  }
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const header = getNavigation(network);
    assert.ok(header.length <= 4, `${network}: ${header.length} menus`);
    for (const category of header) {
      // One word per menu: a longer label wraps in the masthead at 1280px.
      assert.match(category.label, /^[A-Za-z]+$/, `${network}: ${category.label}`);
      for (const group of groupNavigationItems(category.items)) {
        assert.ok(group.items.length <= 6, `${network}: ${category.label} / ${group.label ?? 'all'}`);
      }
    }
  }
  // The last menu mixes analytics, developer and learning pages, so it is called More; its groups name them.
  const more = getNavigation('mainnet').find(category => category.id === 'more');
  assert.equal(more.label, 'More');
  assert.deepEqual(groupNavigationItems(more.items).map(group => group.label), ['Analytics', 'Developers', 'Learn']);
  const privacy = getNavigation('mainnet').find(category => category.id === 'privacy');
  assert.deepEqual(groupNavigationItems(privacy.items).map(group => group.label), [undefined]);
  // Mining, the forks it produces and block speed sit together, on every network that has them.
  const groups = network => groupNavigationItems(getNavigation(network).find(category => category.id === 'network').items)
    .map(group => [group.label, group.items.map(item => item.href)]);
  assert.deepEqual(groups('mainnet'), [
    ['Live network', ['/network', '/network/nodes', '/network/wallet-servers']],
    ['Mining & forks', ['/mining', '/reorgs', '/network/block-speed']],
    ['Protocol', ['/network/upgrades', '/governance', '/calendar']],
  ]);
  assert.deepEqual(groups('crosslink'), [
    ['Live network', ['/network', '/network/nodes', '/validators', '/bootstrap']],
    ['Mining & forks', ['/reorgs', '/fork-monitor']],
  ]);
  // The first menu holds records to look up; analysis pages live in the other menus.
  assert.deepEqual(getNavigation('mainnet')[0].items.map(item => item.href), ['/blocks', '/txs', '/mempool', '/crosschain', '/rich-list']);
  // One surviving group needs no sub-heading.
  assert.deepEqual(groupNavigationItems([{ href: '/a', group: 'Only' }, { href: '/b', group: 'Only' }]).map(group => group.label), [undefined]);
});

test('every page that left the masthead is still linked from the footer or its hub, with a valid parent', () => {
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const header = getNavigation(network).flatMap(category => category.items.map(item => item.href));
    for (const item of getNavigation(network, 'footer').flatMap(category => category.items)) {
      if (item.parent) assert.ok(item.footerOnly && header.includes(item.parent), `${network}: ${item.href} -> ${item.parent}`);
    }
  }
  // The rendered footer carries these; the tools are covered by the hub test below.
  const footer = getFooterColumns('mainnet').flatMap(column => column.items.map(item => item.href));
  for (const path of ['/turnstile', '/privacy/wallets', '/zodl', '/pulse', '/usage-clock', '/tools', '/about', '/press']) {
    assert.ok(footer.includes(path), path);
  }
  // The full list still knows the tools, so a tool page keeps Tools lit in the masthead.
  const sitemap = getNavigation('mainnet', 'footer').flatMap(category => category.items.map(item => item.href));
  for (const path of ['/tools/decode', '/tools/broadcast', '/decrypt', '/tools/blend-check', '/tools/block-time-simulator',
    '/tools/unit-converter', '/tools/anchor-search']) {
    assert.ok(sitemap.includes(path) && !footer.includes(path), path);
  }
});

test('specialist pages stay in the masthead as small links under their parent', () => {
  const nested = network => Object.fromEntries(Object.entries(getNestedNavigation(network)).map(([parent, items]) => [parent, items.map(item => item.href)]));
  assert.deepEqual(nested('mainnet'), {
    '/pools': ['/turnstile'], '/privacy-risks': ['/privacy/wallets'], '/mining': ['/zodl'], '/charts': ['/pulse', '/usage-clock'],
  });
  assert.deepEqual(nested('testnet'), { '/pools': ['/turnstile'], '/privacy-risks': ['/privacy/wallets'], '/charts': ['/pulse'] });
  assert.deepEqual(nested('crosslink'), {});
});

test('the tools hub lists every tool, so the menus and the footer link the hub once', () => {
  const hub = fs.readFileSync('app/tools/page.tsx', 'utf8');
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const sitemap = getNavigation(network, 'footer').flatMap(category => category.items);
    const hubOnly = sitemap.filter(item => item.hubOnly);
    assert.ok(hubOnly.length >= 7, network);
    for (const item of hubOnly) {
      assert.equal(item.parent, '/tools', item.href);
      assert.ok(item.footerOnly && !item.nested, item.href);
      // The hub must link the page itself; it is the only link in the site chrome.
      assert.ok(hub.includes(`'${item.href}'`) || (item.href === PRIVATE_EXPLORER_URL && hub.includes('PRIVATE_EXPLORER_URL')), item.href);
    }
    const footer = getFooterColumns(network).flatMap(column => column.items);
    assert.ok(footer.some(item => item.href === '/tools'), network);
    assert.ok(!footer.some(item => item.hubOnly), network);
    assert.ok(!Object.keys(getNestedNavigation(network)).includes('/tools'), network);
  }
  assert.equal(PRIVATE_EXPLORER_URL, 'https://private.zecblock.com');
});

test('current navigation selects the most specific route and respects path boundaries', () => {
  const sitemap = getNavigation('mainnet', 'footer');
  for (const path of ['/network/block-speed', '/network/upgrades', '/network/nodes', '/privacy/wallets', '/tools/blend-check']) {
    assert.equal(getActiveNavigationHref(path, sitemap), path);
    assert.equal(getActiveNavigationHref(`${path}/`, sitemap), path);
  }
  assert.equal(getActiveNavigationHref('/newsletter/an-issue', sitemap), '/newsletter');
  assert.equal(getActiveNavigationHref('/privacy-policy', sitemap), undefined);
  assert.equal(getActiveNavigationHref('/networking', sitemap), undefined);
});

test('a footer-only page lights the masthead destination it is reached from', () => {
  for (const [path, expected] of [
    ['/pools', '/pools'], ['/network/nodes', '/network/nodes'], ['/newsletter/an-issue', '/newsletter'],
    ['/turnstile', '/pools'], ['/privacy/wallets', '/privacy-risks'], ['/zodl', '/mining'],
    ['/pulse', '/charts'], ['/usage-clock', '/charts'], ['/tools/blend-check', '/tools'], ['/decrypt', '/tools'],
    ['/about', undefined], ['/privacy-policy', undefined], ['/networking', undefined],
  ]) assert.equal(getHeaderActiveHref(path, 'mainnet'), expected, path);
  assert.equal(getHeaderActiveHref(null, 'mainnet'), undefined);
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

test('the footer is one row of even columns that keeps every link and indents child pages', () => {
  const columns = getFooterColumns('mainnet');
  // One row at desktop width: the grid has six tracks, so a seventh column would wrap.
  assert.match(fs.readFileSync('components/Footer.tsx', 'utf8'), /lg:grid-cols-6/);
  assert.deepEqual(columns.map(column => [column.label, column.items.length]), [
    ['Explorer', 5], ['Privacy', 6], ['Network', 10], ['Analytics', 6], ['Developers', 2], ['Learn', 4],
  ]);
  assert.deepEqual(columns.find(column => column.label === 'Developers').items.map(item => item.href), ['/docs', '/tools']);
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const footer = getFooterColumns(network);
    assert.ok(footer.length <= 6, `${network}: ${footer.length} columns`);
    assert.equal(new Set(footer.map(column => column.id)).size, footer.length);
    for (const column of footer) assert.ok(column.items.length <= FOOTER_COLUMN_MAX, `${network}: ${column.label}`);
    // Regrouping loses and duplicates nothing except the pages a hub lists itself.
    assert.deepEqual(footer.flatMap(column => column.items), getNavigation(network, 'footer').flatMap(category => category.items).filter(item => !item.hubOnly));
    for (const column of footer) {
      const entries = nestNavigationItems(column.items);
      assert.equal(entries.reduce((count, entry) => count + 1 + entry.children.length, 0), column.items.length, `${network}: ${column.label}`);
      for (const entry of entries) for (const child of entry.children) assert.equal(child.parent, entry.item.href);
    }
  }
  const nested = label => nestNavigationItems(columns.find(column => column.label === label).items)
    .map(entry => [entry.item.href, entry.children.map(child => child.href)]);
  assert.deepEqual(nested('Privacy'), [['/pools', ['/turnstile']], ['/ironwood', []], ['/privacy', []], ['/privacy-risks', ['/privacy/wallets']]]);
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
