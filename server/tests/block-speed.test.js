const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { once } = require('node:events');
const { loadBlockSpeed, DAYS_SQL, SUMMARY_SQL } = require('../api/lib/block-speed');
const { networkSchedule } = require('../api/lib/network-schedule');

function load(file, overrides = {}) {
  const filename = path.resolve(file);
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const localRequire = name => {
    if (name in overrides) return overrides[name];
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
    if (name.startsWith('@/') || name.startsWith('.')) {
      const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(filename), name);
      if (base.endsWith('.json')) return require(base);
      return load(fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`, overrides);
    }
    return require(name);
  };
  new Function('module', 'exports', 'require', output)(module, module.exports, localRequire);
  return module.exports;
}

const DAY = 86400;
const now = Date.parse('2026-10-22T12:00:00Z');
const nowTs = now / 1000;
const testnetInfo = { chain: 'test', blocks: 4528500, upgrades: { b: { name: 'Blossom', activationheight: 584000 }, n: { name: 'NU7', activationheight: 4465026 } } };
const mainnetInfo = { chain: 'main', blocks: 3526500, upgrades: { b: { name: 'Blossom', activationheight: 653600 } } };

// A linear chain: tip at nowTs, constant spacing within each era.
function chainPool({ tip, nu7 = null, before, after = before, daysRows = [], summaryRow = { intervals: 0 } }) {
  const queries = [];
  const timestampAt = height => nu7 != null && height < nu7
    ? nowTs - (tip - nu7) * after - (nu7 - height) * before
    : nowTs - (tip - height) * after;
  return { queries, pool: { async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT height, timestamp FROM blocks ORDER BY height DESC LIMIT 1')) return { rows: [{ height: tip, timestamp: nowTs }] };
    if (sql.startsWith('SELECT timestamp FROM blocks WHERE height = $1')) return { rows: params[0] <= tip ? [{ timestamp: timestampAt(params[0]) }] : [] };
    if (sql === DAYS_SQL) return { rows: daysRows };
    if (sql === SUMMARY_SQL) return { rows: [summaryRow] };
    throw new Error(`unexpected SQL ${sql.slice(0, 60)}`);
  } } };
}

test('history range widens by height lookups until it starts before the requested UTC day', async () => {
  const tip = 4528500; const nu7 = 4465026;
  const { pool, queries } = chainPool({ tip, nu7, before: 10, after: 25 });
  const payload = await loadBlockSpeed({ pool, info: testnetInfo, schedule: networkSchedule(testnetInfo), now });
  const days = queries.find(q => q.sql === DAYS_SQL);
  const historyStart = Math.floor(nowTs / DAY) * DAY - 30 * DAY;
  assert.deepEqual(days.params.slice(1), [tip, historyStart, nu7]);
  const lookups = queries.filter(q => q.sql.startsWith('SELECT timestamp FROM blocks WHERE height')).map(q => q.params[0]);
  const historyLookups = lookups.slice(0, lookups.indexOf(nu7));
  assert.ok(historyLookups.length > 1, 'a dense pre-NU7 era requires widening beyond the 25-second estimate');
  assert.equal(days.params[0], historyLookups.at(-1));
  assert.equal(payload.coverage.complete, true);
  assert.ok(payload.coverage.fromTimestamp <= historyStart - 3 * 3600);
  assert.deepEqual(payload.activation, { height: nu7, timestamp: nowTs - (tip - nu7) * 25 });
});

test('seven-day windows respect activation and target spacing', async () => {
  const tip = 4528500; const nu7 = 4465026;
  const summaryRow = { first_height: 4504307, last_height: tip, first_timestamp: nowTs - 7 * DAY, last_timestamp: nowTs, intervals: 24193, elapsed: 604825, median: 18, p90: 54.00000000000003 };
  const { pool, queries } = chainPool({ tip, nu7, before: 10, after: 25, summaryRow });
  const payload = await loadBlockSpeed({ pool, info: testnetInfo, schedule: networkSchedule(testnetInfo), now });
  const [latest, before] = queries.filter(q => q.sql === SUMMARY_SQL);
  assert.deepEqual(latest.params.slice(2), [nowTs - 7 * DAY, Number.MAX_SAFE_INTEGER, nu7, tip + 1], 'latest window starts no earlier than activation');
  assert.deepEqual(before.params.slice(1), [nu7 - 1, payload.activation.timestamp - 7 * DAY, Number.MAX_SAFE_INTEGER, 0, nu7]);
  assert.equal(payload.windows.latest.averageSeconds, 25);
  assert.equal(payload.windows.latest.p90Seconds, 54);
  assert.equal(payload.windows.latest.targetSeconds, 25);
  assert.equal(payload.windows.beforeUpgrade.targetSeconds, 75);
});

test('days split by activation, and the current day, are not complete', async () => {
  const start = Math.floor(nowTs / DAY) * DAY;
  const row = (dayStart, nu7, first, last, elapsed) => ({ day_start: String(dayStart), nu7, first_height: first, last_height: last, intervals: last - first + 1, elapsed: String(elapsed), median: 52, p90: 172 });
  const daysRows = [
    row(start - 2 * DAY, false, 100, 1251, 86400),
    row(start - DAY, false, 1252, 1700, 34000), row(start - DAY, true, 1701, 3700, 52400),
    row(start, true, 3701, 4000, 7500),
  ];
  const info = { chain: 'test', blocks: 4000, upgrades: { b: { name: 'Blossom', activationheight: 584000 } } };
  const schedule = { network: 'test', source: 'node-upgrade-schedule', nu7Height: 1701, eras: [{ height: 0, seconds: 75 }, { height: 1701, seconds: 25 }] };
  const { pool } = chainPool({ tip: 4000, before: 75, daysRows });
  const payload = await loadBlockSpeed({ pool, info, schedule, now });
  assert.deepEqual(payload.days.map(d => [d.date, d.nu7, d.complete, d.targetSeconds]), [
    ['2026-10-20', false, true, 75], ['2026-10-21', false, false, 75], ['2026-10-21', true, false, 25], ['2026-10-22', true, false, 25],
  ]);
  assert.equal(payload.days[0].averageSeconds, 75);
});

test('mainnet without NU7 reports no activation or pre-upgrade window', async () => {
  const { pool, queries } = chainPool({ tip: 3526500, before: 75, summaryRow: { first_height: 1, last_height: 8064, first_timestamp: 1, last_timestamp: 2, intervals: 8064, elapsed: 607219, median: 52, p90: 172 } });
  const payload = await loadBlockSpeed({ pool, info: mainnetInfo, schedule: networkSchedule(mainnetInfo), now });
  assert.equal(payload.activation, null);
  assert.equal(payload.windows.beforeUpgrade, null);
  assert.equal(payload.windows.latest.averageSeconds, 75.3);
  assert.equal(queries.filter(q => q.sql === SUMMARY_SQL).length, 1);
  assert.equal(queries.find(q => q.sql === DAYS_SQL).params[3], null);
});

test('a capped scan omits its partial UTC day and cannot publish a truncated seven-day summary', async () => {
  const tip = mainnetInfo.blocks;
  const fromTimestamp = nowTs - 600000;
  const firstStart = Math.floor(fromTimestamp / DAY) * DAY;
  const row = start => {
    const first = Math.max(start, fromTimestamp + 1);
    const last = Math.min(start + DAY - 1, nowTs);
    const intervals = last - first + 1;
    return { day_start: start, nu7: false, first_height: tip - (nowTs - first), last_height: tip - (nowTs - last), intervals, elapsed: intervals, median: 1, p90: 1 };
  };
  const summaryRow = { first_height: tip - 599999, last_height: tip, first_timestamp: fromTimestamp + 1, last_timestamp: nowTs, intervals: 600000, elapsed: 600000, median: 1, p90: 1 };
  const { pool } = chainPool({ tip, before: 1, daysRows: [row(firstStart), row(firstStart + DAY)], summaryRow });
  const result = await loadBlockSpeed({ pool, info: mainnetInfo, schedule: networkSchedule(mainnetInfo), now });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.fromTimestamp, fromTimestamp);
  assert.deepEqual(result.days.map(day => day.complete), [false, true]);
  assert.equal(result.windows.latest, null, 'a scan shorter than seven days is not a complete seven-day observation');
  const story = load('lib/block-speed.ts').buildSpeedStory(result);
  assert.ok(!story.points.some(point => point.kind === 'measured' && point.date === result.days[0].date));
  assert.ok(story.points.some(point => point.kind === 'measured' && point.date === result.days[1].date));
});

test('capped thirty-day history retains a fully covered seven-day summary', async () => {
  const tip = mainnetInfo.blocks;
  const summaryRow = { first_height: tip - 302399, last_height: tip, first_timestamp: nowTs - 604798, last_timestamp: nowTs, intervals: 302400, elapsed: 604800, median: 2, p90: 2 };
  const { pool } = chainPool({ tip, before: 2, summaryRow });
  const result = await loadBlockSpeed({ pool, info: mainnetInfo, schedule: networkSchedule(mainnetInfo), now });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.fromTimestamp < nowTs - 7 * DAY);
  assert.equal(result.windows.latest.averageSeconds, 2);
});

test('a capped history still measures a newly active era when its activation predecessor is covered', async () => {
  const tip = testnetInfo.blocks;
  const summaryRow = { first_height: 4465026, last_height: tip, first_timestamp: nowTs - (tip - 4465026), last_timestamp: nowTs, intervals: tip - 4465026 + 1, elapsed: tip - 4465026 + 1, median: 1, p90: 1 };
  const { pool } = chainPool({ tip, nu7: 4465026, before: 1, after: 1, summaryRow });
  const result = await loadBlockSpeed({ pool, info: testnetInfo, schedule: networkSchedule(testnetInfo), now });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.fromTimestamp > nowTs - 7 * DAY, 'the cap starts inside the calendar week');
  assert.ok(result.activation.timestamp > result.coverage.fromTimestamp, 'the full active era is still covered');
  assert.equal(result.windows.latest.averageSeconds, 1);
  assert.equal(result.windows.latest.targetSeconds, 25);
});

test('v1 block-speed route shares one computation and does not cache failures', async t => {
  const express = require('express');
  const createV1Router = require('../api/v1');
  const { registerNetworkReadinessRoutes } = require('../api/routes/network-readiness');
  const source = express();
  let rpcCalls = 0; let failRpc = true;
  source.locals.pool = chainPool({ tip: 3526500, before: 75 }).pool;
  source.locals.callZebraRPC = async method => {
    assert.equal(method, 'getblockchaininfo');
    rpcCalls++;
    if (failRpc) throw new Error('fixture unavailable');
    return mainnetInfo;
  };
  registerNetworkReadinessRoutes(source);
  const upstream = source.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const router = createV1Router({ API_V1_ENABLED: 'true', API_V1_LAUNCHED: 'true', NEXT_PUBLIC_NETWORK: 'mainnet',
    V1_INTERNAL_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, V1_INTERNAL_SERVICE_KEY: '' });
  const app = express(); app.use('/v1', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    router.__stopRateLimiters?.();
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([server, upstream].map(s => new Promise(resolve => s.close(resolve))));
  });
  const url = `http://127.0.0.1:${server.address().port}/v1/network/block-speed`;
  assert.equal((await fetch(url)).status, 503);
  failRpc = false;
  const responses = await Promise.all([fetch(url), fetch(url), fetch(url)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
  const { data } = await responses[0].json();
  assert.equal(data.network, 'main');
  assert.equal(data.source, 'canonical-block-header-timestamps');
  assert.equal(rpcCalls, 2, 'the failure was retried once and concurrent requests shared one computation');
  assert.equal((await fetch(`${url}?period=7d`)).status, 400, 'unknown query parameters are rejected at the v1 boundary');
});

const speed = load('lib/block-speed.ts');
const summary = (averageSeconds, medianSeconds, p90Seconds, targetSeconds) => ({ fromHeight: 1, toHeight: 2, fromTimestamp: 1, toTimestamp: 2, intervals: 100, averageSeconds, medianSeconds, p90Seconds, targetSeconds });
const day = (date, nu7, averageSeconds, complete = true) => ({ date, start: Date.parse(`${date}T00:00:00Z`) / 1000, nu7, targetSeconds: nu7 ? 25 : 75, firstHeight: 10, lastHeight: 20, intervals: 10, averageSeconds, medianSeconds: 1, p90Seconds: 2, complete });
const payload = (network, overrides) => ({ network, observedAt: '2026-10-22T00:00:00.000Z', indexedHeight: 5, tipTimestamp: 5, schedule: { nu7Height: null },
  activation: null, coverage: { fromTimestamp: 1, complete: true, historyDays: 30 }, days: [], windows: { latest: null, beforeUpgrade: null }, ...overrides });

const panel = (story, variant) => renderToStaticMarkup(React.createElement(load('components/network/BlockSpeedPanel.tsx').BlockSpeedPanel, { story, variant }));
const linkedBars = html => (html.match(/<a [^>]*class="cadence-link"/g) || []).length;

test('before mainnet activation, mainnet shows its own measured days, then the consensus target', () => {
  const mainnet = payload('main', { tipTimestamp: nowTs, indexedHeight: 3526500,
    days: [day('2026-10-20', false, 75.2), day('2026-10-21', false, 75.6), day('2026-10-22', false, 75.7, false)], windows: { latest: summary(75.3, 52, 172, 75), beforeUpgrade: null } });
  const testnet = payload('test', { activation: { height: 4465026, timestamp: 1 }, schedule: { nu7Height: 4465026 }, windows: { latest: summary(25, 18, 54, 25), beforeUpgrade: summary(10, 2, 28, 75) } });
  const story = speed.buildSpeedStory(speed.readBlockSpeed(mainnet, 'main'), speed.readBlockSpeed(testnet, 'test'));
  assert.equal(story.phase, 'upcoming');
  assert.equal(story.before.averageSeconds, 75.3);
  assert.equal(story.after, null, 'nothing about NU7 is presented as a mainnet measurement');
  assert.equal(speed.nu7Average(story), 25);
  assert.deepEqual(story.activation, { height: 3543405, date: '2026-11-05', status: 'announced' });
  const measured = story.points.filter(p => p.kind === 'measured');
  const projected = story.points.filter(p => p.kind === 'projected');
  assert.deepEqual(measured.map(p => p.date), ['2026-10-20', '2026-10-21'], 'today is incomplete and not measured');
  assert.equal(projected[0].date, '2026-10-22');
  assert.ok(projected.filter(p => !p.nu7).every(p => p.averageSeconds === 75 && p.date < '2026-11-05'));
  assert.deepEqual(projected.filter(p => p.nu7).map(p => p.averageSeconds), Array(7).fill(25));
  assert.equal(projected.find(p => p.nu7).date, '2026-11-05');
  assert.equal(story.testnetNu7.averageSeconds, 25, 'testnet is supporting evidence only');
  assert.equal(speed.formatWait(speed.confirmationSeconds(75.3, 10)), '12.6 min');
  assert.equal(speed.formatWait(speed.confirmationSeconds(25, 10)), '4.2 min');

  const html = panel(story);
  assert.match(html, /NU7 · 25-second block target · block #3,543,405/);
  assert.match(html, /7-day average → NU7 target/);
  assert.match(html, /around November 5, 2026/);
  assert.match(html, /href="\/network\/block-speed"/);
  assert.match(html, /75\.3s/);
  assert.match(html, /Average block/);
  assert.match(html, /Typical gap/);
  const stats = html.match(/<dl\b[\s\S]*?<\/dl>/)[0];
  assert.doesNotMatch(stats, /Received funds spendable|\d+(?:\.\d+)? min/, 'summary metrics describe block timing rather than repeating wallet waits');
  assert.match(html, /Outlined bars show targets/);
  assert.match(html, /NU7 target/);
  assert.doesNotMatch(html, /Measured with NU7/, 'upcoming mainnet does not claim measured NU7 timing');
  assert.equal(linkedBars(html), 2, 'only measured days link to blocks');

  const scheduled = speed.buildSpeedStory({ ...speed.readBlockSpeed(mainnet, 'main'), schedule: { nu7Height: 3526500 + 1152 } });
  assert.deepEqual(scheduled.activation, { height: 3527652, date: '2026-10-23', status: 'scheduled' }, 'the serving-node schedule wins, dated at the current target');
});

test('after mainnet activation, measured days replace the projection', () => {
  const mainnet = payload('main', { activation: { height: 3543405, timestamp: Date.parse('2026-11-05T10:00:00Z') / 1000 }, schedule: { nu7Height: 3543405 },
    days: [day('2026-11-04', false, 75), day('2026-11-05', false, 75, false), day('2026-11-05', true, 25, false), day('2026-11-06', true, 25)],
    windows: { latest: summary(25.2, 18, 55, 25), beforeUpgrade: summary(75.1, 52, 171, 75) } });
  const story = speed.buildSpeedStory(speed.readBlockSpeed(mainnet, 'main'));
  assert.equal(story.phase, 'active');
  assert.equal(story.after.averageSeconds, 25.2);
  assert.equal(story.before.averageSeconds, 75.1);
  assert.deepEqual(story.points.map(p => [p.date, p.nu7, p.kind]), [['2026-11-04', false, 'measured'], ['2026-11-06', true, 'measured']], 'the split activation day is omitted');
  assert.equal(story.activation.date, '2026-11-05');
  assert.match(panel(story, 'full'), /Mainnet · NU7 active since block #3,543,405, November 5, 2026/);
  assert.doesNotMatch(panel(story, 'full'), /Target projection/, 'active mainnet days are measured rather than projected');
});

test('testnet shows its own NU7 days and marks the minimum-difficulty era as not comparable', () => {
  const testnet = payload('test', { activation: { height: 4465026, timestamp: Date.parse('2026-10-04T08:00:00Z') / 1000 }, schedule: { nu7Height: 4465026 },
    days: [day('2026-10-03', false, 4.9), day('2026-10-21', true, 25.1), day('2026-10-22', true, 24.6, false)],
    windows: { latest: summary(25, 18, 54, 25), beforeUpgrade: summary(10, 2, 28, 75) } });
  const story = speed.buildSpeedStory(speed.readBlockSpeed(testnet, 'test'));
  assert.equal(story.network, 'testnet');
  assert.equal(story.before, null, 'testnet pre-NU7 history is never a baseline');
  assert.equal(story.irregular.medianSeconds, 2);
  assert.deepEqual(story.points.map(p => [p.date, p.kind]), [['2026-10-03', 'irregular'], ['2026-10-21', 'measured']]);
  const html = panel(story);
  assert.match(html, /Testnet · NU7 active since block #4,465,026, October 4, 2026/);
  assert.match(html, /Typical gap/);
  assert.match(html, /18s/);
  assert.match(html, /Earlier testnet · irregular/);
  assert.doesNotMatch(html, /→<\/span>/, 'no before/after arrows on testnet');
});

test('malformed or wrong-network payloads are rejected and unavailable values stay unavailable', () => {
  assert.equal(speed.readBlockSpeed(payload('test'), 'main'), null);
  assert.equal(speed.readBlockSpeed({ ...payload('main'), days: [{ date: 'bad' }] }, 'main'), null);
  assert.equal(speed.buildSpeedStory(null, payload('test')), null);
  const story = speed.buildSpeedStory(payload('main', { tipTimestamp: nowTs }));
  assert.equal(story.before, null);
  assert.equal(speed.formatWait(speed.confirmationSeconds(null, 10)), '—');
  assert.equal(story.points.filter(p => !p.nu7).length, 0, 'no pre-NU7 projection without a known current target');
  assert.match(panel(story, 'full'), /—/);
  assert.match(panel(null), /Block speed observations are unavailable/);
});

test('daily chart stacks first confirmation and nine more to the ten-confirmation wait', () => {
  const points = [
    { key: 'pre', date: '2026-10-20', nu7: false, kind: 'measured', averageSeconds: 75, targetSeconds: 75, lastHeight: 100 },
    { key: 'nu7', date: '2026-10-21', nu7: true, kind: 'projected', averageSeconds: 25, targetSeconds: 25, lastHeight: null },
  ];
  const html = renderToStaticMarkup(React.createElement(load('components/network/BlockSpeedChart.tsx').BlockSpeedChart, { points, activation: null }));
  assert.match(html, /<svg[^>]*aria-label="Daily confirmation waits in minutes: first confirmation and 10 confirmations total/);
  assert.match(html, /<text[^>]*>0m<\/text>/, 'the y-axis uses elapsed minutes');
  assert.match(html, /aria-label="Oct 20[^"]*average block 75s[^"]*first confirmation 75s[^"]*10 confirmations 12\.5 min/);
  assert.match(html, /Oct 21[^<]*25s (?:block )?target/);
  assert.match(html, /First confirmation/);
  assert.match(html, /9 more confirmations/);
  assert.equal(linkedBars(html), 1, 'only the observed day links to its block');
  const attributes = [...html.matchAll(/<rect([^>]+)>/g)].map(match => match[1]);
  const attribute = (attrs, name) => attrs.match(new RegExp(`\\b${name}="([^"]+)"`))[1];
  const [remaining, first, projectedRemaining, projectedFirst] = attributes;
  assert.equal(attribute(first, 'data-confirmation-segment'), 'first');
  assert.equal(attribute(remaining, 'data-confirmation-segment'), 'remaining');
  assert.equal(attribute(first, 'class'), 'fill-cipher-gold');
  assert.equal(attribute(remaining, 'class'), 'fill-muted');
  const firstHeight = Number(attribute(first, 'height'));
  const remainingHeight = Number(attribute(remaining, 'height'));
  assert.ok(Math.abs(firstHeight / (firstHeight + remainingHeight) - 0.1) < 1e-12, 'the first confirmation occupies one tenth of the total wait');
  assert.ok(Math.abs(Number(attribute(remaining, 'y')) + remainingHeight - Number(attribute(first, 'y'))) < 1e-12, 'the nine remaining confirmations meet the first without a gap or overlap');
  for (const projected of [projectedRemaining, projectedFirst]) {
    assert.match(attribute(projected, 'class'), /fill-none stroke-/);
    assert.equal(attribute(projected, 'stroke-dasharray'), '3 2');
  }
  const measuredY = Number(attribute(remaining, 'y'));
  const targetY = Number(html.match(/<line[^>]*\by1="([\d.]+)"[^>]*class="stroke-secondary"/)[1]);
  assert.equal(measuredY, targetY, 'the full ten-confirmation stack lies on its matching block target');
});

test('current block target label sits beside Today while the NU7 target stays in its own era', () => {
  const points = [
    { key: 'measured', date: '2026-10-19', nu7: false, kind: 'measured', averageSeconds: 75, targetSeconds: 75, lastHeight: 100 },
    { key: 'today', date: '2026-10-20', nu7: false, kind: 'projected', averageSeconds: 75, targetSeconds: 75, lastHeight: null },
    { key: 'tomorrow', date: '2026-10-21', nu7: false, kind: 'projected', averageSeconds: 75, targetSeconds: 75, lastHeight: null },
    { key: 'nu7', date: '2026-10-22', nu7: true, kind: 'projected', averageSeconds: 25, targetSeconds: 25, lastHeight: null },
  ];
  const html = renderToStaticMarkup(React.createElement(load('components/network/BlockSpeedChart.tsx').BlockSpeedChart, { points, activation: null }));
  const textAttributes = label => html.match(new RegExp(`<text([^>]*)>${label}<\\/text>`))[1];
  const x = attrs => Number(attrs.match(/\bx="([\d.]+)"/)[1]);
  const target = textAttributes('75s blocks');
  assert.match(target, /text-anchor="start"/);
  assert.ok(Math.abs(x(target) - x(textAttributes('Today'))) <= 8, 'the current target label is beside the projection start');
  assert.ok(x(target) < x(textAttributes('NU7')), 'the current target label does not sit at the upgrade boundary');
  const nu7Target = textAttributes('25s blocks');
  assert.ok(x(nu7Target) > x(textAttributes('NU7')), 'the NU7 target label stays in the NU7 interval');
  assert.match(nu7Target, /text-anchor="end"/);
});

const pageImports = {
  'server-only': {},
  '@/components/network/BlockTimeChart': { BlockTimeChart: () => null },
  '@/lib/isr-fallback': { retainLastGoodOrBuildFallback: (_fallback, error) => { throw error; } },
};

test('block-speed metadata keeps canonical and social identity on the selected network', async () => {
  const previous = process.env.NEXT_PUBLIC_NETWORK;
  try {
    for (const [network, origin] of [
      ['mainnet', 'https://zecblock.com'],
      ['testnet', 'https://testnet.zecblock.com'],
      ['crosslink-testnet', 'https://crosslink.zecblock.com'],
    ]) {
      process.env.NEXT_PUBLIC_NETWORK = network;
      const page = load('app/network/block-speed/page.tsx', {
        ...pageImports,
        '@/lib/block-speed-server': { loadBlockSpeedSnapshot: async () => ({ host: null, story: null }) },
      });
      const metadata = await page.generateMetadata();
      const canonical = `${origin}/network/block-speed`;
      assert.equal(metadata.alternates.canonical, canonical);
      assert.equal(metadata.robots.index, network === 'mainnet');
      assert.equal(metadata.robots.follow, true);
      assert.equal(metadata.openGraph.url, canonical);
      assert.equal(metadata.openGraph.title, metadata.title);
      assert.equal(metadata.openGraph.description, metadata.description);
      assert.equal(metadata.openGraph.siteName, 'ZecBlock');
      assert.deepEqual(metadata.openGraph.images, [{ url: `${canonical}/image`, width: 1200, height: 675, alt: 'Zcash daily block speed and NU7 · ZecBlock' }]);
      assert.equal(metadata.twitter.card, 'summary_large_image');
      assert.equal(metadata.twitter.title, metadata.title);
      assert.deepEqual(metadata.twitter.images, metadata.openGraph.images);
    }
    const entries = load('lib/sitemaps.ts').getStaticSitemapEntries('core', 'https://zecblock.com', []);
    assert.equal(entries.filter(entry => entry.url === 'https://zecblock.com/network/block-speed').length, 1);
    assert.ok(!entries.some(entry => /\/network\/block-speed\//.test(entry.url)), 'the image asset is not a content sitemap URL');
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_NETWORK;
    else process.env.NEXT_PUBLIC_NETWORK = previous;
  }
});

test('server-rendered block-speed content has one heading, linked sections and the shared chart action', async () => {
  const host = payload('main', { tipTimestamp: nowTs, days: [day('2026-10-21', false, 75.3)], windows: { latest: summary(75.3, 52, 172, 75), beforeUpgrade: null } });
  let story = speed.buildSpeedStory(host);
  const page = load('app/network/block-speed/page.tsx', {
    ...pageImports,
    '@/lib/seo': { getNetwork: () => 'mainnet', getBaseUrl: () => 'https://zecblock.com' },
    '@/lib/block-speed-server': { loadBlockSpeedSnapshot: async () => ({ host, story }) },
  });
  const html = renderToStaticMarkup(await page.default());
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1[^>]*>Zcash block speed<\/h1>/);
  assert.match(html, /href="\/network"/);
  for (const section of ['daily', 'confirmations', 'live', 'method']) {
    assert.match(html, new RegExp(`href="#${section}"`));
    assert.match(html, new RegExp(`id="${section}"`));
  }
  assert.match(html, /<button[^>]*aria-label="Share Zcash block speed"/);
  assert.doesNotMatch(html, /<a[^>]*href="\/network\/block-speed\/image"/, 'image export is an action in the shared chart control');
  const confirmations = html.match(/<section id="confirmations"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(confirmations, /<details\b/, 'the wallet guide is visible without opening a disclosure');
  assert.doesNotMatch(confirmations, /<summary\b/, 'the wallet guide has no disclosure toggle');
  assert.match(confirmations, /Wallet confirmation guide/);
  const rows = confirmations.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)[1];
  assert.equal((rows.match(/<tr\b/g) || []).length, 3, 'the table only compares confirmation depths');
  for (const label of ['First confirmation', '3 confirmations', '10 confirmations']) assert.ok(rows.includes(label), label);
  assert.doesNotMatch(confirmations, /Typical gap|Slow blocks|Median time between blocks|1 gap in 10/);
  assert.match(rows, /12\.6 min/);
  assert.match(rows, /4\.2 min/);
  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
  assert.equal(schema.url, 'https://zecblock.com/network/block-speed');
  assert.equal(schema.isPartOf['@id'], 'https://zecblock.com/#website');

  story = { ...story, network: 'testnet', phase: 'active', before: null, after: null };
  const unavailable = renderToStaticMarkup(await page.default());
  assert.doesNotMatch(unavailable, /href="#confirmations"/);
  assert.doesNotMatch(unavailable, /id="confirmations"/);
});

test('block-speed image keeps Crosslink absent and outages uncached, then recovers on the next request', async () => {
  let network = 'crosslink-testnet';
  let calls = 0;
  let imageTree;
  let snapshot = { host: null, story: null };
  const route = load('app/network/block-speed/image/route.tsx', {
    '@/lib/seo': { getNetwork: () => network },
    '@/lib/block-speed-server': { loadBlockSpeedSnapshot: async () => { calls++; return snapshot; } },
    'node:fs/promises': { readFile: async () => Buffer.from('fixture asset') },
    'next/og': { ImageResponse: class extends Response { constructor(tree, options) { super('', options); imageTree = tree; } } },
  });
  assert.equal((await route.GET()).status, 404);
  assert.equal(calls, 0, 'Crosslink does not fetch an unsupported image');
  network = 'mainnet';
  const unavailable = await route.GET();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
  assert.equal(unavailable.headers.get('Retry-After'), '60');
  const host = payload('main', { tipTimestamp: nowTs, days: [day('2026-10-21', false, 75.3)], windows: { latest: summary(75.3, 52, 172, 75), beforeUpgrade: null } });
  snapshot = { host, story: speed.buildSpeedStory(host) };
  const recovered = await route.GET();
  assert.equal(recovered.status, 200);
  assert.equal(calls, 2);
  assert.match(recovered.headers.get('Cache-Control'), /max-age=300/);
  assert.equal(recovered.headers.get('X-Robots-Tag'), 'noindex');
  const imageHtml = renderToStaticMarkup(imageTree);
  assert.match(imageHtml, /expected minutes/);
  assert.match(imageHtml, /First confirmation/);
  assert.match(imageHtml, /9 more confirmations/);
  assert.match(imageHtml, /10 confirmations: 12\.6 min/);
  assert.match(imageHtml, /4\.2 min at the NU7 target/);
  assert.doesNotMatch(imageHtml, /seconds per block/, 'the exported image uses the same stacked confirmation metric');
  snapshot = { host, story: { ...snapshot.story, points: [] } };
  assert.equal((await route.GET()).status, 503, 'an empty chart does not become a cached image');
});

test('blocks-per-day view keeps the NU7 marker and clips irregular testnet days to the comparable scale', () => {
  const point = (date, nu7, kind, blocks, target) => ({ key: date, date, nu7, kind, averageSeconds: 86400 / blocks, targetSeconds: target, lastHeight: 1, blocks });
  const points = [point('2026-10-01', false, 'irregular', 17000, 75), point('2026-10-05', true, 'measured', 3400, 25), point('2026-10-06', true, 'measured', 3460, 25)];
  const html = renderToStaticMarkup(React.createElement(load('components/network/BlockSpeedChart.tsx').BlockSpeedChart, { points, activation: null, metric: 'blocks' }));
  assert.match(html, /aria-label="Blocks mined per UTC day/);
  assert.match(html, /<text[^>]*>4k<\/text>/, 'scaled to the comparable NU7 days, not the 17k irregular day');
  assert.equal((html.match(/data-clipped="true"/g) || []).length, 1);
  assert.match(html, /Oct 1 · minimum-difficulty era · 17,000 blocks/);
  assert.match(html, /fill-cipher-gold[^"]*"/);
  assert.match(html, /NU7 activation|Estimated NU7 activation/);
});

test('NU7 cards draw only authoritative facts', () => {
  const cards = load('lib/nu7-cards.ts');
  assert.equal(cards.zatHeadline('811560160', 'TAZ'), '8.11 TAZ');
  assert.equal(cards.zatHeadline('-1', 'ZEC'), '-0.00 ZEC');
  assert.equal(cards.nsmCard('mainnet', { reserve: { growthSinceNu7Zat: null } }), null, 'no NSM card before activation');
  assert.equal(cards.readinessCard('mainnet', { referenceUpgrade: 'NU6.3', readinessPct: 100, totalActive: 5 }), null, 'old NU6.3 readiness is never shown as NU7');
  const ready = cards.readinessCard('mainnet', { referenceUpgrade: 'NU7', latestProtocol: 170190, readinessPct: 61.3, latestCount: 285, totalActive: 465 });
  assert.equal(ready.headline, '61.3%');
  assert.match(ready.detail, /285 of 465 nodes report protocol 170190/);
});
