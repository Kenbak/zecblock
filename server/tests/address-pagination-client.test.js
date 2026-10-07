const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

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
    if (specifier === '@/lib/api-client') return { readApiData: response => response.json() };
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

test('an unavailable price quote (testnet) leaves the hero card without a USD estimate', async t => {
  const pending = [];
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const client = harness();
  client.render();
  const priceRequest = pending.find(req => req.url.endsWith('/v1/network/price'));
  priceRequest.resolve({ ok: true, json: async () => ({ price: null, change24h: null, available: false, network: 'testnet' }) });
  const addressRequest = pending.find(req => req.url.includes('?page=1'));
  addressRequest.resolve({ ok: true, json: async () => ({ address: 't-fixture', balance: 1.5, txCount: 1, pagination: { totalPages: 1 }, transactions: [] }) });
  await flush();
  const hero = find(client.render(), 'AddressHeroCard');
  assert.ok(hero, 'the hero card renders');
  assert.equal(hero.props.priceData, null);
});
