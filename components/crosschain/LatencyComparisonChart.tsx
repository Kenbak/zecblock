"use client";

import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { ChartTooltip as Tooltip } from "@/components/charts/ChartTooltip";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartColors, getChartTooltipStyle } from "@/lib/chart-theme";
import { ChartCard } from "@/components/network/ChartCard";
import { formatMinutes } from "@/components/crosschain/format";
import { objectRowsCsv } from '@/components/charts/PanelShareControl';

export interface LatencyStat {
  chain: string;
  chainName: string;
  avgMinutes?: number;
  medianMinutes: number;
  swapCount: number;
}

interface LatencyRow {
  chain: string;
  chainName: string;
  inboundMedian: number;
  inboundCount: number;
  outboundMedian: number;
  outboundCount: number;
  totalCount: number;
}

const TOP_N = 10;

const CHAIN_ICON_MAP: Record<string, string> = {
  eth: "/chains/eth.png",
  sol: "/chains/sol.png",
  btc: "/chains/btc.png",
  near: "/chains/near.png",
  base: "/chains/base.svg",
  arb: "/chains/arb.png",
  op: "/chains/op.png",
  pol: "/chains/pol.png",
  avax: "/chains/avax.png",
  bsc: "/chains/bsc.png",
  bnb: "/chains/bsc.png",
  trx: "/chains/tron.png",
  tron: "/chains/tron.png",
  zec: "/tokens/zec.png",
  apt: "/chains/aptos.png",
  aptos: "/chains/aptos.png",
  sui: "/chains/sui.png",
  ton: "/chains/ton.png",
  doge: "/chains/doge.png",
  xrp: "/chains/xrp.png",
  ltc: "/chains/ltc.png",
  bch: "/chains/bch.png",
  gnosis: "/chains/gnosis.png",
  stellar: "/chains/stellar.png",
  cardano: "/chains/cardano.png",
};

const CHAIN_DISPLAY_NAMES: Record<string, string> = {
  btc: "Bitcoin",
  eth: "Ethereum",
  sol: "Solana",
  near: "NEAR",
  doge: "Dogecoin",
  xrp: "Ripple",
  zec: "Zcash",
  base: "Base",
  arb: "Arbitrum",
  pol: "Polygon",
  avax: "Avalanche",
  trx: "Tron",
  tron: "Tron",
  apt: "Aptos",
  sui: "Sui",
  ton: "TON",
  bnb: "BNB Chain",
  bsc: "BNB Chain",
  op: "Optimism",
  ltc: "Litecoin",
};

function ChainYAxisTick({
  x,
  y,
  payload,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string };
}) {
  if (!x || !y || !payload?.value) return null;
  const chain = payload.value;
  const iconUrl = CHAIN_ICON_MAP[chain];
  const displayName = CHAIN_DISPLAY_NAMES[chain] || chain;

  return (
    <g transform={`translate(${x},${y})`}>
      {iconUrl && (
        <image
          href={iconUrl}
          x={-38}
          y={-9}
          width={18}
          height={18}
          clipPath="inset(0% round 50%)"
        />
      )}
      <text
        x={-44}
        y={4}
        textAnchor="end"
        fill="currentColor"
        fontSize={12}
        fontFamily="var(--font-geist-mono), monospace"
        className="text-secondary"
      >
        {displayName}
      </text>
    </g>
  );
}

function LatencyTooltip({
  active,
  payload,
  colors,
}: {
  active?: boolean;
  payload?: Array<{ payload?: LatencyRow }>;
  colors: ReturnType<typeof getChartColors>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs font-mono shadow-lg"
      style={getChartTooltipStyle(colors)}
    >
      <p className="mb-2 text-caption uppercase tracking-wider text-muted">
        {row.chainName}
      </p>
      {row.inboundCount > 0 && (
        <p className="tabular-nums text-secondary">
          <span className="text-cipher-green">Buy ZEC</span>:{" "}
          {formatMinutes(row.inboundMedian)} median ·{" "}
          {row.inboundCount.toLocaleString()} swaps
        </p>
      )}
      {row.outboundCount > 0 && (
        <p className="tabular-nums text-secondary">
          <span className="text-cipher-orange">Sell ZEC</span>:{" "}
          {formatMinutes(row.outboundMedian)} median ·{" "}
          {row.outboundCount.toLocaleString()} swaps
        </p>
      )}
    </div>
  );
}

export function LatencyComparisonChart({
  inbound,
  outbound,
}: {
  inbound: LatencyStat[];
  outbound: LatencyStat[];
}) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [showAll, setShowAll] = useState(false);

  const rows: LatencyRow[] = useMemo(() => {
    const byChain: Record<string, LatencyRow> = {};
    for (const s of inbound) {
      if (s.medianMinutes <= 0) continue;
      byChain[s.chain] ??= {
        chain: s.chain,
        chainName: s.chainName,
        inboundMedian: 0,
        inboundCount: 0,
        outboundMedian: 0,
        outboundCount: 0,
        totalCount: 0,
      };
      byChain[s.chain].inboundMedian = s.medianMinutes;
      byChain[s.chain].inboundCount = s.swapCount;
    }
    for (const s of outbound) {
      if (s.medianMinutes <= 0) continue;
      byChain[s.chain] ??= {
        chain: s.chain,
        chainName: s.chainName,
        inboundMedian: 0,
        inboundCount: 0,
        outboundMedian: 0,
        outboundCount: 0,
        totalCount: 0,
      };
      byChain[s.chain].outboundMedian = s.medianMinutes;
      byChain[s.chain].outboundCount = s.swapCount;
    }
    return Object.values(byChain)
      .map((r) => ({ ...r, totalCount: r.inboundCount + r.outboundCount }))
      .sort((a, b) => b.totalCount - a.totalCount);
  }, [inbound, outbound]);

  const topRows = rows.slice(0, TOP_N);
  const longTail = rows.slice(TOP_N);
  const displayRows = showAll ? rows : topRows;
  const chartHeight = Math.max(240, displayRows.length * 38);

  if (rows.length === 0) return null;

  return (
    <ChartCard title="Zcash confirmation times" height={chartHeight} share={{ title: 'Zcash cross-chain confirmation times', fileName: 'zecblock-crosschain-confirmation-times', csv: () => objectRowsCsv(displayRows) }}>
      <p className="text-xs text-muted mb-3 max-w-2xl">
        Median time from swap creation to Zcash confirmation.
      </p>
      <ResponsiveContainer
        initialDimension={{ width: 500, height: 300 }}
        width="100%"
        height={chartHeight - 20}
      >
        <BarChart
          data={displayRows}
          layout="vertical"
          margin={{ left: 8, right: 24 }}
        >
          <CartesianGrid
            strokeDasharray="2 6"
            stroke={colors.grid}
            opacity={0.5}
            horizontal={false}
          />
          <XAxis
            type="number"
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            tickFormatter={(v: number) => formatMinutes(v)}
          />
          <YAxis
            type="category"
            dataKey="chain"
            stroke={colors.axis}
            tick={ChainYAxisTick}
            width={130}
          />
          <Tooltip
            content={<LatencyTooltip colors={colors} />}
            cursor={{ fill: colors.barCursor }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            formatter={(value) =>
              value === "inboundMedian"
                ? "Buy ZEC (inbound)"
                : "Sell ZEC (outbound)"
            }
          />
          <Bar
            dataKey="inboundMedian"
            name="inboundMedian"
            fill="var(--color-cipher-green)"
            fillOpacity={0.85}
            radius={[0, 3, 3, 0]}
            barSize={9}
          />
          <Bar
            dataKey="outboundMedian"
            name="outboundMedian"
            fill="var(--color-cipher-orange)"
            fillOpacity={0.85}
            radius={[0, 3, 3, 0]}
            barSize={9}
          />
        </BarChart>
      </ResponsiveContainer>

      {longTail.length > 0 && (
        <div className="mt-3 pt-3 border-t border-cipher-border">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-caption font-mono text-cipher-gold hover:underline"
          >
            {showAll
              ? "← Show top 10 only"
              : `Show ${longTail.length} more chains →`}
          </button>
          {!showAll && (
            <p className="text-caption text-muted mt-1.5 leading-relaxed">
              {longTail
                .slice(0, 8)
                .map((r) => r.chainName)
                .join(", ")}
              {longTail.length > 8 ? `, +${longTail.length - 8} more` : ""} —
              under {topRows[topRows.length - 1]?.totalCount.toLocaleString()}{" "}
              swaps each, latency less statistically reliable.
            </p>
          )}
        </div>
      )}
    </ChartCard>
  );
}
