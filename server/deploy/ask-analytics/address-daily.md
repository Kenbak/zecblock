# Daily transparent address summary and query-shape telemetry

Proposal, not applied. Nothing here has run against the dedicated analytics
database, the worker or the host. The owner approves each rollout step.

## Why

A 162-question field test found queries that exceed the worker budget on every
model, notably per-day distinct-address counts over `address_activity`
(eval case `daily_address_incidences`). Zift agents and visitors write
arbitrary SQL, so the store needs (1) evidence of which query shapes are heavy,
collected without storing their SQL, and (2) maintained summaries for shapes
already known to be heavy.

## `address_daily`

One row per completed UTC date with canonical blocks in core coverage
(`analytics_meta.address_daily`, published as `analytics_public.address_daily_query`).
All columns are exact integer counts.

| Column | Meaning (over canonical `address_activity` rows of that UTC date) |
|---|---|
| `active_addresses` | `count(DISTINCT address)` |
| `sending_addresses` | `count(DISTINCT address) FILTER (WHERE is_input IS TRUE)` |
| `receiving_addresses` | `count(DISTINCT address) FILTER (WHERE is_output IS TRUE)` |
| `new_addresses` | addresses whose lowest-height canonical incidence in covered history falls on this date |
| `incidences` | `count(*)`: address/transaction incidences, including coinbase |
| `input_incidences` / `output_incidences` | `count(*)` with `is_input` / `is_output` true |

- Canonical membership is the same join as `address_activity_query`
  (transaction height/hash/time to a canonical block), within core coverage.
- An address can be both sending and receiving; flags are not disjoint.
- Addresses are transparent address strings, not people or wallets.
- Distinct counts are **not additive**: summing `active_addresses` over a month
  counts an address once per active day. `incidences` and `new_addresses` sum.
- `new_addresses` is "first seen within covered history". It is recomputed only
  for dirty dates: if an older day is corrected after later days were
  summarized, later `new_addresses` can be stale until those days are
  re-dirtied (`UPDATE analytics_meta.address_daily_dirty_days` or a full
  re-seed). Reorg corrections normally touch only the latest days.
- Days with canonical blocks but no transparent incidences get a zero row.

Mechanics (`address-daily-v1.sql`, refresh in `scripts/refresh-ask-summaries.js`):

- A separate dirty set, `analytics_meta.address_daily_dirty_days`, seeded with
  every block date. `track_address_day()` triggers on `blocks`, `transactions`
  and `address_transactions` (ENABLE ALWAYS, so replication apply fires them)
  mark the old and new UTC dates. TRUNCATE marks the dataset unready and every
  date dirty.
- `refreshAddressDaily` runs after the existing summaries in the same timer.
  It has its own advisory lock `(20261007,2)`, takes at most 7 consecutive
  calendar days per batch (operator maximum 31) and does nothing
  (`not-installed`) before the migration or while `address_activity` is not
  admitted (`source-unavailable`).
- `dataset_coverage` keeps every existing rule and adds: `address_daily` is
  ready only when no completed day is dirty. A pending day hides the summary;
  it never appears as empty history. The address backfill cannot make
  `activity_daily` or `flow_daily` unready.
- Readers get SELECT on `address_daily_query` only.
- `address-daily-v1-rollback.sql` restores the original `dataset_coverage`
  definition and drops the view, triggers, function, tables and dataset row.

## Measured cost (local, synthetic)

Disposable PostgreSQL 14.18 cluster on a developer laptop (`fsync=off`, warm
cache), synthetic rows from `test/fixtures/ask-address-daily-store.sql`, 7-day
batches. Not production numbers.

| Synthetic day | Incidences/day | Refresh per day | 7-day batch |
|---|---|---|---|
| September-2026-like | ~17,300 | 139 ms | 0.83–1.08 s |
| busy | ~115,000 | 1,149 ms | 7.1–9.0 s |

For the same synthetic month, reading 31 days:

| Query | Planner cost | Execution |
|---|---|---|
| `address_daily_query` | 15 | 0.4–0.6 ms |
| raw per-day correlated `address_activity` (current guidance) | 25.9 M (17k/day), 60.3 M (115k/day) | 6.8 s, 11.6 s |

The interactive research cost budget is 50 M and the queued budget 250 M.

**Production estimate, not measured.** `address_transactions` held 287 M rows
(108 GB) in June 2026; over ~3,650 days that averages ~80k incidences/day.
At the busy-day rate that is about 48 minutes of refresh execution warm. Cold
reads of the 108 GB table could multiply it several times; with ~520 batches
and the 15-second timer gap, expect a backfill of a few hours to under a day.
Every statement keeps the existing 60-second trusted timeout and 256 MB temp
limit. Measure the first batches on the host before relying on this estimate.

The per-row trigger on `address_transactions` adds one small upsert per
replicated address row, the same pattern already used on `transactions`.

## Query-shape telemetry

`ASK_RESEARCH_METRICS_ENABLED=true` (off by default) already counted fixed
outcome, duration, dataset and feature categories per UTC day. It now also:

- covers quick `/query` research runs (`mode:quick`) as well as queued jobs
  (`mode:queued`);
- adds features `distinct` and `subquery`, and a time-window span bucket
  (`unbounded`, `height`, `day`, `week`, `month`, `quarter`, `year`,
  `multi_year`) computed from literal time bounds in the parsed SQL;
- keeps a joint count per combination in
  `ask:{mainnet}:research-shapes:v1:<day>`, field
  `datasets|features|span|mode|outcome|duration` (sorted fixed tokens, `none` /
  `plain` when empty). New combinations past 1,000 per day count only as
  `overflow`. Both day hashes expire after 30 days.

Never stored: questions, SQL text or fingerprints, literals, aliases,
addresses, IPs or visitor IDs. Reads reject any field that is not built from
the fixed token lists. Metrics failures never change a query outcome.

Operator read (fixed day keys, no scans):

```
node server/api/scripts/read-ask-research-metrics.js 2026-10-30
node server/api/scripts/read-ask-research-metrics.js --days 7 --heavy
```

`--heavy` groups by `datasets|features|span|mode`, ranked by timeout+resource
outcomes, with outcome and duration distributions. A high-ranking shape is a
candidate for the next maintained summary; promoting one is a reviewed code
change, never automatic.

## Rollout plan

1. Merge this branch. Code without the migration is safe: `address_daily`
   queries fail as `dataset-warming` and the refresh reports `not-installed`.
   To avoid that interval, finish steps 2–4 before deploying API/worker code.
2. On the dedicated store, as the trusted postgres operator:
   `psql -d ask_analytics -f address-daily-v1.sql`. It takes short locks on
   `blocks`, `transactions` and `address_transactions` to add triggers
   (`lock_timeout` 500 ms; retry if replication apply holds them).
3. Deploy the updated `refresh-ask-summaries.js` to `/opt/zecblock-analytics`.
   The existing timer drains the backfill. Watch its JSON output
   (`address_daily.remaining_days`) and the first batch durations.
4. When `address_daily` reports `ready`, compare a few dates with the raw
   benchmark `address_incidence` through the normal queue (both measures must
   match exactly).
5. Deploy API and worker code. The agent and classifier guidance then prefer
   `address_daily` for per-day address counts.
6. Enable telemetry: set `ASK_RESEARCH_METRICS_ENABLED=true` in the worker
   environment, restart the worker, and read `--days 7 --heavy` after a week.

Rollback: deploy code without `address_daily`, then run
`address-daily-v1-rollback.sql`. Telemetry rollback is unsetting the flag; keys
expire within 30 days.
