const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function render(data, { network = 'mainnet', error = null, historyData = undefined, metric = 'fees', period = '1d' } = {}) {
  const exports = {};
  const calls = [];
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/network/NetworkAccounting.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { useState: value => [value === 'fees' ? metric : value === '1d' ? period : value, () => {}] };
    if (name === 'recharts') return Object.fromEntries(['ComposedChart','Bar','Line','XAxis','YAxis','ResponsiveContainer','CartesianGrid'].map(key => [key,key]));
    if (name === 'next/link') return { default: 'a' };
    if (name === '@/components/ui/SectionHeader') return { SectionHeader: 'SectionHeader' };
    if (name === '@/components/charts/ChartTooltip') return { ChartTooltip: 'Tooltip' };
    if (name === '@/contexts/ThemeContext') return { useTheme: () => ({ theme: 'dark' }) };
    if (name === '@/lib/chart-theme') return { getChartColors: () => ({}) };
    if (name === '@/lib/config') return { NETWORK: network, CURRENCY: 'ZEC' };
    if (name === '@/components/ui/Card') return { Card: 'Card', CardBody: 'CardBody' };
    if (name === '@/hooks/useApiQuery') return { useApiQuery(url, params, options) {
      calls.push({ url, params, options });
      return url.endsWith('/history') ? { data: historyData } : { data, error, loading: !data };
    } };
    throw new Error(`Unexpected import ${name}`);
  } });
  return { tree: exports.NetworkAccounting(), historyEnabled: calls.find(c => c.url.endsWith('/history')).options.enabled, historyParams: calls.find(c => c.url.endsWith('/history')).params };
}
const snapshot = (height, activation = 4000000, chain = 'main') => ({ nodeHeight: height,
  schedule: { network: chain, nu7Height: activation }, block: null });

test('accounting is hidden and history is not requested before or without confirmed activation', () => {
  for (const data of [undefined, null, {}, snapshot(3999999), snapshot(5000000, null), { ...snapshot(5000000), schedule: null },
    snapshot(5000000, -1), snapshot(5000000, 1.5), snapshot(5000000, 500000000), snapshot(NaN),
    snapshot(500000000)]) {
    const result = render(data);
    assert.equal(result.tree, null);
    assert.equal(result.historyEnabled, false);
  }
});

test('the real activated testnet v1 envelope enables accounting and its history', async () => {
  const apiModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/api-client.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: apiModule, exports: apiModule.exports });
  const envelope = JSON.parse(fs.readFileSync('server/tests/fixtures/nu7-accounting.v1.json', 'utf8'));
  const data = await apiModule.exports.readApiData(new Response(JSON.stringify(envelope)));
  assert.equal(Object.hasOwn(data, 'success'), false, 'v1 data has no legacy success flag');
  const result = render(data, { network: 'testnet' });
  assert.equal(result.tree.type, 'section');
  assert.equal(result.historyEnabled, true);
  assert.equal(data.block.feesPaidZat, '20000');
  assert.equal(data.block.feesToNsmZat, '12000');
  assert.equal(data.nsmBalanceZat, '55778035961');
});
test('each network becomes visible at its own node-announced activation boundary', () => {
  for (const [network, chain, activation] of [['mainnet', 'main', 4000000], ['testnet', 'test', 4400000]]) {
    assert.equal(render(snapshot(activation - 1, activation, chain), { network }).tree, null);
    const result = render(snapshot(activation, activation, chain), { network });
    assert.equal(result.tree.type, 'section');
    assert.equal(result.historyEnabled, true);
    assert.equal(render(snapshot(activation - 1, activation, chain), { network }).tree, null, 'reorg below activation hides accounting');
  }
});
test('wrong-network, Crosslink and failed-refresh snapshots cannot expose NU7 accounting', () => {
  for (const options of [{ network: 'testnet' }, { network: 'crosslink' }, { error: new Error('unavailable') }]) {
    const result = render(snapshot(5000000), options);
    assert.equal(result.tree, null);
    assert.equal(result.historyEnabled, false);
  }
});

function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const periodHistory = { period: '1d', schedule: { network: 'test', nu7Height: 4400000 },
  nodeHeight: 4400001, indexedHeight: 4400001, bucketSeconds: 300,
  totals: { firstHeight:4400000, lastHeight:4400001, feesToNsmZat:'2' },
  selected: {blocks:2,feeBlocks:2,nsmSamples:2,missingBlocks:0,feesPaidZat:'6',feesToNsmZat:'2',minerFeeAllocationZat:'4',firstHeight:4400000,lastHeight:4400001,firstTimestamp:600,lastTimestamp:610},
  reserve: {height:4400001,baselineZat:'100',growthSinceNu7Zat:'2'},
  points: [{timestamp:600,firstHeight:4400000,lastHeight:4400001,feesPaidZat:'6',feesToNsmZat:'2',minerFeeAllocationZat:'4',nsmBalanceZat:'102',cumulativeRemovalZat:'2',minerReceiptsZat:'100'}] };
test('fee columns contain only the two allocations and the canonical block tag is in the header', () => {
  const data = {...snapshot(4400001,4400000,'test'),block:{height:4400001}};
  const result = render(data,{network:'testnet',historyData:periodHistory});
  assert.equal(result.historyParams.period,'1d');
  const bars = nodes(result.tree,'Bar');
  assert.deepEqual(bars.map(node=>node.props.dataKey),['feesToNsmZatDisplay','minerFeeAllocationZatDisplay']);
  assert.ok(bars.every(node=>node.props.stackId==='fees'));
  assert.equal(nodes(result.tree,'SectionHeader')[0].props.actions.props.href,'/block/4400001');
  assert.equal(nodes(result.tree,'button').length,8);
});
test('range changes never plot retained data under a new period, and reserve/cumulative use steps', () => {
  const data = snapshot(4400001,4400000,'test');
  const stale = render(data,{network:'testnet',historyData:periodHistory,period:'30d'});
  assert.equal(stale.historyParams.period,'30d'); assert.equal(nodes(stale.tree,'ComposedChart').length,0);
  for(const metric of ['reserve','cumulative']) {
    const result = render(data,{network:'testnet',historyData:periodHistory,metric});
    assert.equal(nodes(result.tree,'Line')[0].props.type,'stepAfter');
    assert.equal(nodes(result.tree,'Line')[0].props.connectNulls,false);
  }
});
