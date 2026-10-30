# Automatic factual social analysis

Updated 2026-10-28. This document specifies the editorial selection, cards and
source-reply delivery contract. Exact deployed revisions and acceptance records
are maintained separately in the private operations wiki.
`server/bot/index.js` invokes `jobs/editorial.js`;
the old realtime and digest modules remain available as source history but are
not scheduled. No schema migration, public route, indexation or API change.

The owner selected automatic publication of verified factual analysis, without
human review or Telegram approval, and explicitly requested **new events only**.
No LLM writes the copy. Calculations, qualification rules and templates determine
all claims. No messages are sent to a new Telegram destination.

## Copy voice (copy version 2)

Every builder starts with the ZecBlock marker 🟨, leads with the event in plain
words, adds its measured comparison and retains one trailing `zecblock.com`
source URL. Publication separates that URL into a source reply: the parent
contains the finding and its card, followed by a reply with the attributable
source, observation dates and scope. Essential qualifications stay in the
parent/card. This is automatic publication, not a human approval queue.
Template: "🟨 {amount} ZEC ({usd}) just left Ironwood. / One of the largest
{tail}% of deshielding transactions in 90 days. Ironwood now holds {balance} ZEC."
Methodology stays exact but short: "One of the largest x%" is the inclusive
upper tail, rounded up; NEAR Intents swaps say "we've tracked"; MVRV is "a
valuation gauge, not a forecast"; exchange deposits are "not necessarily a sale";
migrations say "no new ZEC was shielded". Posts never say "a wallet" did
something. `lib/editorial-format.js` holds the shared rounding: ZEC amounts and
balances are truncated with integer zatoshi arithmetic, USD values are floored,
percentile tails round up, so no figure overstates its source.

Prices and balances are context, never qualification. Qualifying flow and
migration alerts fetch one CoinGecko `/simple/price` ZEC/USD quote per scan,
after releasing the database snapshot. This is a spot quote near detection
time, not a historical price at the block timestamp. `include_last_updated_at`
supplies the provider timestamp; quotes older than five minutes or more than
one minute in the future, nonfinite/nonpositive prices and missing/invalid
timestamps are rejected. The request has an eight-second timeout and no retry.
Failure (including HTTP 429) omits USD from both text and image and records a
`price-unavailable` decision; there is no daily-price or cached-price fallback.
Exact zatoshis divided by 1e8 times the unrounded quote produce USD; existing
display flooring remains unchanged. Outbox evidence stores `price_usd` and
`price_quote` (`source`, `currency`, `usd`, `basis=spot-at-detection`,
`sourceUpdatedAt` and `fetchedAt` as UTC ISO timestamps), or nulls when unavailable.
Deferred events are recomputed with a new quote on their next scan.

Pool balances still come from the latest `privacy_stats` row only when it is
under three hours old. A failed balance lookup rolls back to a savepoint and
records `context-unavailable`, without discarding a valid spot quote. Daily
close milestones retain their dated `zec_price_daily` valuation; provider-valued
cross-chain swaps retain their source USD. No public API or schema change.

## ZecBlock image integration

The live orchestrator imports `renderEditorial` from `lib/zecblock-cards.js`.
Each story builds its card (`evidence.card`) next to its tweet copy from the
same evidence. All cards are 1200×675 with the ZecBlock dark tokens, Geist /
Geist Mono and the logotype. A natural headline leads; the supporting metric,
qualifier, shortened source and UTC date remain visible. Series label the
metric, unit, observation range and reference rather than using an unlabeled
sparkline. Visuals by type:

- Shield/deshield: green `+amount` or red `−amount`; Transparent (outline) above
  the pool with a neutral white arrow and current balances. USD sits in the line,
  for example "left Ironwood (≈ $2.13M)".
- Migration: Orchard above Ironwood, Ironwood tone, "Pool migration, not new shielding."
- Swap: chain icons with ZEC ringed in gold; green into ZEC, red out of ZEC.
- Daily activity, signals, hashrate, milestones: a series with a zero-based
  y-axis and a dashed reference (30-day average, previous peak or the level).
  Hashrate charts only the samples behind the claim, at most 91 days.
- Ironwood transaction crossovers: Ironwood gold and dashed Orchard purple
  lines on a shared zero-based axis. Each point is the same rolling 7-, 30-
  or 365-day transaction count as the headline. A compact headline sits above
  the chart; exact totals and inline `txs` units label the line endpoints in
  a shared right gutter, with space between the plot and labels. Pool names
  retain the series colors without connector lines. Close labels separate
  vertically in data order; actual points never move. The chart labels
  rolling-window endpoint dates; the footer
  separately labels the latest measurement window in UTC. There is no separate
  metrics row, hero number or legend.
- Weekly activity: a top-ten rank strip when ranked ≤10, otherwise number only.
- Cross-chain daily: into/out-of-ZEC bars. Reorg: a fork diagram.
- Weekly network briefing: three concise rows for non-coinbase transactions,
  weighted shielded transaction share and total fees, with prior-week changes.
- Public-flow trends: signed daily ZEC series, a visible zero line and the
  preceding 30-day daily average. Negative observations are preserved.

Missing values, a non-`zecblock.com` link, or text that cannot fit at a minimum
size throw, and delivery falls back to text instead of a clipped or misleading
image. `node output/bot-examples/render.js` renders every fixture type locally.

The image integration does not alter credentials, automatic posting cadence,
activation watermark, deduplication, selection thresholds or historical claims.
Changing the X profile is a separate account setting. Render regression fixtures
never contact X; they exercise all scheduled types and the media-upload handoff
with a fake client. Deployment evidence belongs in the private operations wiki.

## Activation and cadence

First live execution atomically inserts `analysis:activation:v1` into the existing
`social_post_outbox` with `post_type=editorial_activation`, `status=active` and
`metadata.activatedAt`. Its timestamp persists across restarts and releases.
Missing/corrupt stored timestamps fail closed. Do not delete/reset this row.
Preview does not insert it and uses the preview start as the provisional cutoff.

The new briefing/trend collector has its own persistent
`analysis:insights:activation:v1` marker, using the same initializer. It preserves
the global and pool-milestone markers. Only original reporting boundaries at or
after this feature marker qualify, including when a weekly report is recovered
later in the week. Upgrading does not publish historical briefings/trends.

Only transaction/block event times, swap creation times and reorg detection times
at or after activation qualify. Old activity drafts are never drained. Historical
data remains a baseline, not a publication backlog. A provider swap created
before activation but completed later is conservatively excluded because the
legacy table does not expose an authoritative completion timestamp.

Daily periods become eligible at 06:00 UTC the following day. Weekly periods
become eligible Monday 06:00 UTC. These eligibility times must be at or after
activation. Thus a Tuesday activation does not publish the prior week's draft
or yesterday's completed daily report. The first daily report describes Tuesday,
after Wednesday 06:00 UTC; the first weekly report follows the next Monday cutoff.

The service polls every five minutes. It publishes at most one story per run,
with at least 20 minutes between routine posts. Reorgs bypass that spacing.
Deferred analysis is recomputed before eventual publication; completed scans
are recorded once per collector/day as `editorial_scan/evaluated`. Source failures
remain eligible for retry. Candidates now compete on a common bounded
significance scale, followed by penalties for recently repeated topics and
money-movement formats. Reorgs and genuinely exceptional swaps/direct flows
have protected priority lanes. Raw USD, ZEC and z-scores never sort directly
against one another. No quota needs filling when nothing qualifies.

## Selection and data contracts

| Topic | Qualification and limits | Authority and wording |
|---|---|---|
| Shielding/deshielding | >=500 ZEC and inclusive upper tail <=0.5%; >=100 prior samples; two combined across both directions per UTC day | Canonical transaction-joined `shielded_flows`; verify net Sapling+Orchard+Ironwood balance, transparent involvement and non-coinbase; prior 90 days of the same direction, excluding candidate timestamp; exact rank with ties; rounded percentage never overstates rarity. A routine flow cannot immediately follow another direct flow within six hours. >=50,000 ZEC with upper tail <=0.1% has a protected ranking lane, but still respects the combined cap. This does not cover Sprout-only flows or private transferred amounts. |
| Swaps | >=$50,000 and inclusive upper tail <=1%; >=100 prior samples | Successful external ZEC routes in legacy `cross_chain_swaps`; rank on positive provider-reported **source USD**, never larger-of-two legs. Explicit NEAR 1Click observed sample, not all trading or all Intents activity. Missing source USD excludes ranking. |
| Swap pacing | One ordinary slot each UTC half-day, plus one exceptional slot per UTC day | Exceptional means >=$1,000,000 and upper tail <=0.1%. Exceptional events retain capacity when ordinary slots are used. |
| Activity | One daily lead selected from share, shielded-component count, fully shielded count and total non-coinbase count | Canonical raw `transactions`/`blocks` through `readActivity`; complete target day plus 30 prior days; fresh tip and reconciled counts. Share differences use percentage points. Counts exclude coinbase; fully shielded means no transparent I/O; migrations are included. No unique-user/adoption claim. |
| Weekly activity | Existing noteworthy rules: >=1,000 and top-ten rank, >=52 weeks since equal/higher, first record, or >=100% growth | Recompute complete Monday–Sunday weeks from 2016-10-31; genesis-contiguous history, fresh tip and reconciled counts. Explicit ties, exact comparison metadata. Reviewed legacy rows are respected. |
| Hashrate | New high >=1% above prior peak; fallback to 91/31 daily samples | Shared `target-work-v1`, trailing **7-day** estimate sampled at UTC midnight. ATH requires >=366 continuous valid samples, full genesis block-height coverage, no missing targets/windows. Otherwise only a bounded-window high is possible. Exact peak comparison retained. |
| Hashrate cooldown | Seven days unless >=5% above last published hashrate | No repeating every marginal record. Not instantaneous hashrate or a direct hardware measurement. |
| MVRV and network signals | Complete 31-day series; >=20% from prior 30-day mean and new high/low or absolute z-score >=3 | MVRV=`mvrv_daily` modeled market/realized-cap ratio; exchange destinations=`turnstile_daily`, deposits not sales; fees=`blocks`, incomplete fee values unavailable; shielding/deshielding=verified net flows. Copy leads with value, mean, relative change, UTC date and scope. z-scores only select candidates, not headline copy. |
| Signal pacing | One/day, seven-day same-metric cooldown; break on >=25% change from last published value | Nulls, gaps, nonfinite values and zero comparison means cannot become fabricated changes. |
| Cross-chain daily | Routine totals are no longer scheduled as standalone posts | The read-only collector remains available for previews/source data. Standalone selection requires comparative evidence: >=20% change plus high/low or absolute z>=3, or an explicit comparative lens with significance >=50. Both directions and provider valuation remain required. Ingestion freshness is not proof of provider completeness. |
| Migration | >=10,000 ZEC, max one/day | Orchard withdrawal with Ironwood deposit and no transparent I/O; explicitly not new shielding. |
| Reorg | Depth >=2 | `fork_events`; describe confirmation changes without claiming permanent finality. |
| Milestones | Ironwood every 250K ZEC; total shielded every 250K ZEC; shielded share of supply every 1%; shielded USD value every $1B. Max one/day | `privacy_trends_daily` completed UTC day (last hourly update of the day) joined to `zec_price_daily` for that date. Posts only when the target day's close is the first ever at or above the level versus the max of all prior days, with >=30 prior samples. Outbox key `milestone:<metric>:<level>` makes each level one-time. A level skipped by the daily cap is not retried, because the next day's prior max already includes it. |

Live event scans cover the preceding hour; chain flows/migrations settle for two
minutes. This catches some delayed ingestion but is not an unbounded catch-up
mechanism. Post caps, source failures and events delayed more than an hour can
still suppress an alert. Journal decisions identify rejected candidates and caps.
Routine privacy linkage warnings, raw sigma pulse posts and the old
migration-heavy daily digest are no longer scheduled. Round-number milestones
returned in copy version 2 with the first-ever-close rule above.

### Significance, novelty and current posting mix

`editorialRank` normalizes reader significance to 0–100 from rarity, relative
change, qualified records or explicit evidence-based lenses. Selection records
`editorialSelection` with the topic, significance, novelty penalty, protected
lane and final score. Same-topic output over three days incurs up to 24 points
of penalty; another money-movement story immediately after a movement story
incurs another ten. Protected lanes bypass novelty penalties: reorg 1000,
exceptional swap 900, exceptional direct flow 800. The existing swap slots,
signal/hashrate cooldowns, daily caps and twenty-minute parent spacing remain.
Source replies are excluded from all story-history and pacing calculations.

The read-only production outbox audit motivating this change found, in its
latest 100 posted stories: 46 direct flows, 23 swaps, 14 cross-chain daily
summaries, 14 daily activity reports, two network signals and one weekly
activity report. Over the seven days preceding that audit, 47 stories included
21 direct flows and 39 broadly defined money-movement stories. These are
outbox observations, not a complete X feed scrape or engagement measurements.
The variety follow-up has not changed production output yet.

### Weekly briefing and public-flow trends

`editorial-insight-source.js` reads **37 complete UTC days** once per insight
scan in a read-only repeatable-read snapshot. Its 25-second server statement
timeout is below the shared 35-second client deadline. Mainnet identity and a
tip no more than thirty minutes old or two hours ahead are required. A
contiguous enclosing canonical height span, including both shoulders, must
exist. Transactions join blocks by height and hash; each block must have its
expected transaction count, exactly one coinbase and known pool classification.
The block timestamp assigns the UTC day. Missing blocks, days or classification
fail closed; a day without authoritative observations is never invented as zero.

The weekly briefing uses the most recent completed Monday–Sunday week and its
disjoint prior week. A failed Monday evaluation can recover that same reporting
week on later days, through the following Sunday; its Sunday target, date range
and week-start deduplication key remain unchanged. The feature activation cutoff
still applies to the original Monday 06:00 UTC reporting boundary, so enabling
the collector later cannot publish an older week. It reports canonical
non-coinbase transaction totals, transactions involving any shielded pool
divided by all non-coinbase transactions, and the
sum of authoritative `blocks.total_fees`. A transaction involving several pools
counts once in the share. Migrations remain in transaction activity. Missing
fees suppress the briefing rather than becoming zero. Counts are integers and
monetary totals remain exact zatoshi strings (1 ZEC = 100,000,000 zatoshis).
Share and percentage-point displays truncate toward zero to one decimal;
point changes use exact fraction cross-products, not rounded displayed shares.
Exact numerators and denominators remain in `fractions` evidence.

Public-flow trends derive net movement directly from canonical non-coinbase
transaction value balances for Sapling, Orchard and Ironwood, with transparent
I/O required. This uses the direct-flow economic definition without relying on
completeness of the derived `shielded_flows` table. All Sprout-involving
transactions are excluded so a mixed Sprout-to-modern-pool transfer cannot
appear as new public shielding. Fully shielded pool migrations are excluded;
modern-pool movements within a mixed public transaction cancel in its net value.
This is not total shielded balance growth, private value transferred or demand.
Unknown balances/I/O suppress flow trends independently of fee availability.

Each trend compares the latest seven complete days with the preceding seven
and/or the disjoint prior thirty. The latest net amount must be at least
1,000 ZEC and at least 10% of gross two-way flow. Lenses are a reversal against
the prior seven-day net direction (both net magnitudes >=1,000 ZEC), measured
7/14/21/30-day same-sign streak landmarks, or >=50% pace changes against the
prior thirty days with the same net sign. Evidence retains exact zatoshis,
periods, baseline, source tip and capture time. No all-time or adoption claims
are introduced. One trend/day and a three-day same-topic/lens cooldown apply,
unless its net total changes by at least 25% from the recent published trend.

## NU7 and halving stories

`server/bot/lib/nu7-stories.js` builds them and `nu7-source.js` reads them, on every tick (mainnet only, read-only snapshot).
The NU7 height comes from the serving node's upgrade schedule stored on the latest *canonical*
`node_accounting_observations` row (joined to `blocks` by height and hash), never from the announcement.

| Story (`type`, key) | When it qualifies | Data |
|---|---|---|
| Countdown (`nu7`, `nu7:countdown:<h>`) | 864–1,152 blocks remain (about a day at 75 s) | tip height; NU7 node readiness from the node census (protocol 170190+, self-reported; line omitted if unavailable) |
| NU7 is live (`nu7`, `nu7:activation:<h>`) | activation block has 3 confirmations and is under 12 h old | activation block, pool attribution, last 20 min of header times (pulse card) |
| First 24 hours (`nu7`, `nu7:first_day:<h>`) | 24–48 h after activation | blocks and average header interval in the 24 h after vs before activation |
| Block milestones (`nu7`, `nu7:blocks:<n>`) | 10k/25k/50k/100k blocks since activation, within 24 h of the crossing block and no later than 30 days after activation | measured header-time span vs `n × 75 s` |
| NSM milestones (`nu7`, `nu7:nsm:<zec>`) | reserve growth since the last pre-activation observation crosses 1/10/25/… ZEC, within 24 h of the first crossing | node NSM counter, exact zatoshi (BigInt); growth includes every reserve inflow |
| NSM dollar milestones (`nu7`, `nu7:nsm_usd:<usd>`) | growth since NU7 × CoinGecko spot (detection time, ≤5 min old) passes $10K/100K/500K/1M/5M/10M/50M/100M/500M/1B | same NSM growth; never posted without a fresh quote. ZEC milestones add "(about $X)" when a quote is available |
| Legacy pool drain (`milestone`, `milestone:<sapling\|orchard\|sprout>_below:<zec>`) | first daily close below 500K/400K/…/1K ZEC after 30 closes at or above it | `privacy_trends_daily` per-pool closes (optional columns; absent reads as null); names the last earlier day at or below today's balance |
| Ironwood share (`milestone`, `milestone:ironwood_share:<pct>`) | first close at each whole percent from 85% | Ironwood ÷ shielded pool size, daily closes |
| Halving countdown (`halving`, `halving:<height>:<n>d`) | estimated days to the next halving within a day of 730/365/180/100/30/7/1 | consensus eras; subsidy `floor(12.5 ZEC × spacing / 150) >> halvings` |

Block-speed stories (first 24 hours, block milestones) are launch news and stop 30 days after activation; NSM milestones continue indefinitely.
Selection: "NU7 is live" uses protected lane 950 and is collected even while pacing; the countdown uses lane 700.
Other NU7 stories share two slots per UTC day (`nu7-daily-cap`); halving uses the per-type daily cap. Every story
carries `evidence.eventAt`, which `eventTime` uses for the activation watermark. Source replies scope each claim
(header times are not arrival times; protocol versions are self-reported). Previews:
`node scripts/preview-bot-editorial.js` renders illustrative NU7 fixtures through the production builders.

## Delivery and operations

A session advisory lock (839307) serializes senders. A unique outbox claim uses
`status=posting` before X is called, then stores `posted` plus the accepted X ID.
An ambiguous failure becomes `uncertain`; a process crash can leave `posting`.
Neither is retried automatically because X may have already accepted the post.
Check the account/accepted-ID logs and reconcile those exceptional rows before
any manual retry. This is operational failure handling, not editorial approval.

Two-part publication stores `deliveryVersion=2` and the prepared `sourceReply`
in the parent metadata before sending. The accepted parent is durably `posted`
before its independently claimed `source_reply:<parent-key>` is attempted.
Reply failure never resets the parent or causes it to be reposted. Replies
use the same table with `post_type=source_reply` and `deliveryRole=source_reply`.
A definite HTTP 429 rejection is `retryable`, with five-minute delay and at
most five attempts. Other definite 4xx responses are `blocked`; timeouts,
missing accepted IDs and database failures after acceptance are `uncertain`.
`posting` and `uncertain` children are held for reconciliation. Automatic token
refresh retries only a typed HTTP 401, never a number appearing in error text.

Each run recovers up to three eligible source replies for version-two parents
posted within seven days. A crash before the reply claim can be recovered;
legacy parents have no delivery-version marker and are never backfilled.
This recovery never creates another parent. Child records cannot consume a
story slot, trigger novelty penalties or delay the next parent through pacing.
Source URLs must use the approved HTTPS host and cannot target `/api` or `/v1`.
Compatible metric pages use stable chart/range URLs; other stories retain their
relevant hub or transaction link. Hashrate and scoped flow trends retain their
hub links rather than silently pointing at a different estimator or data scope.
Source replies date the observation and disclose when chart pages update over
time; links do not claim to be immutable historical evidence snapshots.

All X requests have a 20-second socket inactivity timeout. Cards repeat the
qualified copy; rendering/upload failure falls back to text. Editorial text
longer than 280 characters is rejected rather than truncated. This is a
conservative plain-text length bound; templates preserve full source URLs.

Every output keeps its structured evidence in outbox metadata. Every routine
candidate gets a journal decision when dropped by a cap, baseline, activation
cutoff or pacing. No schema migration is needed; statuses are text columns.

Read-only preview using the normal job database environment:

```sh
PGOPTIONS='-c default_transaction_read_only=on' node server/bot/preview.js --output=/tmp/editorial-preview.json
```

Preview imports no X client, does not refresh tokens, write outbox rows, initialize
activation or notify Telegram. Before activation it intentionally selects no
historical events. `BOT_DRY_RUN=1` also prevents all editorial outbox writes.

Rollout: release the reviewed source through the existing repository process,
restart only the bot as applicable, verify the activation row and first polling
logs, and let new events arrive. Do not manually publish old preview examples or
change the watermark to recover missed posts. Roll back bot source if needed;
retain the activation/outbox records so a later forward rollout stays deduplicated.

## Verification

`npm run test:bot` includes real PostgreSQL fixtures when
`ACTIVITY_TEST_POSTGRES=1` or `TEST_ACTIVITY_DATABASE_URL` is set. CI invokes it
alongside the existing activity and hashrate suites. Tests cover canonical-flow
validation, provider coverage labels, UTC boundaries, nulls/ties/zero baselines,
qualified ATHs, spacing/caps, persistent activation, future reporting periods,
concurrent dispatch deduplication, read-only previews and ambiguous sends.

The initial read-only production rehearsal (before adding the requested
activation cutoff) recovered the screenshot's 899.99975 ZEC Ironwood transaction,
ranked in the top 0.20% against 85,872 prior same-direction flows. It also generated
the 60,731/week rank-five story and a 29.23 GSol/s 7-day daily-sampled ATH, 1.7%
above the prior peak. These were **preview examples only**, not posts to publish.
The final activation filter deliberately suppresses this backlog.

Final future-only read-only production preview selected zero posts from five
older live candidates and finished in 1.76 seconds. No activation/outbox writes
or X requests occurred. This is one measured run, not a performance guarantee.
Initial local verification: 15 editorial tests, six activity tests and the hashrate
PostgreSQL fixture passed; server regressions passed 118 with four unrelated
opt-in fixtures skipped. Six example cards rendered successfully; the hashrate
card was visually inspected. Scoped ESLint has zero errors and five existing
X-client warnings. No frontend route changed, so SEO/HTML checks do not apply.

The 2026-10-28 local follow-up adds `bot-editorial-insights.test.js` (25 passing
tests with isolated PostgreSQL enabled) plus selection and two-part publication
regressions. Together these cover missing canonical rows/hashes, exact one-time
pool involvement, fully shielded migrations, mixed Sprout movements, unknown
fees/balances, 2/3 share display, signed chart data, independent reply failures
and duplicate protection. These are local source tests; production query cost,
future story mix and real source-reply delivery remain release acceptance gates.

A single bounded, read-only standby probe of the exact insight SQL, captured
**2026-10-28 19:39:20.271 UTC**, returned **37/37** complete days from September
21 through October 27, with public-flow coverage and fees available. Applying
the pure weekly builder produced the October 19–25 review example: **70,170**
non-coinbase transactions versus **51,041** the prior week; **47,586/70,170**
involving shielded pools versus **29,641/51,041**; and **1,329,300,244 zatoshis**
in fees versus **1,498,827,645**. Displayed figures are +37.4% transactions,
67.8% shielded share, +9.7 percentage points and 13.29 ZEC fees (−11.3%). No
pool-trend lens qualified. This is a measured builder/source review, not a
publication: a newly initialized feature marker excludes that historical week.
The standby query does not establish primary-service latency or p95 behavior;
it introduced no production writes, bot restart or native-process activation.

Copy version 2 (2026-10-01): `npm run test:bot` passed 22 tests locally, and the
PostgreSQL fixture passed against local PostgreSQL with
`ACTIVITY_TEST_POSTGRES=1`, covering the context savepoint fallback, priced copy
and milestone SQL. New tests cover milestone first-crossing, hovering, thin
history, stale target and daily cap; worst-case 280-character bounds; integer
truncation (512.05 ZEC stays 512.05). All 15 fixture cards were rendered and
inspected visually.


## Ironwood transaction milestone alerts — 2026-10-27

First released on 2026-10-27; exact revision and acceptance evidence are recorded
in the private operations wiki. Subsequent presentation refinements retain the
events, activation and data contract below.

### Events

- First Ironwood lead over Orchard in seven complete post-activation UTC days.
- First Ironwood lead over Orchard in thirty complete post-activation UTC days.
- First 90%, 95% and 100% thresholds against Orchard's transaction count in the
  same trailing 365 complete UTC days. The 100% event includes equality and says
  "caught up". It is not a comparison with Orchard's lifetime count.
- Lifetime Ironwood transaction landmarks: 100,000; 250,000; 500,000; 1 million;
  2 million; 5 million; and 10 million. These include the partial activation day.
- First 10%, 25%, 50% and 75% thresholds for Ironwood involvement in all canonical
  non-coinbase transactions over seven complete post-activation UTC days.

Every event retains exact counts, inclusive start and exclusive end, the
canonical source tip, capture time, activation height/timestamp and all
simultaneous first crossings. One lead achievement becomes the post and card;
the others remain structured evidence. Trailing-year parity leads, followed by
thirty-day leadership, seven-day leadership, volume landmarks, weekly share and
approaching-parity thresholds. Percentage cards use a threshold qualifier (≥).
Age context uses completed elapsed days from the indexed activation block,
and is included in the tweet when the complete copy fits within 280 characters.

Copy follows the existing event-first voice: "Ironwood just caught up with
Orchard's transaction count over the past year" and "Ironwood just overtook
Orchard in weekly transaction activity." Exact counts, dates and coinbase
exclusion remain in the body/footer. The frame, fonts, Ironwood gold and source
footer use the existing card renderer. Comparison totals directly label the
line endpoints, with `txs` beside each number. Comparison
charts show up to 90 daily endpoints; each endpoint uses the full stated
rolling window. For launch-day crossovers, a measured pre-launch endpoint
keeps both lines drawable without inventing a repeated point.

### Data authority

`readPoolActivity` uses a read-only repeatable-read PostgreSQL snapshot and a
60-second statement timeout. It requires the mainnet database, a tip no more
than 30 minutes old (or two hours in the future), and canonical activation block
3,428,143 on July 28, 2026 UTC. Activation-day activity is included in lifetime
counts; rate/share windows begin with the next complete UTC day.

History starts 365 days before activation and continues through yesterday.
This covers every relevant historical rolling window since Ironwood launched.
An enclosing contiguous canonical height span, including both shoulders,
detects missing blocks. Transactions join blocks by height and hash. Every
included block must have its expected transaction count and exactly one
coinbase. Missing pool classification, missing days and unsafe counts make the
comparison unavailable and cause the collector to fail for retry.

Transactions count once per pool they involve; pool series overlap. Transparent
transactions remain in the total denominator. Migrations are included. These
counts measure activity, not unique users, independent payments, private value
transferred or organic demand. A pool transaction is not an action or note.

### Scheduling and delivery

The existing five-minute bot tick evaluates newly completed days after 06:00
UTC. A separate persistent marker,
`analysis:pool_activity:activation:v1`, starts this feature with future reporting
periods. Existing global bot activation is preserved. Initial deployment does
not post the historical Ironwood milestones already achieved.

Each scan can recover original first-crossing reports from the last seven
completed reporting dates, provided their reporting time (next day at 06:00
UTC) is at or after the feature marker. Source failures are not marked evaluated.
Recovery preserves each milestone's original counts and dates. The existing
primary outbox history suppresses posted, posting and uncertain keys, and a
permanent unique key based on the lead achievement protects against duplicates
even if chain corrections move its first-crossing date. Ambiguous deliveries
retain the existing manual-reconciliation behavior.

The existing one-milestone-per-UTC-day cap and twenty-minute global spacing
apply. A higher-priority alert can defer this collector to a later run. Several
missed reporting dates may drain over several days; events older than seven
reporting dates are not recovered automatically. A published lead can carry
other simultaneous achievements as evidence without separately publishing each.

### Verification and release

`ACTIVITY_TEST_POSTGRES=1 npm run test:bot` includes the pure milestone policies,
feature activation/recovery/orchestration tests and real isolated PostgreSQL
coverage fixtures. Existing editorial delivery and card tests remain included.
Scoped ESLint covers the changed JavaScript files.

`node server/bot/preview.js --output=/tmp/pool-milestone-preview.json` uses the
existing read-only preview. It does not initialize the feature marker or publish
posts, and therefore intentionally previews no pool backlog before activation.
Release through the normal source review/deployment process, then verify the
feature activation marker and daily collector logs. Local fixtures do not prove
production completeness or query latency. Record deployed-source, activation
and service acceptance separately in the private operations wiki.
