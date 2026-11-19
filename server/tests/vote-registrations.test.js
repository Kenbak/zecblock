const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, URL, setTimeout, clearTimeout, require: name => dependencies[name] ?? require(name) });
  return exports;
}
const lib = load('lib/vote-registrations.ts');
const NU7 = '16eef7ebc77e0e04fb1c7329abfcc390f4a0c002964671ebb360914a3e5a3f11';
const Q3 = '2cba66eb16c7581a1692cb0b033785da0131059f645a0d2fb4dc2a5131505e01';

// Response bodies as returned by zvote-1 REST gateways on 2026-11-18.
const range = pages => ({ status: 500, body: { code: 13, message: `failed to search for txs: page should be within [1, ${pages}] range, given 9999999`, details: [] } });
const parseError = { status: 500, body: { code: 13, message: 'invalid length; proto: invalid field number: tx parse error', details: [] } };
const empty = { status: 200, body: { txs: [], tx_responses: [], pagination: null, total: '0' } };
const tree = leaves => ({ status: 200, body: { tree: { next_index: leaves, root: 'ICc2UagLOMUUZA+VNMR3w3GiuSka58wQ5VoAagjE+z0=', height: 7030162, next_index_at_root: leaves } } });

/** A node answering from fixed per-event totals, recording every path requested. */
function node({ leaves, counts, firstRow = {} }) {
  const paths = [];
  const probe = async path => {
    paths.push(path);
    if (path.startsWith('/shielded-vote/v1/commitment-tree/')) return typeof leaves === 'object' ? leaves : tree(leaves);
    const event = /query=([a-z_]+)\.vote_round_id/.exec(decodeURIComponent(path))[1];
    if (path.includes('pagination.limit=1')) return firstRow[event] ?? (counts[event] === 0 ? empty : parseError);
    return typeof counts[event] === 'object' ? counts[event] : range(Math.max(1, counts[event]));
  };
  return { probe, paths };
}

test('page-range errors give exact counts; one page is zero or one; anything else is rejected', () => {
  assert.deepEqual({ ...lib.parseEventCount(range(1429)) }, { lo: 1429, hi: 1429 });
  assert.deepEqual({ ...lib.parseEventCount(range(1)) }, { lo: 0, hi: 1 });
  for (const response of [
    parseError, empty, { status: 200, body: range(5).body }, { status: 500, body: null }, { status: 500, body: { message: 7 } },
    { status: 500, body: { message: 'failed to search for txs: page should be within [1, 0] range, given 9999999' } },
    { status: 500, body: { message: 'failed to search for txs: page should be within [1, 12] range, given 2' } },
    { status: 500, body: { message: 'x failed to search for txs: page should be within [1, 12] range, given 9999999' } },
    { status: 500, body: { message: 'failed to search for txs: page should be within [1, 99999999999] range, given 9999999' } },
  ]) assert.equal(lib.parseEventCount(response), null);
  assert.equal(lib.parseZeroOrOne(empty), 0);
  assert.equal(lib.parseZeroOrOne(parseError), 1);
  assert.equal(lib.parseZeroOrOne({ status: 200, body: { total: '1' } }), 1);
  for (const response of [range(1), { status: 200, body: { total: '2' } }, { status: 200, body: {} }, { status: 503, body: { message: 'tx parse error' } }]) assert.equal(lib.parseZeroOrOne(response), null);
  assert.equal(lib.parseTreeLeaves(tree(14783)), 14783);
  assert.equal(lib.parseTreeLeaves(tree('14783')), 14783);
  assert.equal(lib.parseTreeLeaves({ status: 200, body: { tree: { root: 'AA==' } } }), 0);
  for (const response of [{ status: 200, body: {} }, { status: 404, body: tree(1).body }, tree(-1), tree(1.5), tree('1e3')]) assert.equal(lib.parseTreeLeaves(response), null);
});

test('NU7 and Q3 totals observed on the chain establish 1,429 and 901 registrations', async () => {
  const nu7 = node({ leaves: 14783, counts: { delegate_vote: 1429, delegate_and_cast_vote_batch: 0, cast_vote: 6677, cast_vote_batch: 0 } });
  assert.equal(await lib.readLiveRegistrations(NU7, 5, nu7.probe, false), 1429);
  // Tree, four counts, then one zero-or-one check for the empty combined-delegation event only.
  assert.equal(nu7.paths.length, 6);
  assert.equal(nu7.paths.filter(p => p.includes('pagination.limit=1')).length, 1);
  assert.ok(nu7.paths.every(p => p.startsWith('/cosmos/tx/v1beta1/txs?query=') || p === `/shielded-vote/v1/commitment-tree/${NU7}/latest`));
  assert.ok(nu7.paths.some(p => p.includes(encodeURIComponent(`delegate_vote.vote_round_id='${NU7}'`)) && p.endsWith('&page=9999999&limit=1')));
  const q3 = node({ leaves: 36236, counts: { delegate_vote: 90, delegate_and_cast_vote_batch: 811, cast_vote: 2736, cast_vote_batch: 1 } });
  assert.equal(await lib.readLiveRegistrations(Q3, 37, q3.probe, false), 901);
  assert.equal(q3.paths.length, 5);
});

test('a single standalone or combined delegation is settled exactly', async () => {
  const one = node({ leaves: 1, counts: { delegate_vote: 1, delegate_and_cast_vote_batch: 0, cast_vote: 0, cast_vote_batch: 0 } });
  assert.equal(await lib.readLiveRegistrations(NU7, 5, one.probe, true), 1);
  const none = node({ leaves: 0, counts: { delegate_vote: 0, delegate_and_cast_vote_batch: 0, cast_vote: 0, cast_vote_batch: 0 } });
  assert.equal(await lib.readLiveRegistrations(NU7, 5, none.probe, true), 0);
  const unsettled = node({ leaves: 1, counts: { delegate_vote: 1, delegate_and_cast_vote_batch: 0, cast_vote: 0, cast_vote_batch: 0 }, firstRow: { delegate_vote: { status: 502, body: {} } } });
  assert.equal(await lib.readLiveRegistrations(NU7, 5, unsettled.probe, true), null);
});

test('counts that do not fit the commitment tree are withheld', async () => {
  const counts = { delegate_vote: 1429, delegate_and_cast_vote_batch: 0, cast_vote: 6677, cast_vote_batch: 0 };
  // Pruned or disabled transaction index: several operators returned an empty range for NU7.
  const pruned = node({ leaves: 14783, counts: { delegate_vote: 0, delegate_and_cast_vote_batch: 0, cast_vote: 0, cast_vote_batch: 0 } });
  assert.equal(await lib.readLiveRegistrations(NU7, 5, pruned.probe, false), null);
  const partial = node({ leaves: 14783, counts: { ...counts, delegate_vote: 700 } });
  assert.equal(await lib.readLiveRegistrations(NU7, 5, partial.probe, false), null);
  const extra = node({ leaves: 14783, counts: { ...counts, delegate_vote: 1430 } });
  assert.equal(await lib.readLiveRegistrations(NU7, 5, extra.probe, false), null);
  const q3Low = node({ leaves: 36236, counts: { delegate_vote: 90, delegate_and_cast_vote_batch: 400, cast_vote: 2736, cast_vote_batch: 1 } });
  assert.equal(await lib.readLiveRegistrations(Q3, 37, q3Low.probe, false), null);
});

test('an open round tolerates submissions arriving between reads, but only a few', async () => {
  const counts = { delegate_vote: 2, delegate_and_cast_vote_batch: 494, cast_vote: 10, cast_vote_batch: 0 };
  // 2 delegations + 10 cast votes = 22 leaves; 494 combined batches add 2 to 6 each,
  // and the unsettled cast-vote batch count (zero or one) widens the top by 6.
  const [low, high, slack] = [22 + 2 * 494, 22 + 6 * 495, 4 * 6];
  for (const leaves of [low - slack, low, high, high + slack]) assert.equal(await lib.readLiveRegistrations(NU7, 5, node({ leaves, counts }).probe, true), 496);
  for (const leaves of [low - slack - 1, high + slack + 1]) assert.equal(await lib.readLiveRegistrations(NU7, 5, node({ leaves, counts }).probe, true), null);
  // A closed round gets no allowance.
  assert.equal(await lib.readLiveRegistrations(NU7, 5, node({ leaves: high, counts }).probe, false), 496);
  assert.equal(await lib.readLiveRegistrations(NU7, 5, node({ leaves: high + 1, counts }).probe, false), null);
  assert.equal(await lib.readLiveRegistrations(NU7, 5, node({ leaves: low - 1, counts }).probe, false), null);
});

test('unrecognized responses, bad identifiers and transport failures give no figure', async () => {
  const counts = { delegate_vote: 1429, delegate_and_cast_vote_batch: 0, cast_vote: 6677, cast_vote_batch: 0 };
  for (const broken of [
    node({ leaves: { status: 500, body: {} }, counts }),
    node({ leaves: 14783, counts: { ...counts, cast_vote: { status: 200, body: { total: '6677' } } } }),
    node({ leaves: 14783, counts: { ...counts, delegate_vote: { status: 500, body: { message: 'rate limited' } } } }),
  ]) assert.equal(await lib.readLiveRegistrations(NU7, 5, broken.probe, false), null);
  const untouched = node({ leaves: 0, counts });
  for (const id of ['', NU7.toUpperCase(), `${NU7}'`, "x' OR '1'='1", NU7.slice(1)]) assert.equal(await lib.readLiveRegistrations(id, 5, untouched.probe, false), null);
  for (const proposals of [0, -1, 1.5, NaN]) assert.equal(await lib.readLiveRegistrations(NU7, proposals, untouched.probe, false), null);
  assert.equal(untouched.paths.length, 0);
  await assert.rejects(lib.readLiveRegistrations(NU7, 5, async () => { throw new Error('offline'); }, false), /offline/);
});

test('the cached reader returns null on failure and reads error bodies within a byte bound', async () => {
  const requests = [];
  const bodies = [];
  const responses = { fail: false };
  const data = load('lib/vote-registrations-data.ts', {
    'next/cache': { unstable_cache: (fn, key, options) => { assert.equal(options.revalidate, 300); assert.ok(key.includes(NU7)); return fn; } },
    './governance': { GOVERNANCE_API: 'https://vote.example/shielded-vote/v1' },
    './vote-registrations': lib,
    './bounded-json': { readBoundedJson: async (response, maxBytes) => { bodies.push(maxBytes); return response.json(); } },
    './server-fetch': { fetchWithDeadline: async (url, init, budget) => {
      requests.push(url);
      assert.equal(init.cache, 'no-store');
      assert.equal(budget, 4000);
      if (responses.fail) throw new Error('offline');
      const path = url.slice('https://vote.example'.length);
      const { status, body } = await node({ leaves: 14783, counts: { delegate_vote: 1429, delegate_and_cast_vote_batch: 0, cast_vote: 6677, cast_vote_batch: 0 } }).probe(path);
      return new Response(JSON.stringify(body), { status });
    } },
  });
  assert.equal(await data.getLiveRegistrations(NU7, 5, false), 1429);
  assert.ok(requests.every(url => url.startsWith('https://vote.example/')));
  assert.ok(bodies.every(limit => limit === 16 * 1024));
  responses.fail = true;
  assert.equal(await data.getLiveRegistrations(NU7, 5, false), null);
});
