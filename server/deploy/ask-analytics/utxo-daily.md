# Daily transparent UTXO-set dataset (batch 6)

Proposal, not applied. The owner approves each rollout step. `utxo_daily` ships
`published:false` in `lib/ask/research-catalogue.js` until step 10.

## Rollback (written first; reverse order, each step safe on its own)

- **Before step 10:**
  0. Revoke the reader grant first if applied: `REVOKE ALL ON analytics_public.utxo_daily_query FROM ask_public_reader;`
  1. Re-deploy the previous worker drop-in (`zzzzzzzzzzzzzzzzzzzz-ask-poolspub-20261102.conf` is the current last) and restore the admission backup taken at step 7.
  2. Restore the recovery config/state backups from step 5 (see `feed-recovery.md`, "Adding a replicated table").
  3. On mainnet: `utxo-daily-source-v1-rollback.sql`.
  4. On the store: `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);`
  5. On the store: `utxo-daily-v1-rollback.sql`. It refuses while either table is still subscribed.
- **After step 10:** revert the publish PR first, re-deploy the previous worker build, and restore the previous `analytics-availability.py`. Then follow the steps above.
- **If the subscription disables itself at step 4:** run the source rollback, `REFRESH PUBLICATION WITH (copy_data=false); ENABLE`, then `feed-recovery.md`.

No existing dataset reads the new tables. `test/v1/ask-logical-sync.test.js` (PG16, CI) exercises:
- the copy and the reviewed column list;
- an in-place morning repair arriving through replication;
- admission readiness and the reader grant;
- the refused early destination rollback and the full rollback order.

## Dataset

### `utxo_daily` (replicated `utxo_age_daily` plus `transparent_realized_cap_daily`)

`date, utxos, unspent, age_lt_1m, age_1_3m, age_3_6m, age_6_12m, age_1_2y, age_gt_2y, spent_outputs, cdd, avg_dormancy_days, realized_cap_usd, avg_cost_basis_usd`. There is one row per completed UTC date from 2016-10-28.

- **Source:** the explorer's `compute-utxo-age` and analytics-history jobs (`server/lib/utxo-age.js`, `server/jobs/backfill-analytics-history.js`).
  - The snapshot is the transparent UTXO set (outputs with value > 0) at 23:59:59 UTC.
  - Age runs from the creating block's date: bands under 30, 30–89, 90–179, 180–364, 365–729 and 730+ days.
  - `spent_outputs`, `cdd` (coin-days destroyed: ZEC × days held) and `avg_dormancy_days` cover outputs spent on that date.
  - `realized_cap_usd` values each unspent output at the daily USD price of its creation date; `avg_cost_basis_usd` is that per ZEC.
- **Units:**
  - `unspent` and the age columns are zatoshi stocks.
  - `cdd` is rounded to 4 decimals and `avg_dormancy_days` to 4.
  - `realized_cap_usd` is rounded to cents and `avg_cost_basis_usd` to 4 decimals.
  - The plan-quality unit lineage now treats every `*_usd` column as USD; it previously recognised only a column named `usd`.
- **Guard:** the realized cap joins only when both summaries report the same UTXO count for the date. If they disagree, for example because one job ran in between, it is NULL rather than mixing two snapshots.
- **Revisions:** the jobs repair the last seven completed dates each morning (upsert by date). Replication carries the updates, so recent dates can change slightly.
- **Privacy:** these are set-wide totals, one row per date, so they cannot help link shielded activity. `created_at` is job bookkeeping and stays private. `transparent_key_exposures` and every other excluded table stay unpublished.

## Evidence (read-only, 2026-11-02)

- **Rows:** 3,657 per table, 2016-10-28 → 2026-11-01, with no gaps, NULLs or zero totals.
- **Consistency:**
  - the age bands sum to `total_unspent_zat` on every date;
  - `unspent_count` equals `utxo_count` on every date;
  - `total_unspent_zat` equals `analytics_history_daily.transparent_supply_zat` on all 3,657 dates;
  - `total_unspent_zat` equals the node-reported transparent pool at the day-end block on all 35 overlapping dates.
- **View over the mainnet tables under the reader's limits** (`work_mem=1MB`, `temp_file_limit=16MB`): 3,657 rows in 4 ms, with no temp files.
- **Load:** a one-time copy of about 7,300 narrow rows, then up to 7 upserts per table each morning.

## Rollout (owner approval at each host step)

0. **Check the alerts:** healthy with 15 required datasets, and no `recovery_relations_drift` or `reader_view_drift`.
1. **Merge this PR.** `utxo_daily` stays unpublished.
2. **Store migration:** `psql -d ask_analytics -f utxo-daily-v1.sql`. It contains no reader grant.
3. **Mainnet source migration:** `utxo-daily-source-v1.sql`.
4. **Copy:** `REFRESH PUBLICATION WITH (copy_data=true)`. Both new tables must reach `r` with errors unchanged.
5. **Recovery repin:** add both tables through `feed-recovery.md`, for 19 relations. `recovery_relations_drift` fires until then; that is expected.
6. **Copy check:** store row counts equal mainnet for both tables.
7. **Worker build at the merge commit** plus the admission script, then restart.
   - Confirm a live `sql_query` on `blocks` succeeds.
   - **Only then** apply `utxo-daily-grant-v1.sql`, and confirm there is no `reader_view_drift`.
8. **Verify as the reader with its limits.** Set them before the role: `SET LOCAL temp_file_limit='16MB'; SET LOCAL work_mem='1MB'; SET LOCAL ROLE ask_public_reader;`. Then check:
   - all columns equal the same query on mainnet, row for row;
   - `unspent` equals `value_pools_daily.transparent` on every overlapping date.
   - 2026-11-03 result: 3,658 rows (2016-10-28 → 2026-11-02) identical to mainnet on all 14 columns (same MD5) in 45 ms under the reader limits; no NULL realized cap; `unspent` equal to `value_pools_daily.transparent` on all 36 overlapping dates.
9. **Live `sql_query`** still rejects `utxo_daily`.
10. **Publish PR:**
    - Deploy the publish worker build before merging.
    - Then merge and deploy `analytics-availability.py`.
    - After Deploy API, verify with a live `sql_query` that **reads the value columns**, not only `count(*)`.
    - **Prompt budget:** every published dataset adds its catalogue text to the model prompts, and `maximumCost` (`ask-budget.js`) refuses any request body over 48,000 bytes. The first publish draft took the classifier prompt to 48,257 bytes, and 8 tests failed. The trimmed text measures 47,535 (classifier) and 44,425 (agent) bytes. The next dataset needs a prompt-budget change first.
