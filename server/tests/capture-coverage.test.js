const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { formatObserver, captureCoverageReport } = require('../api/lib/capture-coverage');

const base = {
  observer: 'local-node', network: 'mainnet', collection_started_at: '2026-10-12T14:14:02Z', heartbeat_at: '2026-11-05T10:00:00Z',
  stream_connected: true, gaps: '5297', pending_records: 0,
  coverage_since: '2026-11-05T00:00:00Z', db_now: '2026-11-05T10:00:00Z', unobserved_ms: '600000',
  outage_since: null, pending_bytes: '2048', journal_max_bytes: '1073741824',
  recent_gaps: [{ start_ms: Date.parse('2026-11-05T01:00:00Z'), end_ms: Date.parse('2026-11-05T01:10:00Z'), reason: 'capture gRPC connect failed' }, { start_ms: 'x' }],
  audit_checked_at: '2026-11-05T09:58:00Z', audit_status: 'ok', audit_fork_tips: 2, audit_fork_blocks: 3,
  audit_canonical_checked: 997, audit_canonical_missing: 0, uncaptured: 1, late: 2,
};

test('internal coverage times streaming only from coverage_since and keeps reasons for operators', () => {
  const m = formatObserver(base);
  assert.equal(m.measuredSince, '2026-11-05T00:00:00.000Z');
  assert.equal(m.streamingFraction, 1 - 600 / 36000);
  assert.equal(m.unobservedSeconds, 600);
  assert.deepEqual(m.recentGaps, [{ start: '2026-11-05T01:00:00.000Z', end: '2026-11-05T01:10:00.000Z', seconds: 600, reason: 'capture gRPC connect failed' }]);
  assert.equal(m.gapEvents, 5297, 'untimed historical gap events are reported separately');
  assert.deepEqual(m.journal, { pendingBytes: 2048, maxBytes: 1073741824 });
  assert.deepEqual(m.audit, { checkedAt: '2026-11-05T09:58:00.000Z', status: 'ok', forkTips: 2, forkBlocksChecked: 3,
    uncapturedForkBlocks: 1, lateCapturedForkBlocks: 2, canonicalBlocksChecked: 997, canonicalBlocksMissing: 0 });
  // An open outage counts up to now, never from before measurement began.
  const open = formatObserver({ ...base, unobserved_ms: '0', outage_since: '2026-11-04T00:00:00Z' });
  assert.equal(open.streamingFraction, 0);
  assert.equal(open.unobservedSeconds, 36000);
  const untimed = formatObserver({ ...base, coverage_since: null });
  assert.equal(untimed.streamingFraction, null, 'untimed history is not measured');
  assert.equal(untimed.unobservedSeconds, null);
  assert.equal(formatObserver({ ...base, audit_checked_at: null }).audit, null);
});

test('coverage stays internal: no public route, inventory entry or UI reads it', () => {
  const root = path.join(__dirname, '../..');
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', 'tests', 'test', 'scripts'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(js|ts|tsx|json|ya?ml)$/.test(entry.name) && file !== path.join(root, 'server/api/lib/capture-coverage.js')) {
        const text = fs.readFileSync(file, 'utf8');
        if (/capture-coverage|block_capture_audit_misses|audit_fork_tips|unobserved_ms/.test(text)) offenders.push(path.relative(root, file));
      }
    }
  };
  for (const dir of ['app', 'components', 'lib', 'server/api']) walk(path.join(root, dir));
  assert.deepEqual(offenders, []);
});

test('real PostgreSQL report reads migration 042 and is absent before it', {
  skip: process.env.ORPHAN_RATES_POSTGRES !== '1' && !process.env.MINING_TEST_DATABASE_URL,
}, async t => {
  const { Client } = require('pg');
  const db = new Client(process.env.MINING_TEST_DATABASE_URL
    ? { connectionString: process.env.MINING_TEST_DATABASE_URL }
    : { host: '/tmp', database: 'postgres' });
  await db.connect();
  t.after(async () => { await db.query('ROLLBACK'); await db.end(); });
  await db.query(`BEGIN; CREATE TEMP TABLE block_capture_observers(observer text PRIMARY KEY, network text, collection_started_at timestamptz DEFAULT now(),
    heartbeat_at timestamptz DEFAULT now(), stream_connected boolean, gaps bigint, pending_records integer, last_gap text, last_gap_at timestamptz);
    INSERT INTO block_capture_observers VALUES ('local-node','mainnet',now()-interval '1 day',now(),true,5,0,null,null)`);
  assert.equal(await captureCoverageReport(db), null, 'pre-042 schema has no report');
  // Apply the real migration's column/table definitions to the temp relation.
  const sql = fs.readFileSync(path.join(__dirname, '../deploy/sql/042_capture_coverage_audit.sql'), 'utf8');
  const alter = sql.slice(sql.indexOf('ALTER TABLE'), sql.indexOf(';', sql.indexOf('ALTER TABLE')) + 1).replace('public.block_capture_observers', 'block_capture_observers');
  const create = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf(');', sql.indexOf('CREATE TABLE')) + 2)
    .replace('CREATE TABLE IF NOT EXISTS public.', 'CREATE TEMP TABLE ').replace('public.block_capture_observers', 'block_capture_observers');
  await db.query(alter);
  await db.query(create);
  const before = await captureCoverageReport(db);
  assert.equal(before.observers[0].measuredSince, null, 'no timed delivery yet');
  await db.query(`UPDATE block_capture_observers SET coverage_since=now()-interval '1 hour', unobserved_ms=36000,
      recent_gaps='[{"start_ms":1,"end_ms":36001,"reason":"collector not running"}]', pending_bytes=0, journal_max_bytes=1073741824,
      audit_checked_at=now(), audit_status='ok', audit_fork_tips=1, audit_fork_blocks=1, audit_canonical_checked=144, audit_canonical_missing=0;
    INSERT INTO block_capture_audit_misses(observer,hash,network,height,branch_len) VALUES ('local-node',repeat('ab',32),'mainnet',5,1),('local-node',repeat('cd',32),'mainnet',6,1);
    UPDATE block_capture_audit_misses SET captured_later_at=now() WHERE hash=repeat('cd',32)`);
  const report = await captureCoverageReport(db, { missLimit: 1 });
  const [m] = report.observers;
  assert.ok(Math.abs(m.streamingFraction - 0.99) < 1e-3, String(m.streamingFraction));
  assert.equal(m.audit.uncapturedForkBlocks, 1);
  assert.equal(m.audit.lateCapturedForkBlocks, 1);
  assert.deepEqual(m.recentGaps, [{ start: new Date(1).toISOString(), end: new Date(36001).toISOString(), seconds: 36, reason: 'collector not running' }]);
  assert.equal(report.recentMisses.length, 1, 'miss list honours its limit');
  assert.match(report.recentMisses[0].hash, /^[0-9a-f]{64}$/);
});
