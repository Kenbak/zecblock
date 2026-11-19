'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

function load(file, imports = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    if (name in imports) return imports[name];
    throw new Error(`Unexpected import ${name} in ${file}`);
  });
  return module.exports;
}

const navigation = load('lib/navigation.ts');
// The catalogue's data helpers are not used by search; only its chart list is.
const catalog = load('lib/chart-catalog.ts', {
  './network-overview': { blockIntervals: () => [] },
  './mining-metrics': { MINING_METRICS_POINTS: 500, MINING_METRICS_WINDOW: 100 },
});
const { searchSite, bestSiteMatch, SITE_SECTIONS } = load('lib/site-search.ts', {
  './navigation': navigation,
  './chart-catalog': catalog,
});
const top = (query, network = 'mainnet') => searchSite(query, network)[0]?.href;
const hrefs = (query, network = 'mainnet', limit = 5) => searchSite(query, network, limit).map(match => match.href);

test('everyday words find the page that owns the topic', () => {
  for (const [query, href] of [
    ['mining', '/mining'], ['Mining', '/mining'], ['blocks', '/blocks'], ['mempool', '/mempool'],
    ['shielded pool', '/pools'], ['shielded pools', '/pools'], ['pool stats', '/pools'], ['shielded pool stats', '/pools'],
    ['mert shielded pool stats', '/pools'], ['how much zec is shielded', '/pools'],
    ['turnstile', '/turnstile'], ['deshield', '/turnstile'], ['ironwood', '/ironwood'], ['privacy score', '/privacy'],
    ['nodes', '/network/nodes'], ['block time', '/network/block-speed'], ['block speed', '/network/block-speed'],
    ['reorg', '/reorgs'], ['forks', '/reorgs'], ['governance', '/governance'], ['vote', '/governance'], ['calendar', '/calendar'],
    ['price', '/valuation'], ['mvrv', '/charts/mvrv'], ['market cap', '/valuation'], ['charts', '/charts'], ['swap', '/crosschain'], ['whales', '/rich-list'],
    ['api', '/docs'], ['tools', '/tools'], ['decode', '/tools/decode'], ['broadcast', '/tools/broadcast'], ['memo', '/decrypt'],
    ['zatoshi', '/tools/unit-converter'], ['private explorer', 'https://private.zecblock.com'], ['newsletter', '/newsletter'],
    ['tx', '/txs'], ['transactions', '/txs'],
  ]) assert.equal(top(query), href, query);
});

test('topics without a page of their own find the section that shows them', () => {
  for (const [query, href] of [
    ['halving', '/network#issuance'], ['supply', '/network#issuance'], ['hashrate', '/mining#metrics'], ['hash rate', '/mining#metrics'],
    ['fee', '/network#network-fees'], ['fees', '/network#network-fees'], ['orphan rate', '/mining#orphans'],
    ['mining pools', '/mining#distribution'], ['shielded transactions', '/txs?type=shielded'], ['mcp', '/docs/mcp'],
    ['shielded rate', '/txs?view=activity'], ['shielded share', '/txs?view=activity'], ['daily transactions', '/txs?view=activity'],
  ]) assert.equal(top(query), href, query);
  // The page about orphans is offered next to the per-pool rate.
  assert.ok(hrefs('orphan').includes('/reorgs'));
  assert.ok(hrefs('orphan').includes('/mining#orphans'));
});

test('every search destination is a real page and a real section', () => {
  const sources = {
    '/network#issuance': 'components/network/MiningIssuance.tsx',
    '/network#network-fees': 'app/network/NetworkClient.tsx',
    '/mining#metrics': 'app/mining/page.tsx',
    '/mining#distribution': 'app/mining/page.tsx',
    '/mining#orphans': 'components/mining/OrphanRateSection.tsx',
    '/pools#flows': 'app/pools/page.tsx',
  };
  for (const section of SITE_SECTIONS) {
    const url = new URL(section.href, 'https://example.test');
    assert.ok(fs.existsSync(`app${url.pathname}/page.tsx`), section.href);
    if (url.hash) {
      assert.ok(sources[section.href], `no source listed for ${section.href}`);
      assert.ok(fs.readFileSync(sources[section.href], 'utf8').includes(`id="${url.hash.slice(1)}"`), section.href);
    }
    // A section is listed under a page the menus know by that name.
    const labels = navigation.getNavigation('mainnet', 'footer').flatMap(category => category.items.map(item => item.label));
    assert.ok(labels.includes(section.page), `${section.href}: ${section.page}`);
  }
  // Every catalogued chart is found by its own title, and opens its chart page.
  assert.ok(fs.existsSync('app/charts/[slug]/page.tsx'));
  assert.ok(catalog.CHART_CATALOG.length > 20);
  for (const chart of catalog.CHART_CATALOG) assert.ok(hrefs(chart.title, 'mainnet', 3).includes(`/charts/${chart.id}`), chart.title);
});

test('results respect the network and never offer a page it does not have', () => {
  for (const network of ['mainnet', 'testnet', 'crosslink']) {
    const allowed = new Set(navigation.getNavigation(network, 'footer').flatMap(category => category.items.map(item => item.href)));
    for (const query of ['swap', 'mining', 'shielded', 'governance', 'validators', 'chart', 'private', 'hashrate', 'block', 'fee']) {
      for (const match of searchSite(query, network, 50)) {
        if (match.kind === 'Page') assert.ok(allowed.has(match.href), `${network}: ${query} -> ${match.href}`);
        if (match.kind === 'Chart') assert.equal(network, 'mainnet');
        if (match.kind === 'Section') assert.ok(SITE_SECTIONS.find(section => section.href === match.href).networks.includes(network));
      }
    }
  }
  assert.equal(top('swap', 'testnet'), undefined);
  assert.equal(top('validators', 'crosslink'), '/validators');
  assert.equal(top('validators', 'mainnet'), undefined);
  assert.equal(top('private explorer', 'testnet'), undefined);
});

test('the shielded rate chart has one home, on the Transactions daily activity tab', () => {
  const home = '/txs?view=activity';
  // Every pointer to the chart agrees: the stats bar, the chart library, the share card and search.
  assert.match(fs.readFileSync('components/StatsBar.tsx', 'utf8'), /href="\/txs\?type=shielded&view=activity" label="Shielded TXs · 30d"/);
  for (const id of ['privacy-adoption', 'daily-activity']) assert.equal(catalog.CHART_CATALOG.find(chart => chart.id === id).href, home, id);
  assert.match(fs.readFileSync('lib/fact-cards.ts', 'utf8'), /id: 'shielded-transactions'[^\n]*href: '\/txs\?view=activity'/);
  assert.equal(top('shielded rate'), home);
  // The page opens that tab from the address, and Privacy Score links to it instead of drawing a copy.
  assert.match(fs.readFileSync('app/txs/render.tsx', 'utf8'), /query\.view\) === 'activity'/);
  assert.match(fs.readFileSync('app/txs/TxsClient.tsx', 'utf8'), /id: 'activity', label: 'Daily Activity'/);
  assert.match(fs.readFileSync('components/privacy/PrivacyTrendsSection.tsx', 'utf8'), /href="\/txs\?view=activity"/);
});

test('ranking prefers the exact name, then pages over sections over charts', () => {
  const mining = searchSite('mining', 'mainnet', 10);
  assert.equal(mining[0].href, '/mining');
  assert.ok(mining[0].score > mining[1].score);
  const pool = searchSite('pool', 'mainnet', 10);
  assert.deepEqual(pool.slice(0, 2).map(match => match.kind), ['Page', 'Section']);
  assert.equal(pool[0].href, '/pools');
  // A two-word query needs both words; a longer one tolerates a stray word.
  assert.equal(top('shielded banana'), undefined);
  assert.equal(top('zzzz'), undefined);
  assert.deepEqual(searchSite('m', 'mainnet'), []);
  assert.ok(searchSite('shielded', 'mainnet', 3).length === 3);
});

test('Enter opens a page only when the words are the page’s own', () => {
  for (const query of ['mining', 'shielded pools', 'shielded pool stats', 'halving', 'fee', 'hashrate', 'api docs', 'private explorer', 'shield'])
    assert.ok(bestSiteMatch(query, 'mainnet'), query);
  // Short or loose matches are suggestions only, so a name or label lookup still runs.
  for (const query of ['mi', 'min', 'alice', 'binance', 'zz'])
    assert.equal(bestSiteMatch(query, 'mainnet'), null, query);
  assert.equal(bestSiteMatch('mining', 'mainnet').href, '/mining');
  assert.equal(bestSiteMatch('private explorer', 'mainnet').external, true);
});

test('the search box loads the index on demand and offers pages before the name fallback', () => {
  const source = fs.readFileSync('components/SearchBar.tsx', 'utf8');
  // Keeps the chart list out of the first page load.
  assert.match(source, /import\('@\/lib\/site-search'\)/);
  // A type-only import is erased at build time; a value import would bundle the index.
  assert.doesNotMatch(source, /^import (?!type )[^;]*from '@\/lib\/site-search'/m);
  const resolve = source.slice(source.indexOf('const resolveWords'), source.indexOf('const resolveShortHex'));
  const order = ['exactLabel', 'bestSiteMatch(', 'findAddressByLabel(', 'isValidName(', 'searchSite('].map(step => resolve.indexOf(step));
  assert.ok(order.every(position => position > 0), 'every lookup step is present');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'a named page is opened before the loose label match and the name lookup');
  // A short hex word such as "fee" reaches the page index instead of the id message.
  assert.match(source, /resolveShortHex\(trimmedQuery\)/);
});
