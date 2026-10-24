const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function loadAddressComponent(file, currency = 'ZEC', imports = {}) {
  const filename = path.resolve(__dirname, '../../app/address/[address]', file);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const load = specifier => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    if (specifier === '@/lib/config') return { CURRENCY: currency };
    if (specifier === 'next/link') return function TestLink({ children, ...props }) { return React.createElement('a', props, children); };
    if (specifier === 'next/image') return function TestImage({ alt, src, width, height }) { return React.createElement('img', { alt, src, width, height }); };
    if (specifier === './helpers') return { formatHumanDate: () => 'October 15, 2026' };
    if (specifier === '@/components/ui/Skeleton') return { Skeleton: () => null };
    if (specifier === '@/components/ui/EmptyState') return { SkeletonTable: () => null };
    return require(specifier);
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(load, module, module.exports);
  return module.exports;
}

// Small hook runner exercises the real component's effects and fetch callbacks
// without requiring a Next dev server. Child rendering is outside this test.
function harness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let page = '1';
  const changed = (a, b) => !a || a.some((value, i) => !Object.is(value, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useCallback(callback, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) slots[i] = { callback, deps };
      return slots[i].callback;
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: effect() };
      });
    },
  };
  const filename = path.resolve(__dirname, '../../app/address/[address]/components/AddressDetailClient.tsx');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const jsx = (type, props) => ({ type, props });
  const load = specifier => {
    if (specifier === 'react') return hooks;
    if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (specifier === 'next/navigation') return { useSearchParams: () => new URLSearchParams({ page }) };
    if (specifier === 'next/dynamic') return () => 'AddressGraph';
    if (specifier === '@/lib/api-config') return { getApiUrl: () => 'https://fixture.invalid' };
    if (specifier === '@/lib/api-client') return { readApiData: async response => {
      const body = await response.json();
      return body?.meta ? body.data : body;
    } };
    if (specifier === '@/lib/format-numbers') return { zatToZec: value => value / 1e8 };
    if (specifier === './helpers') return {
      transformTransactions: (_, txs) => txs, getTypeInfo: () => ({}),
      isShieldedAddress: () => false, hasNoTransactions: () => false, hasIndexingIssue: () => false,
    };
    return new Proxy({}, { get: (_, name) => name });
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(load, module, module.exports);
  return {
    render(nextPage = page) {
      page = nextPage; cursor = 0; effects = [];
      const tree = module.exports.AddressDetailClient({ address: 't-fixture' });
      effects.forEach(run => run());
      return tree;
    },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === type) return tree;
  const children = [tree.props?.children].flat(Infinity);
  return children.map(child => find(child, type)).find(Boolean);
}

test('page data renders while enrichment is pending, page changes fetch once, and stale responses cannot overwrite it', async t => {
  const pending = [];
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const client = harness();
  client.render();
  assert.equal(pending.length, 3);
  const addressRequest = pending.find(req => req.url.includes('?page=1'));
  let finishOldJson;
  addressRequest.resolve({ ok: true, json: () => new Promise(resolve => { finishOldJson = resolve; }) });
  await flush();
  client.render('2');
  assert.equal(addressRequest.options.signal.aborted, true);
  assert.equal(pending.length, 4, 'page navigation must not repeat optional lookups');
  const nextRequest = pending[3];
  assert.match(nextRequest.url, /page=2/);
  const data = txid => ({ address: 't-fixture', balance: 0, txCount: 75, pagination: { totalPages: 3 }, transactions: [{ txid }] });
  nextRequest.resolve({ ok: true, json: async () => data('new') });
  await flush();
  let table = find(client.render(), 'TransactionTable');
  assert.ok(table, 'the table renders even though price and cross-chain never resolved');
  assert.equal(table.props.data.transactions[0].txid, 'new');
  finishOldJson(data('old'));
  await flush();
  table = find(client.render(), 'TransactionTable');
  assert.equal(table.props.data.transactions[0].txid, 'new');
});

test('optional price enrichment cannot crash address rendering and preserves valid zero/nonzero quotes', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const { AddressHeroCard } = loadAddressComponent('components/AddressHeroCard.tsx');
  const cases = [
    { name: 'testnet unavailable quote', quote: { price: null, change24h: null, available: false }, expected: null },
    { name: 'explicit unavailable flag', quote: { price: 25, change24h: 1, available: false }, expected: null },
    { name: 'missing price', quote: { change24h: 1 }, expected: null },
    { name: 'numeric string', quote: { price: '25', change24h: 1 }, expected: null },
    { name: 'nonfinite price', quote: { price: Infinity, change24h: 1 }, expected: null },
    { name: 'missing data', quote: null, expected: null },
    { name: 'valid quote', quote: { price: 25, change24h: 1 }, expected: 25, usd: '37.5' },
    { name: 'valid zero quote', quote: { price: 0, change24h: 0, available: true }, expected: 0, usd: '0' },
  ];
  for (const { name, quote, expected, usd } of cases) {
    await t.test(name, async () => {
      const pending = [];
      global.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
      const client = harness();
      client.render();
      pending.find(req => req.url.endsWith('/v1/network/price')).resolve({
        ok: true, json: async () => ({ data: quote, meta: { network: 'testnet' } }),
      });
      pending.find(req => req.url.includes('?page=1')).resolve({ ok: true, json: async () => ({
        data: { address: 't-fixture', balance: '150000000', txCount: 1, transactions: [] },
        meta: { network: 'testnet' },
      }) });
      await flush();
      const hero = find(client.render(), 'AddressHeroCard');
      assert.ok(hero, 'address content remains available after price enrichment resolves');
      assert.equal(hero.props.priceData?.price ?? null, expected);
      const html = renderToStaticMarkup(React.createElement(AddressHeroCard, hero.props));
      assert.match(html, /1\.50/);
      if (expected === null) assert.match(html, /USD estimate unavailable/);
      else {
        assert.ok(html.includes(`≈ $${usd}`), 'valid quote computes the USD balance');
        assert.ok(html.includes(`at $${expected}`), 'valid quote retains the displayed unit price');
        assert.doesNotMatch(html, /USD estimate unavailable/);
      }
    });
  }
});

test('address server/loading/empty/overview amounts and metadata use the configured network currency', async () => {
  const meta = { balance: 1.5, txCount: 1, type: 'transparent', isShielded: false };
  for (const currency of ['ZEC', 'TAZ', 'CTAZ']) {
    const { AddressHeroCard } = loadAddressComponent('components/AddressHeroCard.tsx', currency);
    const { AddressLoadingSkeleton } = loadAddressComponent('components/AddressLoadingSkeleton.tsx', currency);
    const { EmptyAddressView } = loadAddressComponent('components/AddressStateViews.tsx', currency);
    const html = [
      renderToStaticMarkup(React.createElement(AddressLoadingSkeleton, { initialMeta: meta })),
      renderToStaticMarkup(React.createElement(EmptyAddressView, { address: 't-fixture' })),
      renderToStaticMarkup(React.createElement(AddressHeroCard, {
        data: { ...meta, address: 't-fixture', transactions: [] },
        priceData: null, crossChain: null, totalTxCount: 1,
      })),
    ];
    for (const markup of html) assert.ok(markup.includes(`>${currency}</span>`));
    const layout = loadAddressComponent('layout.tsx', currency, {
      '@/components/CopyButton': { CopyButton: () => null },
      'next/navigation': { notFound: () => { throw new Error('Unexpected not found'); } },
      '@/lib/zcash': { detectAddressType: () => 'transparent' },
      '@/lib/isr-fallback': { retainLastGoodOrBuildFallback: value => value },
      '@/lib/seo': {
        getAddressResolution: async () => ({ state: 'found', meta }),
        formatNumber: value => String(value),
        getBaseUrl: () => 'https://testnet.zecblock.com',
        buildPageMetadata: options => options,
      },
    });
    const props = { params: Promise.resolve({ address: 'tmTwLU5Y855hfBZ25ZaWuTvcrqjrCMFAZR9' }) };
    const metadata = await layout.generateMetadata(props);
    assert.ok(metadata.description.includes(`Public balance 1.50 ${currency}`));
    const markup = renderToStaticMarkup(await layout.default(props));
    assert.ok(markup.includes(`1.5000 ${currency}`), 'JSON-LD uses the same units as visible amounts');
  }
});

test('TEX address pages (ZIP 320) link their P2PKH form and leave indexing to it', async () => {
  const TEX = 'tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte';
  const P2PKH = 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC';
  const zcash = loadAddressComponent('../../../lib/zcash.ts');
  for (const tex of [TEX, 'textest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpfcjgfy']) assert.equal(zcash.detectAddressType(tex), 'tex');
  const meta = { address: TEX, transparentAddress: P2PKH, balance: 0.125, txCount: 1, type: 'transparent', isShielded: false };
  const layout = loadAddressComponent('layout.tsx', 'ZEC', {
    '@/components/CopyButton': { CopyButton: () => null },
    'next/navigation': { notFound: () => { throw new Error('Unexpected not found'); } },
    '@/lib/zcash': zcash,
    '@/lib/isr-fallback': { retainLastGoodOrBuildFallback: value => value },
    '@/lib/seo': {
      getAddressResolution: async () => ({ state: 'found', meta }),
      formatNumber: value => String(value),
      getBaseUrl: () => 'https://zecblock.com',
      buildPageMetadata: options => options,
    },
  });
  const props = { params: Promise.resolve({ address: TEX }) };
  const metadata = await layout.generateMetadata(props);
  assert.match(metadata.description, /^TEX Zcash address\./);
  assert.equal(metadata.index, false, 'the P2PKH page remains the indexed copy of this history');
  const markup = renderToStaticMarkup(await layout.default(props));
  assert.ok(markup.includes(`href="/address/${P2PKH}"`), 'the header links the P2PKH form');
});
