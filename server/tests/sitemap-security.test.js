const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { createRequire } = require('node:module');

const repositoryRoot = path.resolve(__dirname, '../..');

function loadTypeScriptModule(relativePath, imports = {}) {
  const filename = path.join(repositoryRoot, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(imports, specifier)) {
      return imports[specifier];
    }
    if (specifier === '@/lib/api-client') return loadTypeScriptModule('lib/api-client.ts');
    return createRequire(filename)(specifier);
  };
  const evaluate = new Function('exports', 'require', 'module', '__filename', '__dirname', output);
  evaluate(module.exports, localRequire, module, filename, path.dirname(filename));
  return module.exports;
}

function loadJavaScriptModule(relativePath, imports = {}) {
  const filename = path.join(repositoryRoot, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(imports, specifier)) {
      return imports[specifier];
    }
    return createRequire(filename)(specifier);
  };
  const evaluate = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
  evaluate(module.exports, localRequire, module, filename, path.dirname(filename));
  return module.exports;
}

function captureSitemapApiRoutes() {
  const handlers = new Map();
  let middleware;
  const router = {
    use(callback) { middleware = callback; },
    get(route, callback) { handlers.set(route, callback); },
  };
  loadJavaScriptModule('server/api/routes/sitemaps.js', {
    express: { Router: () => router },
    '../lib/safe-log': require('../api/lib/safe-log'),
  });

  return async (route, query, pool) => {
    const response = {
      statusCode: 200,
      headers: new Map(),
      body: undefined,
      set(name, value) { this.headers.set(name.toLowerCase(), value); return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
    };
    const request = { query, app: { locals: { pool } } };
    middleware(request, response, () => {});
    await handlers.get(route)(request, response);
    return response;
  };
}

function captureBlockApiRoute() {
  const handlers = new Map();
  let middleware;
  const router = {
    use(callback) { middleware = callback; },
    get(route, callback) { handlers.set(route, callback); },
  };
  loadJavaScriptModule('server/api/routes/blocks.js', {
    '../lib/mining-software': require('../api/lib/mining-software'),
    express: { Router: () => router },
    '../mining-pools': {
      getPoolName: () => null,
      getPoolInfo: () => ({ name: 'Example Pool', url: 'https://pool.invalid', region: 'US' }),
    },
    '../coinbase-data': { decodeCoinbaseText: () => null },
    '../list-cache': require('../api/list-cache'),
    '../lib/pagination': require('../api/lib/pagination'),
    '../lib/safe-log': require('../api/lib/safe-log'),
  });

  return async (identifier, query, pool) => {
    const response = {
      statusCode: 200,
      headers: new Map(),
      body: undefined,
      set(name, value) { this.headers.set(name.toLowerCase(), value); return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
    };
    const request = {
      params: { heightOrHash: identifier },
      query,
      app: { locals: { pool, redisClient: null, callZebraRPC: null } },
    };
    middleware(request, response, () => {});
    await handlers.get('/api/block/:heightOrHash')(request, response);
    return response;
  };
}

test('refresh cache coalesces misses and retains stale data during retry backoff', async () => {
  const { createRefreshCache } = loadTypeScriptModule('lib/refresh-cache.ts');
  let now = 0;
  let calls = 0;
  let fail = false;
  let releaseFirst;
  const firstLoad = new Promise((resolve) => { releaseFirst = resolve; });
  const getValue = createRefreshCache({
    maxAgeMs: 100,
    retryAfterMs: 10,
    now: () => now,
    load: async () => {
      calls += 1;
      if (calls === 1) return firstLoad;
      if (fail) throw new Error('upstream unavailable');
      return `value-${calls}`;
    },
  });

  const pending = [getValue('mainnet'), getValue('mainnet'), getValue('mainnet')];
  assert.equal(calls, 1);
  releaseFirst('value-1');
  assert.deepEqual(await Promise.all(pending), ['value-1', 'value-1', 'value-1']);

  now = 101;
  fail = true;
  assert.equal(await getValue('mainnet'), 'value-1');
  assert.equal(calls, 2);

  now = 105;
  assert.equal(await getValue('mainnet'), 'value-1');
  assert.equal(calls, 2, 'failure backoff should prevent another refresh');

  now = 112;
  fail = false;
  assert.equal(await getValue('mainnet'), 'value-3');
  assert.equal(calls, 3);
});

test('refresh cache applies a bounded fallback after an initial failure', async () => {
  const { createRefreshCache } = loadTypeScriptModule('lib/refresh-cache.ts');
  let now = 0;
  let calls = 0;
  const getValue = createRefreshCache({
    maxAgeMs: 100,
    retryAfterMs: 10,
    now: () => now,
    load: async () => {
      calls += 1;
      throw new Error('upstream unavailable');
    },
    fallback: () => [],
  });

  assert.deepEqual(await getValue('mainnet'), []);
  now = 5;
  assert.deepEqual(await getValue('mainnet'), []);
  assert.equal(calls, 1);
});

test('ZNS JSON-RPC passes the abort signal to the underlying fetch', async () => {
  const { callZnsRpc } = loadTypeScriptModule('lib/zns-rpc.ts');
  const controller = new AbortController();
  let request;
  const result = await callZnsRpc(
    'https://zns.invalid',
    'status',
    {},
    controller.signal,
    async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { registered: 7 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  assert.deepEqual(result, { registered: 7 });
  assert.equal(request.url, 'https://zns.invalid');
  assert.equal(request.init.signal, controller.signal);
  assert.equal(request.init.cache, 'no-store');
});

test('ZNS JSON-RPC terminates when its deadline signal aborts', async () => {
  const { callZnsRpc } = loadTypeScriptModule('lib/zns-rpc.ts');
  const controller = new AbortController();
  const request = callZnsRpc(
    'https://zns.invalid',
    'status',
    {},
    controller.signal,
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  );

  controller.abort(new DOMException('refresh deadline exceeded', 'TimeoutError'));
  await assert.rejects(request, (error) => error.name === 'TimeoutError');
});

test('API base normalization prevents duplicated API path segments', () => {
  const { normalizeApiBaseUrl } = loadTypeScriptModule('lib/network.ts');

  assert.equal(
    normalizeApiBaseUrl('https://api.crosslink.cipherscan.app'),
    'https://api.crosslink.cipherscan.app',
  );
  assert.equal(
    normalizeApiBaseUrl('https://crosslink.cipherscan.app/api'),
    'https://crosslink.cipherscan.app',
  );
  assert.equal(
    normalizeApiBaseUrl('  https://crosslink.cipherscan.app/API/  '),
    'https://crosslink.cipherscan.app',
  );
});

test('block resolution is shared, cached, and preserves unavailable states', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const requests = [];
  global.fetch = async (url, init) => {
    const identifier = new URL(url).pathname.split('/').pop();
    requests.push({ url: String(url), identifier, init });

    if (identifier === '404') return new Response(null, { status: 404 });
    if (identifier === '410') return new Response(null, { status: 410 });
    if (identifier === '503') return new Response(null, { status: 503 });
    if (identifier === '504') throw new Error('network unavailable');
    if (identifier === '505') {
      return new Response('{', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (identifier === '506') {
      return new Response(JSON.stringify(v1Fixture({ height: 506 })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(v1Fixture({
      height: '123',
      hash: 'b'.repeat(64),
      transactionCount: '1',
      isOrphaned: true,
      canonicalBlock: { hash: 'c'.repeat(64) },
    })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const fakeCache = (callback) => {
    const entries = new Map();
    return (...args) => {
      const key = JSON.stringify(args);
      if (!entries.has(key)) entries.set(key, callback(...args));
      return entries.get(key);
    };
  };
  const { getBlockResolution } = loadTypeScriptModule('lib/seo.ts', {
    react: { cache: fakeCache },
    '@/lib/network': {
      getConfiguredNetwork: () => 'mainnet',
      normalizeApiBaseUrl: (url) => url,
    },
    '@/lib/api-config': {
      getApiUrlForNetwork: () => 'https://api.mainnet.cipherscan.app',
    },
    '@/lib/server-fetch': {
      fetchWithDeadline: (url, init) => global.fetch(url, init),
    },
  });

  assert.deepEqual(await getBlockResolution('not-a-block'), { state: 'absent' });
  assert.equal(requests.length, 0, 'invalid identifiers must not reach the API');
  assert.deepEqual(await getBlockResolution('404'), { state: 'absent' });
  assert.deepEqual(await getBlockResolution('410'), { state: 'absent' });
  assert.deepEqual(await getBlockResolution('503'), { state: 'unavailable' });
  assert.deepEqual(await getBlockResolution('504'), { state: 'unavailable' });
  assert.deepEqual(await getBlockResolution('505'), { state: 'unavailable' });
  assert.deepEqual(await getBlockResolution('506'), { state: 'unavailable' });

  const uppercaseHash = 'A'.repeat(64);
  const first = await getBlockResolution(uppercaseHash);
  const second = await getBlockResolution(uppercaseHash);
  assert.equal(first, second, 'the request cache should return one shared resolution');
  assert.equal(first.state, 'found');
  assert.equal(first.block.canonicalBlock.hash, 'c'.repeat(64));
  const hashRequests = requests.filter(({ identifier }) => identifier === uppercaseHash.toLowerCase());
  assert.equal(hashRequests.length, 1, 'metadata and page consumers should share one API request');
  assert.equal(hashRequests[0].init.next.revalidate, 30);
  assert.equal(new URL(requests.at(-1).url || 'https://invalid').searchParams.get('summary'), '1');
});

test('block summary feed avoids transaction detail fan-out', async () => {
  const callRoute = captureBlockApiRoute();
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return {
        rows: [{
          height: '3413458',
          hash: 'a'.repeat(64),
          timestamp: '1784150000',
          transaction_count: '7',
          size: '4096',
          miner_address: 't1example',
        }],
      };
    },
  };

  const response = await callRoute('3413458', { summary: '1' }, pool);
  assert.equal(response.statusCode, 200);
  assert.equal(queries.length, 1, 'summary lookup should perform only the bounded block query');
  assert.match(queries[0].sql, /FROM blocks/);
  assert.deepEqual(queries[0].params, [3413458]);
  assert.equal(queries.some(({ sql }) => /FROM transactions|transaction_inputs|transaction_outputs/.test(sql)), false);
  assert.deepEqual(response.body, {
    height: 3413458,
    hash: 'a'.repeat(64),
    timestamp: 1784150000,
    transaction_count: 7,
    transactionCount: 7,
    size: 4096,
    isOrphaned: false,
    miner_address: 't1example',
    miner_pool: 'Example Pool',
    miner_pool_url: 'https://pool.invalid',
    miner_pool_region: 'US',
    miner_pool_is_funding_stream: false,
  });
  assert.equal(
    response.headers.get('cache-control'),
    'public, s-maxage=30, stale-while-revalidate=300',
  );
});

test('block metadata uses resolved canonical identity through the shared builder', async () => {
  let resolution;
  let fetchTip = async () => new Response(JSON.stringify(v1Fixture({ height: 1_000 })), {
    headers: { 'content-type': 'application/json' },
  });
  const metadataCalls = [];
  const blockHash = 'd'.repeat(64);
  const layoutModule = loadTypeScriptModule('app/block/[height]/layout.tsx', {
    '@/lib/network-upgrades-server': { getUpgradeStats: async () => null },
    '@/lib/network-upgrades': { readUpgradeSnapshot: () => null, getFutureBlockUpgrade: () => null },
    '@/lib/isr-fallback': {
      retainLastGoodOrBuildFallback: (fallback) => fallback,
    },
    '@/lib/server-fetch': {
      fetchWithDeadline: (...args) => fetchTip(...args),
    },
    '@/lib/seo': {
      buildPageMetadata: (options) => {
        metadataCalls.push(options);
        return options;
      },
      formatNumber: (value) => Number(value).toLocaleString('en-US'),
      getApiUrl: () => 'https://api.invalid',
      getBlockResolution: async () => resolution,
      truncateHash: (value) => value,
    },
  });

  resolution = {
    state: 'found',
    block: {
      height: 123,
      hash: blockHash,
      timestamp: 0,
      transactionCount: '1',
      size: 1024,
      isOrphaned: false,
    },
  };
  await layoutModule.generateMetadata({ params: Promise.resolve({ height: blockHash }) });
  assert.equal(metadataCalls.at(-1).path, '/block/123');
  assert.equal(metadataCalls.at(-1).index, true);
  assert.equal(metadataCalls.at(-1).indexOnTestnet, undefined);
  assert.equal(metadataCalls.at(-1).description.includes('with 1 transaction'), true);
  // Canonical block descriptions identify the block by height, not a zero-padded hash.
  assert.equal(metadataCalls.at(-1).description.includes(blockHash.slice(0, 12)), false);

  resolution = {
    state: 'found',
    block: {
      height: 123,
      hash: blockHash,
      timestamp: 0,
      transactionCount: 2,
      isOrphaned: true,
      canonicalBlock: { hash: 'e'.repeat(64) },
    },
  };
  await layoutModule.generateMetadata({ params: Promise.resolve({ height: blockHash }) });
  assert.equal(metadataCalls.at(-1).path, `/block/${blockHash}`);
  assert.equal(metadataCalls.at(-1).index, true);
  // Orphan pages are keyed by hash, so the description names its distinguishing tail.
  assert.equal(metadataCalls.at(-1).description.includes(`…${blockHash.slice(-12)}`), true);

  resolution = { state: 'absent' };
  await layoutModule.generateMetadata({ params: Promise.resolve({ height: '999' }) });
  assert.equal(metadataCalls.at(-1).path, '/block/999');
  assert.equal(metadataCalls.at(-1).index, false);
  assert.equal(metadataCalls.at(-1).canonical, false);
  assert.equal(metadataCalls.at(-1).imageAlt, metadataCalls.at(-1).title);

  fetchTip = async () => new Response(null, { status: 503 });
  await assert.rejects(
    layoutModule.generateMetadata({ params: Promise.resolve({ height: '1001' }) }),
    /Chain tip returned HTTP 503/,
  );

  resolution = { state: 'unavailable' };
  await layoutModule.generateMetadata({ params: Promise.resolve({ height: '1000' }) });
  assert.equal(metadataCalls.at(-1).path, '/block/1000');
  assert.equal(metadataCalls.at(-1).index, false);
  assert.equal(metadataCalls.at(-1).canonical, undefined);
});

test('shared metadata policy indexes blocks only on mainnet', () => {
  const cases = [
    { network: 'mainnet', baseUrl: 'https://zecblock.com', index: true },
    { network: 'testnet', baseUrl: 'https://testnet.zecblock.com', index: false },
    { network: 'crosslink-testnet', baseUrl: 'https://crosslink.zecblock.com', index: false },
  ];

  for (const testCase of cases) {
    const seoModule = loadTypeScriptModule('lib/seo.ts', {
      react: { cache: (callback) => callback },
      '@/lib/network': {
        getConfiguredNetwork: () => testCase.network,
        normalizeApiBaseUrl: (url) => url,
      },
      '@/lib/api-config': {
        getApiUrlForNetwork: () => `https://api.${testCase.network}.cipherscan.app`,
      },
      '@/lib/server-fetch': {
        fetchWithDeadline: (url, init) => global.fetch(url, init),
      },
    });
    const metadata = seoModule.buildPageMetadata({
      title: 'Zcash Block #123 | CipherScan',
      description: 'Block metadata policy test.',
      path: '/block/123',
      index: true,
    });

    assert.equal(metadata.robots.index, testCase.index);
    assert.equal(metadata.robots.follow, true);
    assert.equal(metadata.alternates.canonical, `${testCase.baseUrl}/block/123`);
    assert.equal(metadata.openGraph.url, `${testCase.baseUrl}/block/123`);
  }
});

test('block consumers share one resolver and transaction JSON-LD escapes opening tags', () => {
  const blockLayout = fs.readFileSync(
    path.join(repositoryRoot, 'app/block/[height]/layout.tsx'),
    'utf8',
  );
  const blockPage = fs.readFileSync(
    path.join(repositoryRoot, 'app/block/[height]/page.tsx'),
    'utf8',
  );
  const txLayout = fs.readFileSync(
    path.join(repositoryRoot, 'app/tx/[txid]/layout.tsx'),
    'utf8',
  );

  assert.equal(blockLayout.includes('getBlockResolution(height)'), true);
  assert.equal(blockPage.includes('getBlockResolution(identifier)'), true);
  assert.equal(blockLayout.includes("from 'react'"), false);
  assert.equal(blockPage.includes("from 'react'"), false);
  assert.equal(blockLayout.includes('fetch('), false);
  assert.equal(blockPage.includes('fetch('), false);
  assert.equal(
    txLayout.includes("JSON.stringify(transactionJsonLd).replace(/</g, '\\\\u003c')"),
    true,
  );
});

test('sitemap serializers escape, deduplicate, bound, and omit ignored fields', () => {
  const sitemap = loadTypeScriptModule('lib/sitemaps.ts');
  const xml = sitemap.serializeUrlSet([
    { url: 'https://zecblock.com/a?x=1&y=<two>', lastModified: '2026-07-15' },
    { url: 'https://zecblock.com/a?x=1&y=<two>' },
  ]);

  assert.equal((xml.match(/<url>/g) || []).length, 1);
  assert.match(xml, /x=1&amp;y=&lt;two&gt;/);
  assert.match(xml, /<lastmod>2026-07-15T00:00:00.000Z<\/lastmod>/);
  assert.equal(xml.includes('<priority>'), false);
  assert.equal(xml.includes('<changefreq>'), false);

  const tooMany = Array.from({ length: sitemap.MAX_SITEMAP_URLS + 1 }, (_, index) => ({
    url: `https://zecblock.com/block/${index}`,
  }));
  assert.throws(() => sitemap.serializeUrlSet(tooMany), /cannot contain more than/);
});

test('sitemap cohorts are disjoint and block ranges require aligned explicit configuration', () => {
  const sitemap = loadTypeScriptModule('lib/sitemaps.ts');
  const ranges = sitemap.getConfiguredBlockSitemapRanges('3350000', '3449999');
  assert.deepEqual(ranges, [
    { start: 3350000, end: 3399999, slug: 'blocks-3350000-3399999' },
    { start: 3400000, end: 3449999, slug: 'blocks-3400000-3449999' },
  ]);
  assert.deepEqual(sitemap.getConfiguredBlockSitemapRanges(undefined, undefined), []);
  assert.deepEqual(sitemap.getConfiguredBlockSitemapRanges('3350001', '3449999'), []);
  assert.equal(sitemap.getBlockSitemapRange('blocks-1-50000', ranges), null);

  const newsletters = [{
    slug: '2026-07-15', title: 'Issue', summary: '', date: '2026-07-15', issue: 1, content: '',
  }];
  const core = sitemap.getStaticSitemapEntries('core', 'https://zecblock.com', newsletters);
  const content = sitemap.getStaticSitemapEntries('content', 'https://zecblock.com', newsletters);
  const tools = sitemap.getStaticSitemapEntries('tools', 'https://zecblock.com', newsletters);
  const allUrls = [...core, ...content, ...tools].map((entry) => entry.url);

  assert.equal(new Set(allUrls).size, allUrls.length);
  assert.ok(allUrls.some((url) => url === 'https://zecblock.com/privacy/wallets'));
  assert.ok(allUrls.some((url) => url === 'https://zecblock.com/newsletter/2026-07-15'));
  assert.ok(allUrls.some((url) => url === 'https://zecblock.com/tools/unit-converter'));
  assert.equal(allUrls.some((url) => url === 'https://zecblock.com/migration'), false);

  const indexEntries = sitemap.getMainnetSitemapIndexEntries('https://zecblock.com', ranges);
  assert.ok(indexEntries.some(({ url }) => url === 'https://zecblock.com/sitemap-core.xml'));
  assert.ok(indexEntries.some(({ url }) => (
    url === 'https://zecblock.com/sitemap-blocks-3400000-3449999.xml'
  )));
});

test('legacy migration and swap routes permanently consolidate authority', async () => {
  const configModule = loadTypeScriptModule('next.config.ts');
  const redirects = await configModule.default.redirects();
  const rewrites = await configModule.default.rewrites();

  assert.ok(redirects.some((redirect) => (
    redirect.source === '/migration'
    && redirect.destination === '/ironwood'
    && redirect.permanent === true
  )));
  assert.ok(redirects.some((redirect) => (
    redirect.source === '/swap'
    && redirect.destination === 'https://cipherswap.app/'
    && redirect.permanent === true
  )));
  assert.deepEqual(rewrites.afterFiles, [{
    source: '/sitemap-:slug.xml',
    destination: '/sitemaps/:slug',
  }]);
  assert.deepEqual(rewrites.fallback, []);

  const latestRoutes = [
    ['/txs', '/txs/latest', ['cursor', 'cursor_idx', 'cursor_id', 'direction', 'page', 'type', 'flow_type', 'pool', 'min_zec']],
  ];
  for (const [source, destination, queryKeys] of latestRoutes) {
    const rewrite = rewrites.beforeFiles.find((candidate) => candidate.source === source);
    assert.equal(rewrite.destination, destination);
    assert.deepEqual(rewrite.missing, queryKeys.map((key) => ({ type: 'query', key })));
  }
  assert.equal(rewrites.beforeFiles.some((route) => route.source === '/blocks'), false);
  // https://github.com/vercel/vercel/blob/main/packages/routing-utils/src/schemas.ts
  // Next accepts larger arrays, but Vercel rejects them after a successful build.
  for (const route of [...redirects, ...Object.values(rewrites).flat()]) {
    for (const condition of ['has', 'missing']) {
      assert.ok((route[condition]?.length ?? 0) <= 16, `${route.source}: too many ${condition} conditions for Vercel`);
    }
  }
});

test('root sitemap is a mainnet index, a testnet homepage set, and an empty Crosslink set', async () => {
  const sitemap = loadTypeScriptModule('lib/sitemaps.ts');
  const cases = [
    { network: 'mainnet', baseUrl: 'https://zecblock.com', root: 'sitemapindex' },
    { network: 'testnet', baseUrl: 'https://testnet.zecblock.com', root: 'urlset' },
    { network: 'crosslink-testnet', baseUrl: null, root: 'urlset' },
  ];

  for (const testCase of cases) {
    let baseUrlCalls = 0;
    const route = loadTypeScriptModule('app/sitemap.xml/route.ts', {
      '@/lib/seo': {
        getNetwork: () => testCase.network,
        getBaseUrl: () => {
          baseUrlCalls += 1;
          return testCase.baseUrl;
        },
      },
      '@/lib/sitemaps': sitemap,
    });
    const response = route.GET();
    const xml = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/xml/);
    assert.match(xml, new RegExp(`<${testCase.root}`));

    if (testCase.network === 'mainnet') {
      assert.match(xml, /https:\/\/zecblock\.com\/sitemap-core\.xml/);
      assert.equal(xml.includes('<priority>'), false);
    } else if (testCase.network === 'testnet') {
      assert.match(xml, /https:\/\/testnet\.zecblock\.com\//);
      assert.equal(xml.includes('/blocks'), false);
    } else {
      assert.equal(baseUrlCalls, 0);
      assert.equal(xml.includes('<url>'), false);
    }
  }
});

test('child sitemap isolates static cohorts and returns explicit 404/503 failures', async (t) => {
  const sitemap = loadTypeScriptModule('lib/sitemaps.ts');
  const refreshCache = loadTypeScriptModule('lib/refresh-cache.ts');
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const loadRoute = (network = 'mainnet') => loadTypeScriptModule('app/sitemaps/[slug]/route.ts', {
    'next/cache': { unstable_cache: (callback) => callback },
    '@/lib/governance-data': { getGovernanceCatalog: async () => ({ votes: [], checkedAt: 0, unavailable: true }) },
    '@/lib/governance': { isGrantsRound: () => false },
    '@/lib/newsletter': { getAllNewsletters: () => [] },
    '@/lib/refresh-cache': refreshCache,
    '@/lib/seo': {
      getApiUrl: () => 'https://api.mainnet.cipherscan.app',
      getBaseUrl: () => 'https://zecblock.com',
      getNetwork: () => network,
    },
    '@/lib/sitemaps': sitemap,
    '@/lib/zns': {
      getZnsStatus: async () => ({ registered: 0 }),
      isValidName: () => true,
      listZnsRegistrations: async () => [],
    },
  });

  global.fetch = async () => new Response(null, { status: 503 });
  const route = loadRoute();
  const core = await route.GET(new Request('https://zecblock.com/sitemaps/core'), {
    params: Promise.resolve({ slug: 'core' }),
  });
  assert.equal(core.status, 200);
  assert.match(await core.text(), /https:\/\/zecblock\.com\/privacy\/wallets/);

  const unavailable = await route.GET(new Request('https://zecblock.com/sitemaps/addresses'), {
    params: Promise.resolve({ slug: 'addresses' }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('retry-after'), '60');

  const unknown = await route.GET(new Request('https://zecblock.com/sitemaps/blocks-1-50000'), {
    params: Promise.resolve({ slug: 'blocks-1-50000' }),
  });
  assert.equal(unknown.status, 404);

  const testnetRoute = loadRoute('testnet');
  const testnetChild = await testnetRoute.GET(new Request('https://testnet.zecblock.com/sitemaps/core'), {
    params: Promise.resolve({ slug: 'core' }),
  });
  assert.equal(testnetChild.status, 404);
});

function nameRegistration(name) {
  return { name, address: 'u1publicregistration', txid: 'a'.repeat(64), height: 3500000, lastAction: 'claim', expiresAt: 'none' };
}

function loadNamesSitemapRoute(listZnsRegistrations, { network = 'mainnet', getZnsStatus = async () => ({ syncedHeight: 3500000, synced: true }) } = {}) {
  const sitemap = loadTypeScriptModule('lib/sitemaps.ts');
  const refreshCache = loadTypeScriptModule('lib/refresh-cache.ts');
  return loadTypeScriptModule('app/sitemaps/[slug]/route.ts', {
    'next/cache': { unstable_cache: (callback) => callback },
    '@/lib/governance-data': { getGovernanceCatalog: async () => ({ votes: [], checkedAt: 0, unavailable: true }) },
    '@/lib/governance': { isGrantsRound: () => false },
    '@/lib/newsletter': { getAllNewsletters: () => [] },
    '@/lib/refresh-cache': refreshCache,
    '@/lib/seo': {
      getApiUrl: () => 'https://api.mainnet.cipherscan.app',
      getBaseUrl: () => 'https://zecblock.com',
      getNetwork: () => network,
    },
    '@/lib/sitemaps': sitemap,
    '@/lib/zns': {
      getZnsStatus,
      isValidName: (name) => /^[a-z0-9]{1,62}$/.test(name),
      listZnsRegistrations,
    },
  });
}

function requestNamesSitemap(route) {
  return route.GET(new Request('https://zecblock.com/sitemaps/names'), {
    params: Promise.resolve({ slug: 'names' }),
  });
}

test('ZNS child sitemap coalesces one bounded registration refresh without a status count', async () => {
  let statusCalls = 0;
  const calls = [];
  const route = loadNamesSitemapRoute(async (limit, cursor, signal) => {
    calls.push({ limit, cursor, signal });
    const offset = Number(cursor || 0);
    return { items: Array.from({ length: limit }, (_, index) => nameRegistration(`name${offset + index}`)), page: { nextCursor: String(offset + limit), hasNext: true } };
  }, { getZnsStatus: async () => { statusCalls += 1; return { syncedHeight: 3500000, synced: true }; } });

  const responses = await Promise.all(Array.from({ length: 3 }, () => requestNamesSitemap(route)));
  const bodies = await Promise.all(responses.map((response) => response.text()));
  assert.equal(statusCalls, 0, 'sync status no longer gates registration discovery');
  assert.equal(calls.length, 10, 'a refresh cannot request more than ten pages');
  assert.ok(calls.every((call) => call.limit === 500));
  assert.equal(new Set(calls.map((call) => call.signal)).size, 1, 'all pages share one deadline');
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.ok(bodies.every((body) => [...body.matchAll(/<loc>/g)].length === 5000));
  assert.ok(bodies.every((body) => [...body.matchAll(/<loc>(.*?)<\/loc>/g)].some((match) => match[1] === 'https://zecblock.com/name/name4999')));
});

test('ZNS sitemap follows opaque collection cursors and emits each valid registration once', async () => {
  const cursors = [];
  const route = loadNamesSitemapRoute(async (_limit, cursor) => {
    cursors.push(cursor);
    return cursor === null
      ? { items: [nameRegistration('alpha'), nameRegistration('alpha'), { name: 'bad-name' }], page: { hasNext: true, nextCursor: 'opaque-next-page' } }
      : { items: [nameRegistration('beta')], page: { hasNext: false, nextCursor: null } };
  });
  const response = await requestNamesSitemap(route);
  assert.equal(response.status, 200);
  const urls = [...(await response.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(urls, ['https://zecblock.com/name/alpha', 'https://zecblock.com/name/beta']);
  assert.deepEqual(cursors, [null, 'opaque-next-page']);
});

test('an authoritative empty name collection produces an empty successful sitemap', async () => {
  let calls = 0;
  const route = loadNamesSitemapRoute(async () => { calls += 1; return { items: [], page: { hasNext: false, nextCursor: null } }; });
  const response = await requestNamesSitemap(route);
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes('<loc>'), false);
  assert.equal(calls, 1, 'an empty registry is established by its collection response');
});

test('failed or malformed name discovery never publishes a partial successful sitemap', async (t) => {
  t.mock.method(console, 'error', () => {});
  const validPage = { items: [nameRegistration('alpha')], page: { hasNext: true, nextCursor: 'next' } };
  const cases = [
    ['first page failure', async () => { throw new Error('unavailable'); }],
    ['later page failure', async (_limit, cursor) => { if (cursor) throw new Error('unavailable'); return validPage; }],
    ['repeated cursor', async () => validPage],
    ['missing cursor', async () => ({ ...validPage, page: { hasNext: true, nextCursor: null } })],
    ['empty advancing page', async () => ({ ...validPage, items: [] })],
    ['oversized collection', async () => ({ items: Array.from({ length: 501 }, (_, i) => nameRegistration(`name${i}`)), page: { hasNext: false, nextCursor: null } })],
    ['incomplete registration', async () => ({ items: [{ name: 'alpha', address: '' }], page: { hasNext: false, nextCursor: null } })],
    ['no usable registrations', async () => ({ items: [{ name: 'bad-name' }], page: { hasNext: false, nextCursor: null } })],
  ];
  for (const [label, read] of cases) {
    await t.test(label, async () => {
      const response = await requestNamesSitemap(loadNamesSitemapRoute(read));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal((await response.text()).includes('<loc>'), false);
    });
  }
});

test('testnet and Crosslink name sitemaps stay excluded without reading the registry', async () => {
  let calls = 0;
  for (const network of ['testnet', 'crosslink-testnet']) {
    const route = loadNamesSitemapRoute(async () => { calls += 1; throw new Error('must not fetch'); }, { network });
    const response = await requestNamesSitemap(route);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  }
  assert.equal(calls, 0);
});

test('transaction archive metadata indexes only unfiltered first pages', async () => {
  const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') };
  const sharedMocks = {
    'react/jsx-runtime': jsxRuntime,
    './TxsClient': { __esModule: true, default: () => null },
    '@/lib/transaction-list': loadTypeScriptModule('lib/transaction-list.ts'),
    '@/lib/api-config': { getApiUrl: () => 'https://api.mainnet.cipherscan.app' },
    '@/lib/isr-fallback': {
      retainLastGoodOrBuildFallback: (fallback) => fallback,
    },
    '@/lib/seo': {
      buildPageMetadata: (options) => options,
      getBaseUrl: () => 'https://zecblock.com',
    },
    '@/lib/server-fetch': {
      fetchWithDeadline: (url, init) => global.fetch(url, init),
      isServerRenderDeadlineError: () => false,
    },
  };
  const renderModule = loadTypeScriptModule('app/txs/render.tsx', sharedMocks);
  const loadPage = (relativePath, componentSpecifier) => loadTypeScriptModule(relativePath, {
    ...sharedMocks,
    [componentSpecifier]: { __esModule: true, default: () => null },
    './render': renderModule,
  });
  const txs = loadPage('app/txs/page.tsx', './TxsClient');

  const txFirst = await txs.generateMetadata({ searchParams: Promise.resolve({}) });
  const txArchive = await txs.generateMetadata({
    searchParams: Promise.resolve({ cursor: Buffer.from(JSON.stringify({ v: 1, route: '/v1/transactions', cursor: 100, cursor_idx: 1 })).toString('base64url'), direction: 'next', page: '2' }),
  });
  const txFilter = await txs.generateMetadata({ searchParams: Promise.resolve({ type: 'coinbase' }) });
  assert.equal(txFirst.index, true);
  assert.equal(txArchive.index, false);
  assert.match(txArchive.path, /^\/txs\?cursor=/);
  assert.equal(txFilter.index, false);
  assert.equal(txFilter.path, '/txs');

  const shieldedFirst = await txs.generateMetadata({ searchParams: Promise.resolve({ type: 'shielded' }) });
  const shieldedArchive = await txs.generateMetadata({
    searchParams: Promise.resolve({ type: 'shielded', cursor: Buffer.from(JSON.stringify({ v: 1, route: '/v1/transactions/shielded', cursor: 100, cursor_id: 1 })).toString('base64url'), direction: 'next', page: '2' }),
  });
  const shieldedFilter = await txs.generateMetadata({
    searchParams: Promise.resolve({ type: 'shielded', pool: 'orchard' }),
  });
  assert.equal(shieldedFirst.index, true);
  assert.equal(shieldedArchive.index, false);
  assert.match(shieldedArchive.path, /^\/txs\?type=shielded/);
  assert.equal(shieldedFilter.index, false);
  assert.equal(shieldedFilter.path, '/txs?type=shielded');
});

test('sitemap API feeds enforce bounds and canonical transaction identity', async () => {
  const callRoute = captureSitemapApiRoutes();
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('MAX(height)')) return { rows: [{ tip: 3_450_001 }] };
      if (sql.includes('FROM blocks')) {
        return { rows: [{ height: 3_400_000, timestamp: 1_784_000_000 }] };
      }
      return {
        rows: Array.from({ length: 100 }, (_, index) => ({
          txid: index.toString(16).padStart(64, '0'),
          block_time: 1_784_000_000 - index,
        })),
      };
    },
  };

  const invalid = await callRoute('/api/sitemaps/blocks', {
    start: '0',
    end: '50000',
  }, pool);
  assert.equal(invalid.statusCode, 400);
  assert.equal(queries.length, 0, 'invalid ranges must not query PostgreSQL');

  const blocks = await callRoute('/api/sitemaps/blocks', {
    start: '3400000',
    end: '3449999',
  }, pool);
  assert.equal(blocks.statusCode, 200);
  assert.deepEqual(blocks.body.blocks, [{ height: 3_400_000, timestamp: 1_784_000_000 }]);
  assert.equal(blocks.body.complete, true);
  assert.deepEqual(queries[0].params, [3_400_000, 3_449_999]);

  queries.length = 0;
  const transactions = await callRoute('/api/sitemaps/transactions/recent', {}, pool);
  assert.equal(transactions.statusCode, 200);
  assert.equal(transactions.body.transactions.length, 100);
  assert.match(queries[0].sql, /JOIN blocks b ON b\.height = t\.block_height AND b\.hash = t\.block_hash/);
  assert.match(queries[0].sql, /ORDER BY t\.block_height DESC, t\.tx_index DESC/);
  assert.deepEqual(queries[0].params, [100]);
  assert.equal(queries[0].sql.includes('mempool'), false);
});

test('crawl graph avoids canonical block aliases and known shared redirect targets', () => {
  const blocksClient = fs.readFileSync(
    path.join(repositoryRoot, 'app/blocks/BlocksClient.tsx'),
    'utf8',
  );
  const reorgs = fs.readFileSync(path.join(repositoryRoot, 'app/reorgs/page.tsx'), 'utf8');
  const footer = fs.readFileSync(path.join(repositoryRoot, 'components/Footer.tsx'), 'utf8');
  const sitemapDefinitions = fs.readFileSync(
    path.join(repositoryRoot, 'lib/sitemaps.ts'),
    'utf8',
  );
  const richListPage = fs.readFileSync(path.join(repositoryRoot, 'app/rich-list/page.tsx'), 'utf8');
  const richListClient = fs.readFileSync(
    path.join(repositoryRoot, 'app/rich-list/RichListClient.tsx'),
    'utf8',
  );

  assert.equal(blocksClient.includes('href={`/block/${block.hash.toLowerCase()}`'), false);
  assert.equal(reorgs.includes('href={`/block/${block.canonicalBlock?.hash || block.canonicalHash}`'), false);
  assert.match(footer, /href="https:\/\/www\.cipherpay\.app\/"/);
  const footerHrefs = [...footer.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(footerHrefs.some((href) => href === 'https://www.cipherpay.app/en'), false);
  assert.match(footer, /getNavigation/);
  assert.match(fs.readFileSync(path.join(repositoryRoot, 'lib/navigation.ts'), 'utf8'), /href: '\/charts'/);
  assert.match(sitemapDefinitions, /['"]\/usage-clock['"]/);
  assert.match(richListPage, /next: \{ revalidate: 60 \}/);
  assert.match(richListClient, /initialAddresses/);
  assert.match(richListClient, /href=\{`\/address\/\$\{entry\.address\}`\}/);

  const content = fs.readFileSync(
    path.join(repositoryRoot, 'content/newsletter/weekly-2026-05-03.md'),
    'utf8',
  );
  assert.equal(content.includes('github.com/ZcashFoundation/zebra/security/advisories/GHSA-28xj-328h-72vm'), false);
  assert.equal(content.includes('github.com/ZcashFoundation/zebra/security/advisories/GHSA-jg86-rwhm-fhg4'), false);
});

function v1Fixture(body) {
 const { success, ...rest } = body;
 const collection = rest.pagination && (rest.blocks || rest.transactions || rest.flows);
 return { data: collection || rest, meta: { requestId: '00000000-0000-4000-8000-000000000000', network: 'mainnet', generatedAt: '2026-09-07T00:00:00.000Z', indexedHeight: 123, source: { indexedHeight: null, observedAt: null }, freshness: { status: 'unknown', ageSeconds: null }, ...(collection ? { page: { limit: 25, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null, total: rest.pagination.total ?? 0 } } : {}) } };
}


test('robots omit unsupported Googlebot crawl delays on every network', () => {
 const previous=process.env.NEXT_PUBLIC_NETWORK;
 try {
  for(const network of ['mainnet','testnet','crosslink-testnet']) {
   process.env.NEXT_PUBLIC_NETWORK=network;
   const {default:robots}=loadTypeScriptModule('app/robots.ts', {'@/lib/seo': {getNetwork:()=>network,getBaseUrl:()=> 'https://zecblock.com'}});
   const rules=[robots().rules].flat();
   for(const rule of rules) if([rule.userAgent].flat().includes('Googlebot')) assert.equal(rule.crawlDelay,undefined);
  }
 } finally { if(previous===undefined)delete process.env.NEXT_PUBLIC_NETWORK;else process.env.NEXT_PUBLIC_NETWORK=previous; }
});


test('only mainnet permits its exact public announcement render dependency', () => {
  for (const network of ['mainnet', 'testnet', 'crosslink-testnet']) {
    const { default: robots } = loadTypeScriptModule('app/robots.ts', {
      '@/lib/seo': { getNetwork: () => network, getBaseUrl: () => 'https://zecblock.com' },
    });
    for (const rule of [robots().rules].flat()) {
      const allow = [rule.allow].flat();
      assert.equal(allow.includes('/api/governance/announcement$'), network === 'mainnet');
      assert.deepEqual(Array.from(rule.disallow), ['/api/']);
      assert.ok(allow.every(path => path === '/' || path === '/api/governance/announcement$'));
    }
  }
});
