# Mining, block timing and daily issuance research datasets (batch 2)

Proposal, not applied. The owner approves each rollout step. All four datasets
ship `published:false` in `lib/ask/research-catalogue.js`, so the API, agent
guidance, MCP `sql_catalogue`, examples and eval cases ignore them until step 8.

## Rollback (written first; reverse order, each step safe on its own)

- **Before step 8:** nothing public uses the datasets.
  1. Re-deploy the previous worker drop-in (`zzzzzzzzzzzzz-ask-datasets-20261031.conf` is the current last) and restore the admission backup taken at step 5.
  2. On mainnet: `mining-source-v1-rollback.sql`. This drops the four tables from the publication and revokes the column grants.
  3. On the store: `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);`
  4. On the store: `mining-v1-rollback.sql`. It refuses while the subscription still lists any of the four tables, so it cannot cause an apply error.
- **After step 8:**
  1. Revert the publish PR first. The API stops advertising the datasets and `REQUIRED_DATASETS` returns to seven.
  2. Restore the previous `analytics-availability.py` and `query-load.py`.
  3. Then follow the steps above.
- **If the subscription disables itself at step 4:** this happens on a schema mismatch.
  1. Run the source rollback.
  2. `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false); ALTER SUBSCRIPTION ask_public_core_v1 ENABLE;`
  3. Follow `replication-recovery-v1.sql` / `feed-recovery.md`.
  4. Verify admission returns `verified`.

The whole order is exercised in `test/v1/ask-logical-sync.test.js` (PG16, CI):
copy, the refused early destination rollback, a table dropped from the publication
(its dataset becomes unready), then source rollback, refresh and destination rollback,
ending with the subscription enabled and admission `verified`.

## Datasets

### `mining_daily` (replicated, from migration 028)

One row per completed UTC date and attributed pool: `date, pool, blocks, day_blocks`.
- **Source:** mainnet `analytics_history_daily.mining_pool_blocks`, written by the analytics history job from the shared pool registry (`server/api/mining-pools.js`: known coinbase tags and payout addresses).
- **Published columns:** only `date, anchor_height, anchor_hash, mining_pool_blocks`. Cohorts, USD cost basis, SOPR, fees, method and `computed_at` stay private.
- **Pool names:**
  - `Unknown` = unattributed blocks.
  - `Private Miner B` / `Unidentified #5` each name a single recurring payout address with no public owner.
  - Registry repairs re-label history: the repair of 2026-10-10/12 rewrote every date.
- **`day_blocks`:** every canonical block of the date, so `blocks/day_blocks` is a share of all blocks including `Unknown`.
- **Hiding rule:** a row whose `(anchor_height, anchor_hash)` is not a canonical replicated block is hidden.
- **Evidence (2026-10-31, read-only):** 3,655 dates, 2016-10-28 → 2026-10-30. Pool counts sum to **3,536,392** blocks, exactly heights 0–3,536,391.

### `software_daily` (replicated, from migration 023)

One row per completed UTC date and marker: `date, software, blocks, day_blocks`.
- **Source:** mainnet `block_software_daily(day, software, blocks)`, maintained by triggers from canonical blocks. `day` is days since 1970-01-01. Classifier v1 `ready=true`; the source step refuses otherwise.
- **Categories:**
  - `zebra`, `zakura`;
  - `other` (a zcashd marker);
  - `conflicting`;
  - `unknown` (no recognized marker);
  - `missing` (coinbase bytes unavailable).
- **Markers are self-reported:** `unknown` is not proof of zcashd.
- **Completed days only:** a day is shown only once the replicated canonical tip's header time has passed its end. Today's partial day is never shown.
- **Write load:** the source table is updated once per block. Replication is one small row update per block (about every 75 s).
- **Evidence:** 4,843 rows (day 17102 → 20757). All-time totals: unknown 3,398,609, zebra 105,790, zakura 33,021, missing 0.

### `block_timing` (replicated receipts plus canonical blocks)

One row per canonical block that ZecBlock received:
`height, hash, timestamp, miner, first_seen, lag_seconds, observed_by`.
- **What it powers:** the same capture as zecblock.com/mining#timing (`server/api/lib/first-seen.js`, `observation-lag.js`), now queryable.
- **Sources:**
  - `block_observations`: local-node 1 s tip poll, from 2026-09-23, about 44k rows.
  - `captured_blocks`: node block stream, from 2026-10-12, about 23k rows.
  - Only `hash, height, first_seen_at` are published from each. Raw block bytes, coinbase, payout address, previous hash, network and poll metadata stay private.
- **Columns:**
  - `first_seen`: the earliest receipt, in Unix seconds with millisecond precision.
  - `lag_seconds`: `first_seen − timestamp` (the miner-written header time).
  - `observed_by`: names the collector.
  - `miner`: the payout address, as in `blocks`.
- **Reading the lag:**
  - Negative means the header time is later than the receipt (the miner clock runs ahead).
  - Positive mixes clock offset with propagation to ZecBlock. One observer cannot separate the two, so the catalogue never calls it propagation delay.
- **Coverage:**
  - Receipts for orphaned blocks (143 of the stream's rows) are excluded by the canonical `(height, hash)` join.
  - Blocks neither collector saw are absent, not zero.
- **No deletes:** both source tables are insert-only (stream rows are later updated only to prune raw bytes).
- **Readiness:** requires **both** tables to be subscribed. `ask-core-admission.js` now maps a dataset to a list of tables, all of which must be in state `r`. For the existing single-table datasets the result is unchanged.

### `issuance_daily` (derived view, no table)

One row per completed UTC date:
`date, first_height, last_height, blocks, subsidy, miner_subsidy, founders, funding_streams, lockbox, lockbox_disbursed`.
- **Range:** each date covers heights from the previous `supply_daily` date's height + 1 through this date's height. Genesis is the start of 2016-10-28.
- **Closed form:** constant-subsidy eras multiply; the slow start sums an arithmetic series. The per-block rules are exactly those of `issuance_query`.
- **NULL rules:** a date with a missing previous date is NULL, and every allocation is NULL once a date reaches NU7 (3,543,405).
- **Date assignment:** dates are assigned by archive height. A block whose header time falls across midnight can land on the neighbouring date compared with `issuance` bucketed by timestamp.
- **Evidence (analytics host, read-only, 2026-10-31):**
  - Over all 3,655 dates, the sums equal `issuance_query` summed over heights 0–3,536,391 for every column:
    - subsidy 1,701,561,250,000,000;
    - miner 1,361,249,000,000,000;
    - founders 210,000,000,000,000;
    - streams 115,124,900,000,000;
    - lockbox 15,187,350,000,000;
    - disbursed 7,875,000,000,000.
  - Every boundary date (10,000, 20,000, Blossom, both halvings, NU6.1) also matched brute force.
- **Why it exists:** it answers full-history issuance within the 3 s quick limit. The per-block equivalent timed out after batch 1's rollout (#210).

## Measured cost (read-only, 2026-10-31)

- **`issuance_daily` full-history yearly split:** run as `ask_public_reader` with `work_mem=1MB` and no parallelism: **126.7 ms**, `shared hit=14,620`, no reads. `memory.events high` was unchanged (556).
- **`block_timing`, all history:** a per-payout aggregate over every receipt took 487.7 ms on mainnet (`shared hit=154,897`). It grows by about 2,300 receipts per day. Guidance and the example bound queries by timestamp, which uses `ask_blocks_time_idx`; the view also starts at the first collected height via subscriber-only height indexes.
- **Initial copy, column-limited:** about 3.5 MB of observations, 1.8 MB of stream receipts, 0.5 MB of pool history and 0.2 MB of software counts.
- **No backfill:** no trigger, dirty set or refresher. Ongoing apply is a few row changes per block.
- **Alerts:** the deployed alerts already use the named `REQUIRED_DATASETS` (seven). The four new `dataset_coverage` rows show as `warming_datasets` until ready and never fire the readiness alert. `host-health.py` reads no dataset list.

## Rollout (one step at a time, owner approval at each host step)

0. **Confirm the alert is healthy:** `analytics-availability.py` shows `"healthy":true`.
1. **Merge this PR.** The API auto-deploys with all four datasets unpublished: no behaviour change.
2. **Destination migration, on the store:** `psql -d ask_analytics -f mining-v1.sql`.
   - Check: `dataset_coverage` lists the four new rows as `f`, and the seven required rows stay `t`.
   - The alert stays healthy, with the new rows warming.
3. **Source migration, on mainnet:** `psql -d zcash_explorer_mainnet -f mining-source-v1.sql`. This must come after step 2.
4. **On the store:** `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=true);`
   - Watch the four tables reach `r`.
   - `pg_stat_subscription_stats` errors must be unchanged.
5. **Deploy the worker build and admission script** at this PR's merge commit:
   - back up the admission script;
   - add a new drop-in;
   - restart, and check health 200.
6. **Verify on the host as `ask_public_reader`:**
   - all four rows ready;
   - `mining_daily` pool counts sum to the canonical block count through the latest date;
   - `software_daily` day totals equal canonical blocks per day;
   - `block_timing` matches `/v1/mining/observation-lag` observed counts for 7d;
   - `issuance_daily` totals equal the `issuance` totals above;
   - `memory.events high` steady.
7. **Live `sql_query`** still rejects the four datasets ("not admitted").
8. **Publish PR:**
   - Remove `published:false`.
   - Add `mining_daily`, `software_daily` and `block_timing` to `REQUIRED_DATASETS` in both scripts; issuance_daily rides on supply_daily but has its own row, so add it too.
   - On merge, deploy the two scripts.
   - Verify with real MCP `sql_query`: pool shares for 30 days, a software share, the timing example, and the full-history issuance split.
