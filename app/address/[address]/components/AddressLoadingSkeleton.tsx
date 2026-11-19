import { SkeletonTable } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { CURRENCY } from '@/lib/config';
import type { AddressMeta } from '@/lib/seo';

export function AddressLoadingSkeleton({ initialMeta = null, address }: { initialMeta?: AddressMeta | null; address?: string } = {}) {
  if (initialMeta?.isShielded) return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 pb-12">
    <p role="status" className="sr-only">Loading private address details…</p>
    <Skeleton className="h-7 w-28 mb-6" />
    <div className="rounded-xl border border-cipher-border p-5 sm:p-7"><p className="text-xl font-semibold text-primary">Shielded activity is private</p><p className="mt-3 text-sm text-muted">Shielded balances and transaction history are not publicly visible.</p><Skeleton className="mt-6 h-20 w-full" /></div>
  </div>;
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 pb-12">
    <div role="status" aria-live="polite" className="sr-only">Loading address activity{address ? ` for ${address}` : ''}…</div>
    <div className="mb-5 flex items-center justify-between" aria-hidden="true"><Skeleton className="h-7 w-48" /><Skeleton className="h-8 w-24" /></div>
    <div className="mb-8 rounded-xl border border-cipher-border bg-cipher-card overflow-hidden">
      <div className="grid lg:grid-cols-[1.2fr_1fr]">
        <div className="p-5 sm:p-7">
          <p className="text-xs font-mono text-muted uppercase tracking-wider">Public balance</p>
          {initialMeta && !initialMeta.isShielded ? <p className="mt-3 text-2xl sm:text-3xl font-mono text-primary">{initialMeta.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} <span className="text-base text-secondary">{CURRENCY}</span></p> : <Skeleton className="mt-3 h-9 w-full max-w-sm" />}
          <Skeleton className="h-4 w-56 max-w-full mt-2" />
        </div>
        <div className="p-5 sm:p-7 border-t lg:border-t-0 lg:border-l border-cipher-border">
          <p className="text-xs text-muted">Indexed transactions</p>
          {initialMeta && !initialMeta.isShielded ? <p className="mt-1 text-xl font-mono text-primary">{initialMeta.txCount.toLocaleString('en-US')}</p> : <Skeleton className="mt-1 h-7 w-24" />}
          <div className="grid grid-cols-2 gap-6 mt-5" aria-hidden="true">{[0, 1].map(i => <div key={i}><Skeleton className="h-3 w-20 mb-2" /><Skeleton className="h-4 w-full max-w-32" /></div>)}</div>
        </div>
      </div>
      <div className="px-5 sm:px-7 py-4 border-t border-cipher-border" aria-hidden="true"><Skeleton className="h-4 w-full max-w-lg" /></div>
    </div>
    <div className="flex gap-5 py-3 mb-6 border-b border-cipher-border" aria-hidden="true"><Skeleton className="h-5 w-32" /><Skeleton className="h-5 w-40" /></div>
    <div className="rounded-xl border border-cipher-border p-5" aria-hidden="true"><SkeletonTable rows={5} columns={5} label={null} /></div>
  </div>;
}

export function AddressPageSuspenseFallback({ initialMeta }: { initialMeta?: AddressMeta | null } = {}) {
  return <AddressLoadingSkeleton initialMeta={initialMeta} />;
}

export function AddressGraphSkeleton() {
  return <div role="status" aria-label="Loading address connections" className="rounded-xl border border-cipher-border p-5 sm:p-6">
    <Skeleton className="h-5 w-48 mb-3" /><Skeleton className="h-4 w-full max-w-xl mb-6" />
    <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-5"><Skeleton className="h-[440px] w-full rounded-lg" /><Skeleton className="h-64 lg:h-[440px] w-full rounded-lg" /></div>
  </div>;
}
