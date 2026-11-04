import { PageHeader } from '@/components/ui/SectionHeader';
import { ChartCardSkeleton, LoadingRegion } from '@/components/ui/Skeleton';

export default function Loading() {
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <PageHeader eyebrow="NETWORK" eyebrowHref="/network" title="Zcash block speed" titleAsHeading={false}
      subtitle="Measured mainnet blocks compared with NU7’s 25-second blocks." />
    <LoadingRegion><ChartCardSkeleton height={420} /></LoadingRegion>
  </div>;
}
