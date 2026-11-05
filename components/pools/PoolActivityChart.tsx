'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { ShareableCard } from '@/components/ShareableCard';
import { Tooltip } from '@/components/Tooltip';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { useTheme } from '@/contexts/ThemeContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { NETWORK } from '@/lib/api-config';
import type { CatalogChart } from '@/lib/chart-catalog';
import type { ChartExportData } from '@/lib/chart-sharing';
import { CHART_DATE_AXIS, getChartColors, getChartTooltipStyle } from '@/lib/chart-theme';
import { chartMarkerIndices } from '@/lib/chart-geometry';
import {
  ACTIVITY_NOTE, ACTIVITY_EXPORT_NOTE, ACTIVITY_POOLS, RECOVERY_LABEL, RECOVERY_NOTE, activityNumber, poolActivityRows, poolActivitySummary,
  selectedActivityPools, toggleActivityPool,
  type ActivityMode, type ActivityPeriod, type ActivityPool, type PoolActivityData,
} from './pool-activity';
import { useUrlState } from '@/lib/use-url-state';

const PERIODS = [
  { key: '7d', label: '7D' }, { key: '30d', label: '30D' },
  { key: '90d', label: '90D' }, { key: '1y', label: '1Y' },
] as const;
const MODES = [{ key: 'count', label: 'Tx count' }, { key: 'share', label: '%' }] as const;

function dateLabel(value: string | number, full = false): string {
  return new Date(Number(value)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(full ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
}

function RecoveryDot({ cx, cy, index, markerIndices, color, background }: {
  cx?: number; cy?: number; index?: number; markerIndices: ReadonlySet<number>; color: string; background: string;
}) {
  if (cx == null || cy == null || index == null || !Number.isFinite(cx) || !Number.isFinite(cy)
    || !markerIndices.has(index)) return <g />;
  return <path d={`M${cx},${cy - 3.5}l3.5,3.5l-3.5,3.5l-3.5,-3.5Z`}
    fill={background} stroke={color} strokeWidth={1.5} aria-hidden="true" />;
}

export function PoolActivityChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [period, setPeriod] = useUrlState<ActivityPeriod>('activity', '30d', PERIODS.map((option) => option.key));
  const [mode, setMode] = useState<ActivityMode>('count');
  const [selected, setSelected] = useState<ActivityPool[]>(ACTIVITY_POOLS.map(pool => pool.key));
  const visiblePools = useMemo(() => selectedActivityPools(selected), [selected]);
  const query = useApiQuery<PoolActivityData>('/v1/shielded-pools/activity', { period }, { refreshInterval: 300_000 });
  // The query hook retains previous data; never label another period's rows as this selection.
  const data = query.data?.period === period ? query.data : null;
  const rows = useMemo(() => poolActivityRows(data?.points ?? [], mode), [data, mode]);
  const hasObservations = rows.some(row => visiblePools.some(({ key }) => row[key] != null));
  const recoveryMarkers = useMemo(() => chartMarkerIndices(rows, 'ironwood'), [rows]);
  const loading = query.loading || (!data && query.isRefreshing);
  const coverage = data ? `${data.coverage.completeDays} of ${data.coverage.expectedDays} complete UTC days` : '';
  const total = data?.totals.totalTransactions ?? null;
  const dateRange = data ? `${dateLabel(Date.parse(data.startDate), true)} – ${dateLabel(Date.parse(data.endDate), true)} UTC` : '';
  const exportData = useMemo<ChartExportData>(() => {
    const chart: CatalogChart = {
      id: 'pool-transaction-activity',
      title: mode === 'share' ? 'Shielded pool transaction share · Zcash' : 'Shielded pool transaction counts · Zcash',
      description: visiblePools.some(pool => pool.key === 'ironwood')
        ? `${ACTIVITY_EXPORT_NOTE} Ironwood supports future quantum recovery (ZIP 2005).`
        : ACTIVITY_EXPORT_NOTE,
      category: 'Supply & flows', href: '/pools#activity',
      endpoint: `/v1/shielded-pools/activity?period=${period}`, rows: 'points', x: 'date',
      window: period.toUpperCase(), unit: mode === 'share' ? '%' : 'Transactions',
      series: visiblePools.map(pool => ({
        ...pool, summary: poolActivitySummary(data?.totals[pool.key] ?? null, total, mode),
      })), kind: 'line',
    };
    return {
      chart, rows, network: NETWORK, source: 'ZecBlock indexed transactions',
      asOf: data ? `${coverage}${data.sourceHeight != null ? ` · through block ${data.sourceHeight.toLocaleString('en-US')}` : ''}` : undefined,
    };
  }, [mode, period, rows, data, total, coverage, visiblePools]);

  return (
    <ShareableCard
      title="Transaction activity by pool"
      shareText={`Zcash transaction activity by shielded pool (${period.toUpperCase()}). ${ACTIVITY_NOTE}`}
      sharePath="/pools#activity"
      fileName={`zecblock-pool-transactions-${mode}-${period}${selected.length < ACTIVITY_POOLS.length ? `-${selected.join('-')}` : ''}.png`}
      exportData={exportData}
      exportDisabled={!hasObservations || !data || query.isRefreshing || Boolean(query.error)}
      sourceHeight={data?.sourceHeight ?? undefined}
      footerNote={data ? `${coverage}${data.sourceHeight != null ? ` · block ${data.sourceHeight.toLocaleString('en-US')}` : ''}` : 'Complete UTC days'}
      className=""
    >
      <p className="mb-4 text-caption leading-relaxed text-muted">{ACTIVITY_NOTE}</p>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3" data-html2canvas-ignore="true">
        <PeriodPillTags options={MODES} value={mode} onChange={setMode} aria-label="Activity metric" />
        <PeriodPillTags options={PERIODS} value={period} onChange={setPeriod} aria-label="Activity period" />
      </div>

      {loading ? <ChartSkeleton height={320} /> : !data ? (
        <div className="flex h-80 flex-col items-center justify-center gap-3 text-caption text-muted" role="status">
          <p>Pool activity is temporarily unavailable.</p>
          <button type="button" onClick={() => void query.refetch()} className="text-secondary underline underline-offset-4">Try again</button>
        </div>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4" role="group" aria-label="Pools shown on chart">
            {ACTIVITY_POOLS.map(({ key, label, color }) => {
              const visible = selected.includes(key);
              const summary = poolActivitySummary(data.totals[key], total, mode);
              return <div key={key} className="min-w-0">
                <button type="button" aria-pressed={visible} aria-label={`${label} pool`}
                  title={visible && selected.length === 1 ? 'At least one pool stays visible' : `${visible ? 'Hide' : 'Show'} ${label}`}
                  onClick={() => setSelected(current => toggleActivityPool(current, key))}
                  className={`w-full rounded-lg p-2 text-left transition hover:bg-glass-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cipher-gold ${visible ? 'text-primary' : 'text-muted'}`}>
                  <span className="mb-1 flex items-center gap-2 text-caption text-muted">
                    <span className="flex h-3 w-3 shrink-0 items-center justify-center rounded-sm border" style={{ borderColor: visible ? colors[color] : colors.referenceLine, backgroundColor: visible ? colors[color] : 'transparent' }}>
                      {visible && <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className="text-cipher-bg" aria-hidden="true"><path d="m2 6 2.5 2.5L10 3" stroke="currentColor" strokeWidth="1.5" /></svg>}
                    </span>{label}
                  </span>
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-lg tabular-nums" aria-label={`${label} total`}>{summary.primary}</span>
                    <span className="font-mono text-caption tabular-nums text-muted" aria-label={`${label} ${mode === 'count' ? 'share' : 'count'}`}>
                      ({summary.secondary})
                    </span>
                  </span>
                </button>
                {key === 'ironwood' && <div className="mt-1 pl-2">
                  <Tooltip content={RECOVERY_NOTE} label="About Ironwood quantum recovery">
                    <span className="inline-flex items-center gap-1 rounded border border-cipher-border px-1.5 py-0.5 text-caption">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ color: colors.ironwood }}><path d="m5 1 4 4-4 4-4-4Z" stroke="currentColor" strokeWidth="1.2" /></svg>
                      {RECOVERY_LABEL}
                    </span>
                  </Tooltip>
                </div>}
              </div>;
            })}
          </div>
          <p className="mb-3 text-caption text-muted">
            {dateRange}{total != null ? ` · ${total.toLocaleString('en-US')} non-coinbase transactions` : ''}
          </p>
          {hasObservations ? (
            <div className="h-80" role="img" aria-label={`Daily shielded pool transaction ${mode === 'share' ? 'percentages' : 'counts'}. ${ACTIVITY_NOTE}`}>
              <ResponsiveContainer initialDimension={{ width: 500, height: 320 }} width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 22 }}>
                  <CartesianGrid vertical={false} stroke={colors.gridStroke} />
                  <XAxis
                    {...CHART_DATE_AXIS} dataKey="x" type="number" domain={['dataMin', 'dataMax']}
                    scale="time" tickFormatter={value => dateLabel(value)} tick={{ fill: colors.axis, fontSize: 12 }}
                    tickLine={false} axisLine={false}
                    label={{ value: 'Date (UTC)', position: 'insideBottom', offset: -14, fill: colors.axis, fontSize: 12 }}
                  />
                  <YAxis
                    width={64} domain={[0, 'auto']} allowDecimals={mode === 'share'}
                    tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false}
                    tickFormatter={value => mode === 'share' ? `${value}%` : new Intl.NumberFormat('en-US', { notation: 'compact' }).format(Number(value))}
                    label={{ value: mode === 'share' ? '% of transactions' : 'Transactions', angle: -90, position: 'insideLeft', fill: colors.axis, fontSize: 12 }}
                  />
                  <ChartTooltip
                    contentStyle={getChartTooltipStyle(colors)} labelFormatter={label => dateLabel(Number(label), true)}
                    formatter={(value, name) => [activityNumber(Number(value), mode), ACTIVITY_POOLS.find(pool => pool.key === name)?.label ?? String(name)]}
                  />
                  {visiblePools.map(({ key, color, strokeWidth }) => (
                    <Line key={key} dataKey={key} type="linear" stroke={colors[color]} strokeWidth={strokeWidth}
                      dot={key === 'ironwood' ? <RecoveryDot markerIndices={recoveryMarkers} color={colors[color]} background={colors.tooltipBg} /> : { r: 2, strokeWidth: 0, fill: colors[color] }}
                      activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-80 items-center justify-center text-caption text-muted" role="status">
              {mode === 'share' && total === 0 ? 'No non-coinbase transactions in this period.' : 'No complete activity observations are available.'}
            </div>
          )}
          {data.coverage.completeDays < data.coverage.expectedDays && (
            <p className="mt-3 text-caption text-muted">Some days are unavailable. Gaps are not counted as zero.</p>
          )}
          {query.error && <p className="mt-3 text-caption text-muted" role="status">Update unavailable. Showing the last loaded data.</p>}
        </>
      )}
    </ShareableCard>
  );
}
