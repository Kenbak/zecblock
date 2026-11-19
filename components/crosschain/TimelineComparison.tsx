"use client";
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { useApiQuery } from "@/hooks/useApiQuery";
import { formatBucketLabel } from "@/lib/chart-dates";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartColors } from "@/lib/chart-theme";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { IS_DEMO, value } from "./model";
import { alignReference } from "./timeline";
export function TimelineComparison({
  kind,
  period,
  dates,
  syncId,
}: {
  kind: "price" | "shielding";
  period: string;
  dates: string[];
  syncId: string;
}) {
  // These existing reference APIs have daily data. Shielding currently exposes at most 1y.
  const queryPeriod =
    kind === "price"
      ? ["24h", "7d"].includes(period)
        ? "30d"
        : period
      : period === "all"
        ? "1y"
        : period === "24h"
          ? "7d"
          : period;
  const { data, loading, error } = useApiQuery<{
    points: { date: string; priceUsd?: number | null; net?: number | null }[];
  }>(
    kind === "price" ? "/v1/valuation/history" : "/v1/shielded-pools/flows",
    { period: queryPeriod },
    { refreshInterval: 300000 },
  );
  const { theme } = useTheme(),
    colors = getChartColors(theme);
  const rows = alignReference(
    dates,
    data?.points || [],
    kind === "price" ? "priceUsd" : "net",
  );
  const label =
    kind === "price" ? "ZEC price · USD" : "Net public shielding · ZEC";
  return (
    <div className="border-t border-cipher-border pt-4 mt-4">
      <p className="text-xs text-secondary mb-3">
        {label} <span className="text-muted">· daily · separate scale</span>
      </p>
      {loading && !data ? (
        <p className="text-xs text-muted py-6" role="status">
          Loading comparison…
        </p>
      ) : !data || !rows.some((r) => r.reference != null) ? (
        <p className="text-xs text-muted py-6" role="status">
          Comparison data unavailable for these dates.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={160} minWidth={0}>
          <ComposedChart
            data={rows}
            syncId={syncId}
            syncMethod="value"
            margin={{ left: 0, right: 8 }}
          >
            <CartesianGrid
              stroke={colors.gridStroke}
              vertical={false}
            />
            <XAxis tickLine={false} axisLine={false}
              dataKey="label"
                tickFormatter={formatBucketLabel}
              padding={{ left: 12, right: 12 }}
              minTickGap={45}
              tick={{ fill: colors.axis, fontSize: 12 }}
            />
            <YAxis tickLine={false} axisLine={false}
              width={65}
              tick={{ fill: colors.axis, fontSize: 12 }}
              tickFormatter={(v) =>
                value(v, kind === "price" ? "usd" : "zec").replace(" ZEC", "")
              }
            />
            <ChartTooltip
              contentStyle={{
                backgroundColor: colors.tooltipBg,
                borderColor: colors.tooltipBorder,
                color: colors.tooltipText,
              }}
              labelFormatter={(l) => `${l} UTC`}
              formatter={(v) => [
                value(
                  v == null ? null : Number(v),
                  kind === "price" ? "usd" : "zec",
                ),
                kind === "price" ? "ZEC price" : "Net shielding",
              ]}
            />
            {kind === "price" ? (
              <Line
                dataKey="reference"
                stroke={colors.gold}
                dot={{ r: 2 }}
                connectNulls={false}
              />
            ) : (
              <>
                <ReferenceLine y={0} stroke={colors.axis} />
                <Bar dataKey="reference" fill={colors.shielded} />
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <p className="text-xs text-muted mt-2">
        {IS_DEMO ? "Simulated comparison data for this preview. " : ""}
        {kind === "shielding"
          ? "Public shielding minus deshielding; no link to individual swaps is inferred."
          : "Historical daily price; gaps are unavailable observations."}
        {kind === "shielding" && period === "all"
          ? " Shielding reference is limited to the latest year."
          : ""}
        {error && data
          ? " Refresh failed; showing last reference snapshot."
          : ""}
      </p>
    </div>
  );
}
