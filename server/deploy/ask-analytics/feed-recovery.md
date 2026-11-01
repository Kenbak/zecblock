# Guarded recovery of the private native feed

This is the operator guide for `feed-recovery.py`,
`replication-recovery-v1.sql`, `zecblock-ask-feed-recovery.service` and its timer.
Deployment state belongs in the verified release record and private wiki; the
presence of these files does not establish that a timer is installed or enabled.
This service is separate from Ask's HTTP/query workers and runs only on the
trusted analytics subscriber as `postgres`.

## Eligible recovery and closed states

Recovery can resume the existing `ask_public_core_v1` subscription after a
classified publisher-restart or transport-disconnect event. It first has to
observe an enabled, admitted `ready` feed with acknowledged error counters and
exactly one apply worker. Installing it while the feed is already disabled does
not create this baseline and does not authorize an enable operation.

Every candidate must pass all of these checks:

- The target is the pinned physical PostgreSQL system, primary database
  `ask_analytics`, with `logical_public_core` identity, a verified baseline and
  state `ready`, `stale` or `reconciling`. Quarantine and incomplete copying block
  recovery. Source generation, system identifier and expected timeline match.
- Exactly one subscription exists. Its OID, owner, name, connection MD5,
  publication and slot match the reviewed configuration. It retains
  `disable_on_error=true`, `run_as_owner=false` and `subskiplsn='0/0'`.
  All configured relations are present exactly once and have native state `r`.
- A nonzero native `pg_<subscription_oid>` origin exists. The subscription is
  disabled, no worker remains, there are no synchronization errors, the
  statistics epoch is unchanged, and exactly one new apply error follows the
  last acknowledgement. Multiple or unexplained errors require review.
- The source is a primary `zcash_explorer_mainnet` connection authenticated as
  the existing LOGIN/REPLICATION role `ask_core_replicator`. Replication-protocol
  `IDENTIFY_SYSTEM` checks its live physical system identifier and timeline;
  the published signal independently matches the pinned generation/identity/
  timeline and is at most 120 seconds old, without a future timestamp.
- The existing source slot is inactive, logical `pgoutput`, for the expected
  database, with `wal_status='reserved'`, valid restart/confirmed positions and
  less than 48 GiB retained WAL. Missing, active, lost, unreserved or extended
  slots, pressure, identity changes and failed source probes block recovery.
  This service never undoes the source guard's NOLOGIN or slot-removal action.
- A complete bounded log interval proves the event belongs to this
  subscription's worker and ends in its automatic-disable message. The parser
  reads at most 16 MiB from each of the current log and `.1`; missing, rotated
  away, ambiguous or unclassified evidence blocks recovery.

Recognized error classes use exact SQLSTATE/message pairs:

- `08006`: `could not send end-of-streaming message to primary: server closed the connection unexpectedly`.
- `08006`: `could not send end-of-streaming message to primary: no COPY in progress`.
- `08006`: `could not receive data from WAL stream: server closed the connection unexpectedly`.
- `08P01`: `could not receive data from WAL stream: server closed the connection unexpectedly`.

The `08006` receive-path pair is the exact native disconnect observed during the
reviewed October 17 and October 23 incidents. It requires ERROR severity, complete
same-worker error/automatic-disable evidence and no DETAIL records attached to
that worker's failure. It does not admit other `08006` messages or a generic WAL
receiver prefix. The end-of-streaming send pairs retain their existing optional
single `no COPY in progress` DETAIL; other details block recovery. All identity,
origin-floor, counter, slot, pause and retry checks above remain required.

A graceful publisher stop can instead emit the exact LOG message
`data stream from publisher has ended`, immediately followed by the same
worker's automatic-disable LOG and one new apply error, without a separate
ERROR. The reviewed graceful-stream-end class requires that complete same-PID
pair and absence of worker errors; it is not permission to enable an arbitrary
disabled subscription. Its recovery kind is `publisher_stream_ended`.

Constraint conflicts, permission errors, unavailable WAL, source failover or
identity loss, schema/publication changes, an operator pause and other errors
stay closed. A transport word inside a different error is not eligible evidence.

### Native feedback and the saved origin floor

An admitted healthy observation persists the native origin name and LSN, the
subscription OID and a SHA-256 digest of the reviewed configuration pins. An
armed recovery needs this complete floor: missing/malformed state, a changed
origin/feed identity or an origin below its last healthy floor blocks even an
already enabled feed from rearming. Repinning or restoring an older target
checkpoint requires explicit operator review of the preserved state.

The service preserves PostgreSQL's native resume semantics. A publisher slot's
`confirmed_flush_lsn` can include idle/control WAL beyond the last applied
transaction origin, so that comparison alone does not block recovery. This does
not authorize origin advance, transaction skip or slot replacement. Recovery
still needs the retained slot, live identity, native origin floor and classified
new event; exact replay is checked in the isolated fixture.

This boundary assumes trusted source/target operators preserve the existing slot
and origin outside recorded maintenance. Metadata checks do not prove that an
administrator never dropped/recreated the same slot name or manually advanced an
origin. Pause recovery before such maintenance, retain evidence and independently
review continuity, source generation and the saved floor before any repin or
rebuild. Never delete the state file to bypass a failed continuity check.

## Retry state and acknowledgement

The first eligible attempt waits at least 60 seconds after disablement. Further
attempts for the same incident wait 120 and 300 seconds, including the delay
since the previous reservation. There are at most three reservations per rolling
hour and three per incident within 24 hours. The timer checks every 30 seconds
with 3-second accuracy, so actual execution can occur later than the minimum.

A private, fsynced state file reserves the attempt and saves event evidence
before administrative mutation; a crash does not erase its retry cost. The CLI
uses a nonblocking file lock to serialize runs. Preserve this directory across
service restarts and upgrades. A subsequent admitted healthy observation refreshes
the evidence boundary and clears the incident budget while retaining the hourly
reservations.

The transaction rechecks the target pins, statistics, ready relations, origin,
baseline and prior acknowledgement under locks. It marks coverage `stale`, records
an event in the append-only `analytics_meta.replication_recovery_events` ledger,
updates the current acknowledgement pointer, and enables only the existing
subscription. The original cumulative apply-error counter and log remain intact.
`analytics_meta.replication_errors_acknowledged()` permits normal admission to
recognize reviewed transport errors while rejecting new errors, changed epochs
and mismatched identity. Recovery does not make coverage `ready`; normal applied
checkpoint, freshness, consistency and dirty-history reconciliation still run.

## Configuration and installation

Use [feed-recovery.json.example](feed-recovery.json.example) as a template for
`/etc/zecblock-ask-recovery/config.json`. It starts disabled and contains deliberately
invalid identity/OID/timeline placeholders. Replace every pin from verified
metadata before running the CLI. OID, timeline and ports must be JSON integers.
Use the complete reviewed publication relation set; the example names the eight
core/signal/catalogue relations, not the nine query datasets.

The connection hash is `md5(subconninfo)` of the existing named subscription.
Retrieve the OID and hash without printing the connection string. A credential,
connection or publication change requires reviewing and repinning the existing
subscription, rather than treating a mismatch as a reason to create another one.
The source socket directory/port in the example use the existing private Unix
socket tunnel described in [private-transport.md](private-transport.md).

Keep the configuration and existing source-role passfile readable only by the
trusted operator account (normally `postgres`, mode 0600); keep the state
directory `postgres:postgres` mode 0700. The example contains a passfile path,
never a password or DSN. Do not copy source credentials to Ask or query workers.
The source probe uses existing replication authority and needs no new grants to
`pg_control_system()` or `pg_control_checkpoint()`.

The target log must retain UTC timestamps and worker PID/SQLSTATE, for example
`log_line_prefix='%m [%p] %e '` with `log_timezone='UTC'` and the default error
verbosity. Keep `log_min_messages='warning'` so both LOG and ERROR messages are
retained; the `log` threshold suppresses ERROR records in PostgreSQL server
logging. Changing the prefix
or adding a duplicated SQLSTATE to the message can make evidence unclassifiable;
verify parsing before enabling the timer.

For a reviewed deployment:

1. Record the exact branch/commit, mainnet network, private target environment and
   installed script/migration/unit hashes. Complete the isolated tests below.
2. Apply `replication-recovery-v1.sql` once to the verified PG16 `ask_analytics`
   target as `postgres`. Install the acknowledgement-aware admission and health
   code together. The migration creates evidence/helper objects; it does not
   reset statistics, enable a subscription or change source rows.
3. Install the script at `/opt/zecblock-ask-recovery/feed-recovery.py`, the reviewed
   units and the private config/passfile. The service creates
   `/var/lib/zecblock-ask-recovery`, restricts writes there and permits AF_UNIX
   only. Existing source transport supplies the remote connection.
4. With the feed independently verified and admitted, set `enabled` to true and
   run the service once. Require `action=healthy` / `reason=admission_verified`
   before enabling `zecblock-ask-feed-recovery.timer`. An `observing` response
   does not establish recovery readiness.
5. Inspect timer/service status, the safe action/reason journal, both availability
   monitors and the current dataset gates. Installing/enabling a unit is not a
   recovery proof. Do not restart the publisher to test this production rollout.

## Adding a replicated table: reviewed repin

`expected_relations` must list exactly the tables of `ask_public_core_v1`. A
dataset rollout that adds a table to the subscription leaves recovery `blocked`
with `copy_incomplete` until the config is updated, and the saved origin floor
pins the old list, so the update is a repin. `analytics-availability.py` alerts
`recovery_relations_drift` while the two differ. Apply this right after the
`REFRESH PUBLICATION` step of the dataset runbook, with the feed enabled and
healthy. Rollback is written first.

**Rollback:** `systemctl stop zecblock-ask-feed-recovery.timer`, restore
`config.json` and `state.json` from the `.bak-<stamp>` copies made in step 1
(`install -o postgres -g postgres -m 600`), then start the timer. Recovery
returns to its previous `blocked` state; the subscription is never touched.

1. `systemctl stop zecblock-ask-feed-recovery.timer`, wait for no active
   oneshot, and copy `/etc/zecblock-ask-recovery/config.json` and
   `/var/lib/zecblock-ask-recovery/state.json` to `.bak-<stamp>` with `cp -p`.
2. Confirm the feed: subscription enabled, every relation in state `r`, exactly
   one apply worker, error counters unchanged since the last acknowledgement.
   Record the saved floor LSN and the current `pg_replication_origin_status`
   LSN for the same origin; the current one must not be lower.
3. Replace `expected_relations` with the sorted subscribed list
   (`schema.table` for each `pg_subscription_rel` row) and write it atomically,
   owner `postgres`, mode 600. Change no other key.
4. In `state.json`, remove `healthy_origin` and set `armed` to `false`; keep
   every other key. Never delete the file.
5. `systemctl start zecblock-ask-feed-recovery.service`. The journal must show
   `healthy`/`admission_verified`, and `state.json` must again hold
   `armed: true` with a new `pins_sha256`. Anything else: run the rollback.
6. Start the timer and confirm the next alert run has no
   `recovery_relations_drift`.

## Operator pause, review and rollback

To pause both automation and the existing subscription through the reviewed CLI:

```sh
sudo -u postgres /usr/bin/python3 /opt/zecblock-ask-recovery/feed-recovery.py --config /etc/zecblock-ask-recovery/config.json --pause
```

The pause marker is saved before the disable operation. A failed disable still
leaves automatic recovery paused. A config with `enabled=false` also pauses
normal automatic runs; it does not itself disable a running subscription.

```sh
sudo -u postgres /usr/bin/python3 /opt/zecblock-ask-recovery/feed-recovery.py --config /etc/zecblock-ask-recovery/config.json --unpause
```

`--unpause` removes only the marker. It does not enable the subscription. Diagnose
the cause, verify identity/slot/history, then use a separately reviewed operator
enable if appropriate. An intentional disable with no new eligible error remains
paused even when an older transport event exists in the log.

For rollback, disable/stop the recovery timer, stop any active oneshot, and use
`--pause` if the subscription must also stop. Preserve the state directory,
append-only ledger, acknowledgement pointer, error counters and original logs.
Restore reviewed application/unit versions together; older admission code can
remain closed on nonzero counters, which is not justification for a reset.
Never use `pg_stat_reset_subscription_stats`, origin advance, `ALTER SUBSCRIPTION
... SKIP`, slot recreation, resnapshot or grant expansion to make recovery green.
Any rebuild, source promotion or schema repair is a separate operator procedure.

## Isolated acceptance

Run policy tests with standard Python and admission unit tests with the reviewed
Node 22 runtime and installed API dependencies:

```sh
python3 server/deploy/ask-analytics/test-feed-recovery.py
node --test server/api/test/v1/ask-replication-recovery.test.js
```

Native tests require an explicit absolute PostgreSQL 16 binary directory and a
non-root test account. They create only disposable private clusters, using 0700
Unix socket directories and no TCP listeners:

```sh
ASK_LOGICAL_TEST_POSTGRES=1 ASK_LOGICAL_PG_BIN=/absolute/pg16/bin python3 server/deploy/ask-analytics/test-feed-recovery-postgres.py
ASK_RECOVERY_TEST_POSTGRES=1 ASK_LOGICAL_PG_BIN=/absolute/pg16/bin node --test server/api/test/v1/ask-replication-recovery.test.js
```

The Python fixture uses actual publisher stop/start, subscriber restart, real
replication catch-up and duplicate-key apply failure, operator disable and lost
slot. It calls the real recovery probes/mutation and verifies retained errors,
unchanged origin identity and no origin advance/skip/slot recreation by recovery.
Only its retry clock is advanced 61 seconds to avoid sleeping for backoff;
fixture-only admission changes are synthetic and do not certify production
canonical reconciliation. A skipped or failing test is not a native pass.
