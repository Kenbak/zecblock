const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const ts = require('typescript');

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
    if (Object.prototype.hasOwnProperty.call(imports, specifier)) return imports[specifier];
    if (specifier === '@/lib/network-upgrades-server') return { getUpgradeStats: async () => null };
    if (specifier === '@/lib/network-upgrades') return { readUpgradeSnapshot: () => null, getFutureBlockUpgrade: () => null };
    if (specifier === '@/lib/api-client') return loadTypeScriptModule('lib/api-client.ts');
    return require(specifier);
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
    if (Object.prototype.hasOwnProperty.call(imports, specifier)) return imports[specifier];
    return require(specifier);
  };
  const evaluate = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
  evaluate(module.exports, localRequire, module, filename, path.dirname(filename));
  return module.exports;
}

function captureTransactionRoutes() {
  const handlers = new Map();
  let middleware;

  const helpers = require('../api/routes/transactions/_helpers');
  middleware = helpers.injectDependencies;

  const detailPath = path.join(repositoryRoot, 'server/api/routes/transactions/tx-detail.js');
  const detailSource = fs.readFileSync(detailPath, 'utf8');
  const detailModule = { exports: {} };
  const detailRequire = (specifier) => {
    if (specifier === 'express') return { Router: () => ({ get: (route, ...cbs) => handlers.set(route, cbs.at(-1)), post: (route, ...cbs) => handlers.set(route, cbs.at(-1)) }) };
    if (specifier === '../../validation') return { validate: () => (_req, _res, next) => next() };
    if (specifier === '../../coinbase-data') return { decodeCoinbaseText: () => null };
    if (specifier === './_helpers') return helpers;
    if (specifier === '../../lib/safe-log') return require('../api/lib/safe-log');
    return createRequire(detailPath)(specifier);
  };
  const detailEval = new Function('exports', 'require', 'module', '__filename', '__dirname', detailSource);
  detailEval(detailModule.exports, detailRequire, detailModule, detailPath, path.dirname(detailPath));

  return { handlers, middleware };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: undefined,
    set(name, value) { this.headers.set(name.toLowerCase(), value); return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('page probe measures headers and complete response body separately', async () => {
  const probeUrl = pathToFileURL(
    path.join(repositoryRoot, 'scripts/perf/probe-slow-pages.mjs'),
  ).href;
  const { probePageLoad } = await import(probeUrl);
  let clock = 0;
  let bodyConsumed = false;
  const result = await probePageLoad('https://cipherscan.invalid/blocks', {
    now: () => clock,
    fetchImpl: async () => {
      clock = 20;
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          bodyConsumed = true;
          clock = 75;
          return new ArrayBuffer(0);
        },
      };
    },
  });

  assert.equal(bodyConsumed, true);
  assert.deepEqual(result, {
    ttfb: 20,
    load: 75,
    afterTtfb: 55,
    status: 200,
    ok: true,
  });
});

test('server-render fetches abort a hung origin inside their deadline', async () => {
  const {
    fetchWithDeadline,
    isServerRenderDeadlineError,
    getServerRenderFetchTimeoutMs,
    SERVER_RENDER_BUILD_FETCH_TIMEOUT_MS,
    SERVER_RENDER_DEV_FETCH_TIMEOUT_MS,
    SERVER_RENDER_FETCH_TIMEOUT_MS,
  } = loadTypeScriptModule('lib/server-fetch.ts', { './api-config': { getApiUrl: () => 'https://api.invalid' } });
  assert.ok(
    SERVER_RENDER_FETCH_TIMEOUT_MS <= 1_000,
    'the production page budget must stay below the 2s TTFB target',
  );
  const started = performance.now();

  let deadlineError;
  await assert.rejects(
    fetchWithDeadline(
      'https://api.invalid/hangs',
      {},
      30,
      (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
    ),
    (error) => {
      deadlineError = error;
      return error.name === 'TimeoutError';
    },
  );
  assert.equal(isServerRenderDeadlineError(deadlineError), true);

  assert.ok(
    performance.now() - started < 250,
    'a hung origin must not consume a multi-second page budget',
  );

  const originalPhase = process.env.NEXT_PHASE;
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.NEXT_PHASE;
    process.env.NODE_ENV = 'production';
    assert.equal(getServerRenderFetchTimeoutMs(), SERVER_RENDER_FETCH_TIMEOUT_MS);

    process.env.NODE_ENV = 'development';
    assert.equal(getServerRenderFetchTimeoutMs(), SERVER_RENDER_DEV_FETCH_TIMEOUT_MS);

    process.env.NODE_ENV = 'production';
    process.env.NEXT_PHASE = 'phase-production-build';
    assert.equal(
      getServerRenderFetchTimeoutMs(),
      SERVER_RENDER_BUILD_FETCH_TIMEOUT_MS,
    );

    process.env.NEXT_PHASE = 'phase-production-server';
    assert.equal(getServerRenderFetchTimeoutMs(), SERVER_RENDER_FETCH_TIMEOUT_MS);
  } finally {
    if (originalPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = originalPhase;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('all list SSR fetches use chain-tip tagged ISR with deadline', async () => {
  const requests = [];
  const fetchWithDeadline = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(v1Fixture({
      success: true,
      blocks: [],
      transactions: [],
      flows: [],
      pagination: {},
    })), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: Symbol('Fragment'),
  };
  const commonImports = {
    'react/jsx-runtime': jsxRuntime,
    '@/lib/api-config': { getApiUrl: () => 'https://api.invalid' },
    '@/lib/isr-fallback': {
      retainLastGoodOrBuildFallback: (fallback) => fallback,
    },
    '@/lib/seo': {
      buildPageMetadata: (options) => options,
      getBaseUrl: () => 'https://cipherscan.app',
    },
    '@/lib/server-fetch': { fetchWithDeadline, isServerRenderDeadlineError: () => false },
  };
  const txsRender = loadTypeScriptModule('app/txs/render.tsx', {
    ...commonImports,
    './TxsClient': { __esModule: true, default: () => null },
    '@/lib/transaction-list': loadTypeScriptModule('lib/transaction-list.ts'),
  });
  const pages = [
    loadTypeScriptModule('app/blocks/BlocksPage.tsx', {
      ...commonImports,
      './BlocksClient': { __esModule: true, default: () => null },
    }),
    loadTypeScriptModule('app/txs/page.tsx', {
      ...commonImports,
      './TxsClient': { __esModule: true, default: () => null },
      '@/lib/transaction-list': loadTypeScriptModule('lib/transaction-list.ts'),
      './render': txsRender,
    }),
  ];

  for (const page of pages) {
    await page.default({ searchParams: Promise.resolve({}) });
  }
  // txs page with type=shielded triggers the shielded list fetch
  await pages[1].default({ searchParams: Promise.resolve({ type: 'shielded' }) });

  assert.equal(requests.length, 3);
  assert.ok(requests.some(({ url }) => url.includes('/v1/blocks?')));
  assert.ok(requests.some(({ url }) => url.includes('/v1/transactions?')));
  assert.ok(requests.some(({ url }) => url.includes('/v1/transactions/shielded?')));
  assert.ok(requests.every(({ init }) => init.next.revalidate === 30));
  assert.ok(requests.every(({ init }) => init.next.tags?.includes('chain-tip')));
  assert.ok(requests.every(({ init }) => init.cache !== 'no-store'));
});

test('latest list ISR throws on unavailable data while dynamic handlers keep shells', async () => {
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: Symbol('Fragment'),
  };
  const failures = [
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response(JSON.stringify(v1Fixture({ success: true })), {
      headers: { 'content-type': 'application/json' },
    }),
    async () => { throw new Error('network unavailable'); },
  ];

  // Shared blocks renderer accepts the internal outage policy; route entry props stay Next-compatible.
  for (const failure of failures) {
    const page = loadTypeScriptModule('app/blocks/BlocksPage.tsx', {
      'react/jsx-runtime': jsxRuntime,
      './BlocksClient': { __esModule: true, default: () => null },
      '@/lib/api-config': { getApiUrl: () => 'https://api.invalid' },
      '@/lib/isr-fallback': {
        retainLastGoodOrBuildFallback: (_fallback, error) => { throw error; },
      },
      '@/lib/seo': {
        buildPageMetadata: (options) => options,
        getBaseUrl: () => 'https://cipherscan.app',
      },
      '@/lib/server-fetch': {
        fetchWithDeadline: failure,
        isServerRenderDeadlineError: () => true,
      },
    });

    await assert.doesNotReject(page.default({ searchParams: Promise.resolve({}) }));
    await assert.rejects(page.default({
      searchParams: Promise.resolve({}),
      unavailablePolicy: 'throw',
    }));
  }

  // txs/page.tsx delegates to renderTransactionsPage which defaults to 'shell',
  // so unavailable data produces a shell rather than throwing
  for (const failure of failures) {
    const txsImports = {
      'react/jsx-runtime': jsxRuntime,
      './TxsClient': { __esModule: true, default: () => null },
      '@/lib/transaction-list': loadTypeScriptModule('lib/transaction-list.ts'),
      '@/lib/api-config': { getApiUrl: () => 'https://api.invalid' },
      '@/lib/isr-fallback': {
        retainLastGoodOrBuildFallback: (fallback) => fallback,
      },
      '@/lib/seo': {
        buildPageMetadata: (options) => options,
        getBaseUrl: () => 'https://cipherscan.app',
      },
      '@/lib/server-fetch': {
        fetchWithDeadline: failure,
        isServerRenderDeadlineError: () => true,
      },
    };
    txsImports['./render'] = loadTypeScriptModule('app/txs/render.tsx', txsImports);
    const page = loadTypeScriptModule('app/txs/page.tsx', txsImports);

    await assert.doesNotReject(page.default({ searchParams: Promise.resolve({}) }));
  }
});

test('server metadata uses lightweight endpoints with deadlines', async () => {
  const requests = [];
  const transactionId = 'a'.repeat(64);
  const fetchWithDeadline = async (url, init) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, init });

    if (requestUrl.endsWith('/v1/network/info')) {
      return new Response(JSON.stringify(v1Fixture({ height: 3000 })));
    }
    if (requestUrl.includes('/v1/blocks/')) {
      return new Response(JSON.stringify(v1Fixture({
        height: 123,
        hash: 'b'.repeat(64),
        timestamp: 1_700_000_000,
        transactionCount: 2,
        size: 1024,
      })));
    }
    if (requestUrl.includes('/v1/transactions/') && requestUrl.endsWith('/summary')) {
      return new Response(JSON.stringify(v1Fixture({
        txid: transactionId,
        blockHeight: 123,
        blockTime: 1_700_000_000,
        confirmations: 10,
        isCanonical: true,
        status: 'confirmed',
        hasOrchard: true,
      })));
    }
    return new Response(JSON.stringify(v1Fixture({
      address: 't1example',
      balance: 100_000_000,
      type: 'transparent',
      txCount: 1,
    })));
  };
  const seo = loadTypeScriptModule('lib/seo.ts', {
    react: { cache: (callback) => callback },
    '@/lib/network': {
      getConfiguredNetwork: () => 'mainnet',
      normalizeApiBaseUrl: (url) => url,
    },
    '@/lib/api-config': {
      getApiUrlForNetwork: () => 'https://api.mainnet.cipherscan.app',
    },
    '@/lib/server-fetch': { fetchWithDeadline },
  });

  const block = await seo.getBlockResolution('123');
  const transaction = await seo.getTxResolution(transactionId);
  const address = await seo.getAddressResolution('t1example');

  assert.equal(block.state, 'found');
  assert.equal(transaction.state, 'found');
  assert.equal(transaction.meta.hasShielded, true);
  assert.equal(address.state, 'found');
  assert.match(requests[0].url, /\/v1\/network\/info$/);
  assert.match(requests[1].url, /\/v1\/blocks\/123\?summary=1$/);
  assert.match(requests[2].url, /\/v1\/transactions\/[a-f0-9]{64}\/summary$/);
  assert.match(requests[3].url, /\/v1\/addresses\/t1example\?limit=1$/);
  assert.deepEqual(requests.map(({ init }) => init.next.revalidate), [3600, 3600, 300, 60]);
});

test('ISR outage shells require the exact offline-build opt-in', () => {
  const original = process.env.CIPHERSCAN_ALLOW_BUILD_UPSTREAM_FALLBACK;
  const {
    isIsrBuildFallbackEnabled,
    retainLastGoodOrBuildFallback,
  } = loadTypeScriptModule('lib/isr-fallback.ts');

  try {
    delete process.env.CIPHERSCAN_ALLOW_BUILD_UPSTREAM_FALLBACK;
    assert.equal(isIsrBuildFallbackEnabled(), false);
    assert.throws(
      () => retainLastGoodOrBuildFallback('empty', new Error('offline'), 'test route'),
      /offline/,
    );

    process.env.CIPHERSCAN_ALLOW_BUILD_UPSTREAM_FALLBACK = 'true';
    assert.equal(isIsrBuildFallbackEnabled(), false);
    assert.throws(
      () => retainLastGoodOrBuildFallback('empty', null, 'test route'),
      /test route is unavailable/,
    );

    process.env.CIPHERSCAN_ALLOW_BUILD_UPSTREAM_FALLBACK = '1';
    assert.equal(isIsrBuildFallbackEnabled(), true);
    assert.equal(
      retainLastGoodOrBuildFallback('empty', new Error('offline'), 'test route'),
      'empty',
    );
  } finally {
    if (original === undefined) delete process.env.CIPHERSCAN_ALLOW_BUILD_UPSTREAM_FALLBACK;
    else process.env.CIPHERSCAN_ALLOW_BUILD_UPSTREAM_FALLBACK = original;
  }
});

test('future-block ISR propagates chain-tip outages instead of caching a not-found result', async () => {
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: Symbol('Fragment'),
  };
  const failures = [
    {
      fetchWithDeadline: async () => new Response(null, { status: 503 }),
      expected: /Chain tip returned HTTP 503/,
    },
    {
      fetchWithDeadline: async () => new Response(JSON.stringify(v1Fixture({ height: null })), {
        headers: { 'content-type': 'application/json' },
      }),
      expected: /Chain tip payload is malformed/,
    },
  ];

  for (const failure of failures) {
    const page = loadTypeScriptModule('app/block/[height]/page.tsx', {
      'react/jsx-runtime': jsxRuntime,
      'next/navigation': {
        notFound: () => { throw new Error('notFound must not run during a tip outage'); },
      },
      '@/lib/isr-fallback': {
        retainLastGoodOrBuildFallback: (_fallback, error) => { throw error; },
      },
      '@/lib/seo': {
        getApiUrl: () => 'https://api.invalid',
        getBlockResolution: async () => ({ state: 'absent' }),
      },
      '@/lib/server-fetch': {
        fetchWithDeadline: failure.fetchWithDeadline,
      },
      './BlockPageClient': { __esModule: true, default: () => null },
      './FutureBlockView': { FutureBlockView: () => null },
    });

    await assert.rejects(
      page.default({ params: Promise.resolve({ height: '9999999' }) }),
      failure.expected,
    );
  }
});

test('homepage, rich list, and detail HTML opt into the Next full route cache', () => {
  const source = (relativePath) => fs.readFileSync(
    path.join(repositoryRoot, relativePath),
    'utf8',
  );
  const home = source('app/page.tsx');
  const richList = source('app/rich-list/page.tsx');

  assert.match(home, /export const revalidate = 30/);
  assert.match(home, /tags: \['chain-tip'\]/);
  assert.doesNotMatch(home, /cache:\s*['"]no-store['"]/);
  assert.equal((home.match(/fetchWithDeadline\(/g) || []).length, 2);
  assert.equal((home.match(/retainLastGoodOrBuildFallback\(/g) || []).length, 2);

  assert.match(richList, /export const revalidate = 60/);
  assert.doesNotMatch(richList, /force-dynamic/);
  assert.match(richList, /fetchApiDataWithDeadline</);
  assert.match(richList, /retainLastGoodOrBuildFallback\(/);

  // Block and tx layouts use dynamic fetch-level revalidation (3600s for
  // confirmed content, 30s near the tip / 300s for confirmed txs) instead
  // of a page-level export.  Address keeps a fixed page-level value.
  const dynamicDetailRoutes = [
    ['app/block/[height]/layout.tsx', 'height'],
    ['app/tx/[txid]/layout.tsx', 'txid'],
  ];
  for (const [filename, param] of dynamicDetailRoutes) {
    const layout = source(filename);
    assert.doesNotMatch(layout, /export const revalidate/);
    assert.match(layout, /export function generateStaticParams/);
    assert.match(layout, new RegExp(`Array<\\{ ${param}: string \\}>`));
    assert.match(layout, /return \[\];/);
    assert.match(layout, /retainLastGoodOrBuildFallback/);
  }

  const fixedDetailRoutes = [
    ['app/address/[address]/layout.tsx', 'address', 60],
  ];
  for (const [filename, param, seconds] of fixedDetailRoutes) {
    const layout = source(filename);
    assert.match(layout, new RegExp(`export const revalidate = ${seconds}`));
    assert.match(layout, /export function generateStaticParams/);
    assert.match(layout, new RegExp(`Array<\\{ ${param}: string \\}>`));
    assert.match(layout, /return \[\];/);
    assert.match(layout, /retainLastGoodOrBuildFallback/);
  }

  for (const filename of [
    'app/blocks/latest/page.tsx',
    'app/txs/latest/page.tsx',
  ]) {
    const latestSource = source(filename);
    assert.match(latestSource, /['"]shell['"]/);
    assert.match(latestSource, /export const revalidate = 30/);
  }

  const addressPage = source('app/address/[address]/page.tsx');
  assert.match(addressPage, /<Suspense/);
  assert.match(addressPage, /<AddressDetailClient/);
  assert.match(source('app/block/[height]/page.tsx'), /retainLastGoodOrBuildFallback/);
});

test('transaction SEO summary performs one bounded database query', async () => {
  const { handlers, middleware } = captureTransactionRoutes();
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{
        txid: 'a'.repeat(64),
        block_height: '123',
        block_hash: 'b'.repeat(64),
        block_time: '1700000000',
        is_coinbase: false,
        has_sapling: false,
        has_orchard: true,
        has_ironwood: false,
        orchard_actions: '2',
        sapling_spend_count: '0',
        sapling_output_count: '0',
        fee: '10001',
        size: 1234,
        vin_count: 2,
        vout_count: 1,
        has_sprout: false,
        is_canonical: true,
        confirmations: '10',
      }] };
    },
  };
  const req = {
    params: { txid: 'a'.repeat(64) },
    app: { locals: { pool } },
  };
  const res = responseRecorder();
  middleware(req, res, () => {});
  await handlers.get('/api/seo/tx/:txid')(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ['a'.repeat(64)]);
  assert.doesNotMatch(
    queries[0].sql,
    /transaction_(inputs|outputs)|cross_chain_swaps|information_schema/i,
  );
  assert.equal(res.body.hasShielded, true);
  assert.equal(res.body.confirmations, 10);
  assert.equal(res.body.feeZat, '10001');
  assert.equal(res.body.size, 1234);
  assert.equal(res.body.vinCount, 2);
  assert.equal(res.body.voutCount, 1);
  assert.equal(res.body.hasSprout, false);
  assert.equal(
    res.headers.get('cache-control'),
    'public, s-maxage=30, stale-while-revalidate=300',
  );
});

function v1Fixture(body) {
 const { success, ...rest } = body;
 const collection = rest.pagination && (rest.blocks || rest.transactions || rest.flows);
 return { data: collection || rest, meta: { requestId: '00000000-0000-4000-8000-000000000000', network: 'mainnet', generatedAt: '2026-09-07T00:00:00.000Z', indexedHeight: 123, source: { indexedHeight: null, observedAt: null }, freshness: { status: 'unknown', ageSeconds: null }, ...(collection ? { page: { limit: 25, hasNext: false, hasPrev: false, nextCursor: null, prevCursor: null, total: rest.pagination.total ?? 0 } } : {}) } };
}
