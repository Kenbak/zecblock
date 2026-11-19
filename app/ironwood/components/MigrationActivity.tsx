'use client';

import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,

} from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { ShareableCard } from '@/components/ShareableCard';
import { fmtValue, type CurrencyMode } from '@/hooks/useCurrencyToggle';
import { CHART_DATE_AXIS } from '@/lib/chart-theme';
import { zatToZec } from '@/lib/format-numbers';
import type {
  ActivityView,
  ChartColors,
  Cohorts,
  MigrationActivityData,
  VelocityBucket,
} from './types';
import { EmptyPanel, SegmentedControl } from './ui';

const zec = zatToZec;

const ACTIVITY_VIEWS: { id: ActivityView; label: string }[] = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'cohorts', label: 'Cohorts' },
  { id: 'daily', label: 'Daily' },
];

function mapActivityBuckets(activity: MigrationActivityData): VelocityBucket[] {
  const hourly = activity.granularity === 'hour';
  return activity.buckets.map((bucket) => {
    const date = new Date(bucket.bucketStart * 1000);
    // Same day label as every other chart axis; the year keeps daily buckets unique.
    const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const label = hourly
      ? `${day}, ${String(date.getUTCHours()).padStart(2, '0')}:00`
      : `${day}, ${date.getUTCFullYear()}`;
    return {
      label,
      ts: bucket.bucketStart * 1000,
      volume: zec(bucket.volumeZat),
      txCount: bucket.txCount,
    };
  });
}

export function MigrationActivity({
  cohorts,
  activityHourly,
  activityDaily,
  activityLoading,
  activityUnavailable,
  activated,
  colors,
  tipHeight,
  currencyMode,
  zecPrice,
}: {
  cohorts: Cohorts | null;
  activityHourly: MigrationActivityData | null;
  activityDaily: MigrationActivityData | null;
  activityLoading: boolean;
  activityUnavailable: boolean;
  activated: boolean;
  colors: ChartColors;
  tipHeight: number;
  currencyMode: CurrencyMode;
  zecPrice: number | null;
}) {
  const [view, setView] = useState<ActivityView>('hourly');

  // Cohort data
  const cohortData = useMemo(
    () =>
      (cohorts?.cohorts ?? []).map((c) => ({
        boundary: c.boundaryStartHeight,
        volume: zec(c.volumeZat),
        txCount: c.txCount,
        firstTime: c.firstTime,
      })),
    [cohorts?.cohorts],
  );

  // Time-bucketed data (hourly/daily)
  const timeBuckets = useMemo(() => {
    if (view === 'cohorts') return [];
    const aggregate = view === 'hourly' ? activityHourly : activityDaily;
    if (aggregate?.buckets.length) return mapActivityBuckets(aggregate);
    return [];
  }, [activityDaily, activityHourly, view]);

  const avgCohort = cohorts?.avgAnonymitySet ?? 0;
  const totalVolumeZec = cohortData.reduce((sum, c) => sum + c.volume, 0);
  const activeCohorts = cohortData.filter((c) => c.volume > 0).length;

  // Stats for time views
  const timeTotalVolume = timeBuckets.reduce((s, b) => s + b.volume, 0);
  const timeTotalTxs = timeBuckets.reduce((s, b) => s + b.txCount, 0);
  const timePeak = timeBuckets.reduce((max, b) => (b.volume > max.volume ? b : max), timeBuckets[0] ?? { volume: 0 });
  const timeAvg = timeBuckets.length > 0 ? timeTotalVolume / timeBuckets.length : 0;

  const periodLabel = view === 'hourly' ? 'hour' : view === 'daily' ? 'day' : 'cohort';

  // Visible chart data + yMax
  const cohortPeak = cohortData.reduce((max, c) => Math.max(max, c.volume), 0);
  const visiblePeak = view === 'cohorts' ? cohortPeak : (timePeak?.volume ?? 0);
  const yMax = Math.max(Math.ceil(visiblePeak * 1.1), 1);

  const shareText =
    view === 'cohorts' && activeCohorts > 0
      ? `${totalVolumeZec.toLocaleString(undefined, { maximumFractionDigits: 0 })} ZEC migrated across ${activeCohorts} Orchard→Ironwood cohorts. Avg anonymity set: ${avgCohort.toFixed(1)} txs.\n\nhttps://zecblock.com/ironwood`
      : view !== 'cohorts' && timeTotalTxs > 0
        ? `${timeTotalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })} ZEC migrated Orchard→Ironwood. Peak ${periodLabel}: ${(timePeak?.volume ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} ZEC.\n\nhttps://zecblock.com/ironwood`
        : `Zcash Orchard → Ironwood migration activity on ZecBlock.\n\nhttps://zecblock.com/ironwood`;

  const subtitle = view === 'cohorts'
    ? (
      <>
        <span className="sm:hidden">Volume per 144-block boundary (~3h). Each bar is one anonymity cohort.</span>
        <span className="hidden sm:inline">
          Volume per 144-block boundary (~3h). Each bar is one anonymity cohort — wallets sharing a boundary mix together.
          {avgCohort > 0 ? <> Avg cohort size: <span className="font-mono text-primary">{avgCohort.toFixed(1)} txs</span>.</> : null}
        </span>
      </>
    )
    : <>ZEC migrated from Orchard to Ironwood per {periodLabel} (UTC).{timeAvg > 0 ? <> Avg per reported {periodLabel}: <span className="font-mono text-primary">{fmtValue(Math.round(timeAvg * 1e8), currencyMode, zecPrice)}/{periodLabel}</span>.</> : null}</>;

  const statsRowClass = 'mb-4 flex flex-col gap-2 text-caption font-mono leading-snug text-muted sm:mb-3 sm:flex-row sm:flex-wrap sm:gap-x-5 sm:gap-y-1 sm:text-caption';

  const hasData = view === 'cohorts' ? cohortData.length > 0 : timeBuckets.length > 0;

  return (
    <div id="migration-activity" className="scroll-mt-20">
      <ShareableCard
        title="Orchard → Ironwood migration activity"
        sourceHeight={tipHeight}
        isLive={activated}
        shareText={shareText}
        fileName="zecblock-migration-activity.png"
        footerNote={view !== 'cohorts' && timeBuckets.length > 0 ? `${timeBuckets[0].label} – ${timeBuckets[timeBuckets.length - 1].label} UTC · latest bucket may be incomplete` : undefined}
      >
        <p className="mb-5 max-w-2xl text-xs leading-[1.65] text-muted sm:mb-4 sm:leading-relaxed">{subtitle}</p>

        {/* Stats row */}
        {view === 'cohorts' && activeCohorts > 0 ? (
          <div className={statsRowClass}>
            <span>Volume in view <span className="text-cipher-ironwood">{totalVolumeZec.toLocaleString(undefined, { maximumFractionDigits: 0 })} ZEC</span></span>
            <span>Peak cohort <span className="text-primary">{cohortPeak.toLocaleString(undefined, { maximumFractionDigits: 0 })} ZEC</span></span>
            <span>Active cohorts <span className="text-primary">{activeCohorts}</span>{avgCohort > 0 ? <span className="text-muted sm:hidden"> · avg {avgCohort.toFixed(1)} txs</span> : null}</span>
          </div>
        ) : view !== 'cohorts' && timeTotalTxs > 0 ? (
          <div className={statsRowClass}>
            <span>Volume in view <span className="text-cipher-ironwood">{fmtValue(Math.round(timeTotalVolume * 1e8), currencyMode, zecPrice)}</span></span>
            <span>Peak {periodLabel} <span className="text-primary">{fmtValue(Math.round((timePeak?.volume ?? 0) * 1e8), currencyMode, zecPrice)}</span></span>
            <span>Transactions <span className="text-primary">{timeTotalTxs.toLocaleString()}</span></span>
          </div>
        ) : null}

        {/* View toggle */}
        <div className="mb-4 sm:mb-3 sm:flex sm:justify-end" data-html2canvas-ignore="true">
          <SegmentedControl options={ACTIVITY_VIEWS} value={view} onChange={setView} />
        </div>

        {/* Chart */}
        {hasData ? (
          view === 'cohorts' ? (
            <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={240}>
              <BarChart data={cohortData} margin={{ top: 8, right: 12, bottom: 28, left: 12 }}>
                <XAxis tickLine={false} axisLine={false}
                  dataKey="boundary"
                  tick={{ fontSize: 12, fill: colors.axis }}
                  tickFormatter={(v: number) => v.toLocaleString()}
                  label={{ value: 'Block height', position: 'insideBottom', offset: -8, style: { fontSize: 12, fill: colors.axis, fontFamily: 'var(--font-geist-mono)' } }}
                />
                <YAxis tickLine={false} axisLine={false}
                  tick={{ fontSize: 12, fill: colors.axis }}
                  width={44}
                  domain={[0, yMax]}
                  tickFormatter={(v) => Number(v).toLocaleString()}
                  label={{ value: 'Volume (ZEC)', angle: -90, position: 'insideLeft', dx: -6, style: { textAnchor: 'middle', fontSize: 12, fill: colors.axis, fontFamily: 'var(--font-geist-mono)' } }}
                />
                <Tooltip
                  cursor={{ fill: colors.barCursor }}
                  contentStyle={{ backgroundColor: colors.tooltipBg, border: `1px solid ${colors.tooltipBorder}`, borderRadius: '8px', fontSize: 12 }}
                  itemStyle={{ color: colors.tooltipText }}
                  labelStyle={{ color: 'var(--color-text-muted, #8b8b9e)', fontFamily: 'var(--font-geist-mono)', fontSize: 12 }}
                  labelFormatter={(v) => `Boundary @ height ${Number(v).toLocaleString()}`}
                  formatter={(val: unknown, name: unknown) =>
                    name === 'volume'
                      ? [`${Number(val).toLocaleString(undefined, { maximumFractionDigits: 2 })} ZEC`, 'Volume']
                      : [Number(val), 'Txs (anonymity set)']
                  }
                />
                <Bar dataKey="volume" fill={colors.ironwoodPool} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer initialDimension={{ width: 500, height: 300 }} width="100%" height={240}>
              <AreaChart data={timeBuckets} margin={{ top: 8, right: 12, bottom: 28, left: 12 }}>
                <defs>
                  <linearGradient id="velocityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.ironwoodPool} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={colors.ironwoodPool} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis tickLine={false} axisLine={false}
                  dataKey="label"
                  tick={{ fontSize: 12, fill: colors.axis }}
                  {...CHART_DATE_AXIS}
                  angle={0}
                  textAnchor="middle"
                  height={32}
                />
                <YAxis tickLine={false} axisLine={false}
                  tick={{ fontSize: 12, fill: colors.axis }}
                  width={50}
                  domain={[0, yMax]}
                  tickFormatter={(v) => Number(v).toLocaleString()}
                  label={{ value: 'Volume (ZEC)', angle: -90, position: 'insideLeft', dx: -6, style: { textAnchor: 'middle', fontSize: 12, fill: colors.axis, fontFamily: 'var(--font-geist-mono)' } }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: colors.tooltipBg, border: `1px solid ${colors.tooltipBorder}`, borderRadius: '8px', fontSize: 12 }}
                  itemStyle={{ color: colors.tooltipText }}
                  labelStyle={{ color: 'var(--color-text-muted, #8b8b9e)', fontFamily: 'var(--font-geist-mono)', fontSize: 12 }}
                  formatter={(val: unknown, name: unknown) =>
                    name === 'volume'
                      ? [`${Number(val).toLocaleString(undefined, { maximumFractionDigits: 2 })} ZEC`, `Volume / ${periodLabel}`]
                      : [Number(val), 'Transactions']
                  }
                />
                <Area
                  type="linear"
                  dataKey="volume"
                  stroke={colors.ironwoodPool}
                  strokeWidth={2}
                  fill="url(#velocityGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )
        ) : (
          <EmptyPanel
            activated={activated}
            message={
              activityLoading
                ? 'Loading migration activity…'
                : activityUnavailable
                  ? 'Migration activity temporarily unavailable'
                  : undefined
            }
          />
        )}
      </ShareableCard>
    </div>
  );
}
