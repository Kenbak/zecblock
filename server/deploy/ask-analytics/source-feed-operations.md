# Private public-core feed — operator runbook

This is trusted infrastructure, separate from the model, query worker and public
API. Column grants/publication filters do not sandbox a replication credential.
Never mount the source socket/passfile or grant replication/admin membership to
the query worker. No public PostgreSQL listener is needed.

## Verified rollout, October 6, 2026 JST

Source `cipherscan-primary` PostgreSQL 16.15 changed `wal_level` from `replica`
to `logical`, with `max_slot_wal_keep_size=64GB`. The maintenance restart ran
2026-10-05 14:56:51–14:56:59 UTC. API/node PIDs stayed unchanged; the Rust indexer
restarted once on database disconnect and resumed indexing. Physical standby
reconnected and stayed asynchronous/streaming. No standby writer was activated.
The first pre-restart validation rejected PG16's expected postmaster-setting
"setting could not be applied" diagnostic, restored configuration, and exited
without restarting; the corrected guard admits only that exact expected setting.
Original configuration/HBA rollback copies are protected operator files on source.

Dedicated `ask_core_replicator` has LOGIN/REPLICATION, connection limit 3 and
explicit selected-column SELECT on exactly three application tables. It has no
superuser/BYPASSRLS/CREATE DB/CREATE ROLE/memberships, application-table mutation,
public-schema/database CREATE, credential-table read or server-file read grant.
Inherited source PUBLIC privileges (including TEMP) are not a model sandbox;
this credential is trusted and never exposed. Source HBA permits SCRAM for this
role only to the named database over 127.0.0.1; Unix/other IP/physical-replication
connections are rejected. Existing source users' rules are preserved.

Publication/subscription `ask_public_core_v1` sends the reviewed columns of
blocks, transactions and shielded_flows, including hidden flow identity. It
propagates insert/update/delete/truncate; no DDL or additional datasets are copied.
Subscription OID 16539 uses the private transport socket and postgres-only passfile
(no password in connection SQL). It is owned by the trusted destination admin;
run_as_owner=false and disable_on_error=true. Destination copy concurrency is 1;
parallel apply workers 0, streaming off, binary false, synchronous_commit on.
The replication process switches to the unprivileged raw table owner to apply.

Initial copy enabled at 2026-10-05 15:07:50.789098 UTC; the final table finished
at 15:11:27.276 UTC (216.486902 seconds from the enable observation). All three
tables reached native `r` (ready) and error counters remained zero. Source/destination
repeatable-read comparison through height 3507709 matches exactly:

- 3507710 blocks, heights 0–3507709.
- 18545603 transactions, including 3507710 coinbases; total header transaction
  count also 18545603.
- 1941180 public-flow records; exact sum 9583554354734854 zatoshis.
- Selected block/transaction fingerprints and latest 100 flow fingerprints match.

Target-only checks over the same bounded history find zero height gaps, parent
hash mismatches, per-block transaction/coinbase count mismatches, transaction
height/hash/time link mismatches or flow-to-transaction height/time mismatches.
This proves tested copy consistency, not independently derived historical flow
completeness. Live tip height/hash matches and a native replication-origin applied
checkpoint exists; received LSN is not substituted for that applied checkpoint.

The new store is **reconciling, ready=false**, flow_completeness unverified.
Reader remains NOLOGIN/no memberships; TCP listener absent and admin socket 0700.
Public coverage/result views remain withheld. Trusted continuous admission,
source identity/timeline/slot-loss checks, independent flow-completeness audit,
and isolated query-worker/Ask integration are still required. No arbitrary SQL
or broader public Ask release occurred. Analytics backups remain deferred by owner.

## WAL/disk guard

Install `source-guard.py` root-owned at `/opt/zecblock-ask-feed/source-guard.py`,
its service/timer under systemd, and a root:postgres 0640 config at
`/etc/zecblock-ask-feed/source-guard.json`. Populate source_system_identifier from
an authenticated operator probe and sync_prefix from the actual destination
subscription OID (not an example). Set slot_required=true only after main slot
creation. Validate the fixed source/database/WAL settings and available capacity
before activating the timer/copy. Timer checks each minute, journal-only.

At <256GiB free or <20% free, >=48GiB WAL retained by its own slot, lost/unreserved
own slots, or missing required main slot, the guard disables only its dedicated
login, terminates only that role's sessions and drops only its exact main/numeric
subscription-sync slots. Busy slot drops remain pending for retry. Other slots,
physical standby, roles and blockchain rows are untouched. 64GB is PostgreSQL's
checkpoint-enforced retention allowance, not an immediate disk hard cap; the
earlier guard thresholds leave headroom and still require monitoring.

A wrong database/system identifier or incompatible settings produces probe_failed
without administrative mutation. This is a journal warning, not a continuous
public admission service or an automatic target-quarantine action. No external
alert delivery or silent recovery is configured. Do not claim this alone handles
source failover. Source timeline 2 was observed; promotion/slot continuity needs
a reviewed admission/failover implementation.

After a stop/lost slot: keep admission closed, diagnose pressure and source
identity, then explicitly reconcile or resnapshot. Never auto-create/skip/advance
a slot and call the missing interval complete. Stop/disable the new destination
subscription first for an operator pause; monitor remaining source WAL retention.
Remove only owned slots/publication/role when deliberately decommissioning after
checking use. Reverting wal_level needs a separate coordinated restart; disabling
a subscription does not authorize a source restart or standby promotion.

## Destination monitor and safety tests

`host-health.py` defaults to dormant bootstrap. Install `copy-stage-health.conf`
as the health-service drop-in only after the single subscription and copying
state exist; it permits copying/reconciling while still refusing public readiness.
It flags disabled/erroring replication, absent apply worker, incorrect isolation,
reader activation/memberships, transport/socket faults, degraded mirrors and
insufficient disk headroom. Journal only; not freshness/coverage admission.

Run Python policy tests and the isolated PG16 administrative-action proof:

```sh
python3 server/deploy/ask-analytics/test-source-guard.py
python3 server/deploy/ask-analytics/test-host-health.py
ASK_LOGICAL_PG_BIN=/absolute/pg16/bin python3 server/deploy/ask-analytics/test-source-guard-postgres.py
```

11 policy tests passed. Disposable private Unix-socket PG16 proof verifies actual
NOLOGIN/session termination/owned-slot removal while preserving unrelated login,
session, logical/physical slots and source fixture rows. It never tests a destructive
pressure path on production. Existing native two-cluster copy/CDC/reorg/reader
proof is documented in [logical-sync.md](logical-sync.md).
