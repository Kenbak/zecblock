'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(result, calls = []) {
  const source = fs.readFileSync(path.join(__dirname, '../../components/crosschain/ShieldedRate.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const stub = ({ children }) => React.createElement('div', null, children);
  const overrides = {
    recharts: new Proxy({}, { get: () => stub }),
    '@/components/charts/ChartTooltip': { ChartTooltip: stub },
    '@/components/network/ChartCard': { ChartCard: ({ title, children, controls }) => React.createElement('section', null, React.createElement('h2', null, title), controls, children) },
    '@/components/charts/PanelShareControl': { objectRowsCsv: () => null },
    '@/components/ui/PeriodPillTags': { PeriodPillTags: ({ value }) => React.createElement('span', { 'data-period': value }) },
    '@/contexts/ThemeContext': { useTheme: () => ({ theme: 'dark' }) },
    '@/lib/chart-theme': { getChartColors: () => new Proxy({}, { get: () => '#000000' }) },
    '@/hooks/useApiQuery': { useApiQuery: (route, query) => { calls.push({ route, query }); return result; } },
    './model': { CHAINS: { eth: 'Ethereum' } },
  };
  new Function('require', 'module', 'exports', code)((n) => (Object.hasOwn(overrides, n) ? overrides[n] : require(n)), module, module.exports);
  return module.exports.ShieldedRate;
}

const breakdown = { shieldedOnArrival: '25000000', shieldedAfter: '350000000', held: '50000000', exchange: '0', bridge: '0', transferred: '0' };
const slice = { swaps: 6, coveredSwaps: 4, swapCoverage: 0.6667, uncovered: { noZecTx: 1, txNotIndexed: 0, unmatched: 1 },
  coveredZat: '425000000', shieldedZat: '375000000', shieldedRate: 0.8823, breakdownZat: breakdown, shieldedArrivals: 1 };
const data = { period: '90d', summary: slice, daily: [{ date: '2026-11-01', ...slice }], byChain: [{ chain: 'eth', ...slice }],
  timeToShield: { samples: 2, medianMinutes: 15.5, p90Minutes: 27.1 },
  coverage: { sourceSwaps: 7, classifiedSwaps: 6, pendingClassification: 1, lastClassifiedAt: null, intentsBalanceSwaps: 3 } };

test('renders rate, coverage and exclusions from exact zatoshi strings', () => {
  const calls = [];
  const ShieldedRate = load({ data, loading: false, error: null }, calls);
  const html = renderToStaticMarkup(React.createElement(ShieldedRate, { dashboardPeriod: '7d' }));
  assert.deepEqual(calls[0], { route: '/v1/crosschain/shielding', query: { period: '30d' } }, 'short dashboard periods widen to 30d');
  assert.match(html, /88\.2%/);
  assert.match(html, /3\.75 ZEC of 4\.25 ZEC delivered/);
  assert.match(html, /4 of 6 swaps traceable on chain/);
  assert.match(html, /1 with no Zcash transaction/);
  assert.match(html, /1 newer swaps await classification/);
  assert.match(html, /16 min/);
  assert.match(html, /Ethereum/);
  assert.match(html, /3 more were kept as NEAR Intents balances/);
});

test('unavailable index shows no inferred rate', () => {
  const ShieldedRate = load({ data: null, loading: false, error: 'HTTP 503' });
  const html = renderToStaticMarkup(React.createElement(ShieldedRate, { dashboardPeriod: '30d' }));
  assert.match(html, /unavailable: HTTP 503\. No rate is inferred/);
  assert.doesNotMatch(html, /%/);
});

test('empty period renders dashes, not zero percent', () => {
  const empty = { ...slice, swaps: 0, coveredSwaps: 0, swapCoverage: null, uncovered: { noZecTx: 0, txNotIndexed: 0, unmatched: 0 },
    coveredZat: '0', shieldedZat: null, shieldedRate: null, breakdownZat: { ...breakdown, shieldedOnArrival: '0', shieldedAfter: '0', held: '0' } };
  const ShieldedRate = load({ data: { ...data, summary: empty, daily: [], byChain: [], timeToShield: { samples: 0, medianMinutes: null, p90Minutes: null } }, loading: false, error: null });
  const html = renderToStaticMarkup(React.createElement(ShieldedRate, { dashboardPeriod: 'all' }));
  assert.doesNotMatch(html, /0\.0%/);
  assert.match(html, /No covered swaps in this period/);
});
