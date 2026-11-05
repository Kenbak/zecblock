const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '../..');
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name === 'react/jsx-runtime') return require(name);
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return exports;
}
const chains = load('lib/chain-logos.ts');
const { TokenChainIcon } = load('components/TokenChainIcon.tsx', { '@/lib/chain-logos': chains });

test('Dash and Monad retain their own identities instead of another chain’s mark', () => {
  assert.equal(chains.getChainLogoSrc('DASH'), '/chains/dash.svg');
  assert.equal(chains.getChainLogoSrc(' Monad '), '/chains/monad.svg');
  assert.notEqual(chains.getChainLogoSrc('dash'), chains.getChainLogoSrc('doge'));
  assert.notEqual(chains.getChainLogoSrc('monad'), chains.getChainLogoSrc('eth'));
  for (const chain of ['dash', 'monad', 'doge', 'eth']) {
    assert.ok(fs.existsSync(path.join(root, 'public', chains.getChainLogoSrc(chain))));
  }
  for (const chain of ['unknown', 'constructor', '__proto__', 'toString']) {
    assert.equal(chains.getChainLogoSrc(chain), undefined);
  }
});

test('native assets use one correct mark, while bridged assets retain their own token and chain identities', () => {
  for (const [token, chain, src] of [['DASH', 'dash', '/chains/dash.svg'], ['MON', 'monad', '/chains/monad.svg']]) {
    const html = renderToStaticMarkup(React.createElement(TokenChainIcon, { token, chain }));
    assert.ok(html.includes(`src="${src}"`));
    assert.equal((html.match(/<img /g) || []).length, 1, 'a native asset has no redundant chain badge');
    assert.doesNotMatch(html, /src="\/chains\/(doge|eth)\.png"/);
  }
  const html = renderToStaticMarkup(React.createElement(TokenChainIcon, { token: 'USDC', chain: 'monad' }));
  assert.match(html, /src="\/tokens\/usdc\.png"/);
  assert.match(html, /src="\/chains\/monad\.svg"/);
  assert.equal((html.match(/<img /g) || []).length, 2);
});
