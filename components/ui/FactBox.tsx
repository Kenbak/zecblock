'use client';

import { ReactNode } from 'react';
import { CURRENCY } from '@/lib/config';
import { formatZecExact } from '@/lib/format-numbers';
import { HashLink } from '@/components/ui/HashLink';
import { CopyButton } from '@/components/CopyButton';
import { Tooltip } from '@/components/Tooltip';

/**
 * Every fact across the block AND transaction pages renders through this —
 * same label style, same padding, same box — instead of each page mixing
 * its own metric-card strip with a separate label:value list. One visual
 * language, shared, rather than two pages that happen to look similar.
 *
 * Deliberately transparent, no `.card` (glass bg + blur) of its own — this
 * already lives inside an outer <Card>, so a second background here just
 * covers the outer card's own glass surface. A plain border is enough to
 * divide facts into cells while keeping the outer glass fully visible.
 */
export function FactBox({
  label,
  tooltip,
  children,
  span = false,
  fit = false,
  hug = false,
  className = '',
}: {
  label: string;
  tooltip?: string;
  children: ReactNode;
  /** Full-width in the 2-column grid — for boxes with more content (breakdowns, tag + hex toggle). */
  span?: boolean;
  /** Flex item sharing its row with other `fit` boxes, all forced to equal width regardless of content — for a row of facts that should read as uniform columns (e.g. the block page's Hash/Timestamp/Size/Transactions/Fees strip). */
  fit?: boolean;
  /** Flex item sized to its own content instead of stretched equal-width — for a row of facts with genuinely different amounts of content (e.g. "Size" next to "Block", which holds a link + count + badge), where forcing equal width just pads the shorter ones with empty space. */
  hug?: boolean;
  /** Escape hatch for one-off placement overrides (mobile order/col-span, or a wider sm+ share via a page-specific class in globals.css) that don't belong in every FactBox's API. */
  className?: string;
}) {
  return (
    <div
      // `fit`'s flex-basis: 0% overrides Tailwind's w-full for sizing purposes,
      // but `hug`'s flex-basis: auto instead resolves back to that leftover
      // width: 100% (per the flexbox spec, an explicit width IS the used
      // flex-basis when flex-basis is auto) — sm:w-auto clears it so content
      // sizing actually takes effect instead of every hug box still
      // stretching to a full row like `fit` does.
      className={`rounded-xl border border-cipher-border/70 p-3.5 ${span ? 'sm:col-span-2' : ''} ${fit ? 'w-full fact-box-fit' : ''} ${hug ? 'w-full sm:w-auto fact-box-hug' : ''} ${className}`.trim()}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-caption font-mono text-muted uppercase tracking-widest">{label}</span>
        {tooltip && <Tooltip content={tooltip} />}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Truncated hash + an always-visible copy button — never a hover-to-reveal affordance the user has to discover. */
export function CopyableHash({
  value,
  href,
  colorClass = 'text-secondary',
  textSize = 'text-xs sm:text-sm',
}: {
  value: string;
  href?: string;
  colorClass?: string;
  textSize?: string;
}) {
  // Only a real link should visually react to hover — a hash with no href
  // renders as plain <code> (see HashLink), and giving it a hover color
  // would suggest it's clickable when it isn't. The underline covers the
  // case where colorClass is already text-primary at rest (e.g. the reward
  // breakdown addresses), where hover:text-primary alone is invisible.
  const hoverClass = href ? 'hover:text-primary hover:underline transition-colors' : '';

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {/*
        block + min-w-0 + truncate: the hash itself is already a fixed-length
        pre-truncated string, but a flex item's default min-width is its
        content's own intrinsic width, not 0 — so if this box gets squeezed
        narrower than that (e.g. paired half-width on mobile), the text was
        overflowing past its own shrunk box and visually painting over the
        copy button instead of actually getting any narrower. This makes it
        a real block-level box that can shrink and ellipsis-clip instead.
      */}
      <HashLink value={value} href={href} lead={10} tail={8} responsive copy={false} linkClassName={`font-mono ${textSize} ${colorClass} ${hoverClass} block min-w-0 truncate`} />
      <CopyButton text={value} size="xs" />
    </div>
  );
}

export function BoldZec({ value, accent = 'text-primary', size = 'base', exact = false }: { value: number; accent?: string; size?: 'base' | 'lg'; exact?: boolean }) {
  const valueSize = size === 'lg' ? 'text-lg sm:text-xl' : 'text-sm sm:text-base';
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`${valueSize} font-semibold font-mono tabular-nums ${accent}`}>{exact ? formatZecExact(value) : value.toFixed(4)}</span>
      <span className="text-xs text-muted">{CURRENCY}</span>
    </div>
  );
}
