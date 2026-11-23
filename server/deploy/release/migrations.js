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
 * Since 047, each recorded row also stores the file's base name and the
 * SHA-256 of its bytes. A number recorded for another name or content is a
 * mismatch, not an applied migration. Rows below IDENTITY_SINCE predate those
 * columns and are trusted by number only, which is why new files must use a
 * number of at least IDENTITY_SINCE (many lower numbers are recorded on hosts
 * for migrations that have no file here).
 *
 *   node server/deploy/release/migrations.js status --network testnet
 *   node server/deploy/release/migrations.js check  --network testnet
 *   node server/deploy/release/migrations.js apply  --network testnet --version 48
 *   node server/deploy/release/migrations.js record --network testnet --version 48
 *
 * `status` prints JSON and always exits 0. `check` exits 2 when a file for
 * this network is not recorded, or is recorded for a different file. `apply`
 * runs exactly one named pending file and records it; it never applies
 * everything implicitly. `record` only records a file that an operator has
 * already run by hand (for example as postgres).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATION_DIRS = ['server/deploy/sql', 'server/deploy/migrations'];
const NETWORKS = new Set(['mainnet', 'testnet', 'crosslink']);

// First version whose schema_migrations row carries file identity.
const IDENTITY_SINCE = 47;

// Every file numbered below IDENTITY_SINCE. Frozen: their rows have no file
// identity, so a new file must never take one of these numbers or any other
// number below IDENTITY_SINCE. 026_exchange_flows.sql (2026-11-23) reused a
// number already recorded for an older migration and was skipped silently.
const LEGACY_FILES = Object.freeze([
  '016_topology_full_graph.sql',
  '023_mining_software.sql',
  '024_exclude_funding_stream_miner_attribution.sql',
  '025_empty_coinbase_tags_are_unmarked.sql',
  '029_node_census_freshness.sql',
  '030_job_summary_compatibility.sql',
  '031_combined_node_census.sql',
  '032_chain_supply_daily.sql',
  '032_crosslink_fork_monitor_ownership.sql',
  '033_crosslink_api_compatibility.sql',
  '034_crosslink_v14_ironwood.sql',
  '035_live_block_capture.sql',
  '036_block_subsidy_allocations.sql',
  '037_block_subsidy_allocation_privileges.sql',
  '038_chain_qualified_node_census.sql',
  '039_qualified_gossip_topology.sql',
  '040_node_crawler_columns.sql',
  '042_capture_coverage_audit.sql',
  '043_regional_census_vantages.sql',
  '044_crosschain_shielding.sql',
  '045_observer_orphan_archive.sql',
  '046_exchange_flows.sql',
]);

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

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function discoverMigrations(root = REPO_ROOT) {
  const files = [];
  for (const dir of MIGRATION_DIRS) {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const name of fs.readdirSync(absolute).sort()) {
      const match = name.match(/^(\d+)_.+\.sql$/);
      if (!match) continue;
      const bytes = fs.readFileSync(path.join(absolute, name));
      files.push({
        version: Number.parseInt(match[1], 10),
        file: path.posix.join(dir, name),
        name,
        sha256: sha256(bytes),
        networks: parseNetworks(bytes.toString('utf8')),
      });
    }
  }
  return files;
}

function appliesTo(file, network) {
  return !file.networks || file.networks.includes(network);
}

// Every number used by more than one file on the same network.
function findDuplicateVersions(files) {
  const duplicates = [];
  for (const network of NETWORKS) {
    const byVersion = new Map();
    for (const file of files.filter((f) => appliesTo(f, network))) {
      byVersion.set(file.version, [...(byVersion.get(file.version) || []), file.file]);
    }
    for (const [version, names] of byVersion) {
      if (names.length > 1) duplicates.push({ network, version, files: names.sort() });
    }
  }
  return duplicates.sort((a, b) => a.version - b.version || a.network.localeCompare(b.network));
}

function migrationsForNetwork(files, network) {
  if (!NETWORKS.has(network)) throw new Error(`Unknown network "${network}"`);
  const selected = files.filter((file) => appliesTo(file, network));
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

// A recorded row is either a bare version (identity unknown to the caller)
// or { version, fileName, fileSha256 }. fileName undefined means the
// identity columns do not exist; null means a row recorded without identity.
function normalizeRecord(row) {
  if (row !== null && typeof row === 'object') {
    return { version: normalizeVersion(row.version), fileName: row.fileName, fileSha256: row.fileSha256 };
  }
  return { version: normalizeVersion(row), fileName: undefined, fileSha256: undefined };
}

function identityProblem(file, record) {
  if (record.fileName === undefined) return null;
  if (record.fileName === null) {
    return file.version < IDENTITY_SINCE ? null : 'recorded without file identity';
  }
  if (record.fileName !== file.name) return 'number recorded for a different file';
  if (record.fileSha256 !== file.sha256) return 'file content differs from the recorded hash';
  return null;
}

function compareState(files, appliedRows, network) {
  const expected = migrationsForNetwork(files, network);
  const recorded = new Map();
  for (const record of appliedRows.map(normalizeRecord)) {
    if (record.version === null) continue;
    const existing = recorded.get(record.version);
    // Padded and bare duplicates of one number: prefer the row with identity.
    if (!existing || (existing.fileName == null && record.fileName != null)) recorded.set(record.version, record);
  }
  const known = new Set(expected.map((file) => file.version));
  const mismatched = [];
  for (const file of expected) {
    const record = recorded.get(file.version);
    if (!record) continue;
    const reason = identityProblem(file, record);
    if (reason) {
      mismatched.push({
        version: file.version,
        file: file.file,
        reason,
        recordedFile: record.fileName,
        recordedSha256: record.fileSha256 ?? null,
      });
    }
  }
  return {
    network,
    pending: expected.filter((file) => !recorded.has(file.version)).map(({ version, file }) => ({ version, file })),
    mismatched,
    recordedWithoutFile: [...recorded.keys()].filter((v) => !known.has(v)).sort((a, b) => a - b),
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

async function hasIdentityColumns(client) {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'schema_migrations'
        AND column_name IN ('file_name', 'file_sha256')`,
  );
  return result.rows[0].n === 2;
}

// null when the table is missing; otherwise rows for compareState.
async function readApplied(client) {
  const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS t");
  if (!exists.rows[0].t) return null;
  if (!(await hasIdentityColumns(client))) {
    const result = await client.query('SELECT version FROM schema_migrations');
    return result.rows.map((row) => ({ version: row.version, fileName: undefined, fileSha256: undefined }));
  }
  const result = await client.query('SELECT version, file_name, file_sha256 FROM schema_migrations');
  return result.rows.map((row) => ({ version: row.version, fileName: row.file_name, fileSha256: row.file_sha256 }));
}

function describe(target) {
  return target.name.replace(/\.sql$/, '').replace(/^\d+_/, '').replace(/_/g, ' ');
}

async function insertRecord(client, target) {
  const version = String(target.version).padStart(3, '0');
  if (await hasIdentityColumns(client)) {
    await client.query(
      'INSERT INTO schema_migrations (version, description, file_name, file_sha256) VALUES ($1, $2, $3, $4)',
      [version, describe(target), target.name, target.sha256],
    );
    return;
  }
  if (target.version >= IDENTITY_SINCE) {
    throw new Error(`schema_migrations has no identity columns; apply ${IDENTITY_SINCE} first`);
  }
  await client.query('INSERT INTO schema_migrations (version, description) VALUES ($1, $2)', [version, describe(target)]);
}

async function prepareRecord(client, files, network, versionArg) {
  const version = normalizeVersion(versionArg);
  const target = migrationsForNetwork(files, network).find((file) => file.version === version);
  if (!target) throw new Error(`No migration ${versionArg} for ${network}`);
  const applied = await readApplied(client);
  if (applied === null) throw new Error('schema_migrations is missing; create it before applying');
  if (applied.some((row) => normalizeVersion(row.version) === version)) {
    throw new Error(`Migration ${version} is already recorded`);
  }
  // A file numbered >= IDENTITY_SINCE (other than the one adding the columns)
  // must be recorded with its identity, so refuse before running anything.
  if (version > IDENTITY_SINCE && !(await hasIdentityColumns(client))) {
    throw new Error(`schema_migrations has no identity columns; apply ${IDENTITY_SINCE} first`);
  }
  return target;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const network = options.network || process.env.NETWORK;
  const files = discoverMigrations();

  if (options.command === 'status' || options.command === 'check') {
    const applied = await withClient(readApplied);
    const state = applied === null
      ? { network, trackingTable: false, identityTracking: false, pending: migrationsForNetwork(files, network).map(({ version, file }) => ({ version, file })), mismatched: [], recordedWithoutFile: [] }
      : {
          trackingTable: true,
          identityTracking: applied.length === 0 || applied[0].fileName !== undefined,
          ...compareState(files, applied, network),
        };
    console.log(JSON.stringify(state));
    if (options.command === 'check' && (!state.trackingTable || state.pending.length > 0 || state.mismatched.length > 0)) {
      for (const m of state.mismatched) {
        console.error(`migrations: ${m.file}: ${m.reason} (recorded ${m.recordedFile ?? 'no file'})`);
      }
      process.exit(2);
    }
    return;
  }

  if (options.command === 'apply' || options.command === 'record') {
    await withClient(async (client) => {
      const target = await prepareRecord(client, files, network, options.version);
      if (options.command === 'apply') {
        // Files manage their own transactions and lock/statement timeouts.
        await client.query('SET statement_timeout = 0');
        await client.query(fs.readFileSync(path.join(REPO_ROOT, target.file), 'utf8'));
      }
      await insertRecord(client, target);
      const verb = options.command === 'apply' ? 'Applied and recorded' : 'Recorded (not run)';
      console.log(`${verb} ${target.file} sha256=${target.sha256} on ${network}`);
    });
    return;
  }

  throw new Error('Usage: migrations.js <status|check|apply|record> --network <mainnet|testnet|crosslink> [--version N]');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`migrations: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  IDENTITY_SINCE,
  LEGACY_FILES,
  parseNetworks,
  discoverMigrations,
  findDuplicateVersions,
  migrationsForNetwork,
  compareState,
  normalizeVersion,
  readApplied,
  insertRecord,
  prepareRecord,
};
