import { PageHeader } from '@/components/ui';
import { ShieldedSupplySkeleton } from '@/components/pools/ShieldedSupplyHero';

export default function Loading() {
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <PageHeader eyebrow="POOL_ANALYTICS" title="Zcash Shielded Pools" titleAsHeading={false}
      subtitle="Supply held in shielded pools, transaction activity, and the public flows moving ZEC in and out." />
    <ShieldedSupplySkeleton />
  </div>;
}
