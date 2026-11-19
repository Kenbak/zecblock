'use client';

import { memo, type ReactNode } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { getChartColors, getMiningSoftwareColors } from '@/lib/chart-theme';
import { SOFTWARE_LABELS, type MiningSoftware } from '@/lib/mining-software';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { formatChartDate } from '@/lib/chart-dates';

interface SoftwareSummary {
  from: string | null;
  to: string;
  totalBlocks: number;
  history: { date: string; total: number; counts: Record<MiningSoftware, number> | null }[];
  categories: { software: MiningSoftware; blocks: number; share: number | null }[];
}

// Same daily stacked history and denominator as the full mining chart.
// Keep missing days as gaps and untagged blocks in the total.
export const MiningSoftwareMiniChart = memo(function MiningSoftwareMiniChart({ footer }: { footer?: ReactNode }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const palette = getMiningSoftwareColors(theme);
  const { data, loading, error } = useApiQuery<SoftwareSummary>(
    '/v1/mining/software',
    { period: '30d', bucket: 'day' },
    { refreshInterval: 300_000 },
  );

  const series = data?.categories.filter(({ blocks }) => blocks > 0) ?? [];
  const chart = data?.history.map(({ date, total, counts }) => ({
    date,
    ...Object.fromEntries(Object.keys(SOFTWARE_LABELS).map(key => [key,
      total > 0 && counts ? counts[key as MiningSoftware] / total * 100 : null,
    ])),
  })) ?? [];

  return (
    <div className="card p-0 overflow-hidden flex flex-col" style={{ height: 336.5 }}>
      <div className="px-4 sm:px-5 py-4 flex-1 min-h-0 flex flex-col">
        {loading || !data || !data.totalBlocks ? (
          <div role="status" className="h-full flex items-center justify-center text-sm text-muted text-center">
            {loading ? 'Loading software tags…' : error ? 'Software tags are temporarily unavailable.' : 'No indexed blocks in this range.'}
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2 text-xs text-muted mb-3 shrink-0">
              <span className="font-mono tabular-nums">{data.totalBlocks.toLocaleString()} blocks</span>
              <span>Last 30 days · UTC</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 shrink-0">
              {series.map(({ software }) => (
                <span key={software} className="inline-flex items-center gap-1.5 text-caption text-muted">
                  <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: palette[software] }} />
                  {SOFTWARE_LABELS[software]}
                </span>
              ))}
            </div>
            <div className="flex-1 min-h-0" aria-label="Daily share of observed blocks by self-reported software tag, over 30 days">
              <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 500, height: 180 }}>
                <BarChart data={chart} barCategoryGap={0} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={colors.gridStroke} />
                  <XAxis dataKey="date" tickFormatter={formatChartDate} minTickGap={40} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: colors.axis }} />
                  <YAxis domain={[0, 100]} ticks={[0, 50, 100]} width={38} tickFormatter={value => `${value}%`} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: colors.axis }} />
                  <ChartTooltip labelFormatter={label => `${label} · UTC day`} formatter={(value, name) => [`${Number(value).toFixed(2)}%`, SOFTWARE_LABELS[name as MiningSoftware] ?? name]} />
                  {series.map(({ software }) => (
                    <Bar key={software} dataKey={software} stackId="software" fill={palette[software]} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-caption text-muted mt-2 shrink-0" role={error ? 'status' : undefined}>
              {error ? 'Refresh unavailable · showing the last received data.' : 'Self-reported block tags, not a node count.'}
            </p>
          </>
        )}
      </div>
      {footer && <div className="px-4 py-3 border-t border-cipher-border text-center shrink-0">{footer}</div>}
    </div>
  );
});
