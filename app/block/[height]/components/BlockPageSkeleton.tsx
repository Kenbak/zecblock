import { SkeletonTable } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { formatRelativeTime } from '@/lib/utils';
import { formatBytesCompact } from '@/lib/format-numbers';
import type { BlockPageSummary } from './types';



export function BlockPageSkeleton({
  identifier,
  initialSummary,
  titleAsHeading = true,
}: {
  titleAsHeading?: boolean;
  identifier: string;
  initialSummary: BlockPageSummary | null;
}) {
  const Title = titleAsHeading ? 'h1' : 'div';
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-fade-in">
      <div className="mb-6">
        <span className="text-caption font-mono text-muted tracking-wider">&gt; BLOCK_DETAILS</span>
        <div className="flex flex-wrap items-center gap-3 mt-1">
          <Title className={`type-page font-mono ${initialSummary?.isOrphaned ? 'text-cipher-orange' : 'text-primary'}`}>
            {initialSummary
              ? `${initialSummary.isOrphaned ? 'Orphaned Zcash Block' : 'Zcash Block'} #${initialSummary.height.toLocaleString()}`
              : 'Zcash Block'}
          </Title>
          {initialSummary && (
            <Badge color={initialSummary.isOrphaned ? 'orange' : 'green'}>
              {initialSummary.isOrphaned ? 'ORPHAN' : 'CANONICAL'}
            </Badge>
          )}
        </div>
        <p className="mt-3 text-xs sm:text-sm text-secondary">
          {initialSummary ? (
            <>
              {initialSummary.isOrphaned
                ? 'This block is no longer part of the canonical Zcash chain.'
                : 'This block is part of the canonical Zcash chain.'}{' '}
              Full block hash:{' '}
              <code className="font-mono text-primary break-all">{initialSummary.hash}</code>
            </>
          ) : (
            <>
              Loading block identifier:{' '}
              <code className="font-mono text-primary break-all">{identifier}</code>
            </>
          )}
        </p>
        {/* Server-seeded facts from the SEO resolution fetch — real content
            instead of a shimmer while the full block detail loads client-side. */}
        {initialSummary && (initialSummary.timestamp != null || initialSummary.transactionCount != null || initialSummary.size != null) && (
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs font-mono text-muted">
            {initialSummary.timestamp != null && (
              <div className="flex items-center gap-1.5">
                <dt className="text-muted">Mined</dt>
                <dd className="text-secondary">{formatRelativeTime(initialSummary.timestamp)}</dd>
              </div>
            )}
            {initialSummary.transactionCount != null && (
              <div className="flex items-center gap-1.5">
                <dt className="text-muted">Transactions</dt>
                <dd className="text-secondary">{initialSummary.transactionCount.toLocaleString()}</dd>
              </div>
            )}
            {initialSummary.size != null && (
              <div className="flex items-center gap-1.5">
                <dt className="text-muted">Size</dt>
                <dd className="text-secondary">{formatBytesCompact(initialSummary.size)}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        Loading full block details for block {initialSummary ? `#${initialSummary.height.toLocaleString()}` : identifier}…
      </div>
      <Card className="mb-6" aria-hidden="true">
        <CardBody>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">{['Block hash', 'Timestamp', 'Block size', 'Transactions', 'Total fees'].map(label => <div key={label} className="rounded border border-cipher-border p-3"><p className="text-caption text-muted mb-2">{label}</p><Skeleton className="h-5 w-28" /></div>)}</div>
          <div className="mt-3 space-y-3">{['Coinbase message', 'Coinbase outputs'].map(label => <div key={label} className="rounded border border-cipher-border p-4"><p className="text-caption text-muted mb-3">{label}</p><Skeleton className="h-4 w-3/4 mb-3" /><Skeleton className="h-4 w-1/2" /></div>)}</div>
          <Skeleton className="h-10 w-40 mt-4" />
        </CardBody>
      </Card>
      <Card aria-hidden="true">
        <CardHeader><Skeleton className="h-4 w-32" /></CardHeader>
        <CardBody>
          <SkeletonTable rows={5} columns={4} label={null} />
        </CardBody>
      </Card>
    </div>
  );
}
