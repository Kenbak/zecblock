const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const ts = require('typescript');

function render(data, { network = 'mainnet', error = null, historyData = undefined, metric = 'fees', period = '30d' } = {}) {
  const exports = {};
  const calls = [];
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/network/NetworkAccounting.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { useState: value => [value === 'fees' ? metric : value === '30d' ? period : value, () => {}] };
    if (name === '@/lib/use-url-state') return { useUrlState: (key, fallback) => [fallback === '30d' ? period : fallback, () => {}] };
    if (name === 'recharts') return Object.fromEntries(['ComposedChart','Bar','Line','XAxis','YAxis','ResponsiveContainer','CartesianGrid'].map(key => [key,key]));
    if (name === 'next/link') return { default: 'a' };
    if (name === '@/components/ui/SectionHeader') return { SectionHeader: 'SectionHeader' };
    if (name === '@/components/charts/ChartTooltip') return { ChartTooltip: 'Tooltip' };
    if (name === '@/contexts/ThemeContext') return { useTheme: () => ({ theme: 'dark' }) };
    if (name === '@/lib/chart-theme') return { getChartColors: () => ({ gold: '#d4a44a' }) };
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

test('the stable NSM overview replaces observations before or without confirmed activation', () => {
  for (const data of [undefined, null, {}, snapshot(3999999), snapshot(5000000, null), { ...snapshot(5000000), schedule: null },
    snapshot(5000000, -1), snapshot(5000000, 1.5), snapshot(5000000, 500000000), snapshot(NaN),
    snapshot(500000000)]) {
    const result = render(data);
    assert.equal(result.tree.type, 'section');
    assert.equal(result.tree.props.id, 'nu7-accounting');
    assert.equal(result.historyEnabled, false);
    assert.equal(nodes(result.tree, 'ComposedChart').length, 0);
    assert.match(textContent(result.tree), /Mechanism overview/);
    assert.doesNotMatch(textContent(result.tree), /0(?:\.0+)? ZEC|Minimum removal since NU7|Reserve growth since NU7/);
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
test('each network switches from mechanism overview to observations at its own activation boundary', () => {
  for (const [network, chain, activation] of [['mainnet', 'main', 4000000], ['testnet', 'test', 4400000]]) {
    const pending = render(snapshot(activation - 1, activation, chain), { network });
    assert.equal(pending.tree.props.id, 'nu7-accounting');
    assert.equal(pending.historyEnabled, false);
    assert.match(textContent(pending.tree), /accounting charts begin at NU7/);
    assert.ok(textContent(pending.tree).includes(activation.toLocaleString('en-US')));
    const result = render(snapshot(activation, activation, chain), { network });
    assert.equal(result.tree.type, 'section');
    assert.equal(result.historyEnabled, true);
    const reorg = render(snapshot(activation - 1, activation, chain), { network });
    assert.equal(reorg.historyEnabled, false, 'reorg below activation hides observations');
    assert.match(textContent(reorg.tree), /Mechanism overview/);
  }
});
test('wrong-network, Crosslink and failed-refresh snapshots cannot expose NU7 accounting', () => {
  for (const options of [{ network: 'testnet' }, { network: 'crosslink' }, { error: new Error('unavailable') }]) {
    const result = render(snapshot(5000000), options);
    assert.equal(result.historyEnabled, false);
    if (options.network === 'crosslink') {
      assert.equal(result.tree, null);
    } else {
      assert.equal(result.tree.props.id, 'nu7-accounting');
      assert.match(textContent(result.tree), /live activation status is unavailable/);
      assert.doesNotMatch(textContent(result.tree), /0(?:\.0+)? ZEC|Minimum removal since NU7|Reserve growth since NU7/);
      assert.equal(nodes(result.tree, 'ComposedChart').length, 0);
    }
  }
});

function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
const periodHistory = { period: '30d', schedule: { network: 'test', nu7Height: 4400000 },
  nodeHeight: 4400001, indexedHeight: 4400001, bucketSeconds: 300,
  totals: { firstHeight:4400000, lastHeight:4400001, feesToNsmZat:'2' },
  selected: {blocks:2,feeBlocks:2,nsmSamples:2,missingBlocks:0,feesPaidZat:'6',feesToNsmZat:'2',minerFeeAllocationZat:'4',firstHeight:4400000,lastHeight:4400001,firstTimestamp:600,lastTimestamp:610},
  reserve: {height:4400001,baselineZat:'100',growthSinceNu7Zat:'2'},
  points: [{timestamp:600,firstHeight:4400000,lastHeight:4400001,feesPaidZat:'6',feesToNsmZat:'2',minerFeeAllocationZat:'4',nsmBalanceZat:'102',cumulativeRemovalZat:'2',minerReceiptsZat:'100'}] };
test('fee columns contain only the two allocations and the canonical block tag is in the header', () => {
  const data = {...snapshot(4400001,4400000,'test'),block:{height:4400001}};
  const result = render(data,{network:'testnet',historyData:periodHistory});
  assert.equal(result.historyParams.period,'30d');
  const bars = nodes(result.tree,'Bar');
  assert.deepEqual(bars.map(node=>node.props.dataKey),['feesToNsmZatDisplay','minerFeeAllocationZatDisplay']);
  assert.ok(bars.every(node=>node.props.stackId==='fees'));
  assert.equal(nodes(result.tree,'SectionHeader')[0].props.actions.props.href,'/block/4400001');
  assert.equal(nodes(result.tree,'button').length,8);
});
test('range changes never plot retained data under a new period, and reserve/cumulative use steps', () => {
  const data = snapshot(4400001,4400000,'test');
  const stale = render(data,{network:'testnet',historyData:periodHistory,period:'1d'});
  assert.equal(stale.historyParams.period,'1d'); assert.equal(nodes(stale.tree,'ComposedChart').length,0);
  for(const metric of ['reserve','cumulative']) {
    const result = render(data,{network:'testnet',historyData:periodHistory,metric});
    assert.equal(nodes(result.tree,'Line')[0].props.type,'stepAfter');
    assert.equal(nodes(result.tree,'Line')[0].props.connectNulls,false);
  }
});

test('reserve points use their recorded sample time, show provenance, and keep empty buckets null', () => {
  const historyData = { ...periodHistory, selected: { ...periodHistory.selected, nsmSamples: 1 },
    points: [
      { ...periodHistory.points[0], nsmSampleHeight: 4400000, nsmSampleHash: 'canonical-sample-hash', nsmSampleTimestamp: 605 },
      { ...periodHistory.points[0], timestamp: 900, nsmBalanceZat: null, nsmSampleHeight: null, nsmSampleHash: null, nsmSampleTimestamp: null },
    ] };
  const data = snapshot(4400001,4400000,'test');
  const result = render(data,{network:'testnet',historyData,metric:'reserve'});
  const chart = nodes(result.tree,'ComposedChart')[0];
  assert.deepEqual(Array.from(chart.props.data, point => point.chartTimestamp), [605,900]);
  assert.deepEqual(Array.from(chart.props.data, point => point.nsmBalanceZatDisplay), [0.00000102,null]);
  assert.equal(nodes(result.tree,'XAxis')[0].props.dataKey,'chartTimestamp');
  const line = nodes(result.tree,'Line')[0];
  assert.equal(line.props.connectNulls,false);
  assert.ok(line.props.dot.r > 0, 'isolated real reserve observations must be visible');
  const tooltip = nodes(result.tree,'Tooltip')[0].props;
  const label = textContent(tooltip.labelFormatter(605,[{payload:historyData.points[0]}]));
  assert.match(label,/Recorded at block 4,400,000/);
  assert.match(label,/canonical-sample-hash/);
  assert.match(label,/1970-01-01T00:10:05.000Z/);
  assert.match(label,/1 blocks before this bucket/);
  assert.match(textContent(result.tree),/1 of 2 reported buckets have a reserve observation/);
  const fees = render(data,{network:'testnet',historyData});
  assert.deepEqual(Array.from(nodes(fees.tree,'ComposedChart')[0].props.data, point => point.chartTimestamp),[600,900]);
});

function textContent(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (typeof tree === 'object') return textContent(tree.props?.children);
  return String(tree);
}

// Complete fees do not imply complete coinbase-receipt observations. The middle
// receipt bucket is isolated between unknown totals, as in the real 7D incident.
const sparseReceiptHistory = {
  ...periodHistory, period: '7d', bucketSeconds: 2700, nodeHeight: 4400005, indexedHeight: 4400005,
  selected: { ...periodHistory.selected, blocks: 6, feeBlocks: 6, receiptBlocks: 3, nsmSamples: 6,
    lastHeight: 4400005, lastTimestamp: 6010 },
  points: [null, '2500000000', null].map((minerReceiptsZat, i) => ({
    ...periodHistory.points[0], timestamp: 600 + i * 2700,
    firstHeight: 4400000 + i * 2, lastHeight: 4400001 + i * 2,
    blocks: 2, feeBlocks: 2, receiptBlocks: [1, 2, 0][i], nsmSamples: 2,
    missingBlocks: 0, minerReceiptsZat,
  })),
};

test('isolated receipt buckets render real Recharts bars while unknown totals remain absent', () => {
  const result = render(snapshot(4400005, 4400000, 'test'), {
    network: 'testnet', historyData: sparseReceiptHistory, period: '7d', metric: 'receipts',
  });
  const chart = nodes(result.tree, 'ComposedChart')[0];
  const bars = nodes(result.tree, 'Bar');
  assert.equal(bars.length, 1);
  assert.equal(nodes(result.tree, 'Line').length, 0);
  assert.equal(bars[0].props.dataKey, 'minerReceiptsZatDisplay');
  assert.equal(bars[0].props.stackId, undefined);
  assert.deepEqual(Array.from(chart.props.data, point => point.minerReceiptsZatDisplay), [null, 25, null]);

  // Recharts' complete chart needs browser layout effects. Exercise its actual
  // bar geometry and SVG renderer here, rather than only checking mocked props.
  const chartRequire = createRequire(require.resolve('recharts/package.json'));
  const React = chartRequire('react');
  const { renderToStaticMarkup } = chartRequire('react-dom/server');
  const { computeBarRectangles } = chartRequire('./lib/cartesian/Bar');
  const { Rectangle } = chartRequire('.');
  const rectangles = computeBarRectangles({
    layout: 'horizontal', barSettings: { ...bars[0].props, minPointSize: 0, hasCustomShape: false },
    pos: { offset: 0, size: bars[0].props.maxBarSize }, bandSize: 100,
    xAxis: { type: 'category' },
    yAxis: { type: 'number', scale: { domain: () => [0, 50], map: value => value == null ? undefined : 250 - Number(value) * 5 } },
    xAxisTicks: chart.props.data.map((_, i) => ({ coordinate: i * 100 })), yAxisTicks: [],
    displayedData: chart.props.data, offset: { top: 0, left: 0, width: 300, height: 250 }, dataStartIndex: 0,
  });
  assert.equal(rectangles.length, 1, 'unknown receipt buckets must not become zero-filled bars');
  assert.equal(rectangles[0].payload.timestamp, 3300);
  assert.ok(rectangles[0].width > 0 && rectangles[0].height > 0, 'isolated known bucket has visible area');
  const svg = renderToStaticMarkup(React.createElement('svg', null, rectangles.map((rectangle, i) => React.createElement(Rectangle, {
    key: i, x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height, fill: bars[0].props.fill,
  }))));
  assert.match(svg, /class="recharts-rectangle"/);
  assert.match(svg, /fill="#d4a44a"/);
  assert.equal((svg.match(/<path/g) || []).length, 1);
  assert.match(svg, /d="[^"]+"/);
});

test('receipt coverage distinguishes missing receipt observations from complete fees', () => {
  const data = snapshot(4400005, 4400000, 'test');
  const options = { network: 'testnet', historyData: sparseReceiptHistory, period: '7d', metric: 'receipts' };
  const text = textContent(render(data, options).tree);
  assert.match(text, /3 of 6 blocks have miner receipts/);
  assert.match(text, /1 of 3 reported buckets have complete receipts/);
  assert.match(text, /Incomplete receipt buckets remain gaps/);
  assert.doesNotMatch(text, /blocks have complete fees/);

  for (const receiptBlocks of [undefined, null, -1, 7, '3']) {
    const historyData = { ...sparseReceiptHistory, selected: { ...sparseReceiptHistory.selected, receiptBlocks } };
    const fallback = textContent(render(data, { ...options, historyData }).tree);
    assert.match(fallback, /Block receipt coverage unavailable/);
    assert.match(fallback, /1 of 3 reported buckets have complete receipts/);
  }

  const historyData = { ...sparseReceiptHistory,
    points: sparseReceiptHistory.points.map(point => ({ ...point, minerReceiptsZat: null })) };
  const empty = render(data, { ...options, historyData });
  assert.equal(nodes(empty.tree, 'ComposedChart').length, 0);
  assert.match(textContent(empty.tree), /No complete observations for this metric in this period/);
  assert.match(textContent(empty.tree), /0 of 3 reported buckets have complete receipts/);
});
