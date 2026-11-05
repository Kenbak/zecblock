const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, dependencies, env = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, { exports, AbortSignal, console, process: { env }, require(name) {
    if (name in dependencies) return dependencies[name];
    if (name === 'react/jsx-runtime') return require(name);
    throw new Error(`Unexpected dependency ${name}`);
  } });
  return exports;
}
const registration = { name: 'sacrebleu', address: 'u1full-public-resolution', txid: 'a'.repeat(64), height: 3500000, nonce: 1, signature: null, lastAction: 'CLAIM', listing: null };
const initialData = { state: 'registered', registration, events: null };
const container = ({ children }) => React.createElement('div', null, children);

test('frontend and API name reads use the published registry for each network and preserve independent overrides', async t => {
  const { NETWORKS } = require('zcashname-sdk');
  const { loadV1Config } = require('../api/v1/config');
  const overrides = {
    ZNS_MAINNET_URL: 'https://mainnet-registry.example/rpc',
    ZNS_TESTNET_URL: 'https://testnet-registry.example/rpc',
  };

  for (const network of ['mainnet', 'testnet', 'crosslink-testnet']) {
    const registryNetwork = network === 'crosslink-testnet' ? 'testnet' : network;
    for (const env of [{}, overrides]) {
      await t.test(`${network}: ${env === overrides ? 'override' : 'published default'}`, async () => {
        const requests = [];
        let clientOptions;
        const zns = load('lib/zns.ts', {
          'zcashname-sdk': { ZNS: class { constructor(options) { clientOptions = options; } } },
          './api-config': { NETWORK: network },
          './api-client': {},
          './zns-rpc': { callZnsRpc: async (...args) => { requests.push(args); return registration; } },
          './name-validation': load('lib/name-validation.ts', {}),
        }, env);
        const expectedUrl = env[`ZNS_${registryNetwork.toUpperCase()}_URL`] || NETWORKS[registryNetwork].url;
        const signal = new AbortController().signal;

        assert.equal((await zns.resolveZnsName(registration.name, signal)).address, registration.address);
        assert.equal(requests[0][0], expectedUrl);
        assert.equal(requests[0][1], 'resolve');
        assert.equal(requests[0][2].query, registration.name);
        assert.equal(requests[0][3], signal, 'registry reads retain their caller deadline');
        const firstClient = zns.getClient();
        assert.equal(zns.getClient(), firstClient, 'the configured client remains a singleton');
        assert.equal(clientOptions.url, expectedUrl);
        assert.equal(clientOptions.network, registryNetwork, 'Crosslink names remain in the testnet namespace');

        for (const networkKey of ['NEXT_PUBLIC_NETWORK', 'ZCASH_NETWORK', 'NETWORK']) {
          const config = loadV1Config({ ...env, [networkKey]: network });
          assert.equal(config.znsUrl, expectedUrl, `${networkKey} must select the same registry as SSR`);
          assert.equal(config.network, network, 'API network identity remains distinct from the shared registry');
        }
      });
    }
  }

  assert.equal(loadV1Config({}).znsUrl, NETWORKS.testnet.url, 'the existing unconfigured API default remains testnet');
  assert.equal(loadV1Config({ NEXT_PUBLIC_NETWORK: 'testnet', NETWORK: 'mainnet' }).znsUrl, NETWORKS.testnet.url, 'explicit frontend network retains precedence');
});

function client(react = React, refresh = {}) {
  return load('app/name/[name]/NameClient.tsx', {
    react,
    '@/lib/api-config': { getApiUrl: () => 'https://api.test' },
    '@/lib/api-client': { readApiData: response => response.json() },
    'next/link': ({ children, href }) => React.createElement('a', { href }, children),
    '@/components/ui/Card': { Card: container, CardHeader: container, CardBody: container },
    '@/components/ui/Badge': { Badge: container },
    '@/components/ui/HashLink': { HashLink: ({ value }) => React.createElement('span', null, value) },
    '@/components/CopyButton': { CopyButton: () => null },
    '@/lib/live-refresh': refresh,
  }).default;
}

test('server HTML contains registration details, full identifiers and current SDK action without browser APIs', () => {
  const html = renderToStaticMarkup(React.createElement(client(), { name: registration.name, initialData }));
  for (const text of ['Resolves to', registration.address, registration.txid, 'CLAIM', 'Last action', 'History is temporarily unavailable.']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('No events.'));
  assert.ok(!html.includes('Admin-registered'), 'SDK no longer supplies a custody field');
  assert.ok(!html.includes('Name data is temporarily unavailable'));
});

test('blocked refresh preserves SSR data; successful release replaces it; unmounted requests cannot write state', async () => {
  const slots = []; let index = 0; let refresh; let cleanup; let response = 'blocked';
  const react = { ...React,
    useState(value) { const slot = index++; if (!(slot in slots)) slots[slot] = value; return [slots[slot], value => { slots[slot] = value; }]; },
    useEffect(fn) { cleanup = fn(); },
  };
  const Component = client(react, {
    startLiveRefresh(fn) { refresh = fn; return () => {}; },
    async fetchLiveResponse(url) {
      if (response === 'blocked') throw new Error('Blocked by robots.txt');
      return url.endsWith('/events') ? { events: [] } : { pricing: null };
    },
  });
  Component({ name: registration.name, initialData });
  await refresh();
  assert.equal(slots[0], initialData);
  assert.equal(slots[1], true);
  response = 'available';
  await refresh();
  assert.equal(slots[0].state, 'available');
  assert.equal(slots[0].pricing, null, 'availability is authoritative even if pricing is unavailable');
  assert.equal(slots[1], false);
  cleanup(); response = 'blocked'; await refresh();
  assert.equal(slots[1], false);
});

test('server resolution distinguishes unavailable service from available name and tolerates missing extras', async () => {
  let fail = false; let result = registration; const signals = [];
  const server = load('lib/name-server.ts', {
    react: { cache: fn => fn },
    './zns': {
      resolveZnsName: async (_, signal) => { signals.push(signal); if (fail) throw new Error('timeout'); return result; },
      getZnsNameEvents: async () => { throw new Error('timeout'); },
      getZnsStatus: async () => { throw new Error('timeout'); },
    },
  });
  const registered = await server.resolveName('sacrebleu');
  const seeded = await server.resolveNameExtras('sacrebleu', registered);
  assert.equal(seeded.registration, registration); assert.equal(seeded.events, null);
  result = null;
  const available = await server.resolveName('available');
  assert.equal(available.state, 'available');
  assert.equal((await server.resolveNameExtras('available', available)).pricing, null);
  fail = true; assert.equal((await server.resolveName('sacrebleu')).state, 'error');
  assert.ok(signals.every(signal => signal instanceof AbortSignal));
});

test('available-name SSR preserves explicit unavailable pricing with the current status schema', async () => {
  const server = load('lib/name-server.ts', {
    react: { cache: fn => fn },
    './zns': {
      resolveZnsName: async () => null,
      getZnsNameEvents: async () => { throw new Error('not registered'); },
      getZnsStatus: async () => ({ syncedHeight: 3500000, synced: true, treasuryAddress: 'u1registry' }),
    },
  });
  const resolution = await server.resolveName('available');
  const snapshot = await server.resolveNameExtras('available', resolution);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.pricing, null, 'missing pricing must not become undefined or a fabricated amount');
});

test('ZNS transport normalizes current wire fields and rejects malformed registrations, never treating them as available', async () => {
  let raw = { ...registration, last_action: 'CLAIM' }; delete raw.lastAction;
  const zns = load('lib/zns.ts', {
    'zcashname-sdk': { ZNS: class {} }, './api-config': { NETWORK: 'mainnet' },
    './api-client': {}, './zns-rpc': { callZnsRpc: async () => raw }, './name-validation': load('lib/name-validation.ts', {}),
  });
  const result = await zns.resolveZnsName('sacrebleu', AbortSignal.timeout(1000));
  assert.equal(result.lastAction, 'CLAIM');
  raw = {}; await assert.rejects(zns.resolveZnsName('sacrebleu', AbortSignal.timeout(1000)), /Invalid ZNS/);
  raw = null; assert.equal(await zns.resolveZnsName('missing', AbortSignal.timeout(1000)), null);
});


test('HTTP name validator matches SDK syntax and rejects invalid names before streaming', async () => {
  const validator = load('lib/name-validation.ts', {});
  const sdk = new (require('zcashname-sdk').ZNS)();
  for (const name of ['', 'a', 'sacrebleu', '123', 'A', 'a-b', 'a_b', 'a.zec', 'é', 'a'.repeat(62), 'a'.repeat(63), '%', 'a/b']) {
    assert.equal(validator.isValidName(name), sdk.isValidName(name), name);
  }
  const NextResponse = class { constructor(body, options) { this.body = body; this.status = options.status; } static next() { return { status: 200 }; } };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('proxy.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, process: { env: { NODE_ENV: 'development' } }, setInterval: () => {}, require(name) {
    if (name === 'next/server') return { NextResponse };
    if (name === './lib/name-validation') return validator;
    return {};
  } });
  for (const pathname of ['/name/invalid!', '/name/%ZZ', '/name/a/b', '/name/' + 'a'.repeat(63)]) {
    const response = await exports.proxy({ nextUrl: { pathname } });
    assert.equal(response.status, 404); assert.match(response.body, /<h1>Name not found/);
  }
  assert.equal((await exports.proxy({ nextUrl: { pathname: '/name/Sacrebleu' } })).status, 200);
});
