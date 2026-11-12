const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, dependencies = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(code, { exports, require(name) {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (['react', 'react/jsx-runtime'].includes(name)) return require(name);
    throw new Error(`Unexpected dependency ${name}`);
  } });
  return exports;
}

function renderFlow(labelInfo) {
  const image = ({ src, alt, width, height, className }) => React.createElement('img', { src, alt, width, height, className });
  const icons = load('components/icons/home-section.tsx');
  const { EntityLogo } = load('components/EntityLogo.tsx', {
    'next/image': image, '@/lib/entity-logos': load('lib/entity-logos.ts'),
  });
  const { PoolLogo } = load('components/PoolLogo.tsx', {
    'next/image': image, '@/components/icons/home-section': icons,
  });
  const { FlowChain } = load('app/tx/[txid]/components/FlowChain.tsx', {
    'next/link': ({ href, children }) => React.createElement('a', { href }, children),
    '@/components/AddressWithLabel': { AddressDisplay: ({ address }) => React.createElement('span', {}, address) },
    '@/lib/address-labels': { useAddressLabel: () => labelInfo },
    '@/components/ui/Badge': load('components/ui/Badge.tsx'),
    '@/components/TokenChainIcon': { TokenChainIcon: () => null },
    '@/components/icons/shield-flow': { ShieldedIcon: () => null },
    '@/components/EntityLogo': { EntityLogo },
    '@/components/PoolLogo': { PoolLogo },
  });
  return renderToStaticMarkup(React.createElement(FlowChain, {
    sources: [{ kind: 'address', address: 't1visible-address' }],
    destinations: [{ kind: 'unknown' }],
  }));
}

test('transaction counterparties preserve official entity names, links and checks beside their mark', () => {
  const html = renderFlow({ label: 'Binance Cold Wallet', category: 'exchange', isOfficial: true });
  assert.match(html, /src="\/brands\/entities\/binance.png"/);
  assert.match(html, /Binance Cold Wallet/);
  assert.match(html, /href="\/address\/t1visible-address"/);
  assert.match(html, /fill-rule="evenodd"/);
  assert.match(html, /alt=""/);
});

test('transaction pool identity requires both official authority and the mining category', () => {
  const official = renderFlow({ label: 'Luxor', category: 'mining', isOfficial: true });
  assert.match(official, /src="\/brands\/mining\/luxor.svg"/);
  const otherCategory = renderFlow({ label: 'Luxor', category: 'exchange', isOfficial: true });
  assert.doesNotMatch(otherCategory, /<img|\/brands\/mining\//);
  assert.match(otherCategory, /Luxor/);
});

test('custom lookalikes and anonymous transaction counterparties receive no official branding', () => {
  for (const label of ['Binance Cold Wallet', 'Luxor']) {
    const html = renderFlow({ label, category: 'mining', isOfficial: false });
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /<img|\/brands\/|fill-rule="evenodd"/);
  }
  const anonymous = renderFlow(null);
  assert.match(anonymous, /t1visible-address/);
  assert.doesNotMatch(anonymous, /<img|\/brands\/|fill-rule="evenodd"/);
});
