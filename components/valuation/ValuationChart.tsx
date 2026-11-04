'use client';

import { useRef } from 'react';
import { ChartWatermark } from '@/components/ChartWatermark';
import type { ReactNode } from 'react';
import { ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { valuationChartPoints } from '@/lib/valuation';
import { PanelShareControl } from '@/components/charts/PanelShareControl';

export interface ChartSeries { key: string; label: string; color: string; area?: boolean; stack?: boolean; dashed?: boolean }
export function ValuationChart({ title, description, data, series, format, loading, reference, controls, footer, domain, intervalDays = 1 }: {
  title: string; description: string; data: Array<{date: string; [key: string]: unknown}>;
  series: ChartSeries[]; format: (v: number) => string; loading: boolean;
  intervalDays?: 1 | 7;
  domain?: [number,number]; reference?: {value: number; label: string}; controls?: ReactNode; footer?: ReactNode;
}) {
  const { theme } = useTheme(); const c = getChartColors(theme);
  const panelRef = useRef<HTMLDivElement>(null);
  const ordered = [...data].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
  const plotted = valuationChartPoints(ordered, intervalDays);
  const latest = ordered.findLast(p=>series.some(s=>typeof p[s.key]==='number' && Number.isFinite(p[s.key])));
  const multiYear = ordered.length>1 && Date.parse(ordered.at(-1)!.date)-Date.parse(ordered[0].date)>365*86400000;
  const hasData = data.some(p => series.some(s => typeof p[s.key] === 'number' && Number.isFinite(p[s.key])));
  const csv = () => ordered.length ? { headers: ['Date (UTC)', ...series.map(s => s.label)], rows: ordered.map(p => [p.date, ...series.map(s => p[s.key] ?? '')]) } : null;
  return <div ref={panelRef} className="card card-static min-w-0 h-full"><div className="card-body flex flex-col h-full">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3"><h3 className="text-sm font-semibold text-primary">{title}</h3><div className="flex flex-wrap items-center gap-2">{controls}<PanelShareControl title={title} fileName={`zecblock-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`} csv={csv} panelRef={panelRef} disabled={loading || !hasData} /></div></div>
    <p className="text-xs text-muted leading-relaxed min-h-12 mb-5">{description}</p>
    <div className="mt-auto" role="img" aria-label={`${title}. ${description}`}>
      {loading ? <ChartSkeleton height={300} /> : !hasData ? <div className="h-[300px] flex items-center justify-center text-xs text-muted" role="status">No observations available for this period.</div> :
        <><ResponsiveContainer width="100%" height={300} initialDimension={{width:500,height:300}}><ComposedChart data={plotted} margin={{top:24,right:12,left:0,bottom:4}}>
          <CartesianGrid vertical={false} stroke={c.gridStroke} />
          <XAxis dataKey="date" minTickGap={65} tickFormatter={d => new Date(String(d)).toLocaleDateString('en-US',{month:'short',...(multiYear?{year:'numeric' as const}:{day:'numeric' as const}),timeZone:'UTC'})} tick={{fill:c.axis,fontSize:12}} axisLine={false} tickLine={false} />
          <YAxis domain={domain} width={64} tickFormatter={format} tick={{fill:c.axis,fontSize:12}} axisLine={false} tickLine={false} />
          <ChartTooltip itemStyle={{color:c.tooltipText}} labelFormatter={d => new Date(String(d)).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'})} formatter={(value, name) => [format(Number(value)),String(name)]} />
          <Legend wrapperStyle={{fontSize:12,paddingTop:12}} formatter={label => <span className="text-muted">{label}</span>} />
          {reference && <ReferenceLine y={reference.value} stroke={c.referenceLine} strokeDasharray="4 4" label={{value:reference.label,fill:c.axis,fontSize:12,position:'insideTopRight'}} />}
          {series.map(s => s.area ? <Area key={s.key} dataKey={s.key} name={s.label} stackId={s.stack?'age':undefined} stroke={s.color} fill={s.color} fillOpacity={s.stack?0.65:0.12} type="linear" isAnimationActive={false} connectNulls={false} /> : <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed?'5 4':undefined} dot={false} type="linear" isAnimationActive={false} connectNulls={false} />)}
        </ComposedChart></ResponsiveContainer><ChartWatermark /></>}
    </div>
    {!loading && latest && <p className="mt-3 text-caption text-muted">Latest observation · {new Date(latest.date).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'})} UTC</p>}
    {footer && <p className="mt-5 border-t border-cipher-border pt-4 text-caption text-muted leading-relaxed">{footer}</p>}
  </div></div>;
}
