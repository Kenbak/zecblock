import type { ReactNode } from 'react';
import { Badge, type BadgeColor } from './Badge';
import { ShieldedIcon, ShieldingIcon, UnshieldingIcon, MigrationIcon, MixedIcon } from '@/components/icons/shield-flow';

const ICON_SIZE = 14;

const CoinbaseIcon = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9.5 9.5c0-1.1 1.12-2 2.5-2s2.5.7 2.5 1.75-1.12 1.75-2.5 1.75-2.5.7-2.5 1.75S10.62 15 12 15s2.5-.9 2.5-2" />
  </svg>
);

const TransparentIcon = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/**
 * The single categorical fact a transaction (or mempool entry) belongs to —
 * "what kind of transaction is this?" Pool identity (Sapling/Orchard/
 * Ironwood) and transaction shape (coinbase/shielding/unshielding/mixed) are
 * the SAME axis in practice: a transaction's category IS the pool it
 * touches, when it touches exactly one. This is deliberately the only place
 * in the app that decides label + color + icon for this axis — every page
 * that shows a "Type" column or badge should resolve to one of these
 * categories and render it with `TxTypeBadge`, instead of re-deciding its
 * own colors (or forgetting to pass an icon and drifting back to a loud
 * solid fill by omission).
 *
 * Anything not covered here (flow direction, confirmation status, bridge
 * in/out, privacy risk) is a genuinely separate axis and has its own
 * component — see ShieldFlowBadge, StatusBadge. Don't fold those in here;
 * that's the same mistake in the other direction (one badge trying to carry
 * two unrelated facts).
 */
export type TxCategory =
  | 'coinbase'
  | 'migration'
  | 'ironwood'
  | 'orchard'
  | 'orchard_sapling'
  | 'sapling'
  | 'sprout'
  | 'shielded'
  | 'shielding'
  | 'unshielding'
  | 'mixed'
  | 'transparent';

export const TX_CATEGORY_CONFIG: Record<TxCategory, { label: string; color: BadgeColor; icon: ReactNode }> = {
  coinbase: { label: 'COINBASE', color: 'green', icon: <CoinbaseIcon /> },
  migration: { label: 'MIGRATION', color: 'amber', icon: <MigrationIcon size={ICON_SIZE} /> },
  ironwood: { label: 'IRONWOOD', color: 'ironwood', icon: <ShieldedIcon size={ICON_SIZE} /> },
  orchard: { label: 'ORCHARD', color: 'purple', icon: <ShieldedIcon size={ICON_SIZE} /> },
  orchard_sapling: { label: 'ORCHARD+SAPLING', color: 'purple', icon: <ShieldedIcon size={ICON_SIZE} /> },
  sapling: { label: 'SAPLING', color: 'green', icon: <ShieldedIcon size={ICON_SIZE} /> },
  // Legacy pool, closed to deposits — muted, matching SHIELDED_POOLS in lib/shielded-pools.ts.
  sprout: { label: 'SPROUT', color: 'muted', icon: <ShieldedIcon size={ICON_SIZE} /> },
  // Generic "fully shielded, pool unknown/unspecified" — used where per-pool
  // detail isn't available or isn't the point (e.g. a mempool row before
  // it's clear which pool dominates). Gold identifies the aggregate privacy
  // state; individual pool badges retain their own labeled identities.
  shielded: { label: 'SHIELDED', color: 'shielded', icon: <ShieldedIcon size={ICON_SIZE} /> },
  shielding: { label: 'SHIELDING', color: 'green', icon: <ShieldingIcon size={ICON_SIZE} /> },
  unshielding: { label: 'UNSHIELDING', color: 'orange', icon: <UnshieldingIcon size={ICON_SIZE} /> },
  // Neither gets a "meaningful" color — mixed has no single direction, and
  // transparent has no shielded activity to signal. Reserving muted for
  // both keeps every other color meaningful when it does appear.
  mixed: { label: 'MIXED', color: 'muted', icon: <MixedIcon size={ICON_SIZE} /> },
  transparent: { label: 'TRANSPARENT', color: 'muted', icon: <TransparentIcon /> },
};

/**
 * Standard category resolution from pool-activity flags — same priority
 * everywhere (coinbase > mixed > ironwood > orchard+sapling > orchard >
 * sapling > generic shielded > transparent). `hasTransparent` is optional:
 * callers that don't model mixed (e.g. a pool-only Type column) simply omit
 * it and never resolve to 'mixed'.
 */
export function resolveTxCategory(input: {
  isCoinbase?: boolean;
  hasIronwood?: boolean;
  hasOrchard?: boolean;
  hasSapling?: boolean;
  hasTransparent?: boolean;
}): TxCategory {
  if (input.isCoinbase) return 'coinbase';
  const hasShielded = input.hasIronwood || input.hasOrchard || input.hasSapling;
  if (!hasShielded) return 'transparent';
  if (input.hasTransparent) return 'mixed';
  if (input.hasIronwood) return 'ironwood';
  if (input.hasOrchard && input.hasSapling) return 'orchard_sapling';
  if (input.hasOrchard) return 'orchard';
  if (input.hasSapling) return 'sapling';
  return 'shielded';
}

export function TxTypeBadge({
  category,
  icon,
  label,
  className = '',
  variant = 'subtle',
}: {
  category: TxCategory;
  /** Override the registry's default icon (rare — e.g. a caller with its own confirmed-good icon set). Most callers should omit this and get the right icon automatically. */
  icon?: ReactNode;
  /** Override the default label (e.g. a caller-specific plural/singular form) while keeping the category's color. */
  label?: string;
  className?: string;
  /**
   * Every category now carries its own icon, so 'subtle' (icon-colored,
   * neutral chip) is the default everywhere — the same calm treatment as
   * the tx-detail header. Pass 'solid' only for a context that genuinely
   * needs a louder single-glance fill.
   */
  variant?: 'solid' | 'subtle';
}) {
  const config = TX_CATEGORY_CONFIG[category];
  return (
    <Badge color={config.color} icon={icon ?? config.icon} className={className} variant={variant}>
      {label || config.label}
    </Badge>
  );
}
