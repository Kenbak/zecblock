'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { RecentBlocks } from '@/components/RecentBlocks';
import { RecentShieldedTxs } from '@/components/RecentShieldedTxs';
import { RecentTransactions } from '@/components/RecentTransactions';
import { RecentReorgs } from '@/components/RecentReorgs';
import { TopMiners } from '@/components/TopMiners';
import { MiningSoftwareMiniChart } from '@/components/MiningSoftwareMiniChart';
import { IronwoodProgressCard } from '@/components/IronwoodProgressCard';
import { ShieldedPoolMiniChart } from '@/components/ShieldedPoolMiniChart';
import { SlidersIcon } from '@/components/icons/common';
import { HomeFeedTableSkeleton } from '@/components/HomeFeedTableSkeleton';
import { HOME_FEED_TYPES, homeFeedPendingAttribute, type HomeFeedType } from '@/lib/home-feed-preferences';

// Mempool deliberately excluded: it renders an extra pending-count summary
// row above its table (see RecentMempool), so it's taller than every other
// feed here — swapping it into this slot breaks the fixed, no-scroll card
// height every other option holds to. It stays available as its own
// permanent section below instead of a Customize option.
export type { HomeFeedType } from '@/lib/home-feed-preferences';

const FEED_ORDER = HOME_FEED_TYPES;

const FEED_META: Record<HomeFeedType, { sectionLabel: string; menuLabel: string; viewAllHref: string }> = {
  blocks: { sectionLabel: 'RECENT_BLOCKS', menuLabel: 'Recent Blocks', viewAllHref: '/blocks' },
  shielded: { sectionLabel: 'SHIELDED_ACTIVITY', menuLabel: 'Shielded Activity', viewAllHref: '/txs?type=shielded' },
  transactions: { sectionLabel: 'RECENT_TRANSACTIONS', menuLabel: 'Recent Transactions', viewAllHref: '/txs' },
  reorgs: { sectionLabel: 'RECENT_REORGS', menuLabel: 'Forks & Reorgs', viewAllHref: '/reorgs' },
  miners: { sectionLabel: 'TOP_MINERS', menuLabel: 'Top Miners (24h)', viewAllHref: '/mining' },
  software: { sectionLabel: 'MINING_SOFTWARE', menuLabel: 'Mining Software (30d)', viewAllHref: '/mining#software' },
  ironwood: { sectionLabel: 'IRONWOOD_PROGRESS', menuLabel: 'Ironwood Migration', viewAllHref: '/ironwood' },
  poolsChart: { sectionLabel: 'SHIELDED_POOLS', menuLabel: 'Shielded Pool Trend', viewAllHref: '/pools' },
};

const CheckIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

/**
 * A homepage feed card whose content the visitor can swap between several
 * "recent activity" feeds — Etherscan's homepage does the same thing (a
 * "Customize" control on each of its Latest Blocks / Latest Transactions
 * cards), and deliberately only as a per-slot content swap, not a
 * draggable/reorderable layout: no position state to persist, no layout
 * shift risk. Defaults remain visible in server HTML. Only an actual saved
 * alternative gets a guarded loading state until preferences are resolved.
 */
export function HomeFeedCard({
  storageKey,
  defaultType,
  initialShieldedTxs,
}: {
  storageKey: string;
  defaultType: HomeFeedType;
  initialShieldedTxs?: any[];
}) {
  const [type, setType] = useState<HomeFeedType>(defaultType);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Match server markup, then resolve preferences before hydration's paint.
  // The small head script prevents a saved alternative flashing during a
  // hard navigation; on soft navigation this layout effect handles it.
  useLayoutEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && FEED_ORDER.includes(saved as HomeFeedType)) {
        setType(saved as HomeFeedType);
      }
    } catch {
      // localStorage unavailable (private browsing, etc.) — just keep the default.
    } finally {
      setPreferencesReady(true);
      const attribute = homeFeedPendingAttribute(storageKey);
      if (attribute) document.documentElement.removeAttribute(attribute);
      document.dispatchEvent(new Event('home-feed-ready'));
    }
  }, [storageKey]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const select = (next: HomeFeedType) => {
    setType(next);
    setOpen(false);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Preference just won't persist — the feed still switches for this session.
    }
  };

  const meta = FEED_META[type];
  const viewAllLink = (
    <Link href={meta.viewAllHref} className="text-xs sm:text-sm font-mono text-muted hover:text-primary transition-colors">
      View all
    </Link>
  );

  return (
    <div className="home-feed min-w-0" data-preference-key={storageKey} data-preferences-ready={preferencesReady}>
      <div className="home-feed-placeholder">
        <div className="relative" aria-hidden="true">
          <div className="invisible">
            <SectionHeader label="LOADING_ACTIVITY" size="lg" actions={
              <div>
                <button disabled tabIndex={-1} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono">
                  <SlidersIcon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Customize</span>
                </button>
              </div>
            } />
          </div>
          <div className="absolute top-1 left-0 h-4 w-48 rounded skeleton-bg motion-safe:animate-pulse" />
        </div>
        <HomeFeedTableSkeleton footer={<span className="text-xs sm:text-sm font-mono" aria-hidden="true">&nbsp;</span>} />
      </div>
      <div className="home-feed-content">
        <SectionHeader
          label={meta.sectionLabel}
          size="lg"
          actions={
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setOpen((v) => !v)}
                aria-label="Customize this card"
                aria-expanded={open}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono transition-colors ${
                  open ? 'text-primary bg-cipher-hover' : 'text-muted hover:text-primary'
                }`}
              >
                <SlidersIcon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Customize</span>
              </button>

              {open && (
                <div className="absolute right-0 mt-1 w-60 dropdown-menu rounded-lg shadow-xl border p-1 z-30 animate-scale-in origin-top-right max-h-80 overflow-y-auto">
                  {FEED_ORDER.map((feed) => (
                    <button
                      key={feed}
                      onClick={() => select(feed)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-data dropdown-item"
                    >
                      {FEED_META[feed].menuLabel}
                      {feed === type && <CheckIcon />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          }
        />

        {type === 'blocks' && (
          <RecentBlocks footer={viewAllLink} />
        )}
        {type === 'shielded' && (
          <RecentShieldedTxs
            initialTxs={type === defaultType ? initialShieldedTxs : undefined}
            showLegend={false}
            footer={viewAllLink}
          />
        )}
        {type === 'transactions' && <RecentTransactions footer={viewAllLink} />}
        {type === 'reorgs' && <RecentReorgs footer={viewAllLink} />}
        {type === 'miners' && <TopMiners footer={viewAllLink} />}
        {type === 'software' && <MiningSoftwareMiniChart footer={viewAllLink} />}
        {type === 'ironwood' && <IronwoodProgressCard footer={viewAllLink} />}
        {type === 'poolsChart' && <ShieldedPoolMiniChart footer={viewAllLink} />}
      </div>
    </div>
  );
}
