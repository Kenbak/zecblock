import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import store from '../lib/attestation-store.js';
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
const root = resolve(import.meta.dirname, '../..');
function loadTs(file, mocks = {}) {
  const filename = resolve(root, file);
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }, fileName: filename }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output)((id) => id in mocks ? mocks[id] : require(id), loaded, loaded.exports);
  return loaded.exports;
}
const Link = ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children);
const apiClient = loadTs('lib/api-client.ts');
const Header = loadTs('components/ui/SectionHeader.tsx');
const Client = loadTs('app/network/attestations/AttestationsClient.tsx', {
  '@/components/ui/SectionHeader': Header,
  '@/hooks/useApiQuery': { useApiQuery: (path, _params, options) => { assert.equal(path, '/v1/network/attestations'); return { data: options.initialData ?? null, loading: false, error: null }; } },
  '@/lib/canary-status': require('../../lib/canary-status'),
  '@/lib/attestation-status': require('../../lib/attestation-status'),
}).default;
function loadPage(network, data) {
  const seo = loadTs('lib/seo.ts', {
    '@/lib/api-client': apiClient,
    '@/lib/network': { getConfiguredNetwork: () => network },
    '@/lib/api-config': { getApiUrlForNetwork: () => 'https://private-service.internal' },
    '@/lib/server-fetch': {},
  });
  return loadTs('app/network/attestations/page.tsx', {
    'next/link': Link,
    '@/lib/api-client': apiClient,
    'next/navigation': { notFound: () => { throw new Error('NOT_FOUND'); } },
    '@/components/ui/SectionHeader': Header,
    '@/lib/seo': seo,
    '@/lib/server-fetch': { fetchWithDeadline: async (url) => { assert.equal(url, 'https://private-service.internal/v1/network/attestations'); return { ok: data !== null, json: async () => ({ data, meta: { requestId: 'attestation-test', network } }) }; } },
    '@/lib/network': { normalizeApiBaseUrl: (url) => url },
    './AttestationsClient': Client,
  });
}
for (const network of ['mainnet', 'testnet']) {
  test(`${network} page server-renders one heading, full endpoint names and correct metadata`, async () => {
    const data = store.publicSnapshot(null, network);
    const page = loadPage(network, data);
    const html = renderToStaticMarkup(await page.default());
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    assert.match(html, /Zero Indexer attestations/);
    for (const endpoint of data.endpoints) assert.ok(html.includes(endpoint.hostname));
    assert.match(html, /No endpoint is being reported as verified/);
    assert.ok(!html.includes('private-service.internal'));
    assert.ok(html.includes(`${network === 'mainnet' ? 'https://api.zecblock.com' : 'https://api.testnet.zecblock.com'}/v1/network/attestations`));
    assert.equal(page.metadata.robots.index, network === 'mainnet');
    assert.equal(page.metadata.robots.follow, true);
    const host = network === 'mainnet' ? 'zecblock.com' : 'testnet.zecblock.com';
    assert.equal(page.metadata.alternates.canonical, `https://${host}/network/attestations`);
    assert.equal(page.metadata.openGraph.url, page.metadata.alternates.canonical);
    assert.equal(page.metadata.twitter.card, 'summary_large_image');
    assert.ok(page.metadata.openGraph.images[0].alt);
    const schemas = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    assert.equal(schemas[0].url, page.metadata.alternates.canonical);
    assert.equal(schemas[0].publisher['@id'], 'https://zecblock.com/#organization');
    assert.match(page.metadata.title, /ZecBlock/);
  });
}
test('API outage still renders meaningful HTML, and Crosslink returns notFound', async () => {
  const html = renderToStaticMarkup(await loadPage('mainnet', null).default());
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /Observations are currently unavailable/);
  const page = loadPage('crosslink-testnet', null);
  assert.equal(page.metadata.robots.index, false);
  await assert.rejects(page.default(), /NOT_FOUND/);
});
test('stale browser data cannot render a current verified state', () => {
  const data = store.publicSnapshot(null, 'mainnet');
  const checkedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  data.available = true;
  data.endpoints.forEach((endpoint) => { endpoint.latest = { checkedAt, reachable: true, evidence: 'verified', tlsBinding: 'matched', release: 'unconfirmed' }; });
  const html = renderToStaticMarkup(React.createElement(Client, { initialData: data, initialNow: Date.now(), network: 'mainnet', apiUrl: 'https://api.mainnet.cipherscan.app' }));
  assert.match(html, /Stale observation/);
  assert.ok(!html.includes('>Verified<'));
  assert.ok(!html.includes('>Matched<'));
});
test('core sitemap has the canonical monitor with a meaningful publication date', () => {
  const sitemap = loadTs('lib/sitemaps.ts');
  const entries = sitemap.getStaticSitemapEntries('core', 'https://cipherscan.app', []);
  const entry = entries.find((item) => item.url.endsWith('/network/attestations'));
  assert.equal(entry.lastModified, '2026-09-09');
  assert.equal(entry.changeFrequency, 'hourly');
  assert.ok(sitemap.serializeUrlSet([entry]).includes('<priority>0.6</priority>'));
});

test('running tag and hub confirmation require a fresh reproduced match, while hub status is separate', () => {
  const now = Date.now();
  const render = (change = {}, age = 0) => {
    const data = store.publicSnapshot(null, 'mainnet'); data.available = true;
    const shim = data.endpoints.find(e => e.id === 'zecrocks-mainnet');
    shim.latest = { checkedAt: new Date(now - age).toISOString(), reachable: true, evidence: 'verified', tlsBinding: 'matched', release: 'reproduced_match', ...change };
    return renderToStaticMarkup(React.createElement(Client, {initialData:data, initialNow:now, network:'mainnet',apiUrl:'https://api.mainnet.cipherscan.app'}));
  };
  const fresh = render();
  assert.match(fresh,/deploy-fdb613db-e0c834c/);
  assert.match(fresh,/Running build · reproduced match/);
  assert.match(fresh,/Confirmed by matching reproduced build/);
  assert.match(fresh.replace(/<[^>]+>/g, ''),/Hub’s own check:Not checked yet/);
  assert.ok(!fresh.includes('shieldedinfra.net'));
  for(const html of [render({},16*60_000),render({release:'mismatch'}),render({reachable:false}),render({tlsBinding:'mismatch'})]) {
    assert.ok(!html.includes('Running build · reproduced match'));
    assert.ok(!html.includes('Confirmed by matching reproduced build'));
    assert.match(html,/current match unconfirmed/);
  }
});

test('Canary has its own expiry and ordinary-host trust wording in server HTML', () => {
  const data = store.publicSnapshot(null, 'mainnet');
  const now = Date.now();
  data.endpoints[0].canary = { checkedAt: new Date(now).toISOString(), verified: true, status: 'VERIFIED', observedAt: new Date(now).toISOString(), expiresAt: new Date(now - 1).toISOString(), transportWarning: null };
  const html = renderToStaticMarkup(React.createElement(Client, { initialData: data, initialNow: now, network: 'mainnet', apiUrl: 'https://api.mainnet.cipherscan.app' }));
  assert.match(html, /Observation expired/);
  assert.doesNotMatch(html, /Signed checks verified/);
  assert.match(html, /monitor itself is not enclave-attested/);
  assert.match(html, /Signed statement/);
});
