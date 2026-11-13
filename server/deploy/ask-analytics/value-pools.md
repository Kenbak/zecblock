# Daily value-pool balances dataset (batch 5)

Proposal, not applied. The owner approves each rollout step. `value_pools_daily`
ships `published:false` in `lib/ask/research-catalogue.js` until step 10.

## Rollback (written first; reverse order, each step safe on its own)

- **Before step 10:**
  0. Revoke the reader grant first if applied: `REVOKE ALL ON analytics_public.value_pools_daily_query FROM ask_public_reader;`
  1. Re-deploy the previous worker drop-in (`zzzzzzzzzzzzzzzzzz-ask-swapspub-20261102.conf` is the current last) and restore the admission backup taken at step 7.
  2. Restore the recovery config/state backups from step 5 (see `feed-recovery.md`, "Adding a replicated table").
  3. On mainnet: `value-pools-source-v1-rollback.sql`.
  4. On the store: `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);`
  5. On the store: `value-pools-v1-rollback.sql`. It refuses while the table is still subscribed.
- **After step 10:** revert the publish PR first, re-deploy the previous worker build, and restore the previous `analytics-availability.py`. Then follow the steps above.
- **If the subscription disables itself at step 4:** run the source rollback, `REFRESH PUBLICATION WITH (copy_data=false); ENABLE`, then `feed-recovery.md`.

No existing dataset reads the new table. `test/v1/ask-logical-sync.test.js` (PG16, CI) exercises the copy, the reviewed column list, admission readiness, the reader grant, an orphan observation never appearing, the refused early destination rollback and the full rollback order.

## 2026-11-13 temp-limit fix (`value-pools-v3.sql`)

Every query that read `value_pools_daily` failed again with "temporary file size exceeds temp_file_limit", in Zift and in MCP `sql_query`.

- **Cause:** at about 69,000 observations, v2's `(height, hash)` join to `blocks` became a batched hash join. It streamed all ~3.57M block rows through temporary files and failed even with a 256 MB limit.
- **Fix:** v3 looks up each observation's block by primary key through an `OFFSET 0` lateral subquery, which the planner cannot flatten back into that join. Columns, types and results are unchanged, so the reader grant is kept.
- **Rehearsal:** on the store, in a rolled-back transaction, as `ask_public_reader` with `work_mem=1MB` and `temp_file_limit=16MB`. v3 ran in 0.38 s with no temporary files, and returned the same 46 rows as v2, with no difference in either direction.
- **Applied:** 2026-11-13. A reader query and a public `sql_query` read of balances both succeed.
- **Regression test:** `ask-research-value-pools.test.js` reads balances over one million blocks and 100,000 observations at the reader's limits. With v2 the test fails with the production error.
- **Rollback:** re-run `value-pools-v2.sql`.

## 2026-11-02 temp-limit fix (`value-pools-v2.sql`)

After publishing, any query that read a balance failed with "temporary file size exceeds temp_file_limit". The reader runs with `work_mem=1MB` and `temp_file_limit=16MB`. v1 materialized every observation's `pool_balances_zat` jsonb in a CTE that it read three times.
- **Fix:** v2 aggregates one row per date first, then reads the jsonb for those rows only. Rehearsed in a rolled-back transaction on the store under the reader's limits: 0.14 s, about 1 MB of temp, and 0 differing rows out of 35. Columns and the reader grant are unchanged.
- **Why step 8 missed it:** `SET ROLE ask_public_reader` does not apply the role's own settings. Verify as the reader with its limits set first (`SET LOCAL temp_file_limit='16MB'; SET LOCAL work_mem='1MB';` before `SET LOCAL ROLE`), and always run a live `sql_query` that reads real columns, not only `count(*)`.

## Dataset

### `value_pools_daily` (replicated `node_accounting_observations`)

`date, height, hash, observed_blocks, day_blocks, transparent, sprout, sapling, orchard, ironwood, lockbox, nsm, chain_supply`. There is one row per completed UTC date (block header time) that has at least one observed canonical block.

- **Authority:** the indexer stores one `getblockchaininfo` snapshot per tip it sees (`cipherscan-rust/src/db/observations.rs`, insert-only, `ON CONFLICT DO NOTHING`). The view takes the highest observed canonical block of each date, joining `(height, hash)` to the replicated canonical `blocks`. Observations of orphaned blocks never match (109 on 2026-11-02).
- **Columns:**
  - The pool columns are `pool_balances_zat` keys. A pool the node did not monitor is NULL, not zero.
  - `nsm` is `nsmValueBalanceZat`: signed, and 0 before NU7.
  - `chain_supply` is the node's `circulating_supply_zat`. It is the sum of every pool **including** the lockbox. It equalled `supply_daily.chain_supply` at all 35 day-end blocks checked on 2026-11-02. It is published as `chain_supply`, not "circulating", because `supply_daily.circulating_supply` excludes the lockbox.
- **Coverage:**
  - History starts 2026-09-28, when observation began. Every day so far misses a few blocks: 183 blocks in 35 days.
  - `observed_blocks`/`day_blocks` make this visible. When they differ, the snapshot can precede the date's last block.
  - Dates without an observation are absent, not zero.
- **Relation to `daily`:** `daily` carries indexer-maintained closing balances for the shielded pools over full history. They differ slightly from the node's values (e.g. 2026-11-01 Ironwood: daily 419,202,496,068,331 zat vs node 419,218,218,120,170 zat). The guidance tells the model to name the source used.
- **Privacy:** these are chain-wide totals, one row per date. Any node returns them, so they carry no per-transaction or per-address information and cannot help link shielded activity. `turnstile_daily` and every other excluded table stay unpublished.
- **Published columns:** `hash, height, observed_at, chain, nsm_balance_zat, circulating_supply_zat, pool_balances_zat`.
- **Private:** `subsidy` (funding-stream addresses), `upgrades`, `source`, `poll_interval_ms`.

## Evidence (read-only, 2026-11-02)

- **Rows:** 40,813 observations from height 3,498,854 (2026-09-28). About 1,150 new rows a day. Reviewed columns total 11 MB.
- **View over the mainnet tables:** 35 completed dates in 0.53 s. The store adds the coverage join.
- **Load:** a one-time copy of ~40k narrow rows, then one insert per block.

## Rollout (owner approval at each host step)

0. **Check the alerts:** `analytics-availability.py` reports healthy, with 14 required datasets and no `recovery_relations_drift` or `reader_view_drift`.
1. **Merge this PR.** `value_pools_daily` stays unpublished.
2. **Store migration:** `psql -d ask_analytics -f value-pools-v1.sql`. One new dataset row appears unready and is reported as warming. It contains **no reader grant**.
3. **Mainnet source migration:** `value-pools-source-v1.sql`.
4. **Copy:** `REFRESH PUBLICATION WITH (copy_data=true)`. Watch the new table reach `r`; error counts must stay unchanged and every other table must stay `r`.
5. **Recovery repin:** add `public.node_accounting_observations` through the reviewed procedure in `feed-recovery.md`, for 17 relations. Until this step, `recovery_relations_drift` fires; that is expected.
6. **Copy check:** the store row count equals the mainnet count up to the current tip.
7. **Worker build at the merge commit:** deploy it, back up the admission script and install the new one, then restart.
   - Confirm a live `sql_query` on `blocks` succeeds.
   - **Only then** apply `value-pools-grant-v1.sql`, and confirm `blocks` still succeeds and the alert has no `reader_view_drift`.
   - The worker's guard refuses every query while the reader can select a view the running build does not list (2026-11-02 incident).
8. **Verify as `ask_public_reader`:**
   - the dates and `chain_supply` equal the same query on mainnet, row for row;
   - `chain_supply` equals `supply_daily.chain_supply` on every date whose snapshot is the date's last block;
   - each `chain_supply` equals the sum of its pool columns.
   - 2026-11-02 result: 35 dates identical to mainnet; `chain_supply` equal to the pool sum and to `supply_daily` on all 35 (same day-end block every date); no NULL pool; NSM 0 throughout.
9. **Live `sql_query`** still rejects `value_pools_daily`.
10. **Publish PR:** it removes `published:false` and adds `value_pools_daily` to `REQUIRED_DATASETS` in both scripts.
    - **Before merging, deploy a worker build of the publish commit.** The worker enforces `published` itself, and so does the API after its deploy.
    - Then merge, deploy `analytics-availability.py`, and verify with a real MCP `sql_query` once Deploy API has finished.
