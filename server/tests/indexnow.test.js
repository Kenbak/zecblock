const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { NextRequest, NextResponse } = require('next/server');

const repositoryRoot = path.resolve(__dirname, '../..');
const source = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
const KEY = 'indexnow-test-key';

function loadProxy({ network = 'mainnet', env = {} } = {}) {
  const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
  const networkExports = {};
  vm.runInNewContext(ts.transpileModule(source('lib/network.ts'), { compilerOptions }).outputText, {
    exports: networkExports, process: { env: { NEXT_PUBLIC_NETWORK: network } },
  });
  const exports = {};
  const dependencies = {
    'next/server': { NextResponse },
    './lib/network': networkExports,
    './lib/governance-request': {},
    './lib/chart-catalog': { CHART_CATALOG: [] },
    './lib/name-validation': {},
    './lib/address-syntax': {},
  };
  vm.runInNewContext(ts.transpileModule(source('proxy.ts'), { compilerOptions }).outputText, {
    exports, URL, process: { env: { NODE_ENV: 'production', INDEXNOW_KEY: KEY, ...env } }, setInterval: () => {},
    require: (name) => dependencies[name],
  });
  return exports;
}

function request(pathname, { host = 'zecblock.com', method = 'GET' } = {}) {
  return new NextRequest(`https://${host}${pathname}`, { method, headers: { host } });
}

test('the mainnet canonical host serves the IndexNow key from private configuration', async () => {
  const { proxy } = loadProxy();
  const response = await proxy(request(`/${KEY}.txt`));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), KEY);
  assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
  assert.equal(response.headers.get('x-middleware-next'), null);

  const head = await proxy(request(`/${KEY}.txt`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
});

test('the key file is not served on other networks, hosts, paths or without configuration', async () => {
  const cases = [
    [loadProxy({ network: 'testnet' }), request(`/${KEY}.txt`, { host: 'testnet.zecblock.com' })],
    [loadProxy({ network: 'testnet' }), request(`/${KEY}.txt`)],
    [loadProxy({ network: 'crosslink-testnet' }), request(`/${KEY}.txt`)],
    [loadProxy(), request(`/${KEY}.txt`, { host: 'zecblock-git-branch.vercel.app' })],
    [loadProxy(), request(`/${KEY}.txt`, { method: 'POST' })],
    [loadProxy(), request(`/${KEY.slice(1)}.txt`)],
    [loadProxy(), request(`/${KEY}.TXT`)],
    [loadProxy({ env: { INDEXNOW_KEY: '' } }), request(`/${KEY}.txt`)],
    [loadProxy({ env: { INDEXNOW_KEY: 'bad/key/value' } }), request('/bad/key/value.txt')],
  ];
  for (const [{ proxy }, req] of cases) {
    const response = await proxy(req);
    assert.notEqual(await response.text(), KEY, `${req.method} ${req.url}`);
  }
});

test('legacy hosts redirect the key path to the canonical host', async () => {
  const { proxy } = loadProxy();
  const response = await proxy(request(`/${KEY}.txt`, { host: 'cipherscan.app' }));
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), `https://zecblock.com/${KEY}.txt`);
});

test('Proxy matches only key-shaped root .txt paths, never robots/sitemap discovery', () => {
  const { config } = loadProxy();
  const matcher = config.matcher[0];
  assert.equal(matcher, '/:indexNowKey([a-zA-Z0-9-]{8,128}\\.txt)');
  const pattern = new RegExp(`^/(?:${matcher.slice('/:indexNowKey('.length, -1)})$`);
  assert.equal(pattern.test(`/${KEY}.txt`), true);
  for (const pathname of ['/robots.txt', '/llms.txt', '/sitemap.xml', `/nested/${KEY}.txt`, `/${KEY}.txt/x`]) {
    assert.equal(pattern.test(pathname), false, pathname);
  }
});

test('the key value is never committed to the repository', () => {
  assert.doesNotMatch(source('proxy.ts'), /INDEXNOW_KEY\s*=\s*['"]/);
  assert.equal(fs.readdirSync(path.join(repositoryRoot, 'public')).some((file) => /^[a-zA-Z0-9-]{8,128}\.txt$/.test(file) && file !== 'robots.txt'), false);
});

test('newsletter submissions use only added/modified issues of the deployed commit', async () => {
  const { changedNewsletterSlugs } = await import(path.join(repositoryRoot, 'scripts/indexnow-newsletter.mjs'));
  const sha = 'c'.repeat(40);
  let args;
  const slugs = changedNewsletterSlugs(sha, (gitArgs) => {
    args = gitArgs;
    return 'content/newsletter/weekly-2026-10-25.md\ncontent/newsletter/assets/chart.png\ncontent/newsletter/nested/x.md\n';
  });
  assert.deepEqual(slugs, ['weekly-2026-10-25']);
  assert.deepEqual(args, ['diff', '--name-only', '--diff-filter=AMR', `${sha}^1`, sha, '--', 'content/newsletter']);
  assert.throws(() => changedNewsletterSlugs('HEAD', () => ''), /40-character SHA/);
});

test('the newsletter workflow runs only after the mainnet production deployment succeeds', () => {
  const workflow = source('.github/workflows/indexnow-newsletter.yml');
  assert.match(workflow, /github\.event\.deployment_status\.state == 'success'/);
  assert.match(workflow, /github\.event\.deployment\.environment == 'Production – zecblock'\)/);
  assert.match(workflow, /INDEXNOW_KEY: \$\{\{ secrets\.INDEXNOW_KEY \}\}/);
  assert.match(workflow, /NETWORK: mainnet/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
});
