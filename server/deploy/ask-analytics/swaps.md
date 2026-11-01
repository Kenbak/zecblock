# Cross-chain swap detail dataset (batch 4)

Proposal, not applied. The owner approves each rollout step. `swap_daily` ships
`published:false` in `lib/ask/research-catalogue.js` until step 10.

## Rollback (written first; reverse order, each step safe on its own)

- **Before step 10:**
  1. Re-deploy the previous worker drop-in (`zzzzzzzzzzzzzzzz-ask-reorgs-20261101.conf` is the current last) and restore the admission backup taken at step 7.
  2. Restore the recovery config/state backups from step 5 (see `feed-recovery.md`, "Adding a replicated table").
  3. On mainnet: `swaps-source-v1-rollback.sql`. It restores the original nine `cross_chain_swaps` columns and drops the venue table in one transaction.
  4. On the store: `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);`
  5. On the store: `DROP TABLE IF EXISTS analytics_meta.swap_amount_backfill;` then `swaps-v1-rollback.sql`. It refuses while the venue table is still subscribed; dropping the amount columns earlier would stop apply.
- **After step 10:** revert the publish PR first, re-deploy the previous worker build, and restore the previous `analytics-availability.py`. Then follow the steps above.
- **If the subscription disables itself at step 4:** run the source rollback, `REFRESH PUBLICATION WITH (copy_data=false); ENABLE`, then `feed-recovery.md`.

The existing `swaps` dataset is unaffected throughout: its view reads only the original nine columns.
`test/v1/ask-logical-sync.test.js` (PG16, CI) exercises the in-place re-publication (no re-copy, no apply error), new rows arriving with amounts, the backfill, the refused early destination rollback, the full rollback order and continued replication of the nine columns afterwards.

## Dataset

### `swap_daily` (replicated `cross_chain_swaps` amounts plus `crosschain_venue_actions`)

`date, venue, direction, chain, token, swaps, zec, usd, missing_zec, missing_usd` — successful swaps per completed UTC date, venue (`near-intents`, `maya`, `thorchain`), direction and counterparty chain/token.
- **NEAR Intents:** same filter and direction as `swaps` (`SUCCESS`, exactly one side on `zec`). `zec` comes from the ZEC-side amount (`dest_amount` for inflow, `source_amount` for outflow); `usd` is the counterparty-side USD with 0 as unavailable, as in `swaps`.
- **Maya/THORChain:** `action_type='swap'` and `status='SUCCESS'`; refunds are excluded. Direction follows the chains (inflow, outflow, otherwise internal), equal to the provider's own direction for all 14,106 stored successes on 2026-11-01. `zec` is `zec_amount_zat`.
- **Privacy:** the view never exposes one swap's ZEC amount or time. `flows` already publishes exact shield/deshield amounts with timestamps, so per-swap ZEC amounts would let SQL rebuild amount-and-time linkage edges, which the dataset policy forbids. Groups with fewer than 5 swaps on a date fold into chain/token `other`; `zec` and `usd` are whole units, rounded, and NULL where fewer than 5 swaps carry the value. Late-indexed swaps can change a completed date's sums; rounding keeps the difference from revealing an exact amount.
- **Units:** `zec` is whole ZEC (not zatoshis); `usd` is whole provider-reported USD. `missing_zec`/`missing_usd` count swaps without the value.
- **History:** NEAR Intents from 2026-06-14, Maya from 2025-05-21, THORChain from 2026-10-02. Earlier absence is not zero.
- **Published columns:** `cross_chain_swaps` adds `source_amount, dest_amount` to its nine; `crosschain_venue_actions` publishes `venue, id, action_type, status, swap_created_at, source_chain, source_token, dest_chain, dest_token, zec_amount_zat, source_amount_usd, dest_amount_usd`.
- **Private:** deposit addresses, memos, senders, recipients, every tx hash (`zec_txid`, source/dest/NEAR hashes), ZEC addresses, matching state, provider payloads, raw asset names, base-unit amounts and observation timestamps.

## Evidence (read-only, 2026-11-01)

- **Rows:** 118,699 successful NEAR Intents swaps; Maya 13,661 swap successes (plus 446 refunds, 4 processing); THORChain 445 swap successes (plus 167 refunds). No NEAR ZEC-side amount is NULL; one THORChain success has a zero ZEC amount.
- **View over the mainnet tables:** full history 80 ms, one date 30 ms, 52 ms for October with a date filter. NEAR Intents sums to 117,014 swaps and 923,849 ZEC rounded per group, against the exact total of 923,851 ZEC. 282 NEAR, 841 Maya and 34 THORChain rows are folded `other` groups.
- **Backfill export:** `SELECT id, source_amount, dest_amount` over all 118,703 rows is 3.2 MB in 0.15 s with 10 MB RSS; 1–20,000 is 70 KB in 0.02 s. IDs run 1–14,705,719.
- **Load:** the venue table copy is about 14.5k narrow rows; ongoing writes are a few hundred swaps a day.

## Rollout (owner approval at each host step)

0. **Check the alerts:** `analytics-availability.py` reports healthy with 13 required datasets, and no `recovery_relations_drift` (needs the recovery-drift alert and repin first).
1. **Merge this PR.** `swap_daily` stays unpublished.
2. **Store migration:** `psql -d ask_analytics -f swaps-v1.sql`. One new row appears unready and is reported as warming.
3. **Mainnet source migration:** `swaps-source-v1.sql`.
4. **Copy:** `REFRESH PUBLICATION WITH (copy_data=true)`. Watch the venue table reach `r`; `cross_chain_swaps` must stay `r` without a re-copy, and errors unchanged.
5. **Recovery repin:** add `public.crosschain_venue_actions` through the reviewed procedure in `feed-recovery.md`.
6. **Backfill, bounded:**
   - On the store: `CREATE UNLOGGED TABLE analytics_meta.swap_amount_backfill(id integer PRIMARY KEY,source_amount numeric,dest_amount numeric);` (no grants).
   - Stream the export without a file: `ssh zcash-mainnet "sudo -u postgres psql -X -d zcash_explorer_mainnet -c '\copy (SELECT id,source_amount,dest_amount FROM public.cross_chain_swaps ORDER BY id) TO STDOUT'"` piped into `sudo -u postgres psql -X -d ask_analytics -c '\copy analytics_meta.swap_amount_backfill FROM STDIN'` on the store.
   - Measure the first batch: `-v lo=1 -v hi=20000 -f swaps-backfill-v1.sql` under `/usr/bin/time -v`. Then run 500,000-id ranges up to the max id.
   - Verify zero mismatches: `SELECT count(*) FROM public.cross_chain_swaps s JOIN analytics_meta.swap_amount_backfill b USING(id) WHERE s.source_amount IS DISTINCT FROM b.source_amount OR s.dest_amount IS DISTINCT FROM b.dest_amount;` then drop the staging table.
7. **Worker build at the merge commit:** deploy it, back up the admission script and install the new one, then restart and check health 200.
8. **Verify as `ask_public_reader`:**
   - `sum(missing_zec)` is 0;
   - NEAR Intents swap counts per date equal the `swaps` dataset;
   - venue totals equal the mainnet source sums within rounding.
9. **Live `sql_query`** still rejects `swap_daily`.
10. **Publish PR:** it removes `published:false` and adds `swap_daily` to `REQUIRED_DATASETS`.
    - **Before merging, deploy a worker build of the publish commit.** The worker enforces `published` itself.
    - Then merge, deploy `analytics-availability.py`, and verify with real MCP `sql_query`.
