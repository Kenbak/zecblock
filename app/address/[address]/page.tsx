import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { detectAddressType } from '@/lib/zcash';
import { getAddressResolution } from '@/lib/seo';
import { AddressDetailClient, AddressPageSuspenseFallback } from './components';

type Props = {
  params: Promise<{ address: string }>;
};

function isValidAddressSyntax(address: string): boolean {
  const type = detectAddressType(address);

  if (type === 'transparent') {
    return address.length === 35 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(address);
  }

  if (type === 'shielded') {
    return address.length === 78
      && /^(?:zs|ztestsapling)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(address);
  }

  if (type === 'unified') {
    return address.length >= 16
      && address.length <= 512
      && /^(?:u|utest)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(address);
  }

  if (type === 'tex') {
    return /^(?:tex|textest)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/.test(address);
  }

  return false;
}

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
