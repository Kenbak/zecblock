const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { NextRequest, NextResponse } = require('next/server');

const repositoryRoot = path.resolve(__dirname, '../..');
const exists = (relativePath) => fs.existsSync(path.join(repositoryRoot, relativePath));
const source = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

// A loading boundary commits the response to 200 before nested layouts run, so
// notFound() below it can only emit a noindex tag instead of a real 404.
test('no loading boundary sits above the detail-route existence checks', () => {
  for (const file of ['app/loading.tsx', 'app/loading.js', 'app/loading.jsx']) {
    assert.equal(exists(file), false, `${file} would stream a 200 before tx/address/block layouts decide 404`);
  }
});

test('detail layouts call notFound() before their own loading boundary', () => {
  for (const layout of ['app/tx/[txid]/layout.tsx', 'app/address/[address]/layout.tsx', 'app/block/[height]/layout.tsx']) {
    const code = source(layout);
    const defaultExport = code.slice(code.indexOf('export default'));
    assert.match(defaultExport, /notFound\(\)/, `${layout} default export must decide missing resources`);
  }
});

test('block pages take their CDN lifetime from ISR tiering, not a blanket proxy header', () => {
  const proxy = source('proxy.ts');
  assert.doesNotMatch(proxy, /CDN-Cache-Control/);
  assert.match(source('lib/seo.ts'), /revalidateSeconds = 3600/);
});

test('legacy /txs/shielded is a permanent config redirect, not a streamed page', () => {
  assert.equal(exists('app/txs/shielded/page.tsx'), false);
  assert.match(source('next.config.ts'), /source: '\/txs\/shielded',\s*destination: '\/txs\?type=shielded',\s*permanent: true/);
});

function loadNetworkProxy(network) {
  const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
  const networkExports = {};
  vm.runInNewContext(ts.transpileModule(source('lib/network.ts'), { compilerOptions }).outputText, {
    exports: networkExports, process: { env: { NEXT_PUBLIC_NETWORK: network } },
  });
  const zcashExports = {};
  vm.runInNewContext(ts.transpileModule(source('lib/zcash.ts'), { compilerOptions }).outputText, { exports: zcashExports, require: () => ({}) });
  const addressSyntaxExports = {};
  vm.runInNewContext(ts.transpileModule(source('lib/address-syntax.ts'), { compilerOptions }).outputText, {
    exports: addressSyntaxExports, require: name => (name === './zcash' ? zcashExports : {}),
  });
  const exports = {};
  const dependencies = {
    'next/server': { NextResponse },
    './lib/network': networkExports,
    './lib/address-syntax': addressSyntaxExports,
    './lib/governance-request': {},
    './lib/chart-catalog': { CHART_CATALOG: [] },
    './lib/name-validation': {},
  };
  vm.runInNewContext(ts.transpileModule(source('proxy.ts'), { compilerOptions }).outputText, {
    exports, URL, process: { env: { NODE_ENV: 'production' } }, setInterval: () => {},
    require: name => dependencies[name],
  });
  return exports;
}

test('Crosslink standard-network detail pages return a real 404 before loading can stream', async () => {
  const routes = ['/network/block-speed', '/network/block-speed/', '/network/block-speed/image', '/network/block-speed/image?share=1', '/network/upgrades', '/network/upgrades/', '/network/upgrades/unknown?view=1'];
  for (const network of ['mainnet', 'testnet', 'crosslink-testnet', 'crosslink']) {
    const { proxy, config } = loadNetworkProxy(network);
    assert.ok(config.matcher.includes('/network/block-speed/:path*'), 'both the page and its image must reach Proxy');
    assert.ok(config.matcher.includes('/network/upgrades/:path*'), 'the upgrade hub must reach Proxy before its parent loading boundary can stream');
    const crosslink = network.startsWith('crosslink');
    for (const route of routes) {
      const response = await proxy(new NextRequest(`https://explorer.example${route}`));
      assert.equal(response.status, crosslink ? 404 : 200, `${network} ${route}`);
      if (!crosslink) {
        assert.equal(response.headers.get('x-middleware-next'), '1');
        continue;
      }
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, follow');
      assert.match(response.headers.get('Content-Type'), /^text\/html/);
      const html = await response.text();
      assert.match(html, /<title>Page not found \| ZecBlock<\/title>/);
      assert.match(html, /not available on Crosslink testnet/);
      assert.equal((html.match(/<h1>/g) || []).length, 1);
    }
    assert.equal((await proxy(new NextRequest('https://explorer.example/network'))).status, 200, `${network} Network hub remains available`);
  }
});

test('malformed transaction and address URLs return a styled 404 from Proxy, never the SSR error shell', async () => {
  const { proxy, config } = loadNetworkProxy('mainnet');
  const matchers = config.matcher.map(pattern => pattern);
  assert.ok(matchers.some(pattern => pattern.startsWith('/tx/:txid((?![a-fA-F0-9]{64}')), 'malformed tx ids must reach Proxy');
  assert.ok(matchers.some(pattern => pattern.startsWith('/address/:address((?!')), 'malformed addresses must reach Proxy');
  const cases = [
    ['/tx/5b34c8b44d', 'Transaction not found'],
    ['/tx/not-a-hash', 'Transaction not found'],
    ['/address/zzz', 'Address not found'],
    ['/address/t1Kfws', 'Address not found'],
    ['/address/%E0%A4%A', 'Address not found'],
    ['/address/tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgt', 'Address not found'],
  ];
  for (const [route, title] of cases) {
    const response = await proxy(new NextRequest(`https://explorer.example${route}`));
    assert.equal(response.status, 404, route);
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, follow', route);
    const html = await response.text();
    assert.match(html, new RegExp(`<h1>${title}</h1>`), route);
  }
  for (const route of [
    `/address/t1${'a'.repeat(33)}`,
    '/address/tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd',
    '/address/tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte',
    '/address/textest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpfcjgfy',
  ]) {
    assert.equal((await proxy(new NextRequest(`https://explorer.example${route}`))).status, 200, route);
  }
});

test('well-formed TEX addresses bypass Proxy like the other address forms', () => {
  const { config } = loadNetworkProxy('mainnet');
  const prefix = '/address/:address(';
  const pattern = config.matcher.find(matcher => matcher.startsWith(prefix));
  const reachesProxy = new RegExp(`^/address/(?:${pattern.slice(prefix.length, -1)})$`);
  assert.equal(reachesProxy.test('/address/tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte'), false);
  assert.equal(reachesProxy.test('/address/textest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpfcjgfy'), false);
  assert.equal(reachesProxy.test('/address/t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC'), false);
  assert.equal(reachesProxy.test('/address/tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgt'), true);
});
