"use client";
import { DisclosureSummary } from "./PanelTitle";
import { useState } from "react";
import { TokenChainIcon } from "@/components/TokenChainIcon";
import { Analytics, CHAINS, href, value } from "./model";
import { SwapFilterLink } from "./SwapFilterLink";

const WEEK = 7 * 86400000;
export function ChainHistory({ data }: { data: Analytics }) {
  const [all, setAll] = useState(false);
  const start = Date.parse(data.start),
    end = Date.parse(data.end);
  const monday = new Date(start);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const weeks: number[] = [];
  for (let t = monday.getTime(); t < end; t += WEEK) weeks.push(t);
  const cells = new Map(
    (data.chainHistory || []).map((r) => [
      `${r.chain}:${Date.parse(r.bucket)}`,
      r,
    ]),
  );
  const max = Math.max(
    1,
    ...(data.chainHistory || []).map((r) => Math.abs(Number(r.net_zec || 0))),
  );
  const chains = all ? data.flows : data.flows.slice(0, 8);
  const verifiedThrough =
    data.coverage.historyTraversalComplete && !data.coverage.stale
      ? Math.min(
          Date.parse(data.coverage.continuousThrough || ""),
          Date.parse(data.coverage.syncedThrough || ""),
        )
      : NaN;
  return (
    <details className="card group">
      <DisclosureSummary title="Weekly chain history" />
      <p className="text-xs text-muted my-4">
        Weekly net ZEC · green into ZEC · orange out · stronger color means more
        · gaps unknown
      </p>
      {data.chainHistory ? (
        <div className="overflow-x-auto">
          <table
            className="w-full text-xs border-separate"
            style={{ borderSpacing: 4 }}
          >
            <caption className="sr-only">
              Net ZEC by chain and UTC week. Boundary weeks are partial.
            </caption>
            <thead>
              <tr>
                <th className="text-left text-muted font-normal w-[140px] min-w-[140px]">
                  Chain
                </th>
                {weeks.map((t) => (
                  <th
                    key={t}
                    className="text-muted font-normal min-w-[38px]"
                    title={`Week of ${new Date(t).toISOString().slice(0, 10)} UTC`}
                  >
                    {new Date(t).toISOString().slice(5, 10)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chains.map(({ chain }) => (
                <tr key={chain}>
                  <th className="font-normal text-secondary text-left">
                    <span className="flex items-center gap-2">
                      <TokenChainIcon token={chain} chain={chain} size={20} />
                      {CHAINS[chain] || chain}
                    </span>
                  </th>
                  {weeks.map((t) => {
                    const row = cells.get(`${chain}:${t}`);
                    const net = row
                      ? row.net_zec == null
                        ? null
                        : Number(row.net_zec)
                      : t >= start && t + WEEK <= verifiedThrough
                        ? 0
                        : null;
                    const partial = t < start || t + WEEK > end;
                    const label = `${CHAINS[chain] || chain} · week of ${new Date(t).toISOString().slice(0, 10)} · ${value(net, "zec")} net${partial ? " · partial week" : ""}${row?.missing_zec ? " · missing amounts" : ""}`;
                    return (
                      <td key={t}>
                        <SwapFilterLink
                          scrollToSwaps
                          href={
                            href({
                              period: data.period,
                              chain,
                              status: "SUCCESS",
                              from: new Date(Math.max(t, start)).toISOString(),
                              to: new Date(
                                Math.min(t + WEEK, end),
                              ).toISOString(),
                            }) + "#swaps"
                          }
                          title={label}
                          aria-label={label}
                          className="block rounded min-w-[32px] h-8 border border-cipher-border text-center leading-8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold"
                          style={
                            net == null || net === 0
                              ? undefined
                              : {
                                  backgroundColor: `color-mix(in srgb, ${net > 0 ? "var(--color-cipher-green)" : "var(--color-cipher-orange)"} ${20 + 70 * Math.sqrt(Math.abs(net) / max)}%, transparent)`,
                                }
                          }
                        >
                          {net == null ? (
                            "—"
                          ) : net === 0 ? (
                            "0"
                          ) : (
                            <span className="sr-only">{value(net, "zec")}</span>
                          )}
                        </SwapFilterLink>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted">
          Chain history is unavailable from this index.
        </p>
      )}
      {data.flows.length > 8 && (
        <button
          className="text-xs text-cipher-gold mt-3"
          onClick={() => setAll(!all)}
        >
          {all
            ? "Show fewer chains"
            : `Show ${data.flows.length - 8} more chains →`}
        </button>
      )}
      <p className="text-xs text-muted mt-3">
        Hover or focus a week for values; select it to see swaps. Boundary weeks
        are partial.
      </p>
    </details>
  );
}
