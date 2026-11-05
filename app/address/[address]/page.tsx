import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { isValidAddressSyntax } from '@/lib/address-syntax';
import { getAddressResolution } from '@/lib/seo';
import { AddressDetailClient, AddressPageSuspenseFallback } from './components';

type Props = {
  params: Promise<{ address: string }>;
};


export default async function AddressPage({ params }: Props) {
  const { address } = await params;

  if (!isValidAddressSyntax(address)) {
    notFound();
  }

  // `getAddressResolution` is React-`cache()`-wrapped, and layout.tsx already
  // calls it for metadata/JSON-LD, so this reuses that same in-request
  // result rather than firing a second fetch. Threading the resolved
  // `AddressMeta` down seeds the client's loading state with real balance/
  // type/tx-count content instead of a pure shimmer skeleton.
  const resolution = await getAddressResolution(address);
  const initialMeta = resolution.state === 'found' ? resolution.meta : null;

  return (
    <Suspense fallback={<AddressPageSuspenseFallback initialMeta={initialMeta} />}>
      <AddressDetailClient address={address} initialMeta={initialMeta} />
    </Suspense>
  );
}
