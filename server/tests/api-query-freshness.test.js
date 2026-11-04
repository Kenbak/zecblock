const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual hook's effects/registry with deterministic time and
// network responses; each mounted component has its own React hook slots.
function harness({ hidden = false, fetchImpl, apiUrl = 'https://api.example.test', browserOrigin } = {}) {
  let now = 1_000_000;
  let id = 0;
  let active;
  let calls = 0;
  const timers = new Map();
  const document = new EventTarget();
  document.visibilityState = hidden ? 'hidden' : 'visible';
  const exports = {};
  const same = (left, right) => left?.length === right?.length
    && right.every((value, index) => Object.is(value, left[index]));
  const react = {
    useRef(value) {
      const index = active.index++;
      return active.hooks[index] ||= { current: value };
    },
    useState(value) {
      const component = active;
      const index = component.index++;
      if (!(index in component.hooks)) component.hooks[index] = typeof value === 'function' ? value() : value;
      return [component.hooks[index], next => {
        component.hooks[index] = typeof next === 'function' ? next(component.hooks[index]) : next;
      }];
    },
    useCallback(callback, deps) {
      const index = active.index++;
      if (!same(active.hooks[index]?.deps, deps)) active.hooks[index] = { deps, callback };
      return active.hooks[index].callback;
    },
    useEffect(effect, deps) {
      const component = active;
      const index = component.index++;
      if (!same(component.hooks[index]?.deps, deps)) {
        const previous = component.hooks[index];
        const next = { deps };
        component.hooks[index] = next;
        component.effects.push(() => { previous?.cleanup?.(); next.cleanup = effect(); });
      }
    },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('hooks/useApiQuery.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, document, URL, AbortController, console, window: browserOrigin ? { location: { origin: browserOrigin } } : undefined,
    Date: { now: () => now },
    require(name) {
      if (name === 'react') return react;
      if (name === '@/lib/api-config') return { getApiUrl: () => apiUrl };
      // Assay uses the versioned API envelope; freshness behavior is shared.
      if (name === '@/lib/api-client') return { readApiData: response => response.json() };
      throw new Error(`Unexpected import ${name}`);
    },
    setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (...args) => {
      calls++;
      return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ height: 101 }) };
    },
  });
  return {
    document, timers,
    get calls() { return calls; },
    get now() { return now; },
    advance(ms) { now += ms; },
    mount(options, path = '/stats') {
      const component = { hooks: [], effects: [], index: 0, options, path, params: undefined };
      const render = () => {
        active = component;
        component.index = 0;
        const result = exports.useApiQuery(component.path, component.params, component.options);
        for (const effect of component.effects.splice(0)) effect();
        return result;
      };
      render();
      return {
        render,
        update(values) { Object.assign(component, values); return render(); },
        unmount() { component.hooks.forEach(hook => hook?.cleanup?.()); },
      };
    },
    async tick(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(key); await timer.fn(); }
      }
    },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('stale ISR data stays visible and refreshes immediately, deduplicated across subscribers', async () => {
  let resolve;
  const live = harness({ fetchImpl: () => new Promise(r => { resolve = r; }) });
  const options = { refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now - 300_000 };
  const first = live.mount(options);
  const second = live.mount(options);
  assert.equal(live.calls, 1);
  assert.equal(first.render().data.height, 100);
  assert.equal(first.render().loading, false);
  assert.equal(first.render().isRefreshing, true);
  resolve({ ok: true, json: async () => ({ height: 101 }) });
  await flush();
  assert.equal(second.render().data.height, 101);
  assert.equal(first.render().error, null);
});

test('fresh seed is refreshed when its remaining lifetime expires, not a full interval after mounting', async () => {
  const live = harness();
  live.mount({ refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now - 50_000 });
  assert.equal(live.calls, 0);
  await live.tick(9_999);
  assert.equal(live.calls, 0);
  await live.tick(1);
  assert.equal(live.calls, 1);
});

test('hidden seeded page waits, then catches up once on visibility return', async () => {
  const live = harness({ hidden: true });
  live.mount({ refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now - 300_000 });
  assert.equal(live.calls, 0);
  assert.equal(live.timers.size, 0);
  live.document.visibilityState = 'visible';
  live.document.dispatchEvent(new Event('visibilitychange'));
  live.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(live.calls, 1);
  await flush();
  assert.equal(live.timers.size, 1);
});

test('failed catch-up preserves last good data and backs off before retrying', async () => {
  let fail = true;
  const live = harness({ fetchImpl: async () => fail
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => ({ height: 102 }) } });
  const view = live.mount({ refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now - 300_000 });
  await flush();
  assert.equal(view.render().data.height, 100);
  assert.equal(view.render().error, 'HTTP 503');
  assert.equal(view.render().loading, false);
  await live.tick(119_999);
  assert.equal(live.calls, 1);
  fail = false;
  await live.tick(1);
  assert.equal(view.render().data.height, 102);
  assert.equal(view.render().error, null);
});

test('unseeded queries still fetch once and a recent shared response is not fetched again', async () => {
  const live = harness();
  const first = live.mount({ refreshInterval: 60_000 });
  await flush();
  const second = live.mount({ refreshInterval: 60_000, initialData: { height: 99 }, initialFetchedAt: live.now - 300_000 });
  assert.equal(live.calls, 1);
  assert.equal(first.render().data.height, 101);
  assert.equal(second.render().data.height, 101);
});

test('refetch is stable for a query and shares one in-flight refresh while retaining data', async () => {
  let resolve;
  const live = harness({ fetchImpl: () => new Promise(done => { resolve = done; }) });
  const options = { refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now };
  const first = live.mount(options);
  const second = live.mount(options);
  const refetch = first.render().refetch;
  assert.equal(refetch, first.render().refetch);
  assert.equal(live.calls, 0);

  const pending = refetch();
  const shared = second.render().refetch();
  assert.equal(live.calls, 1, 'manual refreshes use the shared in-flight guard');
  assert.equal(first.render().data.height, 100);
  assert.equal(second.render().data.height, 100);
  assert.equal(first.render().loading, false);
  assert.equal(second.render().isRefreshing, true);
  assert.equal(refetch, first.render().refetch, 'request state does not replace the callback');

  resolve({ ok: true, json: async () => ({ height: 102 }) });
  await Promise.all([pending, shared]);
  assert.equal(first.render().data.height, 102);
  assert.equal(second.render().isRefreshing, false);
  assert.equal(first.render().error, null);
  assert.equal(refetch, first.render().refetch, 'successful responses preserve callback identity');
});

test('refetch joins an automatic first fetch and restarts one poll interval after completion', async () => {
  let resolve;
  let requests = 0;
  const live = harness({ fetchImpl: async () => ++requests === 1
    ? new Promise(done => { resolve = done; })
    : { ok: true, json: async () => ({ height: 103 }) } });
  const first = live.mount({ refreshInterval: 60_000 });
  const second = live.mount({ refreshInterval: 60_000 });
  assert.equal(live.calls, 1);
  assert.equal(first.render().loading, true);
  await first.render().refetch();
  await second.render().refetch();
  assert.equal(live.calls, 1, 'refetch does not compete with a scheduled fetch');
  live.advance(15_000);
  resolve({ ok: true, json: async () => ({ height: 101 }) });
  await flush();
  assert.equal(first.render().data.height, 101);
  assert.equal(first.render().loading, false);
  await live.tick(59_999);
  assert.equal(live.calls, 1);
  await live.tick(1);
  assert.equal(live.calls, 2);
  assert.equal(first.render().data.height, 103);
});

test('refetch replaces the old poll deadline and leaves a single future poll', async () => {
  const live = harness();
  const view = live.mount({ refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now });
  live.advance(20_000);
  await view.render().refetch();
  assert.equal(live.calls, 1);
  assert.equal(live.timers.size, 1);
  await live.tick(40_000);
  assert.equal(live.calls, 1, 'the original poll deadline was cancelled');
  await live.tick(19_999);
  assert.equal(live.calls, 1);
  await live.tick(1);
  assert.equal(live.calls, 2);
  assert.equal(live.timers.size, 1, 'shared polling still has one timer after manual refresh');
});

test('refetch refuses hidden or disabled subscribers and remains usable after enabling', async () => {
  const live = harness();
  const options = { refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now };
  const view = live.mount(options);
  const refetch = view.render().refetch;
  live.document.visibilityState = 'hidden';
  await refetch();
  assert.equal(live.calls, 0, 'live document visibility gates even an existing callback');
  view.update({ options: { ...options, enabled: false } });
  live.document.visibilityState = 'visible';
  await refetch();
  assert.equal(live.calls, 0, 'a captured callback cannot refresh its disabled subscriber');
  assert.equal(view.render().data.height, 100);
  assert.equal(view.render().loading, false);
  assert.equal(view.render().refetch, refetch);

  view.update({ options });
  await view.render().refetch();
  assert.equal(live.calls, 1);
  assert.equal(view.render().data.height, 101);
});

test('unmounted and stale-key callbacks cannot refresh a registry owned by other subscribers', async () => {
  const live = harness();
  const options = { refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now };
  const changing = live.mount(options);
  const remaining = live.mount(options);
  const oldRefetch = changing.render().refetch;
  changing.update({ path: '/different-stats' });
  assert.notEqual(changing.render().refetch, oldRefetch);
  await oldRefetch();
  assert.equal(live.calls, 0, 'the old key still exists but this subscriber no longer owns it');
  const currentRefetch = changing.render().refetch;
  changing.unmount();
  await currentRefetch();
  assert.equal(live.calls, 0, 'unmount blocks refresh before delayed registry teardown');
  await live.tick(0);
  await currentRefetch();
  assert.equal(live.calls, 0, 'refresh cannot recreate a torn-down registry');
  await remaining.render().refetch();
  assert.equal(live.calls, 1, 'the remaining subscriber still owns the original query');
});

test('failed refetch retains the last good response and follows the normal retry backoff', async () => {
  let fail = true;
  const live = harness({ fetchImpl: async () => fail
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => ({ height: 104 }) } });
  const view = live.mount({ refreshInterval: 60_000, initialData: { height: 100 }, initialFetchedAt: live.now });
  const refetch = view.render().refetch;
  await refetch();
  assert.equal(live.calls, 1);
  assert.equal(view.render().data.height, 100);
  assert.equal(view.render().error, 'HTTP 503');
  assert.equal(view.render().loading, false);
  assert.equal(view.render().isRefreshing, false);
  assert.equal(view.render().refetch, refetch);
  await live.tick(119_999);
  assert.equal(live.calls, 1, 'a failed refresh does not create an immediate retry loop');
  fail = false;
  await live.tick(1);
  assert.equal(live.calls, 2);
  assert.equal(view.render().data.height, 104);
  assert.equal(view.render().error, null);
});

test('browser polling resolves the relative protected staging API base against the deployment origin', async () => {
  const urls = [];
  const live = harness({ apiUrl: '/api/staging-data', browserOrigin: 'https://review.vercel.app', fetchImpl: async url => { urls.push(url); return { ok: true, json: async () => ({ height: 103 }) }; } });
  const view = live.mount({ refreshInterval: 60_000 }, '/v1/network/stats');
  await flush();
  assert.deepEqual(urls, ['https://review.vercel.app/api/staging-data/v1/network/stats']);
  assert.equal(view.render().data.height, 103);
});
