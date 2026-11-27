'use client';

import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { ShareableCard } from '@/components/ShareableCard';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { MetricCard } from '@/components/ui/MetricCard';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';
import { useTheme } from '@/contexts/ThemeContext';
import { useApiQuery } from '@/hooks/useApiQuery';
import { PoolFlowSankey } from './PoolFlowSankey';
import { captureParticleGif } from '@/lib/chart-gif';
import { formatChartDate } from '@/lib/chart-dates';
import { getChartColors, getChartTooltipStyle } from '@/lib/chart-theme';
import { formatZecCompact } from '@/lib/format-numbers';
import { useUrlState } from '@/lib/use-url-state';
import {
  IN_GROUPS, OUT_GROUPS, coveredDays, groupColors, mainCounterpart, groupTotals, miningShare, seriesRows, zat,
  type GroupKey, type PoolSourcesData, type SourceDetail, type SourcePeriod, type SourcePool,
} from './pool-sources';

const CHART_HEIGHT = 280;
const POOLS: { key: SourcePool; label: string }[] = [
  { key: 'sapling', label: 'Sapling' },
  { key: 'ironwood', label: 'Ironwood' },
  { key: 'orchard', label: 'Orchard' },
];
const PERIODS: { key: SourcePeriod; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7D' }, { key: '30d', label: '30D' }, { key: '90d', label: '90D' }, { key: '1y', label: '1Y' }, { key: 'all', label: 'ALL' },
];
const POOL_NAME: Record<SourcePool, string> = { sapling: 'Sapling', ironwood: 'Ironwood', orchard: 'Orchard' };

const fmtZec = (zec: number) => {
  const abs = Math.abs(zec);
  return `${abs >= 100 ? formatZecCompact(abs) : abs.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZEC`;
};
const fmtSigned = (zec: number) => `${zec > 0 ? '+' : zec < 0 ? '−' : ''}${fmtZec(zec)}`;
const fmtPct = (share: number) => (share > 0 && share < 0.001 ? '<0.1%' : `${(share * 100).toFixed(share < 0.01 ? 1 : 0)}%`);

function SeriesTooltip({ active, payload, label, colors, groupColor }: {
  active?: boolean; label?: string;
  payload?: Array<{ dataKey?: string; value?: number; payload?: Record<string, unknown> }>;
  colors: ReturnType<typeof getChartColors>; groupColor: Record<GroupKey, string>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload ?? {};
  const lines = (prefix: 'in' | 'out', groups: typeof IN_GROUPS) => groups
    .map(g => ({ g, v: Number(row[`${prefix}_${g.key}`] ?? 0) }))
    .filter(x => x.v !== 0);
  const ins = lines('in', IN_GROUPS), outs = lines('out', OUT_GROUPS);
  return (
    <div className="rounded-lg border px-3 py-2 text-xs font-mono shadow-lg" style={getChartTooltipStyle(colors)}>
      <p className="mb-2 text-caption uppercase tracking-wider text-muted">
        {formatChartDate(String(label ?? ''))}{row.coverage === 'partial' ? ' · partial' : ''}
      </p>
      {ins.length > 0 && <p className="text-muted">In</p>}
      {ins.map(({ g, v }) => (
        <p key={`in-${g.key}`} className="tabular-nums text-secondary">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: groupColor[g.key] }} />{g.label}: {fmtZec(v)}
        </p>
      ))}
      {outs.length > 0 && <p className="mt-1 text-muted">Out</p>}
      {outs.map(({ g, v }) => (
        <p key={`out-${g.key}`} className="tabular-nums text-secondary">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: groupColor[g.key] }} />{g.label}: {fmtZec(v)}
        </p>
      ))}
      {row.net != null && <p className="mt-1 tabular-nums text-primary">Net: {fmtSigned(Number(row.net))}</p>}
    </div>
  );
}

export function PoolSourcesSection() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const poolColors: Record<string, string> = { sapling: colors.sapling, ironwood: colors.ironwood, orchard: colors.orchard, sprout: colors.sprout };
  const [pool, setPool] = useUrlState<SourcePool>('source', 'sapling', POOLS.map(p => p.key));
  const [period, setPeriod] = useUrlState<SourcePeriod>('sources', '30d', PERIODS.map(p => p.key));
  const [view, setView] = useState<'composition' | 'time'>('composition');
  const query = useApiQuery<PoolSourcesData>('/v1/shielded-pools/sources', { pool, period }, { refreshInterval: 60_000 });
  // The hook keeps previous data while refetching; never label another selection's rows as this one.
  const data = query.data && query.data.pool === pool && query.data.period === period ? query.data : null;
  const groupColor = groupColors(theme, poolColors[mainCounterpart(data) ?? ''] ?? colors.shielded);

  const model = useMemo(() => {
    if (!data?.totals) return null;
    // Averages use completed days only; the flow and "today so far" include the partial day.
    const days = Math.max(coveredDays(data), 1);
    const base = data.completeTotals ?? data.totals;
    const inZec = zat(base.inZat), outZec = zat(base.outZat);
    const today = data.partialDay ? { in: zat(data.partialDay.inZat), out: zat(data.partialDay.outZat), net: zat(data.partialDay.netZat),
      asOf: new Date(data.partialDay.throughTime * 1000).toISOString().slice(11, 16) } : null;
    const named = (rows: SourceDetail[] | null, cats: string[]) => (rows ?? []).filter(d => cats.includes(d.category)).slice(0, 6);
    return {
      days, inZec, outZec, netZec: inZec - outZec, today, periodNet: zat(data.totals.netZat),
      inGroups: groupTotals(data.sources, IN_GROUPS),
      outGroups: groupTotals(data.destinations, OUT_GROUPS),
      mining: miningShare(data),
      namedIn: named(data.sourceDetails, ['mining', 'funding', 'exchange', 'migration']),
      namedOut: named(data.destinationDetails, ['exchange', 'migration']),
      rows: seriesRows(data.series),
    };
  }, [data]);

  const poolName = POOL_NAME[pool];
  const poolColor = poolColors[pool];
  const periodLabel = PERIODS.find(p => p.key === period)?.label ?? period;
  // Once this view has loaded, fetch the other pools for the same period in the
  // background, so switching pools is instant even on slow links.
  const [otherA, otherB] = POOLS.map(p => p.key).filter(key => key !== pool);
  // Gate on any loaded data (query.data keeps the previous view during a switch):
  // gating on this view's data would unsubscribe the prefetches mid-switch and
  // drop their cached entries.
  const prefetch = Boolean(query.data);
  useApiQuery<PoolSourcesData>('/v1/shielded-pools/sources', { pool: otherA, period }, { enabled: prefetch });
  useApiQuery<PoolSourcesData>('/v1/shielded-pools/sources', { pool: otherB, period }, { enabled: prefetch });

  // The hook keeps the previous selection's data while a new one loads; until this
  // selection's data or an error arrives, show the skeleton, never "unavailable".
  const loading = !data && !query.error;
  const unavailable = !loading && !model;

  const controls = (
    <div className="mb-5 flex flex-wrap items-center justify-end gap-2" data-html2canvas-ignore="true">
      <PeriodPillTags options={POOLS} value={pool} onChange={setPool} aria-label="Shielded pool" />
      <PeriodPillTags options={PERIODS} value={period} onChange={setPeriod} aria-label="Sources period" />
    </div>
  );

  const body = loading ? <ChartSkeleton height={CHART_HEIGHT} /> : unavailable || !model || !data ? (
    <p className="flex items-center justify-center text-center text-xs font-mono text-muted" style={{ height: CHART_HEIGHT }} role="status">
      {query.error?.includes('503') ? 'The source breakdown is still being built. Check back shortly.' : 'Source breakdown is temporarily unavailable.'}
    </p>
  ) : (
    <>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {period === 'today' ? (
          <>
            <MetricCard size="compact" label="IN TODAY" value={fmtZec(model.today?.in ?? 0)} hint="since 00:00 UTC" />
            <MetricCard size="compact" label="OUT TODAY" value={fmtZec(model.today?.out ?? 0)} hint="since 00:00 UTC" />
          </>
        ) : (
          <>
            <MetricCard size="compact" label="IN / DAY" value={fmtZec(model.inZec / model.days)} hint={`average of the last ${model.days} full days`} />
            <MetricCard size="compact" label="OUT / DAY" value={fmtZec(model.outZec / model.days)} hint={`average of the last ${model.days} full days`} />
          </>
        )}
        {model.today ? (
          <MetricCard size="compact" label="TODAY SO FAR" value={fmtSigned(model.today.net)}
            accent={model.today.net > 0 ? 'green' : model.today.net < 0 ? 'orange' : 'default'}
            hint={`${fmtZec(model.today.in)} in · ${fmtZec(model.today.out)} out · ${model.today.asOf} UTC`} />
        ) : (
          <MetricCard size="compact" label="NET / DAY" value={fmtSigned(model.netZec / model.days)}
            accent={model.netZec > 0 ? 'green' : model.netZec < 0 ? 'orange' : 'default'} hint={`${poolName} balance change`} />
        )}
        <MetricCard size="compact" label="FROM MINING" accent="gold"
          value={model.mining == null ? '—' : fmtPct(model.mining)} hint="of inflow from outside shielded pools" />
      </div>

      <div className="mb-3 flex justify-end" data-html2canvas-ignore="true">
        <PeriodPillTags options={[{ key: 'composition', label: 'Flow' }, { key: 'time', label: 'Over time' }] as const}
          value={view} onChange={setView} aria-label="Sources view" />
      </div>

      {view === 'composition' ? (
        <PoolFlowSankey data={data} poolName={poolName} poolColor={poolColor} groupColor={groupColor} poolColors={poolColors}
          positive={colors.shielding} negative={colors.deshielding} ink={colors.tooltipText} muted={colors.axis} />
      ) : (
        <ResponsiveContainer initialDimension={{ width: 500, height: CHART_HEIGHT }} width="100%" height={CHART_HEIGHT}>
          <BarChart data={model.rows} stackOffset="sign" barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={colors.gridStroke} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} stroke={colors.axis} tick={{ fill: colors.axis, fontSize: 12 }}
              tickFormatter={v => formatChartDate(String(v))} minTickGap={32} />
            <YAxis tickLine={false} axisLine={false} stroke={colors.axis} tick={{ fill: colors.axis, fontSize: 12 }} width={54}
              tickFormatter={v => (Number(v) === 0 ? '0' : formatZecCompact(Math.abs(Number(v))))} />
            <Tooltip cursor={{ fill: colors.barCursor }} content={<SeriesTooltip colors={colors} groupColor={groupColor} />} />
            <ReferenceLine y={0} stroke={colors.referenceLine} />
            {IN_GROUPS.map(g => <Bar key={`in_${g.key}`} dataKey={`in_${g.key}`} stackId="flow" fill={groupColor[g.key]} stroke={colors.tooltipBg} strokeWidth={1} maxBarSize={48} isAnimationActive={false} />)}
            {OUT_GROUPS.map(g => <Bar key={`out_${g.key}`} dataKey={`out_${g.key}`} stackId="flow" fill={groupColor[g.key]} fillOpacity={0.75} stroke={colors.tooltipBg} strokeWidth={1} maxBarSize={48} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
      )}
      {view === 'time' && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption font-mono text-secondary" aria-label="Legend">
          {[...IN_GROUPS, ...OUT_GROUPS].filter((g, i, all) => all.findIndex(x => x.key === g.key) === i)
            .filter(g => model.inGroups.some(t => t.key === g.key) || model.outGroups.some(t => t.key === g.key))
            .map(g => (
              <li key={g.key}><span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: groupColor[g.key] }} aria-hidden="true" />{g.label}</li>
            ))}
          <li className="text-muted">Above zero: into {poolName} · below: out of {poolName}</li>
        </ul>
      )}
      {data.status === 'stale' && (
        <p className="mt-3 text-caption font-mono text-muted" role="status">Updating: figures may trail the latest blocks.</p>
      )}
    </>
  );

  return (
    <ShareableCard
      title={`Where ${poolName} ZEC comes from and goes`}
      sourceHeight={0}
      isLive={false}
      shareText={`Where ZEC entering and leaving the Zcash ${poolName} pool comes from and goes (${periodLabel}) on ZecBlock.\n\nhttps://zecblock.com/pools#sources`}
      fileName={`zecblock-${pool}-sources-${period}.png`}
      watermark
      className=""
      footerNote={`${poolName} · ${period === 'today' ? 'today since 00:00' : `${periodLabel} + today so far`} · UTC days`}
      animatedCapture={view === 'composition' && model ? captureParticleGif : undefined}
    >
      <p className="mb-4 max-w-2xl text-xs leading-relaxed text-secondary font-sans">
        Every ZEC that enters or leaves the {poolName} pool, by where it came from and where it went: other shielded pools,
        miners shielding block rewards, exchanges or other public addresses. Amounts inside the pool stay private.
      </p>
      {controls}
      {body}
    </ShareableCard>
  );
}
