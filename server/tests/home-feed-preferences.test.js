const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const exportsForTest = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/home-feed-preferences.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsForTest });
const { HOME_FEED_PREFERENCE_BOOTSTRAP, homeFeedPendingAttribute } = exportsForTest;

function boot(preferences = {}, options = {}) {
  const attributes = new Map();
  const listeners = { window: new Map(), document: new Map() };
  const timers = new Map();
  const root = {
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
    hasAttribute: key => attributes.has(key),
  };
  const eventTarget = name => ({
    addEventListener: (type, callback) => listeners[name].set(type, callback),
    removeEventListener: type => listeners[name].delete(type),
  });
  let storageReads = 0;
  vm.runInNewContext(HOME_FEED_PREFERENCE_BOOTSTRAP, {
    location: { pathname: options.path || '/' },
    document: { ...eventTarget('document'), documentElement: root },
    window: eventTarget('window'),
    localStorage: { getItem: key => {
      storageReads++;
      if (options.denied) throw new Error('Storage denied');
      return preferences[key] ?? null;
    } },
    setTimeout: (callback, delay) => { timers.set(1, { callback, delay }); return 1; },
    clearTimeout: id => timers.delete(id),
  });
  return { root, attributes, listeners, timers, storageReads,
    emit: (name, type, event = {}) => listeners[name].get(type)?.(event),
  };
}

test('default, absent, invalid and denied preferences leave server data visible without a timer', () => {
  for (const preferences of [{}, { 'cipherscan-home-card-right': 'shielded' }, { 'cipherscan-home-card-right': 'invalid' }]) {
    const result = boot(preferences);
    assert.equal(result.attributes.size, 0);
    assert.equal(result.timers.size, 0);
  }
  assert.equal(boot({}, { denied: true }).attributes.size, 0);
  assert.equal(boot({}, { path: '/about' }).storageReads, 0);
});

test('only the slot with a real saved alternative is concealed before hydration', () => {
  const result = boot({ 'cipherscan-home-card-right': 'transactions' });
  assert.deepEqual([...result.attributes.keys()], ['data-home-right-pending']);
  assert.equal(result.timers.get(1).delay, 5000);
  assert.equal(homeFeedPendingAttribute('cipherscan-home-card-right'), 'data-home-right-pending');
  assert.equal(homeFeedPendingAttribute('unknown'), undefined);
});

test('one completed slot does not release another pending preference; both completed remove the guard', () => {
  const result = boot({ 'cipherscan-home-card-left': 'transactions', 'cipherscan-home-card-right': 'blocks' });
  result.root.removeAttribute('data-home-left-pending');
  result.emit('document', 'home-feed-ready');
  assert.equal(result.root.hasAttribute('data-home-right-pending'), true);
  assert.equal(result.timers.size, 1);
  result.root.removeAttribute('data-home-right-pending');
  result.emit('document', 'home-feed-ready');
  assert.equal(result.timers.size, 0);
  assert.equal(result.listeners.window.size, 0);
  assert.equal(result.listeners.document.size, 0);
});

test('failed build scripts and runtime chunk errors reveal server defaults immediately', () => {
  for (const event of [
    { target: { tagName: 'SCRIPT', src: 'https://zecblock.com/_next/static/chunks/home.js' } },
    { filename: 'https://zecblock.com/_next/static/chunks/runtime.js' },
  ]) {
    const result = boot({ 'cipherscan-home-card-right': 'transactions' });
    result.emit('window', 'error', event);
    assert.equal(result.attributes.size, 0);
    assert.equal(result.timers.size, 0);
    assert.equal(result.listeners.window.size, 0);
  }
});

test('unrelated image errors keep normal preferences intact; a chunk rejection fails open', () => {
  const result = boot({ 'cipherscan-home-card-right': 'transactions' });
  result.emit('window', 'error', { target: { tagName: 'IMG', src: '/brand/zecblock-mark.svg' } });
  assert.equal(result.attributes.size, 1);
  result.emit('window', 'unhandledrejection', { reason: new Error('ChunkLoadError: Loading chunk failed') });
  assert.equal(result.attributes.size, 0);
  assert.equal(result.timers.size, 0);
});

test('stalled hydration cannot conceal the existing server snapshot indefinitely', () => {
  const result = boot({ 'cipherscan-home-card-right': 'transactions' });
  result.timers.get(1).callback();
  assert.equal(result.attributes.size, 0);
  assert.equal(result.timers.size, 0);
  assert.equal(result.listeners.window.size, 0);
});
