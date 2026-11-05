#!/usr/bin/env node
/**
 * Versioned schema state for every explorer network.
 *
 * Migration files live in server/deploy/sql and server/deploy/migrations and
 * are identified by their numeric prefix. A file applies to every network
 * unless its leading comment block contains `-- networks: <name>[, <name>]`.
 * Applied versions come from the shared `schema_migrations` table, whose
 * historical rows use both zero-padded ('017') and bare ('17') numbers.
 *
 *   node server/deploy/release/migrations.js status --network testnet
 *   node server/deploy/release/migrations.js check  --network testnet
 *   node server/deploy/release/migrations.js apply  --network testnet --version 38
 *
 * `status` prints JSON and always exits 0. `check` exits 2 when a file for
 * this network is not recorded. `apply` runs exactly one named pending file and
 * records it; it never applies everything implicitly.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATION_DIRS = ['server/deploy/sql', 'server/deploy/migrations'];
const NETWORKS = new Set(['mainnet', 'testnet', 'crosslink']);

function parseNetworks(sql) {
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('--')) break;
    const match = trimmed.match(/^--\s*networks:\s*(.+)$/i);
    if (match) {
      const names = match[1].split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
      for (const name of names) {
        if (!NETWORKS.has(name)) throw new Error(`Unknown network "${name}" in migration header`);
      }
      return names;
    }
  }
  return null;
}

function discoverMigrations(root = REPO_ROOT) {
  const files = [];
  for (const dir of MIGRATION_DIRS) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const name of fs.readdirSync(absolute).sort()) {
      const match = name.match(/^(\d+)_.+\.sql$/);
      if (!match) continue;
      const sql = fs.readFileSync(path.join(absolute, name), 'utf8');
      files.push({
        version: Number.parseInt(match[1], 10),
        file: path.posix.join(dir, name),
        networks: parseNetworks(sql),
      });
    }
  }
  return files;
}

function migrationsForNetwork(files, network) {
  if (!NETWORKS.has(network)) throw new Error(`Unknown network "${network}"`);
  const selected = files.filter((file) => !file.networks || file.networks.includes(network));
  const seen = new Map();
  for (const file of selected) {
    if (seen.has(file.version)) {
      throw new Error(`Duplicate migration ${file.version} for ${network}: ${seen.get(file.version)} and ${file.file}`);
    }
    seen.set(file.version, file.file);
  }
  return selected;
}

function normalizeVersion(value) {
  const text = String(value).trim();
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : null;
}

function compareState(files, appliedVersions, network) {
  const expected = migrationsForNetwork(files, network);
  const applied = new Set(appliedVersions.map(normalizeVersion).filter((v) => v !== null));
  const known = new Set(expected.map((file) => file.version));
  return {
    network,
    pending: expected.filter((file) => !applied.has(file.version)).map(({ version, file }) => ({ version, file })),
    recordedWithoutFile: [...applied].filter((v) => !known.has(v)).sort((a, b) => a - b),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key.startsWith('--') || rest[i + 1] === undefined) throw new Error(`Bad argument ${key}`);
    options[key.slice(2)] = rest[i + 1];
  }
  return options;
}

function loadDependencies() {
  const apiModules = path.join(REPO_ROOT, 'server', 'api', 'node_modules');
  require(path.join(apiModules, 'dotenv')).config({ path: path.join(REPO_ROOT, 'server', 'api', '.env') });
  return require(path.join(apiModules, 'pg'));
}

async function withClient(fn) {
  const { Client } = loadDependencies();
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number.parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    application_name: 'zecblock-release-migrations',
    statement_timeout: 15000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function readApplied(client) {
  const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS t");
  if (!exists.rows[0].t) return null;
  const result = await client.query('SELECT version FROM schema_migrations');
  return result.rows.map((row) => row.version);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const network = options.network || process.env.NETWORK;
  const files = discoverMigrations();

  if (options.command === 'status' || options.command === 'check') {
    const applied = await withClient(readApplied);
    const state = applied === null
      ? { network, trackingTable: false, pending: migrationsForNetwork(files, network).map(({ version, file }) => ({ version, file })), recordedWithoutFile: [] }
      : { trackingTable: true, ...compareState(files, applied, network) };
    console.log(JSON.stringify(state));
    if (options.command === 'check' && (!state.trackingTable || state.pending.length > 0)) process.exit(2);
    return;
  }

  if (options.command === 'apply') {
    const version = normalizeVersion(options.version);
    const target = migrationsForNetwork(files, network).find((file) => file.version === version);
    if (!target) throw new Error(`No migration ${options.version} for ${network}`);
    await withClient(async (client) => {
      const applied = await readApplied(client);
      if (applied === null) throw new Error('schema_migrations is missing; create it before applying');
      if (applied.map(normalizeVersion).includes(version)) throw new Error(`Migration ${version} is already recorded`);
      // Files manage their own transactions and lock/statement timeouts.
      await client.query('SET statement_timeout = 0');
      await client.query(fs.readFileSync(path.join(REPO_ROOT, target.file), 'utf8'));
      await client.query(
        'INSERT INTO schema_migrations (version, description) VALUES ($1, $2)',
        [String(version).padStart(3, '0'), path.basename(target.file, '.sql').replace(/^\d+_/, '').replace(/_/g, ' ')],
      );
      console.log(`Applied and recorded ${target.file} on ${network}`);
    });
    return;
  }

  throw new Error('Usage: migrations.js <status|check|apply> --network <mainnet|testnet|crosslink> [--version N]');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`migrations: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseNetworks, discoverMigrations, migrationsForNetwork, compareState, normalizeVersion };
