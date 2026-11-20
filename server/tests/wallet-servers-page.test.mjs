import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import monitor from '../lib/wallet-servers.js';
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
const Header = loadTs('components/ui/SectionHeader.tsx', { 'next/link': Link });
const status = loadTs('lib/wallet-servers.ts');
const Image = (props) => React.createElement('img', Object.fromEntries(Object.entries(props).filter(([name]) => name !== 'unoptimized')));
const Client = loadTs('app/network/wallet-servers/WalletServersClient.tsx', {
  'next/link': Link,
  'next/image': Image,
  '@/hooks/useApiQuery': { useApiQuery: (path, _params, options) => { assert.equal(path, '/v1/network/wallet-servers'); return { data: options.initialData ?? null, loading: false, error: null }; } },
  '@/lib/wallet-servers': status,
  '@/lib/world-dot-map': loadTs('lib/world-dot-map.ts', { './world-land-dots.generated': loadTs('lib/world-land-dots.generated.ts') }),
}).default;
function loadPage(network, data) {
  const seo = loadTs('lib/seo.ts', {
    '@/lib/api-client': apiClient,
    '@/lib/network': { getConfiguredNetwork: () => network },
    '@/lib/api-config': { getApiUrlForNetwork: () => 'https://private-service.internal' },
    '@/lib/server-fetch': {},
  });
  return loadTs('app/network/wallet-servers/page.tsx', {
    'next/link': Link,
    '@/lib/api-client': apiClient,
    'next/navigation': { notFound: () => { throw new Error('NOT_FOUND'); } },
    '@/components/ui/SectionHeader': Header,
    '@/lib/seo': seo,
    '@/lib/server-fetch': { fetchWithDeadline: async (url) => { assert.equal(url, 'https://private-service.internal/v1/network/wallet-servers'); return { ok: data !== null, json: async () => ({ data, meta: { requestId: 'wallet-servers-test', network } }) }; } },
    '@/lib/network': { normalizeApiBaseUrl: (url) => url },
    './WalletServersClient': Client,
  });
}
const HASH = '0000000000e631c94fe7b859a8ef133fceea3cf28a1631f6cc1b28dbe5cf3347';
function observed(now, overrides = {}) {
  const checkedAt = new Date(now).toISOString();
  const data = monitor.publicSnapshot({ checkedAt, referenceHeight: 3591214, observations: {} }, 'mainnet');
  for (const endpoint of data.operators.flatMap((operator) => operator.endpoints)) {
    endpoint.latest = { checkedAt, reachable: true, height: 3591214, hash: HASH, responseMs: 42, chain: 'canonical', tipDelta: 0, chainName: 'main', vendor: 'Ztreamer', version: '0.1.0', nodeSubversion: '/Zakura:1.8.9/', ...(overrides[endpoint.id] ?? {}) };
  }
  return data;
}
const render = (data, now) => renderToStaticMarkup(React.createElement(Client, { initialData: data, initialNow: now, network: 'mainnet' }));
const text = (html) => html.split(/<[^>]+>/).join(' ').replace(/\s+/g, ' ');
// The legend always names the state; no tile or map marker may claim it.
const claimsAnswering = (html) => (html.split('id="server-checks"')[1] ?? '').includes('>Answering<') || /aria-label="[^"]*: Answering/.test(html);

test('mainnet page server-renders one heading, every registered name and complete metadata', async () => {
  const now = Date.now();
  const data = observed(now);
  const page = loadPage('mainnet', data);
  const html = renderToStaticMarkup(await page.default());
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /<h1[^>]*>Zcash wallet servers<\/h1>/);
  for (const endpoint of data.operators.flatMap((operator) => operator.endpoints)) assert.ok(html.includes(`${endpoint.host}:443`), endpoint.host);
  assert.ok(html.includes('rpc.fastz.cash:443'));
  assert.ok(html.includes('href="/block/3591214"'));
  assert.ok(html.includes('href="https://status.fastz.cash/"'));
  assert.ok(!html.includes('private-service.internal'));
  assert.ok(html.includes('https://api.zecblock.com/v1/network/wallet-servers'));
  for (const href of ['/network', '/network/attestations', '/network/nodes']) assert.ok(html.includes(`href="${href}"`), href);
  assert.equal(page.metadata.robots.index, true);
  assert.equal(page.metadata.robots.follow, true);
  assert.equal(page.metadata.alternates.canonical, 'https://zecblock.com/network/wallet-servers');
  assert.equal(page.metadata.openGraph.url, page.metadata.alternates.canonical);
  assert.equal(page.metadata.twitter.card, 'summary_large_image');
  assert.ok(page.metadata.openGraph.images[0].alt);
  assert.match(page.metadata.title, /^Zcash Wallet Servers/);
  assert.equal(page.metadata.title.match(/ZecBlock/g).length, 1);
  assert.ok(page.metadata.description.length <= 160, `description is ${page.metadata.description.length} characters`);
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
  assert.equal(schemas[0].url, page.metadata.alternates.canonical);
  assert.equal(schemas[0].isPartOf['@id'], 'https://zecblock.com/#website');
  assert.equal(schemas[0].publisher['@id'], 'https://zecblock.com/#organization');
});

test('an API outage still renders the heading and reports no server as answering', async () => {
  const html = renderToStaticMarkup(await loadPage('mainnet', null).default());
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /Checks are currently unavailable\. No server is being reported as answering\./);
  assert.ok(!claimsAnswering(html));
  const registryOnly = render(monitor.publicSnapshot(null, 'mainnet'), Date.now());
  assert.match(registryOnly, /rpc\.fastz\.cash:443/);
  assert.match(registryOnly, /Not checked yet/);
  assert.ok(!claimsAnswering(registryOnly));
  assert.ok(claimsAnswering(render(observed(Date.now()), Date.now())), 'the helper detects a current answer');
});

test('testnet and Crosslink have no wallet server page and stay out of the index', async () => {
  for (const network of ['testnet', 'crosslink-testnet']) {
    const page = loadPage(network, null);
    assert.equal(page.metadata.robots.index, false);
    assert.equal(page.metadata.robots.follow, true);
    await assert.rejects(page.default(), /NOT_FOUND/);
  }
});

test('each state is labelled from the observation, and unknown is never shown as a match', () => {
  const now = Date.now();
  const html = render(observed(now, {
    'fastz-usw': { reachable: false, error: 'timeout', height: undefined, hash: undefined, chain: undefined, tipDelta: undefined, vendor: undefined },
    'fastz-la': { tipDelta: -3, height: 3591211 },
    'fastz-use': { chain: 'different' },
    'fastz-sa': { chain: 'unknown', tipDelta: 1, height: 3591215 },
    'fastz-lon': { chainName: 'test' },
    'fastz-de': { tipDelta: -2, height: 3591212 },
  }), now);
  const tile = (id) => text(html.match(new RegExp(`<li id="${id}".*?</li>`))[0]);
  assert.match(tile('fastz-rpc'), /Answering Global Global rpc\.fastz\.cash:443 Height 3,591,214 Our index Same tip block From our server 42 ms\s*$/);
  assert.match(tile('fastz-usw'), /No answer Region Hillsboro, Oregon usw\.fastz\.cash:443 No reply within 5 seconds\s*$/);
  assert.match(tile('fastz-la'), /Behind the tip .* Height 3,591,211 Our index 3 blocks behind, same chain/);
  assert.match(tile('fastz-use'), /Different tip block .* Our index Different block at this height/);
  assert.match(tile('fastz-sa'), /Answering .* Height 3,591,215 Our index 1 block ahead, not compared yet/);
  assert.ok(!html.includes('href="/block/3591215"'), 'a height missing from our index is not linked');
  assert.match(tile('fastz-lon'), /Unexpected network/);
  assert.match(tile('fastz-de'), /Answering .* Height 3,591,212 Our index 2 blocks behind, same chain/);
  assert.match(text(html), /Operated by Zcash Labs · Reports Ztreamer 0\.1\.0 on \/Zakura:1\.8\.9\//);
  const summary = text(html.match(/<dl.*?<\/dl>/)[0]);
  assert.match(summary, /Server names checked 17 2 operators/);
  assert.match(summary, /Answering now 13 /);
  assert.match(summary, /Tip matches our index 14 Index height 3,591,214/);
});

test('expired checks never render as current, on the map, in the tiles or the summary', () => {
  const now = Date.now();
  const html = render(observed(now - 6 * 60_000), now);
  assert.ok(!claimsAnswering(html));
  assert.ok(!html.includes('42 ms'));
  assert.ok(!html.includes('href="/block/3591214"'));
  assert.match(html, /Check expired/);
  assert.match(html, /Checks are currently unavailable/);
  assert.equal(status.walletServerStatus({ checkedAt: new Date(now + 120_000).toISOString(), reachable: true }, { staleAfterSeconds: 300, lagThresholdBlocks: 3, expectedChainName: 'main' }, now), 'not_checked');
});

test('core sitemap lists the canonical page with its publication date', () => {
  const sitemap = loadTs('lib/sitemaps.ts');
  const entries = sitemap.getStaticSitemapEntries('core', 'https://zecblock.com', []);
  const entry = entries.find((item) => item.url === 'https://zecblock.com/network/wallet-servers');
  assert.equal(entry.lastModified, '2026-11-19');
  assert.equal(entry.changeFrequency, 'hourly');
});

test('the map plots fixed locations as dots and area names as rings, each linked to its tile', () => {
  const now = Date.now();
  const html = render(observed(now, { 'fastz-sa': { reachable: false, error: 'timeout', height: undefined, chain: undefined, tipDelta: undefined, vendor: undefined } }), now);
  const map = html.match(/<section[^>]*id="server-map".*?<\/section>/)[0];
  const markers = [...map.matchAll(/<a href="#([a-z-]+)" aria-label="([^"]*)" class="([^"]*)">(.*?)<\/a>/g)].map(([, id, label, cls, body]) => ({ id, label, cls, ring: body.includes('fill="none"') }));
  assert.deepEqual(markers.map((marker) => marker.id), [
    'fastz-usw', 'fastz-la', 'fastz-use', 'fastz-sa', 'fastz-lon', 'fastz-de', 'fastz-sg', 'fastz-jp',
    'zecrocks-na', 'zecrocks-sa', 'zecrocks-eu', 'zecrocks-ap',
  ]);
  for (const marker of markers) {
    assert.ok(html.includes(`<li id="${marker.id}"`), marker.id);
    assert.equal(marker.ring, marker.id.startsWith('zecrocks-'), `${marker.id}: only approximate area positions are rings`);
  }
  assert.equal(markers.find((marker) => marker.id === 'fastz-jp').label, 'Osaka, fastz.cash: Answering, height 3,591,214');
  assert.equal(markers.find((marker) => marker.id === 'zecrocks-eu').label, 'Europe area, zec.rocks: Answering, height 3,591,214');
  assert.match(map, />zec\.rocks · Europe<\/text>/);
  const down = markers.find((marker) => marker.id === 'fastz-sa');
  assert.equal(down.label, 'São Paulo, fastz.cash: No answer');
  assert.match(down.cls, /text-danger/);
  // Names without any position (global names, fastz area names) are listed, not plotted.
  for (const id of ['fastz-rpc', 'fastz-eu', 'zecrocks-global']) assert.ok(!map.includes(`href="#${id}"`), id);
  assert.match(text(map), /fastz\.cash ● locations/);
  assert.match(text(map), /zec\.rocks ○ areas/);
  assert.ok(!render(monitor.publicSnapshot(null, 'testnet'), now).includes('id="server-map"'));
});

test('an operator is identified by its own stored mark, or a neutral initial when it publishes none', () => {
  const html = render(observed(Date.now()), Date.now());
  const section = (id) => html.match(new RegExp(`<section id="${id}".*?</section>`))[0];
  assert.match(section('fastz'), /<img src="\/brands\/wallet-servers\/fastz\.svg" alt="" width="36" height="36"/);
  assert.ok(!section('zecrocks').includes('<img'));
  assert.match(section('zecrocks'), /<span aria-hidden="true"[^>]*>z<\/span>/);
  const data = observed(Date.now());
  data.operators[1].logo = 'https://evil.example/logo.svg';
  assert.ok(!render(data, Date.now()).includes('evil.example'));
});

test('software is shown per name only when an operator reports more than one', () => {
  const now = Date.now();
  const html = render(observed(now, { 'zecrocks-ap': { nodeSubversion: '/Zakura:1.8.8/' } }), now);
  const section = (id) => text(html.match(new RegExp(`<section id="${id}".*?</section>`))[0]);
  assert.match(section('zecrocks'), /Software Ztreamer 0\.1\.0 on \/Zakura:1\.8\.8\//);
  assert.ok(!section('zecrocks').includes('Reports '));
  assert.ok(!section('fastz').includes('Software '));
});

test('the page never makes a visitor contact a wallet server', () => {
  const html = render(observed(Date.now()), Date.now());
  assert.ok(!html.includes('id="speed-test"'));
  assert.ok(!/<button\b/.test(html), 'no control starts a request to an operator');
  const source = readFileSync(resolve(root, 'app/network/wallet-servers/WalletServersClient.tsx'), 'utf8');
  assert.ok(!/\bfetch\(|WebSocket|sendBeacon|no-cors/.test(source), 'the only request is the ZecBlock API query');
  assert.equal([...source.matchAll(/useApiQuery<[^>]*>\('([^']+)'/g)].map((match) => match[1]).join(), '/v1/network/wallet-servers');
});
