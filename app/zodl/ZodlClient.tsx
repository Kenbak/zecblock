'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useUrlState } from '@/lib/use-url-state';
import { ExportButton } from '@/components/ExportButton';
import { zatToZecString } from '@/lib/csv';

// The server snapshot revalidates every 15 minutes; poll at the same cadence.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const PERIODS = [
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '6m', label: '6M' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'ALL' },
];

const SORTS = [
  { key: 'held', label: 'Most stacked' },
  { key: 'shielded', label: 'Most shielded' },
  { key: 'offramp', label: 'Most off-ramped' },
  { key: 'blocks', label: 'Most blocks' },
];

// Destination segment palette
const SEG = {
  held: { color: 'var(--color-text-muted)', label: 'Held' },
  shielded: { color: 'var(--color-shielded-state)', label: 'Shielded' },
  offramp: { color: '#E2A66E', label: 'Exchange / bridge' },
  other: { color: '#6B7280', label: 'Other transparent' },
};

interface PoolRow {
  pool: string;
  earnedZat: string;
  spentZat: string;
  heldZat: string;
  shieldedZat: string;
  exchangeZat: string;
  bridgeZat: string;
  otherZat: string;
  blocks: number;
  activeDays: number;
  classifiedDays: number;
  holdRatio: number;
  sellRatio: number;
  shieldedRatio: number;
  offrampRatio: number;
  otherRatio: number;
}
interface Summary {
  totalEarnedZat: string;
  totalHeldZat: string;
  totalSpentZat: string;
  totalShieldedZat: string;
  totalOfframpZat: string;
  networkHoldRatio: number;
  networkShieldedRatio: number;
  networkOfframpRatio: number;
  poolCount: number;
}
export interface ZodlData {
  period: string;
  pools: PoolRow[];
  summary: Summary | null;
  message?: string;
}

function zec(zat: string | number): number {
  return Number(BigInt(typeof zat === 'number' ? Math.round(zat) : zat)) / 1e8;
}
function fmtZec(zat: string): string {
  const z = zec(zat);
  if (Math.abs(z) >= 1000) return `${Math.round(z).toLocaleString()}`;
  return z.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function ZodlClient({
  initialData,
  initialFetchedAt,
  initialPeriod,
}: {
  initialData: ZodlData | null;
  initialFetchedAt?: number;
  initialPeriod: string;
}) {
  const [period, setPeriod] = useUrlState<string>('period', initialPeriod, PERIODS.map((option) => option.key));
  const [sortKey, setSortKey] = useState<'held' | 'shielded' | 'offramp' | 'blocks'>('held');
  const seeded = period === initialPeriod && initialData !== null;
  const { data, loading, isRefreshing, error } = useApiQuery<ZodlData>(
    '/v1/mining/zodl-leaderboard',
    { period },
    {
      initialData: seeded ? initialData : undefined,
      initialFetchedAt: seeded ? initialFetchedAt : undefined,
      refreshInterval: REFRESH_INTERVAL_MS,
    },
  );

  const pools = useMemo(() => {
    const list = [...(data?.pools || [])];
    const big = (z: string) => BigInt(z);
    list.sort((a, b) => {
      if (sortKey === 'held') return Number(big(b.heldZat) - big(a.heldZat));
      if (sortKey === 'shielded') return Number(big(b.shieldedZat) - big(a.shieldedZat));
      if (sortKey === 'offramp') {
        const off = (p: PoolRow) => big(p.exchangeZat) + big(p.bridgeZat);
        return Number(off(b) - off(a));
      }
      return b.blocks - a.blocks;
    });
    return list;
  }, [data, sortKey]);

  const summary = data?.summary;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs font-mono text-muted mb-4">
        <Link href="/" className="hover:text-primary transition-colors">Dashboard</Link>
        <span className="opacity-40">/</span>
        <Link href="/mining" className="hover:text-primary transition-colors">Mining</Link>
      </div>

      {/* Header */}
      <h1 className="type-page text-primary">Miner ZODL Leaderboard</h1>
      <p className="text-sm text-secondary mt-2 max-w-3xl leading-relaxed">
        Every block mints new ZEC for whoever mined it. We follow the <span className="text-primary font-semibold">first move</span> those rewards make: still <span className="text-primary font-semibold">held</span>, swept into the <span className="text-cipher-shielded font-semibold">shielded pool</span>, or sent straight to an <span style={{ color: SEG.offramp.color }} className="font-semibold">exchange or bridge</span>. These are observed first moves, not proof of a sale or of the miner&apos;s intent.
      </p>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-5 mb-6">
        <div className="inline-flex gap-1 p-1 rounded-lg bg-glass-3">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-3 py-1 text-caption font-mono rounded-md transition ${
                period === p.key ? 'bg-cipher-yellow/15 text-cipher-yellow-bright font-semibold' : 'text-muted hover:text-secondary'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="inline-flex gap-1 p-1 rounded-lg bg-glass-3 overflow-x-auto">
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSortKey(s.key as any)}
              className={`px-3 py-1 text-caption font-mono rounded-md transition whitespace-nowrap ${
                sortKey === s.key ? 'bg-white/5 text-primary font-semibold border border-white/10' : 'text-muted hover:text-secondary border border-transparent'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {pools.length > 0 && (
          <div className="sm:ml-auto">
            <ExportButton
              type="csv"
              data={pools}
              filename={`zecblock-miner-zodl-${data?.period ?? period}`}
              csvHeaders={['Pool', 'Blocks', 'Active days', 'Classified days', 'Earned (ZEC)', 'Held (ZEC)', 'Spent (ZEC)', 'Shielded (ZEC)', 'To exchange (ZEC)', 'To bridge (ZEC)', 'Other (ZEC)', 'holdRatio', 'shieldedRatio', 'offrampRatio', 'sellRatio', 'otherRatio']}
              csvMapper={(row: PoolRow) => [
                row.pool, String(row.blocks), String(row.activeDays), String(row.classifiedDays),
                zatToZecString(row.earnedZat), zatToZecString(row.heldZat), zatToZecString(row.spentZat), zatToZecString(row.shieldedZat),
                zatToZecString(row.exchangeZat), zatToZecString(row.bridgeZat), zatToZecString(row.otherZat),
                String(row.holdRatio), String(row.shieldedRatio), String(row.offrampRatio), String(row.sellRatio), String(row.otherRatio),
              ]}
            />
          </div>
        )}
        {(loading || isRefreshing) && <span className="text-caption font-mono text-cipher-gold animate-pulse">updating…</span>}
        {error && data && !isRefreshing && (
          <span role="status" className="text-caption font-mono text-muted">Couldn&apos;t refresh. Showing the last loaded leaderboard.</span>
        )}
      </div>

      {error && !data && !loading && (
        <div role="status" className="rounded-xl border border-cipher-border bg-cipher-surface p-10 text-center mb-5">
          <p className="text-sm text-secondary">The leaderboard couldn&apos;t be loaded. It will retry automatically.</p>
        </div>
      )}

      {/* Summary */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Rewards mined', value: `${fmtZec(summary.totalEarnedZat)} ZEC`, color: 'text-primary' },
            { label: 'Held (unspent)', value: `${(summary.networkHoldRatio * 100).toFixed(1)}%`, color: 'text-secondary' },
            { label: 'Shielded', value: `${(summary.networkShieldedRatio * 100).toFixed(1)}%`, color: 'text-cipher-shielded' },
            { label: 'To exchange / bridge', value: `${(summary.networkOfframpRatio * 100).toFixed(1)}%`, color: '', style: { color: SEG.offramp.color } },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-cipher-border bg-cipher-surface p-4 min-w-0">
              <div className={`text-base sm:text-xl font-semibold font-mono tabular-nums whitespace-nowrap ${s.color}`} style={(s as any).style}>{s.value}</div>
              <div className="text-caption text-muted uppercase tracking-wider mt-1 font-mono truncate">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-caption font-mono text-muted">
        {Object.values(SEG).map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>

      {/* Leaderboard */}
      {data?.message ? (
        <div className="rounded-xl border border-cipher-border bg-cipher-surface p-10 text-center">
          <p className="text-sm text-secondary">{data.message}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {pools.map((p, i) => {
            const segs = [
              { ...SEG.held, pct: p.holdRatio * 100, zat: p.heldZat },
              { ...SEG.shielded, pct: p.shieldedRatio * 100, zat: p.shieldedZat },
              { ...SEG.offramp, pct: p.offrampRatio * 100, zat: (BigInt(p.exchangeZat) + BigInt(p.bridgeZat)).toString() },
              { ...SEG.other, pct: p.otherRatio * 100, zat: p.otherZat },
            ];
            return (
              <div
                key={p.pool}
                className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 rounded-xl border border-cipher-border bg-cipher-surface px-4 py-3"
              >
                <div className="flex items-center gap-3 sm:w-[200px] sm:flex-shrink-0">
                  <div className={`w-6 text-sm font-mono font-semibold ${i < 3 ? 'text-cipher-yellow-bright' : 'text-muted'}`}>{i + 1}</div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-primary truncate">{p.pool}</div>
                    <div className="text-caption text-muted font-mono">{fmtZec(p.earnedZat)} ZEC · {p.blocks.toLocaleString()} blocks</div>
                  </div>
                </div>

                {/* stacked destination bar */}
                <div className="flex-1 min-w-0">
                  <div className="flex h-3.5 rounded-full overflow-hidden bg-glass-3">
                    {segs.map((s) => s.pct > 0 ? (
                      <div
                        key={s.label}
                        style={{ width: `${s.pct}%`, backgroundColor: s.color }}
                        title={`${s.label}: ${s.pct.toFixed(1)}% · ${fmtZec(s.zat)} ZEC`}
                      />
                    ) : null)}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-caption font-mono text-muted">
                    {segs.filter((s) => s.pct >= 0.5).map((s) => (
                      <span key={s.label}>
                        <span style={{ color: s.color }}>●</span> {s.label.split(' ')[0]} {s.pct.toFixed(0)}%
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Methodology */}
      <div className="mt-8 rounded-xl border border-cipher-border bg-cipher-surface p-5">
        <h3 className="text-xs font-mono font-semibold text-secondary uppercase tracking-wider mb-2">How we read it</h3>
        <p className="text-xs text-muted leading-relaxed">
          We attribute each coinbase reward to a pool by its payout address, then trace where those coins go when spent.
          <span className="text-secondary"> Held</span> = never spent. <span className="text-cipher-shielded">Shielded</span> = swept into the shielded pool — a privacy move, not a sale, and likely still the miner&apos;s. <span style={{ color: SEG.offramp.color }}>Exchange / bridge</span> = sent to a labeled off-ramp, the clearest &ldquo;sold&rdquo; signal. <span className="text-secondary">Other transparent</span> = moved to an unlabeled address (rotation, cold storage, payouts) or not yet classified. We track the <span className="text-secondary">first hop</span> only: a pool that shields and later deshields to sell shows up here as &ldquo;shielded&rdquo; — where that money goes next is tracked on the <Link href="/turnstile" className="text-cipher-gold hover:underline">turnstile</Link> page. It&apos;s a directional read from public coinbase spends and our address labels, not an exact treasury.
        </p>
      </div>
    </div>
  );
}
