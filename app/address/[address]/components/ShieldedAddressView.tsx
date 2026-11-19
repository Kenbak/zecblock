'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { RedactedAmount } from '@/components/ui/RedactedAmount';
import { Icons } from './icons';
import { UnifiedAddressViewer } from './UnifiedAddressViewer';
import type { UnifiedAddressComponents } from './types';

export function ShieldedAddressView({ isUnified, uaComponents, uaLoading, copiedText, onCopy }: {
  address: string;
  isUnified: boolean;
  uaComponents: UnifiedAddressComponents | null;
  uaLoading: boolean;
  copiedText: string | null;
  onCopy: (text: string, label: string) => void;
}) {
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 pb-12 space-y-6">
    <Badge color="shielded" icon={<Icons.Shield />}>{isUnified ? 'UNIFIED' : 'SHIELDED'}</Badge>
    <section className="rounded-xl border border-cipher-border bg-cipher-card p-5 sm:p-7" aria-label="Private address information">
      <div className="flex items-start gap-4">
        <span className="text-cipher-shielded mt-1" aria-hidden="true"><Icons.Shield /></span>
        <div><h2 className="text-xl font-semibold text-primary">Shielded activity is private</h2>
          <p className="mt-3 text-sm text-secondary max-w-3xl leading-relaxed">An address alone does not reveal its shielded balance, transactions or counterparties. The explorer cannot calculate a total balance for this {isUnified ? 'Unified Address' : 'shielded address'}.</p>
          {isUnified && <p className="mt-3 text-sm text-muted max-w-3xl leading-relaxed">A Unified Address can include transparent and shielded receivers. Public activity for a transparent receiver is available separately and does not include shielded funds.</p>}
        </div>
      </div>
      <dl className="grid sm:grid-cols-2 gap-5 border-t border-cipher-border mt-6 pt-5 text-sm">
        <div>
          <dt className="text-xs text-muted">Shielded balance</dt>
          <dd className="mt-3 space-y-2">
            <RedactedAmount label="Shielded balance is private" />
            <p className="text-xs text-muted">Not publicly visible</p>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Shielded transaction history</dt>
          <dd className="mt-3 text-secondary">Not publicly visible</dd>
        </div>
      </dl>
    </section>
    {isUnified && <UnifiedAddressViewer uaComponents={uaComponents} uaLoading={uaLoading} copiedText={copiedText} onCopy={onCopy} />}
    <nav aria-label="Private address tools" className="flex flex-wrap gap-3">
      <Link href="/decrypt" className="rounded border border-cipher-border px-4 py-3 text-sm text-secondary hover:bg-cipher-hover hover:text-primary">Decrypt a transaction →</Link>
      <Link href="/privacy" className="rounded border border-cipher-border px-4 py-3 text-sm text-secondary hover:bg-cipher-hover hover:text-primary">Network privacy metrics →</Link>
    </nav>
  </div>;
}
