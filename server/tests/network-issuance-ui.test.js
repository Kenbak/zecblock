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
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => dependencies[name] ?? require(name) });
  return exports;
}

const cards = load('components/ui/Card.tsx');
const { HalvingPanel } = load('components/network/HalvingPanel.tsx', {
  '@/components/ui/Card': cards,
  '@/lib/format-numbers': load('lib/format-numbers.ts'),
});
const unavailable = {
  halvingStatus: 'unavailable', halvingBlock: null, blocksRemaining: null,
  eraProgress: null, currentSubsidy: 1.5625, nextSubsidy: null,
  minerReward: null, nextMinerReward: null, estimatedDate: null, estimatedSeconds: null,
};

test('server-rendered halving panel explains unknown schedules without guessed progress', () => {
  const html = renderToStaticMarkup(React.createElement(HalvingPanel, { halving: unavailable }));
  assert.match(html, /next halving cannot currently be determined/);
  assert.doesNotMatch(html, /Current block subsidy|Next block subsidy/);
  assert.doesNotMatch(html, /Current era progress|NaN|Invalid Date/);
});

test('issuance copy describes observed cadence and keeps missing allocations unavailable', () => {
  const { MiningIssuance } = load('components/network/MiningIssuance.tsx', {
    '@/components/ui/Card': cards,
    '@/components/ui/Skeleton': { Skeleton: () => null },
    '@/components/ui/SectionHeader': { SectionHeader: () => null },
    './HalvingPanel': { HalvingPanel },
    './SupplyIssuanceChart': { SupplyIssuanceChart: () => null },
    '@/lib/config': { CURRENCY: 'TAZ' },
    '@/hooks/useApiQuery': { useApiQuery: path => ({ data: path.endsWith('/halving')
      ? unavailable : { dailyEmissionEstimate: null }, loading: false, error: null }) },
  });
  const html = renderToStaticMarkup(React.createElement(MiningIssuance));

  assert.match(html, /1\.5625/);
  assert.match(html, /After halving/);
  assert.match(html, /TAZ \/ block/);
  assert.doesNotMatch(html, /1,152|0 ZEC|NaN/);
});

function renderAccounting(active, nsmBalanceZat) {
  const { NetworkAccounting } = load('components/network/NetworkAccounting.tsx', {
    'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
    '@/components/ui/Card': cards,
    '@/components/ui/SectionHeader': { SectionHeader: () => null },
    '@/components/charts/ChartTooltip': { ChartTooltip: () => null },
    '@/contexts/ThemeContext': { useTheme: () => ({ theme: 'dark' }) },
    '@/lib/chart-theme': { getChartColors: () => ({}) },
    '@/lib/config': { NETWORK: 'mainnet', CURRENCY: 'ZEC' },
    '@/hooks/useApiQuery': { useApiQuery: path => path.endsWith('/history') ? { data: null } : { data: {
      success: true, schedule: { network: 'main', nu7Height: active ? 3497350 : null },
      nodeHeight: 3497353, nsmBalanceZat,
      block: { height: 3497353, feesPaidZat: '362088', feesToNsmZat: '217252',
        minerFeeAllocationZat: '144836', minerSubsidyZat: '125000000',
        minerReceiptsZat: '125144836', reissuanceZat: null },
    }, loading: false, error: null } },
  });
  return renderToStaticMarkup(React.createElement(NetworkAccounting));
}

test('pre-NU7 accounting stays entirely hidden', () => {
  assert.equal(renderAccounting(false, '0'), '');
});

test('active accounting preserves exact signed reserve amounts without repeating issuance', () => {
  const html = renderAccounting(true, '-9223372036854775808');
  assert.match(html, /NSM reserve/);
  assert.match(html, /-92,233,720,368\.54775808 ZEC/);
  assert.match(html, /0\.00217252 ZEC/);
  assert.match(html, /1\.25144836 ZEC/);
  assert.doesNotMatch(html, /Miner subsidy allocation|Current block subsidy|Next block subsidy|Separate reissuance amount|<dt[^>]*>Reissuance/);
  assert.match(html, /<details/);
  assert.match(html, /current node reserve can be newer than the history/);
  assert.match(renderAccounting(true, null), /NSM reserve<\/dt><dd[^>]*>Unavailable/);
});
