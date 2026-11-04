'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Date, require(name) {
    if (name in mocks) return mocks[name];
    throw Error(`Unexpected import: ${name}`);
  } });
  return exports;
}
const { clusterNodeLocations } = load('lib/node-map-locations.ts');
const location = (countryCode, nodeCount, extra = {}) => ({ country: countryCode, countryCode,
  lat: 49, lon: 2, nodeCount, avgPingMs: 10, topClient: 'Zebra', topIsp: 'Provider A', ...extra });

function visit(tree, predicate, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (predicate(tree)) out.push(tree);
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) visit(child, predicate, out);
  return out;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree);
}
function mapHarness({ version = 3, fail = false, torNodes = 4, torClassificationAvailable,
  locations = [location('GB', 10), location('FR', 9), location('FR', 8)] } = {}) {
  const state = []; let cursor = 0;
  const jsx = (type, props, key) => ({ type, props, key });
  const stats = { censusVersion: version, chainQualifiedCrawlerNodes: 20, localPeerOnlyNodes: 12, activeNodes: 32, totalNodes: 100, countries: 2, cities: 2,
    avgPingMs: 10, torNodes, torClassificationAvailable, lastUpdated: '2026-10-19T00:30:00.000Z' };
  const { NodeMap } = load('components/NodeMap.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: { useId: () => 'node-map-test', useMemo: fn => fn(), useState: value => { const index = cursor++; if (!(index in state)) state[index] = value; return [state[index], next => { state[index] = next; }]; } },
    'next/link': { default: 'Link' },
    '@/components/ui/Skeleton': { LoadingRegion: 'LoadingRegion', Skeleton: 'Skeleton' },
    '@/components/network/NodeGlobe': { NodeGlobe: 'NodeGlobe' },
    '@/components/network/NodePlanisphere': { NodePlanisphere: 'NodePlanisphere' },
    '@/lib/network-colors': { clientLabel: value => value },
    '@/lib/node-map-locations': { clusterNodeLocations },
    '@/hooks/useApiQuery': { useApiQuery: path => ({ loading: false, error: fail ? 'offline' : null,
      data: path.endsWith('/stats') ? { stats, trends: { change24h: null, change7d: null, change30d: null },
        topCountries: [{ country: 'France', countryCode: 'FR', nodeCount: 17 }, { country: 'Britain', countryCode: 'GB', nodeCount: 10 }] } : { locations } }) },
  });
  return () => { cursor = 0; return NodeMap({}); };
}

function detailHarness({ version = 3, torNodes = 4, torClassificationAvailable } = {}) {
  let cursor = 0;
  const jsx = (type, props, key) => ({ type, props, key });
  const stats = { censusVersion: version, activeNodes: 32, totalNodes: 100, countries: 2, cities: 2,
    avgPingMs: 10, torNodes, torClassificationAvailable, lastUpdated: null };
  const { default: NodesClient } = load('app/network/nodes/NodesClient.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: { useState: initial => [cursor++ === 1 ? stats : initial, () => {}], useEffect: () => {}, useCallback: fn => fn },
    'next/link': { default: 'Link' },
    '@/lib/api-client': { readApiData: () => {} },
    '@/lib/api-config': { getApiUrl: () => 'https://api.example.test' },
    '@/components/ui/EmptyState': { SkeletonTable: 'SkeletonTable' },
    '@/components/ChartWatermark': { ChartWatermark: 'ChartWatermark' },
    '@/components/ui/Skeleton': { ChartCardSkeleton: 'ChartCardSkeleton' },
    '@/components/ui/Card': { Card: 'Card', CardBody: 'CardBody' },
    '@/components/ExportButton': { ExportButton: () => null },
    '@/components/ui/SectionHeader': { PageHeader: 'PageHeader', SectionHeader: 'SectionHeader' },
    '@/components/network/NodeMapExplorer': { NodeMapExplorer: 'NodeMapExplorer' },
    '@/lib/network-colors': { clientLabel: value => value, clientColor: () => 'gold' },
    '@/components/ui/RadialGauge': { scoreColor: () => 'gold' },
  });
  return NodesClient();
}

function torMetric(tree, childType) {
  return visit(tree, node => node.type === 'div' &&
    [node.props?.children].flat().some(child => child?.type === childType && text(child) === 'Tor classified'))[0];
}

test('border-adjacent countries retain their counts and filters independently', () => {
  const render = mapHarness(); let tree = render();
  const initialGlobe = visit(tree, n => n.type === 'NodeGlobe')[0];
  assert.equal(initialGlobe.props.selectedCountry, null);
  const france = visit(tree, n => n.type === 'button').find(n => text(n).includes('France'));
  france.props.onClick(); tree = render();
  const globe = visit(tree, n => n.type === 'NodeGlobe')[0];
  assert.equal(globe.props.selectedCountry, 'FR');
  assert.equal(globe.props.locations.length, 2);
  assert.ok(globe.props.locations.some(n => n.countryCode === 'FR' && n.nodeCount === 17));
  assert.ok(globe.props.locations.some(n => n.countryCode === 'GB' && n.nodeCount === 10));
  assert.equal(globe.props.locations.reduce((sum, n) => sum + n.nodeCount, 0), 27);
  assert.equal(initialGlobe.props.locations.length, globe.props.locations.length, 'filtering preserves other countries for the globe');
  visit(tree, n => n.props?.role === 'tab' && text(n) === 'Map')[0].props.onClick(); tree = render();
  const planisphere = visit(tree, n => n.type === 'NodePlanisphere')[0];
  assert.equal(planisphere.props.selectedCountry, 'FR', 'country selection survives a view change');
  assert.deepEqual(planisphere.props.locations, globe.props.locations, 'both views receive identical geographic groups');
  visit(tree, n => n.type === 'button').find(n => text(n).includes('France')).props.onClick();
  assert.equal(visit(render(), n => n.type === 'NodePlanisphere')[0].props.selectedCountry, null);
});

test('view tabs default to Globe, mount one view, and connect their active panel accessibly', () => {
  const render = mapHarness(); let tree = render();
  const tabs = () => visit(tree, n => n.props?.role === 'tab');
  const globe = tabs().find(n => text(n) === 'Globe');
  const map = tabs().find(n => text(n) === 'Map');
  assert.equal(visit(tree, n => n.props?.role === 'tablist')[0].props['aria-label'], 'Node map view');
  assert.equal(globe.props['aria-selected'], true);
  assert.equal(globe.props.tabIndex, 0);
  assert.equal(map.props['aria-selected'], false);
  assert.equal(map.props.tabIndex, -1);
  assert.equal(visit(tree, n => n.type === 'NodeGlobe').length, 1);
  assert.equal(visit(tree, n => n.type === 'NodePlanisphere').length, 0);
  assert.equal(visit(tree, n => n.props?.role === 'tabpanel').length, 2, 'both tab control references resolve');
  let panel = visit(tree, n => n.props?.role === 'tabpanel' && !n.props.hidden)[0];
  assert.equal(panel.props.id, globe.props['aria-controls']);
  assert.equal(panel.props['aria-labelledby'], globe.props.id);
  const child = visit(tree, n => n.type === 'NodeGlobe')[0];
  child.props.onHover(child.props.locations[0]); tree = render();
  assert.ok(text(tree).includes('Geographic group · approximate location'));
  map.props.onClick(); tree = render();
  assert.equal(visit(tree, n => n.type === 'NodeGlobe').length, 0, 'hidden globe is unmounted');
  assert.equal(visit(tree, n => n.type === 'NodePlanisphere').length, 1);
  assert.ok(!text(tree).includes('Geographic group · approximate location'), 'view changes clear stale hover');
  panel = visit(tree, n => n.props?.role === 'tabpanel' && !n.props.hidden)[0];
  const activeMap = tabs().find(n => text(n) === 'Map');
  assert.equal(activeMap.props['aria-selected'], true);
  assert.equal(activeMap.props.tabIndex, 0);
  assert.equal(panel.props.id, activeMap.props['aria-controls']);
  assert.equal(panel.props['aria-labelledby'], activeMap.props.id);
  tabs().find(n => text(n) === 'Globe').props.onClick(); tree = render();
  assert.equal(visit(tree, n => n.type === 'NodeGlobe').length, 1);
  assert.equal(visit(tree, n => n.type === 'NodePlanisphere').length, 0);
});

test('view tabs support arrow, Home and End keys with focus following selection', () => {
  const render = mapHarness(); let tree = render();
  for (const [key, expected] of [['ArrowRight', 'map'], ['ArrowLeft', 'globe'], ['End', 'map'], ['Home', 'globe']]) {
    let focused = false; let prevented = false;
    const active = visit(tree, n => n.props?.role === 'tab' && n.props['aria-selected'])[0];
    active.props.onKeyDown({ key, preventDefault: () => { prevented = true; }, currentTarget: {
      parentElement: { querySelector: selector => {
        assert.equal(selector, `[data-node-view="${expected}"]`);
        return { focus: () => { focused = true; } };
      } },
    } });
    tree = render();
    assert.equal(prevented, true);
    assert.equal(focused, true);
    assert.equal(visit(tree, n => n.props?.role === 'tab' && n.props['aria-selected'])[0].props['data-node-view'], expected);
  }
});

test('flat map preserves country counts and dimming, and supports marker focus', () => {
  let hovered = null;
  const jsx = (type, props, key) => ({ type, props, key });
  const { NodePlanisphere } = load('components/network/NodePlanisphere.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: { useState: value => [value, () => {}] },
    '@/components/ChartWatermark': { ChartWatermark: 'ChartWatermark' },
    '@/lib/world-dot-map': { MAP_WIDTH: 1000, MAP_HEIGHT: 500, DOT_RADIUS: 1,
      project: (lat, lon) => ({ x: lon, y: lat }), useWorldLandDots: () => [{ x: 0, y: 0 }] },
  });
  const tree = NodePlanisphere({
    locations: clusterNodeLocations([location('GB', 10), location('FR', 9), location('FR', 8)]),
    selectedCountry: 'FR', onHover: value => { hovered = value; },
  });
  const bubbles = visit(tree, n => n.type === 'g' && String(n.key).startsWith('nc-'));
  assert.equal(bubbles.length, 2);
  const counts = bubbles.map(n => ({ count: Number(text(visit(n, x => x.type === 'text')[0])), opacity: n.props.style.opacity }));
  assert.ok(counts.some(n => n.count === 17 && n.opacity === 1));
  assert.ok(counts.some(n => n.count === 10 && n.opacity === 0.15));
  const france = bubbles.find(n => n.props['aria-label'].startsWith('FR:'));
  france.props.onFocus();
  assert.equal(hovered.countryCode, 'FR');
  assert.equal(hovered.nodeCount, 17);
  france.props.onBlur();
  assert.equal(hovered, null);
  assert.equal(visit(tree, n => n.type === 'ChartWatermark').length, 1);
});

test('globe hover identifies geographic groups within one country using observed IP counts', () => {
  const render = mapHarness({ locations: [
    location('JP', 1, { country: 'Japan', lat: 35, lon: 139, topIsp: 'BIGLOBE Inc.' }),
    location('JP', 15, { country: 'Japan', lat: 43, lon: 141, topIsp: 'Amazon.com, Inc.' }),
  ] });
  let tree = render();
  const globe = visit(tree, n => n.type === 'NodeGlobe')[0];
  assert.equal(globe.props.locations.length, 2, 'separate location cells stay separate');
  globe.props.onHover(globe.props.locations.find(n => n.nodeCount === 15));
  tree = render();
  assert.ok(text(tree).includes('Japan'));
  assert.ok(text(tree).includes('15 observed IPs'));
  assert.ok(text(tree).includes('Geographic group · approximate location'));
  assert.ok(text(tree).includes('Amazon.com, Inc.'));
  assert.ok(!text(tree).includes('15 nodes'));
  globe.props.onHover(globe.props.locations.find(n => n.nodeCount === 1));
  assert.ok(text(render()).includes('1 observed IP'));
  assert.ok(!text(render()).includes('1 observed IPs'));
  globe.props.onHover(null);
  assert.ok(!text(render()).includes('Geographic group · approximate location'));
});

test('combined cells never claim the last cell latency or an unsupported dominant client', () => {
  const input = [location('FR', 9), location('FR', 8, { avgPingMs: 1000, topClient: 'Zakura', topIsp: 'Provider B' })];
  const [combined] = clusterNodeLocations(input);
  assert.equal(combined.nodeCount, 17);
  assert.equal(combined.avgPingMs, null);
  assert.equal(combined.topClient, null);
  assert.equal(combined.topIsp, null);
  assert.equal(input[0].nodeCount, 9, 'source observations remain intact');
});

test('new census shows missing baselines without manufacturing percentages and labels candidate remainder', () => {
  const page = text(mapHarness()());
  for (const period of ['24h', '7d', '30d']) assert.ok(page.includes(`${period} unavailable`));
  assert.ok(page.includes('comparable observation'));
  assert.ok(page.includes('Other / unknown5'));
  assert.ok(page.includes('Tor classified'));
  assert.ok(page.includes('20 crawler-verified IPs'));
  assert.ok(page.includes('12 additional local-peer IPs'));
  assert.ok(!page.includes('332.2%'));
  assert.ok(!text(mapHarness({ version: 2 })()).includes('after chain verification'));
});

test('a failed refresh keeps observations visible with an explicit stale status', () => {
  const tree = mapHarness({ fail: true })();
  assert.ok(text(tree).includes('Observed IPs'));
  const status = visit(tree, n => n.props?.role === 'status');
  assert.equal(status.length, 1);
  assert.ok(text(status[0]).includes('may be stale'));
});

for (const [name, render, labelType] of [
  ['overview', values => mapHarness(values)(), 'div'],
  ['node details', detailHarness, 'dt'],
]) {
  test(`${name} distinguishes unavailable Tor classification from a measured zero`, () => {
    for (const values of [
      { torNodes: null, torClassificationAvailable: false },
      { torNodes: null },
      { torNodes: 4, torClassificationAvailable: false },
      { torNodes: 0 },
      { torNodes: 4 },
    ]) {
      const metric = torMetric(render(values), labelType);
      assert.ok(metric, 'Tor classification remains visible when unavailable');
      assert.ok(text(metric).includes('—'), 'no numeric count is asserted without classification');
      assert.ok(text(metric).includes('Tor classification unavailable'));
    }
    for (const count of [0, 4]) {
      const metric = torMetric(render({ torNodes: count, torClassificationAvailable: true }), labelType);
      assert.ok(metric, 'a valid zero remains visible');
      assert.ok(text(metric).includes(`${count}`));
      assert.ok(!text(metric).includes('unavailable'));
    }
    const legacyZero = torMetric(render({ version: 0, torNodes: 0 }), labelType);
    assert.ok(text(legacyZero).includes('0'), 'numeric peer-mode counts remain compatible');
    assert.ok(!text(legacyZero).includes('unavailable'));
  });
}
