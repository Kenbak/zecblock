'use client';
import { ChartWatermark } from '@/components/ChartWatermark';
import { ChartSkeleton, Skeleton } from '@/components/ui/Skeleton';

import { memo, type ReactNode } from 'react';
import {  AreaChart, Area, XAxis, CartesianGrid,  ResponsiveContainer  } from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors, getChartTooltipStyle } from '@/lib/chart-theme';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatChartDate, tooltipDate } from '@/lib/chart-dates';
import { formatZecCompact } from '@/lib/format-numbers';

interface PoolPoint {
  date: string;
  sapling: number;
  orchard: number;
  ironwood: number;
  sprout: number;
  shielded: number;
  transparent: number;
  shieldedSupplyPct: number | null;
}

// Pixel-matched to the table-based Customize options (RecentBlocks etc.) —
// see IronwoodProgressCard for the same constant/reasoning. The chart itself
// renders at `height="100%"` inside a flex-1 container rather than a fixed
// pixel value, so it's this outer height driving the total, not the other
// way around — stats row + legend can't push the total past this number.
const CARD_HEIGHT_PX = 336.5;

// Same stacking order as the full PoolDistributionChart (Ironwood on top,
// Sprout at the base) — Sprout's balance is tiny (long-mined-out pool) but
// omitting it made this chart's stack sum less than the "Shielded" total
// stated right above it.
const SERIES = [
  { key: 'ironwood', label: 'Ironwood' },
  { key: 'orchard', label: 'Orchard' },
  { key: 'sapling', label: 'Sapling' },
  { key: 'sprout', label: 'Sprout' },
] as const;

function MiniTooltip({
  active,
  payload,
  label,
  colors,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number; payload?: Record<string, unknown> }>;
  label?: string;
  colors: ReturnType<typeof getChartColors>;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs font-mono shadow-lg"
      style={getChartTooltipStyle(colors)}
    >
      <p className="mb-1.5 text-caption uppercase tracking-wider text-muted">{tooltipDate(payload, label)}</p>
      {SERIES.map(({ key, label: seriesLabel }) => {
        const entry = payload.find((p) => p.dataKey === key);
        if (!entry) return null;
        return (
          <p key={key} className="tabular-nums text-secondary">
            <span style={{ color: colors[key] }}>{seriesLabel}</span>: {formatZecCompact(Number(entry.value ?? 0))} ZEC
          </p>
        );
      })}
    </div>
  );
}

/**
 * Homepage-sized shielded-pool trend widget — a chart, not a table. Fixed
 * height regardless of data volume (no overflow risk), 30 days by default
 * (matches "recent activity" framing of the other Customize options rather
 * than the full-page PoolDistributionChart's default "all time"). Skips
 * Recharts' own <Legend/> in favor of a tiny custom row — a full legend eats
 * too much of this widget's limited vertical budget.
 */
export const ShieldedPoolMiniChart = memo(function ShieldedPoolMiniChart({ footer }: { footer?: ReactNode } = {}) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const { data: apiRes, loading } = useApiQuery<{ points: PoolPoint[] }>('/v1/shielded-pools/history', { period: '30d' });
  const points = apiRes?.points ?? [];
  const latest = points[points.length - 1];

  if (loading) {
    return (
      <div className="card p-0 overflow-hidden flex flex-col" style={{ height: CARD_HEIGHT_PX }}>
        <div className="p-4 flex-1 min-h-0"><Skeleton className="h-5 w-36 mb-4" /><ChartSkeleton height={CARD_HEIGHT_PX - 110} /></div>
        {footer && <div className="px-4 py-3 border-t border-cipher-border text-center">{footer}</div>}
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="card p-0 overflow-hidden flex flex-col" style={{ height: CARD_HEIGHT_PX }}>
        <div className="flex-1 flex items-center justify-center px-4 text-center text-sm text-muted font-mono">
          No shielded pool history available
        </div>
        {footer && <div className="px-4 py-3 border-t border-cipher-border text-center">{footer}</div>}
      </div>
    );
  }

  return (
    <div className="card p-0 overflow-hidden flex flex-col" style={{ height: CARD_HEIGHT_PX }}>
      <div className="px-4 pt-4 flex-1 min-h-0 flex flex-col">
        {latest && (
          <div className="grid grid-cols-3 gap-3 pb-2 mb-2 border-b border-cipher-border/50 shrink-0">
            <div>
              <span className="text-caption font-mono text-muted uppercase tracking-widest block mb-0.5">Shielded</span>
              <span className="text-sm font-mono font-semibold text-primary tabular-nums">{formatZecCompact(latest.shielded)} ZEC</span>
            </div>
            <div>
              <span className="text-caption font-mono text-muted uppercase tracking-widest block mb-0.5">Transparent</span>
              <span className="text-sm font-mono font-semibold text-primary tabular-nums">{formatZecCompact(latest.transparent)} ZEC</span>
            </div>
            <div>
              <span className="text-caption font-mono text-muted uppercase tracking-widest block mb-0.5">Shielded %</span>
              <span className="text-sm font-mono font-semibold text-primary tabular-nums">
                {latest.shieldedSupplyPct != null ? `${latest.shieldedSupplyPct.toFixed(1)}%` : '—'}
              </span>
            </div>
          </div>
        )}
        <div className="flex items-center gap-3 mb-1 shrink-0">
          {SERIES.map(({ key, label }) => (
            <span key={key} className="inline-flex items-center gap-1.5 text-caption font-mono text-muted uppercase tracking-wider">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors[key] }} />
              {label}
            </span>
          ))}
        </div>
        {/* height="100%" (not a fixed px value) — this fills whatever space
            is left after the stats/legend rows above, so the outer
            CARD_HEIGHT_PX is what's exact, not this chart's own size. */}
        <div className="flex-1 min-h-0">
          <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={colors.gridStroke} vertical={false} />
              <XAxis
                dataKey="date"
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: 12 }}
                tickFormatter={(v) => formatChartDate(String(v))}
                interval="preserveStartEnd"
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<MiniTooltip colors={colors} />} />
              <Area type="linear" dataKey="ironwood" stackId="1" stroke={colors.ironwood} fill={colors.ironwood} fillOpacity={0.65} isAnimationActive={false} />
              <Area type="linear" dataKey="orchard" stackId="1" stroke={colors.orchard} fill={colors.orchard} fillOpacity={0.6} isAnimationActive={false} />
              <Area type="linear" dataKey="sapling" stackId="1" stroke={colors.sapling} fill={colors.sapling} fillOpacity={0.6} isAnimationActive={false} />
              <Area type="linear" dataKey="sprout" stackId="1" stroke={colors.sprout} fill={colors.sprout} fillOpacity={0.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <ChartWatermark className="shrink-0" />
      </div>
      {footer && <div className="px-4 py-3 border-t border-cipher-border text-center shrink-0">{footer}</div>}
    </div>
  );
});
