#!/usr/bin/env node
/**
 * Read-only drift report across every API host in targets.json.
 *
 *   node server/deploy/release/drift-report.js [--json] [--deployed-only]
 *
 * Each host streams host.sh `status` from this checkout. A host is coherent
 * when its tracked tree is clean, it serves the same commit as the mainnet
 * primary (the release reference), that commit is on origin/main, its runtime
 * matches .node-version, its unit state matches its role, and its database has
 * recorded every migration file this checkout defines for its network.
 * Exits 1 when any host drifts, so CI can alert on it.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { discoverMigrations, compareState } = require('./migrations');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST_SCRIPT = path.join(__dirname, 'host.sh');

function parseStatus(text) {
  const status = { changed: [] };
  for (const line of text.split('\n')) {
    if (line.startsWith('changed: ')) status.changed.push(line.slice('changed: '.length));
    else if (line.startsWith('service=')) {
      for (const pair of line.split(' ')) {
        const [key, value] = pair.split('=');
        status[key] = value;
      }
    } else {
      const index = line.indexOf('=');
      if (index > 0) status[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return status;
}

function collect(target) {
  const env = [
    `NETWORK=${target.network}`, `ROLE=${target.role}`,
    `SERVICE=${target.service}`, `PORT=${target.port}`,
  ].join(' ');
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target.ssh, `${env} bash -s -- status`], {
    input: fs.readFileSync(HOST_SCRIPT),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) {
    return { error: (result.stderr || result.error?.message || 'ssh failed').trim().split('\n').pop() };
  }
  return parseStatus(result.stdout);
}

function isOnMain(sha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function evaluate(target, status, { reference, nodeVersion, migrationFiles, onMain }) {
  if (status.error) return [`unreachable: ${status.error}`];
  const problems = [];
  if (status.tracked_changes !== '0') problems.push(`${status.tracked_changes} tracked file(s) modified`);
  if (status.head !== reference) problems.push(`serves ${status.head?.slice(0, 8)}, primary serves ${reference?.slice(0, 8)}`);
  if (!onMain(status.head)) problems.push(`commit ${status.head?.slice(0, 8)} is not on origin/main`);
  if (status.node !== `v${nodeVersion}`) problems.push(`runtime ${status.node}, expected v${nodeVersion}`);
  const wantActive = target.role === 'serving';
  if ((status.active === 'active') !== wantActive || (status.enabled === 'enabled') !== wantActive) {
    problems.push(`${target.service} is ${status.active}/${status.enabled} for role ${target.role}`);
  }
  // A passive host must stay a replica; a serving host owns a writable database.
  const wantRecovery = target.role === 'passive' ? 't' : 'f';
  if (status.pg_in_recovery !== wantRecovery) {
    problems.push(`PostgreSQL pg_is_in_recovery=${status.pg_in_recovery}, expected ${wantRecovery} for role ${target.role}`);
  }
  const applied = status.applied_migrations;
  if (applied === 'missing-table' || applied === 'unreadable') {
    problems.push(`schema_migrations ${applied}`);
  } else if (applied && applied !== 'skipped') {
    const state = compareState(migrationFiles, applied.split(','), target.network);
    if (state.pending.length) problems.push(`unrecorded migrations ${state.pending.map((m) => m.version).join(', ')}`);
  }
  return problems;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'targets.json'), 'utf8'));
  // --deployed-only limits the check to hosts the deploy workflow manages.
  if (process.argv.includes('--deployed-only')) {
    manifest.targets = manifest.targets.filter((target) => target.deploy);
    manifest.excluded = {};
  }
  const nodeVersion = fs.readFileSync(path.join(REPO_ROOT, '.node-version'), 'utf8').trim();
  const migrationFiles = discoverMigrations(REPO_ROOT);
  const statuses = manifest.targets.map((target) => ({ target, status: collect(target) }));
  const reference = statuses.find(({ target }) => target.name === 'mainnet-primary')?.status.head;

  const rows = statuses.map(({ target, status }) => ({
    name: target.name,
    deploy: target.deploy,
    head: status.head || null,
    node: status.node || null,
    problems: evaluate(target, status, { reference, nodeVersion, migrationFiles, onMain: isOnMain }),
  }));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ reference, nodeVersion, rows }, null, 2));
  } else {
    console.log(`Reference: mainnet-primary ${reference || 'unknown'}; runtime v${nodeVersion}\n`);
    console.log('| Host | Auto-deploy | Commit | Node | Drift |');
    console.log('|---|---|---|---|---|');
    for (const row of rows) {
      console.log(`| ${row.name} | ${row.deploy ? 'yes' : 'no'} | ${row.head?.slice(0, 8) || '-'} | ${row.node || '-'} | ${row.problems.join('; ') || 'none'} |`);
    }
    for (const [name, reason] of Object.entries(manifest.excluded || {})) {
      console.log(`| ${name} | excluded | - | - | ${reason} |`);
    }
  }
  if (rows.some((row) => row.problems.length)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { parseStatus, evaluate };
