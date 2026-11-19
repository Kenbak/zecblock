'use client';

import Link from 'next/link';
import { CURRENCY } from '@/lib/config';

interface AddressStateProps {
  address: string;
  copiedText: string | null;
  onCopy: (text: string, label: string) => void;
}

export function EmptyAddressView({ address }: AddressStateProps) {
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 pb-12">
    <section aria-label={`Activity for ${address}`} role="status" className="rounded-xl border border-cipher-border bg-cipher-card p-5 sm:p-7">
      <p className="text-xs font-mono text-muted uppercase tracking-wider">Public balance</p>
      <p className="mt-3 text-3xl text-primary font-mono">0.00 <span className="text-base text-muted">{CURRENCY}</span></p>
      <h2 className="mt-6 text-base font-semibold text-primary">No indexed activity</h2>
      <p className="mt-2 text-sm text-muted">The index has no transaction history for this transparent address.</p>
    </section>
  </div>;
}

export function IndexingIssueView({ address }: AddressStateProps) {
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 pb-12">
    <section aria-label={`Activity for ${address}`} role="status" className="rounded-xl border border-cipher-border bg-cipher-card p-5 sm:p-7">
      <h2 className="text-base font-semibold text-primary">Address activity is unavailable</h2>
      <p className="mt-2 text-sm text-muted max-w-2xl">The explorer could not retrieve this address’s public history. This does not mean its balance is zero or that it has no transactions.</p>
      <Link href="/" className="inline-flex mt-5 rounded border border-cipher-border px-4 py-2 text-sm text-secondary hover:bg-cipher-hover">Explorer home →</Link>
    </section>
  </div>;
}
