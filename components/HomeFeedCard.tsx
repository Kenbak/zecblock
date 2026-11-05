'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
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
import { BlockSectionIcon, TransactionSectionIcon, ReorgSectionIcon, MiningSectionIcon, SoftwareSectionIcon } from '@/components/icons/home-section';
import { ShieldedIcon, MigrationIcon } from '@/components/icons/shield-flow';
import { HomeFeedTableSkeleton } from '@/components/HomeFeedTableSkeleton';

// Mempool deliberately excluded: it renders an extra pending-count summary
// row above its table (see RecentMempool), so it's taller than every other
// feed here — swapping it into this slot breaks the fixed, no-scroll card
// height every other option holds to. It stays available as its own
// permanent section below instead of a Customize option.
export type HomeFeedType = 'blocks' | 'shielded' | 'transactions' | 'reorgs' | 'miners' | 'software' | 'ironwood' | 'poolsChart';

const FEED_ORDER: HomeFeedType[] = ['blocks', 'shielded', 'transactions', 'reorgs', 'miners', 'software', 'ironwood', 'poolsChart'];

const FEED_META: Record<HomeFeedType, { sectionLabel: string; menuLabel: string; viewAllHref: string; icon: ComponentType<{ className?: string }> }> = {
  blocks: { sectionLabel: 'RECENT_BLOCKS', menuLabel: 'Recent Blocks', viewAllHref: '/blocks', icon: BlockSectionIcon },
  shielded: { sectionLabel: 'SHIELDED_ACTIVITY', menuLabel: 'Shielded Activity', viewAllHref: '/txs?type=shielded', icon: ShieldedIcon },
  transactions: { sectionLabel: 'RECENT_TRANSACTIONS', menuLabel: 'Recent Transactions', viewAllHref: '/txs', icon: TransactionSectionIcon },
  reorgs: { sectionLabel: 'RECENT_REORGS', menuLabel: 'Forks & Reorgs', viewAllHref: '/reorgs', icon: ReorgSectionIcon },
  miners: { sectionLabel: 'TOP_MINERS', menuLabel: 'Top Miners (24h)', viewAllHref: '/mining', icon: MiningSectionIcon },
  software: { sectionLabel: 'MINING_SOFTWARE', menuLabel: 'Mining Software (30d)', viewAllHref: '/mining#software', icon: SoftwareSectionIcon },
  ironwood: { sectionLabel: 'IRONWOOD_PROGRESS', menuLabel: 'Ironwood Migration', viewAllHref: '/ironwood', icon: MigrationIcon },
  poolsChart: { sectionLabel: 'SHIELDED_POOLS', menuLabel: 'Shielded Pool Trend', viewAllHref: '/pools', icon: ShieldedIcon },
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
 * shift risk. Defaults remain in server HTML and work without JavaScript;
 * a CSS loading state covers them until browser preferences are resolved.
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

  // Read the saved preference only after mount — the server (and the very
  // first client render) use `defaultType` so hydration matches. CSS shows
  // the placeholder before JavaScript runs, without a pre-paint script.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && FEED_ORDER.includes(saved as HomeFeedType)) {
        setType(saved as HomeFeedType);
      }
    } catch {
      // localStorage unavailable (private browsing, etc.) — just keep the default.
    } finally {
      setPreferencesReady(true);
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
  const FeedIcon = meta.icon;
  const PlaceholderIcon = FEED_META[defaultType].icon;
  const viewAllLink = (
    <Link href={meta.viewAllHref} className="text-xs sm:text-sm font-mono text-muted hover:text-primary transition-colors">
      View all
    </Link>
  );

  return (
    <div className="home-feed min-w-0" data-preferences-ready={preferencesReady}>
      <noscript>
        <style>{`
          .home-feed[data-preferences-ready="false"] > .home-feed-content { display: block; }
          .home-feed[data-preferences-ready="false"] > .home-feed-placeholder { display: none; }
        `}</style>
      </noscript>
      <div className="home-feed-placeholder">
        <div className="relative" aria-hidden="true">
          <div className="invisible">
            <SectionHeader label="LOADING_ACTIVITY" icon={<PlaceholderIcon />} size="lg" actions={
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
          icon={<FeedIcon />}
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
                  {FEED_ORDER.map((feed) => {
                    const MenuIcon = FEED_META[feed].icon;
                    return (
                      <button
                        key={feed}
                        onClick={() => select(feed)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-data dropdown-item"
                      >
                        <span className="inline-flex items-center gap-2.5">
                          <span className="flex shrink-0 text-muted" aria-hidden="true"><MenuIcon className="w-4 h-4" /></span>
                          {FEED_META[feed].menuLabel}
                        </span>
                        {feed === type && <CheckIcon />}
                      </button>
                    );
                  })}
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
