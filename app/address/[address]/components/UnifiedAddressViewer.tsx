'use client';

import Link from 'next/link';
import { CopyButton } from '@/components/CopyButton';
import { TxTypeBadge } from '@/components/ui/TxTypeBadge';
import type { UnifiedAddressComponents } from './types';

export function UnifiedAddressViewer({ uaComponents, uaLoading, copiedText, onCopy }: {
  uaComponents: UnifiedAddressComponents | null;
  uaLoading: boolean;
  copiedText: string | null;
  onCopy: (text: string, label: string) => void;
}) {
  const receivers = uaComponents ? [
    { key: 'transparent' as const, present: uaComponents.has_transparent, address: uaComponents.transparent_address },
    { key: 'sapling' as const, present: uaComponents.has_sapling, address: uaComponents.sapling_address && /^(zs|ztestsapling)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(uaComponents.sapling_address) ? uaComponents.sapling_address : null },
    { key: 'orchard' as const, present: uaComponents.has_orchard, address: null },
  ].filter(receiver => receiver.present) : [];
  return <section aria-label="Unified address receivers" className="rounded-xl border border-cipher-border bg-cipher-card overflow-hidden">
    <div className="p-5 sm:p-6"><h2 className="text-base font-semibold text-primary">Address receivers</h2><p className="mt-2 text-sm text-muted">Decoded locally from the address. Receiver details do not reveal shielded activity.</p></div>
    {uaLoading ? <p role="status" className="px-5 sm:px-6 pb-6 text-sm text-muted">Decoding receivers…</p> : !uaComponents ? <p role="status" className="px-5 sm:px-6 pb-6 text-sm text-muted">Receiver decoding is unavailable. This does not mean the address is empty or has no shielded receivers.</p> : <div className="divide-y divide-cipher-border border-t border-cipher-border">
      {receivers.map(receiver => <div key={receiver.key} className="grid sm:grid-cols-[150px_minmax(0,1fr)] gap-4 p-5 sm:p-6">
        <div><TxTypeBadge category={receiver.key} /></div>
        <div className="min-w-0">
          {receiver.address ? <div className="flex items-start gap-2"><code className="min-w-0 break-all text-xs text-secondary">{receiver.address}</code><CopyButton text={receiver.address} label={receiver.key} copiedText={copiedText} onCopy={onCopy} /></div> : <p className="text-sm text-secondary">Receiver present · use the Unified Address</p>}
          {receiver.key === 'transparent' && receiver.address ? <Link className="inline-flex mt-3 rounded border border-cipher-border px-3 py-2 text-xs font-mono text-primary hover:bg-cipher-hover" href={`/address/${receiver.address}`} prefetch={false}>View transparent activity →</Link> : <p className="text-xs text-muted mt-2">Balance and history remain private.</p>}
        </div>
      </div>)}
      {!receivers.length && <p className="p-5 text-sm text-muted">No supported receiver details were returned by the decoder.</p>}
    </div>}
  </section>;
}
