'use client';
import { ChartWatermark } from '@/components/ChartWatermark';
import { ChartSkeleton } from '@/components/ui/Skeleton';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';
import { blockIntervals, blockAgeLabel } from '@/lib/network-overview';
import { Card, CardBody } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import type { RecentBlocksResponse } from './RecentBlocksTable';

export function BlockCadenceChart({ initialData, initialFetchedAt, chainHeight, now, targetSeconds }: {
  initialData: RecentBlocksResponse | null; initialFetchedAt: number; chainHeight?: number; now: number; targetSeconds: number | null;
}) {
  const { data, loading, error } = useApiQuery<RecentBlocksResponse>('/v1/network/blocks/recent-summary', { limit: 30 }, {
    refreshInterval: 60_000, initialData: initialData ?? undefined, initialFetchedAt,
  });
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  useEffect(() => {
    if (!wrapper.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.floor(entry.contentRect.width))));
    observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, []);
  const points = blockIntervals(data?.blocks ?? []);
  const last = points[points.length - 1];
  const lag = last && chainHeight != null ? Math.max(0, chainHeight - last.height) : 0;
  const values = points.flatMap(p => p.seconds == null ? [] : [p.seconds]);
  const min = Math.min(0, ...values);
  const max = Math.max(1, targetSeconds ?? 0, ...values) * 1.15;
  const y = (value: number) => 18 + (max - value) / (max - min) * 174;
  const plotWidth = width - 54;
  const step = plotWidth / Math.max(points.length, 1);

  return <Card className="h-full"><CardBody>
    <SectionHeader card label="Recent block intervals" actions={<Link href="/blocks" className="text-caption font-mono text-muted hover:text-primary">All blocks →</Link>} />
    <p className="text-caption text-muted mb-4">Individual intervals from block timestamps in the latest 30-block sample. {targetSeconds != null ? `Dashed line: ${targetSeconds}s target.` : 'Current target unavailable.'}</p>
    <div ref={wrapper} className="min-h-[240px]">
      {loading && !points.length ? <ChartSkeleton height={228} /> : !points.length ? <p role="status" className="py-20 text-sm text-muted text-center">{loading ? 'Loading block timestamps…' : 'Block interval data unavailable.'}</p> : <>
        <svg width="100%" height="228" viewBox={`0 0 ${width} 228`} role="group" aria-label="Recent block intervals; each bar links to its block" className="font-mono text-caption">
          {[0, Math.round(max), ...(min < 0 ? [min] : [])].map(tick => <g key={tick}>
            <line x1="46" x2={width - 8} y1={y(tick)} y2={y(tick)} className="stroke-cipher-border" />
            <text x="38" y={y(tick) + 4} textAnchor="end" className="fill-muted">{tick}</text>
          </g>)}
          {targetSeconds != null && <g><line x1="46" x2={width - 8} y1={y(targetSeconds)} y2={y(targetSeconds)} className="stroke-cipher-gold" strokeDasharray="3 4" />
          <text x="38" y={y(targetSeconds) + 4} textAnchor="end" className="fill-cipher-gold">{targetSeconds}</text></g>}
          {points.map((point, index) => <a key={point.height} href={`/block/${point.height}`} aria-label={`Block ${point.height}: ${point.seconds == null ? 'previous block missing from sample' : `${point.seconds} seconds since previous block`}`} className="cadence-link">
            <title>{`#${point.height.toLocaleString()} · ${point.seconds == null ? 'Interval unavailable' : `${point.seconds}s`}`}</title>
            {point.seconds != null && <rect x={46 + index * step + 1} y={point.seconds == null ? y(0) - 2 : Math.min(y(0), y(point.seconds))}
              width={Math.max(1, step - 3)} height={point.seconds == null || point.seconds === 0 ? 2 : Math.abs(y(point.seconds) - y(0))}
              className={point.seconds == null ? 'fill-cipher-border' : point.seconds < 0 ? 'fill-warning' : index === points.length - 1 ? 'fill-cipher-gold' : 'fill-muted'} />}
          </a>)}
          <text x="46" y="220" className="fill-muted">#{points[0].height.toLocaleString()}</text>
          <text x={width - 8} y="220" textAnchor="end" className="fill-muted">#{last.height.toLocaleString()}</text>
        </svg>
        <p className="text-caption text-muted mt-2">{values.length} observed intervals · newest sampled block {blockAgeLabel(last.timestamp, now)}</p>
      </>}
    </div>
    {lag > 0 && <p role="status" className="text-caption text-warning mt-3">Sample is {lag.toLocaleString()} blocks behind the network summary.</p>}
    {error && <p role="status" className="text-caption text-warning mt-3">Block sample could not refresh. Last received data is shown when available.</p>}
    {points.some(p => p.seconds == null || p.seconds < 0) && <p className="text-caption text-muted mt-3">Missing predecessors leave gaps. Negative intervals reflect non-monotonic block timestamps.</p>}
  <ChartWatermark /></CardBody></Card>;
}
