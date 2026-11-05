'use client';

import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from '@/components/charts/ChartTooltip';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';

interface DailyRate { date: string; canonicalBlocks: number; orphanedBlocks: number; rate: number | null; partial: boolean }
type EventKind = 'capture' | 'observers' | 'nu7';
interface RateEvent { at: string; kind: EventKind; label: string }
interface DailyRates { days: DailyRate[]; events: RateEvent[]; asOf: string }

const DAYS = 60;
const MARKER_TEXT: Record<EventKind, string> = { capture: 'Capture began', observers: 'More observers', nu7: 'NU7' };

function shortDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function pct(rate: number | null) {
  if (rate === null) return 'No rate';
  return rate > 0 && rate < 0.0001 ? '<0.01%' : `${(rate * 100).toFixed(2)}%`;
}

/** In-plot marker labels collide on narrow screens; the legend names the markers there. */
function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 640px)');
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

/** Daily observed orphan rate with dated coverage and NU7 markers. */
export function OrphanRateDailyChart() {
  const wide = useWide();
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const { data, loading } = useApiQuery<DailyRates>(`/v1/mining/orphan-rates/daily?days=${DAYS}`, undefined, { refreshInterval: 300_000 });
  if (loading && !data) return <div className="h-56 mb-6" role="status" aria-label="Loading daily orphan rate" />;
  if (!data?.days?.length) return null;

  const points = data.days.map(day => ({ ...day, percent: day.rate === null ? null : day.rate * 100 }));
  const eventsByDay = new Map<string, RateEvent[]>();
  for (const event of data.events ?? []) {
    const day = event.at.slice(0, 10);
    eventsByDay.set(day, [...(eventsByDay.get(day) ?? []), event]);
  }
  const markerColor = (kind: EventKind) => (kind === 'nu7' ? colors.gold : colors.axis);
  const first = points.find(p => p.rate !== null);

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h3 className="text-caption font-mono uppercase text-muted">Daily observed rate · last {DAYS} days</h3>
        <div className="flex flex-wrap gap-3 text-caption text-muted" aria-hidden>
          {[...new Set((data.events ?? []).map(e => e.kind))].map(kind => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <svg width="16" height="10"><line x1="0" x2="16" y1="5" y2="5" stroke={markerColor(kind)} strokeWidth="2" strokeDasharray={kind === 'nu7' ? undefined : '4 3'} /></svg>
              {MARKER_TEXT[kind]}
            </span>
          ))}
        </div>
      </div>
      <div className="h-56" role="img" aria-label={`Daily observed orphan rate for the last ${DAYS} UTC days${first ? `, from ${shortDate(first.date)}` : ''}. Markers show when capture began, when observer coverage expanded and NU7 activation.`}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 800, height: 224 }}>
          <BarChart data={points} margin={{ top: 18, right: 4, left: 0, bottom: 0 }} barCategoryGap={2}>
            <CartesianGrid vertical={false} stroke={colors.grid} strokeDasharray="3 5" />
            <XAxis dataKey="date" minTickGap={55} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: colors.axis }} tickFormatter={shortDate} />
            <YAxis width={46} tickLine={false} axisLine={false} allowDecimals tick={{ fontSize: 12, fill: colors.axis }} tickFormatter={v => `${Number(v).toFixed(1)}%`} />
            <ChartTooltip
              itemStyle={{ color: colors.tooltipText }}
              separator=": "
              labelFormatter={label => {
                const day = points.find(p => p.date === label);
                const events = eventsByDay.get(String(label)) ?? [];
                return <>
                  <span>{shortDate(String(label))} UTC{day?.partial ? ' · so far today' : ''}</span>
                  {events.map(e => <span key={e.kind} className="block text-caption text-muted">{e.label}</span>)}
                </>;
              }}
              formatter={(_value, _name, item) => {
                const day = item.payload as DailyRate;
                return [`${pct(day.rate)} (${day.orphanedBlocks.toLocaleString()} orphans, ${day.canonicalBlocks.toLocaleString()} blocks)`, 'Orphan rate'];
              }}
            />
            {[...eventsByDay].map(([day, events]) => {
              const kind = events.some(e => e.kind === 'nu7') ? 'nu7' : events[0].kind;
              // Labels near the right edge read leftwards so they are not clipped.
              const nearEnd = points.findIndex(p => p.date === day) > points.length * 0.75;
              return <ReferenceLine key={day} x={day} stroke={markerColor(kind)} strokeWidth={kind === 'nu7' ? 2 : 1.5}
                strokeDasharray={kind === 'nu7' ? undefined : '3 3'} ifOverflow="extendDomain"
                label={wide ? { value: events.map(e => MARKER_TEXT[e.kind]).join(' · '), position: nearEnd ? 'insideTopRight' : 'insideTopLeft', fontSize: 12, fill: colors.axis, dy: -16, dx: nearEnd ? -4 : 4 } : undefined} />;
            })}
            <Bar dataKey="percent" isAnimationActive={false} radius={[3, 3, 0, 0]} maxBarSize={14}>
              {points.map(p => <Cell key={p.date} fill={colors.transparent} fillOpacity={p.partial ? 0.45 : 0.85} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-caption text-muted mt-1">Faded bar = today so far. Observer coverage grew from 1 to 10 nodes on 5 Nov, shortly before NU7, so part of any change after that date comes from seeing more competing blocks.</p>
    </div>
  );
}
