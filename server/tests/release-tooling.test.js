const test = require('node:test');
const assert = require('node:assert/strict');
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
});

test('repository migrations are unambiguous for mainnet and testnet', () => {
  const files = migrations.discoverMigrations();
  for (const network of ['mainnet', 'testnet']) {
    assert.doesNotThrow(() => migrations.migrationsForNetwork(files, network));
  }
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
