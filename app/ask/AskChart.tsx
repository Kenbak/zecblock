'use client';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { formatChain } from '@/lib/ask/data';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors, getChartTooltipStyle } from '@/lib/chart-theme';
import { formatValue, type Evidence, type EvidencePoint } from '@/lib/ask/evidence';

export default function AskChart({ points, evidence, view }: { points: EvidencePoint[]; evidence: Evidence; view: 'line' | 'bar' }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const ranking = evidence.dimension === 'chain';
  // Missing source dates are visible gaps, never zero or interpolated values.
  const byDate = new Map(points.map(point => [point.date, point]));
  const daily = ranking ? points.slice(0, 10) : [];
  for (let day = Date.parse(points[0].date); !ranking && day <= Date.parse(points[points.length - 1].date); day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    daily.push(byDate.get(date) || { date, values: Object.fromEntries(evidence.series.map(series => [series.key, null])) });
  }
  const data = daily.map(point => ({ date: point.date, ...Object.fromEntries(evidence.series.map(series => [series.key, point.values[series.key] === null ? null : Number(point.values[series.key]) / (evidence.unit === 'ZEC' ? 1e8 : evidence.unit === 'USD' || evidence.unit === '%' ? 100 : 1)])) }));
  return <div role="img" aria-label={`${evidence.unit} by ${ranking ? 'chain, top ten' : 'day'}; observations are available in the Table view.`} className="h-72 sm:h-80 w-full min-w-0">
    <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 320 }}>
      <ComposedChart layout={ranking ? 'vertical' : 'horizontal'} data={data} margin={{ top: 16, right: 12, bottom: 8, left: 0 }}>
        <CartesianGrid vertical={false} stroke={colors.gridStroke} />
        {ranking ? <>
          <XAxis type="number" tickLine={false} axisLine={false} tick={{ fill: colors.axis, fontSize: 12 }} tickFormatter={value => Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)} />
          <YAxis type="category" dataKey="date" width={90} tickLine={false} axisLine={false} interval={0} tick={{ fill: colors.axis, fontSize: 12 }} tickFormatter={formatChain} />
        </> : <>
          <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: colors.axis, fontSize: 12 }} minTickGap={45} tickFormatter={date => String(date).slice(5)} />
          <YAxis domain={evidence.unit === '%' ? [0, 100] : undefined} allowDecimals={['ZEC', 'USD', '%'].includes(evidence.unit)} tickLine={false} axisLine={false} width={60} tick={{ fill: colors.axis, fontSize: 12 }} tickFormatter={value => `${Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)}${evidence.unit === '%' ? '%' : ''}`} />
        </>}
        <ChartTooltip content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null;
          const point = points.find(row => row.date === label);
          return <div style={getChartTooltipStyle(colors)}><p className="mb-2">{ranking ? formatChain(String(label)) : `${String(label)} · UTC`}</p>{evidence.series.map(series => <p key={series.key}>{series.label}: {formatValue(point?.values[series.key] ?? null, evidence.unit)} {evidence.unit}</p>)}</div>;
        }} />
        {evidence.series.map(series => view === 'bar'
          ? <Bar key={series.key} dataKey={series.key} name={series.label} fill={colors[series.color as keyof typeof colors]} maxBarSize={12} isAnimationActive={false} />
          : <Line key={series.key} type="linear" dataKey={series.key} name={series.label} stroke={colors[series.color as keyof typeof colors]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />)}
      </ComposedChart>
    </ResponsiveContainer>
  </div>;
}
