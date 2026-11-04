'use client';

import { useState, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { ChartTooltip as Tooltip } from '@/components/charts/ChartTooltip';
import { ChartWatermark } from '@/components/ChartWatermark';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { useUrlState } from '@/lib/use-url-state';
import { PanelShareControl, objectRowsCsv } from '@/components/charts/PanelShareControl';

const BLOCK_TIME_PERIODS = ['6h', '24h', '7d'];

type Point = { height: number; timestamp: number; averageSeconds: number | null; intervalSeconds: number | null; targetSeconds: number | null };
type Response = { success: boolean; period: string; points: Point[]; rollingIntervals: number; truncated: boolean; observedAt: string;
  nodeHeight: number; indexedHeight: number | null; schedule: { nu7Height: number | null } | null };

export function BlockTimeChart() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const panelRef = useRef<HTMLDivElement>(null);
  const [period, setPeriod] = useUrlState('interval', '24h', BLOCK_TIME_PERIODS);
  const [individual, setIndividual] = useState(false);
  const { data, loading, error } = useApiQuery<Response>('/v1/network/block-time', { period }, { refreshInterval: 15_000 });
  const points = data?.period === period ? data.points : [];
  const latest = points.at(-1);
  const activation = data?.schedule?.nu7Height;
  const showActivation = activation != null && points.length > 0 && activation >= points[0].height && activation <= points[points.length - 1].height;
  return <div ref={panelRef}><Card className="card-static p-4 sm:p-6"><CardBody><SectionHeader label="BLOCK_INTERVAL" className="max-sm:flex-col max-sm:items-stretch" actions={<div className="flex gap-2 max-sm:mt-2" aria-label="Average block interval period">
    <PanelShareControl title={`Zcash average block interval (${period})`} fileName={`zecblock-block-interval-${period}`} csv={() => objectRowsCsv(points)} panelRef={panelRef} disabled={!points.length} />
    {BLOCK_TIME_PERIODS.map(value => <button key={value} type="button" aria-pressed={period === value}
      className={`filter-btn ${period === value ? 'filter-btn-active' : ''}`}
      onClick={() => setPeriod(value)}>{value}</button>)}
  </div>} />
    <p className="text-caption text-muted mb-4">{latest?.averageSeconds != null ? `${latest.averageSeconds.toFixed(1)}s observed` : 'Observed average unavailable'}
      {' · '}{latest?.targetSeconds != null ? `${latest.targetSeconds}s target` : 'Target unavailable'}</p>
    {points.length ? <ResponsiveContainer width="100%" height={270} initialDimension={{ width: 400, height: 270 }}>
      <LineChart data={points} margin={{ top: 12, right: 40, bottom: 12, left: 0 }}>
        <CartesianGrid vertical={false} stroke={colors.grid} />
        <XAxis dataKey="height" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => Number(v).toLocaleString()} minTickGap={55} padding={{ left: 16, right: 32 }} tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
        <YAxis width={48} unit="s" tick={{ fill: colors.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
        <Tooltip labelFormatter={height => `Block ${Number(height).toLocaleString()}`}
          formatter={(value, name) => [value == null ? 'Unavailable' : `${Number(value).toFixed(1)}s`, name]} />
        {individual && <Line dataKey="intervalSeconds" name="Sampled block interval (s)" stroke={colors.transparent} dot={false} strokeWidth={1} isAnimationActive={false} connectNulls={false} />}
        <Line dataKey="averageSeconds" name="120-interval average (s)" stroke={colors.gold} dot={false} strokeWidth={2} isAnimationActive={false} connectNulls={false} />
        <Line dataKey="targetSeconds" name="Consensus target (s)" type="stepAfter" stroke={colors.axis} strokeDasharray="5 5" dot={false} isAnimationActive={false} connectNulls={false} />
        {showActivation && <ReferenceLine x={activation} stroke={colors.gold} label="NU7" />}
      </LineChart>
    </ResponsiveContainer> : loading ? <ChartSkeleton height={270} /> : <p role="status" className="py-20 text-center text-muted">{loading ? 'Loading block intervals…' : 'Block time observations unavailable.'}</p>}
    <label className="flex items-center gap-2 text-caption text-muted mb-3"><input className="accent-cipher-gold" type="checkbox" checked={individual} onChange={event => setIndividual(event.target.checked)} />Show sampled individual intervals</label>
    <p className="text-caption text-muted">Average over 120 consecutive block-header intervals. Header timestamps can move backwards. Heights are shown on the horizontal axis.</p>
    {data?.truncated && <p role="status" className="text-caption text-warning mt-2">Showing the latest bounded sample; earlier observations in this period are omitted.</p>}
    {(error || (data?.indexedHeight != null && data.nodeHeight > data.indexedHeight)) && <p role="status" className="text-caption text-warning mt-2">{error ? 'Refresh unavailable. Any displayed observations are from the previous response.' : `Sample is ${data!.nodeHeight - data!.indexedHeight!} blocks behind the node.`}</p>}
    <ChartWatermark />
  </CardBody></Card></div>;
}
