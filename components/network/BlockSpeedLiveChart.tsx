'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { formatSeconds, ROLLING_BLOCKS, type LiveBlock } from '@/lib/block-speed';

const LEFT = 40;
const RIGHT = 8;
const BOTTOM = 24;
const TOP = 30;
/** Narrowest bar slot; the window shows as many recent blocks as fit. */
const MIN_SLOT = 6;
const MIN_BLOCKS = 40;
/** Single gaps are exponential; above this multiple of the target they are clipped. */
export const CLIP_TARGETS = 4;
/** The reveal spreads over this many bar steps however many bars are shown. */
const REVEAL_STEPS = 40;

const height = (value: number) => `#${value.toLocaleString('en-US')}`;
const tickLabel = (seconds: number) => seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;

function niceStep(max: number) {
  return [5, 10, 15, 30, 60, 120].find(step => max / step <= 5) ?? 300;
}

/** Consecutive blocks sharing a target, so each era draws its own target line. */
function targetSegments(blocks: LiveBlock[]) {
  const segments: { target: number; from: number; to: number }[] = [];
  blocks.forEach((block, index) => {
    const last = segments.at(-1);
    if (block.targetSeconds == null) return;
    if (last && last.target === block.targetSeconds && last.to === index - 1) last.to = index;
    else segments.push({ target: block.targetSeconds, from: index, to: index });
  });
  return segments;
}

function describe(block: LiveBlock, nu7: boolean) {
  const gap = block.intervalSeconds == null ? 'gap unavailable' : `${formatSeconds(block.intervalSeconds)} after the previous block`;
  const rolling = block.rollingSeconds == null ? '' : ` · last ${ROLLING_BLOCKS} averaged ${formatSeconds(Number(block.rollingSeconds.toFixed(1)))}`;
  return `Block ${height(block.height)}${nu7 ? ' · NU7' : ''} · ${gap}${block.targetSeconds != null ? ` · ${block.targetSeconds}s target` : ''}${rolling}`;
}

/**
 * One bar per canonical block: its header-time gap from the previous block,
 * with the rolling ROLLING_BLOCKS average as a line. Same axes, target lines
 * and NU7 marker as the daily chart; blocks from the NU7 height on are gold.
 */
export function BlockSpeedLiveChart({ blocks, nu7Height, height: chartHeight = 260 }: { blocks: LiveBlock[]; nu7Height: number | null; height?: number }) {
  // A callback ref re-measures whenever the wrapper node itself changes.
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    if (!wrapper) return;
    const measure = (value: number) => { if (value > 0) setWidth(Math.max(200, Math.floor(value))); };
    measure(wrapper.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [wrapper]);

  const narrow = width < 520;
  const fits = Math.max(MIN_BLOCKS, Math.floor((width - LEFT - RIGHT) / MIN_SLOT));
  const shown = blocks.slice(-fits);
  return <div ref={setWrapper}>{shown.length < 2
    ? <p role="status" className="py-16 text-center text-sm text-muted">Recent blocks are unavailable.</p>
    : <Plot blocks={shown} nu7Height={nu7Height} width={width} height={chartHeight} narrow={narrow} />}
  </div>;
}

function Plot({ blocks, nu7Height, width, height: chartHeight, narrow }: { blocks: LiveBlock[]; nu7Height: number | null; width: number; height: number; narrow: boolean }) {
  const isNu7 = (block: LiveBlock) => nu7Height != null && block.height >= nu7Height;
  const segments = targetSegments(blocks);
  const topTarget = Math.max(0, ...segments.map(segment => segment.target));
  const gaps = blocks.flatMap(block => block.intervalSeconds == null ? [] : [Math.max(0, block.intervalSeconds)]);
  const rolling = blocks.flatMap(block => block.rollingSeconds == null ? [] : [block.rollingSeconds]);
  const cap = topTarget ? topTarget * CLIP_TARGETS : Infinity;
  const peak = Math.max(1, topTarget, ...rolling, Math.min(cap, Math.max(0, ...gaps)));
  // Clipped gaps reach the top exactly; otherwise leave headroom above the tallest bar.
  const ceiling = peak >= cap ? peak : peak * 1.1;
  const step = niceStep(ceiling);
  const max = Math.ceil(ceiling / step) * step;
  const plotHeight = chartHeight - TOP - BOTTOM;
  const y = (value: number) => TOP + plotHeight - Math.min(Math.max(value, 0), max) / max * plotHeight;
  const slot = (width - LEFT - RIGHT) / blocks.length;
  const barWidth = Math.max(1, slot * 0.72);
  const left = (index: number) => LEFT + index * slot + (slot - barWidth) / 2;
  const edge = (index: number) => LEFT + index * slot;
  const center = (index: number) => LEFT + (index + 0.5) * slot;
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const nu7Index = nu7Height == null ? -1 : blocks.findIndex(block => block.height === nu7Height);
  const latest = blocks.at(-1)!;
  const toActivation = nu7Height != null && nu7Index < 0 && latest.height < nu7Height ? nu7Height - latest.height : null;
  const labelFits = (index: number, label: string) => edge(index) + 5 + label.length * 7 < width - RIGHT;
  const line = blocks.map((block, index) => block.rollingSeconds == null ? null : `${center(index).toFixed(1)} ${y(block.rollingSeconds).toFixed(1)}`)
    .reduce<string[]>((paths, point, index, all) => {
      if (point == null) return paths;
      paths.push(`${all[index - 1] == null ? 'M' : 'L'}${point}`);
      return paths;
    }, []).join(' ');
  const heightLabels = [0, ...(nu7Index > 0 && !narrow ? [nu7Index] : []), blocks.length - 1]
    .filter((index, i, all) => i === 0 || edge(index) - edge(all[i - 1]) > 96);
  const hasBefore = blocks.some(block => !isNu7(block));
  const hasNu7 = blocks.some(isNu7);

  return <>
    <svg width="100%" height={chartHeight} viewBox={`0 0 ${width} ${chartHeight}`} role="group" className="font-mono text-caption"
      aria-label={`Seconds between consecutive blocks, ${height(blocks[0].height)} to ${height(latest.height)}, with the ${ROLLING_BLOCKS}-block average`}>
      {ticks.map(tick => <g key={tick}>
        <line x1={LEFT} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} className="stroke-cipher-border" />
        <text x={LEFT - 8} y={y(tick) + 4} textAnchor="end" className="fill-muted">{tickLabel(tick)}</text>
      </g>)}
      <g>{blocks.map((block, index) => {
        if (block.intervalSeconds == null) return null;
        const nu7 = isNu7(block);
        const clipped = block.intervalSeconds > max;
        const top = y(block.intervalSeconds);
        const style = { '--bar-index': Math.round(index / blocks.length * REVEAL_STEPS) } as CSSProperties;
        return <a key={block.height} href={`/block/${block.height}`} aria-label={describe(block, nu7)} className="cadence-link">
          <title>{describe(block, nu7)}</title>
          <rect x={left(index)} y={top} width={barWidth} height={Math.max(block.intervalSeconds > 0 ? 1 : 0, y(0) - top)} rx={barWidth > 3 ? 1 : 0}
            className={`speed-bar ${nu7 ? 'fill-cipher-gold' : 'fill-muted'}`} style={style} data-live-block={block.height} />
          {clipped && barWidth >= 3 && <path d={`M${left(index)} ${top + 7}l${barWidth / 2} -3l${barWidth / 2} 3`} className="stroke-cipher-bg" strokeWidth={2} fill="none" data-clipped="true" />}
        </a>;
      })}</g>
      {line && <path d={line} fill="none" className="stroke-primary" strokeWidth={1.5} strokeLinejoin="round" pointerEvents="none" data-rolling-average="true" />}
      {segments.map(segment => {
        const label = narrow ? `${segment.target}s` : `${segment.target}s blocks`;
        const labelWidth = label.length * 7 + 12;
        const level = y(segment.target);
        const x1 = edge(segment.from); const x2 = edge(segment.to + 1);
        return <g key={`${segment.from}-${segment.target}`} pointerEvents="none">
          <line x1={x1} x2={x2} y1={level} y2={level} className="stroke-secondary" strokeDasharray="2 4" />
          {x2 - x1 > labelWidth && <text x={x2 - 4} y={level - 6} textAnchor="end" className="fill-secondary stroke-cipher-bg" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">{label}</text>}
        </g>;
      })}
      {nu7Index > 0 && <g pointerEvents="none">
        <line x1={edge(nu7Index)} x2={edge(nu7Index)} y1={TOP - 10} y2={y(0)} className="stroke-cipher-gold" strokeDasharray="3 4" />
        <text x={edge(nu7Index) + (labelFits(nu7Index, 'NU7') ? 5 : -5)} y={TOP - 14} textAnchor={labelFits(nu7Index, 'NU7') ? 'start' : 'end'} className="fill-cipher-gold">NU7</text>
      </g>}
      {toActivation != null && <text x={width - RIGHT} y={TOP - 14} textAnchor="end" className="fill-cipher-gold">
        NU7 in {toActivation.toLocaleString('en-US')} block{toActivation === 1 ? '' : 's'} →
      </text>}
      {heightLabels.map((index, i) => <text key={index} x={i === heightLabels.length - 1 ? width - RIGHT : edge(index)} y={chartHeight - 6}
        textAnchor={i === heightLabels.length - 1 ? 'end' : 'start'} className="fill-muted">{height(blocks[index].height)}</text>)}
    </svg>
    <div className="grid grid-cols-1 gap-2 mt-3 text-caption text-muted sm:flex sm:flex-wrap sm:gap-x-5">
      {hasBefore && <Legend swatch="h-2.5 rounded-sm bg-muted">{hasNu7 ? 'Before NU7' : 'Block gap'}</Legend>}
      {hasNu7 && <Legend swatch="h-2.5 rounded-sm bg-cipher-gold">With NU7</Legend>}
      <Legend swatch="h-0.5 bg-primary">{ROLLING_BLOCKS}-block average</Legend>
      <Legend swatch="h-0 border-t border-dashed border-secondary">Target</Legend>
    </div>
  </>;
}

function Legend({ swatch, children }: { swatch: string; children: ReactNode }) {
  return <span className="flex items-center gap-2"><span aria-hidden="true" className={`w-2.5 ${swatch}`} />{children}</span>;
}
