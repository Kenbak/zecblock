'use client';

import { useRef } from 'react';
import { CURRENCY } from '@/lib/config';
import { formatDateLabelUTC } from '@/lib/utils';
import { CHART_DATE_AXIS } from '@/lib/chart-theme';
import { ChartWatermark } from '@/components/ChartWatermark';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import {  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,  ResponsiveContainer  } from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { useApiQuery } from '@/hooks/useApiQuery';
import { feeBand } from '@/lib/network-overview';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { useUrlState } from '@/lib/use-url-state';
import { PanelShareControl, objectRowsCsv } from '@/components/charts/PanelShareControl';

const PERIODS = ['7d', '30d', '90d', '1y', 'all'] as const;
type Period = typeof PERIODS[number];
export interface DayFees { date: string; p10: number; p25: number; median: number; p75: number; p90: number; avgFee: number; txCount: number }
export interface FeeDistributionResponse { daily: DayFees[]; period?: string; historyStatus?: string }

export function FeeDistributionChart({ initialData, initialFetchedAt }: { initialFetchedAt?: number; initialData?: FeeDistributionResponse | null }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const panelRef = useRef<HTMLDivElement>(null);
  const [period, setPeriod] = useUrlState<Period>('fees', '30d', PERIODS);
  const { data, loading, error, isRefreshing } = useApiQuery<FeeDistributionResponse>('/v1/network/fee-distribution', { period }, {
    initialFetchedAt,
    initialData: period === '30d' ? initialData ?? undefined : undefined, refreshInterval: 300_000,
  });
  const points = (data?.daily ?? []).map(day => ({ date: day.date, txCount: day.txCount, ...feeBand(day) }));
  const usable = points.some(p => p.median != null);
  const last = [...points].reverse().find(p => p.median != null);
  const dateLabel = formatDateLabelUTC;
  return <div ref={panelRef} className="h-full"><Card className="h-full"><CardBody>
    <SectionHeader label="OBSERVED_FEES" actions={<div className="flex flex-wrap items-center gap-1"><div className="flex gap-1" aria-label="Fee history range">{PERIODS.map(value => <button key={value} onClick={() => setPeriod(value)} aria-pressed={period === value} className={`filter-btn ${period === value ? 'filter-btn-active' : ''}`}>{value.toUpperCase()}</button>)}</div><PanelShareControl title={`Zcash observed transaction fees (${period})`} fileName={`zecblock-fees-${period}`} csv={() => objectRowsCsv(points)} panelRef={panelRef} disabled={!usable} /></div>} />
    <p className="text-caption text-muted mb-4">Daily median and 10th–90th percentile range. Observed fees, not a fee quote.</p>
    {loading && !usable ? <ChartSkeleton height={228} /> : !usable ? <p role="status" className="min-h-[240px] flex items-center justify-center text-sm text-muted">{loading || isRefreshing ? 'Loading observed fees…' : 'Fee history unavailable.'}</p> : <>
      <><ResponsiveContainer width="100%" height={228} initialDimension={{ width: 400, height: 228 }}>
        <ComposedChart data={points} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={colors.grid} />
          <XAxis dataKey="date" tickFormatter={dateLabel} {...CHART_DATE_AXIS} tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis width={56} tickCount={4} tickFormatter={v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} domain={[0, 'auto']} />
          <Tooltip labelFormatter={label => new Date(String(label)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}
            contentStyle={{ background: colors.tooltipBg, border: `1px solid ${colors.tooltipBorder}`, color: colors.tooltipText, fontSize: 12 }}
            formatter={(value, name) => [Array.isArray(value) ? `${value.map(v => Number(v).toFixed(3)).join('–')} m${CURRENCY}` : `${Number(value).toFixed(3)} m${CURRENCY}`, name]} />
          <Area type="linear" dataKey="range" name="P10–P90" stroke="none" fill={colors.transparent} fillOpacity={0.22} connectNulls={false} isAnimationActive={false} />
          <Line type="linear" dataKey="median" name="Median" stroke={colors.gold} strokeWidth={2} dot={points.length === 1} connectNulls={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer><ChartWatermark /></>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted mt-2"><span><span aria-hidden="true" className="inline-block w-3 h-0.5 bg-cipher-gold align-middle mr-1.5" />Median</span><span><span aria-hidden="true" className="inline-block w-3 h-2 bg-muted/30 align-middle mr-1.5" />P10–P90</span></div>
      <p className="text-caption text-muted mt-2">m{CURRENCY} · 1 m{CURRENCY} = 0.001 {CURRENCY}{last ? ` · latest day ${dateLabel(last.date)}` : ''}</p>
    </>}
    {data?.historyStatus === 'unavailable' && <p className="text-caption text-muted mt-3">All-time history is unavailable. Showing the last 30 days.</p>}
    {isRefreshing && <p role="status" className="text-caption text-muted mt-3">Updating range; previous observations remain visible.</p>}
    {error && <p role="status" className="text-caption text-warning mt-3">Fee history could not refresh. Last received observations are shown when available.</p>}
  </CardBody></Card></div>;
}
