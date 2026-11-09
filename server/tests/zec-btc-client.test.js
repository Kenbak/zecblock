const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the actual request hook with controllable effects, time, and responses.
// Deferred requests deliberately ignore abort so late-response protection is
// exercised independently of the browser's fetch cancellation.
function harness({ hidden = false } = {}) {
  let now = Date.parse('2026-10-27T12:00:00Z');
  let nextTimer = 0;
  let writes = 0;
  const timers = new Map();
  const requests = [];
  const component = { hooks: [], effects: [], index: 0, period: '30d' };
  const same = (left, right) => left?.length === right?.length
    && right.every((value, index) => Object.is(value, left[index]));
  const react = {
    useState(initial) {
      const index = component.index++;
      if (!(index in component.hooks)) component.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [component.hooks[index], next => {
        writes++;
        component.hooks[index] = typeof next === 'function' ? next(component.hooks[index]) : next;
      }];
    },
    useRef(initial) {
      const index = component.index++;
      return component.hooks[index] ||= { current: initial };
    },
    useMemo(callback, deps) {
      const index = component.index++;
      if (!same(component.hooks[index]?.deps, deps)) component.hooks[index] = { deps, value: callback() };
      return component.hooks[index].value;
    },
    useEffect(effect, deps) {
      const index = component.index++;
      if (!same(component.hooks[index]?.deps, deps)) {
        const previous = component.hooks[index];
        const next = { deps };
        component.hooks[index] = next;
        component.effects.push(() => { previous?.cleanup?.(); next.cleanup = effect(); });
      }
    },
  };
  const document = new EventTarget();
  document.visibilityState = hidden ? 'hidden' : 'visible';
  class ClockDate extends Date { static now() { return now; } }
  const exports = {};
  const source = fs.readFileSync('components/valuation/ZecBtcCard.tsx', 'utf8')
    + '\nexport { useZecBtc as __useZecBtc };\n';
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, document, Date: ClockDate, AbortController,
    require(name) {
      if (name === 'react') return react;
      if (name === '@/lib/zec-btc') return { btcPercentage: value => Number.isFinite(value) && value > 0 ? value * 100 : null };
      // Rendering dependencies are never executed by this hook harness.
      return {};
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay, interval: null });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay, interval: delay });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    fetch(url, options) {
      return new Promise((resolve, reject) => requests.push({
        url, signal: options.signal, reject,
        resolve(data) { resolve({ ok: true, json: async () => data }); },
        fail(status = 503) { resolve({ ok: false, status }); },
      }));
    },
  });
  const render = () => {
    component.index = 0;
    const result = exports.__useZecBtc(component.period);
    for (const effect of component.effects.splice(0)) effect();
    return result;
  };
  render();
  return {
    requests, render,
    get now() { return now; },
    get writes() { return writes; },
    get intervals() { return [...timers.values()].filter(timer => timer.interval !== null).length; },
    setPeriod(period) { component.period = period; render(); return render(); },
    setVisible(visible) {
      document.visibilityState = visible ? 'visible' : 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval === null) timers.delete(id);
        else timer.at += timer.interval;
        timer.callback();
      }
      now = target;
    },
    unmount() { component.hooks.forEach(hook => hook?.cleanup?.()); },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
function snapshot(period, now, value = 0.016) {
  const endAt = Date.parse('2026-10-27T00:00:00Z');
  const startAt = endAt - (period === '7d' ? 7 : 30) * 86_400_000;
  return {
    period, source: 'CoinGecko',
    quote: { btcPerZec: value, observedAt: now - 20_000, fetchedAt: now - 5_000, delayed: false },
    history: {
      points: [{ timestamp: startAt, btcPerZec: value / 2 }, { timestamp: endAt, btcPerZec: value }],
      startAt, endAt, observedAt: endAt, fetchedAt: now - 10_000, delayed: false,
    },
  };
}

test('a late response from the previous period never replaces the selected range', async () => {
  const view = harness();
  assert.match(view.requests[0].url, /period=30d$/);
  const pending = view.setPeriod('7d');
  assert.equal(view.requests[0].signal.aborted, true);
  assert.equal(pending.data?.history ?? null, null, 'old history must not appear under the new period');
  assert.match(view.requests[1].url, /period=7d$/);

  const current = snapshot('7d', view.now, 0.017);
  view.requests[1].resolve(current);
  await flush();
  assert.equal(view.render().data.period, '7d');
  assert.equal(view.render().data.quote.btcPerZec, 0.017);
  const writes = view.writes;
  view.requests[0].resolve(snapshot('30d', view.now, 0.03));
  await flush();
  assert.equal(view.writes, writes, 'disposed requests cannot write data or request state');
  assert.equal(view.render().data.period, '7d');
  assert.equal(view.render().data.history.startAt, current.history.startAt);
});

test('a range change retains the independent quote while hiding history from the previous period', async () => {
  const view = harness();
  const initial = snapshot('30d', view.now);
  view.requests[0].resolve(initial);
  await flush();
  const pending = view.setPeriod('7d');
  assert.equal(pending.quote.btcPerZec, initial.quote.btcPerZec);
  assert.equal(pending.quote.observedAt, initial.quote.observedAt);
  assert.equal(pending.quote.fetchedAt, initial.quote.fetchedAt);
  assert.equal(pending.data?.history ?? null, null);
  assert.equal(pending.failed, false);
  view.requests[1].resolve(snapshot('7d', view.now, 0.018));
  await flush();
  assert.equal(view.render().data.period, '7d');
  assert.equal(view.render().quote.btcPerZec, 0.018);
});

test('failed refresh retains last good values and their original observation and fetch times', async () => {
  const view = harness();
  const initial = snapshot('30d', view.now);
  view.requests[0].resolve(initial);
  await flush();
  view.advance(60_000);
  assert.equal(view.requests.length, 2);
  view.requests[1].fail();
  await flush();
  const result = view.render();
  assert.equal(result.failed, true);
  assert.equal(result.data.quote.btcPerZec, initial.quote.btcPerZec);
  assert.equal(result.data.quote.observedAt, initial.quote.observedAt);
  assert.equal(result.data.quote.fetchedAt, initial.quote.fetchedAt);
  assert.equal(result.data.history.observedAt, initial.history.observedAt);
  assert.equal(result.data.history.fetchedAt, initial.history.fetchedAt);
});

test('a failed previous period does not mark a newly requested period failed while it is pending', async () => {
  const view = harness();
  view.requests[0].fail();
  await flush();
  assert.equal(view.render().failed, true);
  const next = view.setPeriod('7d');
  assert.equal(next.failed, false);
  assert.equal(next.data?.history ?? null, null);
  view.requests[1].resolve(snapshot('7d', view.now));
  await flush();
  assert.equal(view.render().failed, false);
  assert.equal(view.render().data.period, '7d');
});

test('cleanup aborts the request and removes polling and visibility refreshes', async () => {
  const view = harness();
  const request = view.requests[0];
  view.unmount();
  assert.equal(request.signal.aborted, true);
  assert.equal(view.intervals, 0);
  const writes = view.writes;
  view.advance(60_000);
  view.setVisible(false);
  view.setVisible(true);
  assert.equal(view.requests.length, 1);
  request.resolve(snapshot('30d', view.now));
  await flush();
  assert.equal(view.writes, writes, 'a response settling after unmount cannot write state');
});

test('polling pauses while hidden and visibility return starts one immediate refresh', async () => {
  const view = harness({ hidden: true });
  assert.equal(view.requests.length, 0);
  view.advance(120_000);
  assert.equal(view.requests.length, 0);
  view.setVisible(true);
  view.setVisible(true);
  assert.equal(view.requests.length, 1, 'visibility events share the pending request');
  view.requests[0].resolve(snapshot('30d', view.now));
  await flush();
  view.setVisible(false);
  view.advance(120_000);
  assert.equal(view.requests.length, 1);
  view.setVisible(true);
  assert.equal(view.requests.length, 2);
  view.requests[1].resolve(snapshot('30d', view.now, 0.018));
  await flush();
  assert.equal(view.render().data.quote.btcPerZec, 0.018);
});
