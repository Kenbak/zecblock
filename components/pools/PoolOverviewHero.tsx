'use client';

import { useMemo, useState } from 'react';
import { PageLoadingBody } from '@/components/ui/PageLoading';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { zatToZec } from '@/lib/format-numbers';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ShareableCard } from '@/components/ShareableCard';
import { PoolCurrencyToggle, PoolCurrencyNote, usePoolCurrency } from './PoolCurrency';
import { SupplyTreemap } from './SupplyTreemap';
import { SupplyTimelineScrubber } from './SupplyTimelineScrubber';
import { completeSupplyHistory, type HistoryPoint } from './supply-history';
import { buildShieldedPoolSegments, buildTopLevelSegments, MAX_SUPPLY_ZAT, SHIELDED_POOL_KEYS, type SupplyPoolKey } from './supply-treemap-layout';

export interface PoolOverviewData {
  current: {
    sprout: number;
    sapling: number;
    orchard: number;
    ironwood: number;
    transparent: number;
    shielded: number;
    chainSupply: number;
    updatedAt: string;
  };
  deltas: Record<string, Record<string, number | null>>;
}



function snapshotDate(value: string, time = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}) }) + (time ? ' UTC' : '');
}

export function PoolOverviewHero({ data }: { data: PoolOverviewData }) {
  const { currency, price, format, formatSupplySegment } = usePoolCurrency();
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [hoveredKey, setHoveredKey] = useState<SupplyPoolKey | null>(null);
  const [split, setSplit] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const { data: historyRes, loading, error } = useApiQuery<{ points: HistoryPoint[] }>(
    '/v1/shielded-pools/history', { period: 'all' },
  );
  const history = useMemo(() => completeSupplyHistory(historyRes?.points ?? []), [historyRes]);
  const point = history.find(item => item.date === selectedDate);
  const snapshot = point ? {
    sprout: Math.round(point.sprout * 1e8), sapling: Math.round(point.sapling * 1e8),
    orchard: Math.round(point.orchard * 1e8), ironwood: Math.round(point.ironwood * 1e8),
    transparent: Math.round(point.transparent * 1e8), shielded: Math.round(point.shielded * 1e8),
    chainSupply: Math.round(point.chainSupply * 1e8), updatedAt: point.date,
  } : data.current;
  const topLevel = buildTopLevelSegments({ ...snapshot, colors: { transparent: colors.transparent, shielded: colors.shielded, unmined: colors.transparent } });
  const poolColors = { sprout: colors.sprout, sapling: colors.sapling, orchard: colors.orchard, ironwood: colors.ironwood };
  const children = buildShieldedPoolSegments({ ...snapshot, colors: poolColors });
  const share = snapshot.chainSupply > 0 ? snapshot.shielded / snapshot.chainSupply * 100 : null;
  const delta = !point ? data.deltas.shielded?.['7d'] : null;
  const dateLabel = snapshotDate(snapshot.updatedAt, !point);
  const toggleSplit = () => { setSplit(value => !value); setHoveredKey(null); };

  if (!topLevel.length) return <p className="py-12 text-center text-caption text-muted" role="status">
    Supply map unavailable: this snapshot has missing or inconsistent supply totals.
  </p>;

  return <ShareableCard title="Where every ZEC lives" sourceHeight={0} isLive={false}
    shareText={`${share == null ? '—' : share.toFixed(1) + '%'} of issued ZEC is held in shielded pools. Snapshot: ${dateLabel}.\n\nhttps://zecblock.com/pools`}
    fileName="zecblock-pools.png" className=""
    footerNote={`${point ? 'Historical' : 'Latest available'} snapshot · ${dateLabel}`}>
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-5">
      <p className="max-w-2xl text-xs leading-relaxed text-secondary">Public supply, shielded pools and remaining issuance. Map labels show each share of the 21 million ZEC cap. USD values cover issued supply only; unmined ZEC has no market value.</p>
      <div className="flex flex-wrap shrink-0 items-center gap-2"><PoolCurrencyToggle />
      <button type="button" aria-pressed={split} onClick={toggleSplit} className="shrink-0 self-start rounded-md border border-cipher-border px-3 py-2 text-caption font-mono text-secondary hover:bg-glass-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold">
        {split ? 'Hide pool split' : 'Show pool split'}
      </button></div>
    </div>
    <div className="overflow-hidden rounded-lg border border-cipher-border">
      <SupplyTreemap topLevel={topLevel} shieldedChildren={children} hoveredKey={hoveredKey} pinnedShielded={split} onHover={setHoveredKey} onTogglePinShielded={toggleSplit} />
    </div>
    <dl className="sm:hidden mt-4 space-y-2 text-caption font-mono">{topLevel.map(segment => <div key={segment.key} className="flex justify-between gap-2"><dt className="text-muted">{segment.label}</dt><dd className="text-secondary">{formatSupplySegment(segment)} · {(segment.zat / MAX_SUPPLY_ZAT * 100).toFixed(1)}%</dd></div>)}</dl>
    <div className="flex flex-wrap gap-x-5 gap-y-2 mt-4 text-caption font-mono text-secondary">
      <span><span className="text-primary">{share == null ? '—' : `${share.toFixed(1)}%`}</span> of issued supply is shielded</span>
      {delta != null && Number.isFinite(delta) && <span><span className={delta >= 0 ? 'text-cipher-green' : 'text-cipher-orange'}>{delta >= 0 && (currency === 'zec' || price != null) ? '+' : ''}{format(zatToZec(delta))}</span> net pool change · 7 days</span>}
    </div>
    <div className="mt-6 border-t border-cipher-border pt-5">
      <div className="flex flex-wrap justify-between gap-2 mb-3 text-caption font-mono text-muted"><span>INSIDE SHIELDED</span><span>{currency.toUpperCase()} · share of shielded supply</span></div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {SHIELDED_POOL_KEYS.map(key => <button key={key} type="button"
          onClick={() => { setSplit(true); setHoveredKey(key); }}
          onMouseEnter={() => setHoveredKey(split ? key : 'shielded')} onMouseLeave={() => setHoveredKey(null)}
          onFocus={() => setHoveredKey(split ? key : 'shielded')} onBlur={() => setHoveredKey(null)}
          aria-label={`${key}, ${format(zatToZec(snapshot[key]))}. Show in pool split.`}
          className={`min-w-0 rounded-lg p-3 text-left transition-colors hover:bg-glass-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold ${hoveredKey === key ? 'bg-glass-3' : ''}`}>
          <span className="flex items-center gap-2 text-caption text-secondary"><span className="w-2 h-2 rounded-full" style={{ background: poolColors[key] }} /><span className="capitalize">{key}</span></span>
          <span className="block mt-2 text-sm font-mono tabular-nums text-primary">{format(zatToZec(snapshot[key]))}</span>
          <span className="block mt-1 text-caption font-mono text-muted">{snapshot.shielded > 0 ? `${(snapshot[key] / snapshot.shielded * 100).toFixed(1)}%` : '—'} of shielded</span>
        </button>)}
      </div>
    </div>
    <PoolCurrencyNote />
    <SupplyTimelineScrubber historyDates={history.map(item => item.date)} scrubIndex={point ? history.indexOf(point) : history.length - 1}
      mode={point ? 'scrub' : 'live'} scrubDateLabel={point ? dateLabel : null}
      onScrub={index => setSelectedDate(history[index].date)} onLive={() => setSelectedDate(null)} />
    {history.length < 2 && <p className="mt-5 border-t border-cipher-border pt-4 text-caption text-muted" role="status">{loading ? 'Loading historical snapshots…' : error ? 'Historical snapshots are temporarily unavailable.' : 'Not enough complete historical snapshots to enable the timeline.'}</p>}
    <p className="mt-3 text-caption leading-relaxed text-muted">Pool balances are public aggregates; they do not reveal individual shielded balances. <a href="#methodology" className="underline underline-offset-4 hover:text-primary">Data &amp; definitions</a></p>
  </ShareableCard>;
}

export function PoolOverviewSkeleton() {
  return <PageLoadingBody layout="pools" />;
}
