# Dedicated public-core subscriber schema v1

`subscriber-core-v1.sql` is the first one-time migration for the NEW analytics
destination. It is not a source explorer migration or the local snapshot schema.
Run only through trusted operator access to an empty `ask_analytics` PostgreSQL16
database owned by the previously provisioned unprivileged NOLOGIN
`analytics_owner`. It rejects a different database/version, recovery, a populated
store, existing reserved roles/schemas and any subscription/slot. Collisions fail
atomically; do not alter/reuse unexpected objects to make it pass.

```sh
psql -X -v ON_ERROR_STOP=1 -d ask_analytics -f subscriber-core-v1.sql
```

Host identity/data-directory checks belong to the operator wrapper as well; a
same-named unrelated database is not permission to install there. No credential,
source connection, publication/subscription, HBA, TCP listener or Ask flag is
created. Lightweight empty-table DDL can run during initial RAID synchronization;
wait for the mirror and other operational gates before bulk import/load tests.

## Data authority and units

Hidden `public.blocks`, `public.transactions`, `public.shielded_flows` match the
reviewed source column names/types and primary keys from `TABLES` in the logical
preflight. Flow integer `id` is needed for native replica identity; no sequence is
created and the view owner/reader cannot read it. Source transaction/direction
uniqueness is retained. There are no foreign-key cascades or extra raw-value
checks that could reject native apply order or legacy source values. All fields
are explicit, not SELECT-star, and adding published columns requires a reviewed
subscriber migration first. DDL/sequences are not replicated automatically.

Reviewed security-barrier views expose blocks only within admitted coverage;
transactions require matching canonical block height/hash/header time; flows
require matching transaction ID/height/time. Mismatched/orphan rows are excluded.
Transactions include coinbase, unlike the current v2 private Ask transaction view;
activity queries must explicitly choose their coinbase policy. Flows preserve the
source public-boundary observation grain; join transactions if filtering coinbase.
Monetary fields remain exact bigint zatoshis (signed pool value balances are not
private payment values); timestamps remain UTC Unix seconds. Summing flow rows
and then transaction fees can multiply fees; aggregate at the correct grain.
Historical flow completeness remains `unverified` until separately reconciled.

## Dormant reader and denied privileges

`ask_public_view_owner` is an unprivileged NOLOGIN owner with explicit column
SELECT grants only on the raw fields needed by the views and the public health
fields of internal state. It cannot SELECT hidden flow IDs or source identity/LSN
metadata. `ask_public_reader` is NOLOGIN, NOINHERIT, no memberships or elevated
attributes, and can CONNECT/USAGE/SELECT only the four approved public views.
PUBLIC database/schema/table privileges are revoked. No raw/meta reads, writes,
DDL, TEMP, file access, owner-role escalation or subscription management grants.
There is no model/worker login or credential yet.

Reader defaults: two connections, read-only, 3s statement/500ms lock/5s idle
transaction timeouts, 1MB work_mem, 16MB temp files, no JIT or parallel gather.
These defaults are not immutable controls: permitted users can change many
settings, and PostgreSQL built-in functions are not a generic SQL sandbox.
Worker parsing/function allowlists, per-request transaction/timeout enforcement,
cancellation, scan/concurrency/result bounds and shared quotas/spend limits are
still required. Do not enable this role or offer raw SQL on the strength of DDL.

## Coverage state fails closed

Internal identity is schema1/mainnet/`logical_public_core`. Initial state is
`uninitialized`, with no source/checkpoint/coverage claim. Every data view is
empty in this state, even if raw copy rows already exist. The public coverage
view explicitly reports readiness; the future worker must check it and return
unavailable rather than interpret hidden data as zero activity.

`ready` state requires non-null source ID/system identifier/applied LSN, a valid
covered height range, tip hash and verification time. Public readiness additionally
requires a verification no older than120 seconds, no future timestamp, and the
advertised tip still present at its height/hash. Stale, copying, reconciling,
quarantined or absent state hides data; newly copied rows above the verified
height ceiling stay hidden. Reader cannot change this state.

This is a schema guard, NOT the trusted reconciliation/admission service. That
service remains to be implemented: verify ALL table-ready states, native applied
origin checkpoint, source identity/slot continuity, canonical parents/counts/time
and exact samples/flow coverage. Publish health in one trusted transaction and
read health/results together in repeatable-read. Received LSN or newest height
alone cannot establish completeness. No source transport/feed is activated here.

## Real PG16 verification

The existing two-cluster `ask-logical-sync.test.js` now applies THIS migration to
its disposable destination; it does not construct an alternative target schema.
Fixture-only reader activation and trusted admin publication of synthetic
coverage are clearly distinct from production login/coverage admission.

It tests exact source column types/identities, filtered initial copy, amounts
above JavaScript safe integer, atomic multi-table apply, historical corrections,
reorg removal, pause/resume/process restart/truncate, denied raw/metadata/file/
DDL/role/subscription access even with the read-only default disabled on one held
connection, collision/wrong-database refusal, orphan/time/range exclusion, and
stale/future/quarantined/tip-mismatch hiding. No mainnet benchmark or SQL-sandbox
certification is implied by the fixture.

See [logical synchronization gates](logical-sync.md).
References: [PG16 views](https://www.postgresql.org/docs/16/sql-createview.html),
[logical replication restrictions](https://www.postgresql.org/docs/16/logical-replication-restrictions.html),
[logical replication security](https://www.postgresql.org/docs/16/logical-replication-security.html).
