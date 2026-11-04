# Dedicated core store — private Ask integration

The `logical_public_core` worker is a separate profile. It does not weaken the existing standby profile's recovery/role guard. Its model catalogue contains blocks, non-coinbase transactions, and indexed public shielding/deshielding flows only. The model selects bounded version-two relational plans; the reviewed compiler chooses identifiers/functions and binds values. There is no arbitrary SQL execution endpoint, arbitrary joins, shell/file tools or primary fallback.

## Admission and source continuity

Apply `admission-v1.sql` once to the dedicated PG16 `ask_analytics` destination. Source provisioning uses `source-signal-v1.sql` with operator-reviewed psql variables `source_system_identifier`, `source_timeline`, and `source_id` (the existing sync-state generation). The extra `analytics_feed_meta.signal` table is private operational metadata, not a fourth user dataset. Native initial-copy refresh must produce four ready subscription relations. The fixed source heartbeat writes only this metadata every fifteen seconds and refuses recovery, a different system/timeline, or a missing/nonreserved dedicated logical slot.

The trusted postgres admission service validates the applied origin checkpoint, source generation/identity/timeline, fresh marker and matching canonical tip in a repeatable-read transaction. Its initial baseline checks all copied block links, block/transaction/coinbase counts, transaction identity/time and recorded flow references/amounts. Replica-enabled triggers track subsequent changes and adjacent heights. Each refresh validates at most two hundred dirty heights. Unchecked changes inside admitted coverage, expired signals or verification timestamps hide results. Broken consistency or truncation quarantines the store; repair does not automatically undo quarantine. Received LSN/latest height alone never opens admission. `applied_lsn` records the signal's conservative pre-update lower bound, not the later received WAL position or the marker's exact commit LSN.

`analytics_meta.is_admitted()` is the one audited security-definer exception: no arguments, boolean result only, owner `analytics_owner`, fixed `pg_catalog` search path. The reader has EXECUTE for calls embedded in the views, without schema USAGE or direct metadata access. Change tracking's privileged trigger function is not executable by the reader. These functions never execute dynamic SQL. Query views use verified rows directly to avoid redundant whole-chain joins; only the optional miner join remains, and can be removed by the planner when unused. `core-query-views-v1.sql` is the reviewed replacement for already installed early query views.

Recorded-flow referential consistency is checked; independent completeness of historical flow backfill remains **unverified**. Sparse events do not establish zero flows. Completed inclusive UTC date windows are limited to 366 days, two dimensions, four measures, two calculations and 25 result rows. Unsupported datasets/fields and SQL/expression/URL properties are rejected before query execution.

## Separate reader and runtime

Use locked OS user `ask_query` with only group `ask_db_socket`; never add it to `postgres`. PG remains without TCP listeners. Create `/run/ask-public-db` postgres:ask_db_socket mode0750, sockets group ask_db_socket mode0770. Keep admin socket parent `/run/postgresql` private mode0700 (setgid may remain). Put socket overrides after the existing `ask-baseline.conf`, e.g. `zz-ask-worker.conf`; inspect pg_settings.sourcefile and socket modes, not just the intended file. A destination-only PG restart is required for socket settings.

HBA must precede general peer lines:

```
local ask_analytics ask_public_reader peer map=ask_worker
local all ask_public_reader reject
```

The ident map contains only `ask_worker ask_query ask_public_reader`. Enable reader LOGIN only after native admission tests and the baseline pass. No reader password is provisioned. Config: `ASK_ANALYTICS_STORE=logical_public_core`, `ASK_ANALYTICS_DATABASE_URL=peer-only`, `ASK_ANALYTICS_SOCKET=/run/ask-public-db`; other DSNs/socket paths fail closed. Pool two connections; read-only repeatable-read transactions; statements three seconds, locks 500ms, temp16MiB, work_mem1MiB; overall worker deadline ten seconds and cancellation destroys the session. Role defaults alone are mutable and are not the privilege boundary.

Install the core worker unit as `zecblock-ask-analytics.service`, with explicit OS user, inaccessible source transport/passfile/data paths, loopback-only networking, bind only3015, memory128MiB and CPU25%. Root-owned application files and a checksum-verified Node22 runtime need the shared `lib/ask/query-contract.js` and locked API dependencies visible via root `node_modules` symlink or explicit NODE_PATH. Never copy an API/indexer .env. Separate quota Redis loopback6391 uses authenticated AOF/appendfsync=always, noeviction and shared daily/concurrency counters. Quota outage denies execution. Private deployment query limit is200/day and maximum concurrency two. Service credentials are root-only; the local API receives only worker/Redis auth, not database or replication credentials. API abuse limits and provider reservations are additional independent controls.

Install admission and source timers; replace the copy-stage health drop-in with ready-stage policy only after the reader and services work. Health is journal-only; no external alert delivery or newly provisioned analytics backups. Verify durable quotas after cold service restart without resetting actual counters, reader denial with read-only default off, worker filesystem isolation, authenticated/invalid-plan response codes and real query performance. A successful `systemctl start` is insufficient.

## Current deployment scope

October6 private localhost preview uses the new dedicated analytics host for custom relational queries. Existing fixed charts and record-lookup tools still use reviewed public API datasets, with separate provenance. No application push, public paid activation or unlimited SQL product is implied. Saved datasets/dashboards, broader catalogue, public ingress/CAPTCHA verification, load/capacity testing, external alerts and backups remain subsequent work. Provider prompts can be refused or malformed; prompt instructions supplement the compiler/grants/runtime boundaries, never replace them.
