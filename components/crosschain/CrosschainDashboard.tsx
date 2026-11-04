"use client";
import { RelativeTimeProvider } from "@/components/RelativeTime";
import { useState } from "react";
import Link from "next/link";
import { useApiQuery } from "@/hooks/useApiQuery";
import { TokenChainIcon } from "@/components/TokenChainIcon";
import { LatencyComparisonChart } from "./LatencyComparisonChart";
import { ChainHistory } from "./ChainHistory";
import { OutcomeBreakdown } from "./OutcomeBreakdown";
import { ChainFlowOverview } from "./ChainFlowOverview";
import { PageSectionNav } from "@/components/PageSectionNav";
import { ActivityCharts } from "./ActivityCharts";
import { SwapFilterLink, useAnalyticsPeriod } from "./SwapFilterLink";
import { SwapExplorer } from "./SwapExplorer";
import { WrappedZecTracker, WrappedZecAsset } from "./WrappedZecTracker";
import { DisclosureSummary, PanelTitle } from "./PanelTitle";
import { CrosschainVenueContext, type CrosschainVenue } from "./VenueContext";
import {
  Analytics,
  CHAINS,
  IS_DEMO,
  PERIODS,
  Unit,
  date,
  href,
  value,
} from "./model";
const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "flows", label: "Flows" },
  { id: "swaps", label: "Swaps" },
  { id: "ecosystem", label: "Ecosystem" },
];
const PERIOD_LABELS: Record<string, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  "1y": "last 12 months",
  all: "all indexed history",
};
const OUTCOMES = [
  ["SUCCESS", "Completed", "bg-cipher-green"],
  ["REFUNDED", "Refunded", "bg-cipher-orange"],
  ["FAILED", "Failed", "bg-cipher-coral"],
  ["PROCESSING", "Processing", "bg-glass-12"],
  ["INCOMPLETE_DEPOSIT", "Incomplete deposit", "bg-glass-12"],
] as const;
export function CrosschainDashboard({
  params = {},
  venue = "near",
  venueTabs,
}: {
  params?: Record<string, string>;
  venue?: CrosschainVenue;
  venueTabs?: React.ReactNode;
}) {
  const [unit, setUnit] = useState<Unit>(venue === "near" ? "usd" : "zec");
  const [allRoutes, setAllRoutes] = useState(false);
  const [requestedPairSort, setPairSort] = useState<"swaps" | Unit>("swaps");
  const venueName = venue === "near" ? "NEAR Intents" : venue === "maya" ? "Maya Protocol" : "THORChain";
  const period = useAnalyticsPeriod(params.period || "30d");
  const { data, loading, error, isRefreshing } = useApiQuery<Analytics>(
    venue === "near" ? "/v1/crosschain/analytics" : "/v1/crosschain/venues/analytics",
    { period, ...(venue === "near" ? {} : { venue }) },
    { refreshInterval: 120000 },
  );
  const wrapped = useApiQuery<{
    assets: WrappedZecAsset[];
    totalWrapped: number;
  }>("/v1/crosschain/wrapped-zec/supply", undefined, {
    refreshInterval: 300000,
  });
  const unitToggle = (
    <div className="filter-group" role="group" aria-label="Volume unit">
      {(["usd", "zec"] as const).map((u) => (
        <button
          key={u}
          onClick={() => setUnit(u)}
          aria-pressed={unit === u}
          className={`filter-btn ${unit === u ? "filter-btn-active" : ""}`}
        >
          {u.toUpperCase()}
        </button>
      ))}
    </div>
  );
  if (loading && !data)
    return (
      <div className="space-y-4">{venueTabs}<div className="card min-h-[240px] text-muted" role="status">Loading indexed cross-chain activity…</div></div>
    );
  if (!data)
    return (
      <div className="space-y-4">{venueTabs}<div className="card" role="alert">
        <h2 className="text-secondary">{venueName} data unavailable</h2>
        <p className="text-sm text-muted mt-2">
          {error || "The analytics service has not returned a snapshot."}
        </p>
        <p className="text-sm text-muted mt-2">
          No zero-volume figures are inferred from an unavailable index.
        </p>
      </div></div>
    );
  const s = data.summary,
    c = data.coverage;
  const volume = s[`volume_${unit}`],
    inflow = s[`inflow_${unit}`],
    outflow = s[`outflow_${unit}`];
  const missing = unit === "usd" ? s.missing_usd : s.missing_zec;
  const net =
    inflow == null || outflow == null ? null : Number(inflow) - Number(outflow);
  const periodLabel = PERIOD_LABELS[period] || period;
  const metrics: [string, string, string, string?][] = [
    [
      "Volume",
      value(volume, unit),
      missing > 0
        ? `${missing.toLocaleString()} swaps without a ${unit.toUpperCase()} value`
        : `Reported amounts · ${periodLabel}`,
    ],
    ["Swaps", s.swaps.toLocaleString(), `Completed external swaps · ${periodLabel}`],
    [
      net == null ? "Net flow" : net >= 0 ? "Net into ZEC" : "Net out of ZEC",
      net == null ? value(null, unit) : `${net >= 0 ? "+" : "−"}${value(Math.abs(net), unit)}`,
      `${value(inflow, unit)} in · ${value(outflow, unit)} out`,
      net == null || net === 0 ? undefined : net > 0 ? "text-cipher-green" : "text-cipher-orange",
    ],
    [
      "Average swap",
      value(s[`average_${unit}`], unit),
      `Median ${value(s[`median_${unit}`], unit)}`,
    ],
  ];
  const fresh = !c.stale && !error;
  const outcomeTotal = OUTCOMES.reduce(
    (sum, [status]) =>
      c.statusesAvailable.includes(status)
        ? sum + (data.statuses.find((row) => row.status === status)?.count || 0)
        : sum,
    0,
  );
  const pairSort = data.routeRankings ? requestedPairSort : "swaps";
  const rankedPairs = data.routeRankings?.[pairSort] || data.routes;
  const routes = allRoutes ? rankedPairs : rankedPairs.slice(0, 6);
  const pairUnit = pairSort === "swaps" ? unit : pairSort;
  const pairMetric = (r: Analytics["routes"][number]) =>
    pairSort === "swaps" ? r.swaps : Number(r[`volume_${pairSort}`] ?? 0);
  const pairMax = Math.max(1, ...rankedPairs.map(pairMetric));
  return (
    <CrosschainVenueContext.Provider value={venue}>
    <div className="space-y-6" aria-busy={isRefreshing}>
      {IS_DEMO && (
        <aside
          className="card border-cipher-orange text-sm"
          aria-label="Preview data notice"
        >
          <p className="text-cipher-orange">
            Demo preview · simulated swaps, not live market activity.
          </p>
        </aside>
      )}
      <section id="overview" className="space-y-4 scroll-mt-40">
        <div className="flex flex-wrap justify-between items-center gap-3">
          {venueTabs}
          <div className="flex flex-wrap items-center gap-3">
            <nav aria-label="Analytics period" className="filter-group flex-wrap">
              {PERIODS.map((p) => (
                <Link
                  key={p}
                  href={href({ period: p, ...(venue === "near" ? {} : { venue }) })}
                  aria-current={period === p ? "page" : undefined}
                  className={`filter-btn ${period === p ? "filter-btn-active" : ""}`}
                >
                  {p.toUpperCase()}
                </Link>
              ))}
            </nav>
            {unitToggle}
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption font-mono text-muted">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${fresh ? "bg-cipher-green" : "bg-cipher-orange"}`} aria-hidden="true" />
          <span className={fresh ? "" : "text-cipher-orange"} role="status">
            {error ? "Refresh failed; showing last snapshot" : c.stale ? "Data may be out of date" : venueName}
          </span>
          <span aria-hidden="true">·</span>
          <span>Synced through {date(c.syncedThrough)}</span>
          <span aria-hidden="true">·</span>
          <span>{c.records.toLocaleString()} records since {date(c.earliest).slice(0, 10)}</span>
          {!c.historyTraversalComplete ? <><span aria-hidden="true">·</span><span>Historical backfill in progress</span></> : null}
          <a href="#data-details" className="text-cipher-gold hover:underline" onClick={() => { const el = document.getElementById("data-details"); if (el instanceof HTMLDetailsElement) el.open = true; }}>Coverage &amp; methodology</a>
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {metrics.map(([label, v, hint, tone]) => (
            <div key={label} className="card">
              <p className="text-caption text-muted uppercase font-mono">
                {label}
              </p>
              <p className={`text-xl sm:text-3xl font-mono tabular-nums mt-2 break-words ${tone || "text-primary"}`}>
                {v}
              </p>
              <p className="text-xs text-muted mt-2">{hint}</p>
            </div>
          ))}
        </div>
        <PageSectionNav sections={SECTIONS} ariaLabel="Cross-chain sections" />
        <ActivityCharts data={data} unit={unit} />
      </section>
      <section id="flows" className="space-y-4 scroll-mt-40">
        <ChainFlowOverview
          flows={data.flows || []}
          tokenFlows={data.tokenFlows}
          unit={unit}
          period={period}
        />
        <ChainHistory data={data} />
        <div id="routes" className="grid lg:grid-cols-2 gap-4">
          <ActivityCharts data={data} unit={unit} panel="sizes" />
          <section className="card space-y-4">
            <PanelTitle title="Top pairs" controls={
              <div
                className="filter-group"
                role="group"
                aria-label="Rank top pairs by"
              >
                {(["swaps", "usd", "zec"] as const).map((metric) => (
                  <button
                    key={metric}
                    type="button"
                    aria-pressed={pairSort === metric}
                    disabled={metric !== "swaps" && !data.routeRankings}
                    className={`filter-btn disabled:opacity-40 ${pairSort === metric ? "filter-btn-active" : ""}`}
                    onClick={() => {
                      setPairSort(metric);
                      setAllRoutes(false);
                    }}
                  >
                    {metric === "swaps" ? "Swaps" : `${metric.toUpperCase()} volume`}
                  </button>
                ))}
              </div>
            } />
            <p className="text-xs text-muted">
              {pairSort === "swaps"
                ? "Ranked by completed swap count."
                : `Ranked by reported ${pairSort.toUpperCase()} volume from completed swaps.`}{" "}
              Up to 100 pairs. Select a pair to see its swaps.
            </p>
            {!data.routeRankings && (
              <p className="text-xs text-muted">
                Volume ranking is not available from this data source yet.
              </p>
            )}
            {pairSort !== "swaps" && (
              <p className="text-xs text-muted">
                Missing valuations are excluded; totals use reported values only.
              </p>
            )}
            <div className="space-y-1">
              {routes.map((r) => (
                <SwapFilterLink
                  scrollToSwaps
                  key={JSON.stringify([
                    r.source_chain, r.source_asset || r.source_token,
                    r.dest_chain, r.dest_asset || r.dest_token,
                  ])}
                  title={`Median ${value(r[`median_${pairUnit}`], pairUnit)} · ${r.source_asset || r.source_token} → ${r.dest_asset || r.dest_token}`}
                  className="relative flex items-center justify-between gap-3 rounded-lg px-3 pt-3 pb-4 transition-colors hover:bg-glass-3"
                  href={
                    href({
                      period,
                      direction: r.direction,
                      status: "SUCCESS",
                      sourceAsset: r.source_asset || "",
                      destAsset: r.dest_asset || "",
                      chain:
                        r.direction === "inflow"
                          ? r.source_chain
                          : r.dest_chain,
                      token:
                        r.direction === "inflow"
                          ? r.source_token
                          : r.dest_token,
                    }) + "#swaps"
                  }
                >
                  <span
                    className="absolute bottom-1.5 left-3 right-3 h-1 rounded-full bg-glass-4 overflow-hidden"
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full bg-glass-12"
                      style={{ width: `${(pairMetric(r) / pairMax) * 100}%` }}
                    />
                  </span>
                  <span className="relative text-xs">
                    <span className="flex items-center gap-2 text-secondary">
                      <TokenChainIcon
                        token={r.source_token}
                        chain={r.source_chain}
                        size={22}
                      />
                      {r.source_token} →
                      <TokenChainIcon
                        token={r.dest_token}
                        chain={r.dest_chain}
                        size={22}
                      />
                      {r.dest_token}
                    </span>
                    <span className="block text-muted mt-1">
                      {CHAINS[r.source_chain] || r.source_chain} →{" "}
                      {CHAINS[r.dest_chain] || r.dest_chain}
                    </span>
                  </span>
                  <span className="relative text-right text-xs whitespace-nowrap">
                    <span className="block font-mono">
                      {pairSort === "swaps"
                        ? `${r.swaps.toLocaleString()} swaps`
                        : value(r[`volume_${pairUnit}`], pairUnit)}
                    </span>
                    <span className="text-muted">
                      {pairSort === "swaps"
                        ? value(r[`volume_${pairUnit}`], pairUnit)
                        : `${r.swaps.toLocaleString()} swaps`}
                    </span>
                  </span>
                </SwapFilterLink>
              ))}
            </div>
            {!routes.length && (
              <p className="text-xs text-muted">No pairs in this period.</p>
            )}
            {rankedPairs.length > 6 && (
              <button
                className="text-xs text-cipher-gold"
                onClick={() => setAllRoutes(!allRoutes)}
              >
                {allRoutes
                  ? "Show fewer pairs"
                  : `Show ${rankedPairs.length - 6} more pairs →`}
              </button>
            )}
          </section>
        </div>
      </section>
      <section id="swaps" className="space-y-4 scroll-mt-40">
        <section className="card space-y-4" aria-label="Swap outcomes">
          <PanelTitle
            title={venue === "near" ? "Swap outcomes" : "Swap & refund actions"}
            controls={<span className="text-caption text-muted font-mono">Latest observed status · select one to filter swaps</span>}
          />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {OUTCOMES.map(([status, label, dot]) => {
              const count = data.statuses.find((row) => row.status === status)?.count || 0;
              if (!c.statusesAvailable.includes(status))
                return (
                  <div key={status} className="rounded-lg border border-dashed border-cipher-border p-3" title={`${venueName} does not report this state in the indexed data.`}>
                    <p className="text-caption text-muted break-words">{label}</p>
                    <p className="text-sm text-muted mt-1.5">Not reported</p>
                  </div>
                );
              return (
                <SwapFilterLink
                  scrollToSwaps
                  key={status}
                  href={href({ period, status }) + "#swaps"}
                  className="rounded-lg bg-glass-3 p-3 transition-colors hover:bg-glass-6"
                >
                  <p className="flex items-center gap-1.5 text-caption text-muted break-words">
                    <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                    {label}
                  </p>
                  <p className="font-mono text-lg tabular-nums mt-1">{count.toLocaleString()}</p>
                  <p className="text-caption text-muted mt-0.5 tabular-nums">
                    {outcomeTotal > 0 ? `${((count / outcomeTotal) * 100).toFixed(1)}% of ${outcomeTotal.toLocaleString()}` : "No observed records"}
                  </p>
                </SwapFilterLink>
              );
            })}
          </div>
          {venue === 'near' ? <p className="text-xs text-muted">
            {c.source === "legacy-success-index"
              ? "This view currently covers completed swaps only; other outcome counts are unavailable. "
              : "Latest observed outcomes; older status changes appear after reconciliation. "}
            Unfunded pending-deposit quotes are excluded.
          </p> : null}
          <OutcomeBreakdown data={data} />
        </section>
        <RelativeTimeProvider initialNow={Date.parse(data.end)}>
          <SwapExplorer unit={unit} statuses={c.statusesAvailable} />
        </RelativeTimeProvider>
      </section>
      <section id="ecosystem" className="space-y-3 scroll-mt-40">
        {wrapped.data && (
          <WrappedZecTracker
            assets={wrapped.data.assets}
            totalWrapped={wrapped.data.totalWrapped}
            unit="zec"
          />
        )}
        {wrapped.error && (
          <p className="text-xs text-muted">
            Wrapped-token supply is temporarily unavailable.
          </p>
        )}
        <p className="text-xs text-muted">
          Token supplies are separate contract observations, not swap volumes or
          a proof of reserves. Their sum is not a measure of unique backing.
        </p>
      </section>
      <details className="card group">
        <DisclosureSummary title="Confirmation times & referrals" />
        <div className="mt-5 space-y-4">
        {data.latency.length > 0 && (
          <LatencyComparisonChart
            inbound={data.latency
              .filter((r) => r.direction === "inflow")
              .map((r) => ({
                chain: r.chain,
                chainName: CHAINS[r.chain] || r.chain,
                medianMinutes: r.median_minutes,
                swapCount: r.samples,
              }))}
            outbound={data.latency
              .filter((r) => r.direction === "outflow")
              .map((r) => ({
                chain: r.chain,
                chainName: CHAINS[r.chain] || r.chain,
                medianMinutes: r.median_minutes,
                swapCount: r.samples,
              }))}
          />
        )}

        <div className="grid sm:grid-cols-2 gap-4 text-xs text-muted">
          <p>
            Median swap:{" "}
            <span className="text-primary">
              {value(s[`median_${unit}`], unit)}
            </span>
          </p>
          <p>
            Distinct source addresses:{" "}
            <span className="text-primary">
              {s.sender_addresses.toLocaleString()}
            </span>{" "}
            (not a count of people)
          </p>
        </div>
        <section id="execution" className="grid lg:grid-cols-2 gap-4">
          <div className="card space-y-4">
            <PanelTitle title="Reported referrals" controls={<span className="text-caption text-muted font-mono">Distribution channels</span>} />
            {data.referrals.length > 0 && (
                <ul className="text-xs space-y-2">
                  {data.referrals.map((r) => (
                    <li
                      key={r.referral || "unknown"}
                      className="flex gap-3 justify-between"
                    >
                      <span className="break-all">
                        {r.referral || "Not reported"}
                      </span>
                      <span className="text-muted whitespace-nowrap">
                        {r.successful} successful · {r.refunded} refunded ·{" "}
                        {r.failed} failed / {r.observed}
                      </span>
                    </li>
                  ))}
                </ul>
            )}
            {!data.referrals.length && <p className="text-xs text-muted">No referral observations are available for this selection.</p>}
          </div>
          <div className="card space-y-4">
            <PanelTitle title="Zcash confirmation leg" />
            <p className="text-xs text-muted">{data.latencyDefinition}</p>
            <div className="overflow-x-auto max-h-[280px]">
              <table className="w-full text-xs">
                <thead className="text-muted text-left">
                  <tr>
                    <th className="py-2 font-normal">Route</th>
                    <th className="font-normal">Median</th>
                    <th className="font-normal">P90</th>
                    <th className="font-normal">Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {data.latency.map((r) => (
                    <tr
                      key={r.chain + r.direction}
                      className="border-t border-cipher-border"
                    >
                      <td className="py-2 pr-3">
                        {r.direction === "inflow"
                          ? `${CHAINS[r.chain] || r.chain} → ZEC`
                          : `ZEC → ${CHAINS[r.chain] || r.chain}`}
                      </td>
                      <td>{r.median_minutes.toFixed(1)}m</td>
                      <td>{r.p90_minutes.toFixed(1)}m</td>
                      <td>{r.samples.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.latency.length && (
              <p className="text-xs text-muted">
                No qualifying matched samples.
              </p>
            )}
          </div>
        </section>
        </div>
      </details>
      <details id="data-details" className="card group text-xs text-muted scroll-mt-40 [&[open]>*:not(summary)]:mt-3">
        <DisclosureSummary title="Data coverage & methodology" />
        <div className="rounded-lg border border-cipher-border p-4 text-xs text-muted space-y-2">
          <p><span className="text-secondary">Venue / source:</span> {venueName} · {c.source}</p>
          <p>
            <span className="text-secondary">Indexed history:</span>{" "}
            {date(c.earliest)} → {date(c.latest)} · {c.records.toLocaleString()}{" "}
            records ·{" "}
            {c.historyTraversalComplete
              ? "Historical API traversal complete"
              : "Historical coverage incomplete / unverified"}
          </p>
          <p>
            <span className="text-secondary">Synced through:</span>{" "}
            {date(c.syncedThrough)} ·{" "}
            <span className={c.stale || error ? "text-cipher-orange" : ""}>
              {error
                ? "Refresh failed; showing last snapshot"
                : c.stale
                  ? "Stale or unverified"
                  : "Recent sync"}
            </span>{" "}
            · {c.missingZecHash.toLocaleString()} records without a reported ZEC
            transaction hash.
          </p>
          {c.source === "near-explorer-v2" && (
            <p>
              Continuous historical traversal through{" "}
              {date(c.continuousThrough)}. Unverified intervals remain gaps.
            </p>
          )}
          {c.source === "legacy-success-index" && (
            <p>
              This dataset contains successful swaps only. Other outcome counts
              are unavailable here. Pending-deposit quotes are excluded.
            </p>
          )}
          {venue !== "near" && !c.historyTraversalComplete ? <p>Historical backfill is in progress. Statistics cover the indexed records currently available; unobserved intervals remain gaps.</p> : null}
          {missing > 0 && (
            <p className="text-cipher-orange">
              {missing.toLocaleString()} successful swaps have no{" "}
              {unit.toUpperCase()} valuation. Totals cover the reported values
              only.
            </p>
          )}
        </div>
        <p className="text-xs text-muted">
          {unit === "zec"
            ? "ZEC uses actual reported swap amounts, never conversion at today’s price."
            : "USD uses the reported source-side valuation."}{" "}
          Swaps of ZEC-backed tokens on other chains retain their own chain
          identity. Direction follows the asset route; {venue === "near" ? "an Intents-balance trade does not itself prove an on-chain deposit or withdrawal." : "provider-reported native legs remain separate from independently verified chain finality."}
        </p>

        <p>
          Outcomes show the latest observed status for each record created in
          the selected period. {venue === "near" ? "Unfunded pending-deposit quotes are excluded; these figures do not measure quote conversion." : "Separate refund actions do not create extra successful swap volume."}
        </p>
        <p>
          Charts use UTC intervals. The first and last intervals may be partial;
          gaps indicate unknown coverage.
        </p>
        <p>
          {venue === "near" ? "Swap sizes use reported dollar values; swaps with missing USD values are excluded." : "Size buckets use provider-reported prices at the first swap interval. Missing valuations are excluded; these estimates are not settlement-time or current-price valuations."}
        </p>
        <p>
          Chain history shows weekly net native ZEC on successful external
          routes. Missing ZEC amounts leave the cell unavailable; unverified
          empty intervals stay gaps. Token flows group reported symbols within
          each chain; matching symbols are not proof of identical assets.
        </p>
        <p>
          Timeline comparisons use separate daily reference datasets. Swap
          activity is aggregated daily while a comparison is open; an unknown
          hour leaves a daily gap. First and last days can be partial. Price
          comes from valuation history; net shielding is public shielding minus
          deshielding, not a change in total shielded balances or evidence of
          swap proceeds being shielded.
        </p>
        <p>{c.note}</p>
        <p>{data.volumeDefinition}</p>
        <p>
          {c.internalSwaps.toLocaleString()} indexed Zcash → Zcash routes are
          available in the swap explorer but excluded from the external-route
          analytics.
        </p>
        <a
          href={venue === "near" ? "https://docs.near-intents.org/api-reference/get-transactions" : venue === "maya" ? "https://docs.mayaprotocol.com/mayachain-dev-docs/concepts/connecting-to-mayachain" : "https://dev.thorchain.org/concepts/connecting-to-thorchain.html"}
          className="text-cipher-gold hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {venue === "near" ? "NEAR Explorer API definitions" : `${venue === "maya" ? "Maya" : "THORChain"} provider definitions`} ↗
        </a>
      </details>
    </div>
    </CrosschainVenueContext.Provider>
  );
}
