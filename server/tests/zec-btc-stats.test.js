const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function quoteHarness({ enabled = true, hidden = false } = {}) {
  let now = Date.parse('2026-10-27T12:00:00Z');
  let timerId = 0;
  let writes = 0;
  const timers = new Map();
  const requests = [];
  const component = { hooks: [], effects: [], index: 0, enabled };
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
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('hooks/useZecBtcQuote.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, document, Date: ClockDate, AbortController,
    require(name) {
      if (name === 'react') return react;
      throw new Error(`Unexpected hook dependency: ${name}`);
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay, interval: null });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay, interval: delay });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    // Ignore abort here: an obsolete request must remain harmless even if its
    // response settles after disable/unmount rather than rejecting promptly.
    fetch(url, options) {
      return new Promise(resolve => requests.push({
        url, signal: options.signal,
        resolve(quote) { resolve({ ok: true, json: async () => ({ source: 'CoinGecko', quote }) }); },
        fail() { resolve({ ok: false, status: 503 }); },
      }));
    },
  });
  const render = () => {
    component.index = 0;
    const result = exports.useZecBtcQuote(component.enabled);
    for (const effect of component.effects.splice(0)) effect();
    return result;
  };
  render();
  return {
    requests, render,
    get now() { return now; },
    get writes() { return writes; },
    get intervals() { return [...timers.values()].filter(timer => timer.interval !== null).length; },
    setEnabled(value) { component.enabled = value; render(); return render(); },
    setVisible(value) {
      document.visibilityState = value ? 'visible' : 'hidden';
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
const quoteAt = (now, overrides = {}) => ({
  btcPerZec: 0.016, observedAt: now - 20_000, fetchedAt: now - 5_000, delayed: false, ...overrides,
});

test('the optional quote performs no work until enabled and reads only the quote endpoint', async () => {
  const view = quoteHarness({ enabled: false });
  view.advance(120_000);
  view.setVisible(false);
  view.setVisible(true);
  assert.equal(view.requests.length, 0);
  assert.equal(view.intervals, 0);
  assert.equal(view.render().quote, null);
  view.setEnabled(true);
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].url, '/api/market/zec-btc/quote');
  view.requests[0].resolve(quoteAt(view.now));
  await flush();
  assert.equal(view.render().quote.btcPerZec, 0.016);
  assert.equal(view.render().delayed, false);
});

test('visible polling pauses while hidden and resumes once on visibility return', async () => {
  const view = quoteHarness({ hidden: true });
  view.advance(120_000);
  assert.equal(view.requests.length, 0);
  view.setVisible(true);
  view.setVisible(true);
  assert.equal(view.requests.length, 1);
  view.requests[0].resolve(quoteAt(view.now));
  await flush();
  view.advance(60_000);
  assert.equal(view.requests.length, 2);
  view.requests[1].resolve(quoteAt(view.now));
  await flush();
  view.setVisible(false);
  view.advance(120_000);
  assert.equal(view.requests.length, 2);
  assert.equal(view.render().delayed, true, 'an old retained quote ages while polling is paused');
  view.setVisible(true);
  view.setVisible(true);
  assert.equal(view.requests.length, 3);
  view.requests[2].resolve(quoteAt(view.now, { btcPerZec: 0.018 }));
  await flush();
  assert.equal(view.render().quote.btcPerZec, 0.018);
  assert.equal(view.render().delayed, false);
});

test('disabling aborts pending work, removes refreshes, and ignores a late response', async () => {
  const view = quoteHarness();
  const initial = quoteAt(view.now);
  view.requests[0].resolve(initial);
  await flush();
  view.setVisible(true);
  const pending = view.requests[1];
  view.setEnabled(false);
  assert.equal(pending.signal.aborted, true);
  assert.equal(view.intervals, 0);
  const writes = view.writes;
  pending.resolve(quoteAt(view.now, { btcPerZec: 0.99 }));
  await flush();
  assert.equal(view.writes, writes);
  assert.equal(view.render().quote.btcPerZec, initial.btcPerZec);
  view.advance(120_000);
  view.setVisible(false);
  view.setVisible(true);
  assert.equal(view.requests.length, 2);
  view.setEnabled(true);
  assert.equal(view.requests.length, 3, 'reenabling starts a new owned request');
  view.unmount();
  assert.equal(view.requests[2].signal.aborted, true);
});

test('failed refresh retains the last good quote and timestamps while marking it delayed', async () => {
  const view = quoteHarness();
  const initial = quoteAt(view.now);
  view.requests[0].resolve(initial);
  await flush();
  view.setVisible(true);
  view.requests[1].fail();
  await flush();
  const failed = view.render();
  assert.equal(failed.quote.btcPerZec, initial.btcPerZec);
  assert.equal(failed.quote.observedAt, initial.observedAt);
  assert.equal(failed.quote.fetchedAt, initial.fetchedAt);
  assert.equal(failed.delayed, true, 'failure matters even when retained timestamps are still recent');
  view.advance(60_000);
  view.requests[2].resolve(quoteAt(view.now, { btcPerZec: 0.019 }));
  await flush();
  assert.equal(view.render().quote.btcPerZec, 0.019);
  assert.equal(view.render().delayed, false);
});

test('provider delay, age, unknown times, and future times never produce a current quote', async () => {
  const cases = [
    ['provider flag', () => ({ delayed: true })],
    ['old provider observation', now => ({ observedAt: now - 300_001 })],
    ['old cache fetch', now => ({ fetchedAt: now - 60_001 })],
    ['unknown provider time', () => ({ observedAt: null })],
    ['invalid provider time', () => ({ observedAt: NaN })],
    ['invalid cache time', () => ({ fetchedAt: NaN })],
    ['future provider time', now => ({ observedAt: now + 60_001 })],
    ['future cache time', now => ({ fetchedAt: now + 60_001 })],
  ];
  for (const [name, overrides] of cases) {
    const view = quoteHarness();
    view.requests[0].resolve(quoteAt(view.now, overrides(view.now)));
    await flush();
    assert.equal(view.render().delayed, true, name);
    view.unmount();
  }
});

function statsSelection(network) {
  const exports = {};
  const source = fs.readFileSync('components/StatsBar.tsx', 'utf8')
    + '\nexport { STAT_ORDER, DEFAULT_STATS, MAX_STATS, isValidStatId };\n';
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(name) {
      if (name === '@/lib/config') return {
        CURRENCY: network === 'mainnet' ? 'ZEC' : 'TAZ',
        isMainnet: network === 'mainnet', isCrosslink: network === 'crosslink-testnet',
      };
      // Module evaluation exposes selection policy without mounting the bar,
      // subscribing to unrelated API queries, or comparing presentation text.
      return {};
    },
  });
  return exports;
}

test('ZEC/BTC is opt-in on mainnet and rejected by other networks with the six-slot default preserved', () => {
  const defaults = ['block', 'mempool', 'hashrate', 'shieldedPool', 'shieldedPct', 'price'];
  for (const network of ['mainnet', 'testnet', 'crosslink-testnet']) {
    const selection = statsSelection(network);
    assert.equal(selection.isValidStatId('zecBtc'), network === 'mainnet', network);
    assert.equal(selection.STAT_ORDER.includes('zecBtc'), network === 'mainnet', network);
    assert.equal(selection.isValidStatId('unknownStat'), false);
    assert.equal(selection.isValidStatId(null), false);
    assert.equal(selection.MAX_STATS, 6);
    assert.deepEqual(Array.from(selection.DEFAULT_STATS), defaults);
  }
});
