'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const now = Date.parse('2026-10-23T00:00:00Z');
const node = (id, reachable = true, degree = 1) => ({ id, reachable, degree, client: reachable ? 'Zebra' : null,
  isTor: false, countryCode: reachable ? 'JP' : null, betweenness: null, closeness: null });
const snapshot = (extra = {}) => ({ topologyAvailable: true, gossipProvenance: 'zcash-mainnet-qualified-addr-v1',
  observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 540000).toISOString(),
  nodes: [node(0), node(1, false), node(2, true, 0)], edges: [{ source: 0, target: 1 }],
  counts: { total: 3, reachable: 2, off: 1, edges: 1 }, ...extra });

function visit(tree, predicate, found = []) {
  if (!tree || typeof tree !== 'object') return found;
  if (predicate(tree)) found.push(tree);
  for (const child of [tree.props?.children].flat(Infinity)) visit(child, predicate, found);
  return found;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree);
}

function harness(initial = snapshot()) {
  const hooks = [], effects = [], frames = new Map(), timers = new Map(), requests = [];
  let cursor = 0, nextId = 1, tree, data = initial, visible = true, active = true, clock = now, tickCount = 0;
  let refreshing = false, refetchCalls = 0, error = null, documentHidden = false;
  const refetch = async () => {
    if (!active || documentHidden) return;
    refetchCalls++;
    refreshing = true;
  };
  const same = (a, b) => a?.length === b.length && b.every((value, index) => value === a[index]);
  const jsx = (type, props) => ({ type, props });
  const react = {
    useRef(value) { const index = cursor++; return hooks[index] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value;
      return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { deps, value: fn() };
      return hooks[index].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) {
        const previous = hooks[index]; hooks[index] = { deps };
        effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = fn(); });
      }
    },
    useSyncExternalStore: () => visible,
  };
  const chain = () => {
    const force = {};
    for (const method of ['id', 'distance', 'strength', 'distanceMax']) force[method] = () => force;
    return force;
  };
  const simulation = nodes => {
    nodes.forEach((item, index) => { item.x = index; item.y = index; item.z = 0; });
    const sim = { force: () => sim, alphaDecay: () => sim, stop: () => sim, tick: () => { tickCount++; return sim; } };
    return sim;
  };
  class ClockDate extends Date { static now() { return clock; } }
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/network/TopologyGraph.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, Date: ClockDate, performance: { now: () => 0 },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'three') return {};
      if (name === '@react-three/fiber') return { Canvas: 'Canvas' };
      if (name === '@react-three/drei') return { OrbitControls: 'OrbitControls' };
      if (name === 'd3-force-3d') return { forceSimulation: simulation, forceLink: chain, forceManyBody: chain,
        forceCenter: chain, forceX: chain, forceY: chain, forceZ: chain };
      if (name === '@/contexts/ThemeContext') return { useTheme: () => ({ theme: 'dark' }) };
      if (name === '@/components/ChartWatermark') return { ChartWatermark: 'ChartWatermark' };
      if (name === '@/lib/network-colors') return { clientColor: () => 'gold', clientLabel: value => value || 'Unidentified',
        CLIENT_COLORS: { Zebra: 'gold', zcashd: 'blue', Unknown: 'gray' } };
      if (name === '@/hooks/useApiQuery') return { useApiQuery(path, params, options) {
        requests.push({ path, options }); return { data, loading: false, error, refetch, isRefreshing: refreshing };
      } };
      throw new Error(`Unexpected import: ${name}`);
    },
    document: { documentElement: {}, get visibilityState() { return documentHidden ? 'hidden' : 'visible'; } },
    getComputedStyle: () => ({ getPropertyValue: token => token.endsWith('-rgb') ? '200 180 100' : '#999' }),
    requestAnimationFrame: callback => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  function render() {
    cursor = 0; tree = exports.TopologyGraph({ active });
    for (const effect of effects.splice(0)) effect();
    return tree;
  }
  render();
  return {
    exports, requests, render,
    get tree() { return tree; },
    get tickCount() { return tickCount; },
    get refetchCalls() { return refetchCalls; },
    update(values) {
      if ('data' in values) data = values.data;
      if ('visible' in values) { visible = values.visible; documentHidden = !visible; }
      if ('active' in values) active = values.active;
      if ('refreshing' in values) refreshing = values.refreshing;
      if ('error' in values) error = values.error;
      return render();
    },
    setDocumentHidden(value) { documentHidden = value; },
    completeRefresh(nextData = data, nextError = null) {
      data = nextData; error = nextError; refreshing = false;
      return render();
    },
    frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); return render(); },
    advance(time) {
      clock = time;
      for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
      return render();
    },
    flush() { for (let count = 0; frames.size && count < 100; count++) this.frame(); return tree; },
  };
}

test('advertised targets remain distinct from active observations and unavailable copy makes no revalidation promise', () => {
  const graph = harness(); graph.flush();
  const page = text(graph.tree);
  assert.ok(page.includes('2 observed active IPs · 1 advertised only · 1 advertisement links'));
  assert.ok(page.includes('Advertised only'));
  assert.ok(page.includes('do not establish remote connections'));
  assert.ok(!page.includes('Not recently observed'));
  const scene = visit(graph.tree, item => typeof item.type === 'function' && item.type.name === 'Scene')[0];
  scene.props.onPin(scene.props.nodes.find(item => !item.reachable)); graph.render();
  const rows = visit(graph.tree, item => typeof item.type === 'function' && item.type.name === 'Row');
  assert.equal(rows.find(row => row.props.label === 'Status').props.value, 'Advertised only');
  assert.equal(rows.find(row => row.props.label === 'Tor flag').props.value, 'Unknown');
  assert.equal(rows.find(row => row.props.label === 'Shown incoming').props.value, '1');
  const unavailable = harness(snapshot({ topologyAvailable: false, gossipProvenance: null }));
  assert.ok(text(unavailable.tree).includes('Fresh verified gossip links are not available.'));
  assert.ok(text(unavailable.tree).includes('2 observed active IPs.'));
  assert.ok(!text(unavailable.tree).includes('revalidated'));
});

test('expiry hides qualified graphs and immediately refreshes, restoring fresh links without the five-minute poll', () => {
  const data = snapshot({ expiresAt: new Date(now + 1000).toISOString() });
  const graph = harness(data); graph.flush();
  assert.ok(visit(graph.tree, item => item.type === 'Canvas').length);
  assert.equal(visit(graph.tree, item => item.type === 'time').length, 2);
  graph.advance(now + 1001);
  assert.equal(visit(graph.tree, item => item.type === 'Canvas').length, 0);
  assert.ok(text(graph.tree).includes('previous snapshot expired'));
  assert.equal(graph.refetchCalls, 1);
  graph.completeRefresh(snapshot({ observedAt: new Date(now + 500).toISOString() }));
  graph.flush();
  assert.equal(visit(graph.tree, item => item.type === 'Canvas').length, 1);
  assert.equal(graph.exports.topologyIsFresh(snapshot({ expiresAt: undefined }), now), false);
  assert.equal(graph.exports.topologyIsFresh(snapshot({ gossipProvenance: 'unqualified' }), now), false);
  const legacy = snapshot(); delete legacy.gossipProvenance; delete legacy.expiresAt;
  assert.equal(graph.exports.topologyIsFresh(legacy, now), true, 'legacy peer mode retains its existing contract');
});

test('the same expired payload, a failed request or an unavailable result cannot trigger a refresh loop', () => {
  const expired = snapshot({ expiresAt: new Date(now + 1000).toISOString() });
  const graph = harness(expired);
  graph.advance(now + 1001);
  assert.equal(graph.refetchCalls, 1);
  graph.completeRefresh({ ...expired }, 'HTTP 503');
  graph.update({ data: { ...expired }, error: null });
  graph.advance(now + 60_000);
  assert.equal(graph.refetchCalls, 1, 'stable evidence identity is independent of response object identity/errors');
  assert.equal(visit(graph.tree, item => item.type === 'Canvas').length, 0);
  graph.completeRefresh(snapshot({ topologyAvailable: false, expiresAt: null }));
  graph.advance(now + 120_000);
  assert.equal(graph.refetchCalls, 1, 'an unavailable result waits for the regular poll');
});

test('expiry waits for an in-flight request and recovers once it settles with the expired evidence', () => {
  const data = snapshot({ expiresAt: new Date(now + 1000).toISOString() });
  const graph = harness(data);
  graph.update({ refreshing: true });
  graph.advance(now + 1001);
  assert.equal(graph.refetchCalls, 0, 'expiry does not start a second concurrent request');
  assert.equal(visit(graph.tree, item => item.type === 'Canvas').length, 0);
  graph.completeRefresh({ ...data });
  assert.equal(graph.refetchCalls, 1, 'settled expired evidence gets one recovery attempt');
  graph.completeRefresh({ ...data }, 'HTTP 503');
  assert.equal(graph.refetchCalls, 1);
});

test('inactive or hidden surfaces cancel expiry work and defer the attempt until visible activation', () => {
  for (const state of [{ active: false }, { visible: false }]) {
    const graph = harness(snapshot({ expiresAt: new Date(now + 1000).toISOString() }));
    graph.update(state);
    graph.advance(now + 1001);
    assert.equal(graph.refetchCalls, 0);
    graph.update({ active: true, visible: true });
    assert.equal(graph.refetchCalls, 1, 'the hidden/inactive deadline did not consume the recovery attempt');
  }
  const race = harness(snapshot({ expiresAt: new Date(now + 1000).toISOString() }));
  race.setDocumentHidden(true); // visibility render/passive cleanup has not run yet
  race.advance(now + 1001);
  assert.equal(race.refetchCalls, 0);
  race.update({ visible: false });
  race.update({ visible: true });
  assert.equal(race.refetchCalls, 1, 'live document visibility prevents consuming the attempt in the race window');
});

test('successive evidence expiries are rate-limited and hidden cooldowns resume only when visible', () => {
  const graph = harness(snapshot({ expiresAt: new Date(now + 1000).toISOString() }));
  graph.advance(now + 1001);
  assert.equal(graph.refetchCalls, 1);
  graph.completeRefresh(snapshot({ observedAt: new Date(now + 1000).toISOString(), expiresAt: new Date(now + 2000).toISOString() }));
  graph.advance(now + 2001);
  assert.equal(graph.refetchCalls, 1);
  assert.equal(visit(graph.tree, item => item.type === 'Canvas').length, 0);
  graph.advance(now + 31_000);
  assert.equal(graph.refetchCalls, 1, 'the recovery interval has not fully elapsed');
  graph.update({ visible: false });
  graph.advance(now + 31_001);
  assert.equal(graph.refetchCalls, 1, 'the pending cooldown was cancelled while hidden');
  graph.update({ visible: true });
  assert.equal(graph.refetchCalls, 2);
  graph.completeRefresh(snapshot({ expiresAt: new Date(now + 100_000).toISOString() }));
  graph.flush();
  assert.equal(visit(graph.tree, item => item.type === 'Canvas').length, 1);
});

test('polling is five minutes and enabled only for the active visible surface', () => {
  const graph = harness();
  assert.equal(graph.requests.at(-1).path, '/v1/network/topology');
  assert.equal(graph.requests.at(-1).options.refreshInterval, 300000);
  assert.equal(graph.requests.at(-1).options.enabled, true);
  graph.update({ active: false }); assert.equal(graph.requests.at(-1).options.enabled, false);
  graph.update({ active: true, visible: false }); assert.equal(graph.requests.at(-1).options.enabled, false);
  graph.update({ visible: true }); assert.equal(graph.requests.at(-1).options.enabled, true);
});

test('large layouts are bounded, yield between tick batches and disclose both display and collection limits', () => {
  const nodes = Array.from({ length: 1600 }, (_, id) => node(id, id >= 1500, 1600 - id));
  const edges = Array.from({ length: 5000 }, (_, index) => ({ source: 1500 + index % 100, target: index % 500 }));
  const data = snapshot({ nodes, edges, truncated: true, counts: { total: 1600, reachable: 100, off: 1500, edges: 5000 } });
  const graph = harness(data);
  const selected = graph.exports.selectTopologyLayout(data);
  assert.equal(selected.nodes.length, 600);
  assert.equal(selected.nodes.filter(item => item.reachable).length, 100);
  assert.equal(selected.edges.length, 2000);
  assert.equal(graph.tickCount, 0, 'layout work is scheduled after render');
  graph.frame(); assert.ok(graph.tickCount <= 3, 'one frame has at most three ticks');
  graph.flush(); assert.equal(graph.tickCount, 120);
  const page = text(graph.tree);
  assert.ok(page.includes('Showing 600 of 1,600 nodes and 2,000 of 5,000 links'));
  assert.ok(page.includes('Additional advertisements are omitted.'));
  assert.ok(page.includes('100 observed active IPs · 1500 advertised only'));
  const scene = visit(graph.tree, item => typeof item.type === 'function' && item.type.name === 'Scene')[0];
  assert.equal(scene.props.nodes.length, 600);
  assert.equal(scene.props.edgePairs.length, 2000);
});

test('geography is the initial node-explorer lens and topology remains deferred', () => {
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/network/NodeMapExplorer.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { lazy: () => 'LazyTopology', Suspense: 'Suspense', useState: value => [value, () => {}], useRef: value => ({ current: value }) };
    if (name === '@/components/ui/Skeleton') return { VisualizationSkeleton: 'Skeleton' };
    if (name === '@/components/ui/Tabs') return { Tabs: 'Tabs' };
    if (name === './NodeGeoLayerMap') return { NodeGeoLayerMap: 'NodeGeoLayerMap' };
    throw new Error(`Unexpected import: ${name}`);
  } });
  const tree = exports.NodeMapExplorer();
  assert.equal(visit(tree, item => item.type === 'Tabs')[0].props.active, 'client');
  assert.equal(visit(tree, item => item.type === 'NodeGeoLayerMap')[0].props.mode, 'client');
  assert.equal(visit(tree, item => item.type === 'LazyTopology').length, 0);
});
