const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const registry = require('../../data/wallet-servers.json');
const lib = require('../../lib/wallet-servers');
const { createWalletServersRouter } = require('../routes/wallet-servers');

const HASH = '0000000000e631c94fe7b859a8ef133fceea3cf28a1631f6cc1b28dbe5cf3347';
const wireHash = () => Buffer.from(HASH, 'hex').reverse();
const grpc = { credentials: { createSsl: () => 'tls' } };

function fakeStreamer(handlers, seen = {}) {
  return class {
    constructor(target, credentials) { seen.target = target; seen.credentials = credentials; }
    GetLightdInfo(_request, options, done) { seen.deadline = options.deadline; handlers.info(done); }
    GetLatestBlock(_request, _options, done) { handlers.block(done); }
    close() { seen.closed = (seen.closed || 0) + 1; }
  };
}
const endpoint = { id: 'a', host: 'wallet.example', port: 443 };

test('registry lists only reviewed TLS hostnames with unique identifiers', () => {
  const ids = new Set();
  for (const [network, operators] of Object.entries(registry)) {
    assert.equal(network, 'mainnet');
    for (const operator of operators) {
      for (const url of [operator.operatorUrl, operator.statusUrl]) assert.equal(new URL(url).protocol, 'https:');
      if (operator.logo) assert.ok(require('node:fs').existsSync(require('node:path').join(__dirname, '../../../public', operator.logo)), operator.logo);
      assert.ok(operator.endpoints.length > 0);
      for (const item of operator.endpoints) {
        assert.match(item.host, /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/);
        assert.equal(item.port, 443);
        assert.ok(['global', 'area', 'region'].includes(item.scope));
        assert.ok(item.label);
        // A position is either the operator's published city for a single
        // region, or an explicitly approximate point for an area name.
        assert.equal('lat' in item, 'lon' in item);
        if ('lat' in item) {
          assert.ok(Math.abs(item.lat) <= 90 && Math.abs(item.lon) <= 180);
          assert.equal(item.approximate === true, item.scope === 'area');
          assert.notEqual(item.scope, 'global');
        } else assert.equal('approximate' in item, false);
        assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
        ids.add(item.id);
      }
    }
  }
  assert.ok(ids.has('fastz-rpc'));
});

test('probe maps a wallet server answer, reverses the hash and closes the connection', async () => {
  const seen = {};
  const ticks = [100, 142.4];
  const result = await lib.probeEndpoint(endpoint, {
    grpc, clock: () => ticks.shift(),
    CompactTxStreamer: fakeStreamer({
      info: (done) => done(null, { chainName: 'main', vendor: 'Ztreamer', version: '0.1.0', zcashdSubversion: '/Zakura:1.8.9/' }),
      block: (done) => done(null, { height: '3591214', hash: wireHash() }),
    }, seen),
  });
  assert.deepEqual(result, {
    reachable: true, height: 3591214, hash: HASH, responseMs: 42,
    chainName: 'main', vendor: 'Ztreamer', version: '0.1.0', nodeSubversion: '/Zakura:1.8.9/',
  });
  assert.equal(seen.target, 'wallet.example:443');
  assert.equal(seen.credentials, 'tls');
  assert.ok(seen.deadline instanceof Date);
  assert.equal(seen.closed, 1);
});

test('probe bounds untrusted text and rejects malformed tips without leaking error text', async () => {
  const info = (done) => done(null, { chainName: 'main', vendor: `<b>\u0000Evil\n${'x'.repeat(200)}`, version: 7 });
  const ok = await lib.probeEndpoint(endpoint, { grpc, CompactTxStreamer: fakeStreamer({ info, block: (done) => done(null, { height: '10', hash: wireHash() }) }) });
  assert.equal(ok.vendor.length, 64);
  assert.ok(ok.vendor.startsWith('<b>Evil'));
  assert.ok(!/[\u0000\n]/.test(ok.vendor));
  assert.equal(ok.version, null);

  for (const block of [{ height: '10', hash: Buffer.alloc(31) }, { height: '-1', hash: wireHash() }, { height: '1e3', hash: wireHash() }, {}]) {
    const bad = await lib.probeEndpoint(endpoint, { grpc, CompactTxStreamer: fakeStreamer({ info, block: (done) => done(null, block) }) });
    assert.deepEqual(bad, { reachable: false, error: 'invalid_response' });
  }
  const cases = [[4, 'timeout'], [14, 'connection_failed'], [13, 'invalid_response']];
  for (const [code, error] of cases) {
    const seen = {};
    const failed = await lib.probeEndpoint(endpoint, { grpc, CompactTxStreamer: fakeStreamer({ info: (done) => done(Object.assign(new Error('secret 10.0.0.1'), { code })), block: () => {} }, seen) });
    assert.deepEqual(failed, { reachable: false, error });
    assert.equal(seen.closed, 1);
  }
});

const operators = [{ id: 'op', name: 'Op', operator: 'Op', operatorUrl: 'https://op.example', statusUrl: 'https://status.op.example', endpoints: [
  { id: 'tip', host: 'a.example', port: 443, scope: 'global', label: 'Global' },
  { id: 'fork', host: 'b.example', port: 443, scope: 'region', label: 'B' },
  { id: 'ahead', host: 'c.example', port: 443, scope: 'region', label: 'C' },
  { id: 'down', host: 'd.example', port: 443, scope: 'region', label: 'D' },
  { id: 'throws', host: 'e.example', port: 443, scope: 'region', label: 'E' },
] }];
const answers = {
  tip: { reachable: true, height: 100, hash: 'aa', responseMs: 5, chainName: 'main' },
  fork: { reachable: true, height: 98, hash: 'ff', responseMs: 6, chainName: 'main' },
  ahead: { reachable: true, height: 101, hash: 'bb', responseMs: 7, chainName: 'main' },
  down: { reachable: false, error: 'timeout' },
};

test('monitor compares each reported tip with the index and keeps unknown distinct from different', async () => {
  let asked = null;
  const monitor = lib.createWalletServerMonitor({
    network: 'mainnet', operators, now: () => Date.parse('2026-11-19T12:00:00Z'),
    probe: async (item) => { if (item.id === 'throws') throw new Error('boom'); return answers[item.id]; },
    readChain: async (heights) => { asked = heights; return { tip: 100, canonical: new Map([[100, 'aa'], [98, 'cc']]) }; },
  });
  const snapshot = await monitor.read();
  assert.deepEqual([...asked].sort(), [100, 101, 98]);
  assert.equal(snapshot.referenceHeight, 100);
  assert.equal(snapshot.checkedAt, '2026-11-19T12:00:00.000Z');
  const o = snapshot.observations;
  assert.deepEqual([o.tip.chain, o.tip.tipDelta], ['canonical', 0]);
  assert.deepEqual([o.fork.chain, o.fork.tipDelta], ['different', -2]);
  assert.deepEqual([o.ahead.chain, o.ahead.tipDelta], ['unknown', 1]);
  assert.deepEqual(o.down, { checkedAt: snapshot.checkedAt, reachable: false, error: 'timeout' });
  assert.deepEqual(o.throws, { checkedAt: snapshot.checkedAt, reachable: false, error: 'invalid_response' });
});

test('an unavailable index leaves chain agreement unknown instead of failing the check', async () => {
  const monitor = lib.createWalletServerMonitor({
    network: 'mainnet', operators: [{ ...operators[0], endpoints: [operators[0].endpoints[0]] }],
    probe: async () => answers.tip, readChain: async () => { throw new Error('db down'); },
  });
  const snapshot = await monitor.read();
  assert.equal(snapshot.referenceHeight, null);
  assert.deepEqual([snapshot.observations.tip.chain, snapshot.observations.tip.tipDelta], ['unknown', null]);
});

test('concurrent readers share one probe round and later readers never wait on a refresh', async () => {
  let rounds = 0;
  let clock = 1_000_000;
  let release = null;
  const single = [{ ...operators[0], endpoints: [operators[0].endpoints[0]] }];
  const monitor = lib.createWalletServerMonitor({
    network: 'mainnet', operators: single, now: () => clock, refreshMs: 60_000,
    probe: async () => { rounds++; if (release) await release; return answers.tip; },
    readChain: async () => ({ tip: 100, canonical: new Map([[100, 'aa']]) }),
  });
  const [a, b] = await Promise.all([monitor.read(), monitor.read()]);
  assert.equal(rounds, 1);
  assert.equal(a, b);
  clock += 59_000;
  assert.equal(await monitor.read(), a);
  assert.equal(rounds, 1);

  clock += 2_000;
  let open;
  release = new Promise((resolve) => { open = resolve; });
  const stale = await monitor.read();
  assert.equal(stale, a, 'the previous observation is served while a refresh runs');
  await monitor.read();
  assert.equal(rounds, 2, 'a running refresh is not duplicated');
  open();
  await release; await new Promise((resolve) => setImmediate(resolve));
  const next = await monitor.read();
  assert.notEqual(next, a);
  assert.equal(next.checkedAtMs, clock);

  // After an idle period longer than an observation's life, a reader waits
  // for the new round instead of receiving an expired one.
  release = null;
  clock += 5 * 60_000;
  const afterIdle = await monitor.read();
  assert.equal(rounds, 3);
  assert.equal(afterIdle.checkedAtMs, clock);
});

test('networks without registered servers are never probed', async () => {
  let probed = false;
  const monitor = lib.createWalletServerMonitor({ network: 'testnet', probe: async () => { probed = true; }, readChain: async () => ({}) });
  assert.equal(await monitor.read(), null);
  assert.equal(probed, false);
  const body = lib.publicSnapshot(null, 'testnet');
  assert.deepEqual([body.available, body.operators.length, body.expectedChainName], [false, 0, null]);
});

async function serve(t, router, locals = {}) {
  const app = express();
  Object.assign(app.locals, locals);
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/api/network/wallet-servers`;
}

test('route answers with the registry and an explicit unavailable state when probing cannot run', async (t) => {
  const url = await serve(t, createWalletServersRouter({ network: 'mainnet' }));
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, follow');
  const body = await response.json();
  assert.equal(body.available, false);
  assert.equal(body.checkedAt, null);
  assert.equal(body.reference.height, null);
  const fastz = body.operators.find((operator) => operator.id === 'fastz');
  assert.equal(fastz.endpoints.length, 12);
  assert.ok(fastz.endpoints.every((item) => item.latest === null));
});

test('route publishes observations and survives a failing monitor', async (t) => {
  const observed = {
    checkedAtMs: 1, checkedAt: '2026-11-19T12:00:00.000Z', referenceHeight: 3591214,
    observations: { 'fastz-rpc': { checkedAt: '2026-11-19T12:00:00.000Z', reachable: true, height: 3591214, hash: HASH, responseMs: 42, chain: 'canonical', tipDelta: 0, chainName: 'main', vendor: 'Ztreamer', version: '0.1.0', nodeSubversion: '/Zakura:1.8.9/' } },
  };
  const url = await serve(t, createWalletServersRouter({ network: 'mainnet', monitor: { read: async () => observed } }));
  const body = await (await fetch(url)).json();
  assert.deepEqual([body.available, body.checkedAt, body.reference.height], [true, observed.checkedAt, 3591214]);
  assert.deepEqual([body.refreshSeconds, body.staleAfterSeconds, body.lagThresholdBlocks, body.expectedChainName], [60, 300, 3, 'main']);
  const endpoints = body.operators.flatMap((operator) => operator.endpoints);
  assert.deepEqual(endpoints.find((item) => item.id === 'fastz-rpc').latest, observed.observations['fastz-rpc']);
  assert.equal(endpoints.find((item) => item.id === 'fastz-sa').latest, null);
  assert.deepEqual(endpoints.find((item) => item.id === 'fastz-sa').location, { lat: -23.55, lon: -46.63, approximate: false });
  assert.equal(endpoints.find((item) => item.id === 'fastz-rpc').location, null);
  assert.equal(endpoints.find((item) => item.id === 'fastz-eu').location, null);
  assert.deepEqual(endpoints.find((item) => item.id === 'zecrocks-eu').location, { lat: 41, lon: 20, approximate: true });
  assert.deepEqual(body.operators.map((operator) => operator.logo), ['/brands/wallet-servers/fastz.svg', null]);
  assert.equal(body.checkedAtMs, undefined);

  const failing = await serve(t, createWalletServersRouter({ network: 'mainnet', monitor: { read: async () => { throw new Error('boom'); } } }));
  const fallback = await (await fetch(failing)).json();
  assert.equal(fallback.available, false);

  const crosslink = await serve(t, createWalletServersRouter({ network: 'crosslink' }));
  const none = await (await fetch(crosslink)).json();
  assert.deepEqual([none.network, none.operators.length], ['crosslink-testnet', 0]);
  assert.throws(() => createWalletServersRouter({ network: 'regtest' }));
});

test('readChain uses a parameterized height list and returns exact canonical hashes', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push([sql, params]);
    return sql.includes('MAX') ? { rows: [{ height: '3591214' }] } : { rows: [{ height: '3591214', hash: HASH.toUpperCase() }] };
  } };
  const chain = await lib.readChain(pool, [3591214]);
  assert.equal(chain.tip, 3591214);
  assert.equal(chain.canonical.get(3591214), HASH);
  assert.deepEqual(queries[1][1], [[3591214]]);
  assert.ok(!queries[1][0].includes('3591214'));
  const empty = await lib.readChain({ query: async () => ({ rows: [{ height: null }] }) }, []);
  assert.deepEqual([empty.tip, empty.canonical.size], [null, 0]);
});
