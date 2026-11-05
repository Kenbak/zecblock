# Cross-chain data: authority, validation and staged rollout

Updated: 2026-10-15. The source includes the reviewed filtered reader and maintenance
worker already operating on mainnet. This integration preserves the reader modules
installed October 14 and the separately pinned immutable worker; it does not enable
readers, recreate checkpoints, change the provider budget or apply SQL automatically.
The canonical private workspace wiki records exact serving commits and deployment
verification. Earlier dated implementation evidence below is historical.

## Existing production release and upgrade boundary

The separately installed worker remains
`/opt/cipherscan-crosschain/b72a393fc97b754880cd5752da6e436182633f6b`, reached through
`/opt/cipherscan-crosschain/current`. The maintenance unit references that existing
`current` link and its provider preload. Preserve the link, existing `.env` symlink,
shared request budget and legacy cron/flock. The API reader modules match their
existing production overlays exactly: `analytics.js` SHA256
`25fbe48fa752d52fade346c5747a115da7ab09c7740fbdf104015566b7166396`,
`ingest.js` SHA256 `621898e7be862fdef7a5eda7e10d72212f15f7405fac14bf183dd458c20c8c7e`.

Mainnet already has scoped tables, the filtered indexes and
`CROSSCHAIN_V2_READ_ENABLED=1`. The source release must retain those settings and
existing `non-pending-v1` checkpoints; it requires no new schema migration, reset,
backfill, timer change or worker replacement. Testnet and passive standby must not
acquire a new writer. Fresh installation and old-policy migration commands below
are explicit operator procedures, not actions for an already migrated host.

## Filtered live maintenance after historical completion

`maintain-crosschain-v2.js --apply --page-size=1000` requires both scoped historical
directions complete, the writable primary mainnet database and the shared provider
limiter. Its first live window starts one hour before each historical
completed-through anchor, even if history took more than seven days. Later live
windows start one hour before the prior live completed-through anchor. Unfinished
windows resume fixed bounds/cursors. This maintenance mode supersedes the seven-day
overlap of standalone sync.

Each batch allows two live pages per direction. Only after both live windows
finish does it advance up to four reconciliation pages per direction, interleaving
directions and giving the least recently advanced direction the first turn. A
completed direction stays intact for seven days before its next sweep. Finally it
may refresh one known PROCESSING/INCOMPLETE_DEPOSIT identity, within the remaining
budget. Older late settlements are discovered by filtered full reconciliation;
creation-window live sync alone cannot find every later status transition.

Reconciliation uses a one-day creation window ending at the durable cursor's
stored timestamp, with a one-millisecond overlap and up to 1,000 rows. Returned
ordering and date bounds are validated. A page containing only boundary-time ties,
an empty bounded window or a missing cursor row falls back to the original
100-row identity cursor. Only exhaustion of that original cursor certifies global
completion; a short or empty calendar page cannot. Page rows and cursor updates
commit together, preserving original snapshots and retained historical checkpoints.

The maintenance service retains the legacy flock, six-second shared reservations,
90-second systemd deadline and five-minute cadence at UTC :02/:07/etc. The worker
has a 75-second total budget including token-catalog loading and one attempt per
Explorer request. It yields before a new request or between committed pages when
budget expires; real provider/cooldown/invalid-response failures remain failures.
Live catch-up uses at most four page calls. Steady maintenance schedules at most
eight reconciliation pages, each possibly using a date request plus cursor fallback,
and one identity refresh, within the same deadline. This is not a request-rate or
service-deadline increase. Keep the completed backfill timer disabled.

For a fresh reader installation, explicitly apply
`server/scripts/index-crosschain-filtered.sql` outside a transaction before reader
acceptance. It builds concurrent partial indexes for non-pending creation-order
reads and active unsettled refresh, preserving old rows/indexes. Verify both
indexes valid; an interrupted build requires inspecting and removing only its
invalid index before retry. This is application SQL, not a numbered Rust migration.
Existing production already has these indexes; do not reapply as part of source
reconciliation merely because the script becomes tracked in main.

On sustained provider/production impact stop only maintenance, retain checkpoints,
then verify a bounded canary before resuming. Installing source does not enable API
readers. Coverage separately reports `historyTraversalComplete`,
`statusReconciliationComplete`, per-direction reconciliation progress, live
`syncedThrough`, continuous coverage and `stale`; completion flags do not certify
upstream all-time completeness, immediate settlement discovery or sustained load.

## Pending-quote exclusion — October 6

The owner excluded `PENDING_DEPOSIT` from historical and future ingestion. The
`non-pending-v1` scope requests SUCCESS, REFUNDED, FAILED, PROCESSING and
INCOMPLETE_DEPOSIT only, in backfill, sync and reconciliation. The upsert guard
also ignores pending quotes if returned unexpectedly. Unsettled refresh selects
only processing/incomplete records. Existing pending rows remain stored for now,
but the updated v2 reader excludes them and reports the five included statuses;
outcomes are not a quote-conversion rate.

When upgrading an old unscoped worker for the first time, stop its timer/service and apply
`server/scripts/scope-crosschain-v2.sql`. It preserves old cursors/coverage under
`all-statuses-v1`, adding scope to their primary keys. The new writer starts fresh
filtered checkpoints at the current snapshot, never reusing an old quote cursor.
A fresh installation uses `create-crosschain-v2.sql`; its default scope deliberately
remains the old policy so old callers cannot certify new coverage. All new writer
and reader operations select `non-pending-v1` explicitly. Do not restart an old
worker after this migration: its unscoped conflict targets are incompatible.
Rollback safely by stopping the new worker and preserving all tables/checkpoints.

Keep the existing shared provider budget, six-second spacing, five-minute timer,
one page per direction and 90-second deadline. Filtered pages contain 100 records:
the initial 1,000-row filtered canary timed out, while a bounded 100-row probe
returned HTTP 200 in 11.738 seconds. Request frequency remains unchanged. Verify a bounded canary advances
both filtered checkpoints without new pending writes or legacy impact before
resuming. Do not enable v2 readers as part of this worker change. Complete filtered
traversal, catch-up, full status reconciliation, identical-window SUCCESS validation
and reader performance checks first. A quote that later becomes non-pending can
be discovered by sync within its seven-day creation window; older transitions
require a full reconciliation sweep. Exclusion does not guarantee immediate
capture of arbitrarily late settlements.

## What the data means

The authority is the authenticated [NEAR 1Click Explorer API](https://docs.near-intents.org/api-reference/get-transactions),
not all NEAR Intents activity. Token identities come from
`https://1click.chaindefuser.com/v0/tokens`. Index the five non-pending statuses in
both directions involving native ZEC. Store the complete upstream JSON, retaining
fields that are not currently visualized. Identity is `(depositAddress, depositMemo)`;
an address alone is insufficient. Wrapped assets keep their reported chain identity.
Internal ZEC-to-ZEC routes remain searchable but are excluded from external-route
analytics. An Intents-balance asset route does not prove an on-chain deposit or withdrawal.

Historical traversal has no arbitrary year/week cutoff. It follows address+memo
cursors against a fixed upper timestamp until the provider returns an empty page.
Short pages do not terminate traversal. Empty calendar intervals do not terminate
traversal. A checkpoint and its entire page commit atomically; invalid data or a
non-advancing cursor fails without skipping the page. Completed history is proof
of traversal, **not proof that upstream has exposed every swap**.

Only SUCCESS contributes volume, distributions, routes and timing. USD is reported
source-side USD; native ZEC is destination quantity for inflow and source quantity
for outflow. Decimal amounts stay PostgreSQL numeric / JSON strings; charts convert
only for rendering. Legacy zero sentinels become unavailable values. Missing values
are counted, not silently replaced by zero; aggregates with no valued rows are null.
A partially valued aggregate explicitly covers only reported values. Median uses
PostgreSQL percentile interpolation; it is a statistical value, not a transfer amount.

Daily/hourly UTC series have a row for each bucket. Absent buckets remain null unless
completed historical and live traversals cover the entire bucket continuously and
the live sync is fresh. A coverage range ledger detects gaps between a historical
snapshot and later overlapping live windows. First/current partial buckets are not
fabricated as zero. 24h/7d default to hourly; longer periods use daily resolution.
“All indexed” means the observed index, not a claim about all historical volume.

PENDING_DEPOSIT can be an unfunded quote. Observed status counts are not a venue-wide
success/failure rate. In-flight amounts are unavailable, not zero. `firstSeenAt`,
`lastSeenAt` and `statusObservedAt` are local observation times, not execution times.
`last_checked_at` also advances for an unsuccessful refresh without claiming a new
upstream observation. Processing/incomplete records are refreshed; filtered full reconciliation
rediscovers older quotes that have transitioned and updates terminal outcomes.

Timing measures swap creation to the reported Zcash transaction's block timestamp,
using matched positive samples under 24 hours, with sample count/p50/p90. The outbound
measurement is the Zcash deposit leg. **It is not end-to-end settlement latency.**
Do not substitute heuristic linked hashes. Sender counts distinguish chain+address,
not people or wallets. Application fees are reported basis points, not total cost.
Wrapped token supply remains a separate contract observation, not unique backing or
proof of reserves.

## Compatible read surfaces

- `/api/crosschain/analytics` and `/v1/crosschain/analytics`: period and granularity;
  summary, coverage, dense series, distribution, exact-asset routes, outcomes,
  referrals and sampled timing. A bounded per-process single-flight cache lasts 60s.
- `/api/crosschain/swaps` and `/v1/crosschain/swaps`: period, direction, status,
  chain, symbol, exact source/destination asset, referral, min/max USD, UTC from/to,
  exact address/transaction/NEAR-intent search, limit and opaque cursor. Date intervals are
  `[from,to)`. Cursor fixes the original time window and filter fingerprint; sorting
  uses timestamp+address+memo, avoiding tied-row loss and offset ceilings.
- Default readers use the existing `cross_chain_swaps` table. Set
  `CROSSCHAIN_V2_READ_ENABLED=1` only after acceptance checks. Existing API endpoints,
  legacy jobs and their consumers retain their contracts; their old historical
  limitations are not silently rewritten by this change.
- The redesign calls the new v1 routes. Publish compatible API routes before shipping
  the frontend. Before API availability, the new UI shows unavailable, never fake zeros.

## Additive schema and writer

`server/scripts/create-crosschain-v2.sql` is an explicit application SQL migration,
not a numbered Rust indexer migration. It creates three new tables only:
`crosschain_swaps_v2`, `crosschain_sync_v2`, `crosschain_coverage_v2`. PostgreSQL 14+
is required for multirange aggregation. It uses a two-second DDL lock timeout. It
never truncates, renames or updates legacy tables. Run with `ON_ERROR_STOP=1` against
`zcash_explorer_mainnet`; inspect the database identity before applying.

`node server/jobs/sync-crosschain-v2.js` is dry-run by default. Writing requires all
of `--apply`, `NETWORK=mainnet`, `CROSSCHAIN_V2_WRITER_ENABLED=1`, and an exact database
name of `zcash_explorer_mainnet`. Credentials are loaded by the existing job utilities.
A PostgreSQL session advisory lock prevents competing v2 jobs. Each invocation is
bounded to five pages per direction by default (100 provider records/page), with
`--max-pages=1..100`. Provider calls are spaced at least 5.5 seconds, retry at most five
times on transient errors, honor Retry-After, and abort resumably if cooldown exceeds
60 seconds. Token catalog failure aborts rather than inventing chains.

## Production rollout and rollback

1. Verify the actual mainnet release branch, API process working directory, deployed
   commit, database host/name/version, disk space and cron ownership. Keep the
   unrelated redesign out of an API-only release. Deploy the compatible API modules
   with both v2 flags unset; check existing routes plus both new legacy-backed routes.
2. Apply the additive SQL with a low lock timeout. Confirm the new empty tables and
   indexes. Retain existing source tables; no legacy data copy is required or assumed
   to preserve memo identity.
3. **Coordinate the partner-wide provider quota before enabling the writer.** NEAR
   documents one request per five seconds per partner. The local limiter and advisory
   lock do not coordinate with the legacy job or other hosts using the same key.
   Use a provider-approved separate quota or a scheduled, non-overlapping execution
   window shared by every job using that partner key. Do not run the v2 backfill
   concurrently with the legacy ingester at full quota, or disable legacy indefinitely:
   its transaction labels and other consumers still depend on it. No cron is installed
   by this change. Measure per-window duration and leave time for legacy updates.
4. Run one bounded `--apply --backfill --max-pages=1` in that coordinated window.
   Verify rows, memo identities, payloads, numeric amounts and checkpoint. Continue
   bounded backfill invocations until both directions have `completed_at`. The first
   history snapshot is fixed; it can take multiple invocations to traverse all included statuses.
5. Run bounded `--apply` live sync invocations to completion, then schedule sufficiently
   frequently to remain within the 20-minute freshness threshold. Live windows overlap
   seven days and resume unfinished windows. Their start follows prior completed-through,
   so interrupted periods are caught up. Check continuous coverage through both directions;
   if the initial backfill took more than seven days, run a full `--apply --reconcile`
   sweep to close any gap to the live window. Reconciliation is resumable and starts
   a new full sweep after completion. Schedule according to measured volume and quota.
6. Compare legacy and v2 SUCCESS rows over the SAME exact time window; explain
   memo-collision recovery, revised provider statuses, missing values and internal ZEC
   exclusions. Check histogram count equals valued SUCCESS external rows, native-ZEC
   sums equal the relevant token amounts, both traversal checkpoints complete, live
   freshness, continuous coverage and representative source/destination hash links.
   Confirm failed/refunded/processing rows and pending exclusion and missing-value behavior using real payloads.
7. Enable the reader flag only after these gates pass. Check API latency/load at the
   resulting filtered index size, database pool headroom, errors, coverage and UI.
   Ship the redesign on its own reviewed release path. Do not claim “complete history”
   until the provider's exposed history has actually been traversed.
8. Roll back by unsetting `CROSSCHAIN_V2_READ_ENABLED` and restarting the API through
   its normal release mechanism. Disable only the new writer schedule/flag if needed.
   Legacy data and jobs remain intact. Retain v2 tables/checkpoints for diagnosis and
   resumable recovery; no destructive down migration is required.

## Validation evidence (2026-09-28)

- Read-only production probe: 87,603 legacy records, earliest
  `2026-06-13T23:21:15.344Z`, 1,499 internal routes, 10,159 records without an
  upstream-reported ZEC hash. Counts are a point-in-time observation.
- New legacy-backed 30-day analytics and 25-row explorer read together took 831 ms
  in one measured remote invocation. Both successful external count and valued
  histogram count were 49,799. Native ZEC total `210537.77734986`; USD total
  `266143507.544119209861`. This is not a sustained load benchmark.
- Authenticated provider probes found successful ZEC swaps on 2025-12-31, proving
  older data exists; no earliest-provider-date claim is made. A later probe validated
  five recent records in each direction against 198 catalog tokens; all ten were
  pending deposits with unavailable amounts.
- Real PostgreSQL regression fixtures cover memo identity, status changes, history
  older than the former 84-day bound, checkpoint recovery/rollback, cursor exhaustion,
  repeat-cursor failure, UTC buckets under a Tokyo database timezone, coverage gaps,
  counts, exact sums, internal exclusion, unknown values, lifecycle observation,
  pagination ties and actual legacy/v1 HTTP adapters.
- Browser validation uses a separate localhost API and 60,000 explicitly synthetic
  records; these are not production data. No fixture is included in a production job.

Run `npm run test:crosschain-postgres` with a local PostgreSQL socket at `/tmp`.
The tests create and drop their own uniquely named databases and cover pending
exclusion, old-scope migration, fixed-window/cursor resume, date ties/exhaustion,
maintenance fairness/deadlines, reconciliation/freshness metadata, numeric unknowns
and HTTP compatibility. Without the opt-in, native PostgreSQL cases are skipped. Also run frontend tests, lint, typecheck,
v1 contract/OpenAPI checks and a production build before release.

Final local release checks: optimized webpack production build passed after replacing
a shared dependency symlink with a local copy; TypeScript passed. Full frontend suite:
226 passed. Server regressions: 116 passed, 3 skipped. API tests: 135 passed, 2 skipped.
v1 contract tests: 282 passed. Cross-chain PostgreSQL suite: 3 passed (including the
integration scenario); route-cache build checks: 5 passed. Full lint passed with
227 existing warnings and no errors; targeted changed-file lint had no output.
The build used the repository's allowed upstream fallback; an unrelated rich-list
request timed out during prerendering, while the build completed successfully.
Optimized-build browser verification had no console errors. Raw HTML checks found
one H1, complete sharing metadata and two JSON-LD blocks; the clean route was
index/follow and filtered variants noindex/follow, both canonical to the clean URL.

## Preview refinement — 2026-09-29 (local only)

Inflow/outflow bars now share the same date position using a signed stack. Both
charts use the shared theme-aware hover surface; outflow tooltips show the positive
amount while the chart retains its negative direction. Swap-size count and volume
views are both available, always grouped by source-side USD size; ZEC volume uses
reported native amounts within those same USD buckets. Existing token/chain logos
are reused in route and swap rows.

The chain overview now ranks **all** observed external chains by ZEC buys, ZEC sells,
or combined swaps, using count or the selected USD/ZEC volume. A buy assigns the
source chain; a sell assigns the destination chain. This groups asset routes, not
trading venues or identifiable participants. The analytics response adds `flows`
with `chain`, `swaps`, `buy_swaps`, `sell_swaps`, and both directions' USD/ZEC sums.
Its query includes every selected successful route before the separate top-100
route listing limit. Counts link to corresponding filtered swaps.

Summary additionally exposes `average_usd` / `average_zec` using SQL numeric AVG of
available values (not total divided by a count containing missing valuations).
The overview restores average swap size, a net-flow card and a standalone swap
count alongside median and direction totals. Missing sums stay unavailable.

Metric reconciliation: volume/count and chart history remain period-selectable;
24h and all-indexed totals are reached through their period tabs instead of fixed
24h cards with simultaneous all-time hints. Chain flows and swap-size volume mode
are restored. Top pairs became exact-asset route summaries; transaction details
remain in Swap Explorer. The former “unique wallets (30d)” wording is replaced by
distinct chain+sender addresses in the selected period. Timing remains matched
Zcash-leg p50/p90/sample counts, with no end-to-end claim. Wrapped supply remains.
No production data or existing endpoint was deleted.

`NEXT_PUBLIC_CROSSCHAIN_DEMO=1` is a **local preview build-only** option. It visibly
labels simulated data, explains fixture identifiers, and disables transaction
explorer links for those fake hashes. Do not set it in production. The demo dataset
still has only two routes; this does not restrict real-data chain rankings.

Refinement verification: optimized build and TypeScript passed; targeted lint and
design lint passed; 28 frontend regression checks and all 3 cross-chain tests
(including PostgreSQL buy/sell counts, native quantities, average and missing values)
passed. Browser checks confirmed equal date X positions and widths for paired bars,
loaded route logos, successful buy/sell and count/volume ranking controls, themed
hover fill `rgba(156,164,176,0.07)` in dark mode, count+volume tooltip, and no console
errors. Clean and filtered raw HTML retained one H1 and correct canonical/robots.

## Visual layout correction — 2026-09-29 (local only)

The preview builds on the original visual layout: four headline cards (volume,
swap count, net flow and average), full-width aligned volume history, a diverging
flow-by-chain chart with existing logos, swap sizes beside Top Pairs, compact
clickable outcome counts, and recent swaps with direction tabs. Chain flows use
one shared symmetric scale and can switch between volume and swap count; the
first eight chains rank by combined activity, with all remaining chains expandable.
Chain labels link to filtered swaps. Hover shows both direction values and counts;
it does not yet restore the legacy per-token hover breakdown.

The large chain-ranking and route tables are replaced by these visuals. Top Pairs
still uses exact-asset routes and links to their records. Search and the complete
advanced filter form remain under “Search & filters”; active filters are flagged
with a clear action. Existing confirmation-time charts return when matched samples
exist. Median, source-address counts, p90/sample details and referrals remain in
expandable analytics. Outcome counts stay visible; status links filter the feed.
Verbose definitions and coverage details move into an expandable section while
stale-data and missing-value warnings remain visible. Demo labeling stays explicit.
The selected period remains 30 days by default. No ingestion, API, database or
production configuration changed in this UI correction; deeper ingestion remains
implemented but undeployed/unrun in production.

Recent swaps also restores the original asset hierarchy: a 32px token/chain icon
beside a prominent amount + symbol, with the chain on a smaller muted line below.
From/To column headings align with the asset cells; value and status are aligned
separately. Full provider amount strings remain intact, including in expanded
record details; no precision or amount calculation changed.

Verification: final optimized build and TypeScript passed, targeted ESLint/design
checks passed, and 31 frontend regression checks passed. Browser verified restored
flow graphics, volume/count switching, outcome links, submitted status/chain
filters, and the amount-first swap layout with all 50 feed icons loaded and no
console errors. Clean/filtered raw HTML returned 200, one H1, canonical ZecBlock
URL, appropriate index/noindex, social tags and valid JSON-LD. Preview is local
mainnet-mode demo on port 3110; no production rollout or backfill occurred.

## Swap filters update locally — 2026-09-29 (preview only)

Recent-swaps Apply/Reset, direction tabs, pagination and chain/pair/outcome links
now update native browser history, with Next useSearchParams driving only the
swap results. The dashboard is keyed by the global period rather than all query
parameters, preserving chart controls and USD/ZEC selection during feed filtering.
Filter submissions omit empty fields and reset the cursor; a keyed results child
prevents old-filter rows from being presented as new-filter results. The search
panel remains open and its form synchronizes on Back/Forward. Links keep real
hrefs for sharing, opening another tab and server rendering. Global period changes
still update the whole analytics dashboard. Filtered direct requests retain their
existing noindex and stable canonical policy. No API or production changes.

Native popstate/hashchange subscriptions also handle plain section-anchor entries
that lack Next router history state; the analytics period subscription updates
only when the global period changes. Browser checks verified Apply, Back/Forward
through a section-anchor entry, pagination, Reset including unsaved drafts, and
chain-to-feed links. ZEC unit, chain-chart count mode and the expanded filter panel
survived feed changes. Global 7d selection and Back to 30d synchronized correctly.
Final build/TypeScript, scoped/design lint and 20 query/frontend checks passed;
clean/filtered raw HTML retained the correct canonical, robots, one H1 and HTTP
200. Browser logged no errors. Local preview only; production unchanged.


## Progressive analytics views — 2026-09-29 (local preview)

Navigation is Overview / Flows / Swaps / Ecosystem. Period and USD/ZEC controls
sit together above metrics. Existing icons, signed flow bars, swap sizes, top pairs,
amount-first recent swaps and wrapped supply remain. Confirmation timing, referrals
and methodology are secondary disclosures. Feed filters remain local and removable
chips describe active values; chart links clear unrelated filters and reset pagination.

Analytics adds three fields, on both legacy and v2 readers, without schema changes:
- `tokenFlows`: successful external swaps grouped by counterparty chain and reported
  token symbol. Same-symbol records within one chain are grouped; this is not an
  assertion of identical asset contracts. Counts and USD/native-ZEC amounts have the
  same semantics as `flows`. Groups are computed before the top-100 exact-route cap.
- `chainHistory`: observed successful swaps grouped by counterparty chain and UTC
  Monday week; `bucket`, `swaps`, `missing_zec`, `net_zec` (numeric string/null).
  Net is native ZEC acquired minus native ZEC exchanged. Any missing ZEC amount
  leaves that week's net null. First/last weeks are restricted to the selected
  interval and labeled partial. Empty cells become zero only within verified,
  fresh continuous history; otherwise they remain unknown.
- `chainOutcomes`: counterparty chain + latest status + count for all external
  records created in the period. Stacked bars include outstanding statuses instead
  of implying all quotes completed. Legacy success-only coverage is explicit.
  Segments link to the corresponding status/chain feed; weeks link to UTC bounds.

Optional price/net-shielding comparisons are fetched only when selected. Activity
is aggregated to UTC days while comparing; unknown hourly data leaves a daily gap.
Both charts use matching date keys and synchronized hover with separate y scales.
The first/last activity days can be partial. Price is historical USD/ZEC from
`/v1/valuation/history`; net public shielding is ZEC from
`/v1/shielded-pools/flows`, shielding minus deshielding, not balance change.
The shielding API supports at most 1y, so all-history comparison explicitly labels
that limit. Missing reference dates stay null without interpolation or forward fill.
The local preview serves clearly labeled synthetic daily comparison fixtures. No causal link or
tracing of individual swap proceeds into shielding is claimed.

Production has not been deployed, migrated or backfilled by these changes.


Reference calendar correction: valuation history now projects `m.date::text` and
uses a UTC cutoff, keeping the database calendar day independent of the Node host
timezone. Public flow daily projections and raw-flow fallback use UTC/text dates;
hourly fallback bucketing is explicitly UTC. Both reference cache namespaces are
versioned to avoid serving shifted old daily keys after deployment. History date
strings are YYYY-MM-DD; clients must not interpret them in viewer-local time.
Deploy these API corrections before the frontend comparisons. No database
migration or new production writer is needed.

Before release, verify the existing `flow_daily` materialized view was built and
refreshed under UTC. This local UI task does not certify production view timezone.

## Isolated history worker and shared NEAR budget — 2026-09-29

The backfill can be installed independently of the API/frontend release. Apply
`create-crosschain-v2.sql` and `create-near-provider-budget.sql` explicitly as the
mainnet job database user. Both are additive SQL applications (not numbered Rust
migrations). Production readers stay on legacy data until separately verified.

`NEAR_EXPLORER_SHARED_LIMIT=1` with the job-only `provider-preload.js` wraps NEAR
Explorer requests from both the existing cron and the isolated v2 worker. A
PostgreSQL session lock serializes requests and the singleton
`crosschain_provider_budget` stores a deadline, request/throttle counters and last
HTTP status, without credentials or swap payloads. Requests are spaced at least
six seconds at the reservation boundary. HTTP 429 persists the larger of six
seconds and Retry-After; missing/invalid Retry-After uses 60 seconds. Long active
cooldowns fail closed before another HTTP request. A separate one-connection pool
avoids deadlocking the writer's transaction connection. Other partner applications
must coordinate this same quota; independent API keys do not imply separate limits.

Install an immutable minimal worker release at `/opt/cipherscan-crosschain/<sha>`;
`current` points to the verified release. It uses the existing API node_modules via
NODE_PATH and an API .env symlink; credentials are never copied into the artifact.
Add the preload only to the existing legacy cron command, preserving its schedule,
script and `/run/cipherscan-sync-swaps.lock`. Back up the exact original crontab.
The repository's generic cron templates do not install this opt-in limiter:
**preserve this host override during subsequent cron provisioning while backfill
is enabled**. Manual Explorer diagnostics must use the same preload and lock.

The supplied systemd timer starts at UTC minutes 02,07,... between legacy runs.
Each batch takes the same nonblocking flock, processes at most three 1,000-record
pages per direction, and is killed after 90 seconds. Committed page checkpoints
survive timeout/cooldown/restart; an interrupted transaction rolls back. Busy live
sync skips the batch. Start with one page per direction as a canary, inspect real
records and primary API health, then enable the timer. Disable the timer when both
backfill checkpoints complete; catch-up/reconciliation and ongoing v2 polling are
separate rollout steps, required before changing readers. Do not claim complete
history, status freshness or all provider fields until those checks pass.

Rollback: stop/disable `cipherscan-crosschain-backfill.timer`, stop its service,
and restore only the legacy cron command from backup. Leave additive tables and
checkpoints intact. No API restart, production Git checkout change, legacy table
rewrite or standby writer activation is part of this worker rollout.

### Provider cursor verification

The initial scheduled production batch failed closed on a repeated cursor. Live
read-only probes established that sending `lastDepositMemo=` for a null memo
repeats the first page, while omitting the memo advances to older records. The
worker now omits null/empty cursor memos and preserves real memo strings; matching
legacy/repair source fixes are included for the October 1 release. Do not infer
that a repeated page proves history is exhausted. No checkpoint was advanced or
coverage declared by that failed batch.


## Pair rankings and readable swap times — October 12, 2026

Prepared on `codex/zecblock-assay-rebrand`; this UI change is not a production
release. Recent swaps reuse the shared ticking relative-time component, with
an exact UTC tooltip, machine-readable datetime and an exact creation date in
the expanded details. The time describes provider record creation, not settlement.

Analytics adds `routeRankings: { swaps, usd, zec }`, each up to 100 successful
external exact-asset pairs. Each ranking is computed across all matching pairs
before its limit; a high-value pair outside the count leaders is not lost.
SQL ranks numeric sums before serialization, puts unknown totals last and breaks
ties deterministically. `routes` remains the count ranking for existing clients.
USD is reported source-side value; ZEC is the Zcash-side token amount. Missing
valuations are omitted from sums, and an entirely unknown total remains null.
The dashboard switches both ordering and bar size/primary value with its selected
metric. Without the additive field, volume controls are disabled; the client does
not mislabel a re-sort of the old top-100 count subset as a global volume ranking.

Five outcome cards exclude PENDING_DEPOSIT; the status filter and chain breakdown
also exclude those quotes. A legacy SUCCESS-only response keeps other cards
Unavailable with an adjacent explanation. A covered status with no observed rows
is zero. V2 activation makes the five statuses available but does not guarantee
instantaneous late-settlement updates. Publish the compatible API before this UI.
Existing route identity, robots/canonical policy and sitemap entries are unchanged.

## Maya and THORChain venue maintenance — October 29, 2026

Indexed Maya/THORChain history lives in the additive `crosschain_venue_actions`
and `crosschain_venue_sync` tables (`server/scripts/create-crosschain-venues.sql`,
an application migration in the main database). The API serves
`/api/crosschain/venues/{analytics,swaps}` only when
`CROSSCHAIN_VENUES_READ_ENABLED=1`; otherwise it returns 503, never zero volume.
Analytics marks a venue stale when its newest checkpoint is older than 20 minutes.

`server/jobs/maintain-crosschain-venues.js` is the production writer. It refuses
to write unless `NETWORK=mainnet`, `CROSSCHAIN_VENUES_WRITER_ENABLED=1` and the
connection is the primary `zcash_explorer_mainnet` database. Each run, per venue:
an incremental sync from the provider head (stops at the first known settled
action), a bounded backfill until the provider history is exhausted, then a
refresh of up to two pending actions. Pages are capped by a 150-second budget at
10 seconds per page; one venue's provider failure does not stop the other.

`cipherscan-crosschain-venues.timer` runs it every five minutes at :04/:09/…
UTC with its own flock (`/run/cipherscan-crosschain-venues.lock`). Midgard is
independent of NEAR, so it never takes the NEAR swap lock or provider quota.
`server/jobs/sync-crosschain-venues.js` remains the isolated local-review writer.

Initial rollout on the primary, after the API release contains this code:

1. Apply `create-crosschain-venues.sql` to `zcash_explorer_mainnet`.
2. Run the job once with a larger backfill, e.g.
   `--backfill-pages=400 --budget-ms=3600000`, under the same flock.
3. Add `CROSSCHAIN_VENUES_READ_ENABLED=1` to the API environment and restart
   `zcash-api-mainnet`.
4. Install and enable the service and timer.

Rollback: disable the timer and remove the read flag; the routes return 503 and
the tables can stay. Dropping them is a separate, deliberate operation.
