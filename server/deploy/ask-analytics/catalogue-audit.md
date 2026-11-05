# Public analytics catalogue: first audit

This is operator tooling and a draft catalogue, not a new public API or broader
Ask query permission. The current v2 worker, grants and paid/public activation
settings are unchanged. `server/api/v1/lib/ask-public-catalogue.js` describes nine
reviewed source candidates, units, row grain and seven join relationships.
Unpublished input/output/address candidates are explicitly marked as such.

## Collect measurements

Generate the fixed psql script locally, inspect it, then run it only against the
mainnet standby with an existing operator connection. Do not give that operator
connection to Ask. No credentials are read or printed by the generator.

```sh
node server/api/scripts/profile-ask-catalogue.js > /tmp/ask-catalogue-profile.sql
psql -X -q -d zcash_explorer_mainnet -f /tmp/ask-catalogue-profile.sql
```

Default mode collects only allowlisted relation/column/index metadata, estimated
row counts, physical table/index bytes and a canonical-chain anchor. Estimated
rows are planner statistics, not counted records or coverage certification.
`total_bytes` includes indexes and TOAST; do not add `table_bytes` and indexes
again when summing `total_bytes`. Source footprint is not a final analytics copy
size: column selection, new indexes, aggregates, staging, backups and growth all
change the required capacity.

Opt in to five fixed sequential read probes with a 1–31 completed UTC-day window:

```sh
node server/api/scripts/profile-ask-catalogue.js \
  --start 2026-09-30 --end 2026-10-02 --benchmarks > /tmp/ask-catalogue-profile.sql
```

The script requires a recovering mainnet database with replay age at most 120s.
It begins a repeatable-read **READ ONLY** transaction, sets a 3s statement limit,
200ms lock limit, 5s idle limit, 1MB work_mem and 16MB temporary-file limit,
disables parallelism/JIT, and
finishes with rollback. No schema/grant changes, EXPLAIN ANALYZE, full-table row
counts, model calls or arbitrary query input. Run one audit at a time. These
limits bound individual probes; they are not complete server CPU isolation.

Probes compare maintained daily counts with canonical non-coinbase activity,
rank public shielding transactions/volume and average fees by miner address,
sample active transparent address incidences for the first selected day, and
independently repeat the miner ranking with a block-driven reference query. The
reference requires the reviewed unique `(txid,flow_type)` key. Compare both
rankings exactly; a mismatch is a failed correctness gate.
The prototype retains current Ask’s non-coinbase/nonnegative-boundary eligibility.
Flow direction is selected and grouped to transaction grain before fees/counts
are joined. Unknown miner addresses stay NULL; an address is not a named pool.
Amounts and counts are returned as exact strings, with average fees rounded to
six decimal zatoshis and missing fee counts supplied. The join prototype uses
reviewed source columns under this operator-only connection; it is not executable
by the existing view-only Ask reader. Canonical membership is checked once after
preaggregating boundary rows, avoiding repeated canonical joins through two views.
Address activity is not
new-address history. A successful date sample does not certify historical
completeness or the absence of source records that were never indexed.

Timeouts/errors emit an unavailable status and SQLSTATE; they do not become zero
activity. Savepoint rollback permits later probes; any failed probe makes the
complete script exit nonzero after the final rollback. `elapsed_ms` is one psql
server-session wall-time observation including serialization/recovery overhead,
not a latency percentile, throughput benchmark or capacity guarantee. JSON
records are an operator report; they must not be forwarded to model context or
the public client as a database-introspection tool.

Add `--samples` to collect aggregate-only selected-row size samples from each
allowlisted source, using SYSTEM (0.01 percent), a fixed seed and at most 256 rows.
No sampled identifiers or row contents are returned. The mean record size times
planner-estimated rows is only a preliminary logical-row budget: it excludes new
indexes, heap/page overhead, bloat, staging, backups and growth. Block sampling
can be biased or empty; empty samples stay NULL. Measure an actual selected-column
copy before treating this as a final disk requirement.

## Acceptance and next gates

- Verify expected fields/types, uniqueness, canonical joins and retained history.
- Reconcile daily totals with canonical activity within the audited window.
- Check flow historical backfill and address-summary first-seen/first-funded
  semantics before expanding claims or enabling those candidates.
- Benchmark representative longer windows and concurrent readers in an isolated
  staging/analytics database before choosing final query allowances or capacity.
- Define source identities, sync/reorg updates and snapshot cutover; swaps need a
  reviewed stable identity and source coverage beyond the current aggregate view.
- Provision a public-only analytics store, then expose registered joins through
  the same bounded runner. This prototype does not itself add an HTTP SQL endpoint.

Verify locally with:

```sh
CATALOGUE_TEST_POSTGRES=1 node --test server/api/test/v1/ask-public-catalogue.test.js
```

The PostgreSQL test creates and removes only its own local `/tmp` fixture
database. It checks canonical/orphan and coinbase handling, both flow directions,
exact large amounts, missing/zero observations and real timeout recovery.
