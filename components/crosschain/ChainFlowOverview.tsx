"use client";
import { useState } from "react";
import { SwapFilterLink } from "./SwapFilterLink";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { TokenChainIcon } from "@/components/TokenChainIcon";
import { ChartCard } from "@/components/network/ChartCard";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartColors, getChartTooltipStyle } from "@/lib/chart-theme";
import { Analytics, CHAINS, Unit, href, value } from "./model";
import { objectRowsCsv } from "@/components/charts/PanelShareControl";

export function ChainFlowOverview({
  flows,
  tokenFlows,
  unit,
  period,
}: {
  flows: Analytics["flows"];
  tokenFlows: Analytics["tokenFlows"];
  unit: Unit;
  period: string;
}) {
  const [group, setGroup] = useState<"chains" | "tokens">("chains");
  const [showAll, setShowAll] = useState(false);
  const [metric, setMetric] = useState<"volume" | "count">("volume");
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const grouped =
    group === "chains"
      ? flows.map((f) => ({
          ...f,
          token: f.chain,
          asset: null as string | null,
          label: CHAINS[f.chain] || f.chain,
        }))
      : (tokenFlows || []).map((f) => ({
          ...f,
          label: `${f.token} · ${CHAINS[f.chain] || f.chain}`,
        }));
  const rows = grouped
    .map((f) => ({
      ...f,
      key: JSON.stringify([f.chain, f.token, f.asset]),
      incoming:
        metric === "count"
          ? f.buy_swaps
          : f[`inflow_${unit}`] == null
            ? null
            : Number(f[`inflow_${unit}`]),
      outgoing:
        metric === "count"
          ? -f.sell_swaps
          : f[`outflow_${unit}`] == null
            ? null
            : -Number(f[`outflow_${unit}`]),
    }))
    .sort(
      (a, b) =>
        Math.abs(b.incoming || 0) +
          Math.abs(b.outgoing || 0) -
          (Math.abs(a.incoming || 0) + Math.abs(a.outgoing || 0)) ||
        a.chain.localeCompare(b.chain),
    );
  const visible = showAll ? rows : rows.slice(0, 8);
  const peak = Math.max(
    1,
    ...visible.flatMap((r) => [
      Math.abs(r.incoming || 0),
      Math.abs(r.outgoing || 0),
    ]),
  );
  const step = 10 ** Math.max(0, Math.floor(Math.log10(peak)) - 1);
  const extent = Math.ceil((peak * 1.08) / (2 * step)) * 2 * step;
  const format = (v: number) =>
    metric === "count"
      ? Math.abs(v).toLocaleString()
      : value(Math.abs(v), unit).replace(" ZEC", "");
  return (
    <section>
      <ChartCard
        title={group === "chains" ? "Flow by chain" : "Flow by token"}
        share={{ title: group === "chains" ? "ZEC cross-chain flow by chain" : "ZEC cross-chain flow by token", fileName: `zecblock-crosschain-flow-by-${group === "chains" ? "chain" : "token"}`, csv: () => objectRowsCsv(visible) }}
        height={180}
        controls={
          <div
            className="filter-group"
            role="group"
            aria-label="Chain flow metric"
          >
            {(["volume", "count"] as const).map((key) => (
              <button
                key={key}
                aria-pressed={metric === key}
                onClick={() => setMetric(key)}
                className={`filter-btn ${metric === key ? "filter-btn-active" : ""}`}
              >
                {key === "volume" ? "Volume" : "Swaps"}
              </button>
            ))}
          </div>
        }
      >
        <div
          className="filter-group mb-4"
          role="group"
          aria-label="Flow grouping"
        >
          {(["chains", "tokens"] as const).map((key) => (
            <button
              key={key}
              aria-pressed={group === key}
              onClick={() => {
                setGroup(key);
                setShowAll(false);
              }}
              className={`filter-btn ${group === key ? "filter-btn-active" : ""}`}
            >
              {key === "chains" ? "Chains" : "Tokens"}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted mb-5">
          Out of ZEC on the left. Into ZEC on the right. Hover for details.
        </p>
        {visible.length ? (
          <>
            <ResponsiveContainer
              width="100%"
              height={Math.max(210, visible.length * 48 + 45)}
              minWidth={0}
            >
              <BarChart
                data={visible}
                layout="vertical"
                stackOffset="sign"
                margin={{ left: 0, right: 12, top: 8, bottom: 8 }}
              >
                <CartesianGrid
                  stroke={colors.grid}
                  strokeDasharray="2 6"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  domain={[-extent, extent]}
                  ticks={[-extent, -extent / 2, 0, extent / 2, extent]}
                  tickFormatter={format}
                  tick={{ fill: colors.axis, fontSize: 12 }}
                />
                <YAxis
                  type="category"
                  dataKey="key"
                  width={group === "tokens" ? 170 : 122}
                  tickLine={false}
                  axisLine={false}
                  tick={({ x, y, payload }) => {
                    const row = rows.find((r) => r.key === payload.value)!;
                    return (
                      <foreignObject
                        x={Number(x) - (group === "tokens" ? 168 : 120)}
                        y={Number(y) - 16}
                        width={group === "tokens" ? 160 : 112}
                        height={32}
                      >
                        <SwapFilterLink
                          scrollToSwaps
                          className="flex h-full items-center justify-end gap-2 text-xs text-secondary hover:text-cipher-gold"
                          href={
                            href({
                              period,
                              chain: row.chain,
                              ...(group === "tokens"
                                ? { token: row.token }
                                : {}),
                              status: "SUCCESS",
                            }) + "#swaps"
                          }
                          aria-label={`View swaps for ${row.label}`}
                        >
                          <span className="truncate">{row.label}</span>
                          <TokenChainIcon
                            token={row.token}
                            chain={row.chain}
                            size={20}
                          />
                        </SwapFilterLink>
                      </foreignObject>
                    );
                  }}
                />
                <ReferenceLine x={0} stroke={colors.axis} />
                <ChartTooltip
                  content={({ active, payload }) => {
                    const row = payload?.[0]?.payload as
                      (typeof rows)[number] | undefined;
                    return active && row ? (
                      <div style={getChartTooltipStyle(colors)}>
                        <p className="text-secondary mb-2">{row.label}</p>
                        <p className="text-cipher-orange">
                          Out of ZEC: {value(row[`outflow_${unit}`], unit)} ·{" "}
                          {row.sell_swaps.toLocaleString()} swaps
                        </p>
                        <p className="text-cipher-green">
                          Into ZEC: {value(row[`inflow_${unit}`], unit)} ·{" "}
                          {row.buy_swaps.toLocaleString()} swaps
                        </p>
                      </div>
                    ) : null;
                  }}
                />
                <Bar
                  stackId="flow"
                  dataKey="outgoing"
                  name="Out of ZEC"
                  fill="var(--color-cipher-orange)"
                  maxBarSize={24}
                  radius={[4, 0, 0, 4]}
                />
                <Bar
                  stackId="flow"
                  dataKey="incoming"
                  name="Into ZEC"
                  fill="var(--color-cipher-green)"
                  maxBarSize={24}
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-5 text-xs mt-3">
              <span className="text-cipher-orange">■ Out of ZEC</span>
              <span className="text-cipher-green">■ Into ZEC</span>
            </div>
            {rows.length > 8 && (
              <button
                className="text-xs text-cipher-gold mt-5"
                onClick={() => setShowAll(!showAll)}
              >
                {showAll
                  ? `Show fewer ${group}`
                  : `Show ${rows.length - 8} more ${group} →`}
              </button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted py-8">No flows in this period.</p>
        )}
      </ChartCard>
    </section>
  );
}
