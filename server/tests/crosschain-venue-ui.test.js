'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(name, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../components/crosschain', name), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const customRequire = name => name === 'next/link' ? props => React.createElement('a', Object.fromEntries(Object.entries(props).filter(([key]) => !['prefetch', 'children'].includes(key))), props.children)
    : Object.hasOwn(overrides, name) ? overrides[name] : require(name);
  new Function('require', 'module', 'exports', code)(customRequire, module, module.exports);
  return module.exports;
}
const { scopeVenueHref } = load('VenueContext.tsx');
const venueContext = load('VenueContext.tsx');
const panelTitle = load('PanelTitle.tsx');
const { VenueTransferDetails } = load('VenueTransferDetails.tsx', { './model': { EXPLORERS: { eth: 'https://etherscan.io/tx/' } } });
const txid = 'a'.repeat(64);
const leg = { side: 'in', txid, address: 't1FullAddress', affiliate: false, coins: [{ asset: 'ZEC.ZEC', chain: 'zec', token: 'ZEC', amountBaseUnits: '10000001', decimals: 8, amount: '0.10000001' }] };
const record = { id: 'maya-swap-' + txid, sourceAddress: 't1FullAddress', actionType: 'swap', refundKind: null, observedStatus: 'success', createdAt: '2026-10-29T10:00:00.000Z', streaming: true,
  zecAmount: '0.10000001', zecAmountZat: '10000001', zecAmountBasis: 'midgard-reported-native-zec-input', inputs: [leg], outputs: [] };

test('every provider chart/filter/pagination href retains dataset, query and fragment; NEAR URLs stay unchanged', () => {
  for (const venue of ['maya', 'thorchain']) {
    const result = new URL(scopeVenueHref('/crosschain?period=7d&chain=eth&status=SUCCESS&cursor=opaque#swaps', venue), 'https://zecblock.com');
    assert.equal(result.searchParams.get('venue'), venue);
    assert.equal(result.searchParams.get('period'), '7d');
    assert.equal(result.searchParams.get('chain'), 'eth');
    assert.equal(result.searchParams.get('cursor'), 'opaque');
    assert.equal(result.hash, '#swaps');
  }
  assert.equal(scopeVenueHref('/crosschain?period=7d#swaps', 'near'), '/crosschain?period=7d#swaps');
  assert.equal(scopeVenueHref('https://example.com/crosschain', 'maya'), 'https://example.com/crosschain');
});

test('provider detail shows full identifiers, exact native amounts and source semantics without NEAR-only fields', () => {
  const html = renderToStaticMarkup(React.createElement(VenueTransferDetails, { record }));
  assert.match(html, /0\.10000001 ZEC \(10000001 zat\)/);
  assert.ok(html.includes('href="/tx/' + txid + '"'));
  assert.ok(html.includes('>' + txid + '</a>'));
  assert.match(html, /Reported source address/);
  assert.match(html, /2026-10-29 10:00:00 UTC/);
  assert.doesNotMatch(html, /Deposit address|NEAR transactions|Intent hashes/);
});

test('Maya native asset units and partial refunds retain their exact meaning', () => {
  const partial = { ...record, actionType: 'refund', refundKind: 'partial', zecAmount: null, zecAmountZat: null,
    outputs: [{ side: 'out', txid: null, address: 'maya-affiliate', affiliate: true, coins: [
      { asset: 'MAYA.CACAO', chain: 'maya', token: 'CACAO', amountBaseUnits: '12345678901', decimals: 10, amount: '1.2345678901' },
      { asset: 'MAYA.MAYA', chain: 'maya', token: 'MAYA', amountBaseUnits: '12345', decimals: 4, amount: '1.2345' },
    ] }] };
  const html = renderToStaticMarkup(React.createElement(VenueTransferDetails, { record: partial }));
  assert.match(html, /Partial refund/);
  assert.match(html, /12345678901 in 1e10 units/);
  assert.match(html, /12345 in 1e4 units/);
  assert.match(html, /this refund is not another successful swap/);
  assert.doesNotMatch(html, /undefined in 1e8/);
});

test('venue tabs lead the controls that scope the statistics and shared visualizations, with NEAR defaults preserved', () => {
  const analytics = {
    period: '30d', granularity: 'day', start: '2026-10-01T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z',
    coverage: { source: 'test-index', records: 2, earliest: '2026-10-01T00:00:00.000Z', latest: '2026-10-29T00:00:00.000Z', missingZecHash: 0, internalSwaps: 0, syncedThrough: '2026-10-29T00:00:00.000Z', continuousThrough: '2026-10-29T00:00:00.000Z', stale: false, statusesAvailable: ['SUCCESS', 'REFUNDED'], historyTraversalComplete: false, backfill: [], note: 'Fixture coverage' },
    summary: { swaps: 2, volume_usd: '456', volume_zec: '123', inflow_usd: '456', outflow_usd: '0', inflow_zec: '123', outflow_zec: '0', average_usd: '228', average_zec: '61.5', median_usd: '228', median_zec: '61.5', missing_usd: 0, missing_zec: 0, sender_addresses: 1 },
    trends: [], flows: [], routes: [], distribution: [], statuses: [{ status: 'SUCCESS', count: 3 }, { status: 'REFUNDED', count: 1 }], latency: [], referrals: [], latencyDefinition: 'No fixture latency', volumeDefinition: 'Fixture amounts',
  };
  for (const venue of ['near', 'maya', 'thorchain']) {
    const calls = [];
    const stub = () => null;
    const { CrosschainDashboard } = load('CrosschainDashboard.tsx', {
      '@/hooks/useApiQuery': { useApiQuery: (route, query) => { calls.push({ route, query }); return route.endsWith('/supply') ? { data: null } : { data: analytics, loading: false, error: null, isRefreshing: false }; } },
      '@/components/RelativeTime': { RelativeTimeProvider: ({ children }) => React.createElement(React.Fragment, null, children) },
      '@/components/TokenChainIcon': { TokenChainIcon: stub },
      '@/components/PageSectionNav': { PageSectionNav: stub },
      './VenueContext': venueContext,
      './PanelTitle': panelTitle,
      './SwapFilterLink': { useAnalyticsPeriod: value => value, SwapFilterLink: ({ children, href }) => React.createElement('a', { href }, children) },
      './SwapExplorer': { SwapExplorer: stub },
      './LatencyComparisonChart': { LatencyComparisonChart: stub },
      './ChainHistory': { ChainHistory: stub },
      './OutcomeBreakdown': { OutcomeBreakdown: stub },
      './ChainFlowOverview': { ChainFlowOverview: stub },
      './WrappedZecTracker': { WrappedZecTracker: stub },
      './ActivityCharts': { ActivityCharts: ({ panel }) => React.createElement('div', { 'data-chart': panel || 'volume' }) },
      './model': { CHAINS: {}, IS_DEMO: false, PERIODS: ['7d', '30d'], date: value => value || 'Unknown', href: params => '/crosschain?' + new URLSearchParams(params), value: (amount, unit) => amount == null ? 'Unavailable' : amount + ' ' + unit },
    });
    const html = renderToStaticMarkup(React.createElement(CrosschainDashboard, { venue, params: { period: '30d' }, venueTabs: React.createElement('nav', { 'data-testid': 'venue-tabs' }, 'Data source tabs') }));
    assert.equal(calls[0].route, venue === 'near' ? '/v1/crosschain/analytics' : '/v1/crosschain/venues/analytics');
    assert.deepEqual(calls[0].query, venue === 'near' ? { period: '30d' } : { period: '30d', venue });
    const amount = venue === 'near' ? '456 usd' : '123 zec';
    assert.ok(html.indexOf('data-testid="venue-tabs"') < html.indexOf('aria-label="Analytics period"'));
    assert.ok(html.indexOf('aria-label="Analytics period"') < html.indexOf(amount));
    assert.ok(html.indexOf(amount) < html.indexOf('data-chart="volume"'));
    assert.match(html, /Net into ZEC/);
    assert.match(html, /75\.0% of 4/);
    assert.match(html, /25\.0% of 4/);
    assert.match(html, /Not reported/);
    assert.doesNotMatch(html, /status=FAILED/);
    if (venue !== 'near') assert.match(html, /Historical backfill is in progress/);
    assert.match(html, /Historical backfill in progress/);
  }
});
