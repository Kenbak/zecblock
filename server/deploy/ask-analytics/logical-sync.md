# Public-core logical synchronization: candidate and local proof

## Current private feed and acceptance authority — October 12, 2026 JST

The nine-dataset private analytics store is provisioned. Today's outage/recovery,
alert delivery, fixed workload and remaining public-launch gates are tracked in
[launch-readiness.md](launch-readiness.md) and the canonical private wiki. Earlier
copy/dormant-reader statements below are dated provisioning history, not the
current state. No public paid activation is implied.


**Recommended first production feed:** native PostgreSQL 16 logical replication,
with an explicit column-list publication, one subscription for all three core
tables and a separate public-only analytics host. This captures committed inserts,
updates, deletes and truncates from every writer, including historical repairs,
without adding an indexer-specific outbox to each write path. This is a tested
candidate and rollout plan, not an activated production feed.

The existing snapshot prototype remains fixture-only. Native replication uses
its own durable checkpoints and initial table-copy mechanism; do not reuse the
fixture revision as a production cursor or repeatedly replace all history.

## Verified operator preflight

`profile-ask-logical-sync.js` only generates fixed SQL or a review-only publication
plan. It never reads credentials, connects, changes configuration or enables Ask.
Default SQL is metadata-only in READ ONLY, with 3s statements, 200ms locks and final
rollback. It reports reviewed core fields/types/replica identity plus bounded
configuration/slot/sender counts; no passwords, connection strings or arbitrary
introspection input are accepted. Keep raw reports in operator storage, outside
model/public context. `assessPreflight` always leaves activation unauthorized;
configuration readiness is only one gate.

Observed 2026-10-04 **21:36:04 UTC**, October 5 **06:36 JST**:

- Primary and physical standby both PostgreSQL **16.15**; recovery=false/true
  respectively, no pending restarts in the selected settings.
- `wal_level=replica`, `max_replication_slots=10`, `max_wal_senders=10`,
  `max_slot_wal_keep_size=-1` (unlimited), zero replication slots/publications.
  Primary had one connected WAL sender; standby had zero.
- All selected core fields/types are present. Default valid identities are
  blocks(height), transactions(txid), shielded_flows(id). The additional
  `previous_block_hash` is present as text; this checks its schema, not every
  historical parent relationship.

Production is **not ready to activate**: logical WAL needs a planned database
restart, and a finite positive slot-WAL budget/alarms must be chosen first.
No source PostgreSQL setting, slot, publication, role, HBA/firewall or service was
changed by these reads. Standby remains a physical HA/read-offload replica.

```sh
node server/api/scripts/profile-ask-logical-sync.js > /tmp/ask-logical-preflight.sql
node server/api/scripts/profile-ask-logical-sync.js --publication-plan > /tmp/ask-publication-review.sql
```

Inspect and execute the preflight only through the existing operator connection.
The second command emits DDL for review; **do not execute it as part of this audit**.
It rejects an unreviewed database/version, a standby, non-logical WAL and an
unlimited/zero WAL budget before creating a publication. Publication creation
aborts on name collision; it does not silently alter another publication.
The operator must separately verify identities/types, capacity, privileges and
rollout gates; this SQL guard is not a complete release/security audit.

## Why native replication fits the current sources

Reviewed Rust `05c81d6` source writes block/header, transactions, flows, spent
outputs and address summaries in `insert_block_with_transactions`'s transaction;
reorg rollback also commits deletions/restored spends/summaries atomically.
`batch_update_metadata` can change older transactions, and other application
repair jobs are independent writers. Database-level change capture handles
these changes without relying on a new-height or timestamp-only append cursor.
This is source inspection, not a new verification/deployment of running indexer
artifacts. No Rust source or numbered migration changes in this task.

Native table names must match on publisher/subscriber. Prepare thin raw
`public.blocks`, `public.transactions`, `public.shielded_flows` on the NEW host;
place reviewed canonical views in `analytics_public`. The query reader gets
SELECT on those views only, with no raw/meta/subscription privileges. The dedicated [subscriber-core v1 migration](subscriber-core-v1.md) now creates
these exact thin tables and canonical views with a dormant reader and
uninitialized coverage. It is separate from `local-core-store.sql`; the latter
is a disposable snapshot fixture, not a production subscriber migration.

`shielded_flows.id` must travel because the existing default replica identity is
its integer primary key. Keep it in the hidden raw table and omit it from the
public flow view. This avoids changing the source table's identity or publishing
unreviewed flow columns. Published flow row grain remains transaction/direction;
its uniqueness and coverage must also be reconciled. All monetary core columns
are bigint zatoshis; retain exact decimal strings in application evidence.

## Real PostgreSQL 16 fixture verification

```sh
ASK_LOGICAL_TEST_POSTGRES=1 ASK_LOGICAL_PG_BIN=/absolute/path/to/pg16/bin \
  node --test server/api/test/v1/ask-logical-sync.test.js
```

The opt-in test initializes TWO private, disposable PG16 clusters under the OS
temporary directory, uses only Unix sockets inside a 0700 directory and disables
TCP listeners. It does not alter/start/restart the existing local PostgreSQL 14
installation or any remote server. Local fixture trust authentication contains
no real credentials and is not a production authentication recommendation.
Cleanup stops both fixtures, removes the subscription/slot and deletes their
files. A sandbox may block PostgreSQL shared-memory initialization; an approved
local unsandboxed run is then needed. A skipped fixture is not a verification pass.

For this run PG **16.15** was built under `/private/tmp/ask-sync-20261005` from the
official archive after verifying its published SHA-256; no global installation.
Node **22.22.1** ran the tests. The initial sandboxed initdb failed on shmget;
the approved local run completed with all checks enabled.

The destination now uses the actual `subscriber-core-v1.sql` migration, not
a separately constructed test schema. Fixture-only login activation and trusted
admin publication of synthetic coverage are not a production admission service.
New checks cover inherited-owner refusal, type compatibility, migration collision/
wrong-database refusal and hidden unready/stale/future/quarantined/noncanonical/
uncovered data. Denial probes retain one connection with its read-only default
disabled, so reconnects cannot silently restore that default.

Checks also cover column-filtered initial copying/all table-ready states; exact amount
9007199254740993; no source private-marker columns on the subscriber; committed
multi-table change visibility; paused consumer plus historical fee/flow updates,
deletions and reorg tail removal; actual subscriber-process stop/restart and
checkpoint catch-up; truncate propagation; finite 64MB fixture WAL setting;
unchanged flow primary key; denied raw tables, connection metadata, writes, TEMP,
files, role escalation and subscription control for the query reader. The source
replication role has explicit public-column SELECT and cannot SELECT excluded
columns or the private fixture table. Its replication credential remains a
privileged trusted-service secret, never a model/query-worker credential.

Fixture timing is not a mainnet benchmark, failover drill or arbitrary-SQL
sandbox certification. The 64MB fixture WAL budget is not a production sizing
recommendation. Checkpoint-bound enforcement is not an immediate disk hard cap.

## Implementation backup policy — October 5, 2026

The owner explicitly deferred analytics backup setup until implementation works
as intended. No analytics backup repository/account/schedule will be provisioned
at this stage, and it is not a prerequisite for the initial private chain-data
copy. Raw blockchain rows can be rebuilt from the source; losing this store
requires a fresh copy and reconciliation. Existing source production backups
continue unchanged. Revisit analytics backup/configuration/user-content recovery
after implementation is accepted. This does not waive WAL retention, capacity,
source maintenance, copy reconciliation or query-access controls.

## Required production rollout gates

1. **New analytics host and schema:** select budget/configuration, provision
   private transport, create versioned hidden raw tables + reviewed
   views, and a separately audited read-only worker. No source credentials or
   replication role memberships in the worker/model/API client.
2. **Source maintenance review:** measure WAL rate/headroom; choose finite
   retention with low-disk/retained-WAL/lag alarms and an invalid-slot recovery
   policy. Coordinate logical WAL configuration and planned restart with physical
   HA. Do not enable capture with unlimited retention, restart services or promote
   the standby as a side effect of running the preflight.
3. **Restricted transport/publication:** dedicated trusted replication login,
   public-column grants, private network/TLS/HBA restrictions and bounded native
   sync concurrency. One reviewed publication/subscription for this core dataset.
   More tables/columns require versioned subscriber-first schema review; DDL is
   not automatically replicated. Never expose publication-management privileges
   as an Ask tool.
4. **Bootstrap readiness:** keep Ask pointed at its existing worker during copy.
   Wait for ALL selected tables to finish initial sync and for changes to catch
   up; initial table copying must not be treated as one immediately queryable
   consistent snapshot. Reconcile canonical parent/hash/time, block transaction
   counts, coinbase rules and exact flow/fee samples before admission. Flow
   historical completeness remains explicitly unverified until independently
   checked; table-ready does not prove it.
5. **Trusted health/admission:** use applied checkpoint/replication-origin
   progress, not merely received LSN. Publish a verified canonical height/hash and
   coverage timestamps. Read result rows/coverage in the same repeatable-read
   query transaction. Refuse current-data requests on stale/unknown/unready state;
   historical snapshot reads need explicit product policy. No primary fallback.
6. **Failover/backpressure:** PG16 source logical slots are not assumed to follow
   physical-primary promotion automatically. Stop admission on identity/slot/
   timeline loss; use a reviewed coordinated failover procedure or resnapshot
   into a quarantined store. Never create a new slot and assume it includes a
   missing interval. Rebuild after invalidation, reconcile, then re-admit.
7. **Public SQL/AI release:** AST/function/schema restrictions, cancellation,
   concurrency/result budgets, atomic shared quotas/spend caps and adversarial
   tests remain separate gates. Start with private Ask; no arbitrary public SQL
   access is added by publication readiness.

Primary references:
- https://www.postgresql.org/docs/16/logical-replication-col-lists.html
- https://www.postgresql.org/docs/16/logical-replication-config.html
- https://www.postgresql.org/docs/16/logical-replication-restrictions.html
- https://www.postgresql.org/docs/16/logicaldecoding-explanation.html
- https://ftp.postgresql.org/pub/source/v16.15/
