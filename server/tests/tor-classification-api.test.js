'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_SOURCE = 'crawl';
const router = require('../api/routes/network');
const { TOR_CLASSIFICATION_KEY } = require('../lib/tor-classification');

test('cached census stats fail closed for Tor without losing other measurements', async () => {
  const now = Date.now();
  const snapshotTime = now - 500;
  const sourceTime = now - 1500;
  const cached = { success: true, stats: { activeNodes: 445, torNodes: 0,
    lastUpdated: new Date(sourceTime).toISOString(), censusSnapshotTime: new Date(snapshotTime).toISOString() } };
  let status = null;
  let latest = new Date(snapshotTime);
  let redisError = false;
  let dbError = false;
  let cacheHits = 0;
  const req = { app: { locals: {
    pool: { async query() { if (dbError) throw Error('DB unavailable'); return { rows: [{ snapshot_time: latest }] }; } },
    listCache: { async getOrLoad() { cacheHits++; return { value: cached, state: 'HIT', cacheDurationMs: 0, totalDurationMs: 0, loadTimings: [] }; } },
    redisClient: { isOpen: true, async get(key) { assert.equal(key, TOR_CLASSIFICATION_KEY); if (redisError) throw Error('Redis unavailable'); return status && JSON.stringify(status); } },
  } }, query: {} };
  router.stack[0].handle(req, {}, () => {});
  const route = router.stack.find(l => l.route?.path === '/api/network/nodes/stats').route.stack[0];
  async function request() {
    let body;
    const headers = {};
    let code = 200;
    await route.handle(req, { set(k,v) { headers[k] = v; }, status(c) { code = c; return this; }, json(v) { body = v; } });
    assert.equal(code, 200);
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(body.stats.activeNodes, 445);
    assert.equal('censusSnapshotTime' in body.stats, false);
    return body.stats;
  }
  assert.equal((await request()).torNodes, null, 'missing status cannot turn old cached zero into current evidence');
  status = { version: 1, available: true, checkedAtMs: now-1000, sourceObservedAtMs: sourceTime,
    committedAtMs: now-100, snapshotTimeMs: snapshotTime, classifiedTorNodes: 0 };
  let stats = await request();
  assert.equal(stats.torNodes, 0);
  assert.equal(stats.torClassificationAvailable, true, 'valid provider can measure zero');
  status = { ...status, available: false, classifiedTorNodes: null };
  stats = await request();
  assert.equal(stats.torNodes, null);
  assert.equal(stats.torClassificationAvailable, false, 'failed provider masks previously cached numeric result immediately');
  status = { ...status, available: true, classifiedTorNodes: 4 };
  assert.equal((await request()).torNodes, 4);
  redisError = true;
  assert.equal((await request()).torNodes, null);
  redisError = false;
  latest = new Date(snapshotTime + 100);
  assert.equal((await request()).torNodes, null, 'old Redis status cannot attest a newer commit with the same source clock');
  latest = new Date(snapshotTime);
  dbError = true;
  assert.equal((await request()).torNodes, null, 'commit-guard lookup failure preserves cached non-Tor stats');
  dbError = false;
  status = { ...status, checkedAtMs: now-601000, sourceObservedAtMs: now-602000 };
  assert.equal((await request()).torNodes, null);
  assert.equal(cached.stats.torNodes, 0, 'per-request overlay never mutates the aggregate cache');
  assert.equal(cacheHits, 8);
});

test('classification publication requires the production writer and a completed commit', async () => {
  const modulePath = require.resolve('../jobs/ingest-crawl');
  const originalArgs = [...process.argv];
  const originalSource = process.env.NODE_SOURCE;
  let published = 0;
  let committed = false;
  let failCommit = false;
  let lock = true;
  const stamp = Date.now() - 2000;
  const db = {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: lock }] };
      if (sql === 'BEGIN') committed = false;
      if (sql === 'COMMIT') { if (failCommit) throw Error('commit failed'); committed = true; }
      if (sql.includes('COUNT(*) FILTER (WHERE is_active) AS active')) return { rows: [{ active: '1', total: '1', countries: '1', tor: '0', inbound:'0',outbound:'1',tor_hidden:'0',avg_ping:null,source_observed_at:new Date(stamp) }] };
      if (sql.includes('SELECT client_impl, COUNT(*)::int AS node_count')) return { rows: [{ client_impl: 'Zebra', node_count: 1 }] };
      if (sql.includes('INSERT INTO node_snapshots')) return { rows: [{ snapshot_time: new Date(stamp+1000) }] };
      return { rows: [], rowCount: 0 };
    }, release() {},
  };
  const options = { rpc:async()=>({generated_at_ms:Date.now(),node_info:[]}),peerRpc:async()=>[],
    crunch:async()=>({nodes:[]}),torExits:async()=>new Set(['192.0.2.250']),dbPool:{connect:async()=>db},
    classificationPublisher:async status=>{ assert.equal(committed,true);assert.equal(status.available,true);assert.equal(status.classifiedTorNodes,0);published++;return true; } };
  function writer(source,dry=false){
    process.env.NODE_SOURCE=source;
    process.argv=originalArgs.filter(a=>a!=='--dry-run');
    if(dry)process.argv.push('--dry-run');
    delete require.cache[modulePath];
    return require(modulePath).ingestCrawl;
  }
  try {
    await writer('crawl')(options);
    assert.equal(published,1);
    await writer('peer')(options);
    await writer('crawl',true)(options);
    assert.equal(published,1,'shadow and dry-run writers cannot publish live status');
    failCommit=true;
    await assert.rejects(writer('crawl')(options),/commit failed/);
    assert.equal(published,1,'rollback cannot attest a classification');
    failCommit=false;lock=false;
    await writer('crawl')(options);
    assert.equal(published,1,'a skipped lock cannot refresh status');
  } finally {process.env.NODE_SOURCE=originalSource;process.argv=originalArgs;delete require.cache[modulePath];}
});
