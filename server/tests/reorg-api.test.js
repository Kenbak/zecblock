const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

async function request(router, pool, path) {
  const app = express();
  app.locals.pool = pool;
  app.use(router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, data: await res.json() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('reorg sides expose independent observations; header/detection times are never fallbacks', async () => {
  const router = require('../api/routes/reorgs');
  const row = { id: 1, height: 100, hash: 'a'.repeat(64), canonical_block_hash: 'b'.repeat(64),
    timestamp: 1700000000, canonical_timestamp: 1700000001, detected_at: '2026-09-23T11:00:00Z',
    first_seen_at: '2026-09-23T10:59:58.123Z', canonical_first_seen_at: '2026-09-23T10:59:59.456Z',
    observation_source: 'local-node-rpc', poll_interval_ms: 1000 };
  const pool = { async query(sql) { return { rows: sql.includes('COUNT(*)') ? [{ total: '1' }] : [row] }; } };
  let result = await request(router, pool, '/api/uncles');
  assert.equal(result.status, 200);
  assert.equal(result.data.orphanedBlocks[0].firstSeenAt, row.first_seen_at);
  assert.equal(result.data.orphanedBlocks[0].canonicalBlock.firstSeenAt, row.canonical_first_seen_at);
  delete row.first_seen_at;
  delete row.canonical_first_seen_at;
  result = await request(router, pool, '/api/uncles');
  assert.equal(result.data.orphanedBlocks[0].firstSeenAt, null);
  assert.equal(result.data.orphanedBlocks[0].canonicalBlock.firstSeenAt, null);
  delete row.canonical_block_hash;
  row.canonical_hash = 'c'.repeat(64);
  result = await request(router, pool, '/api/uncles');
  assert.equal(result.data.orphanedBlocks[0].canonicalBlock, null);
});

test('observer-only orphans: list excludes reorg archives, stats stay available without capture tables', async () => {
  const router = require('../api/routes/reorgs');
  const row = { height: '200', hash: 'd'.repeat(64), timestamp: '1700000100', first_seen_at: '2026-11-06T04:25:46Z',
    observer_count: 10, miner_address: null, coinbase_hex: null, canonical_block_hash: 'e'.repeat(64),
    canonical_timestamp: '1700000099', canonical_first_seen_at: '2026-11-06T04:25:45Z' };
  const seen = [];
  const pool = { async query(sql) {
    seen.push(sql);
    return { rows: /count\(\*\) AS total/.test(sql) ? [{ total: '1' }] : [row] };
  } };
  const result = await request(router, pool, '/api/uncles/observed?limit=10');
  assert.equal(result.status, 200);
  const [item] = result.data.orphanedBlocks;
  assert.deepEqual([item.height, item.hash, item.observerCount, item.canonicalBlock.hash, item.canonicalBlock.firstSeenAt],
    [200, row.hash, 10, row.canonical_block_hash, row.canonical_first_seen_at]);
  assert.equal(result.data.pagination.total, 1);
  for (const sql of seen) {
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM orphaned_blocks ob WHERE ob\.hash = c\.hash\)/, 'never duplicates /uncles');
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM blocks canonical WHERE canonical\.hash = c\.hash\)/, 'never a canonical hash');
  }
  assert.equal((await request(router, pool, '/api/uncles/observed?offset=50001')).status, 400);
  const failing = { async query() { throw new Error('boom'); } };
  assert.equal((await request(router, failing, '/api/uncles/observed')).status, 503);

  const statsPool = { async query(sql) {
    if (sql.includes('captured_blocks')) throw new Error('relation "captured_blocks" does not exist');
    return { rows: [{ total: '5', max_depth: '2' }] };
  } };
  const stats = await request(router, statsPool, '/api/uncles/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.data.totalOrphanedBlocks, 5);
  assert.equal(stats.data.observerOnlyOrphanedBlocks, null);
  const okStats = await request(router, { async query(sql) {
    return { rows: [sql.includes('captured_blocks') ? { total: '61', capture_start: '1760263882' } : { total: '5', max_depth: '2' }] };
  } }, '/api/uncles/stats');
  assert.equal(okStats.data.observerOnlyOrphanedBlocks, 61);
  assert.equal(okStats.data.observerCaptureStartedAt, '2025-10-12T10:11:22.000Z');
});
