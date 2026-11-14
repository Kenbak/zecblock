const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// Observer-only orphans parsed by the indexer live in observer_orphan_*
// (migration 045), never in orphaned_*. Node-reorg counts, fork events, orphan
// rates, Ask analytics and open data must keep reading only the node archive,
// and the reorgs page "Observers only" list stays defined by captured_blocks.
test('reorg counts and orphan rates never read the observer archive', () => {
  for (const file of [
    'api/routes/reorgs.js',
    'api/lib/orphan-rates.js',
    'api/lib/orphan-rate-daily.js',
    'api/lib/first-seen.js',
    'api/lib/observation-lag.js',
    'deploy/ask-analytics/reorgs-v1.sql',
    'deploy/ask-analytics/mining-v1.sql',
    'open-data/catalogue.py',
  ]) {
    assert.ok(!/observer_orphan_/.test(read(file)), `${file} must not count observer archives`);
  }
});

test('observer-only rule is unchanged by archiving', () => {
  const source = read('api/routes/reorgs.js');
  const rule = source.match(/const OBSERVER_ONLY_SQL = `([\s\S]*?)`;/)[1].replace(/\s+/g, ' ').trim();
  assert.equal(rule, [
    'FROM captured_blocks c JOIN blocks r ON r.height = c.height WHERE r.hash <> c.hash',
    'AND NOT EXISTS (SELECT 1 FROM blocks canonical WHERE canonical.hash = c.hash)',
    'AND NOT EXISTS (SELECT 1 FROM orphaned_blocks ob WHERE ob.hash = c.hash)',
  ].join(' '));
});

test('explorer migration mirror keeps observer archives out of orphaned_*', () => {
  const sql = read('deploy/sql/045_observer_orphan_archive.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.observer_orphan_blocks/);
  assert.match(sql, /CHECK \(source = 'observer'\)/);
  assert.match(sql, /REVOKE ALL ON public\.observer_orphan_blocks/);
  const code = sql.replace(/--.*$/gm, '');
  assert.ok(!/orphaned_(blocks|transactions)/.test(code), 'no DDL or DML on node-reorg tables');
});
