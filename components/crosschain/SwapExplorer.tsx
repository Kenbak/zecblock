"use client";
import { RelativeTime } from "@/components/RelativeTime";
import { useState } from "react";
import {
  SwapFilterLink,
  updateSwapUrl,
  useSwapSearchParams,
} from "./SwapFilterLink";
import { TokenChainIcon } from "@/components/TokenChainIcon";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useCrosschainVenue } from "./VenueContext";
import { PanelTitle } from "./PanelTitle";
import { VenueTransferDetails } from "./VenueTransferDetails";
import {
  CHAINS,
  IS_DEMO,
  EXPLORERS,
  STATUSES,
  Swap,
  SwapPage,
  Unit,
  date,
  href,
  value,
} from "./model";
function SwapAsset({
  token,
  chain,
  amount,
  label,
}: {
  token: string;
  chain: string;
  amount: string | null;
  label: string;
}) {
  return (
    <span className="flex items-center gap-3 min-w-0">
      <TokenChainIcon token={token} chain={chain} size={32} />
      <span className="min-w-0">
        <span className="sr-only">{label}: </span>
        <span
          className="block font-mono text-sm font-medium text-primary break-all"
          title={amount == null ? "Amount withheld" : `${amount} ${token}`}
        >
          {amount ?? "—"} {token}
        </span>
        <span className="block text-xs text-muted mt-1">
          {CHAINS[chain] || chain}
        </span>
      </span>
    </span>
  );
}
const SWAP_COLUMNS =
  "grid grid-cols-2 md:grid-cols-[1fr_1.3fr_1.3fr_0.7fr_0.9fr] gap-x-4 gap-y-3 items-center";
function Hashes({ chain, hashes }: { chain: string; hashes: string[] }) {
  if (!hashes.length) return <span className="text-muted">Not reported</span>;
  return (
    <ul className="space-y-1">
      {hashes.map((hash) => (
        <li key={hash} className="break-all font-mono">
          {EXPLORERS[chain] && !IS_DEMO ? (
            <a
              className="text-cipher-gold hover:underline"
              href={EXPLORERS[chain] + encodeURIComponent(hash)}
              target={chain === "zec" ? undefined : "_blank"}
              rel="noopener noreferrer"
            >
              {hash}
            </a>
          ) : (
            hash
          )}
        </li>
      ))}
    </ul>
  );
}
function Detail({ swap: s }: { swap: Swap }) {
  if (s.providerRecord) return <VenueTransferDetails record={s.providerRecord} />;
  const fields = [
    ["Created (UTC)", date(s.createdAt)],
    ["Deposit address", s.depositAddress],
    [
      "Deposit memo",
      s.depositMemo === null
        ? "Unavailable in legacy index"
        : s.depositMemo || "None",
    ],
    ["Source amount (token units)", s.sourceAmount],
    ["Destination amount (token units)", s.destAmount],
    ["Reported source USD", s.amountUsd],
    ["Source asset", s.sourceAsset],
    ["Destination asset", s.destAsset],
    ["Raw input (smallest unit)", s.amountInRaw],
    ["Raw output (smallest unit)", s.amountOutRaw],
    ["Deposit type", s.depositType],
    ["Recipient type", s.recipientType],
    ["Referral", s.referral],
    ["Intent hashes", s.intentHashes],
    ["Reported sender addresses", s.senders?.join(", ") || null],
    ["Recipient", s.recipient],
    ["Refund destination", s.refundTo],
    ["Refund type", s.refundType],
    ["Refund reason", s.refundReason],
    ["Refund fee (source token)", s.refundFee],
    ["First indexed", date(s.firstSeenAt)],
    ["Last observed", date(s.lastSeenAt)],
    ["Status first observed", date(s.statusObservedAt)],
  ];
  return (
    <div className="mt-4 pt-4 border-t border-cipher-border space-y-4 text-xs">
      <div className="grid md:grid-cols-3 gap-4">
        <div>
          <p className="text-muted mb-2">
            Source transaction · {CHAINS[s.sourceChain] || s.sourceChain}
          </p>
          <Hashes chain={s.sourceChain} hashes={s.sourceTxHashes} />
        </div>
        <div>
          <p className="text-muted mb-2">
            Destination transaction · {CHAINS[s.destChain] || s.destChain}
          </p>
          <Hashes chain={s.destChain} hashes={s.destTxHashes} />
        </div>
        <div>
          <p className="text-muted mb-2">NEAR transactions</p>
          <Hashes chain="near" hashes={s.nearTxHashes} />
        </div>
      </div>
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
        {fields.map(([label, v]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="break-all font-mono mt-1">{v ?? "Not reported"}</dd>
          </div>
        ))}
      </dl>
      {s.appFees && s.appFees.length > 0 && (
        <div>
          <p className="text-muted">
            Reported application fees (basis points; not total swap cost)
          </p>
          {s.appFees.map((fee, i) => (
            <p key={i} className="break-all">
              {fee.fee} bps · {fee.recipient}
            </p>
          ))}
        </div>
      )}
      <p className="text-muted">
        Observation timestamps are indexer observations, not execution
        completion times. Unreported amounts remain unavailable.
      </p>
    </div>
  );
}
export function SwapExplorer({
  unit,
  statuses,
}: {
  unit: Unit;
  statuses: string[];
}) {
  const searchParams = useSwapSearchParams();
  const venue = useCrosschainVenue();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const params: Record<string, string> = {};
  for (const key of [
    "period",
    "direction",
    "status",
    "chain",
    "token",
    "search",
    "minUsd",
    "maxUsd",
    "from",
    "to",
    "cursor",
    "sourceAsset",
    "destAsset",
    "referral",
  ]) {
    const val = searchParams.get(key);
    if (val) params[key] = val;
  }
  params.period ||= "30d";
  if (venue !== "near") params.venue = venue;
  const field =
    "bg-cipher-bg border border-cipher-border rounded-lg px-3 py-2 text-sm w-full";
  return (
    <section className="card space-y-4" aria-label="Recent swaps">
      <PanelTitle
        title={venue === "near" ? "Recent swaps" : "Recent swaps & refunds"}
        controls={IS_DEMO ? (
          <span
            className="text-xs text-cipher-orange"
            title="Simulated swaps: fixture addresses and transaction IDs are examples."
          >
            Demo data
          </span>
        ) : undefined}
      />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <nav aria-label="Swap direction" className="filter-group">
            {[
              ["", "All"],
              ["inflow", "Into ZEC"],
              ["outflow", "Out of ZEC"],
            ].map(([direction, label]) => (
              <SwapFilterLink
                key={label}
                className={`filter-btn ${(params.direction || "") === direction ? "filter-btn-active" : ""}`}
                aria-current={
                  (params.direction || "") === direction ? "page" : undefined
                }
                href={
                  href(params, {
                    direction,
                    cursor: undefined,
                    sourceAsset: undefined,
                    destAsset: undefined,
                  }) + "#swaps"
                }
              >
                {label}
              </SwapFilterLink>
            ))}
          </nav>
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="swap-filter-form"
            aria-label="Search & filters"
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`filter-btn ${filtersOpen ? "filter-btn-active" : ""}`}
          >
            <span className="hidden sm:inline">Search & </span>Filters{" "}
            <span aria-hidden="true">{filtersOpen ? "−" : "+"}</span>
          </button>
        </div>
        {Object.keys(params).some(
          (key) => !["period", "cursor", "venue"].includes(key),
        ) && (
          <div
            className="flex flex-wrap gap-2 items-center text-xs"
            aria-label="Active swap filters"
          >
            {Object.entries(params)
              .filter(([key]) => !["period", "cursor", "venue"].includes(key))
              .map(([key, val]) => {
                const labels: Record<string, string> = {
                  direction: "Direction",
                  status: "Outcome",
                  chain: "Chain",
                  token: "Token",
                  minUsd: "Min USD",
                  maxUsd: "Max USD",
                  from: "From",
                  to: "Until",
                  search: "Search",
                  sourceAsset: "From asset",
                  destAsset: "To asset",
                  referral: "Referral",
                };
                const display =
                  key === "chain"
                    ? CHAINS[val] || val
                    : key === "direction"
                      ? {
                          inflow: "Into ZEC",
                          outflow: "Out of ZEC",
                          internal: "Zcash → Zcash",
                        }[val] || val
                      : key === "status"
                        ? {
                            SUCCESS: "Completed",
                            REFUNDED: "Refunded",
                            FAILED: "Failed",
                            PROCESSING: "Processing",
                            PENDING_DEPOSIT: "Awaiting deposit",
                            INCOMPLETE_DEPOSIT: "Incomplete deposit",
                          }[val] || val
                        : val;
                return (
                  <SwapFilterLink
                    key={key}
                    title={`${labels[key] || key}: ${display}`}
                    aria-label={`Remove ${labels[key] || key} filter: ${display}`}
                    href={
                      href(params, { [key]: undefined, cursor: undefined }) +
                      "#swaps"
                    }
                    className="inline-flex items-center gap-2 min-h-8 rounded-lg border border-cipher-border px-3 py-1 text-secondary hover:text-cipher-gold"
                  >
                    <span className="max-w-[220px] truncate">
                      {labels[key] || key}: {display}
                    </span>
                    <span aria-hidden="true">×</span>
                  </SwapFilterLink>
                );
              })}
            <SwapFilterLink
              className="inline-flex items-center min-h-8 text-cipher-gold px-3 py-1"
              href={href({ period: params.period }) + "#swaps"}
            >
              Clear filters
            </SwapFilterLink>
          </div>
        )}
      </div>
      <div id="swap-filter-form" hidden={!filtersOpen}>
        <form
          key={JSON.stringify(params)}
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const next: Record<string, string> = {};
            for (const [key, val] of fields.entries()) {
              if (typeof val === "string" && val.trim()) next[key] = val.trim();
            }
            updateSwapUrl(href(next) + "#swaps");
          }}
          action="/crosschain"
          method="get"
          className="grid grid-cols-2 md:grid-cols-4 gap-3"
        >
          <input type="hidden" name="period" value={params.period || "30d"} />
          {venue !== "near" ? <input type="hidden" name="venue" value={venue} /> : null}
          {["sourceAsset", "destAsset"].map((k) =>
            params[k] ? (
              <input key={k} type="hidden" name={k} value={params[k]} />
            ) : null,
          )}
          <label className="text-xs text-muted">
            Referral
            <input
              name="referral"
              defaultValue={params.referral}
              maxLength={256}
              className={field}
            />
          </label>
          <label className="text-xs text-muted">
            Direction
            <select
              name="direction"
              defaultValue={params.direction || ""}
              className={field}
            >
              <option value="">All directions</option>
              <option value="inflow">ZEC acquired</option>
              <option value="outflow">ZEC exchanged</option>
              <option value="internal">Zcash → Zcash</option>
            </select>
          </label>
          <label className="text-xs text-muted">
            Status
            <select
              name="status"
              defaultValue={params.status || ""}
              className={field}
            >
              <option value="">All indexed statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s} disabled={!statuses.includes(s)}>
                  {s.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Chain
            <input
              name="chain"
              list="crosschain-chain-options"
              defaultValue={params.chain || ""}
              placeholder="All chains, or chain ID"
              maxLength={32}
              className={field}
            />
            <datalist id="crosschain-chain-options">
              {Object.entries(CHAINS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </datalist>
          </label>
          <label className="text-xs text-muted">
            Token
            <input
              name="token"
              defaultValue={params.token}
              placeholder="e.g. USDC"
              maxLength={64}
              className={field}
            />
          </label>
          <label className="text-xs text-muted">
            Minimum USD
            <input
              name="minUsd"
              defaultValue={params.minUsd}
              type="number"
              min="0"
              step="any"
              className={field}
            />
          </label>
          <label className="text-xs text-muted">
            Maximum USD
            <input
              name="maxUsd"
              defaultValue={params.maxUsd}
              type="number"
              min="0"
              step="any"
              className={field}
            />
          </label>
          <label className="text-xs text-muted">
            From (UTC ISO)
            <input
              name="from"
              defaultValue={params.from}
              placeholder="2026-01-01T00:00:00Z"
              className={field}
            />
          </label>
          <label className="text-xs text-muted">
            Until (UTC ISO, exclusive)
            <input
              name="to"
              defaultValue={params.to}
              placeholder="2026-09-28T00:00:00Z"
              className={field}
            />
          </label>
          <label className="col-span-2 md:col-span-3 text-xs text-muted">
            Address or transaction hash
            <input
              name="search"
              defaultValue={params.search}
              maxLength={200}
              className={field}
            />
          </label>
          <div className="flex items-end gap-3">
            <button className="filter-btn filter-btn-active py-2" type="submit">
              Apply filters
            </button>
            <button
              type="reset"
              className="text-xs text-muted hover:underline"
              onClick={() =>
                updateSwapUrl(
                  href({ period: params.period || "30d" }) + "#swaps",
                )
              }
            >
              Reset
            </button>
          </div>
        </form>
      </div>
      <SwapResults key={JSON.stringify(params)} params={params} unit={unit} />
    </section>
  );
}

function SwapResults({
  params,
  unit,
}: {
  params: Record<string, string>;
  unit: Unit;
}) {
  const { data, loading, error, isRefreshing } = useApiQuery<SwapPage>(
    params.venue === "maya" || params.venue === "thorchain" ? "/v1/crosschain/venues/swaps" : "/v1/crosschain/swaps",
    { ...params, limit: "25" },
    { refreshInterval: params.cursor ? undefined : 120000 },
  );
  return (
    <div className="min-h-[320px]">
      {error && (
        <p role="alert" className="text-sm text-cipher-orange">
          Swap feed unavailable: {error}
        </p>
      )}
      {loading && !data ? (
        <p role="status">Loading swaps…</p>
      ) : (
        data && (
          <div aria-busy={isRefreshing}>
            {data.swaps.length > 0 && (
              <div
                className={`${SWAP_COLUMNS} text-xs text-muted font-mono uppercase pb-3`}
                aria-hidden="true"
              >
                <span className="hidden md:block">Time</span>
                <span>From</span>
                <span>To</span>
                <span className="hidden md:block text-right">Value</span>
                <span className="hidden md:block text-right">Status</span>
              </div>
            )}
            {data.swaps.length === 0 ? (
              <p className="text-muted py-8 text-center">
                No indexed swaps match these filters.
              </p>
            ) : (
              data.swaps.map((s) => (
                <details
                  key={s.id}
                  className="border-t border-cipher-border py-3 group"
                >
                  <summary className={`cursor-pointer ${SWAP_COLUMNS} text-xs`}>
                    <span className="font-mono text-muted order-3 md:order-1 col-span-2 md:col-span-1">
                      <RelativeTime timestamp={Date.parse(s.createdAt) / 1000} />
                    </span>
                    <span className="order-1 md:order-2">
                      <SwapAsset
                        token={s.sourceToken}
                        chain={s.sourceChain}
                        amount={s.sourceAmount}
                        label="From"
                      />
                    </span>
                    <span className="order-2 md:order-3">
                      <SwapAsset
                        token={s.destToken}
                        chain={s.destChain}
                        amount={s.destAmount}
                        label="To"
                      />
                    </span>
                    <span className="font-mono text-primary order-4 md:text-right">
                      {value(unit === "zec" ? s.zecAmount : s.amountUsd, unit)}
                    </span>
                    <span className="text-muted order-5 text-right">
                      {s.refundKind === "partial" ? "Partial refund" : s.status.replaceAll("_", " ")}{" "}
                      <span aria-hidden="true">⌄</span>
                      <span className="sr-only"> — expand details</span>
                    </span>
                  </summary>
                  <Detail swap={s} />
                </details>
              ))
            )}
            <div className="flex justify-between gap-4 border-t border-cipher-border pt-4 text-xs">
              <span className="text-muted">
                {data.swaps.length} records on this page
              </span>
              <div className="flex gap-4">
                {params.cursor && (
                  <SwapFilterLink
                    scrollToSwaps
                    className="text-cipher-gold"
                    href={href(params, { cursor: undefined })}
                  >
                    Newest matches
                  </SwapFilterLink>
                )}
                {data.nextCursor && (
                  <SwapFilterLink
                    scrollToSwaps
                    className="text-cipher-gold"
                    href={href(params, { cursor: data.nextCursor })}
                  >
                    Older matches →
                  </SwapFilterLink>
                )}
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}
