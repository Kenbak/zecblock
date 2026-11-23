const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const migrations = require('../deploy/release/migrations');
const { parseStatus, evaluate } = require('../deploy/release/drift-report');

function fixtureRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-migrations-'));
  for (const [file, sql] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), sql);
  }
  return root;
}

test('network header scopes a migration; absent header applies everywhere', () => {
  assert.deepEqual(migrations.parseNetworks('-- networks: crosslink\nBEGIN;'), ['crosslink']);
  assert.deepEqual(migrations.parseNetworks('-- note\n-- networks: mainnet, testnet\n'), ['mainnet', 'testnet']);
  assert.equal(migrations.parseNetworks('-- note\nBEGIN;\n-- networks: crosslink'), null);
  assert.throws(() => migrations.parseNetworks('-- networks: regtest'), /Unknown network/);
});

test('pending compares numeric versions across padded and bare records', () => {
  const root = fixtureRepo({
    'server/deploy/sql/016_topology.sql': 'SELECT 1;',
    'server/deploy/sql/017_index.sql': 'SELECT 1;',
    'server/deploy/sql/033_crosslink.sql': '-- networks: crosslink\nSELECT 1;',
    'server/deploy/migrations/023_mining.sql': 'SELECT 1;',
  });
  const files = migrations.discoverMigrations(root);
  const state = migrations.compareState(files, ['17', '023', '028'], 'testnet');
  assert.deepEqual(state.pending, [{ version: 16, file: 'server/deploy/sql/016_topology.sql' }]);
  assert.deepEqual(state.recordedWithoutFile, [28]);
});

test('duplicate versions for one network are rejected, not silently merged', () => {
  const root = fixtureRepo({
    'server/deploy/sql/032_supply.sql': 'SELECT 1;',
    'server/deploy/sql/032_crosslink.sql': '-- networks: crosslink\nSELECT 1;',
  });
  const files = migrations.discoverMigrations(root);
  assert.equal(migrations.migrationsForNetwork(files, 'mainnet').length, 1);
  assert.throws(() => migrations.migrationsForNetwork(files, 'crosslink'), /Duplicate migration 32/);
  assert.deepEqual(migrations.findDuplicateVersions(files), [
    { network: 'crosslink', version: 32, files: ['server/deploy/sql/032_crosslink.sql', 'server/deploy/sql/032_supply.sql'] },
  ]);
});

test('duplicate detection spans both folders and respects network headers', () => {
  const root = fixtureRepo({
    'server/deploy/sql/050_a.sql': '-- networks: mainnet\nSELECT 1;',
    'server/deploy/migrations/050_b.sql': '-- networks: testnet\nSELECT 1;',
    'server/deploy/sql/051_a.sql': 'SELECT 1;',
    'server/deploy/migrations/051_b.sql': '-- networks: testnet\nSELECT 1;',
  });
  const duplicates = migrations.findDuplicateVersions(migrations.discoverMigrations(root));
  assert.deepEqual(duplicates, [
    { network: 'testnet', version: 51, files: ['server/deploy/migrations/051_b.sql', 'server/deploy/sql/051_a.sql'] },
  ]);
});

// Crosslink has no schema_migrations table and runs its own bundle; the
// unscoped 032_chain_supply_daily.sql predates the Crosslink-only 032 file.
const KNOWN_DUPLICATES = [{
  network: 'crosslink',
  version: 32,
  files: ['server/deploy/sql/032_chain_supply_daily.sql', 'server/deploy/sql/032_crosslink_fork_monitor_ownership.sql'],
}];

test('repository migrations never share a number on one network', () => {
  const files = migrations.discoverMigrations();
  assert.deepEqual(migrations.findDuplicateVersions(files), KNOWN_DUPLICATES,
    'two migration files use the same number on one network; take the next free number');
  for (const network of ['mainnet', 'testnet']) {
    assert.doesNotThrow(() => migrations.migrationsForNetwork(files, network));
  }
});

test('numbers below the identity floor are frozen to the legacy files', () => {
  const files = migrations.discoverMigrations();
  const legacy = files.filter((file) => file.version < migrations.IDENTITY_SINCE).map((file) => file.name).sort();
  // A new file below IDENTITY_SINCE could reuse a number recorded on a host for
  // an unrelated migration (026, 2026-11-23); its row has no identity to compare.
  assert.deepEqual(legacy, [...migrations.LEGACY_FILES].sort(),
    `new migrations must be numbered ${migrations.IDENTITY_SINCE} or higher`);
  const identity = files.find((file) => file.version === migrations.IDENTITY_SINCE);
  assert.equal(identity?.name, '047_schema_migration_identity.sql');
});

test('files with identity never record themselves', () => {
  // `apply`/`record` write the row with the file's name and hash; a file that
  // inserts its own row would make that insert fail after the file ran.
  for (const file of migrations.discoverMigrations()) {
    if (file.version < migrations.IDENTITY_SINCE) continue;
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', file.file), 'utf8');
    assert.doesNotMatch(sql, /INSERT\s+INTO\s+(public\.)?schema_migrations/i, file.file);
  }
});

function identityFixture() {
  const root = fixtureRepo({
    'server/deploy/sql/026_legacy.sql': 'SELECT 26;',
    'server/deploy/sql/047_identity.sql': 'SELECT 47;',
    'server/deploy/sql/048_new.sql': 'SELECT 48;',
  });
  return migrations.discoverMigrations(root);
}

test('discovered files carry their base name and SHA-256', () => {
  const [legacy] = identityFixture();
  assert.equal(legacy.name, '026_legacy.sql');
  assert.equal(legacy.sha256, crypto.createHash('sha256').update('SELECT 26;').digest('hex'));
});

test('a recorded row matching the file name and hash is applied', () => {
  const files = identityFixture();
  const rows = files.map((f) => ({ version: String(f.version).padStart(3, '0'), fileName: f.name, fileSha256: f.sha256 }));
  rows[0] = { version: '026', fileName: null, fileSha256: null };
  const state = migrations.compareState(files, rows, 'testnet');
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.mismatched, []);
});

test('a number recorded for a different file is a mismatch, not applied', () => {
  const files = identityFixture();
  const [, identity, fresh] = files;
  const state = migrations.compareState(files, [
    { version: '026', fileName: null, fileSha256: null },
    { version: '047', fileName: identity.name, fileSha256: identity.sha256 },
    { version: '048', fileName: '048_older_feature.sql', fileSha256: 'f'.repeat(64) },
  ], 'testnet');
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.mismatched, [{
    version: 48, file: fresh.file, reason: 'number recorded for a different file',
    recordedFile: '048_older_feature.sql', recordedSha256: 'f'.repeat(64),
  }]);
});

test('a recorded file whose content changed is a mismatch', () => {
  const files = identityFixture();
  const [, identity, fresh] = files;
  const state = migrations.compareState(files, [
    { version: '26', fileName: null, fileSha256: null },
    { version: '047', fileName: identity.name, fileSha256: identity.sha256 },
    { version: '048', fileName: fresh.name, fileSha256: '0'.repeat(64) },
  ], 'testnet');
  assert.equal(state.mismatched.length, 1);
  assert.equal(state.mismatched[0].reason, 'file content differs from the recorded hash');
});

test('legacy rows without a name are tolerated only below the identity floor', () => {
  const files = identityFixture();
  const state = migrations.compareState(files, [
    { version: '026', fileName: null, fileSha256: null },
    { version: '047', fileName: null, fileSha256: null },
    { version: '048', fileName: null, fileSha256: null },
  ], 'testnet');
  assert.deepEqual(state.mismatched.map((m) => [m.version, m.reason]), [
    [47, 'recorded without file identity'],
    [48, 'recorded without file identity'],
  ]);
});

test('a padded and a bare row for one number prefer the row with identity', () => {
  const files = identityFixture();
  const [, identity] = files;
  const state = migrations.compareState(files, [
    { version: '47', fileName: null, fileSha256: null },
    { version: '047', fileName: identity.name, fileSha256: identity.sha256 },
  ], 'testnet');
  assert.deepEqual(state.mismatched, []);
  assert.deepEqual(state.pending.map((p) => p.version), [26, 48]);
});

test('bare version lists (no identity columns) keep number-only comparison', () => {
  const files = identityFixture();
  const state = migrations.compareState(files, ['026', '047', '048'], 'testnet');
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.mismatched, []);
  const preIdentity = migrations.compareState(files, [{ version: '048', fileName: undefined }], 'testnet');
  assert.deepEqual(preIdentity.mismatched, []);
});

const SERVING = { name: 'testnet', network: 'testnet', role: 'serving', service: 'zcash-api.service' };
const SHA = 'a'.repeat(40);
const context = (overrides = {}) => ({
  reference: SHA,
  nodeVersion: '22.23.4',
  migrationFiles: [{ version: 16, file: 'x/016_a.sql', networks: null }],
  onMain: () => true,
  ...overrides,
});

test('a clean, current, migrated serving host reports no drift', () => {
  const status = parseStatus([
    `head=${SHA}`, 'tracked_changes=0', 'node=v22.23.4',
    'service=zcash-api.service active=active enabled=enabled', 'pg_in_recovery=f', 'applied_migrations=016',
  ].join('\n'));
  assert.deepEqual(evaluate(SERVING, status, context()), []);
});

test('each drift class is reported', () => {
  const status = parseStatus([
    `head=${'b'.repeat(40)}`, 'tracked_changes=2', 'changed:  M server/api/server.js',
    'node=v22.14.0', 'service=zcash-api.service active=inactive enabled=enabled',
    'pg_in_recovery=t', 'applied_migrations=001',
  ].join('\n'));
  assert.deepEqual(status.changed, [' M server/api/server.js']);
  const problems = evaluate(SERVING, status, context({ onMain: () => false }));
  assert.equal(problems.length, 7);
  assert.match(problems.join('\n'), /2 tracked file/);
  assert.match(problems.join('\n'), /primary serves aaaaaaaa/);
  assert.match(problems.join('\n'), /not on origin\/main/);
  assert.match(problems.join('\n'), /runtime v22\.14\.0/);
  assert.match(problems.join('\n'), /inactive\/enabled for role serving/);
  assert.match(problems.join('\n'), /pg_is_in_recovery=t, expected f/);
  assert.match(problems.join('\n'), /unrecorded migrations 16/);
});

test('passive hosts must stay stopped and skip schema comparison', () => {
  const passive = { ...SERVING, role: 'passive' };
  const status = parseStatus([
    `head=${SHA}`, 'tracked_changes=0', 'node=v22.23.4',
    'service=zcash-api.service active=active enabled=enabled', 'pg_in_recovery=t', 'applied_migrations=skipped',
  ].join('\n'));
  assert.deepEqual(evaluate(passive, status, context()), ['zcash-api.service is active/enabled for role passive']);
});

test('unreachable hosts are drift, not a pass', () => {
  assert.deepEqual(evaluate(SERVING, { error: 'timeout' }, context()), ['unreachable: timeout']);
});
