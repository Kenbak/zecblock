const test = require('node:test');
const assert = require('node:assert/strict');
const { registerNetworkAnalyticsRoutes } = require('../api/routes/network-analytics');
const { observedBlockCadence, subsidyZat, CADENCE_WINDOW_BLOCKS } = require('../api/lib/network-issuance');
const { supplyProjection } = require('../api/lib/issuance-projection');

function blocks(spacing = 75, height = 3_500_000) {
  return Array.from({ length: CADENCE_WINDOW_BLOCKS + 1 }, (_, index) => ({ height: height - index, timestamp: 1_800_000_000 - index * spacing }));
}

// Evaluates the cadence aggregate the way PostgreSQL would over `rows`.
function cadenceQuery(rows, [currentHeight, window]) {
  const eligible = rows.filter(row => row.height <= currentHeight);
  if (!eligible.length) return { rows: [{ end_height: null, block_count: '0', end_timestamp: null, start_timestamp: null }] };
  const tip = Math.max(...eligible.map(row => row.height));
  const inWindow = rows.filter(row => row.height >= tip - window && row.height <= tip);
  const at = height => inWindow.find(row => row.height === height)?.timestamp ?? null;
  return { rows: [{ end_height: String(tip), block_count: String(inWindow.length), end_timestamp: at(tip) === null ? null : String(at(tip)), start_timestamp: at(tip - window) === null ? null : String(at(tip - window)) }] };
}

async function request(path, { snapshots = null, trends = [], archive = null, archiveCanonical = true, blockRows = blocks(), subsidy = 1.5625, redisClient = null, rpc } = {}) {
  const routes = new Map();
  registerNetworkAnalyticsRoutes({ get: (path, handler) => routes.set(path, handler) });
  const pool = { async query(sql, params) {
    if (sql.includes('information_schema.tables')) return { rows: (params[0] === 'chain_supply_daily' ? archive === null : snapshots === null) ? [] : [{}] };
    if (sql.includes('FROM chain_supply_archive_state')) return { rows: [{ verified_height: '3500000', verified_hash: 'a'.repeat(64) }] };
    if (sql.includes('FROM chain_supply_daily')) return { rows: archive };
    if (sql.includes('FROM chain_snapshots')) return { rows: snapshots };
    if (sql.includes('FROM privacy_trends_daily')) return { rows: trends };
    if (sql.includes('WITH tip AS (SELECT max(height) AS h FROM blocks')) return cadenceQuery(blockRows, params);
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const callZebraRPC = rpc || (async (method, params) => {
    if (method === 'getblockhash') return (archiveCanonical ? 'a' : 'b').repeat(64);
    if (method === 'getblockcount') return 3_500_000;
    if (method === 'getblockchaininfo') return { chain: 'main', blocks: 3_500_000, upgrades: { b: { name: 'Blossom', activationheight: 653600 } } };
    assert.equal(method, 'getblocksubsidy');
    assert.equal(params[0], 3_500_000, 'subsidy is pinned to the observed node height');
    return { totalblocksubsidy: subsidy };
  });
  let body;
  let status = 200;
  const res = { json(value) { body = value; return this; }, status(value) { status = value; return this; } };
  await routes.get(path)({ query: {}, app: { locals: { pool, callZebraRPC, redisClient } } }, res);
  return { status, body };
}

const daily = (date, chain_supply) => ({ date, chain_supply });

test('emission preserves supply decreases, zero change, and exact single-zatoshi movements', async () => {
  const { status, body } = await request('/api/network/emission', { trends: [
    daily('2026-09-01', '1700000000000000'),
    daily('2026-09-02', '1699999999999999'),
    daily('2026-09-03', '1699999999999999'),
    daily('2026-09-04', '1700000000000000'),
  ] });
  assert.equal(status, 200);
  assert.equal(body.supplyHistory[1].circulatingZat, 1699999999999999);
  assert.ok(body.supplyHistory[1].circulating < body.supplyHistory[0].circulating);
  assert.deepEqual(body.dailyEmission.map(p => p.emissionZat), [-1, 0, 1]);
  assert.deepEqual(body.dailyEmission.map(p => p.emission), [-0.00000001, 0, 0.00000001]);
  assert.equal(body.dailyEmissionMeaning, 'net-chain-supply-change');
  assert.equal(body.supplyHistoryTable, 'privacy_trends_daily');
});

test('snapshots remain authoritative observations without fabricated days or monotonic smoothing', async () => {
  const { body } = await request('/api/network/emission', { snapshots: [
    { snapshot_time: '2026-09-01T00:00:00Z', chain_supply_zat: '1700000000000000', block_height: '3500000' },
    { snapshot_time: '2026-09-04T00:00:00Z', chain_supply_zat: '1699999999999999', block_height: '3500001' },
  ], trends: [daily('2026-09-01', '100'), daily('2026-09-04', '400')] });
  assert.equal(body.supplyHistory.length, 2);
  assert.equal(body.supplyHistoryTable, 'chain_snapshots');
  assert.equal(body.circulatingZat, 1699999999999999);
  assert.equal(body.supplyObservedAt, '2026-09-04T00:00:00Z');
  assert.equal(body.dailyEmission[0].emission, null, 'three-day changes are not called daily issuance');
});

test('missing and invalid supply is unavailable, never silently zero or carried forward', async () => {
  for (const invalid of [null, undefined, '', 0, '0', '123oops', '-1', '1.5', '2100000000000001', Number.MAX_SAFE_INTEGER + 1]) {
    const { body } = await request('/api/network/emission', { trends: [
      daily('2026-09-01', '100'), daily('2026-09-02', invalid), daily('2026-09-03', '105'), daily('2026-09-04', invalid),
    ] });
    assert.equal(body.supplyHistory[1].circulating, null);
    assert.equal(body.circulating, null);
    assert.equal(body.remaining, null);
    assert.equal(body.circulatingPct, null);
    assert.ok(body.dailyEmission.every(point => point.emission === null));
  }
  const { body } = await request('/api/network/emission');
  assert.equal(body.circulating, null);
  assert.equal(body.supplyHistorySource, 'none');
});

test('daily issuance is scheduled subsidy per target day, not an extrapolated cadence sample', async () => {
  for (const spacing of [75, 25, 40]) {
    const { body } = await request('/api/network/emission', { blockRows: blocks(spacing) });
    // The mock node has no NU7 activation, so target spacing stays 75 seconds.
    assert.equal(body.dailyEmissionEstimate, 1.5625 * 86400 / 75);
    assert.equal(body.dailyEmissionBasis, 'current-subsidy-at-target-spacing');
    assert.equal(body.targetSpacingSeconds, 75);
    assert.equal(body.cadence.intervalSeconds, spacing);
    assert.equal(body.cadence.intervals, CADENCE_WINDOW_BLOCKS);
    assert.equal(body.cadence.source, 'indexed-block-timestamps');
  }
});

test('incomplete, lagging, or unusable cadence is unavailable without hiding scheduled issuance', async () => {
  for (const rows of [[], blocks().slice(0, 1), blocks(75, 3_499_987), blocks().filter((_, i) => i !== 30), blocks(0), blocks(-25)]) {
    const { body } = await request('/api/network/emission', { blockRows: rows });
    assert.equal(body.cadence, null);
    assert.equal(body.dailyEmissionEstimate, 1800);
  }
  const rows = blocks();
  rows[50].timestamp = rows[49].timestamp + 1; // Interior timestamps need not be monotonic.
  const cadence = await observedBlockCadence({ query: async (sql, params) => cadenceQuery(rows, params) }, 3_500_000);
  assert.equal(cadence.intervalSeconds, 75);
});

test('subsidy failures do not hide supply observations or invent daily issuance', async () => {
  for (const subsidy of [null, NaN, -1, 0.000000001]) {
    const { body } = await request('/api/network/emission', { subsidy, trends: [daily('2026-09-01', '100')] });
    assert.equal(body.circulatingZat, 100);
    assert.equal(body.dailyEmissionEstimate, null);
  }
  const { body } = await request('/api/network/emission', { rpc: async method => method === 'getblockcount' ? 3_500_000 : method === 'getblockchaininfo' ? null : { totalblocksubsidy: 1.5625 } });
  assert.equal(body.dailyEmissionEstimate, null, 'no node schedule means no target spacing');
  assert.equal(subsidyZat(0), 0);
  assert.equal(subsidyZat(0.52083333), 52083333);
});

test('halving route ignores legacy cached countdowns and fails closed on unsupported schedules', async () => {
  const keys = [];
  const { body } = await request('/api/network/halving', {
    rpc: async (method, params) => method === 'getblockchaininfo' ? { chain: 'unknown', blocks: 3500000, upgrades: { b: { name: 'Blossom', activationheight: 653600 } } } : ({
      totalblocksubsidy: params[0] < 3_600_000 ? 1.5625 : 0.52083333,
    }),
    redisClient: { isOpen: true, async get(key) {
      keys.push(key);
      return key === 'zcash:halving_info' ? JSON.stringify({ halvingBlock: 3_600_000 }) : null;
    }, async setEx() { assert.fail('unavailable countdown must not be cached'); } },
  });
  assert.deepEqual(keys, ['zcash:halving_info:v4']);
  assert.equal(body.halvingStatus, 'unavailable');
  assert.equal(body.estimatedSeconds, null);
  assert.equal(body.estimatedDate, null);
  assert.equal(body.currentSubsidy, 1.5625);
});

const nu7Rpc = async (method, params) => {
  if (method === 'getblockcount') return 3_589_445;
  if (method === 'getblockhash') return 'a'.repeat(64);
  if (method === 'getblockchaininfo') return { chain: 'main', blocks: 3_589_445, upgrades: { b: { name: 'Blossom', activationheight: 653600 }, n: { name: 'NU7', activationheight: 3_543_405 } } };
  return { totalblocksubsidy: params[0] < 3_543_405 ? 1.5625 : params[0] < 6_132_390 ? 0.52083333 : 0.26041666 };
};

async function at(time, fn) {
  const now = Date.now;
  Date.now = () => time;
  try { return await fn(); } finally { Date.now = now; }
}

test('halving date follows consensus target spacing, ignores cadence samples and caches for five minutes', async () => {
  const time = Date.parse('2026-11-19T11:00:00Z');
  for (const spacing of [17, 25, 43]) {
    const stored = [];
    const { body } = await at(time, () => request('/api/network/halving', {
      blockRows: blocks(spacing, 3_589_445), rpc: nu7Rpc,
      redisClient: { isOpen: true, async get() { return null; }, async setEx(...args) { stored.push(args); } },
    }));
    assert.equal(body.halvingBlock, 6_132_390);
    assert.equal(body.blocksRemaining, 2_542_945);
    assert.equal(body.estimatedSeconds, 2_542_945 * 25);
    assert.equal(body.estimatedSeconds, body.targetSecondsRemaining);
    assert.equal(body.estimatedDate, new Date(time + 63_573_625_000).toISOString());
    assert.equal(body.estimatedDate.slice(0, 10), '2028-11-24');
    assert.equal(body.dateBasis, 'consensus-target-spacing');
    assert.equal(stored[0][1], 300);
  }
});

test('the halving card and the projection marker give the same date for the same tip and time', async () => {
  const time = Date.parse('2026-11-19T11:00:00Z');
  const snapshots = [{ snapshot_time: '2026-11-19T10:00:00Z', chain_supply_zat: '1650000000000000', block_height: '3589300' }];
  const halving = await at(time, () => request('/api/network/halving', { rpc: nu7Rpc, blockRows: blocks(21, 3_589_445) }));
  const emission = await at(time, () => request('/api/network/emission', { rpc: nu7Rpc, snapshots, blockRows: blocks(29, 3_589_445) }));
  const marker = emission.body.projection.points.find(point => point.halving != null);
  assert.equal(marker.height, halving.body.halvingBlock);
  assert.equal(marker.date, halving.body.estimatedDate);
  assert.equal(emission.body.projection.dateBasis, 'consensus-target-spacing');
  assert.equal(emission.body.projection.points[0].date, '2026-11-19T10:00:00.000Z', 'the projection starts at the supply observation');
  assert.equal(emission.body.dailyEmissionEstimate, 0.52083333 * 3456);
  assert.equal(emission.body.targetSpacingSeconds, 25);
});

test('brief polling lag uses the complete indexed cadence window and discloses its height lag', async () => {
 const { body } = await request('/api/network/emission', { blockRows: blocks(75, 3_499_995) });
 assert.equal(body.cadence.intervalSeconds,75);
 assert.equal(body.cadence.endHeight,3499995);
 assert.equal(body.cadence.lagBlocks,5);
});


test('permanent canonical history fills earlier dates and snapshot gaps without changing today', async () => {
  const { body } = await request('/api/network/emission', {
    archive: [
      { date: '2016-10-28', block_height: '0', chain_supply_zat: '0' },
      { date: '2026-09-02', block_height: '3499998', chain_supply_zat: '1699999999999999' },
      { date: '2026-09-03', block_height: '3499999', chain_supply_zat: '1699999999999999' },
    ], snapshots: [
      { snapshot_time: '2026-09-01T23:00:00Z', block_height: '3499997', chain_supply_zat: '1700000000000000' },
      { snapshot_time: '2026-09-04T10:00:00Z', block_height: '3500000', chain_supply_zat: '1700000000000001' },
    ],
  });
  assert.equal(body.supplyHistory[0].circulating, 0);
  assert.equal(body.supplyHistory.length, 5);
  assert.equal(body.supplyHistory[2].height, 3499998);
  assert.equal(body.circulatingZat, 1700000000000001);
  assert.equal(body.supplyObservedAt, '2026-09-04T10:00:00Z');
  assert.equal(body.supplyHistoryTable, 'chain_supply_daily+chain_snapshots');
});


test('a changed node ancestry checkpoint excludes the archive instead of showing orphan supply', async () => {
  const { body } = await request('/api/network/emission', {
    archiveCanonical: false,
    archive: [{ date: '2016-10-28', block_height: '0', chain_supply_zat: '0' }],
    snapshots: [{ snapshot_time: '2026-09-04T10:00:00Z', block_height: '3500000', chain_supply_zat: '1700000000000001' }],
  });
  assert.equal(body.supplyHistory.length, 1);
  assert.equal(body.supplyHistoryTable, 'chain_snapshots');
});
