import { PageHeader } from '@/components/ui/SectionHeader';
import { LoadingRegion, Skeleton } from '@/components/ui/Skeleton';

export default function Loading() {
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <PageHeader eyebrow="NETWORK" eyebrowHref="/network" title="Zcash wallet servers" titleAsHeading={false}
      subtitle="Public wallet servers checked against ZecBlock’s index of the chain." />
    <LoadingRegion>
      <div className="grid sm:grid-cols-3 border border-cipher-border rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-cipher-border mb-8">
        {['Server names checked', 'Answering now', 'Tip matches our index'].map(label => <div key={label} className="p-5 sm:p-6"><p className="type-label text-muted mb-3">{label}</p><Skeleton className="h-8 w-16" /></div>)}
      </div>
      <div className="card card-static p-5 sm:p-6 mb-6"><Skeleton className="h-5 w-48 mb-6" /><Skeleton className="aspect-[960/380] w-full" /></div>
      <div className="space-y-6">{[0, 1].map(i => <div key={i} className="card card-static p-5 sm:p-6"><Skeleton className="h-5 w-40 mb-6" /><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{[0, 1, 2, 3].map(j => <Skeleton key={j} className="h-36 w-full" />)}</div></div>)}</div>
    </LoadingRegion>
  </div>;
}
