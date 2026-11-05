'use client';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,

  ResponsiveContainer,
} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors, getChartTooltipStyle } from '@/lib/chart-theme';
import { poolDateAxis } from '@/lib/pool-display';
import { PoolCurrencyToggle, PoolCurrencyNote, usePoolCurrency } from '@/components/pools/PoolCurrency';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ShareableCard } from '@/components/ShareableCard';
import { tooltipDate } from '@/lib/chart-dates';
import { useUrlState } from '@/lib/use-url-state';

type Period = '30d' | '90d' | '1y' | 'all';
type View = 'rate' | 'composition' | 'pools';
const EMPTY_POINTS: PoolPoint[] = [];

const CHART_HEIGHT = 360;
const CHART_MARGIN = { top: 12, right: 16, left: 4, bottom: 24 };
const Y_AXIS_WIDTH = 64;

const VIEW_META: Record<View, { label: string; shortLabel: string; description: string }> = {
  rate: {
    label: 'Shielded %',
    shortLabel: 'Shielded %',
    description:
      'Share of issued chain supply held in shielded pools over time. For absolute balances use Public / private or Per pool.',
  },
  composition: {
    label: 'Public / private',
    shortLabel: 'Public / private',
    description:
      'Shielded vs transparent supply. Unmined supply is excluded — only issued pools on chain.',
  },
  pools: {
    label: 'Per pool',
    shortLabel: 'Per pool',
    description: 'How each value pool grew or shrank — Sprout through Ironwood — from daily chain state.',
  },
};

interface PoolPoint {
  date: string;
  shielded: number;
  sprout: number;
  sapling: number;
  orchard: number;
  ironwood: number;
  transparent: number;
  shieldedSupplyPct: number | null;
}

function segmentedClass(active: boolean) {
  return `px-2 py-1 text-caption font-mono uppercase tracking-wide rounded transition whitespace-nowrap ${
    active ? 'bg-brand-gold/15 text-cipher-gold font-semibold' : 'text-muted hover:text-primary'
  }`;
}

function SupplyChartFrame({ yLabel, children }: { yLabel: string; children: ReactNode }) {
  return (
    <div className="flex items-stretch gap-2">
      <div className="flex w-5 shrink-0 items-center justify-center" aria-hidden="true">
        <span className="origin-center -rotate-90 whitespace-nowrap text-caption font-mono text-muted">
          {yLabel}
        </span>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function RateTooltip({
  active,
  payload,
  label,
  colors,
}: {
  active?: boolean;
  payload?: Array<{ payload: Record<string, unknown> }>;
  label?: string;
  colors: ReturnType<typeof getChartColors>;
}) {
  const { format } = usePoolCurrency();
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const rate = row.shieldedPct as number | null;
  const shielded = row.shielded as number;
  const transparent = row.transparent as number;
  const total = shielded + transparent;

  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs font-mono shadow-lg"
      style={getChartTooltipStyle(colors)}
    >
      <p className="mb-2 text-caption uppercase tracking-wider text-muted">{tooltipDate(payload, label)}</p>
      {rate != null ? (
        <p className="mb-1 tabular-nums">
          <span className="text-cipher-gold font-semibold">{rate.toFixed(2)}%</span>
          <span className="text-muted"> shielded</span>
        </p>
      ) : null}
      <p className="tabular-nums text-secondary">{format(shielded)} shielded</p>
      <p className="tabular-nums text-muted">{format(transparent)} transparent</p>
      {total > 0 ? (
        <p className="mt-1 border-t border-glass-6 pt-1 tabular-nums text-muted">
          {format(total)} tracked
        </p>
      ) : null}
    </div>
  );
}

function CompositionTooltip({
  active,
  payload,
  label,
  colors,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: Record<string, unknown> }>;
  label?: string;
  colors: ReturnType<typeof getChartColors>;
}) {
  const { format } = usePoolCurrency();
  if (!active || !payload?.length) return null;

  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs font-mono shadow-lg"
      style={getChartTooltipStyle(colors)}
    >
      <p className="mb-2 text-caption uppercase tracking-wider text-muted">{tooltipDate(payload, label)}</p>
      {payload.map((entry) => (
        <p key={String(entry.name)} className="tabular-nums text-secondary">
          <span style={{ color: entry.color }}>{entry.name}</span>
          {': '}
          {format(Number(entry.value ?? 0))}
        </p>
      ))}
    </div>
  );
}

function PoolsTooltip({
  active,
  payload,
  label,
  colors,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: Record<string, unknown> }>;
  label?: string;
  colors: ReturnType<typeof getChartColors>;
}) {
  const { format } = usePoolCurrency();
  if (!active || !payload?.length) return null;

  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs font-mono shadow-lg"
      style={getChartTooltipStyle(colors)}
    >
      <p className="mb-2 text-caption uppercase tracking-wider text-muted">{tooltipDate(payload, label)}</p>
      {payload
        .filter((entry) => Number(entry.value ?? 0) > 0)
        .map((entry) => (
          <p key={String(entry.name)} className="tabular-nums text-secondary">
            <span style={{ color: entry.color }}>{entry.name}</span>
            {': '}
            {format(Number(entry.value ?? 0))}
          </p>
        ))}
    </div>
  );
}

export interface PoolHistoryResponse {
  points: PoolPoint[];
  hasVerifiedPerPoolBreakdown?: boolean;
}

export function PoolDistributionChart({ initialData, initialFetchedAt }: { initialFetchedAt?: number; initialData?: PoolHistoryResponse | null }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const { currency, price, format } = usePoolCurrency();
  const [chartWidth, setChartWidth] = useState(600);
  const [period, setPeriod] = useUrlState<Period>('pools', '30d', ['30d', '90d', '1y', 'all']);
  const [view, setView] = useState<View>('pools');
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const { data: apiRes, loading } = useApiQuery<PoolHistoryResponse>(
    '/v1/shielded-pools/history',
    { period },
    { refreshInterval: 300_000, initialFetchedAt, initialData: period === 'all' ? initialData ?? undefined : undefined },
  );
  const points = apiRes?.points ?? EMPTY_POINTS;
  const hasPerPoolHistory = !!apiRes?.hasVerifiedPerPoolBreakdown;

  const canShowPools =
    hasPerPoolHistory || points.some((p) => p.orchard > 0 || (p as PoolPoint).ironwood > 0);

  useEffect(() => {
    if (!loading && view === 'pools' && !canShowPools) {
      setView('composition');
    }
  }, [loading, view, canShowPools]);

  const chartData = useMemo(
    () =>
      points.map((p) => ({
        ...p,
        timestamp: Date.parse(p.date),
        shieldedPct: p.shieldedSupplyPct,
      })),
    [points],
  );

  const pctValues = chartData.map((d) => d.shieldedPct).filter((v): v is number => v != null && v > 0);
  const rateYMin = pctValues.length ? Math.max(0, Math.floor(Math.min(...pctValues) - 2)) : 0;
  const rateYMax = pctValues.length ? Math.min(100, Math.ceil(Math.max(...pctValues) + 2)) : 40;

  const maxSupplyZec = useMemo(() => {
    let max = 0;
    for (const p of chartData) {
      const total = (p.shielded || 0) + (p.transparent || 0);
      if (total > max) max = total;
    }
    return max * 1.05 || 1;
  }, [chartData]);

  const viewOptions: { key: View; label: string; title: string }[] = [
    ...(canShowPools
      ? [{ key: 'pools' as View, label: VIEW_META.pools.shortLabel, title: VIEW_META.pools.label }]
      : []),
    { key: 'composition', label: VIEW_META.composition.shortLabel, title: VIEW_META.composition.label },
    { key: 'rate', label: VIEW_META.rate.shortLabel, title: VIEW_META.rate.label },
  ];

  const meta = VIEW_META[view];
  const dateAxis = useMemo(() => poolDateAxis(points.map(p => p.date), chartWidth - Y_AXIS_WIDTH - 48), [points, chartWidth]);
  const shareText = `Zcash supply history (${meta.shortLabel}, ${period.toUpperCase()}) on ZecBlock.\n\nhttps://zecblock.com/pools#supply`;

  const controls = (
    <div className="mb-4 flex flex-wrap items-center justify-end gap-2" data-html2canvas-ignore="true">
      <PoolCurrencyToggle />
      <div className="inline-flex max-w-full flex-wrap gap-0 rounded-md bg-glass-3 p-0.5" role="group" aria-label="Chart view">
        {viewOptions.map(({ key, label, title: tabTitle }) => (
          <button
            key={key}
            type="button"
            title={tabTitle}
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={segmentedClass(view === key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="inline-flex gap-0 rounded-md bg-glass-3 p-0.5" role="group" aria-label="Time range">
        {(['30d', '90d', '1y', 'all'] as Period[]).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={period === p}
            onClick={() => setPeriod(p)}
            className={segmentedClass(period === p)}
          >
            {p.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );

  const chartBody = loading ? (
    <ChartSkeleton height={CHART_HEIGHT} />
  ) : currency === 'usd' && price == null && view !== 'rate' ? (
    <div className="flex items-center justify-center text-xs text-muted" style={{ height: CHART_HEIGHT }} role="status">A fresh quote is needed to display USD. Switch to ZEC to view supply history.</div>
  ) : chartData.length === 0 ? (
    <div
      className="flex items-center justify-center text-xs font-mono text-muted"
      style={{ height: CHART_HEIGHT }}
    >
      No supply history for this range.
    </div>
  ) : view === 'pools' && canShowPools ? (
    <SupplyChartFrame yLabel={currency === 'usd' ? 'USD at current price' : 'ZEC in pools'}>
      <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={CHART_HEIGHT} onResize={width => setChartWidth(width)}>
        <AreaChart data={chartData} margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            ticks={dateAxis.ticks}
            minTickGap={24}
            tickLine={false}
            axisLine={false}
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            tickFormatter={dateAxis.format}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            tickFormatter={(v) => format(v, false)}
            domain={[0, maxSupplyZec]}
            width={Y_AXIS_WIDTH}
          />
        <Tooltip content={<PoolsTooltip colors={colors} />} />
        <Area isAnimationActive={false} type="monotone" dataKey="ironwood" stackId="1" stroke={colors.ironwood} fill={colors.ironwood} fillOpacity={0.65} name="Ironwood" hide={hiddenSeries.has('ironwood')} />
        <Area isAnimationActive={false} type="monotone" dataKey="orchard" stackId="1" stroke={colors.orchard} fill={colors.orchard} fillOpacity={0.6} name="Orchard" hide={hiddenSeries.has('orchard')} />
        <Area isAnimationActive={false} type="monotone" dataKey="sapling" stackId="1" stroke={colors.sapling} fill={colors.sapling} fillOpacity={0.6} name="Sapling" hide={hiddenSeries.has('sapling')} />
        <Area isAnimationActive={false} type="monotone" dataKey="sprout" stackId="1" stroke={colors.sprout} fill={colors.sprout} fillOpacity={0.5} name="Sprout" hide={hiddenSeries.has('sprout')} />
        <Area isAnimationActive={false} type="monotone" dataKey="transparent" stackId="1" stroke={colors.transparent} fill={colors.transparent} fillOpacity={0.35} name="Transparent" hide={hiddenSeries.has('transparent')} />
      </AreaChart>
    </ResponsiveContainer>
    </SupplyChartFrame>
  ) : view === 'composition' ? (
    <SupplyChartFrame yLabel={currency === 'usd' ? 'USD at current price' : 'Chain supply (ZEC)'}>
      <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={CHART_HEIGHT} onResize={width => setChartWidth(width)}>
        <AreaChart data={chartData} margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            ticks={dateAxis.ticks}
            minTickGap={24}
            tickLine={false}
            axisLine={false}
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            tickFormatter={dateAxis.format}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            tickFormatter={(v) => format(v, false)}
            domain={[0, maxSupplyZec]}
            width={Y_AXIS_WIDTH}
          />
        <Tooltip content={<CompositionTooltip colors={colors} />} />
        <Area isAnimationActive={false} type="monotone" dataKey="shielded" stackId="1" stroke={colors.shielded} fill={colors.shielded} fillOpacity={0.55} name="Shielded" />
        <Area isAnimationActive={false} type="monotone" dataKey="transparent" stackId="1" stroke={colors.transparent} fill={colors.transparent} fillOpacity={0.35} name="Transparent" />
      </AreaChart>
    </ResponsiveContainer>
    </SupplyChartFrame>
  ) : (
    <SupplyChartFrame yLabel="Shielded %">
      <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={CHART_HEIGHT} onResize={width => setChartWidth(width)}>
        <LineChart data={chartData} margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="2 6" stroke={colors.grid} opacity={0.5} />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            ticks={dateAxis.ticks}
            minTickGap={24}
            tickLine={false}
            axisLine={false}
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            tickFormatter={dateAxis.format}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 12 }}
            domain={[rateYMin, rateYMax]}
            tickFormatter={(v) => `${v}%`}
            width={Y_AXIS_WIDTH}
          />
        <Tooltip content={<RateTooltip colors={colors} />} />
        <Line
          isAnimationActive={false}
          type="monotone"
          dataKey="shieldedPct"
          stroke={colors.shielded}
          strokeWidth={2.5}
          dot={false}
          name="Shielding rate"
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
    </SupplyChartFrame>
  );

  return (
    <ShareableCard
      title="Supply History"
      sourceHeight={0}
      isLive={false}
      shareText={shareText}
      fileName="zecblock-supply-history.png"
      watermark={true}
      className=""
      footerNote={`${meta.shortLabel} · ${period.toUpperCase()} · ${currency === 'usd' ? 'USD at current price' : 'ZEC'}`}
    >
      <p className="mb-4 max-w-2xl text-xs leading-relaxed text-secondary font-sans">
        Daily pool balances from chain state — stack by pool, split public vs private, or track shielded share over
        time.
      </p>
      {controls}
      {chartBody}
      {!loading && chartData.length > 0 && view !== 'rate' && (currency === 'zec' || price != null) && <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-caption" aria-label="Supply chart legend">
        {(view === 'pools' ? ['ironwood', 'orchard', 'sapling', 'sprout', 'transparent'] as const : ['shielded', 'transparent'] as const).map(key => {
          const hidden = hiddenSeries.has(key);
          const label = key.charAt(0).toUpperCase() + key.slice(1);
          const content = <><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colors[key] }} /><span>{label}</span></>;
          return view === 'pools' ? <button key={key} type="button" aria-pressed={!hidden} title={`${hidden ? 'Show' : 'Hide'} ${label}`}
            onClick={() => setHiddenSeries(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
            className={`flex min-h-8 items-center gap-1.5 rounded px-2 py-1 hover:bg-glass-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold ${hidden ? 'text-muted line-through' : 'text-secondary'}`}>
            {content}
          </button> : <span key={key} className="flex min-h-8 items-center gap-1.5 px-2 text-secondary">{content}</span>;
        })}
      </div>}
      <PoolCurrencyNote />
      <p className="mt-3 text-xs leading-relaxed text-muted">{meta.description}</p>
    </ShareableCard>
  );
}
