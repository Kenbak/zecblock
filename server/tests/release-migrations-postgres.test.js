'use strict';
// End-to-end `migrations.js check|apply|record` against a throwaway database
// with the production schema_migrations shape. Uses TEST_ACTIVITY_DATABASE_URL
// in CI, otherwise the local socket in /tmp. Never points at a host database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');
const migrations = require('../deploy/release/migrations');

const CLI = path.join(__dirname, '..', 'deploy', 'release', 'migrations.js');
const NETWORK = 'testnet';

async function withDatabase(fn) {
  const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
  const admin = new Pool(connection ? { connectionString: connection } : { host: '/tmp', database: 'postgres' });
  const name = `release_migrations_${process.pid}_${Date.now()}`;
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = connection ? new URL(connection) : null;
    if (url) url.pathname = `/${name}`;
    db = new Pool({ ...(url ? { connectionString: url.toString() } : { host: '/tmp', database: name }), max: 2 });
    const env = url
      ? { DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: name, DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password) }
      : { DB_HOST: '/tmp', DB_PORT: '5432', DB_NAME: name, DB_USER: process.env.USER || '', DB_PASSWORD: '' };
    await fn(db, env);
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  }
}

function cli(env, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--network', NETWORK], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  let state = null;
  try { state = JSON.parse(result.stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, state };
}

// The pre-047 production shape (checked on local copies, 2026-11-22).
const TABLE = `CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  backfilled boolean NOT NULL DEFAULT false)`;

test('check, apply and record enforce migration identity on a real table', async () => {
  await withDatabase(async (db, env) => {
    await db.query(TABLE);
    const files = migrations.migrationsForNetwork(migrations.discoverMigrations(), NETWORK);
    const legacy = files.filter((f) => f.version < migrations.IDENTITY_SINCE);
    // Legacy rows exactly as hosts have them: number and free text only,
    // including a number (026) recorded for a migration with no file here.
    for (const v of [...legacy.map((f) => f.version), 26]) {
      await db.query('INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [String(v).padStart(3, '0'), `legacy ${v}`]);
    }

    let run = cli(env, 'check');
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.state.identityTracking, false);
    assert.deepEqual(run.state.pending.map((p) => p.version), files.filter((f) => f.version >= 47).map((f) => f.version));

    run = cli(env, 'apply', '--version', '47');
    assert.equal(run.status, 0, run.stderr);
    const identity = files.find((f) => f.version === 47);
    const row = (await db.query("SELECT file_name, file_sha256 FROM schema_migrations WHERE version = '047'")).rows[0];
    assert.deepEqual(row, { file_name: identity.name, file_sha256: identity.sha256 });

    const pendingAfter = files.filter((f) => f.version > 47);
    run = cli(env, 'check');
    assert.equal(run.status, pendingAfter.length ? 2 : 0, run.stderr);
    assert.equal(run.state.identityTracking, true);
    assert.deepEqual(run.state.mismatched, [], 'legacy rows without a name are tolerated');
    assert.match(run.stdout, /"recordedWithoutFile":\[[^\]]*26/);

    // Content edited after recording.
    await db.query("UPDATE schema_migrations SET file_sha256 = repeat('0', 64) WHERE version = '047'");
    run = cli(env, 'check');
    assert.equal(run.status, 2);
    assert.equal(run.state.mismatched[0].reason, 'file content differs from the recorded hash');
    assert.match(run.stderr, /047_schema_migration_identity\.sql/);

    // The 026 incident, from now on: the number was recorded for another file.
    await db.query("UPDATE schema_migrations SET file_name = '047_older_feature.sql', file_sha256 = $1 WHERE version = '047'", [identity.sha256]);
    run = cli(env, 'check');
    assert.equal(run.status, 2);
    assert.deepEqual(run.state.mismatched.map((m) => [m.version, m.reason, m.recordedFile]),
      [[47, 'number recorded for a different file', '047_older_feature.sql']]);

    // A row inserted by hand above the floor without identity is not trusted.
    await db.query("UPDATE schema_migrations SET file_name = NULL, file_sha256 = NULL WHERE version = '047'");
    run = cli(env, 'check');
    assert.equal(run.status, 2);
    assert.equal(run.state.mismatched[0].reason, 'recorded without file identity');

    // `record` writes identity for a file run by hand, and refuses a recorded number.
    await db.query("DELETE FROM schema_migrations WHERE version = '047'");
    run = cli(env, 'record', '--version', '47');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Recorded \(not run\)/);
    run = cli(env, 'record', '--version', '47');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /already recorded/);
    run = cli(env, 'check');
    assert.deepEqual(run.state.mismatched, []);
  });
});

test('apply refuses a post-047 file before 047 adds the identity columns', async () => {
  await withDatabase(async (db) => {
    await db.query(TABLE);
    const files = [
      { version: 47, file: 'x/047_identity.sql', name: '047_identity.sql', sha256: 'a'.repeat(64), networks: null },
      { version: 48, file: 'x/048_next.sql', name: '048_next.sql', sha256: 'b'.repeat(64), networks: null },
    ];
    await assert.rejects(migrations.prepareRecord(db, files, NETWORK, '48'), /apply 47 first/);
    const target = await migrations.prepareRecord(db, files, NETWORK, '47');
    assert.equal(target.version, 47);
    await assert.rejects(migrations.insertRecord(db, files[1]), /apply 47 first/);
  });
});
