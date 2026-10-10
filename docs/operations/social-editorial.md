# Automatic factual social analysis

Prepared 2026-09-29. This document describes the new implementation, not evidence
of production deployment. `server/bot/index.js` now invokes `jobs/editorial.js`;
the old realtime and digest modules remain available as source history but are
not scheduled. No schema migration, public route, indexation or API change.

The owner selected automatic publication of verified factual analysis, without
human review or Telegram approval, and explicitly requested **new events only**.
No LLM writes the copy. Calculations, qualification rules and templates determine
all claims. No messages are sent to a new Telegram destination.

## Copy voice (copy version 2)

Every post starts with the ZecBlock marker 🟨, leads with the event in plain
words, adds one sentence on why it matters, then the `zecblock.com` link.
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
Each story builds its card (`evidence.card`) next to its tweet copy, so the two
cannot disagree. All cards are 1200×675 with the ZecBlock dark tokens, Geist /
Geist Mono, the logotype, one headline number, one sentence, one short
qualifier, the shortened source link and UTC date. Visuals by type:

- Shield/deshield: green `+amount` or red `−amount`; Transparent (outline) above
  the pool with a neutral white arrow and current balances. USD sits in the line,
  for example "left Ironwood (≈ $2.13M)".
- Migration: Orchard above Ironwood, Ironwood tone, "Pool migration, not new shielding."
- Swap: chain icons with ZEC ringed in gold; green into ZEC, red out of ZEC.
- Daily activity, signals, hashrate, milestones: a series with a zero-based
  y-axis and a dashed reference (30-day average, previous peak or the level).
  Hashrate charts only the samples behind the claim, at most 91 days.
- Weekly activity: a top-ten rank strip when ranked ≤10, otherwise number only.
- Cross-chain daily: into/out-of-ZEC bars. Reorg: a fork diagram.

Missing values, a non-`zecblock.com` link, or text that cannot fit at a minimum
size throw, and delivery falls back to text instead of a clipped or misleading
image. `node output/bot-examples/render.js` renders every fixture type locally.

The source change does not alter credentials, automatic posting cadence,
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
remain eligible for retry. Posting priority: reorg, exceptional swap, shielding
or deshielding, milestone, weekly activity, hashrate, daily activity, contextual
network signal, ordinary swap, cross-chain daily summary, pool migration.

## Selection and data contracts

| Topic | Qualification and limits | Authority and wording |
|---|---|---|
| Shielding/deshielding | >=500 ZEC and inclusive upper tail <=0.5%; >=100 prior samples; two per direction per UTC day | Canonical transaction-joined `shielded_flows`; verify net Sapling+Orchard+Ironwood balance, transparent involvement and non-coinbase; prior 90 days of the same direction, excluding candidate timestamp; exact rank with ties; rounded percentage never overstates rarity. This does not cover Sprout-only flows or private transferred amounts. |
| Swaps | >=$50,000 and inclusive upper tail <=1%; >=100 prior samples | Successful external ZEC routes in legacy `cross_chain_swaps`; rank on positive provider-reported **source USD**, never larger-of-two legs. Explicit NEAR 1Click observed sample, not all trading or all Intents activity. Missing source USD excludes ranking. |
| Swap pacing | One ordinary slot each UTC half-day, plus one exceptional slot per UTC day | Exceptional means >=$1,000,000 and upper tail <=0.1%. Exceptional events retain capacity when ordinary slots are used. |
| Activity | One daily lead selected from share, shielded-component count, fully shielded count and total non-coinbase count | Canonical raw `transactions`/`blocks` through `readActivity`; complete target day plus 30 prior days; fresh tip and reconciled counts. Share differences use percentage points. Counts exclude coinbase; fully shielded means no transparent I/O; migrations are included. No unique-user/adoption claim. |
| Weekly activity | Existing noteworthy rules: >=1,000 and top-ten rank, >=52 weeks since equal/higher, first record, or >=100% growth | Recompute complete Monday–Sunday weeks from 2016-10-31; genesis-contiguous history, fresh tip and reconciled counts. Explicit ties, exact comparison metadata. Reviewed legacy rows are respected. |
| Hashrate | New high >=1% above prior peak; fallback to 91/31 daily samples | Shared `target-work-v1`, trailing **7-day** estimate sampled at UTC midnight. ATH requires >=366 continuous valid samples, full genesis block-height coverage, no missing targets/windows. Otherwise only a bounded-window high is possible. Exact peak comparison retained. |
| Hashrate cooldown | Seven days unless >=5% above last published hashrate | No repeating every marginal record. Not instantaneous hashrate or a direct hardware measurement. |
| MVRV and network signals | Complete 31-day series; >=20% from prior 30-day mean and new high/low or absolute z-score >=3 | MVRV=`mvrv_daily` modeled market/realized-cap ratio; exchange destinations=`turnstile_daily`, deposits not sales; fees=`blocks`, incomplete fee values unavailable; shielding/deshielding=verified net flows. Copy leads with value, mean, relative change, UTC date and scope. z-scores only select candidates, not headline copy. |
| Signal pacing | One/day, seven-day same-metric cooldown; break on >=25% change from last published value | Nulls, gaps, nonfinite values and zero comparison means cannot become fabricated changes. |
| Cross-chain daily | One completed UTC day; >=10 valued swaps, both directions available | Positive source USD on observed successful external routes; in/out/net, top route by USD, largest observed swap. Missing directional valuation is unavailable, not zero. Ingestion updated_at must be <=20 minutes old; this is an operational freshness gate, not proof of provider completeness. |
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

## Delivery and operations

A session advisory lock (839307) serializes senders. A unique outbox claim uses
`status=posting` before X is called, then stores `posted` plus the accepted X ID.
An ambiguous failure becomes `uncertain`; a process crash can leave `posting`.
Neither is retried automatically because X may have already accepted the post.
Check the account/accepted-ID logs and reconcile those exceptional rows before
any manual retry. This is operational failure handling, not editorial approval.

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
Local verification: 15 editorial tests, six activity tests and the hashrate
PostgreSQL fixture passed; server regressions passed 118 with four unrelated
opt-in fixtures skipped. Six example cards rendered successfully; the hashrate
card was visually inspected. Scoped ESLint has zero errors and five existing
X-client warnings. No frontend route changed, so SEO/HTML checks do not apply.

Copy version 2 (2026-10-01): `npm run test:bot` passed 22 tests locally, and the
PostgreSQL fixture passed against local PostgreSQL with
`ACTIVITY_TEST_POSTGRES=1`, covering the context savepoint fallback, priced copy
and milestone SQL. New tests cover milestone first-crossing, hovering, thin
history, stale target and daily cap; worst-case 280-character bounds; integer
truncation (512.05 ZEC stays 512.05). All 15 fixture cards were rendered and
inspected visually.
