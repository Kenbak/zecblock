# ZecBlock visualization inventory and decisions

5 September 2026 · Source audit of frontend, plus the supplied screenshots.

This is a format/communication audit, not verification of every upstream statistic. Screenshots show historical observations. “Implemented” identifies structural changes in this branch; all other decisions are recommendations. Every existing visualization inherits shared tokens where used; this is not equivalent to rebuilding every plot.

## Inventory method

Searched app and components for Recharts, Visx, SVG/canvas, D3, React Three Fiber and React Flow, then inspected the chart catalog, page composites and custom CSS encodings. Icon-only SVGs are excluded. The catalog at app/charts/ChartsClient.tsx exposes 20 metric entries and four custom visual links; additional visualizations live outside that catalog.

## Explorer and activity

- `RecentBlocks`, `RecentTransactions`, `RecentShieldedTxs`, `RecentMempool`, `HomeFeedCard`, `ui/DataTable`: exact recent-event lookup. Tables are the right format; keep the configurable pair and mempool. Implemented shared rules, mono numeric rhythm and calmer boundaries. No arbitrary sparkline beside a hash.
- `BlockActivityChart`: bytes by block, plus Crosslink finality. Existing logarithmic bars did not match the visible 0/mid/max labels. **Implemented linear heights and correct midpoint**, keyboard-focus detail, no hover scaling. Very small blocks are allowed to be visually small; exact bytes remain accessible. Recommended next: thin time-gap markers only when actual timestamps establish gaps.
- `MempoolBubbles`: transaction-size spatial display with lifecycle animation. Useful as an optional live view, inefficient as the main pending list. Keep the conventional list primary. Decorative hex fields, scan line, gloss and ambient glow should be retired; do not infer privacy from bubble size. Palette migration applies here; physics and animation remain a later redesign.
- `CrosslinkChainGraph` and lazy wrapper: actual PoW/BFT topology, finality and staking. Keep its special-purpose graph; recommended reduce atmospheric layers and distinguish finalized/voting/pending with words or stroke style. Do not substitute an invented decorative chain for real graph relationships.
- `PulseWidget`, pulse page: statistical anomaly summaries. Keep compact text and magnitude; no always-rising “network health” sparkline. Detection thresholds and statistical caveats must remain visible.
- `app/txs/TxsClient`: archive transaction mix composition bar. Keep compact exact fractions; ensure denominator and active filter agree.

## Supply and pools

- `pools/SupplyTreemap`, `PoolOverviewHero`: absolute supply composition against 21M, with nested shielded pool composition. A one-dimensional proportional strip is enough for the first question; retain nested drill-in because it adds information. **Implemented much shorter map and more readable labels/focus**. Never inflate a tiny pool to make its label fit; keep labels in the accompanying ledger.
- `SupplyTimelineScrubber`: historical supply snapshots and upgrade markers. Keep; label UTC snapshot time and distinguish observed snapshots from interpolation. Mobile tick reduction should preserve upgrade annotations.
- `InteractiveCompositionBar`: reusable exact composition primitive. Keep; align legend order with segment order. Small segments get text equivalents, not minimum-width distortion.
- `network/PoolDistributionChart`: supply history, composition and growth rate. Keep separate units/views; amount area and percentage composition answer different questions. Consider small-multiple pool trends rather than overlaying incomparable scales. Current/latest emphasis does not change historical colors.
- `ShieldedPoolMiniChart`: homepage-selectable stacked pool history. Good compact alternative to a second table. Preserve real history; lower fill weight, expose units and current total without creating another hero card.
- `pools/FlowVolumeChart`: shield/deshield volume and count with period controls. Keep directional bars around an explicit zero baseline; volume and count must stay distinct. Recommend gold/iris for pool identity, sage/clay only for direction, never simultaneously ambiguous color meanings.
- `pools/TurnstileTracker`: distribution and daily destination breakdown of publicly observable deshielding. Keep the breakdown and exact ledger together. Display classification confidence/unavailable categories; do not imply shielded ownership linkage.
- `network/NetworkClient` supply distribution: compact pool bar. Keep; shared semantic pool colors must agree with the dedicated pools page. Its denominator is chain supply, not the 21M cap; retain that distinction.
- `network/HalvingPanel`: issuance curve, supply/halving schedule and progress. Keep discrete events and schedule caveats; step encoding when rates actually change, not a smoothed curve.

## Ironwood

- `SupplyVerification`: verified supply ratio and pool ledger. **Replaced oversized donut with exact linear proportion and explicit verified/pending values.** Old code forced a minimum 5% pending slice and a fictional 50/50 split when unavailable. Both removed. Server-computed verifiedPct remains the authority; invalid/unavailable values draw no split. Share text no longer unconditionally asserts “No inflation detected.”
- `MigrationActivity`: cohort counts, daily volume/activity and migration progress. Keep bars for bucketed events and an independent cumulative view; clearly separate ZEC, transactions and percentages. Recommend integrated compact headline + plot rather than another nested card.
- `InflowSources`, `InflowFlow`: source composition and migration route schematic. Keep exact source categories; widths only represent amounts where the data supports that. **Shared inflow palette now matches source identity**, replacing several gold opacities. Public flow does not identify hidden owners.
- `MigrationTiers`: cohort tiers / migration participation. Keep ranked rows with small bars; distinguish count share from value share and preserve tier definitions.
- `PrivacyScore`, `PrivacyScatterChart`, `VolumeAreaChart`: amount distinguishability, distribution and anonymity proxies. Keep scatter for amount/time relationships; no smoothed “privacy improvement” claim. Outliers and standard denominations require explicit legend and tooltip. Label estimates as estimates.
- `TurnstileHero`, `TurnstileScene`: interactive 3D migration narrative. The 3D scene is disproportionate for routine inspection. Recommended replace default with planar Orchard → turnstile → Ironwood diagram and exact accumulated quantities; keep any exploratory animation optional. This branch does not rewrite the scene.
- `ComplianceSection`: tier/compliance proportions. Preserve method, denominator and unavailable semantics. Compact bars plus text outperform decorative gauges.

## Mining, network and fees

- `network/NetworkHashrateChart`: observed hashrate over time. **Implemented unfilled linear line chart**, horizontal grid, shorter frame; removes area gradient and spline implication. Keep GSol/s units and period selection.
- `network/MiningMetricsChart`: solrate, difficulty, rolling block interval. One selected metric per axis is appropriate. Recommended value + sparkline at summary level, full plot only for detail; label rolling window and units.
- `app/mining/page`: mining-pool distribution donut, per-pool historical share area/line, miner earned-vs-moved grouped bars and rankings. Donut duplicates the pool ledger: recommend ranked horizontal bars with exact shares. Retain historical shares; use stable miner ordering/colors and a neutral Other. Earned/moved are flows; held is stock and should not share an unlabeled scale.
- `network/NetworkHistoryCharts`: chain size (GB) history. Good sparkline candidate with latest size, growth delta and time range. Full chart available for history; no gradient required.
- `network/ProtocolStatsChart`: monthly commitments/nullifiers. Grouped bars or small multiples preserve discrete monthly observations. Keep protocol labels and count units; don't collapse commitments into transaction counts.
- `network/FeeDistributionChart`: fee percentile bands p10–p90. Keep median plus restrained interval band; label percentiles as distribution, not confidence bounds. Outliers and zero/missing fees remain distinguishable. Do not reduce this to average fees.
- `NodeMap`, `network/NodeGeoLayerMap`, `network/TopologyGraph`: location lenses and peer relationships. Geography is meaningful here. Keep 2D default and top-country ledger; no pulsing decorative city lights. Crawler coverage, geolocation uncertainty and actual connectivity remain separate concepts.
- `app/network/nodes/NodesClient`: client donut, version breakdown, upgrade/readiness, concentration and node table. Recommend replace client donut with aligned count/share bars; sparse version categories can be text only. Keep unidentified nodes explicit.

## Privacy and address inspection

- `privacy/PrivacyTrendsSection`: adoption line, shielded/transparent activity bars, pool growth areas. Keep as three related questions, with shared time range but separate units. Catalog previews should reuse these definitions.
- `privacy/AnonymitySetChart`: potential matching sources by amount. Keep distribution, expose population/window and caveats; never label the estimate “probability of anonymity.”
- `privacy/ShieldingDistributionChart`: shield/deshield amount-bucket histogram. Keep true bin boundaries and counts; compare directions consistently. Highly skewed bins may warrant an explicit log-scale option, not an undisclosed transform.
- `PrivacyLinkGraph`, `RiskyTxCard`, `BatchPatternCard`: evidence/candidate graph and relationship summaries. Keep graph for actual relationships and uncertainty, not a graph for every alert. Provide accompanying ordered facts and selectable nodes.
- `app/address/[address]/components/AddressBubbleMap`: address transaction relationships and amount layout. Useful exploratory view; exact history table remains primary. Unknown shielded destinations must not become inferred recipients.
- `app/tx/[txid]/components/TxHeroFlow`, `FlowChain`, `InputsSection`, `OutputsSection`: transaction public input/output structure. Preserve clear public/shielded boundaries. Recommended one planar flow with aligned counts/amounts, not nested cards and redundant arrows. No drawn linkage across hidden shielded internals.
- `app/privacy/wallets/WalletsClient`: fee-lane history, wallet composition donut, fingerprint/feature and fee-category bars. History is useful; replace donut with ranked shares to compare small categories. Standard fee behavior does not establish wallet identity. Preserve classification limitations.
- `ui/RadialGauge`, `MetricCard`, `FactBox`: scalar metrics and bounded progress. Recommend inline value + short progress rule except when a gauge really represents a bounded threshold. Never draw 0% for unavailable.

## Crosschain

- `crosschain/LatencyComparisonChart`: per-chain latency distributions. Keep comparison by median/quantiles; label seconds/minutes and sample size. An average alone hides long tails.
- `crosschain/WrappedZecTracker`: wrapped balances, reserves and progress. Prefer compact exact ledger and coverage indicator. Backing claims must be scoped to data authority, not implied by a green bar.

## Valuation and temporal patterns

- `app/valuation/page`: price vs realized price, MVRV, SOPR, NUPL, HODL waves and dormancy. Keep dedicated views with exact definition/threshold labels; these are transparent UTXO observations plus shielded-flow approximations, not complete knowledge of private holdings. Neutral comparison bands, distinct ratio baselines, consistent time range. HODL stacks need ordered age bins; no rainbow.
- `app/usage-clock/UsageClockClient`: hourly dial, regional distribution/map, daylight correlation, machine-hour residuals, 7×24 heatmap. The weekly heatmap is the strongest compact representation. Keep it primary; dial is secondary. Temporal usage correlations cannot establish user geography. One sequential luminance scale, explicit UTC and count legend; residuals centered on zero.
- `app/charts/ChartsClient`: mini-chart catalog of the above. Keep miniatures as navigation previews, not competing full dashboards. Preview aggregation must match destination; no duplicate metrics with different definitions. Sparklines should omit furniture but retain a metric, period and unit.

## Coherence checks

The same pool must keep the same color across all views; type and unit formatting must survive chart/table transitions. Exact data remains in the existing APIs and value renderers. Chart branding belongs below the plot, never diagonally across it. Legends must remain readable in both themes. Every proposed future format change needs source/denominator review and representative visual testing before it can be called complete.
