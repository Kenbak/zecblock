'use client';

import Link from 'next/link';
import Image from 'next/image';
import { CURRENCY } from '@/lib/config';
import { formatHumanDate } from './helpers';
import type { AddressData, CrossChainActivity, PriceData } from './types';

export function AddressHeroCard({ data, priceData, crossChain, totalTxCount }: {
  data: AddressData;
  priceData: PriceData | null;
  crossChain: CrossChainActivity | null;
  totalTxCount: number;
}) {
  const funding = data.firstFunding;
  return (
    <section aria-label="Address overview" className="mb-8 rounded-xl border border-cipher-border bg-cipher-card overflow-hidden">
      <div className="grid lg:grid-cols-[1.2fr_1fr]">
        <div className="p-5 sm:p-7">
          <p className="text-xs font-mono text-muted uppercase tracking-wider">Public balance</p>
          <div className="mt-3 flex items-center gap-3 font-mono text-primary font-semibold min-w-0">
            <Image unoptimized src="/tokens/zec.png" alt="" width={36} height={36} className="h-8 w-8 sm:h-9 sm:w-9 shrink-0 rounded-full" />
            <p className="min-w-0 break-words">
            <span className="text-xl sm:text-3xl tracking-tight">{data.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}</span>
            <span className="ml-2 text-base font-normal text-secondary">{CURRENCY}</span>
            </p>
          </div>
          <p className="mt-2 text-sm font-mono text-muted">
            {priceData ? <>≈ ${(data.balance * priceData.price).toLocaleString('en-US', { maximumFractionDigits: 2 })} <span className="text-xs">at ${priceData.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}/{CURRENCY}</span></> : 'USD estimate unavailable'}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:p-7 border-t lg:border-t-0 lg:border-l border-cipher-border">
          <div className="col-span-2"><dt className="text-xs text-muted">Indexed transactions</dt><dd className="mt-1 text-xl text-primary font-mono">{totalTxCount.toLocaleString('en-US')}</dd></div>
          <div><dt className="text-xs text-muted">First activity</dt><dd className="mt-1 text-sm text-secondary font-mono">{data.firstSeen ? formatHumanDate(data.firstSeen) : 'Unavailable'}</dd></div>
          <div><dt className="text-xs text-muted">Last activity</dt><dd className="mt-1 text-sm text-secondary font-mono">{data.lastSeen ? formatHumanDate(data.lastSeen) : 'Unavailable'}</dd></div>
        </dl>
      </div>
      {(funding || (crossChain && crossChain.totalSwaps > 0)) && <div className="flex flex-wrap gap-x-8 gap-y-3 border-t border-cipher-border px-5 sm:px-7 py-4 text-xs text-muted">
        {funding && <p>First funding <Link href={`/tx/${funding.txid}`} prefetch={false} className="ml-2 text-secondary underline underline-offset-4 hover:text-primary">{funding.amountZec.toLocaleString('en-US', { maximumFractionDigits: 8 })} {CURRENCY} ↗</Link>
          {funding.isCoinbase ? ' · Mining reward' : funding.funderAddress ? <> · From <Link className="text-secondary hover:text-primary" href={`/address/${funding.funderAddress}`} prefetch={false}>{funding.funderLabel || `${funding.funderAddress.slice(0, 6)}…${funding.funderAddress.slice(-4)}`}</Link></> : null}
        </p>}
        {crossChain && crossChain.totalSwaps > 0 && <p>Bridge records <span className="ml-2 font-mono text-secondary">{crossChain.totalSwaps.toLocaleString('en-US')}</span> · {crossChain.entryCount} in / {crossChain.exitCount} out</p>}
      </div>}
    </section>
  );
}
