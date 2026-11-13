# UTXO analytics and signal notifications

`compute-utxo-age.js` writes completed UTC days only. Its default run recomputes
seven completed days, recovering missed runs and recent reorg changes. Use
`--days=N` (1–366), or `--from=YYYY-MM-DD --to=YYYY-MM-DD`; today/future dates
and invalid ranges fail before opening the database. Existing rows are replaced
atomically only after both read queries succeed and their source block is still
canonical on the primary.

The job reads one repeatable-read snapshot on the configured replica (or primary
when no replica is configured). It aggregates current unspent outputs once using
the existing partial index, then reconstructs historical balances from indexed
recent spending inputs/current output links. Lateral index lookups also prevent
poor cardinality estimates from producing full-history hash joins. Daily cohorts preserve zatoshis and
counts as integers. Day windows are [UTC midnight, next UTC midnight); HODL ages
are measured at the last included second. CDD is in ZEC-days; average dormancy is
in days. No new index, table, migration or global database tuning is required.

The routine job uses a bounded 180-second statement/185-second client deadline.
Explicit rebuilds longer than seven days have 600/605-second read deadlines;
use a 1,500-second process limit for those one-off rebuilds. Both use 64 MB
work memory per operation and at most two parallel workers for reads. Primary
snapshot writes have a 30-second statement deadline. Keep the existing external
flock and add a 600-second process timeout to the UTXO cron command. Do not run
multiple backfills concurrently or bypass the advisory lock (839302).

After deploying the reviewed main revision to the job host, run from
`server/jobs` with the existing NODE_PATH/environment:

```sh
node compute-utxo-age.js --from=2026-08-17 --to=2026-09-08
```

This example repairs the first-to-last missing dates found on September 9. A
larger rebuild can correct earlier partial-day snapshots as well. Check row dates,
bucket sums, replication health, and both `/api/valuation/hodl-waves` and
`/api/valuation/dormancy`; these reads have a ten-minute cache. Invalidate only
the corresponding valuation cache keys after a repair, never flush Redis. The
two API endpoints expose `date` as a UTC `YYYY-MM-DD` string and exclude the
incomplete current UTC day, independently of the server/session timezone.

Signal jobs read `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from their existing
job environment or `server/signals/.env` (falling back to `server/api/.env`). Store
credentials only on the server with restricted permissions; never in Git. Do
not infer a destination from a different service's credentials without confirming
where these reports belong. Both legacy and V3 senders validate configuration,
apply a 15-second HTTP deadline and reject HTTP/Telegram API failures. They never
log credential-bearing URLs. `node server/signals/notify.js --check` verifies the
bot and chat with getMe/getChat without sending a message. The V3 computation's
successful exit previously did not prove notification delivery: missing settings
silently skipped delivery, and HTTP errors were not checked.

Tests: `npm run test:server-regressions`. Set `TEST_UTXO_DATABASE_URL` to a
**disposable superuser-enabled PostgreSQL instance** to run the real SQL/oracle
and atomic-write integration tests; they create/drop an isolated fixture database.
CI provides a disposable PostgreSQL 16 service. No fixture test targets production.

## October 1, 2026 coordinated ZecBlock release

The owner selected the ZecBlock redesign release for the analytics API, chart
ranges, and daily valuation-job changes. Keep these together on
`codex/zecblock-assay-rebrand`; the earlier main-only
`new/analytics-history-release` branch is not a separate deployment plan.

Mainnet migration 028 and the staged replay are already installed. The
2026-09-29 06:58 UTC check found all 3,623 completed days from 2016-10-28 through
2026-09-28; the latest completeness run passed source and replay checks. Keep the
existing guarded catch-up/refresh timers running until release. Do not restart
or repeat the genesis replay just to publish the frontend/API.

At cutover, reconcile the final redesign with current production main and the
actual running API/job revisions, retaining intervening security fixes. Verify
migration 028 and API-role grants on each target network before enabling new
readers; mainnet completion does not establish testnet readiness. Deploy the
reviewed API and daily valuation job before enabling the matching chart frontend
within the same release window. Verify the installed worker source/drop-ins and
locks before transitioning from the staged worker; never run duplicate writers.
Check completeness, all-history API results, chart ranges, and indexing/replica
health at the exact deployed revision. Preserve the completed data on rollback.
The exact October 1 cutover time and final deployment acceptance remain open.

## Genesis analytics replay (migration 028)

Apply canonical Rust migration `028_analytics_history.sql` before deploying API
readers. `backfill-analytics-history.js` reconstructs completed UTC days from
indexed output creations and canonical transparent spends. It requires a physical
read replica: there is deliberately no primary fallback. Each day commits its
checkpoint, HODL/CDD data, transparent cost basis, mining pool block counts and
miner destinations together. All-history hashrate-share reads these daily block
counts instead of running attribution regexes across the entire block table.
Zatoshi cohorts and creation-price multiplication use integer arithmetic; USD
prices have four decimals. SOPR is total spent ZEC valued at spending-day price
divided by the same outputs valued at creation-day prices. It is null without a
positive denominator. Shielded notes and individual purchase prices are unknown.
Average dormancy remains the arithmetic mean age per positive-value spent output,
not a value-weighted mean. Miner destination cohorts use their latest observed
spend/labels; they are not proof of sales or point-in-time historical labels.

The checkpoint has a canonical daily block anchor and compact JSON aggregate
creation-day cohorts. Header timestamps can move backward: a future-dated
creation already spent is stored as a pending debit, excluded from holdings,
and canceled on its creation date. Negative timestamp ages are clamped to zero;
SOPR still uses the actual creation-date price. These are header-date snapshots,
not a claim that timestamps define monotonic chain order. Repairs propagate
forward when a prior checkpoint is newer. No transaction identifiers or private wallet data are added.
MVRV retains a separately named shielded-flow model (`pool_realized_cap_daily`,
`server/lib/pool-basis.js`). It replays every canonical transaction that changes
a shielded pool, including shielded coinbase, in height/index order from the
per-pool value balances (Sprout, Sapling, Orchard, Ironwood). Value leaving a pool
takes that pool's average modeled cost; value entering a pool is funded first by
value leaving other pools in the same transaction (pool-to-pool migrations keep
their cost) and otherwise costs the UTC-day price. Unknown (NULL) value balances
fail the run. `shortfallZat` in the job log counts value that left a pool beyond
its modeled balance; it should be 0 with complete source data. A `--rebuild`
replaces every row, including retired pseudo-pool rows such as `mixed`. Pre-model dates expose daily
prices and reconstructed transparent data without manufacturing a shielded basis.
The old current-transparent-balance scaling job has been replaced; `--today-only`
now refreshes the last seven *completed* days and `--all` consumes available
validated daily checkpoints. No changes are made to consensus/indexer tables.

Start with the default read-only single-day preview, then an applied pilot:

```sh
NODE_PATH=server/api/node_modules node server/jobs/backfill-analytics-history.js
NODE_PATH=server/api/node_modules node server/jobs/backfill-analytics-history.js --apply --max-days=3 --pause-ms=10000
NODE_PATH=server/api/node_modules node server/jobs/check-analytics-completeness.js
```

Operational bounds: one reader and one writer; reads use 20-second statement
limits, 16 MB work memory and no parallel workers; writes have a five-second
statement limit and one-second lock timeout. Existing UTXO and miner-destination
advisory locks plus a replay lock prevent overlap. Health gates check host load
(maximum 0.5 per CPU), indexed tip/heartbeat (600 seconds), indexer lag (three
blocks), replica lag (five indexed blocks or 16 MiB WAL). Source/price mismatches and reorgs stop the run without advancing the failed day. Timed-out creation/spend queries subdivide
within the same read snapshot, down to one-hour windows; a timeout at that
bound stops without advancing. There are no
service restarts or indexer writes in the replay. Checkpoints resume missing
calendar days and missing derivatives. A daily refresh recomputes the latest seven
completed days after the historical queue is caught up.

The provided systemd history timer resumes 120-day batches with ten-second pauses
and five-minute rests; the refresh timer runs at 06:30 UTC. Install only on the
active mainnet primary after a reviewed pilot and migration. Keep standby writers
inactive. Both log completeness reports and failures to journald. Incomplete
historical coverage is expected while the initial queue runs; source gaps must be
investigated, never filled with zero or interpolated. The completeness report also
surfaces privacy/price/MVRV gaps and staleness; upstream inputs need their own
source-specific recovery and are not fabricated by this replay. Changed daily
values invalidate only the relevant Redis chart families, never the whole cache.

Disable the two timers and stop only their analytics services to pause. Already
committed days are retained; a running PostgreSQL transaction rolls back on
termination. Resuming uses persisted checkpoints, not a guessed height watermark.

Release dependencies: retire the old current-balance-scaling `compute-mvrv.js`
by deploying the replacement with the backend release. The staged replay alone
does not replace the original daily-v3 cron source. Do not restart an indexer to
install SQL-only migration 028. Mainnet is the only enabled replay target;
testnet needs its prerequisite analytics tables before these API readers/jobs.
