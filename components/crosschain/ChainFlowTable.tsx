'use client';

import { getChainLogoSrc } from '@/lib/chain-logos';
import { useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors, getChartTooltipStyle } from '@/lib/chart-theme';
import { ChartCard } from '@/components/network/ChartCard';
import { TokenChainIcon } from '@/components/TokenChainIcon';
import { formatValue, type DisplayUnit } from '@/components/crosschain/format';

export interface TokenVolume {
  symbol: string;
  volume24h: number;
}

export interface ChainGroup {
  chain: string;
  chainName: string;
  totalVolume24h: number;
  tokens: TokenVolume[];
}

interface FlowRow {
  chain: string;
  chainName: string;
  inflow: number;
  outflowNeg: number;
  net: number;
  inflowTokens: TokenVolume[];
  outflowTokens: TokenVolume[];
}

const TOP_N = 8;

const CHAIN_DISPLAY_NAMES: Record<string, string> = {
  btc: 'Bitcoin', eth: 'Ethereum', sol: 'Solana', near: 'NEAR',
  doge: 'Dogecoin', xrp: 'Ripple', zec: 'Zcash', base: 'Base',
  arb: 'Arbitrum', pol: 'Polygon', avax: 'Avalanche', trx: 'Tron',
  tron: 'Tron', apt: 'Aptos', sui: 'Sui', ton: 'TON',
  bnb: 'BNB Chain', bsc: 'BNB Chain', op: 'Optimism', ltc: 'Litecoin',
  dash: 'Dash', gnosis: 'Gnosis', monad: 'Monad',
};

function ChainYAxisTick({ x, y, payload }: { x?: number; y?: number; payload?: { value?: string } }) {
  if (!x || !y || !payload?.value) return null;
  const chain = payload.value;
  const iconUrl = getChainLogoSrc(chain);
  const name = CHAIN_DISPLAY_NAMES[chain] || chain;

  return (
    <g transform={`translate(${x},${y})`}>
      {iconUrl && (
        <image
          href={iconUrl}
          x={-30}
          y={-10}
          width={20}
          height={20}
          clipPath="inset(0% round 50%)"
        />
      )}
      <text
        x={-36}
        y={4}
        textAnchor="end"
        fill="currentColor"
        fontSize={12}
        fontFamily="var(--font-geist-mono), monospace"
        className="text-secondary"
      >
        {name}
      </text>
    </g>
  );
}

function TokenRow({ token, chain, value, unit, zecPrice }: {
  token: string; chain: string; value: number;
  unit: DisplayUnit; zecPrice: number | null;
}) {
  const fv = formatValue(value, unit, zecPrice);
  return (
    <div className="flex items-center gap-2 py-0.5">
      <TokenChainIcon token={token} chain={chain} size={14} />
      <span className="text-secondary flex-1 truncate">{token}</span>
      <span className="tabular-nums text-secondary">{fv}</span>
    </div>
  );
}

function FlowTooltip({ active, payload, colors, unit, zecPrice }: {
  active?: boolean;
  payload?: Array<{ payload?: FlowRow }>;
  colors: ReturnType<typeof getChartColors>;
  unit: DisplayUnit;
  zecPrice: number | null;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const fv = (v: number) => formatValue(v, unit, zecPrice);
  const outflow = Math.abs(row.outflowNeg);
  const sign = row.net >= 0 ? '+' : '';

  const inflowTokensSorted = [...row.inflowTokens].sort((a, b) => b.volume24h - a.volume24h).slice(0, 4);
  const outflowTokensSorted = [...row.outflowTokens].sort((a, b) => b.volume24h - a.volume24h).slice(0, 4);

  return (
    <div
      className="rounded-lg border px-3 py-3 text-caption font-mono shadow-xl min-w-[200px] max-w-[260px]"
      style={getChartTooltipStyle(colors)}
    >
      <div className="flex items-center gap-2 mb-2.5 pb-2 border-b border-glass-6">
        <TokenChainIcon token={row.chain} chain={row.chain} size={18} />
        <span className="text-primary font-semibold text-xs">{row.chainName}</span>
      </div>

      {row.inflow > 0 && (
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-cipher-green font-semibold text-caption uppercase tracking-wider">Inflow</span>
            <span className="text-cipher-green tabular-nums font-semibold">{fv(row.inflow)}</span>
          </div>
          {inflowTokensSorted.map((t) => (
            <TokenRow key={t.symbol} token={t.symbol} chain={row.chain} value={t.volume24h} unit={unit} zecPrice={zecPrice} />
          ))}
        </div>
      )}

      {outflow > 0 && (
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-cipher-orange font-semibold text-caption uppercase tracking-wider">Outflow</span>
            <span className="text-cipher-orange tabular-nums font-semibold">{fv(outflow)}</span>
          </div>
          {outflowTokensSorted.map((t) => (
            <TokenRow key={t.symbol} token={t.symbol} chain={row.chain} value={t.volume24h} unit={unit} zecPrice={zecPrice} />
          ))}
        </div>
      )}

      <div className={`flex items-center justify-between pt-2 border-t border-glass-6 font-semibold ${row.net >= 0 ? 'text-cipher-green' : 'text-cipher-orange'}`}>
        <span>Net</span>
        <span className="tabular-nums">{sign}{fv(row.net)}</span>
      </div>
    </div>
  );
}

export function ChainFlowTable({
  inflows,
  outflows,
  unit = 'usd',
  zecPrice = null,
}: {
  inflows: ChainGroup[];
  outflows: ChainGroup[];
  unit?: DisplayUnit;
  zecPrice?: number | null;
}) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [showAll, setShowAll] = useState(false);

  const { topRows, tailRows } = useMemo(() => {
    const byChain: Record<string, {
      chain: string; chainName: string;
      inflow: number; outflow: number;
      inflowTokens: TokenVolume[]; outflowTokens: TokenVolume[];
    }> = {};

    for (const g of inflows) {
      byChain[g.chain] ??= { chain: g.chain, chainName: g.chainName, inflow: 0, outflow: 0, inflowTokens: [], outflowTokens: [] };
      byChain[g.chain].inflow = g.totalVolume24h;
      byChain[g.chain].inflowTokens = g.tokens;
    }
    for (const g of outflows) {
      byChain[g.chain] ??= { chain: g.chain, chainName: g.chainName, inflow: 0, outflow: 0, inflowTokens: [], outflowTokens: [] };
      byChain[g.chain].outflow = g.totalVolume24h;
      byChain[g.chain].outflowTokens = g.tokens;
    }

    const all: FlowRow[] = Object.values(byChain)
      .map((r) => ({
        chain: r.chain,
        chainName: r.chainName,
        inflow: r.inflow,
        outflowNeg: -r.outflow,
        net: r.inflow - r.outflow,
        inflowTokens: r.inflowTokens,
        outflowTokens: r.outflowTokens,
      }))
      .sort((a, b) => (b.inflow + Math.abs(b.outflowNeg)) - (a.inflow + Math.abs(a.outflowNeg)));

    return {
      topRows: all.slice(0, TOP_N),
      tailRows: all.slice(TOP_N),
    };
  }, [inflows, outflows]);

  const displayRows = showAll ? [...topRows, ...tailRows] : topRows;
  const BAR_SIZE = 16;
  const chartHeight = Math.max(260, displayRows.length * 44 + 60);
  const fv = (v: number) => formatValue(Math.abs(v), unit, zecPrice);

  if (displayRows.length === 0) {
    return (
      <ChartCard title="FLOW_BY_CHAIN" height={120}>
        <div className="flex items-center justify-center h-[80px] text-xs font-mono text-muted">No cross-chain activity in the last 24h</div>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="FLOW_BY_CHAIN" height={chartHeight}>
      <p className="text-xs text-muted mb-3">
        24h inflows (green, right) vs outflows (orange, left) by chain. Hover for token breakdown.
      </p>
      <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={chartHeight - 40}>
        <BarChart
          data={displayRows}
          layout="vertical"
          barGap={-BAR_SIZE}
          barCategoryGap="20%"
          margin={{ left: 8, right: 24, top: 4, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.4} vertical horizontal={false} />
          <XAxis
            type="number"
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            tickFormatter={(v: number) => fv(v)}
          />
          <YAxis
            type="category"
            dataKey="chain"
            stroke={colors.axis}
            tick={ChainYAxisTick as any}
            width={120}
          />
          <Tooltip content={<FlowTooltip colors={colors} unit={unit} zecPrice={zecPrice} />} cursor={{ fill: colors.barCursor }} />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            formatter={(value) => value === 'inflow' ? 'Inflows (24h)' : 'Outflows (24h)'}
          />
          <ReferenceLine x={0} stroke={colors.grid} strokeWidth={1.5} />
          <Bar dataKey="inflow" name="inflow" fill="var(--color-cipher-green)" fillOpacity={0.85} radius={[0, 4, 4, 0]} barSize={BAR_SIZE} />
          <Bar dataKey="outflowNeg" name="outflowNeg" fill="var(--color-cipher-orange)" fillOpacity={0.75} radius={[4, 0, 0, 4]} barSize={BAR_SIZE} />
        </BarChart>
      </ResponsiveContainer>

      {tailRows.length > 0 && (
        <div className="mt-3 pt-3 border-t border-cipher-border">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-caption font-mono text-cipher-gold hover:underline"
          >
            {showAll ? '← Show top 8 only' : `Show ${tailRows.length} more chain${tailRows.length !== 1 ? 's' : ''} →`}
          </button>
          {!showAll && (
            <p className="text-caption text-muted mt-1.5 leading-relaxed">
              {tailRows.slice(0, 6).map((r) => r.chainName).join(', ')}
              {tailRows.length > 6 ? `, +${tailRows.length - 6} more` : ''}
            </p>
          )}
        </div>
      )}
    </ChartCard>
  );
}
