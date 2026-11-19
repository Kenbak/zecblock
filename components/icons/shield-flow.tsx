import type { ReactNode, SVGProps } from 'react';

export type ShieldFlowType = 'shielded' | 'shielding' | 'unshielding' | 'mixed' | 'migration';

export const SHIELD_FLOW_LABELS: Record<ShieldFlowType, string> = {
  shielded: 'Shielded',
  shielding: 'Shielding',
  unshielding: 'Deshielding',
  mixed: 'Mixed',
  migration: 'Migration',
};

export const SHIELD_FLOW_COLORS: Record<ShieldFlowType, string> = {
  shielded: 'text-cipher-shielded',
  shielding: 'text-cipher-green',
  unshielding: 'text-cipher-orange',
  mixed: 'text-muted',
  migration: 'text-cipher-yellow',
};

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 20, className = '', children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

// This whole family draws the shield as a stroked outline rather than a
// filled shape — thinner, quieter glyph that reads well at 14-20px next to
// text in a badge without competing with the badge's own fill/border. Every
// icon shares the identical outer crest path so only the inner glyph (plain
// / up-arrow / down-arrow / through-arrow / partial fill) differs, keeping the family
// visually obviously related.
const SHIELD_OUTLINE = 'M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z';

function ShieldOutline({ children, ...props }: IconProps & { children?: ReactNode }) {
  return (
    <IconBase {...props}>
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth={1.5} fill="none" />
      {children}
    </IconBase>
  );
}

export function ShieldedIcon(props: IconProps) {
  return <ShieldOutline {...props} />;
}

export function ShieldingIcon(props: IconProps) {
  return (
    <ShieldOutline {...props}>
      <path d="M12 8v8M8 12l4-4 4 4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </ShieldOutline>
  );
}

export function UnshieldingIcon(props: IconProps) {
  return (
    <ShieldOutline {...props}>
      <path d="M12 8v8M8 12l4 4 4-4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </ShieldOutline>
  );
}

/** Same outer shield as ShieldedIcon — pool-to-pool migration is still fully
 *  shielded end to end — with a through-arrow to distinguish "moved between
 *  pools" (publicly knowable amount) from a plain shielded spend (unknowable). */
export function MigrationIcon(props: IconProps) {
  return (
    <ShieldOutline {...props}>
      <path d="M8 12h8M12 8l4 4-4 4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </ShieldOutline>
  );
}

/** Public and shielded components in one transaction, not a privacy percentage. */
export function MixedIcon(props: IconProps) {
  return (
    <ShieldOutline {...props}>
      <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91V2z" fill="currentColor" fillOpacity={0.5} />
      <path d="M12 2v20" stroke="currentColor" strokeWidth={1.5} />
    </ShieldOutline>
  );
}

export function ShieldFlowIcon({ type, size = 20, className = '' }: { type: ShieldFlowType; size?: number; className?: string }) {
  const colorClass = SHIELD_FLOW_COLORS[type];
  const merged = `${colorClass} ${className}`.trim();

  if (type === 'shielding') return <ShieldingIcon size={size} className={merged} />;
  if (type === 'unshielding') return <UnshieldingIcon size={size} className={merged} />;
  if (type === 'shielded') return <ShieldedIcon size={size} className={merged} />;
  if (type === 'migration') return <MigrationIcon size={size} className={merged} />;
  if (type === 'mixed') return <MixedIcon size={size} className={merged} />;
  return null;
}

/**
 * Map API / table row fields to a shield flow type.
 *
 * A pool-to-pool migration (e.g. Orchard -> Ironwood) has no transparent leg
 * at all, so vinCount/voutCount alone read identically to a plain, genuinely
 * unknowable fully-shielded spend (both 0/0). The two are distinguishable
 * from public data anyway: the binding-signature balance equation requires
 * one pool's valueBalance to be positive (source) and another's negative
 * (dest) in the same transaction for a migration, with nothing left over for
 * a transparent output. Pass the three pools' value balances so callers get
 * that distinction — and, downstream, a real amount instead of a redacted one.
 */
export function resolveShieldFlowType(input: {
  flowType?: string | null;
  type?: 'fully-shielded' | 'partial';
  vinCount?: number;
  voutCount?: number;
  valueBalanceSapling?: number | null;
  valueBalanceOrchard?: number | null;
  valueBalanceIronwood?: number | null;
}): ShieldFlowType {
  const ft = input.flowType?.toLowerCase();
  if (ft === 'migration') return 'migration';
  if (ft === 'shield' || ft === 'shielding') return 'shielding';
  if (ft === 'deshield' || ft === 'deshielding' || ft === 'unshielding') return 'unshielding';
  if (ft === 'fully_shielded' || ft === 'fully-shielded') return 'shielded';
  if (ft === 'mixed') return 'mixed';

  if ((input.vinCount ?? 0) === 0 && (input.voutCount ?? 0) === 0) {
    const sap = input.valueBalanceSapling || 0;
    const orc = input.valueBalanceOrchard || 0;
    const irn = input.valueBalanceIronwood || 0;
    const source = orc > 0 ? 'orchard' : sap > 0 ? 'sapling' : irn > 0 ? 'ironwood' : null;
    const dest = irn < 0 ? 'ironwood' : orc < 0 ? 'orchard' : sap < 0 ? 'sapling' : null;
    if (source && dest && source !== dest) return 'migration';
  }

  if (input.type === 'fully-shielded') return 'shielded';
  if (input.vinCount != null && input.voutCount != null) {
    if (input.vinCount === 0 && input.voutCount === 0) return 'shielded';
    if (input.vinCount > 0 && input.voutCount === 0) return 'shielding';
    if (input.vinCount === 0 && input.voutCount > 0) return 'unshielding';
  }

  return 'mixed';
}
