const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(stats, { fail = false } = {}) {
  const calls = [];
  const exports = {};
  const points = Array.from({ length: 3614 }, (_, i) => ({ height: i }));
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/network/page.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, Date,
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name === '@/lib/issuance-curve') return { dailySupplyHistory: points => points };
      if (name === '@/lib/network-upgrades') return { readUpgradeSnapshot: () => null };
      if (name === 'next/link') return { default: 'Link' };
      if (name === './NetworkClient') return { default: 'NetworkClient' };
      if (name === '@/components/RelativeTime') return { RelativeTimeProvider: 'RelativeTimeProvider' };
      if (name === '@/lib/seo') return { getNetwork: () => 'mainnet', getApiUrl: () => 'https://api.test', getBaseUrl: () => 'https://cipherscan.app' };
      if (name === '@/lib/api-client') return { readApiData: response => response.json() };
      if (name === '@/lib/isr-fallback') return { retainLastGoodOrBuildFallback: (_fallback, error) => { throw error; } };
      if (name === '@/lib/block-speed-server') return { loadBlockSpeedSnapshot: async () => ({ story: { fixture: 'block-speed' } }) };
      if (name === '@/lib/server-fetch') return { fetchWithDeadline: async (url, init) => {
        calls.push({ url, init });
        return { ok: !fail, json: async () => url.endsWith('/network/stats') ? stats : { points } };
      } };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { page: exports.default, calls, points };
}
function find(node, type) {
  if (node?.type === type) return node;
  const children = node?.props?.children;
  return (Array.isArray(children) ? children : [children]).filter(Boolean)
    .map(child => typeof child === 'object' ? find(child, type) : null).find(Boolean);
}

test('valid network statistics object is seeded and every server fetch uses five-minute caching', async () => {
  const stats = { network: { height: 123, peers: 42 }, blockchain: { height: 123 } };
  const { page, calls, points } = load(stats);
  const tree = await page();
  const data = find(tree, 'NetworkClient').props.initialData;
  assert.equal(data.stats, stats, 'network object must not be mistaken for a network-name string');
  assert.deepEqual(data.blockSpeed, { fixture: 'block-speed' });
  assert.ok(calls.length >= 6);
  for (const call of calls) assert.equal(call.init.next.revalidate, 300, call.url);
  // Main retains every historical point; assay has moved this dataset to Pools.
  if (data.poolHistory) assert.equal(data.poolHistory.points, points);
});

test('explicit wrong-network response does not replace the last successful ISR snapshot', async () => {
  await assert.rejects(load({ network: 'testnet' }).page(), /Network statistics unavailable/);
});

test('upstream failure does not publish an empty ISR snapshot', async () => {
  await assert.rejects(load(null, { fail: true }).page(), /Network statistics unavailable/);
});
