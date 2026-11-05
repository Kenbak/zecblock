const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => dependencies[name] ?? require(name) });
  return exports;
}

const utils = load('lib/utils.ts');
const { parseTransactionListItems, parseTransactionTimestamp } = load('lib/transaction-list.ts');
const fixture = require('./fixtures/transaction-list-mainnet.json');
const { RelativeTime, RelativeTimeProvider } = load('components/RelativeTime.tsx', {
  '@/lib/utils': utils,
});
const timestamp = 1_789_367_400;
const render = (value, initialNow) => renderToStaticMarkup(
  React.createElement(RelativeTimeProvider, { initialNow }, React.createElement(RelativeTime, { timestamp: value })),
);

test('server ages use the supplied clock, including exact minute and hour boundaries', () => {
  for (const [seconds, expected] of [[59, 'Just now'], [60, '1 min ago'], [120, '2 mins ago'], [3600, '1 hour ago']]) {
    assert.equal(utils.formatRelativeTime(timestamp, (timestamp + seconds) * 1000), expected);
  }
});

test('server HTML contains relative age and an exact machine-readable date and UTC tooltip', () => {
  const html = render(timestamp, (timestamp + 120) * 1000);
  assert.match(html, />2 mins ago<\/time>/);
  assert.ok(html.includes(`dateTime="${new Date(timestamp * 1000).toISOString()}"`));
  assert.match(html, /title="[^"]+ UTC"/);
});

test('invalid timestamps remain unavailable, never a fake age', () => {
  for (const value of [null, NaN, Infinity, 0, -1]) {
    assert.equal(render(value, timestamp * 1000), '<time title="Time unavailable">Time unavailable</time>');
  }
});

test('captured production transaction strings decode to renderable ages without changing monetary units', () => {
  assert.equal(typeof fixture.transactions[0].block_time, 'string', 'Fixture must retain the production wire type');
  const decoded = parseTransactionListItems(fixture.transactions);
  for (const [i, row] of decoded.entries()) {
    const wire = fixture.transactions[i];
    assert.equal(row.block_time, Number(wire.block_time));
    assert.equal(row.block_height, Number(wire.block_height));
    assert.equal(row.value_balance_sapling, wire.value_balance_sapling);
    assert.equal(row.total_output, wire.total_output);
    assert.match(render(row.block_time, (row.block_time + 120) * 1000), />2 mins ago<\/time>/);
  }
});

test('numeric and decimal-string timestamps share one boundary; invalid values remain unknown', () => {
  assert.equal(parseTransactionTimestamp(timestamp), timestamp);
  assert.equal(parseTransactionTimestamp(String(timestamp)), timestamp);
  for (const value of [null, undefined, '', ' ', '0', '-1', '1789370528oops', '1e9', true, {}, NaN, Infinity, 1.5, 8_640_000_000_001]) {
    assert.equal(parseTransactionTimestamp(value), null);
  }
});

test('the list decoder preserves unknown time and rejects malformed rows instead of trusting a type cast', () => {
  const wire = fixture.transactions[0];
  const [unknownTime] = parseTransactionListItems([{ ...wire, block_time: null }]);
  assert.match(render(unknownTime.block_time, Date.now()), />Time unavailable<\/time>/);
  for (const rows of [null, {}, [null], [{ ...wire, txid: '' }], [{ ...wire, block_height: 'bad' }], [{ ...wire, has_sapling: 'false' }]]) {
    assert.throws(() => parseTransactionListItems(rows));
  }
  assert.equal(parseTransactionListItems([]).length, 0);
});

test('zatoshi strings are preserved exactly and fractional ZEC values cannot masquerade as zatoshis', () => {
  const wire = fixture.transactions[0];
  const [row] = parseTransactionListItems([{ ...wire, total_output: '9007199254740993' }]);
  assert.equal(row.total_output, '9007199254740993');
  assert.throws(() => parseTransactionListItems([{ ...wire, total_output: 0.01 }]), /total_output/);
});

test('callers without a server clock retain a deterministic UTC server fallback', () => {
  const html = renderToStaticMarkup(React.createElement(RelativeTime, { timestamp }));
  assert.match(html, />[^<]+ UTC<\/time>/);
});

test('navbar search controls stay present when server pathname is unavailable or rewritten', () => {
  let pathname = null;
  const { NavBar } = load('components/NavBar.tsx', {
    'next/navigation': { usePathname: () => pathname },
    'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
    'next/image': { default: () => null },
    '@/components/BrandLogo': { BrandLogo: () => null },
    '@/components/ask/ZiftMark': { ZiftMark: () => null },
    '@/lib/dialog-focus': { containDialogFocus: () => {} },
    '@/hooks/useBodyScrollLock': { useBodyScrollLock: () => {} },
    '@/lib/navigation': load('lib/navigation.ts'),
    '@/components/SearchBar': { SearchBar: () => React.createElement('input', { 'aria-label': 'Search' }) },
    '@/components/DonateButton': { DonateButton: () => null },
    '@/components/ThemeToggle': { ThemeToggle: () => null },
    '@/contexts/ThemeContext': { useTheme: () => ({ theme: 'dark' }) },
    '@/lib/config': { NETWORK: 'mainnet', MAINNET_URL: 'https://zecblock.com', TESTNET_URL: 'https://testnet.zecblock.com', CROSSLINK_URL: 'https://crosslink.zecblock.com', NETWORK_LABEL: 'MAINNET', NETWORK_COLOR: '', isMainnet: true, isCrosslink: false },
  });
  const server = renderToStaticMarkup(React.createElement(NavBar));
  for (const route of ['/', '/txs', '/txs/latest']) {
    pathname = route;
    const html = renderToStaticMarkup(React.createElement(NavBar));
    assert.equal((html.match(/nav-search-compact/g) || []).length, 2);
    assert.deepEqual(html.match(/<input[^>]+aria-label="Search"[^>]*>/g), server.match(/<input[^>]+aria-label="Search"[^>]*>/g));
  }
  assert.equal((server.match(/nav-search-compact/g) || []).length, 2);
});


test('v1 collection decoding preserves opaque pagination, wire times and exact money', async () => {
  const { readApiCollection } = load('lib/api-client.ts');
  const nextCursor = 'opaque_cursor_not_a_height';
  const { items, page } = await readApiCollection({ ok: true, json: async () => ({
    data: fixture.transactions,
    meta: { requestId: 'v1-regression', network: 'mainnet', page: { limit: 25, hasNext: true, hasPrev: false, nextCursor, prevCursor: null } },
  }) });
  const rows = parseTransactionListItems(items);
  assert.equal(page.nextCursor, nextCursor);
  assert.equal(rows[0].block_time, Number(fixture.transactions[0].block_time));
  assert.equal(rows[0].total_output, fixture.transactions[0].total_output);
});

test('block intervals retain signed timestamp differences and unavailable values', () => {
  for (const [seconds, label] of [[-5, '−5s'], [-65, '−1m 5s'], [-120, '−2m'], [0, '0s'], [75, '1m 15s'], [601, '10m 1s']]) {
    assert.equal(utils.formatBlockInterval(seconds).label, label);
  }
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(utils.formatBlockInterval(value).label, '—');
  assert.equal(utils.formatBlockInterval(-5, 75).level, 'unknown');
  assert.equal(utils.formatBlockInterval(75, 75).level, 'normal');
  assert.equal(utils.formatBlockInterval(75).level, 'unknown');
});
