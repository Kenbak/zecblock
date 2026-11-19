'use client';

import { type ReactNode } from 'react';
import { ShareableCard } from '@/components/ShareableCard';
import { fmtValue, type CurrencyMode } from '@/hooks/useCurrencyToggle';
import type { ChartColors, Overview, PoolRow } from './types';
import { PoolBalanceRow } from './PoolBalanceRow';

export function IronwoodLedgerStat({
  icon,
  label,
  hint,
  value,
  valueColor,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="rounded-lg border border-cipher-border/25 bg-glass-3/20 px-3 py-2 sm:py-2.5">
      <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-stretch sm:gap-0">
        <div className="flex items-center gap-1.5 text-caption font-mono uppercase tracking-wide text-muted">
          {icon}
          {label}
        </div>
        <div
          className="shrink-0 text-sm font-mono font-semibold tabular-nums text-primary sm:mt-1 sm:shrink"
          style={valueColor ? { color: valueColor } : undefined}
        >
          {value}
        </div>
      </div>
      <div className="mt-1 text-caption leading-snug text-muted sm:mt-0.5">{hint}</div>
    </div>
  );
}

export function SupplyVerification({
  overview,
  colors,
  currencyMode = 'zec',
  zecPrice = null,
}: {
  overview: Overview | null;
  colors: ChartColors;
  currencyMode?: CurrencyMode;
  zecPrice?: number | null;
}) {
  const audit = overview?.supplyAudit;
  const pools = overview?.poolSizes;
  if (!audit || !pools) return null;

  const totalSupply = pools.chainSupplyZat;

  // Fold deferred/lockbox into transparent (not a separate pool)
  const transparentZat = (pools.transparentZat ?? 0) + (pools.deferredZat ?? 0);

  const poolRows: PoolRow[] = [];
  if (transparentZat > 0) {
    poolRows.push({ name: 'Transparent', zat: transparentZat, pct: 0, color: colors.transparent, category: 'transparent' });
  }
  if (pools.sproutZat > 0) {
    poolRows.push({ name: 'Sprout', zat: pools.sproutZat, pct: 0, color: colors.sprout, category: 'shielded' });
  }
  if (pools.saplingZat > 0) {
    poolRows.push({ name: 'Sapling', zat: pools.saplingZat, pct: 0, color: colors.sapling, category: 'shielded' });
  }
  poolRows.push({ name: 'Orchard', zat: pools.orchardZat, pct: 0, color: colors.orchardPool, category: 'shielded' });
  poolRows.push({ name: 'Ironwood', zat: pools.ironwoodZat, pct: 0, color: colors.ironwoodPool, highlight: true, category: 'shielded' });

  const transparentPools = poolRows.filter((r) => r.category === 'transparent');
  const shieldedPools = poolRows.filter((r) => r.category === 'shielded');

  const computedTotal = poolRows.reduce((sum, r) => sum + r.zat, 0);
  const displayTotal = totalSupply ?? computedTotal;
  poolRows.forEach((r) => { r.pct = displayTotal > 0 ? (r.zat / displayTotal) * 100 : 0; });

  const MAX_SUPPLY_ZAT = 2_100_000_000_000_000;
  const unminedZat = MAX_SUPPLY_ZAT - displayTotal;
  const supplySum = displayTotal + unminedZat;
  const supplyBalanced = supplySum === MAX_SUPPLY_ZAT;

  const poolSum = computedTotal;
  const supplyMatch = totalSupply != null ? poolSum === totalSupply : null;

  // Use server-computed supply verification (single source of truth)
  // When Zebra RPC is unavailable, supplyVerification will be null — show only pool data
  const sv = overview?.supplyVerification;
  const hasSupplyData = sv != null && sv.chainSupplyZat != null;
  const verifiedPct = hasSupplyData ? sv.verifiedPct : null;

  // Exact server proportion. Invalid or unavailable data must never draw a fake split.
  const validVerifiedPct = verifiedPct != null && Number.isFinite(verifiedPct) && verifiedPct >= 0 && verifiedPct <= 100
    ? verifiedPct : null;
  const shareText = validVerifiedPct != null
    ? `${validVerifiedPct.toFixed(1)}% of Zcash supply turnstile-verified.\n\nhttps://zecblock.com/ironwood`
    : `Zcash Ironwood migration tracker\n\nhttps://zecblock.com/ironwood`;

  return (
    <div id="supply" className="scroll-mt-20">
      <ShareableCard
        title="Zcash supply verification"
        sourceHeight={pools.sourceHeight}
        isLive={pools.isLive}
        shareText={shareText}
        fileName="zecblock-supply.png"
      >
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_3fr] lg:grid-cols-[5fr_7fr] gap-6 sm:gap-10 lg:gap-14 items-center">
        <div className="w-full py-4">
          <p className="text-xs font-mono text-muted mb-3">TURNSTILE_VERIFICATION</p>
          <p className="text-4xl font-mono font-medium tracking-tight text-primary tabular-nums">
            {validVerifiedPct != null ? `${validVerifiedPct.toFixed(1)}%` : '—'}
          </p>
          <p className="text-sm text-secondary mt-2 mb-6">
            {validVerifiedPct != null ? 'of chain supply turnstile-verified' : 'Supply verification unavailable'}
          </p>
          {validVerifiedPct != null && (
            <>
              <div className="flex h-3 w-full overflow-hidden bg-cipher-hover" role="img"
                aria-label={`${validVerifiedPct}% verified; ${100 - validVerifiedPct}% pending Orchard verification`}>
                <div style={{ width: `${validVerifiedPct}%`, backgroundColor: colors.verifiedRing }} />
                <div style={{ width: `${100 - validVerifiedPct}%`, backgroundColor: colors.orchardPool }} />
              </div>
              <div className="flex justify-between mt-3 gap-4 text-xs font-mono text-secondary">
                <span>Verified <span className="text-primary">{validVerifiedPct.toFixed(1)}%</span></span>
                <span>Pending <span className="text-cipher-purple">{(100 - validVerifiedPct).toFixed(1)}%</span></span>
              </div>
              <p className="mt-5 text-xs text-muted leading-relaxed">The remaining Orchard balance is pending turnstile verification. Bar lengths show the actual proportions.</p>
            </>
          )}
        </div>

        {/* Right: Pool breakdown */}
        <div className="w-full min-w-0 sm:space-y-1 sm:pl-2 lg:pl-4">
          <div className="flex items-center justify-between mb-1.5 sm:mb-3 px-0.5">
            <a href="/pools" title="Balances over time on Shielded Pools" className="text-xs font-semibold text-primary underline decoration-cipher-border underline-offset-4 hover:decoration-current">Pool balances</a>
            {supplyMatch != null && (
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${supplyMatch ? 'bg-cipher-green animate-pulse' : 'bg-danger'}`} />
                <span className={`text-caption font-mono ${supplyMatch ? 'text-cipher-green' : 'text-danger'}`}>
                  {supplyMatch ? 'No inflation' : 'Mismatch'}
                </span>
              </div>
            )}
          </div>
          <div className="divide-y divide-cipher-border/15 sm:divide-y-0">
            {transparentPools.map((row) => (
              <PoolBalanceRow key={row.name} row={row} currencyMode={currencyMode} zecPrice={zecPrice} />
            ))}
            {transparentPools.length > 0 && shieldedPools.length > 0 && (
              <div className="my-1 border-t border-cipher-border-subtle sm:my-2" aria-hidden="true" />
            )}
            {shieldedPools.map((row) => (
              <PoolBalanceRow key={row.name} row={row} currencyMode={currencyMode} zecPrice={zecPrice} />
            ))}
          </div>
          <div className="flex items-center justify-between pt-1.5 mt-1 border-t border-cipher-border/30 px-2 sm:px-3">
            <span className="text-caption sm:text-xs text-secondary">Mined</span>
            <span className="text-caption sm:text-sm font-mono text-primary">{fmtValue(displayTotal, currencyMode, zecPrice)}</span>
          </div>
          <div className="flex items-center justify-between px-2 sm:px-3 py-0.5 sm:py-1">
            <span className="text-caption sm:text-xs text-secondary">Unmined</span>
            <span className="text-caption sm:text-sm font-mono text-primary">{fmtValue(unminedZat, currencyMode, zecPrice)}</span>
          </div>
          <div className="flex items-center justify-between pt-1.5 mt-1 border-t border-cipher-border/30 px-2 sm:px-3">
            <div className="flex items-center gap-2">
              <span className="text-caption sm:text-xs font-semibold text-primary">Max supply</span>
              {supplyBalanced && <span className="w-1.5 h-1.5 rounded-full bg-cipher-green" />}
            </div>
            <span className="text-caption sm:text-sm font-mono font-semibold text-primary">{fmtValue(MAX_SUPPLY_ZAT, currencyMode, zecPrice)}</span>
          </div>
        </div>
      </div>
    </ShareableCard>
    </div>
  );
}
