const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '../..');

function load(file, dependencies, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(code, {
    exports, AbortSignal, console, ...globals,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (['react', 'react/jsx-runtime'].includes(name)) return require(name);
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return exports;
}

function addressLabelHarness({ officialLabels = [], customLabels = {} } = {}) {
  let storedLabels = JSON.stringify(customLabels);
  let requestCount = 0;
  const labels = load('lib/address-labels.ts', {
    '@/lib/api-config': { getApiUrl: () => 'https://api.test' },
    '@/lib/api-client': { readApiData: async response => (await response.json()).data },
  }, {
    window: {},
    localStorage: {
      getItem: () => storedLabels,
      setItem: (_, value) => { storedLabels = value; },
    },
    fetch: async () => {
      requestCount++;
      return { ok: true, json: async () => ({ data: { labels: officialLabels } }) };
    },
  });
  const image = ({ src, alt, width, height, className }) => React.createElement('img', { src, alt, width, height, className });
  const { EntityLogo } = load('components/EntityLogo.tsx', {
    'next/image': image,
    '@/lib/entity-logos': load('lib/entity-logos.ts', {}),
  });
  const { PoolLogo } = load('components/PoolLogo.tsx', {
    'next/image': image,
    '@/components/icons/home-section': load('components/icons/home-section.tsx', {}),
  });
  const states = [];
  let slot = 0;
  let effect;
  const { AddressLabel } = load('components/AddressLabel.tsx', {
    react: {
      ...React,
      useState(initial) {
        const index = slot++;
        if (!(index in states)) states[index] = initial;
        return [states[index], value => { states[index] = value; }];
      },
      useEffect(callback) { effect = callback; },
    },
    '@/lib/address-labels': labels,
    '@/components/EntityLogo': { EntityLogo },
    '@/components/PoolLogo': { PoolLogo },
  });

  const render = address => {
    slot = 0;
    const element = AddressLabel({ address });
    return { element, html: renderToStaticMarkup(element) };
  };
  return {
    render,
    async mount(address) {
      render(address);
      effect();
      await labels.fetchOfficialLabels();
      return render(address);
    },
    requestCount: () => requestCount,
  };
}

test('address header loads authoritative entity identities and preserves their label, check and description', async () => {
  const address = 't1official-binance-address';
  const page = addressLabelHarness({
    officialLabels: [{ address, label: 'Binance Cold Wallet', category: 'exchange', description: 'Binance cold storage' }],
    customLabels: { [address]: 'My custom guess' },
  });
  const { html } = await page.mount(address);
  assert.equal(page.requestCount(), 1, 'direct loads use the shared official-label request');
  assert.match(html, /src="\/brands\/entities\/binance\.png"/);
  assert.match(html, /alt=""/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /Binance Cold Wallet/);
  assert.match(html, /title="Binance cold storage"/);
  assert.match(html, /fill-rule="evenodd"/, 'the existing official check remains');
  assert.doesNotMatch(html, /My custom guess|Remove label/);
});

test('custom text matching an entity or pool never receives a brand mark or official check', async () => {
  for (const label of ['Binance', 'Luxor']) {
    const address = `t1custom-${label}`;
    const page = addressLabelHarness({ customLabels: { [address]: label } });
    let { element, html } = await page.mount(address);
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /<img|\/brands\/|fill-rule="evenodd"/);
    assert.match(html, /title="Remove label"/);

    element.props.children[1].props.onClick();
    ({ element, html } = page.render(address));
    assert.match(html, /Add label/, 'custom-label removal is preserved');
    element.props.onClick();
    ({ element } = page.render(address));
    element.props.children[0].props.onChange({ target: { value: label } });
    ({ element } = page.render(address));
    element.props.children[0].props.onKeyDown({ key: 'Enter' });
    ({ html } = page.render(address));
    assert.ok(html.includes(label), 'custom-label save is preserved');
    assert.doesNotMatch(html, /<img|\/brands\/|fill-rule="evenodd"/);
  }
});

test('pool marks require an authoritative mining category and unknown official names remain neutral', async () => {
  for (const [label, category, expectedSrc] of [
    ['Luxor', 'mining', '/brands/mining/luxor.svg'],
    ['Luxor', 'exchange', null],
    ['Binance lookalike', 'exchange', null],
  ]) {
    const address = `t1official-${category}-${label}`;
    const page = addressLabelHarness({ officialLabels: [{ address, label, category, description: 'Existing attribution' }] });
    const { html } = await page.mount(address);
    assert.ok(html.includes(label));
    assert.match(html, /title="Existing attribution"/);
    assert.match(html, /fill-rule="evenodd"/, 'existing authority stays visible even without a sourced mark');
    if (expectedSrc) assert.ok(html.includes(`src="${expectedSrc}"`));
    else assert.doesNotMatch(html, /<img|\/brands\//);
  }
});
