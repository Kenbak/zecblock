'use client';

import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { CURRENCY } from '@/lib/config';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { ChartWatermark } from '@/components/ChartWatermark';
import { Card, CardBody } from '@/components/ui/Card';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { issuanceChartPoints, type EmissionResponse } from '@/lib/issuance-curve';

const amount = (value: number | null | undefined) => value != null && Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
const fullDate = (value: number) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const cadence = (sample: EmissionResponse['cadence']) => sample && Number.isFinite(sample.intervalSeconds)
  ? ` Last ${sample.intervals.toLocaleString('en-US')} blocks averaged ${sample.intervalSeconds.toFixed(1)} s${sample.lagBlocks ? `, ending ${sample.lagBlocks} blocks behind the node` : ''}.` : '';
const date = (value: number) => new Date(value).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function SupplyIssuanceChart({ data, loading, error }: { data: EmissionResponse | null; loading: boolean; error: string | null }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const points = issuanceChartPoints(data);
  const firstTime = points[0]?.time;
  const lastTime = points.at(-1)?.time;
  const ticks = firstTime != null && lastTime != null ? Array.from({ length: 5 }, (_, i) => firstTime + (lastTime - firstTime) * i / 4) : undefined;
  const milestones = points.filter(p => p.halving != null && p.projected != null);
  const observedAt = data?.supplyObservedAt ? Date.parse(data.supplyObservedAt) : null;
  return <Card className="mb-5"><CardBody>
    <SectionHeader card label="Supply issuance" />
    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
      {([['Issued supply', data?.circulating], ['Remaining to cap', data?.remaining], ['Estimated daily issuance', data?.dailyEmissionEstimate]] as const).map(([label, value]) =>
        <div key={label}><dt className="text-caption text-muted mb-1">{label}</dt><dd className="font-mono text-primary tabular-nums">{amount(value)} <span className="text-caption text-muted">{CURRENCY}</span></dd></div>)}
    </dl>
    {observedAt != null && Number.isFinite(observedAt) && <p className="text-caption text-muted mb-2">Latest observation: {fullDate(observedAt)}.</p>}
    <p className="text-caption text-muted mb-4">Daily estimate: current block subsidy × {data?.targetSpacingSeconds ? `${(86400 / data.targetSpacingSeconds).toLocaleString('en-US')} blocks per day at the ${data.targetSpacingSeconds}-second target` : 'blocks per day at the target block time'}.{cadence(data?.cadence)}</p>
    {loading && !points.length ? <ChartSkeleton height={280} /> : !points.length ? <p role="status" className="text-sm text-muted py-12 text-center">Supply history is unavailable.</p> : <>
      <ResponsiveContainer width="100%" height={280} initialDimension={{ width: 600, height: 280 }}>
        <ComposedChart data={points} margin={{ top: 26, right: 28, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={colors.gridStroke} />
          <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} scale="time" ticks={ticks} tickFormatter={date} tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={48} />
          <YAxis width={48} domain={[0, 21000000]} ticks={[0, 7000000, 14000000, 21000000]} tickFormatter={v => `${v / 1e6}M`} tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
          <ChartTooltip labelFormatter={label => fullDate(Number(label))} formatter={(value, name) => [`${amount(Number(value))} ${CURRENCY}`, name]} />
          <ReferenceLine y={21000000} stroke={colors.referenceLine} strokeDasharray="4 4" />
          {observedAt != null && Number.isFinite(observedAt) && <ReferenceLine x={observedAt} stroke={colors.referenceLine} strokeDasharray="3 4" label={{ value: 'Latest', position: observedAt > (lastTime ?? 0) - ((lastTime ?? 0) - (firstTime ?? 0)) * 0.05 ? 'insideBottomRight' : 'insideTopLeft', fill: colors.axis, fontSize: 12 }} />}
          {milestones.map((p, index) => <ReferenceLine key={p.halving} x={p.time} stroke={colors.referenceLine} strokeDasharray="3 5" label={index === 0 || p.time - milestones[index - 1].time > ((lastTime ?? 0) - (firstTime ?? 0)) * 0.1 ? { value: `Halving ${p.halving}`, position: p.time > (lastTime ?? 0) - ((lastTime ?? 0) - (firstTime ?? 0)) * 0.05 ? 'insideTopRight' : 'top', fill: colors.axis, fontSize: 12 } : undefined} />)}
          <Area dataKey="observed" name="Observed supply" type="linear" stroke={colors.gold} fill={colors.gold} fillOpacity={0.12} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
          <Line dataKey="projected" name="Projected supply" type="linear" stroke={colors.gold} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <ChartWatermark />
      <p className="text-caption text-muted mt-3">Solid: observed supply. Dashed: projected new issuance.</p>
      {!data?.projection && <p className="text-caption text-muted mt-2">Projection unavailable.</p>}
    </>}
    {error && <p role="status" className="text-caption text-warning mt-3">Supply could not refresh. Last received observations are shown when available.</p>}
  </CardBody></Card>;
}
