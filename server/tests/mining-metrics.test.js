const test = require('node:test');
const assert = require('node:assert/strict');
const { registerNetworkAnalyticsRoutes } = require('../api/routes/network-analytics');

const blocks = (length = 200) => Array.from({ length }, (_, i) => ({
  height: 1000 - i, timestamp: 1800000000 - i * 75,
  difficulty: 100, transaction_count: 5, total_fees: 100000,
}));

async function metrics(rows, query = {}) {
  const routes = new Map();
  registerNetworkAnalyticsRoutes({ get: (path, handler) => routes.set(path, handler) });
  let body, fetched;
  const req = { query, app: { locals: { pool: { async query(_sql, [limit]) {
    fetched = limit;
    return { rows: rows.slice(0, limit) };
  } } } } };
  const res = { json(value) { body = value; }, status() { assert.fail('Request must succeed'); } };
  await routes.get('/api/network/mining-metrics')(req, res);
  return { body, fetched };
}

test('all displayed mining points have complete averages using offscreen predecessors', async () => {
  for (const window of [5, 20, 100]) {
    const { body, fetched } = await metrics(blocks(700), { window, limit: 120 });
    assert.equal(fetched, 120 + window);
    assert.equal(body.points.length, 120);
    assert.equal(body.points[0].height, 881);
    assert.equal(body.points.at(-1).height, 1000);
    for (const p of body.points) {
      assert.equal(p.blockTime, 75);
      assert.ok(Math.abs(p.solrate - 100 * 8192 / 75) < 1e-8);
      assert.equal(p.difficulty, 100);
      assert.equal(p.txCount, 5);
      assert.ok(Math.abs(p.txFees - 0.001) < 1e-12);
    }
  }
});

test('missing heights preserve timing gaps and recover once the gap leaves the window', async () => {
  const rows = blocks().filter(b => b.height !== 950);
  const { body } = await metrics(rows);
  for (const p of body.points.filter(p => p.height >= 951 && p.height <= 970)) {
    assert.equal(p.solrate, null);
    assert.equal(p.blockTime, null);
  }
  assert.equal(body.points.find(p => p.height === 971).blockTime, 75);
});

test('nonpositive timestamp deltas remain unavailable for solrate, never filled with zero', async () => {
  for (const delta of [0, -5]) {
    const rows = blocks();
    rows[0].timestamp = rows[1].timestamp + delta;
    const { body } = await metrics(rows);
    assert.equal(body.latest.solrate, null);
    assert.equal(body.points.at(-1).solrate, null);
    assert.equal(body.latest.blockTime, (19 * 75 + delta) / 20);
  }
});

test('insufficient history and empty data do not invent full-window averages', async () => {
  for (const rows of [[], blocks(4)]) {
    const { body } = await metrics(rows);
    for (const value of Object.values(body.latest)) assert.equal(value, null);
    for (const p of body.points) assert.equal(p.difficulty, null);
  }
  const { body } = await metrics(blocks(21));
  assert.equal(body.latest.blockTime, 75);
  assert.equal(body.points[0].blockTime, null);
});
