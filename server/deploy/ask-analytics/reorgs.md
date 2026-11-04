# Reorg research datasets (batch 3)

Proposal, not applied. The owner approves each rollout step. Both datasets ship
`published:false` in `lib/ask/research-catalogue.js` until step 8.

## Rollback (written first; reverse order, each step safe on its own)

- **Before step 8:**
  1. Re-deploy the previous worker drop-in (`zzzzzzzzzzzzzzz-ask-datasets3-20261031.conf` is the current last) and restore the admission backup taken at step 5.
  2. On mainnet: `reorgs-source-v1-rollback.sql`.
  3. On the store: `ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);`
  4. On the store: `reorgs-v1-rollback.sql`. It refuses while either table is still subscribed.
- **After step 8:** revert the publish PR first, re-deploy the previous worker build, and restore the previous `analytics-availability.py`. Then follow the steps above.
- **If the subscription disables itself at step 4:** run the source rollback, `REFRESH PUBLICATION WITH (copy_data=false); ENABLE`, then `feed-recovery.md`.

`test/v1/ask-logical-sync.test.js` (PG16, CI) exercises copy, reviewed-columns-only replication, the Berlin time conversion, the refused early destination rollback and the full rollback order.

## Datasets

### `reorgs` (replicated `fork_events`)

`reorg_id, fork_height, depth, reported_orphans, orphans, detected_at` — one row per reorg the indexer detected and rolled back.
- **History:** logging began 2026-07-17, so earlier absence is not zero.
- **`reported_orphans`:** the count recorded at rollback.
- **`orphans`:** counts the stored `orphaned_blocks` rows. 24 early events differ.
- **`detected_at`:** the source writes `now()` into a `timestamp without time zone` under server zone `Europe/Berlin`. The view converts with an explicit `AT TIME ZONE 'Europe/Berlin'`, and the source step refuses unless the session zone is Europe/Berlin. One caveat: the repeated hour at the end of summer time (2026-10-25 02:00–03:00) is ambiguous by one hour.
- **Published columns:** `id, fork_height, depth, orphaned_count, detected_at`.
- **Private:** `canonical_tip`, `source`, the free-text `description`, and `resolved_at` (never set).

### `orphaned_blocks` (replicated `orphaned_blocks`)

`height, hash, canonical_hash, timestamp, miner, transactions, bytes, reorg_id, detected_at, canonical_now`.
- **`canonical_now`:** true when a later reorg restored the orphaned hash to the canonical chain (10 of 386 rows on 2026-10-31).
- **Published columns:** `id, height, hash, canonical_hash, timestamp, transaction_count, size, miner_address, fork_event_id, detected_at`.
- **Private:** raw/header/coinbase hex, block metadata, roots, difficulty, previous hash, `source`, `reported_by` and `consensus_valid` (both always NULL), and `first_indexed_at`.

## Evidence (read-only, 2026-10-31)

- **Counts:** mainnet holds 409 events (408 depth 1, one depth 2) and 386 orphaned blocks, heights 3,414,837–3,536,784. This equals the explorer's `/v1/uncles/stats` (`totalForkEvents` 409, `totalOrphanedBlocks` 386, `deepestReorg` 2).
- **Time conversion:** latest event 472 was written as `2026-10-31 08:01:40` Berlin and becomes Unix 1793430100 = 07:01:40 UTC (CET, UTC+1).
- **Replacements:** 376 replacements are still canonical, and 10 orphaned hashes are canonical again.
- **Size and load:** the copy is under 1 MB. Writes are one event plus 1–2 orphan rows per reorg (about six a day). There is no backfill.

## Rollout (owner approval at each host step)

0. **Check the alert:** `analytics-availability.py` reports healthy, with 11 required datasets.
1. **Merge this PR.** All datasets stay unpublished.
2. **Store migration:** `psql -d ask_analytics -f reorgs-v1.sql`. Two new rows appear unready and are reported as warming.
3. **Mainnet source migration:** `reorgs-source-v1.sql`, run under the default `Europe/Berlin` session zone.
4. **Copy:** `REFRESH PUBLICATION WITH (copy_data=true)`. Then watch both tables reach `r`, with errors unchanged.
5. **Worker build at the merge commit:** deploy it, back up the admission script and install the new one, then restart and check health 200.
6. **Verify as `ask_public_reader`:**
   - the counts equal `/v1/uncles/stats`;
   - the latest `detected_at` equals the UTC conversion;
   - `canonical_now` matches `blocks`.
7. **Live `sql_query`** still rejects both datasets.
8. **Publish PR:** it removes `published:false` and adds both datasets to `REQUIRED_DATASETS`.
   - **Before merging, deploy a worker build of the publish commit.** The worker enforces `published` itself; batch 2 showed that an API-only publish fails with "This SQL cannot run".
   - Then merge, deploy `analytics-availability.py`, and verify with real MCP `sql_query`.
