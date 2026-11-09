'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { CURRENCY, isCrosslink, isMainnet } from '@/lib/config';
import { SlidersIcon } from '@/components/icons/common';
import { HASHRATE_DESCRIPTION, type HashrateSnapshot } from '@/lib/hashrate';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useZecBtcQuote } from '@/hooks/useZecBtcQuote';
import { btcPercentage } from '@/lib/zec-btc';

interface StatsData {
  blockHeight: number | null;
  mempoolCount: number | null;
  hashrate: string | null;
  avgBlockTime: number | null;
  price: number | null;
  change24h: number | null;
  privacyScore: number | null;
  shieldedPool: number | null;
  shieldedPct: number | null;
  totalTxs: number | null;
  ironwoodPool: number | null;
  ironwoodPct: number | null;
}

type StatId =
  | 'block'
  | 'blockTime'
  | 'hashrate'
  | 'mempool'
  | 'totalTxs'
  | 'shieldedPool'
  | 'shieldedPct'
  | 'privacyScore'
  | 'ironwoodPool'
  | 'ironwoodPct'
  | 'price'
  | 'zecBtc';

// Canonical display order — filtering by selection never reorders the bar,
// so toggling one stat off and back on doesn't shuffle the others.
const STAT_ORDER: StatId[] = [
  'block',
  'blockTime',
  'hashrate',
  'mempool',
  'totalTxs',
  'shieldedPool',
  'shieldedPct',
  'ironwoodPool',
  'ironwoodPct',
  'privacyScore',
  'price',
  ...(isMainnet ? ['zecBtc' as const] : []),
];

const STAT_MENU_LABELS: Record<StatId, string> = {
  block: 'Block',
  blockTime: 'Block Time',
  hashrate: 'Hashrate',
  mempool: 'Mempool',
  totalTxs: 'Total TXs',
  shieldedPool: 'Shielded Pool',
  shieldedPct: 'Shielded TXs · all time',
  ironwoodPool: 'Ironwood Pool',
  ironwoodPct: '% Migrated',
  privacyScore: 'Privacy Score',
  price: `${CURRENCY} Price`,
  zecBtc: 'ZEC / BTC',
};

// Measured (not guessed) against the bar's real available width — see the
// widths comment on MAX_STATS. Shielded Pool + % Shielded both stay in the
// default set deliberately: cutting either undersells the one thing that
// actually differentiates this explorer from a generic chain scanner.
const DEFAULT_STATS: StatId[] = ['block', 'mempool', 'hashrate', 'shieldedPool', 'shieldedPct', 'price'];

// Hard cap, not a soft target. The bar's content area caps at ~1216px on
// any viewport ≥ the `lg` breakpoint (it lives in the same max-w-7xl
// container as everything else, so a bigger monitor doesn't buy more room).
// Measured real widths at 1440px: Block 123 / Block Time 107 / Hashrate 139
// / Mempool 76 / Total TXs 115 / Shielded Pool 170 / % Shielded 154 /
// Privacy Score 154 / Price 143 — 8 of the 9 already overflowed that budget
// by 96px there, and by 287px at 1920px once Privacy Score also appeared.
// 6 items lands around ~950px including gaps/separators: comfortable margin
// even as block heights/prices grow more digits over time.
const MAX_STATS = 6;
const STORAGE_KEY = 'cipherscan-stats-bar-selection';

function isValidStatId(value: unknown): value is StatId {
  return typeof value === 'string' && (STAT_ORDER as string[]).includes(value);
}

function formatCompact(num: number): string {
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(0)}K`;
  return num.toLocaleString();
}

function StatItem({ href, label, title, children }: { href: string; label: string; title?: string; children: React.ReactNode }) {
  return (
    <Link href={href} title={title} className="flex items-center gap-1.5 text-xs sm:text-data font-mono text-muted hover:text-primary transition-colors whitespace-nowrap">
      <span className="text-muted">{label}</span>
      <span className="text-secondary">{children}</span>
    </Link>
  );
}

function Sep() {
  return <span aria-hidden="true" className="h-3 border-l border-cipher-border mx-0.5 sm:mx-0" />;
}

const CheckIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

export function StatsBar() {
  const [stats, setStats] = useState<StatsData>({
    blockHeight: null,
    mempoolCount: null,
    hashrate: null,
    avgBlockTime: null,
    price: null,
    change24h: null,
    privacyScore: null,
    shieldedPool: null,
    shieldedPct: null,
    totalTxs: null,
    ironwoodPool: null,
    ironwoodPct: null,
  });

  const blocksQuery = useApiQuery<Array<{ height: number | string }>>(
    '/v1/blocks',
    { limit: 1 },
    { refreshInterval: 30_000 },
  );
  const mempoolQuery = useApiQuery<{
    success?: boolean;
    count?: number;
    transactions?: unknown[];
  }>('/v1/mempool', undefined, { refreshInterval: 30_000 });
  const priceQuery = useApiQuery<{ price?: number; change24h?: number }>(
    '/v1/network/price',
    undefined,
    { refreshInterval: 30_000 },
  );
  const networkQuery = useApiQuery<{
    mining?: { networkHashrate?: string; avgBlockTime?: number; hashrateEstimate?: HashrateSnapshot };
    network?: { height?: number };
    supply?: { ironwood?: number; totalShielded?: number };
  }>('/v1/network/stats', undefined, {
    enabled: !isCrosslink,
    refreshInterval: 30_000,
  });
  const privacyQuery = useApiQuery<{
    success?: boolean;
    data?: {
      metrics?: { privacyScore?: number; shieldedPercentage?: number };
      shieldedPool?: { currentSize?: number };
      totals?: { totalTx?: number };
    };
    metrics?: { privacyScore?: number; shieldedPercentage?: number };
    shieldedPool?: { currentSize?: number };
    totals?: { totalTx?: number };
  }>('/v1/privacy/stats', undefined, {
    enabled: !isCrosslink,
    refreshInterval: 30_000,
  });

  // Server render + first client paint always show DEFAULT_STATS — no
  // hydration mismatch — then this swaps in the visitor's own saved
  // selection, same pattern as the homepage's HomeFeedCard.
  const [selected, setSelected] = useState<StatId[]>(DEFAULT_STATS);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btcQuery = useZecBtcQuote(isMainnet && selected.includes('zecBtc'));
  const btcPercent = btcPercentage(btcQuery.quote?.btcPerZec);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(isValidStatId).slice(0, MAX_STATS);
        if (valid.length > 0) setSelected(valid);
      }
    } catch {
      // localStorage unavailable or corrupted — keep the default.
    }
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleStat = (id: StatId) => {
    setSelected((prev) => {
      const isSelected = prev.includes(id);
      let next: StatId[];
      if (isSelected) {
        next = prev.filter((s) => s !== id);
      } else {
        if (prev.length >= MAX_STATS) return prev; // at cap — no-op, checkbox stays disabled
        next = [...prev, id];
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Selection just won't persist — still applies for this session.
      }
      return next;
    });
  };

  // Fade whichever edge(s) have more content off-screen — never fade an edge
  // that's already fully at rest (e.g. don't fade "Block" while scrollLeft is 0).
  // Still relevant on narrow/mobile widths even with the 6-stat cap; the cap
  // guarantees no scroll on desktop, not on every phone width.
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Expose measured bar height for sticky offsets below it (Ironwood banner) —
  // the bar's height changes across breakpoints (h-10 sm:h-11), so a static
  // CSS var would drift out of sync the way --app-nav-height would without this.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const syncStatsHeight = () => {
      document.documentElement.style.setProperty('--app-stats-height', `${bar.offsetHeight}px`);
    };

    syncStatsHeight();
    const observer = new ResizeObserver(syncStatsHeight);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const updateScrollFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollFade();
    el.addEventListener('scroll', updateScrollFade, { passive: true });
    const resizeObserver = new ResizeObserver(updateScrollFade);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollFade);
      resizeObserver.disconnect();
    };
    // Re-check once stats finish loading, since that's what changes content width.
  }, [updateScrollFade, stats, selected, btcQuery.quote, btcQuery.delayed]);

  const scrollFadeClass = canScrollLeft && canScrollRight
    ? 'stats-bar-fade-both'
    : canScrollLeft
      ? 'stats-bar-fade-left'
      : canScrollRight
        ? 'stats-bar-fade-right'
        : '';

  useEffect(() => {
    setStats((current) => {
      const next = { ...current };
      const latestBlock = blocksQuery.data?.[0];
      if (latestBlock) next.blockHeight = Number(latestBlock.height);
      if (mempoolQuery.data) {
        next.mempoolCount = mempoolQuery.data.count
          ?? mempoolQuery.data.transactions?.length
          ?? 0;
      }
      if (priceQuery.data?.price != null) next.price = priceQuery.data.price;
      if (priceQuery.data?.change24h != null) next.change24h = priceQuery.data.change24h;

      const network = networkQuery.data;
      if (network?.mining?.networkHashrate) next.hashrate = network.mining.networkHashrate;
      if (network?.mining?.avgBlockTime) next.avgBlockTime = network.mining.avgBlockTime;
      if (network?.network?.height && !next.blockHeight) next.blockHeight = network.network.height;
      if (network?.supply?.ironwood) next.ironwoodPool = network.supply.ironwood;
      if (network?.supply?.ironwood && network.supply.totalShielded) {
        next.ironwoodPct = (network.supply.ironwood / network.supply.totalShielded) * 100;
      }

      const privacy = privacyQuery.data;
      if (privacy?.metrics?.privacyScore != null) next.privacyScore = privacy.metrics.privacyScore;
      if (privacy?.metrics?.shieldedPercentage != null) {
        next.shieldedPct = privacy.metrics.shieldedPercentage;
      }
      if (privacy?.shieldedPool?.currentSize != null) {
        next.shieldedPool = privacy.shieldedPool.currentSize;
      }
      if (privacy?.totals?.totalTx != null) next.totalTxs = privacy.totals.totalTx;
      return next;
    });
  }, [
    blocksQuery.data,
    mempoolQuery.data,
    networkQuery.data,
    priceQuery.data,
    privacyQuery.data,
  ]);

  const hasAnyData = stats.blockHeight !== null || stats.price !== null;

  const renderStat = (id: StatId): React.ReactNode => {
    switch (id) {
      case 'block':
        return stats.blockHeight !== null ? (
          <StatItem href="/blocks" label="Block">#{stats.blockHeight.toLocaleString()}</StatItem>
        ) : null;
      case 'blockTime':
        return stats.avgBlockTime !== null ? (
          <StatItem href="/network" label="Block Time">{stats.avgBlockTime}s</StatItem>
        ) : null;
      case 'hashrate':
        return stats.hashrate ? (
          <StatItem href="/network" label="Hashrate · 24h" title={`${HASHRATE_DESCRIPTION}${networkQuery.data?.mining?.hashrateEstimate ? ` As of ${networkQuery.data.mining.hashrateEstimate.asOf}` : ''}`}>{networkQuery.data?.mining?.hashrateEstimate ? networkQuery.data.mining.networkHashrate : '—'}</StatItem>
        ) : null;
      case 'mempool':
        return stats.mempoolCount !== null ? (
          <StatItem href="/mempool" label="Mempool">
            <span className="flex items-center gap-1">
              {stats.mempoolCount > 0 && (
                <span className="relative flex h-1 w-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cipher-green opacity-50"></span>
                  <span className="relative inline-flex rounded-full h-1 w-1 bg-cipher-green"></span>
                </span>
              )}
              {stats.mempoolCount}
            </span>
          </StatItem>
        ) : null;
      case 'totalTxs':
        return stats.totalTxs !== null ? (
          <StatItem href="/txs" label="Total TXs">{formatCompact(stats.totalTxs)}</StatItem>
        ) : null;
      case 'shieldedPool':
        return stats.shieldedPool !== null ? (
          <StatItem href="/pools" label="Shielded Pool">{formatCompact(stats.shieldedPool)} {CURRENCY}</StatItem>
        ) : null;
      case 'shieldedPct':
        return stats.shieldedPct !== null ? (
          <StatItem href="/privacy" label="Shielded TXs · all time" title="All-time shielded transactions divided by non-coinbase transactions">{stats.shieldedPct.toFixed(1)}%</StatItem>
        ) : null;
      case 'privacyScore':
        return stats.privacyScore !== null ? (
          <StatItem href="/privacy" label="Privacy Score">
            <span className={stats.privacyScore < 30 ? 'text-danger' : stats.privacyScore < 60 ? 'text-warning' : 'text-cipher-green'}>
              {stats.privacyScore}/100
            </span>
          </StatItem>
        ) : null;
      case 'ironwoodPool':
        return stats.ironwoodPool !== null ? (
          <StatItem href="/ironwood" label="Ironwood">{formatCompact(stats.ironwoodPool)} {CURRENCY}</StatItem>
        ) : null;
      case 'ironwoodPct':
        return stats.ironwoodPct !== null ? (
          <StatItem href="/ironwood" label="% Migrated">{stats.ironwoodPct.toFixed(1)}%</StatItem>
        ) : null;
      case 'price':
        return stats.price !== null ? (
          <StatItem href="/network" label={CURRENCY}>
            <span className="flex items-center gap-1">
              <span>${stats.price.toFixed(2)}</span>
              {stats.change24h !== null && (
                <span className={stats.change24h >= 0 ? 'text-cipher-green' : 'text-danger'}>
                  [{stats.change24h >= 0 ? '↑' : '↓'}{Math.abs(stats.change24h).toFixed(1)}%]
                </span>
              )}
            </span>
          </StatItem>
        ) : null;
      case 'zecBtc':
        return isMainnet ? (
          <StatItem href="/valuation#zec-btc" label="ZEC/BTC" title={`One ZEC as a percentage of one BTC · CoinGecko${btcQuery.quote?.observedAt ? ` · ${new Date(btcQuery.quote.observedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC` : ''} · ${btcPercent === null ? 'Quote unavailable' : btcQuery.delayed ? 'Delayed quote' : 'View chart'}`}>
            {btcPercent === null ? '—' : `${btcPercent.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: btcPercent < 0.01 ? 6 : 2 })}%`}
            {btcPercent !== null && btcQuery.delayed && <span className="text-muted"> · delayed</span>}
          </StatItem>
        ) : null;
      default:
        return null;
    }
  };

  const visibleItems = STAT_ORDER
    .filter((id) => selected.includes(id))
    .map((id) => ({ id, node: renderStat(id) }))
    .filter((item) => item.node !== null);

  return (
    <div ref={barRef} className="stats-bar backdrop-blur-xl sticky top-[var(--app-nav-height,4rem)] z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-9 sm:h-10 items-center gap-2">
          <div
            ref={scrollRef}
            /* Left-anchored, sharing the edge held by the logo, hero and feeds.
               Centering it left a visible staircase against that column. */
            className={`${scrollFadeClass} flex-1 min-w-0 flex items-center overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch] no-scrollbar`}
          >
            <div className="flex items-center gap-3 sm:gap-4 pr-4">
              {visibleItems.map(({ id, node }, i) => (
                <span key={id} className="flex items-center gap-3 sm:gap-4">
                  {node}
                  {i < visibleItems.length - 1 && <Sep />}
                </span>
              ))}
            </div>

            {/* Skeleton */}
            {!hasAnyData && (
              <div className="flex items-center gap-4 w-full">
                <div className="h-3 w-24 rounded bg-cipher-hover animate-pulse" />
                <div className="h-3 w-16 rounded bg-cipher-hover animate-pulse" />
                <div className="h-3 w-20 rounded bg-cipher-hover animate-pulse" />
                <div className="h-3 w-16 rounded bg-cipher-hover animate-pulse" />
                <div className="h-3 w-24 rounded bg-cipher-hover animate-pulse" />
              </div>
            )}
          </div>

          {/* Pinned outside the scrollable strip — never scrolls away with the stats. */}
          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Customize stats bar"
              aria-expanded={menuOpen}
              className={`inline-flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
                menuOpen ? 'text-primary bg-cipher-hover' : 'text-muted hover:text-primary'
              }`}
            >
              <SlidersIcon className="w-3.5 h-3.5" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-60 dropdown-menu rounded-lg shadow-xl border p-1 z-30 animate-scale-in origin-top-right">
                <div className="px-3 py-2 text-caption font-mono text-muted uppercase tracking-widest">
                  Show up to {MAX_STATS} · {selected.length}/{MAX_STATS} selected
                </div>
                {STAT_ORDER.map((id) => {
                  const isChecked = selected.includes(id);
                  const isDisabled = !isChecked && selected.length >= MAX_STATS;
                  return (
                    <button
                      key={id}
                      onClick={() => toggleStat(id)}
                      disabled={isDisabled}
                      aria-pressed={isChecked}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-data dropdown-item ${
                        isDisabled ? 'opacity-40 cursor-not-allowed' : ''
                      }`}
                    >
                      {STAT_MENU_LABELS[id]}
                      {isChecked && <CheckIcon />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
