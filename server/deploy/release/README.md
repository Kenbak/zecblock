# Unified API releases

Every explorer API host runs the same commit of `main`, installed by the same
script, with the same Node runtime and a recorded schema. Network differences
belong in each host's `server/api/.env` and its unit file, never in edited
source on the host.

| File | Purpose |
|---|---|
| `targets.json` | Desired state: host alias, network, role, unit, port, and whether the deploy workflow manages it. |
| `host.sh` | The only install procedure. `status` reports; `deploy <sha>` checks out, installs, health-gates and rolls back. It refuses hosts with edited tracked files. |
| `migrations.js` | Compares `server/deploy/sql` and `server/deploy/migrations` with `schema_migrations`. A file applies to all networks unless its header has `-- networks: <name>`. |
| `drift-report.js` | Read-only comparison of every host with the mainnet primary, `origin/main`, `.node-version`, its role and its schema. Exits 1 on drift. |
| `write-ssh-config.sh` | CI only: writes the `targets.json` aliases from host secrets. |

`.github/workflows/deploy.yml` deploys each `"deploy": true` target in order
after CI passes on `main`, then runs the drift report for those hosts.
`.github/workflows/drift.yml` runs the full report daily.

## Local use

The aliases in `targets.json` match the operator `~/.ssh/config`:

```bash
node server/deploy/release/drift-report.js
```

## Schema changes

Add a numbered file. Mark network-specific files with `-- networks: ...` in
the leading comment block. Record a file on a host with:

```bash
node server/deploy/release/migrations.js apply --network testnet --version 38
```

`apply` runs one named file as the API database user and records it. Files
must stay safe to re-run. When a file alters tables owned by `postgres` (for
example `nodes`), run it with `sudo -u postgres psql -v ON_ERROR_STOP=1 -f`
instead and insert its `schema_migrations` row in the same session.

Never re-run an old file on a host that already has its objects. Later files
can rewrite the same comments (031 and 038 both set
`node_snapshots.census_version`), so re-running the older one regresses them.
Verify the objects exist and only insert the `schema_migrations` row.

Once every deployed host reports no unrecorded migrations, set the repository
variable `ENFORCE_MIGRATIONS=true`. Deploys then refuse to restart a serving
API while a file for its network is unrecorded.

## Reconciling a drifted host

Done for testnet on 2026-10-29. It ran a server-local base (`73dd57ce`, on top
of main `8845e5b9`) with 13 edited tracked files, every one either
byte-identical to a version in main's history or a combination of main's own
content. Its database lacked migrations 016, 029, 031, 038 and 039.

1. Save local state in a root-only directory: `git rev-parse HEAD`, `git diff HEAD`,
   a bundle of local commits, untracked files plus `.env`, and
   `pg_dump --schema-only`.
2. Apply the missing files in numeric order (see Schema changes) and record each.
3. Point `origin` at `Kenbak/zecblock`, discard tracked edits (`git checkout -- .`)
   and move aside untracked files that main now tracks.
4. Stream `host.sh deploy <mainnet primary sha>` with the target's settings from
   `targets.json`, then check routes, job runs and the drift report.
5. Authorize the CI deploy key on the host, add its address secret and its
   pinned host keys (testnet uses `TESTNET_KNOWN_HOSTS`, appended after
   `DEPLOY_KNOWN_HOSTS`), then set `"deploy": true` in `targets.json`.

Mainnet primary had the objects for 016 and 031 but never recorded them; only
their `schema_migrations` rows were inserted.

## Not yet covered

- Crosslink runs a separate feature-net bundle with no Git checkout and no
  `schema_migrations` table. It needs its own schema reconciliation first.
- Unit files on hosts are not compared with `server/deploy/*.service` yet.
- Native node and indexer artifacts are released separately.
