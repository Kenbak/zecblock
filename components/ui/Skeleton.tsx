import type { CSSProperties, ReactNode } from 'react';
import { MetricCard } from './MetricCard';

/** Decorative placeholders share one quiet surface and respect reduced motion. */
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`block max-w-full rounded skeleton-bg motion-safe:animate-pulse ${className}`} style={style} />;
}

export function LoadingRegion({ children, label = 'Loading page data', className = '' }: { children: ReactNode; label?: string; className?: string }) {
  return <div aria-busy="true" className={className}><span role="status" className="sr-only">{label}</span><div aria-hidden="true">{children}</div></div>;
}

export function MetricSkeletons({ labels, compact = false, columns = 2, className = '' }: { labels: string[]; compact?: boolean; columns?: 1 | 2; className?: string }) {
  return <div className={`grid ${columns === 1 ? 'grid-cols-1' : 'grid-cols-2'} gap-3 ${className}`}>
    {labels.map(label => <MetricCard key={label} label={label} size={compact ? 'compact' : 'default'} value={<Skeleton className="h-[1em] w-28 my-[0.125em]" />} hint={<Skeleton className="h-4 w-36" />} />)}
  </div>;
}

/** Reserve the same plot height as the resolved chart, without inventing plotted data. */
export function ChartSkeleton({ height = 300, className = '' }: { height?: number; className?: string }) {
  return <div aria-hidden="true" className={`relative ${className}`} style={{ height }}>
    <div className="absolute inset-x-8 top-4 bottom-10 flex flex-col justify-between border-b border-cipher-border">
      {[0, 1, 2, 3].map(row => <div key={row} className="border-t border-cipher-border/50" />)}
    </div>
    <div className="absolute left-8 right-8 bottom-3 flex justify-between">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-3 w-8" />)}</div>
    <Skeleton className="absolute left-1/2 top-1/2 -translate-x-1/2 h-3 w-24" />
  </div>;
}

export function ChartCardSkeleton({ height = 300, title }: { height?: number; title?: string }) {
  return <div className="card card-static"><div className="card-body">
    {title ? <p className="chart-title mb-4">{title}</p> : <Skeleton className="h-5 w-44 mb-4" />}
    <Skeleton className="h-4 w-96 mb-6" /><ChartSkeleton height={height} />
    <div className="mt-5 flex justify-center gap-5"><Skeleton className="h-3 w-24" /><Skeleton className="h-3 w-24" /></div>
  </div></div>;
}

export function ControlsSkeleton() {
  return <div aria-hidden="true" className="flex flex-wrap items-center justify-between gap-3 mb-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-9 w-40" /></div>;
}

/** Maps and spatial views reserve a canvas without implying axes or observations. */
export function VisualizationSkeleton({ className = 'h-[350px] sm:h-[420px]' }: { className?: string }) {
  return <div aria-hidden="true" className={`relative ${className}`}><Skeleton className="absolute left-1/2 top-1/2 -translate-x-1/2 h-4 w-32" /></div>;
}
