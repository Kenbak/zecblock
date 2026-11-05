const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  new Function('require', 'exports', 'process', code)(name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (['react', 'react/jsx-runtime'].includes(name)) return require(name);
    throw new Error(`Unexpected dependency ${name}`);
  }, exports, { env: {} });
  return exports;
}

function valuationRoute(network) {
  const seo = load('lib/seo.ts', {
    '@/lib/api-client': { readApiData: () => {} },
    '@/lib/network': { getConfiguredNetwork: () => network },
    '@/lib/api-config': { getApiUrlForNetwork: () => 'https://api.invalid' },
    '@/lib/server-fetch': { fetchWithDeadline: () => {} },
  });
  const header = load('components/ui/SectionHeader.tsx', {
    'next/link': ({ href, children }) => React.createElement('a', { href }, children),
  });
  const { default: Page } = load('app/valuation/page.tsx', {
    '@/components/ui/SectionHeader': header,
    '@/lib/seo': seo,
    './ValuationClient': () => null,
  });
  const { metadata, default: Layout } = load('app/valuation/layout.tsx', { '@/lib/seo': seo });
  const html = renderToStaticMarkup(React.createElement(Layout, {}, React.createElement(Page)));
  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  return { metadata, html, schema };
}

for (const [network, origin] of [
  ['mainnet', 'https://zecblock.com'],
  ['testnet', 'https://testnet.zecblock.com'],
  ['crosslink-testnet', 'https://crosslink.zecblock.com'],
]) {
  test(`valuation intro, sharing copy and structured data describe the available ${network} experience`, () => {
    const { metadata, html, schema } = valuationRoute(network);
    const mainnet = network === 'mainnet';
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /Zcash Valuation &amp; Market Context/);
    assert.equal(metadata.alternates.canonical, `${origin}/valuation`);
    assert.equal(metadata.robots.index, mainnet);
    assert.equal(metadata.robots.follow, true);
    assert.equal(metadata.openGraph.url, `${origin}/valuation`);
    assert.equal(metadata.openGraph.description, metadata.description);
    assert.equal(metadata.twitter.description, metadata.description);
    assert.equal(schema.url, `${origin}/valuation`);
    assert.equal(schema.description, metadata.description);
    assert.equal(schema.isPartOf['@id'], `${origin}/#website`);
    assert.equal(metadata.keywords.includes('ZEC BTC ratio'), mainnet);
    if (mainnet) {
      assert.match(html, /percentage of Bitcoin/);
      assert.match(metadata.description, /ZEC\/BTC history/);
    } else {
      assert.match(html, /Current market data, modeled cost basis/);
      assert.doesNotMatch(html, /percentage of Bitcoin|ZEC\/BTC|ZEC BTC/);
      assert.doesNotMatch(metadata.description, /Bitcoin|BTC/);
    }
  });
}
