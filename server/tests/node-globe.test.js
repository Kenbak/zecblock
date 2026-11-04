'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const modules = new Map();
function load(file) {
  const resolved = path.resolve(file);
  if (modules.has(resolved)) return modules.get(resolved);
  const exports = {};
  modules.set(resolved, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(name) {
      if (!name.startsWith('.')) throw new Error(`Unexpected import: ${name}`);
      return load(path.resolve(path.dirname(resolved), `${name}.ts`));
    },
  }, { filename: resolved });
  return exports;
}

const {
  GLOBE_LAND_POINTS,
  clampGlobeZoom,
  createGlobeView,
  latLonToVector,
  projectGlobePoint,
  projectGlobeVector,
  rotateGlobeView,
} = load('lib/node-globe.ts');
const { WORLD_LAND_DOTS } = load('lib/world-land-dots.generated.ts');
const { GLOBE_LAND_COORDINATES } = load('lib/globe-land.generated.ts');

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-10, message ?? `${actual} should be near ${expected}`);
}

test('globe cardinal directions project right, left, north, and south', () => {
  for (const [lat, lon, x, y, depth] of [
    [0, 0, 0, 0, 1],
    [0, 90, 1, 0, 0],
    [0, -90, -1, 0, 0],
    [90, 0, 0, -1, 0],
    [-90, 0, 0, 1, 0],
  ]) {
    const point = projectGlobePoint(lat, lon, 0, 0);
    near(point.x, x);
    near(point.y, y);
    near(point.depth, depth);
  }
});

test('opposite hemisphere has negative depth and becomes visible after rotation', () => {
  assert.ok(projectGlobePoint(0, 180, 0, 0).depth < 0);
  near(projectGlobePoint(0, 180, 180, 0).depth, 1);
  near(projectGlobePoint(0, 180, 180, 0).x, 0);
  assert.ok(projectGlobePoint(0, 0, 180, 0).depth < 0);
});

test('the chosen longitude and latitude move to the front center', () => {
  for (const [lat, lon] of [[35, 139], [-34, 151], [65, -180], [-65, 179]]) {
    const point = projectGlobePoint(lat, lon, lon, lat);
    near(point.x, 0);
    near(point.y, 0);
    near(point.depth, 1);
    const opposite = projectGlobePoint(-lat, lon + 180, lon, lat);
    near(opposite.depth, -1);
  }
  assert.ok(projectGlobePoint(50, 20, 20, 35).y < 0, 'north remains above the center');
  assert.ok(projectGlobePoint(20, 20, 20, 35).y > 0, 'south remains below the center');
});

test('precomputed vectors preserve geometry and match direct projection', () => {
  const view = createGlobeView(23, -17);
  for (const [lat, lon] of [[35, 139], [-34, 151], [0, 0], [90, 180]]) {
    const vector = latLonToVector(lat, lon);
    near(Math.hypot(vector.x, vector.y, vector.z), 1);
    const projected = projectGlobeVector(vector, view);
    const direct = projectGlobePoint(lat, lon, 23, -17);
    near(projected.x, direct.x);
    near(projected.y, direct.y);
    near(projected.depth, direct.depth);
    near(Math.hypot(projected.x, projected.y, projected.depth), 1);
  }
});

test('rotation wraps across the date line and clamps latitude', () => {
  const east = rotateGlobeView(179, 0, 5, 4);
  assert.equal(east.centerLon, -176);
  assert.equal(east.centerLat, 4);
  assert.equal(rotateGlobeView(-179, 0, -5, 0).centerLon, 176);
  assert.equal(rotateGlobeView(0, 0, 360 * 8 + 10, 100).centerLon, 10);
  assert.equal(rotateGlobeView(0, 0, 0, 100).centerLat, 65);
  assert.equal(rotateGlobeView(0, 0, 0, -100).centerLat, -65);
  assert.equal(rotateGlobeView(0, 0, -360 * 8 - 10, 0).centerLon, -10);
});

test('zoom stays between one and three for wheel and button updates', () => {
  assert.equal(clampGlobeZoom(0.5), 1);
  assert.equal(clampGlobeZoom(1), 1);
  assert.equal(clampGlobeZoom(2.25), 2.25);
  assert.equal(clampGlobeZoom(3), 3);
  assert.equal(clampGlobeZoom(4), 3);
  assert.equal(clampGlobeZoom(Number.NEGATIVE_INFINITY), 1);
  assert.equal(clampGlobeZoom(Number.POSITIVE_INFINITY), 3);
  assert.equal(clampGlobeZoom(Number.NaN), 1);
});

test('spherical land sampling is denser than the flat mask and preserves geographic positions', () => {
  assert.equal(GLOBE_LAND_POINTS.length, GLOBE_LAND_COORDINATES.length);
  assert.ok(GLOBE_LAND_POINTS.length > WORLD_LAND_DOTS.length * 2);
  assert.ok(GLOBE_LAND_POINTS.length >= 5000 && GLOBE_LAND_POINTS.length <= 7000);
  for (let index = 0; index < GLOBE_LAND_COORDINATES.length; index += 1) {
    const [lat, lon] = GLOBE_LAND_COORDINATES[index];
    const point = projectGlobeVector(GLOBE_LAND_POINTS[index], createGlobeView(lon, lat));
    near(point.x, 0);
    near(point.y, 0);
    near(point.depth, 1);
  }
});

test('land samples cover continental interiors and the Antarctic cap while leaving ocean clear', () => {
  function nearestDegrees(lat, lon) {
    const target = latLonToVector(lat, lon);
    const dot = Math.max(...GLOBE_LAND_POINTS.map(point => point.x * target.x + point.y * target.y + point.z * target.z));
    return Math.acos(Math.min(1, dot)) * 180 / Math.PI;
  }
  for (const [lat, lon] of [[40, -100], [0, 25], [-25, 135], [60, 90], [70, -40], [-89, 0]]) {
    assert.ok(nearestDegrees(lat, lon) < 2, `land is sampled near ${lat}, ${lon}`);
  }
  for (const [lat, lon] of [[0, -140], [0, -30], [-40, -130]]) {
    assert.ok(nearestDegrees(lat, lon) > 8, `open ocean stays clear near ${lat}, ${lon}`);
  }
});

test('generator excludes polygon holes and handles land across the date line and around the pole', async () => {
  const { isPointOnLand } = await import('../../scripts/generate-globe-land.mjs');
  const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]];
  assert.equal(isPointOnLand(1, 1, [[square, hole]]), true);
  assert.equal(isPointOnLand(5, 5, [[square, hole]]), false);
  const acrossDateLine = [[179, -2], [-179, -2], [-179, 2], [179, 2], [179, -2]];
  assert.equal(isPointOnLand(0, 180, [[acrossDateLine]]), true);
  assert.equal(isPointOnLand(0, 0, [[acrossDateLine]]), false);
  const polarCoast = [[-180, -80], [-90, -80], [0, -80], [90, -80], [180, -80], [-180, -80]];
  assert.equal(isPointOnLand(-89, 60, [[polarCoast]]), true);
  assert.equal(isPointOnLand(-70, 60, [[polarCoast]]), false);
});

function globeHarness({ reducedMotion = true } = {}) {
  const hooks = [], pendingEffects = [], listeners = new Map(), frames = new Map(), captures = new Set();
  const hoverLog = [];
  let cursor = 0, nextFrame = 1, tree;
  const same = (a, b) => a?.length === b.length && b.every((value, index) => value === a[index]);
  const noop = () => {};
  const context = new Proxy({}, { get(target, key) {
    if (key === 'createRadialGradient') return () => ({ addColorStop: noop });
    return key in target ? target[key] : noop;
  } });
  const canvas = {
    dataset: {}, style: {}, getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 480 }),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id), focus: noop,
  };
  const jsx = (type, props) => {
    if (type === 'canvas') props.ref.current = canvas;
    return { type, props };
  };
  const react = {
    useRef(value) { const index = cursor++; return hooks[index] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = value;
      return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { deps, value: fn() };
      return hooks[index].value;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) {
        const previous = hooks[index];
        hooks[index] = { deps };
        pendingEffects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = fn(); });
      }
    },
    useSyncExternalStore: () => reducedMotion,
  };
  class Observer { observe() {} disconnect() {} }
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/network/NodeGlobe.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === '@/components/ChartWatermark') return { ChartWatermark: 'ChartWatermark' };
      if (name === '@/lib/node-globe') return load('lib/node-globe.ts');
      throw new Error(`Unexpected import: ${name}`);
    },
    window: { devicePixelRatio: 1 },
    document: { hidden: false, documentElement: {}, addEventListener: noop, removeEventListener: noop },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: Observer, IntersectionObserver: Observer, MutationObserver: Observer,
    requestAnimationFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const location = { country: 'Example', countryCode: 'XX', lat: 20, lon: 20, nodeCount: 2, avgPingMs: null };
  const props = { locations: [location], selectedCountry: null, onHover: value => hoverLog.push(value) };
  function render() {
    cursor = 0;
    tree = exports.NodeGlobe(props);
    for (const effect of pendingEffects.splice(0)) effect();
  }
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const match = find(child, predicate);
      if (match) return match;
    }
    return null;
  }
  render();
  return {
    render, canvas, location, hoverLog,
    event(name, values = {}) {
      listeners.get(name)({ type: name, pointerType: 'touch', pointerId: 1, button: 0,
        clientX: 480, clientY: 218, preventDefault: noop, ...values });
    },
    frame(time = 1000) {
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback(time);
    },
    get pendingFrames() { return frames.size; },
    get zoom() { return Number(find(tree, node => node.type === 'canvas').props['data-zoom']); },
    button(label) { return find(tree, node => node.type === 'button' && node.props['aria-label'] === label); },
    labelled(label) { return find(tree, node => node.props?.['aria-label'] === label); },
  };
}

test('a tapped marker remains visible after touch leaves and pointer capture is lost', () => {
  const globe = globeHarness();
  globe.frame();
  globe.event('pointerdown');
  globe.event('pointerup');
  assert.equal(globe.hoverLog.at(-1), globe.location);
  globe.event('lostpointercapture');
  globe.event('pointerleave');
  assert.equal(globe.hoverLog.at(-1), globe.location, 'touch boundary events preserve the tapped marker');
  globe.event('pointerdown', { clientX: 400 });
  assert.equal(globe.hoverLog.at(-1), null, 'the next interaction clears the previous selection');
});

test('touch pinch changes zoom and clamps both gesture extremes', () => {
  const globe = globeHarness();
  globe.frame();
  globe.event('pointerdown', { clientX: 430 });
  globe.event('pointerdown', { pointerId: 2, clientX: 530 });
  for (const [clientX, expected] of [[630, 2], [1030, 3], [431, 1]]) {
    globe.event('pointermove', { pointerId: 2, clientX });
    globe.render();
    assert.equal(globe.zoom, expected);
  }
});

test('small touch movements accumulate into a drag without opening a marker tooltip', () => {
  const globe = globeHarness();
  globe.frame();
  globe.event('pointerdown');
  for (let clientX = 481; clientX <= 486; clientX++) globe.event('pointermove', { clientX });
  globe.event('pointerup', { clientX: 486 });
  assert.equal(globe.hoverLog.at(-1), null);
});

test('reduced motion disables autoplay while allowing an explicit rotation request', () => {
  const globe = globeHarness();
  globe.frame();
  assert.equal(globe.canvas.dataset.longitude, '20.00');
  assert.equal(globe.pendingFrames, 0, 'reduced motion draws once and schedules no animation loop');
  globe.button('Start globe rotation').props.onClick();
  globe.render();
  globe.frame(2000);
  assert.ok(Number(globe.canvas.dataset.longitude) > 20);
  assert.equal(globe.pendingFrames, 1, 'the user can explicitly enable rotation');
  const normalMotion = globeHarness({ reducedMotion: false });
  normalMotion.frame();
  assert.equal(normalMotion.pendingFrames, 1, 'autoplay remains available without reduced motion');
});

test('autoplay pauses over the sphere and resumes in the surrounding canvas space', () => {
  const globe = globeHarness({ reducedMotion: false });
  globe.frame(1000);
  globe.event('pointerenter', { pointerType: 'mouse', clientX: 50, clientY: 50 });
  globe.frame(1040);
  assert.equal(globe.pendingFrames, 1, 'empty canvas space keeps rotation running');
  const beforeHover = globe.canvas.dataset.longitude;
  globe.event('pointermove', { pointerType: 'mouse' });
  globe.frame(1080);
  assert.equal(globe.canvas.dataset.longitude, beforeHover);
  assert.equal(globe.pendingFrames, 0, 'the sphere pauses animation');
  globe.event('pointermove', { pointerType: 'mouse', clientX: 50, clientY: 50 });
  globe.frame(1120);
  assert.ok(Number(globe.canvas.dataset.longitude) > Number(beforeHover));
  assert.equal(globe.pendingFrames, 1, 'leaving the sphere resumes animation without leaving the canvas');
});

test('pointer gestures outside the sphere do not capture the pointer or rotate the view', () => {
  const globe = globeHarness();
  globe.frame();
  let prevented = false;
  globe.event('pointerdown', { clientX: 50, clientY: 50, preventDefault: () => { prevented = true; } });
  globe.event('pointermove', { clientX: 150, clientY: 150 });
  globe.frame(1100);
  assert.equal(prevented, false);
  assert.equal(globe.canvas.dataset.longitude, '20.00');
  assert.equal(globe.canvas.dataset.latitude, '20.00');
});

test('ordinary wheel scrolling zooms over the sphere and remains page scrolling beside it', () => {
  const globe = globeHarness();
  globe.frame();
  let prevented = false;
  const preventDefault = () => { prevented = true; };
  globe.event('wheel', { clientX: 50, clientY: 50, deltaY: -300, preventDefault });
  globe.render();
  assert.equal(prevented, false);
  assert.equal(globe.zoom, 1);
  globe.event('wheel', { deltaY: -300, preventDefault });
  globe.render();
  assert.equal(prevented, true);
  assert.ok(globe.zoom > 1 && globe.zoom < 3);
  for (const [deltaY, expected] of [[-10000, 3], [10000, 1]]) {
    globe.event('wheel', { deltaY, preventDefault });
    globe.render();
    assert.equal(globe.zoom, expected);
  }
});

test('globe overlays retain the four count tiers and labelled icon controls', () => {
  const globe = globeHarness();
  const legend = globe.labelled('Observed IPs per geographic group');
  assert.ok(legend.props.className.includes('absolute'));
  assert.deepEqual(Array.from(legend.props.children, entry => entry.props.children[1]), ['10+', '5–9', '2–4', '1']);
  assert.ok(globe.labelled('Globe controls').props.className.includes('absolute'));
  for (const label of ['Start globe rotation', 'Zoom out', 'Zoom in', 'Reset globe view']) {
    const button = globe.button(label);
    assert.ok(button.props.title);
    assert.equal(button.props.children.type, 'svg');
  }
});
