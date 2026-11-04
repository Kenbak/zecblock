const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, atob, URL, Response, require: name => dependencies[name] ?? require(name), ...globals });
  return exports;
}
const nu7 = load('lib/nu7-vote-results.ts');
const model = load('lib/governance.ts', { './nu7-vote-results': nu7 });
const helpers = load('lib/governance-announcement.ts', { './governance': model });
const now = Date.parse('2026-10-16T00:00:00Z');
const Clock = class extends Date { static now() { return now; } };
function vote(state, end = now + 3600_000, id = 'reviewed-vote') {
  return { id, state, title: 'Reviewed vote', href: `/governance/${id}`, round: { vote_end_time: end / 1000, discussion_url: '' } };
}
function catalog(votes = [], checkedAt = now) { return { votes, checkedAt, unavailable: false }; }
function route(network, data) {
  let calls = 0;
  return {
    handler: load('app/api/governance/announcement/route.ts', {
      '@/lib/governance-data': { getGovernanceAnnouncementCatalog: async () => { calls++; return data; } },
      '@/lib/governance-announcement': helpers,
      '@/lib/seo': { getNetwork: () => network },
    }, { Date: Clock }).GET,
    calls: () => calls,
  };
}

test('mainnet shares fresh announcements at the CDN while browsers revalidate and APIs stay noindex', async () => {
  const api = route('mainnet', catalog([vote('active')]));
  const response = await api.handler();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(api.calls(), 1);
  assert.equal(body.announcement.key, 'reviewed-vote:active');
  assert.equal(body.generatedAt, now);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  for (const header of ['CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.equal(response.headers.get(header), 'public, s-maxage=60, must-revalidate');
    assert.doesNotMatch(response.headers.get(header), /stale-while-revalidate|stale-if-error/);
  }
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, follow');
});

test('testnet and Crosslink never fetch or expose mainnet governance', async () => {
  for (const network of ['testnet', 'crosslink-testnet']) {
    const api = route(network, catalog([vote('active')]));
    const response = await api.handler();
    assert.equal((await response.json()).announcement, null);
    assert.equal(api.calls(), 0);
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, follow');
  }
});

test('empty successful catalogs share null, but unavailable and stale catalogs never enter the CDN', async () => {
  const empty = await route('mainnet', catalog()).handler();
  assert.equal((await empty.json()).announcement, null);
  assert.match(empty.headers.get('Vercel-CDN-Cache-Control'), /s-maxage=60/);
  for (const data of [{ votes: [], checkedAt: 0, unavailable: true }, catalog([vote('active')], now - 600_001)]) {
    const response = await route('mainnet', data).handler();
    assert.equal((await response.json()).announcement, null);
    for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) assert.equal(response.headers.get(header), 'no-store');
  }
});

test('CDN freshness uses the remaining catalog minute rather than adding another minute', () => {
  assert.equal(helpers.buildAnnouncementSnapshot(catalog([], now - 45_250), now).ttl, 14);
  for (const age of [60_000, 60_001, 300_000]) {
    assert.equal(helpers.buildAnnouncementSnapshot(catalog([vote('active')], now - age), now).ttl, 0);
  }
});

test('five-minute finalized result cache does not disable sharing a fresh directory minute', () => {
  const data = { ...catalog([vote('results')], now - 240_000), directoryCheckedAt: now - 15_000 };
  assert.equal(helpers.buildAnnouncementSnapshot(data, now).ttl, 45);
  // The older result check still bounds the ten-minute stale-data cutoff.
  const stale = { ...data, checkedAt: now - 600_001 };
  assert.equal(helpers.buildAnnouncementSnapshot(stale, now).ttl, 0);
  assert.equal(helpers.buildAnnouncementSnapshot(stale, now).snapshot.announcement, null);
});

test('fresh active voting stays announced when an unrelated historical tally check is old', () => {
  const data = { ...catalog([vote('active'), vote('results', now - 30 * 86_400_000, 'old-results')], now - 601_000), directoryCheckedAt: now };
  const fresh = helpers.buildAnnouncementSnapshot(data, now);
  assert.equal(fresh.snapshot.announcement.key, 'reviewed-vote:active');
  assert.equal(fresh.ttl, 60);
  assert.equal(fresh.snapshot.nextChangeAt, now + 600_001);
  assert.equal(helpers.buildAnnouncementSnapshot(data, now + 600_001).snapshot.announcement, null);
  assert.equal(helpers.buildAnnouncementSnapshot(data, now + 600_001).ttl, 0);
});

test('active voting closes at its deadline and CDN caching rounds down before the boundary', () => {
  const closing = now + 10_250;
  const data = catalog([vote('active', closing)]);
  const before = helpers.buildAnnouncementSnapshot(data, now);
  assert.equal(before.ttl, 10);
  assert.equal(before.snapshot.nextChangeAt, closing);
  assert.equal(before.snapshot.announcement.key, 'reviewed-vote:active');
  assert.equal(helpers.buildAnnouncementSnapshot(data, closing - 250).ttl, 0);
  assert.equal(helpers.buildAnnouncementSnapshot(data, closing).snapshot.announcement, null);
});

test('results and upcoming date-only notices transition without fabricating an opening or result', () => {
  const expiry = now + 10_000;
  const results = catalog([vote('results', expiry - 5 * 86_400_000)]);
  assert.equal(helpers.buildAnnouncementSnapshot(results, now).snapshot.nextChangeAt, expiry);
  assert.equal(helpers.buildAnnouncementSnapshot(results, expiry).snapshot.announcement, null);
  const opening = Date.parse(`${model.GRANTS.opensOn}T00:00:00Z`);
  const start = opening - 7 * 86_400_000;
  const before = helpers.buildAnnouncementSnapshot(catalog([], start - 10_000), start - 10_000);
  assert.equal(before.snapshot.announcement, null);
  assert.equal(before.snapshot.nextChangeAt, start);
  assert.equal(before.ttl, 10);
  const during = helpers.buildAnnouncementSnapshot(catalog([], opening - 10_000), opening - 10_000);
  assert.equal(during.snapshot.announcement.key, `${model.GRANTS.slug}:upcoming`);
  assert.equal(during.snapshot.nextChangeAt, opening);
  assert.equal(helpers.buildAnnouncementSnapshot(catalog([], opening), opening).snapshot.announcement, null);
});

function bannerHarness(responses, initialNow = now) {
  const effects = [];
  const updates = [];
  const timeouts = new Map();
  const intervals = new Map();
  const listeners = new Map();
  let clock = initialNow;
  let nextTimer = 1;
  let calls = 0;
  let state = 0;
  const FakeDate = class extends Date { static now() { return clock; } };
  const component = load('components/GovernanceBanner.tsx', {
    react: {
      useState: value => { const index = state++; return [value, next => { if (index === 0) updates.push(next); }]; },
      useRef: value => ({ current: value }), useEffect: effect => effects.push(effect),
    },
    'next/link': {}, '@/lib/config': { isMainnet: true, isCrosslink: false, NETWORK: 'mainnet' },
    '@/hooks/useApiQuery': { useApiQuery: () => ({ data: null, error: null }) },
    '@/lib/network-upgrades': { readUpgradeSnapshot: () => null, getPendingNu7Upgrade: () => null },
  }, {
    Date: FakeDate, performance: { now: () => clock }, AbortController,
    AbortSignal: { any: signals => signals[0], timeout: () => new AbortController().signal },
    document: { visibilityState: 'visible', addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) },
    setTimeout: (fn, delay) => { const id = nextTimer++; timeouts.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: (fn, delay) => { const id = nextTimer++; intervals.set(id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id),
    fetch: async () => {
      const response = responses[Math.min(calls++, responses.length - 1)];
      if (response instanceof Error) throw response;
      return response;
    },
  });
  component.GovernanceBanner();
  const cleanup = effects[1]();
  return { updates, timeouts, intervals, cleanup, calls: () => calls, advance: value => { clock += value; },
    tick: async () => { await new Promise(resolve => setImmediate(resolve)); } };
}
function response(snapshot, age = '0') {
  return { ok: true, headers: new Headers({ Age: age }), json: async () => snapshot };
}

test('a cached banner clears at the known boundary, accounts for CDN Age, and keeps its minute poll', async () => {
  const active = { key: 'vote:active', href: '/governance/vote', text: 'Voting is open' };
  const initial = { announcement: active, generatedAt: now - 50_000, nextChangeAt: now + 10_000 };
  const ended = { announcement: null, generatedAt: now + 10_000, nextChangeAt: null };
  const banner = bannerHarness([response(initial, '50'), response(ended)]);
  await banner.tick();
  assert.equal(banner.updates.at(-1).key, active.key);
  assert.equal([...banner.intervals.values()][0].delay, 60_000);
  const expiry = [...banner.timeouts.values()][0];
  assert.equal(expiry.at, now + 10_000);
  banner.advance(10_000);
  expiry.fn();
  assert.equal(banner.updates.at(-1), null);
  await banner.tick();
  assert.equal(banner.calls(), 2);
  assert.equal(banner.updates.at(-1), null);
  banner.cleanup();
  assert.equal(banner.timeouts.size, 0);
  assert.equal(banner.intervals.size, 0);
});

test('expired CDN payloads and failed refreshes cannot retain actionable announcement text', async () => {
  const active = { key: 'vote:active', href: '/governance/vote', text: 'Voting is open' };
  // CDN age protects the deadline even when the browser wall clock is behind.
  const expired = bannerHarness([response({ announcement: active, generatedAt: now - 60_000, nextChangeAt: now - 1 }, '61')], now - 30_000);
  await expired.tick();
  assert.equal(expired.updates.at(-1), null);
  assert.equal(expired.timeouts.size, 0);
  expired.cleanup();
  const banner = bannerHarness([response({ announcement: active, generatedAt: now, nextChangeAt: now + 120_000 }), new Error('offline')]);
  await banner.tick();
  assert.equal(banner.updates.at(-1).key, active.key);
  [...banner.intervals.values()][0].fn();
  await banner.tick();
  assert.equal(banner.updates.at(-1), null);
  assert.equal(banner.timeouts.size, 0);
  banner.cleanup();
});

test('a stale catalog with a distant deadline cannot overflow the browser timer into a refresh loop', async () => {
  const stale = helpers.buildAnnouncementSnapshot(catalog([vote('active', now + 30 * 86_400_000)], now - 600_001), now);
  assert.equal(stale.snapshot.announcement, null);
  assert.equal(stale.ttl, 0);
  const banner = bannerHarness([response(stale.snapshot)]);
  await banner.tick();
  assert.equal(banner.calls(), 1);
  assert.equal(banner.updates.at(-1), null);
  const timer = [...banner.timeouts.values()][0];
  assert.equal(timer.at - now, 2_147_483_647, 'setTimeout must stay within the browser signed 32-bit limit');
  assert.equal([...banner.intervals.values()][0].delay, 60_000);
  banner.cleanup();
});

test('shared announcement responses omit per-IP quota headers while the same limit remains enforced', async () => {
  const { NextRequest, NextResponse } = require('next/server');
  const { proxy } = load('proxy.ts', {
    'next/server': { NextResponse },
    './lib/governance-request': {}, './lib/network': {}, './lib/chart-catalog': {}, './lib/name-validation': {}, './lib/address-syntax': {},
  }, { process: { env: { NODE_ENV: 'production' } }, setInterval: () => {} });
  const request = path => new NextRequest(`https://zecblock.com${path}`, {
    headers: { host: 'zecblock.com', 'x-forwarded-for': '192.0.2.123' },
  });
  for (let i = 0; i < 300; i++) {
    const response = await proxy(request('/api/governance/announcement'));
    assert.equal(response.headers.get('x-middleware-next'), '1');
    for (const header of ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']) {
      assert.equal(response.headers.get(header), null, 'shared responses must not cache a visitor-specific quota');
    }
  }
  const limited = await proxy(request('/api/governance/announcement'));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('X-RateLimit-Remaining'), '0');
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  const other = await proxy(new NextRequest('https://zecblock.com/api/revalidate', {
    headers: { host: 'zecblock.com', 'x-forwarded-for': '192.0.2.124' },
  }));
  assert.equal(other.headers.get('X-RateLimit-Limit'), '300', 'other APIs retain their existing quota contract');
  assert.equal(other.headers.get('X-RateLimit-Remaining'), '299');
});
