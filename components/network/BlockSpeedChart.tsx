'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatDay, formatSeconds, formatWait, SPENDABLE_CONFIRMATIONS, type SpeedActivation, type SpeedPoint } from '@/lib/block-speed';

const LEFT = 40;
const RIGHT = 8;
const BOTTOM = 24;
const TOP = 30;

export type SpeedMetric = 'wait' | 'blocks';

function niceStep(max: number, metric: SpeedMetric) {
  const steps = metric === 'wait' ? [1, 2, 5, 10, 15, 20] : [250, 500, 1000, 2000, 2500, 5000];
  return steps.find(step => max / step <= 4) ?? Math.ceil(max / 4 / 10) * 10;
}

const totalMinutes = (point: SpeedPoint) => point.averageSeconds * SPENDABLE_CONFIRMATIONS / 60;
const DAY_SECONDS = 86_400;
const tickLabel = (value: number, metric: SpeedMetric) => metric === 'wait' ? `${value}m` : value >= 1000 ? `${value / 1000}k` : String(value);

function barClass(point: SpeedPoint, first: boolean) {
  if (point.kind === 'projected') return first ? 'fill-none stroke-cipher-gold' : 'fill-none stroke-muted';
  return `${first ? 'fill-cipher-gold' : 'fill-muted'}${point.kind === 'irregular' ? ' opacity-30' : ''}`;
}

/** Block counts colour the NU7 era gold so the step up reads at a glance. */
function countClass(point: SpeedPoint) {
  if (point.kind === 'projected') return point.nu7 ? 'fill-none stroke-cipher-gold' : 'fill-none stroke-muted';
  return `${point.nu7 ? 'fill-cipher-gold' : 'fill-muted'}${point.kind === 'irregular' ? ' opacity-30' : ''}`;
}

const soFar = (point: SpeedPoint) => point.inProgress ? ' so far today' : '';

function era(point: SpeedPoint) {
  if (point.kind === 'irregular') return ' · minimum-difficulty era';
  if (point.segment === 'before-nu7') return ' · before NU7 activation';
  return point.nu7 ? ' · NU7' : '';
}

/** Points sharing a UTC day: an activation day has one point for each side of NU7. */
type Column = { key: string; date: string; parts: SpeedPoint[] };

function describeColumn(column: Column, metric: SpeedMetric) {
  if (metric === 'wait' || column.parts.length === 1) return describe(column.parts[0], metric);
  const [before, after] = column.parts;
  return `${formatDay(column.date)} · ${before.blocks.toLocaleString('en-US')} blocks before NU7 + ${after.blocks.toLocaleString('en-US')} with NU7${soFar(after)}`;
}

function describe(point: SpeedPoint, metric: SpeedMetric = 'wait') {
  if (metric === 'blocks') {
    return point.kind === 'projected'
      ? `${formatDay(point.date)} · projected ${point.blocks.toLocaleString('en-US')} blocks at the ${point.targetSeconds}s target`
      : `${formatDay(point.date)}${era(point)} · ${point.blocks.toLocaleString('en-US')} blocks${soFar(point)}`;
  }
  const waits = `first confirmation ${formatWait(point.averageSeconds)} · ${SPENDABLE_CONFIRMATIONS} confirmations ${formatWait(point.averageSeconds * SPENDABLE_CONFIRMATIONS)}`;
  if (point.kind === 'projected') return `${formatDay(point.date)} · projected at the ${point.targetSeconds}s block target · ${waits}`;
  return `${formatDay(point.date)}${era(point)} · average block ${formatSeconds(point.averageSeconds)}${soFar(point)} · ${waits}`;
}

/** Consecutive columns sharing a target, so each era draws its own target line. */
function targetSegments(columns: Column[]) {
  const segments: { target: number; from: number; to: number }[] = [];
  columns.forEach((column, index) => {
    const last = segments.at(-1);
    const target = column.parts.at(-1)!.targetSeconds;
    if (target == null) return;
    if (last && last.target === target && last.to === index - 1) last.to = index;
    else segments.push({ target, from: index, to: index });
  });
  return segments;
}

/** One column per point for waits; blocks per day stack an activation day's two sides into one bar. */
function columnsFor(points: SpeedPoint[], metric: SpeedMetric): Column[] {
  const columns: Column[] = [];
  for (const point of points) {
    const last = columns.at(-1);
    if (metric === 'blocks' && last && last.date === point.date && point.segment && last.parts[0].segment) last.parts.push(point);
    else columns.push({ key: point.key, date: point.date, parts: [point] });
  }
  return columns;
}

/**
 * `wait`: first confirmation plus the remaining blocks, stacked to the wallet's
 * total confirmation depth. `blocks`: blocks mined per UTC day.
 */
export function BlockSpeedChart({ points, activation, height = 260, metric = 'wait' }: { points: SpeedPoint[]; activation: SpeedActivation | null; height?: number; metric?: SpeedMetric }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (!wrapper.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))));
    observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, []);
  if (!points.length) return <p role="status" className="py-16 text-center text-sm text-muted">Daily block observations are unavailable.</p>;

  const narrow = width < 520;
  const columns = columnsFor(points, metric);
  const segments = targetSegments(columns);
  const columnValue = (column: Column) => metric === 'wait' ? totalMinutes(column.parts[0]) : column.parts.reduce((sum, part) => sum + part.blocks, 0);
  const targetValue = (target: number) => metric === 'wait' ? target * SPENDABLE_CONFIRMATIONS / 60 : DAY_SECONDS / target;
  // Testnet's minimum-difficulty days ran at up to ~6× any target; scale to the
  // comparable days and clip those bars so the NU7 step stays readable.
  const scaled = metric === 'blocks' && columns.some(column => column.parts[0].kind !== 'irregular')
    ? columns.filter(column => column.parts[0].kind !== 'irregular') : columns;
  const peak = Math.max(...scaled.map(columnValue), ...segments.map(segment => targetValue(segment.target)));
  const step = niceStep(peak, metric);
  const max = Math.ceil(peak * 1.1 / step) * step;
  const plotHeight = height - TOP - BOTTOM;
  const y = (value: number) => TOP + plotHeight - value / max * plotHeight;
  const slot = (width - LEFT - RIGHT) / columns.length;
  const barWidth = Math.max(2, slot * (narrow ? 0.7 : 0.72));
  const left = (index: number) => LEFT + index * slot + (slot - barWidth) / 2;
  const edge = (index: number) => LEFT + index * slot;
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const nu7Index = columns.findIndex(column => column.parts.some(part => part.nu7));
  const todayIndex = columns.findIndex(column => column.parts[0].kind === 'projected');
  const nu7Label = 'NU7';
  const labelFits = (index: number, label: string) => edge(index) + 5 + label.length * 7 < width - RIGHT;
  const hasProjections = points.some(point => point.kind === 'projected');
  const hasIrregular = points.some(point => point.kind === 'irregular');
  const hasInProgress = points.some(point => point.inProgress);
  const dateLabels = [0, ...(nu7Index > 0 && !narrow ? [nu7Index] : []), columns.length - 1]
    .filter((index, i, all) => i === 0 || edge(index) - edge(all[i - 1]) > 64);

  return <div ref={wrapper}>
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="group" className="font-mono text-caption"
      aria-label={metric === 'wait'
        ? `Daily confirmation waits in minutes: first confirmation and ${SPENDABLE_CONFIRMATIONS} confirmations total, ${formatDay(points[0].date)} to ${formatDay(points.at(-1)!.date)}`
        : `Blocks mined per UTC day, ${formatDay(points[0].date)} to ${formatDay(points.at(-1)!.date)}`}>
      {ticks.map(tick => <g key={tick}>
        <line x1={LEFT} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} className="stroke-cipher-border" />
        <text x={LEFT - 8} y={y(tick) + 4} textAnchor="end" className="fill-muted">{tickLabel(tick, metric)}</text>
      </g>)}
      <g key={metric}>{columns.map((column, index) => {
        const style = { '--bar-index': index } as CSSProperties;
        const point = column.parts[0];
        const label = describeColumn(column, metric);
        const faded = column.parts.some(part => part.inProgress) ? 'opacity-50' : undefined;
        const lastHeight = column.parts.at(-1)!.lastHeight;
        let body;
        if (metric === 'blocks') {
          const total = columnValue(column);
          const clipped = total > max;
          let base = 0;
          body = <>
            <title>{label}</title>
            <g className={faded}>{column.parts.map(part => {
              const from = base; base += part.blocks;
              const top = y(Math.min(base, max)); const bottom = y(Math.min(from, max));
              return <rect key={part.key} x={left(index)} y={top} width={barWidth} height={Math.max(0, bottom - top)} rx={1.5} className={`speed-bar ${countClass(part)}`} style={style}
                strokeDasharray={part.kind === 'projected' ? '3 2' : undefined} data-day-segment={part.segment} />;
            })}</g>
            {clipped && <path d={`M${left(index)} ${y(max) + 7}l${barWidth / 2} -3l${barWidth / 2} 3`} className="stroke-cipher-bg" strokeWidth={2} fill="none" data-clipped="true" />}
          </>;
        } else {
          const top = y(totalMinutes(point));
          const split = y(point.averageSeconds / 60);
          body = <>
            <title>{label}</title>
            <g className={`speed-bar${faded ? ` ${faded}` : ''}`} style={style} data-day-segment={point.segment}>
              <rect data-confirmation-segment="remaining" x={left(index)} y={top} width={barWidth} height={Math.max(0, split - top)} rx={1.5} className={barClass(point, false)}
                strokeDasharray={point.kind === 'projected' ? '3 2' : undefined} />
              <rect data-confirmation-segment="first" x={left(index)} y={split} width={barWidth} height={Math.max(0, y(0) - split)} rx={1.5} className={barClass(point, true)}
                strokeDasharray={point.kind === 'projected' ? '3 2' : undefined} />
            </g>
          </>;
        }
        return lastHeight != null
          ? <a key={column.key} href={`/block/${lastHeight}`} aria-label={label} className="cadence-link">{body}</a>
          : <g key={column.key}>{body}</g>;
      })}</g>
      {segments.map(segment => {
        const label = narrow ? `${segment.target}s` : `${segment.target}s blocks`;
        const labelWidth = label.length * 7 + 12;
        const level = y(targetValue(segment.target));
        const x1 = edge(segment.from); const x2 = edge(segment.to + 1);
        const tallest = y(Math.max(...columns.slice(segment.from, segment.to + 1).map(columnValue)));
        const labelAtToday = todayIndex >= segment.from && todayIndex <= segment.to
          && x2 - edge(todayIndex) > labelWidth;
        return <g key={`${segment.from}-${segment.target}`} pointerEvents="none">
          <line x1={x1} x2={x2} y1={level} y2={level} className="stroke-secondary" strokeDasharray="2 4" />
          {x2 - x1 > labelWidth && <text x={labelAtToday ? edge(todayIndex) + 6 : x2 - 4} y={Math.min(level, tallest) - 6} textAnchor={labelAtToday ? 'start' : 'end'} className="fill-secondary">{label}</text>}
        </g>;
      })}
      {todayIndex > 0 && todayIndex !== nu7Index && <g>
        <line x1={edge(todayIndex)} x2={edge(todayIndex)} y1={TOP - 10} y2={y(0)} className="stroke-muted" />
        <text x={edge(todayIndex) + 5} y={TOP - 14} className="fill-muted">Today</text>
      </g>}
      {nu7Index > 0 && <g>
        <title>{activation?.status === 'active' ? 'NU7 activation' : activation?.status === 'announced' ? 'Announced NU7 activation' : 'Estimated NU7 activation'}</title>
        <line x1={edge(nu7Index)} x2={edge(nu7Index)} y1={TOP - 10} y2={y(0)} className="stroke-cipher-gold" strokeDasharray="3 4" />
        <text x={edge(nu7Index) + (labelFits(nu7Index, nu7Label) ? 5 : -5)} y={TOP - 14} textAnchor={labelFits(nu7Index, nu7Label) ? 'start' : 'end'} className="fill-cipher-gold">{nu7Label}</text>
      </g>}
      {dateLabels.map((index, i) => <text key={index} x={i === dateLabels.length - 1 ? width - RIGHT : edge(index)} y={height - 6}
        textAnchor={i === dateLabels.length - 1 ? 'end' : 'start'} className="fill-muted">{formatDay(columns[index].date)}</text>)}
    </svg>
    <div className="grid grid-cols-1 gap-2 mt-3 text-caption text-muted sm:flex sm:flex-wrap sm:gap-x-5">
      {metric === 'wait' ? <>
        <Legend swatch="bg-cipher-gold">First confirmation</Legend>
        <Legend swatch="bg-muted">{SPENDABLE_CONFIRMATIONS - 1} more confirmations</Legend>
      </> : <>
        {points.some(point => !point.nu7 && point.kind !== 'irregular') && <Legend swatch="bg-muted">Before NU7</Legend>}
        <Legend swatch="bg-cipher-gold">With NU7</Legend>
      </>}
      {hasInProgress && <Legend swatch="bg-muted opacity-50">Today so far</Legend>}
      {hasProjections && <Legend swatch="border border-dashed border-secondary">Target projection</Legend>}
      {hasIrregular && <Legend swatch="bg-muted opacity-30">Earlier testnet · irregular</Legend>}
    </div>
  </div>;
}

function Legend({ swatch, children }: { swatch: string; children: ReactNode }) {
  return <span className="flex items-center gap-2"><span aria-hidden="true" className={`w-2.5 h-2.5 rounded-sm ${swatch}`} />{children}</span>;
}
