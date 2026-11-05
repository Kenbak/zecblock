# Supply and issuance research datasets (batch 1)

Proposal, not applied. The owner approves each rollout step. Both datasets ship
`published:false` in `lib/ask/research-catalogue.js`: the API, agent guidance,
MCP `sql_catalogue`, examples and eval cases ignore them until step 8 below.

## Datasets

### `supply_daily` (replicated node archive)

One row per completed UTC date from mainnet `chain_supply_daily` (migration
032): chain state at the last canonical block of that date, reconstructed from
node `getblock` `chainSupply.chainValueZat`. Permanent history from 2016-10-28.

| Column | Meaning |
|---|---|
| `date` | UTC date (completed days only) |
| `height`, `hash`, `timestamp` | last canonical block of that date; Unix seconds |
| `chain_supply` | all ZEC in every value pool, **including the NU6 lockbox**: total supply |
| `lockbox` | deferred development-fund balance (see below); NULL from NU7 |
| `circulating_supply` | `chain_supply - lockbox`; NULL from NU7 |
| `net_change` | `chain_supply` minus the previous date; NULL when that date is absent |

- All amounts are exact integer zatoshis. `chain_supply`, `lockbox` and
  `circulating_supply` are stocks: never summed across dates.
- `net_change` is net issuance. It is not gross subsidy: it is lower when a
  coinbase claims less than allowed, and it can go negative after NU7.
- Idle dates repeat the last state (archive rule).
- A row whose `(height, hash)` is not a canonical replicated block is hidden,
  and the next date's `net_change` becomes NULL rather than bridging the gap.
- Readiness: its own `dataset_coverage` row (`supply_daily`), set by
  `ask-core-admission.js` from the subscription's table state, plus core
  admission. Not ready means the query fails with `dataset-warming`; the
  history is never shown as empty.

`lockbox(h)` = 0 below 2,726,400; otherwise
`18,750,000 × (h − 2,726,399) − (7,875,000,000,000 if h ≥ 3,146,400)`. This is
12% of the 1.5625 ZEC subsidy per block, minus the one-time 78,750 ZEC NU6.1
disbursement. It matched the node's `lockbox` pool balance exactly at height
3,537,015 (7,324,050,000,000 zat, `node_accounting_observations`). The node's
own `circulating_supply_zat` includes the lockbox. This dataset's
`circulating_supply` deliberately excludes it, and the catalogue says so.

### `issuance` (derived view, no table)

One row per canonical block (`blocks` within core coverage):
`height, hash, timestamp, subsidy, miner_subsidy, founders, funding_streams,
lockbox, lockbox_disbursed, fees`.

- `subsidy = miner_subsidy + founders + funding_streams + lockbox`, in zatoshis.
- **Founders:** `founders` is 20% below 1,046,400.
- **Funding streams:** `funding_streams` are paid development-fund streams:
  - ZIP 1014 ECC 7% + ZF 5% + Major Grants 8%, from 1,046,400 to 2,726,400;
  - ZCG/Major Grants 8% from 2,726,400.
- **Lockbox:** `lockbox` is the deferred 12% from 2,726,400.
- **Disbursement:** `lockbox_disbursed` is the one-time 78,750 ZEC at 3,146,400. It moves lockbox funds and is not new issuance.
- **Fees:** `fees` is `blocks.total_fees`, NULL when unknown. Miner revenue is `miner_subsidy + fees`.
- **Maximum, not actual:** these are the maximum claimable consensus allocations. Summed `subsidy` can exceed
  archived chain supply: early 2016 blocks claimed less. At height 629 the
  schedule sums to 12,383,437,500 zat, against an archived 12,302,365,136.
- **After NU7:** every allocation column is **NULL from NU7 activation (3,543,405)**. The node
  applies ZIP 234 there: issuance depends on chain state, and its RPC reports
  that far-future heights need the parent block. A height-only formula would
  be a guess. Post-NU7 issuance belongs with the batch 5 NU7/NSM accounting work,
  from per-hash node observations.
- **Readiness:** gated by canonical core admission alone, like `blocks`
  (`coreGatedIds`).

**Verification of the schedule (2026-10-31).**
- The schedule matched mainnet node `getblocksubsidy` (zakurad), checking subsidy, founders, streams, lockbox and miner, at all 423 checked heights:
  - every boundary ±1: 1, 9,999/10,000, 19,999/20,000, Blossom, both halvings, NU6, NU6.1, NU6.2 3,364,600, NU6.3 3,428,143, and 3,543,404;
  - plus 400 seeded random heights below NU7.
- A bisection over 20,000–3,543,406 found change points only at 653,600, 1,046,400, 2,726,400, 3,146,400 (stream recipient rename only) and 3,543,405.
- `test/v1/ask-research-supply-issuance.test.js` executes the migration's own view text against those node vectors.

## Measured cost (analytics host, read-only, 2026-10-31)

- **Full history:** per-day aggregation of the subsidy expression over all of `blocks_query` (3,537,026 rows), run as `ask_public_reader` with `work_mem=1MB` and no parallelism:
  - 2,050 ms execution, planner cost 167,710 (the interactive research budget is 50,000,000);
  - `Buffers: shared hit=2,648,280`, no reads: `blocks` (811 MB) is already resident in shared buffers.
  - It fits the 3 s quick limit but has little headroom. Long-range issuance sums suit the queued path (30 s).
- **Bounded windows:** queries bounded by timestamp use the existing `ask_blocks_time_idx`.
- **Initial copy:** `chain_supply_daily` is 3,655 rows, 760 kB total on the primary. One archive row is written per day.
- **No backfill:** `supply_daily` and `issuance` add no trigger, dirty set or refresher batch. Nothing scans large tables in the background. This is the difference from the `address_daily` incident.

Host condition observed before rollout:
- The PostgreSQL cgroup sat at `memory.high` (25.76 of 25.77 GB, mostly page cache).
- `memory.events high` had risen from 459 after the incident to 507–508.
- Each increment holds research admission for 30 s (`ask-memory-pressure.js`).
- Batch 1 adds no background reads, but the existing hold behaviour applies to any query.

## Rollout (one step at a time, owner approval at each host step)

0. **Prerequisite:** deploy PR #206's `analytics-availability.py` and
   `query-load.py` to `/opt/zecblock-ask-operations`. The deployed copies
   still check `count(*)=6`, so a 7th `dataset_coverage` row would fire the
   research-readiness alert, as on 2026-10-30. Confirm with one manual run
   that the output shows `"healthy":true` and `warming_datasets:[]`.
1. **Merge this PR.** The API auto-deploys with both datasets unpublished: no
   behaviour change. The worker on the host is untouched.
2. **Destination migration, on the analytics store** (trusted postgres
   operator): `psql -d ask_analytics -f supply-issuance-v1.sql`.
   - It adds an empty `public.chain_supply_daily`, the `supply_daily` dataset row (unready, reported as warming), and two views. Locks: none on existing tables.
   - Check: `SELECT dataset,ready FROM analytics_public.dataset_coverage` shows `supply_daily|f` and the six required datasets `t`. The alert stays healthy.
3. **Source migration, on mainnet** (`zcash-mainnet`, `zcash_explorer_mainnet`):
   `psql -f supply-issuance-source-v1.sql`. Column grant and publication add
   only. This must come after step 2: a published table without its
   destination table stops apply, and `disable_on_error` would halt all
   research.
4. **On the analytics store:**
   `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=true);`
   (outside a transaction).
   - Watch `pg_subscription_rel` until `chain_supply_daily` reaches `r`, and confirm `pg_stat_subscription_stats` errors are unchanged.
   - Expect seconds for 760 kB.
5. **Deploy the worker and admission code** at this PR's merge commit:
   - New `/opt/zecblock-ask-datasets-<date>-<sha>` and a new
     `zecblock-ask-analytics.service.d` drop-in that keeps the existing env lines.
   - Update `/opt/zecblock-analytics/server/api/scripts/ask-core-admission.js` (the `supply_daily` mapping).
   - Restart the worker. Health 200.
6. **Verify on the host as `ask_public_reader`** (read-only):
   - `supply_daily` is ready.
   - Row count is about 3,65x.
   - The latest `chain_supply` equals the mainnet archive's latest row exactly.
   - `lockbox` at the latest date equals `18,750,000×(h−2,726,399)−7,875,000,000,000`.
   - `issuance` at heights 1,046,400, 2,726,400 and 3,146,400 matches the vectors above.
   - `sum(subsidy) − max(chain_supply)` over the archive's last height is ≥ 0 and stable.
   - `memory.events high` is unchanged across the checks.
7. **Live `sql_query`:** the datasets are still unpublished, so the public path
   must still reject them. Confirm `SELECT 1 FROM supply_daily` returns "not admitted".
8. **Publish PR:**
   - Remove `published:false` from both entries.
   - Add `supply_daily` to `REQUIRED_DATASETS` in `analytics-availability.py` and `query-load.py`.
   - On merge, the API auto-deploys. Then deploy the two ops scripts.
   - Verify through a real MCP `sql_query`: "What's the total supply?" via `SELECT date, chain_supply FROM supply_daily ORDER BY date DESC LIMIT 1`, plus an `issuance` year split.
   - Run the capped live eval pair (≤12 provider calls) on the four pending cases plus `mining_concentration_30d`. This needs separate approval for provider spend.

## Rollback (reverse order; each step is independent and safe on its own)

- **Before step 8:** nothing public uses the datasets.
  1. Re-deploy the previous worker drop-in (`zzzzzzzzzzz-ask-memory-20261029.conf` is the current last one) and the previous admission script.
  2. On mainnet: `supply-issuance-source-v1-rollback.sql` (publication drop and column revoke).
  3. On the store: `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);`
  4. On the store: `supply-issuance-v1-rollback.sql`. It refuses while the subscription still lists the table, so it cannot cause an apply error.
- **After step 8:**
  1. Revert the publish PR first: the API stops advertising the datasets and `REQUIRED_DATASETS` returns to six.
  2. Then follow the steps above.
- **If the subscription disables itself at step 4:** this happens on a schema mismatch.
  1. Run the source rollback.
  2. `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false); ALTER SUBSCRIPTION ask_public_core_v1 ENABLE;`
  3. Follow `replication-recovery-v1.sql` / `feed-recovery.md`.
  4. Verify admission returns `verified`.

The rollback order is exercised end to end in `test/v1/ask-logical-sync.test.js` (PG16, CI). That test copies the table into the subscription, refuses the destination rollback while it is still subscribed, then removes it in order. It then shows the subscription stays enabled and admission stays `verified`.
