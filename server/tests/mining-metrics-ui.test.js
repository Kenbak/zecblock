const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');

function render(data, { active = 'solrate', loading = false, error = null, currency = 'TAZ' } = {}) {
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/network/MiningMetricsChart.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { useState: () => [active, () => {}] };
    if (name === 'recharts') return Object.fromEntries(['LineChart', 'Line', 'XAxis', 'YAxis', 'CartesianGrid', 'ResponsiveContainer'].map(key => [key, key]));
    if (name === '@/components/charts/ChartTooltip') return { ChartTooltip: 'Tooltip' };
    if (name === '@/contexts/ThemeContext') return { useTheme: () => ({ theme: 'dark' }) };
    if (name === '@/lib/chart-theme') return { getChartColors: () => ({ gold: '#d4a44a' }) };
    if (name === '@/lib/format-numbers') return { formatHashrate: String, formatDifficulty: String };
    if (name === '@/hooks/useApiQuery') return { useApiQuery: () => ({ data, loading, error }) };
    if (name === '@/lib/config') return { CURRENCY: currency };
    if (name === './ChartCard') return { ChartCard: 'ChartCard' };
    if (name === '@/components/charts/PanelShareControl') return { objectRowsCsv: () => null };
    throw new Error(`Unexpected import ${name}`);
  } });
  return exports.MiningMetricsChart();
}

function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(item => nodes(item, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}

function textContent(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (typeof tree === 'object') return textContent(tree.props?.children);
  return String(tree);
}

const sparse = {
  solrateMethod: 'difficulty-work-over-elapsed-v1',
  latest: { solrate: null, txFees: 0.001 },
  points: [null, 1000, null].map((solrate, i) => ({ height: 1000 + i, solrate, txFees: 0.001 })),
};

test('known isolated mining points render real dots while unknown points remain gaps', () => {
  const tree = render(sparse);
  const chart = nodes(tree, 'LineChart')[0];
  const line = nodes(tree, 'Line')[0];
  assert.equal(line.props.type, 'linear');
  assert.equal(line.props.connectNulls, false);
  assert.deepEqual(Array.from(chart.props.data, p => p.solrate), [null, 1000, null]);

  // Use Recharts' real coordinate calculator and SVG primitives. A single
  // known value between nulls must have area even though no line can join it.
  const chartRequire = createRequire(require.resolve('recharts/package.json'));
  const React = chartRequire('react');
  const { renderToStaticMarkup } = chartRequire('react-dom/server');
  const { computeLinePoints } = chartRequire('./lib/cartesian/Line');
  const { Dot, Curve } = chartRequire('.');
  const points = computeLinePoints({
    layout: 'horizontal', dataKey: line.props.dataKey, bandSize: 0, displayedData: chart.props.data,
    xAxis: { type: 'category', allowDuplicatedCategory: true },
    xAxisTicks: [{ coordinate: 0 }, { coordinate: 100 }, { coordinate: 200 }], yAxisTicks: [],
    yAxis: { type: 'number', scale: { map: value => 250 - Number(value) / 10 } },
  });
  const svg = renderToStaticMarkup(React.createElement('svg', {}, [
    React.createElement(Curve, { key: 'curve', points, type: line.props.type, connectNulls: line.props.connectNulls }),
    ...points.map((point, i) => React.createElement(Dot, {
      ...line.props.dot, key: i, cx: point.x, cy: point.y ?? undefined,
    })),
  ]));
  assert.equal((svg.match(/<circle\b/g) || []).length, 1);
  const circle = svg.match(/<circle\b[^>]+>/)[0];
  for (const attribute of ['cx="100"', 'cy="150"', 'r="2"']) assert.ok(circle.includes(attribute));
  assert.doesNotMatch(svg, /L/, 'unknown points are not bridged by a line');
});

test('empty, incomplete, failed and loading charts explain why no series is displayed', () => {
  for (const [data, options, expected] of [
    [null, { loading: true }, /Loading mining metrics/],
    [null, { error: 'HTTP 503' }, /temporarily unavailable/],
    [{ points: [] }, {}, /No complete 20-block window/],
    [{ points: [{ height: 1, solrate: null }] }, {}, /No complete 20-block window/],
  ]) {
    const tree = render(data, options);
    assert.equal(nodes(tree, 'LineChart').length, 0);
    assert.match(textContent(tree), expected);
    assert.ok(nodes(tree, 'div').some(node => node.props.role === 'status'));
  }
});

test('refresh errors retain valid points with an explicit stale-data message', () => {
  const tree = render(sparse, { error: 'Request timed out' });
  assert.equal(nodes(tree, 'LineChart').length, 1);
  assert.match(textContent(tree), /Showing the last received mining metrics/);
});

test('method copy remains accurate during rolling API upgrades and testnet fees use TAZ', () => {
  assert.match(textContent(render(sparse)), /total difficulty and elapsed header time/);
  assert.doesNotMatch(textContent(render({ ...sparse, solrateMethod: undefined })), /total difficulty and elapsed header time/);
  for (const currency of ['TAZ', 'ZEC']) {
    const tree = render(sparse, { currency, active: 'txFees' });
    assert.match(textContent(tree), new RegExp(`0.001000 ${currency}`));
    const tooltip = nodes(tree, 'Tooltip')[0];
    assert.equal(tooltip.props.formatter(0.001)[0], `0.001000 ${currency}`);
  }
});
