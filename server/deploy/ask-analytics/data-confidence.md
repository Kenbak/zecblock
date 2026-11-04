# Bounded data-confidence audits

`server/api/scripts/audit-ask-data-confidence.js` is a trusted operator tool for
measuring recorded-table consistency in an explicit height interval. It adds no
public endpoint, reader grant, backfill, migration, provider call or production
write. Every report retains `chain_history_completeness='unverified'`, including
a clean measured interval. The source index and its replicated views are not an
independent account of all Zcash chain history.

## Scope and authority

The audit has two explicit modes:

- `source` measures the raw recorded blocks, transactions, shielded flows,
  transparent address incidences and selected current summaries. Choose
  `--source-kind primary` or `standby`; a standby must have replay age between
  zero and 120 seconds. The database must be `zcash_explorer_mainnet` on PG16.
- `analytics` reads only existing `analytics_public` query/coverage views in
  primary PG16 `ask_analytics`. Core coverage must be ready and include the whole
  requested interval; address/activity gates must also be ready. A stale gate
  fails unavailable before data planning. Canonical/publication filters can hide
  underlying defects, and the transaction view excludes coinbase while address
  incidences include it. This mode therefore does not claim independent orphan
  detection or complete incidence-to-transaction reconciliation.

The operator must establish the intended host, network, release and trusted
connection before running either mode. A same-named database is not independent
chain identity. The report records its read-only snapshot observation time,
selected bounds and public first/last block hashes; preserve those alongside the
verified serving-node/canonical identity when comparing reports.

The five fixed probes measure:

1. Missing recorded block heights, null timestamps and source-only parent links.
   Missing rows mean missing source records in the selected interval; a node
   comparison is still needed to determine the authoritative chain history.
2. Transaction fee/byte nulls and source-only missing block/hash/time/coinbase
   fields. Source transaction counts include coinbase; the published view does not.
3. Flow amount nulls/negative values, unrecognized direction/pool, repeated
   transaction/direction groups and source-only missing transaction/canonical
   links. Amounts remain exact decimal zatoshis. A missing amount makes the
   recorded sum NULL; no matching observations also produce a NULL sum, not an
   invented zero. Sprout remains a recognized historical pool.
4. Incidence value/flag nulls, negative values, empty flags and repeated
   address/transaction pairs, plus source-only missing/canonical references.
   Active addresses and incidences do not count people or new addresses.
5. Up to 128 selected current summaries: missing summary/measure fields,
   `first_seen` after a sampled observation, `last_seen` before one, or summary
   incidence count below the sample. These are necessary consistency conditions;
   passing does not prove first funding, historical balances or full-ledger sums.

The tool returns aggregates, exact amount strings and public block anchors;
address and transaction identifiers remain inside fixed SQL, not report rows.
Rows with absent/incorrect recorded heights outside the selected interval are
outside scope. A window without flow rows does not certify that no chain flow
occurred. Fields not exposed by a view are not silently treated as verified.

## Plan first, then explicitly measure

Provide standard private PG connection environment through the existing trusted
operator access. The tool accepts no DSN, SQL, arbitrary relation or provider-key
argument and does not print raw database errors or credentials. Run a small
reviewed historical interval first; do not point it at a production mutation or
run a full-history scan to fill this report.

```sh
node server/api/scripts/audit-ask-data-confidence.js --mode source --source-kind primary --from-height 3500000 --to-height 3500063
node server/api/scripts/audit-ask-data-confidence.js --mode analytics --from-height 3500000 --to-height 3500063
```

Default reports are plan-only: they issue EXPLAIN FORMAT JSON without ANALYZE for
each fixed probe and do not execute its data SELECT. Review the aggregate cost
and plan rejection reasons before the separately authorized measurement:

```sh
node server/api/scripts/audit-ask-data-confidence.js --mode source --source-kind primary --from-height 3500000 --to-height 3500063 --execute
```

Execution repeats EXPLAIN immediately before every SELECT in the same read-only
repeatable-read snapshot. Plans with estimated cost over 100000 at any node, or a
sequential scan or index scan without an index condition over one of the five
source relations with unknown or over 5000 estimated rows, are refused. Planner row estimates are estimates, and cost units
are not milliseconds. This automatic gate complements operator review; it is
not proof of negligible I/O or production capacity.

Bounds are fixed: at most 1024 heights, at most 10000 rows per transaction/flow/
incidence probe, and at most 128 summary addresses. Every large input is bounded
before its joins/grouping. The cap-plus-one sentinel marks overflow
`incomplete_row_budget`; it is never a passing full-window measurement. Reduce
the range and rerun explicitly rather than silently truncating a question or
promoting a partial result.

Statements are capped at 3 seconds, locks at 200ms, idle transactions at 5 seconds,
work_mem at 1MiB, no parallel gather/JIT, temp files at most 16MiB and one DB
connection. Source operator mode sets its transaction temp cap; view mode requires
an already restricted role cap and does not request new privileges. All work
rolls back. A failed probe rolls back only its savepoint and reports unavailable
plus SQLSTATE; it does not become zero activity or poison later measurements.
An unavailable/incomplete execution exits 1; measured contradictions exit 2.
Plan-only output is not a data pass.

## Remaining verification gates

A report may establish `scope_consistent=true` only for its fully measured
interval and admitted fields. It cannot remove these gates:

- Compare registered historical segments against independently decoded node/raw
  transactions using the exact deployed parser and activation rules; preserve
  exact zatoshi direction/pool totals and expected records, including zero cases.
- Reconstruct transparent inputs/outputs and address incidences independently,
  including coinbase, addressless scripts, spend resolution and reorg rollback.
- Reconcile complete selected-address histories with current maintained sums,
  counts and earliest/latest observations. `first_seen` is not first funding.
- Cover the whole advertised historical range with bounded, reproducible
  segments and identify untested gaps explicitly. Sampling cannot certify the
  unsampled intervals or unpublished source columns.

Never flip `flow_completeness` or another readiness/certification flag from this
operator report alone. Normal replication/admission freshness is necessary but
separate from independent historical completeness.

## Verification

```sh
node --test server/api/test/v1/ask-data-confidence.test.js
ASK_DATA_CONFIDENCE_TEST_POSTGRES=1 ASK_LOGICAL_PG_BIN=/absolute/pg16/bin node --test server/api/test/v1/ask-data-confidence.test.js
```

The native fixture initializes only a disposable PG16 database on a 0700 private
Unix socket, without TCP listeners. It creates deliberately missing heights,
wrong canonical links, null/exact amounts, repeated flows/incidences, orphan
references and contradictory summaries, then checks real aggregate results.
Fixture setup may write/ANALYZE its synthetic tables; the audit itself remains
read-only. A skipped native case is not an SQL execution pass. Production probes
must still be staged and reviewed by the trusted operator.

## Scoped verification — 2026-10-16 UTC

The opt-in native suite passed **9/9 with zero skips** on PG16.15 and Node
22.22.1 in a disposable cluster. The service used postgres, PrivateTmp, Unix
sockets only, a 512MiB cgroup cap and 64 tasks. It did not restart or modify a
production cluster.

An indexed September timestamp anchor selected mainnet heights **3467591–3467654**
(64 blocks, starting at Unix second **1788220877**). Source and restricted-reader
analytics measurements at **11:28:20 UTC** both returned 64 blocks with matching
first/last public hashes, no missing heights/timestamps, and **82 recorded flow
rows totaling exactly 162657030213 zatoshis**. All measured flow value, direction,
pool and duplicate checks were zero; source-only transaction/canonical link
checks were also zero. Source returned 287 transactions including coinbase;
the published view returned 223 transactions and excludes coinbase. This is a
comparison of recorded aggregates, not an independent row-by-row chain replay.

Both address probes were refused before execution. Their estimated costs were
about 11.69 million on source and 5.42/6.11 million on analytics; the target
summary plan also scanned the full addresses relation. Thus the overall reports
remain `complete=false` and history completeness remains unverified. No budget,
index, grant, admission or readiness setting was changed to obtain a pass.

Index inspection found source incidences indexed by `(address,block_height,
tx_index,txid)` and separately by `txid`; target has `(txid,block_height)` and
`(block_time,address)`. A future transaction-led audit can take bounded canonical
transaction seeds and use indexed lateral txid lookups. It must retain explicit
seed/incidence overflow sentinels. A source candidate using all transactions in
this 64-block window still exceeded the cost gate, so smaller explicit batches
are needed there. Analytics seeds from the published transaction view exclude
coinbase. Neither seed strategy can find incidence rows whose transaction is
absent, certify every historical address incidence, or justify removing the
original orphan/full-history gates. These candidates were explained only.

Sanitized native output, original plans, measured aggregates, index definitions,
public block anchors and selected source hashes are retained locally under
`/private/tmp/ask-beta-data-20261016/`; this temporary path is evidence for the
operator and is not an off-host backup or deployed application artifact.
