'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ExportButton } from '@/components/ExportButton';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { NetworkIcon } from '@/components/icons/common';
import { getNetworkLabel } from '@/lib/network';
import type { BlockData } from './types';

const ClockIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

/** Target of a ←/→ press that already owns arrow keys (text entry, tabs, sliders, menus, maps). */
const ARROW_KEY_OWNERS =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="tab"], [role="slider"], [role="listbox"], [role="menu"], [role="menubar"], [role="grid"], [role="radiogroup"], canvas';

/**
 * Previous/next block buttons on the title row — the first thing someone
 * stepping through the chain reaches for, so they sit at title height
 * (40px, styled like Export) rather than as small pills on the badge row.
 * ←/→ on the keyboard do the same, except where the focused element uses
 * arrow keys itself.
 */
function BlockNavButtons({ data }: { data: BlockData }) {
  const router = useRouter();
  const prev = data.previousBlockHash ? data.height - 1 : null;
  const next = data.nextBlockHash ? data.height + 1 : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target;
      if (target instanceof Element && target.closest(ARROW_KEY_OWNERS)) return;
      const height = event.key === 'ArrowLeft' ? prev : next;
      if (height === null) return;
      event.preventDefault();
      router.push(`/block/${height}`);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [prev, next, router]);

  const navButton = (direction: 'prev' | 'next', height: number) => {
    const label = direction === 'prev' ? 'Previous' : 'Next';
    const enabled = direction === 'prev' ? prev !== null : next !== null;
    const className = `inline-flex items-center gap-1.5 h-10 px-3 shrink-0 rounded-md border border-cipher-border text-sm font-mono tabular-nums transition-colors ${
      direction === 'next' ? 'flex-row-reverse' : ''
    }`;
    const content = (
      <>
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={direction === 'prev' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} />
        </svg>
        #{height.toLocaleString()}
      </>
    );
    if (!enabled) {
      return (
        <span aria-hidden="true" className={`${className} text-muted opacity-40`}>
          {content}
        </span>
      );
    }
    return (
      <Link
        href={`/block/${height}`}
        prefetch={false}
        aria-label={`${label} block #${height.toLocaleString()}`}
        aria-keyshortcuts={direction === 'prev' ? 'ArrowLeft' : 'ArrowRight'}
        title={`${label} block (${direction === 'prev' ? '←' : '→'})`}
        className={`${className} text-secondary hover:text-primary hover:bg-cipher-hover`}
      >
        {content}
      </Link>
    );
  };

  return (
    <nav aria-label="Adjacent blocks" className="flex items-center gap-2 shrink-0">
      {navButton('prev', data.height - 1)}
      {navButton('next', data.height + 1)}
    </nav>
  );
}

export function BlockPageHeader({
  data,
}: {
  data: BlockData;
}) {
  const isDeepOrFinalized = data.finality ? data.finality === 'Finalized' : data.confirmations > 6;

  return (
    <div className="mb-6 animate-fade-in-up">
      <span className="text-caption font-mono text-muted tracking-wider">&gt; BLOCK_DETAILS</span>

      {/* Title (left) + prev/next block buttons (right, above Export so the
          header's right edge reads as one control column). 40px tall so they
          carry the heading's weight; on narrow screens they wrap under the
          title, left-aligned, rather than squeezing it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 mt-1">
        <h1
          className={`type-page font-mono ${data.isOrphaned ? 'text-cipher-orange' : 'text-primary'}`}
        >
          {data.isOrphaned ? 'Orphaned Zcash Block' : 'Zcash Block'} #{data.height.toLocaleString()}
        </h1>
        {!data.isOrphaned && <BlockNavButtons data={data} />}
      </div>

      {/* Facts (left) + Export (right), one row directly above the facts
          card — nothing between the badges and the card they describe. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color="muted" icon={<NetworkIcon />} variant="subtle">
            {getNetworkLabel()}
          </Badge>
          <StatusBadge status={data.isOrphaned ? 'orphan' : 'canonical'} variant="subtle" />
          {!data.isOrphaned && (
            <Badge color={isDeepOrFinalized ? 'green' : 'orange'} icon={<ClockIcon />} variant="subtle">
              {data.finality ?? `${data.confirmations.toLocaleString()} CONFIRMATION${data.confirmations !== 1 ? 'S' : ''}`}
            </Badge>
          )}
        </div>

        {!data.isOrphaned && (
          <div className="flex items-center gap-2">
            <ExportButton
              data={{
                height: data.height,
                hash: data.hash,
                timestamp: data.timestamp,
                transactionCount: data.transactionCount,
                size: data.size,
                difficulty: data.difficulty,
                confirmations: data.confirmations,
                previousBlockHash: data.previousBlockHash,
                nextBlockHash: data.nextBlockHash,
                version: data.version,
                merkleRoot: data.merkleRoot,
                finalSaplingRoot: data.finalSaplingRoot,
                bits: data.bits,
                nonce: data.nonce,
                solution: data.solution,
                totalFees: data.totalFees,
                minerAddress: data.minerAddress,
                transactions: data.transactions?.map((tx: any) => ({
                  txid: tx.txid,
                  type: tx.vin?.[0]?.coinbase ? 'coinbase' : tx.hasShieldedActivity ? 'shielded' : 'regular',
                  inputs: tx.vin?.length || 0,
                  outputs: tx.vout?.length || 0,
                  amount: tx.vout?.reduce((sum: number, out: any) => sum + (out.value || 0), 0) || 0
                }))
              }}
              csvData={data.transactions}
              filename={`block-${data.height}`}
              type="both"
              label="Export"
              csvHeaders={['TXID', 'Type', 'Inputs', 'Outputs', 'Amount (ZEC)']}
              csvMapper={(tx: any) => [
                tx.txid,
                tx.vin?.[0]?.coinbase ? 'Coinbase' : tx.hasShieldedActivity ? 'Shielded' : 'Regular',
                String(tx.vin?.length || 0),
                String(tx.vout?.length || 0),
                tx.vout?.reduce((sum: number, out: any) => sum + (out.value || 0), 0).toFixed(8) || '0'
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}
