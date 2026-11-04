"use client";
import { useId, useState } from "react";
import {
  BarChart,
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import { ChartTooltip as Tooltip } from "@/components/charts/ChartTooltip";
import { ChartCard } from "@/components/network/ChartCard";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartColors, getChartTooltipStyle } from "@/lib/chart-theme";
import { Analytics, Unit, value } from "./model";
import { dailyTrends } from "./timeline";
import { TimelineComparison } from "./TimelineComparison";
import { objectRowsCsv } from "@/components/charts/PanelShareControl";
const BUCKETS = [
  "<$10",
  "$10–50",
  "$50–100",
  "$100–500",
  "$500–1K",
  "$1K–5K",
  "$5K–10K",
  "$10K–50K",
  "$50K+",
];
export function ActivityCharts({
  data,
  unit,
  panel = "volume",
}: {
  data: Analytics;
  unit: Unit;
  panel?: "volume" | "sizes";
}) {
  const { theme } = useTheme(),
    colors = getChartColors(theme);
  const [view, setView] = useState<"volume" | "count">("volume");
  const [comparison, setComparison] = useState<"none" | "price" | "shielding">(
    "none",
  );
  const syncId = useId();
  const daily = comparison !== "none";
  const points = (daily ? dailyTrends(data.trends) : data.trends).map((p) => ({
    ...p,
    label:
      data.granularity === "hour" && !daily
        ? p.bucket.slice(5, 16).replace("T", " ")
        : p.bucket.slice(0, 10),
    Inflow: p[`inflow_${unit}`] == null ? null : Number(p[`inflow_${unit}`]),
    Outflow:
      p[`outflow_${unit}`] == null ? null : -Number(p[`outflow_${unit}`]),
    Net:
      p[`inflow_${unit}`] == null || p[`outflow_${unit}`] == null
        ? null
        : Number(p[`inflow_${unit}`]) - Number(p[`outflow_${unit}`]),
  }));
  const [sizeView, setSizeView] = useState<"count" | "volume">("count");
  const distribution = BUCKETS.map((label, bucket) => {
    const group = data.distribution.find((b) => b.bucket === bucket);
    const amount = group?.[`volume_${unit}`];
    return {
      label,
      swaps: group?.swaps || 0,
      volume: group ? (amount == null ? null : Number(amount)) : 0,
    };
  });
  const tooltipStyle = {
    backgroundColor: colors.tooltipBg,
    borderColor: colors.tooltipBorder,
    color: colors.tooltipText,
  };
  return (
    <>
      {panel === "volume" && (
        <ChartCard
          title="Volume & activity"
          share={{ title: `ZEC cross-chain swap volume and activity (${data.period})`, fileName: `zecblock-crosschain-activity-${data.period}`, csv: () => objectRowsCsv(points) }}
          height={300}
          controls={
            <div className="filter-group">
              <button
                className={`filter-btn ${view === "volume" ? "filter-btn-active" : ""}`}
                aria-pressed={view === "volume"}
                onClick={() => setView("volume")}
              >
                Volume
              </button>
              <button
                className={`filter-btn ${view === "count" ? "filter-btn-active" : ""}`}
                aria-pressed={view === "count"}
                onClick={() => setView("count")}
              >
                Swaps
              </button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <p className="text-xs text-muted">
              {data.granularity === "hour" && !daily ? "Hourly" : "Daily"}{" "}
              activity · UTC{daily ? " · boundary days partial" : ""}
            </p>
            <label className="text-xs text-muted flex items-center gap-2">
              Compare with
              <select
                aria-label="Compare activity with"
                className="bg-cipher-bg border border-cipher-border rounded-lg px-2 py-1 text-xs text-secondary"
                value={comparison}
                onChange={(e) =>
                  setComparison(e.target.value as typeof comparison)
                }
              >
                <option value="none">None</option>
                <option value="price">ZEC price</option>
                <option value="shielding">Net shielding</option>
              </select>
            </label>
          </div>
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <ComposedChart
              data={points}
              syncId={syncId}
              syncMethod="value"
              stackOffset="sign"
              margin={{ left: 0, right: 8 }}
            >
              <CartesianGrid
                stroke={colors.grid}
                strokeDasharray="2 6"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                padding={{ left: 12, right: 12 }}
                minTickGap={45}
                tick={{ fill: colors.axis, fontSize: 12 }}
              />
              <YAxis
                width={65}
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(v) =>
                  view === "count"
                    ? Number(v).toLocaleString()
                    : value(v, unit).replace(" ZEC", "")
                }
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(l) => `${l} UTC`}
                formatter={(v, name) =>
                  view === "count"
                    ? Number(v).toLocaleString()
                    : value(
                        v == null
                          ? null
                          : name === "Outflow"
                            ? Math.abs(Number(v))
                            : Number(v),
                        unit,
                      )
                }
              />
              <ReferenceLine y={0} stroke={colors.axis} />
              <Legend />
              {view === "count" ? (
                <Bar
                  dataKey="swaps"
                  name="Observed swaps"
                  fill="var(--color-cipher-gold)"
                />
              ) : (
                <>
                  <Bar
                    stackId="flow"
                    dataKey="Inflow"
                    fill="var(--color-cipher-green)"
                  />
                  <Bar
                    stackId="flow"
                    dataKey="Outflow"
                    fill="var(--color-cipher-orange)"
                  />
                  <Line
                    dataKey="Net"
                    stroke={colors.axis}
                    dot={false}
                    connectNulls={false}
                  />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
          {comparison !== "none" && (
            <TimelineComparison
              key={`${comparison}:${data.period}`}
              kind={comparison}
              period={data.period}
              dates={points.map((p) => p.label)}
              syncId={syncId}
            />
          )}
        </ChartCard>
      )}
      {panel === "sizes" && (
        <ChartCard
          title="Swap sizes"
          share={{ title: `ZEC cross-chain swap sizes (${data.period})`, fileName: `zecblock-crosschain-swap-sizes-${data.period}`, csv: () => objectRowsCsv(distribution) }}
          height={300}
          controls={
            <div className="filter-group">
              <button
                className={`filter-btn ${sizeView === "count" ? "filter-btn-active" : ""}`}
                aria-pressed={sizeView === "count"}
                onClick={() => setSizeView("count")}
              >
                Count
              </button>
              <button
                className={`filter-btn ${sizeView === "volume" ? "filter-btn-active" : ""}`}
                aria-pressed={sizeView === "volume"}
                onClick={() => setSizeView("volume")}
              >
                Volume
              </button>
            </div>
          }
        >
          <p className="text-xs text-muted mb-4">
            Swaps grouped by dollar value.
          </p>
          <ResponsiveContainer width="100%" height={260} minWidth={0}>
            <BarChart
              data={distribution}
              layout="vertical"
              margin={{ left: 5, right: 12 }}
            >
              <XAxis
                type="number"
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(v) =>
                  sizeView === "count"
                    ? Number(v).toLocaleString()
                    : value(v, unit).replace(" ZEC", "")
                }
              />
              <YAxis
                type="category"
                dataKey="label"
                width={78}
                tick={{ fill: colors.axis, fontSize: 12 }}
              />
              <Tooltip
                content={({ active, payload }) => {
                  const row = payload?.[0]?.payload as
                    | { label: string; swaps: number; volume: number | null }
                    | undefined;
                  return active && row ? (
                    <div style={getChartTooltipStyle(colors)}>
                      <p className="text-muted mb-2">{row.label}</p>
                      <p>{row.swaps.toLocaleString()} swaps</p>
                      <p>{value(row.volume, unit)} volume</p>
                    </div>
                  ) : null;
                }}
              />
              <Bar
                dataKey={sizeView === "count" ? "swaps" : "volume"}
                name={sizeView === "count" ? "Swaps" : "Volume"}
                fill="var(--color-cipher-gold)"
                radius={[0, 3, 3, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </>
  );
}
