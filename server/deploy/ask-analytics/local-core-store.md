# Local public-core store prototype

This is a disposable synchronization fixture, not a deployable analytics store,
production migration, new Ask capability or change-data-capture implementation.
It requires two independent PostgreSQL databases on the local `/tmp` Unix socket.
Tests create them, copy reviewed fields, exercise failures and remove both databases
and their three dedicated roles. No source/provider credentials or production
connection URLs are loaded. No large history is downloaded.

Run from this checkout using the repository's Node 22 runtime:

```sh
ASK_STORE_TEST_POSTGRES=1 node --test server/api/test/v1/ask-core-store.test.js
```

Requirements: local PostgreSQL 14+ listening at `/tmp`, `pg` installed under
`server/api`, and a local administrator matching the OS username with permission
to create disposable databases/roles. Existing fixture role names abort; they
are never reused or repurposed. Tests ignore environment connection URLs/users.
No non-local database provisioning is accepted by `local-core-store.sql`.

## Data and publication contract

`server/api/lib/ask-core-store.js` exports:

- `readCoreSnapshot(pool,{from,through})`: fixed queries in one repeatable-read
  READ ONLY source transaction, only on `ask_source_fixture_<pid>`. The fixture's
  control row contains a stable source UUID and positive revision updated in the
  SAME source transaction as its data changes. This revision is a test surrogate,
  not a production replication slot/LSN or an indexer watermark.
- `validateSnapshot(snapshot)`: exact version/network/field allowlists; integer
  strings for counts, amounts and signed pool value balances; bounded text;
  contiguous height/parent relationships; matching transaction block hash/time;
  one coinbase and exact header transaction count per block; unique transactions
  and transaction/direction flows. The first block's external parent is not
  independently verified. Retained public flow history remains unverified.
- `applyCoreSnapshot(pool,snapshot,{expectedGeneration})`: only the local
  `ask_store_writer` and a matching versioned store identity. Lock the singleton
  checkpoint, enforce expected generation and increasing source revisions,
  replace the whole bounded window, and publish its coverage in one transaction.
  If any step fails, roll back records AND coverage; discard the connection when
  rollback fails. A duplicate payload is harmless even after a lost acknowledgement.

Limits: 200 inclusive heights, 5,000 total block/transaction/flow rows, 4 MiB
serialized input; parameterized inserts in chunks of 100. This is a bounded
window replacement proof, not a full-history incremental importer. Each SQL
statement has a 3s timeout and 500ms lock timeout, with 5s idle-transaction timeout,
1MB work_mem and parallel query workers disabled. These are not an overall
import deadline or a server CPU/memory isolation guarantee.

Core data includes coinbase transactions. Query code must explicitly exclude
coinbase when comparing with the existing Ask v2 non-coinbase metrics. Flow rows
are public shield/deshield boundary observations, not private shielded payments.
Fees are transaction-grain values; select/preaggregate flow direction before
joining so two directions cannot duplicate a transaction's fees. Money remains
numeric(78,0)/exact strings, with 100000000 zatoshis per display ZEC. Nullable
values stay NULL, never fabricated zero. Parent hashes are mapped from the
source `previous_block_hash` column; this additional field has not received the
live-column audit performed for the earlier nine-source inventory.

## Roles and visibility

`analytics_meta` owns fixture identity/checkpoints. `analytics_public` owns
blocks, transactions, flows and a coverage view; it exposes fixture-only authority,
range, tip hash, source-observation time, publication time and explicit unverified
flow completeness. Generation zero exposes no coverage row.

- `ask_store_owner`: NOLOGIN schema owner.
- `ask_store_writer`: fixed-table SELECT/INSERT/DELETE plus checkpoint UPDATE;
  no owner membership, DDL, TRUNCATE, private-fixture access or grant option.
- `ask_store_reader`: SELECT only on three public tables and coverage view,
  no metadata schema, ownership/memberships, write/DDL/TEMP privileges, privileged
  file/program access or grant option. It has a read-only session default,
  3s statement limit, 16MB temp-file limit and connection limit two.

PUBLIC database CONNECT/TEMP and public-schema privileges are revoked ONLY in
this dedicated disposable database. Shared production PUBLIC grants and current
Ask roles are untouched. Tests turn OFF the reader's user-changeable read-only
default to verify its effective privileges. A GRANT without grant option may
return a warning; the test confirms no effective PUBLIC access was added.

There is no raw SQL endpoint or model connection. System catalog/function exposure,
allowed SQL AST/functions, worker egress/process boundaries, shared quotas/spend,
request cancellation and tenant/account storage still require the production
execution-service design and audit. SELECT-only grants are not a complete public
SQL sandbox. Query rows and their coverage must eventually be read in the SAME
repeatable-read transaction to avoid mixing two published generations.

## Verification and remaining gates

The real local PostgreSQL tests exercise bootstrap; an exact amount beyond JS's
safe-integer range; both flow directions without doubled fees; unchanged-revision
polls/retries; historical correction and flow deletion; stale/conflicting revision
and generation refusal; canonical reorg replacement with orphan exclusion; chain
tip retreat; interrupted publication observed concurrently by the independent
reader, rollback and retry; incomplete source data; wrong identity/range; and
reader/writer effective privileges. Fixture data is synthetic, not measured mainnet
history, throughput or capacity. An interrupted-publication test injects an
exception before checkpoint publication while executing real database writes;
it is not a network outage or full CDC test.

Before the new box/full-data pilot:

1. Choose an actual snapshot/change-feed strategy using the current indexer and
   PostgreSQL configuration. Capture every relevant insert/update/delete;
   timestamp-only append polling is insufficient. Review replication-slot WAL
   retention/disk alarms and failover handling if using logical replication.
2. Establish gap-free snapshot/change cutover and restart checkpoints, plus
   reorg/canonical coverage reconciliation across real source changes. Extend
   retained history by bounded batches rather than deleting all copied history.
3. Validate source parent/hash/time fields and historical flow completeness.
   Review stable swap identities and mutable transparent spends/summaries before
   adding the remaining catalogue candidates.
4. Deploy a production-specific schema/importer/reader identity on the dedicated
   analytics box, load a bounded real sample, then measure actual indexes, storage
   and concurrent query/sync performance before full-history load/public admission.
5. Audit and connect the common protected SQL/query service to private Ask. The
   existing v2 standby guard remains unchanged; this fixture must not replace it.
