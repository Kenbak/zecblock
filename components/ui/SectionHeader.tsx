import { ReactNode } from 'react';
import Link from 'next/link';

/**
 * PageHeader — the standard page-level header.
 *
 * Renders the `> EYEBROW` mono label, the page H1, and an optional subtitle.
 * Use on every top-level page so titles stay visually identical app-wide.
 *
 * Do not hand-roll this pattern in pages; if a page needs an extra control
 * next to the title, pass it via `actions`.
 */
export function PageHeader({
  eyebrow,
  eyebrowHref,
  title,
  subtitle,
  actions,
  children,
  className = '',
  titleAsHeading = true,
}: {
  /** Mono uppercase label, e.g. "MINING" — rendered as "> MINING" */
  eyebrow: string;
  /** Optional parent link, using the standard eyebrow instead of a separate back row. */
  eyebrowHref?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional right-aligned controls (count, export button, period selector, ...) */
  actions?: ReactNode;
  /** Optional extra header content rendered below the title row (quote, banner) */
  children?: ReactNode;
  className?: string;
  /**
   * Render the title as a plain element instead of the page H1.
   *
   * Only for `loading.tsx` skeletons: Next streams the loading fallback and
   * the resolved page into the *same* initial HTML response, so a skeleton
   * that emits its own `<h1>` puts two H1s on the page — which breaks the
   * one-H1-per-document rule in AGENTS.md. The skeleton still shows the real
   * title (it must, or the shell is a thin duplicate page); it just isn't a
   * second heading in the outline.
   */
  titleAsHeading?: boolean;
}) {
  const Title = titleAsHeading ? 'h1' : 'div';
  return (
    <div className={`mb-8 animate-fade-in ${className}`}>
      <p className="type-label text-muted uppercase mb-3">
        <span className="opacity-50" aria-hidden="true">{'>'}</span> {eyebrowHref ? <Link href={eyebrowHref} className="rounded-sm underline decoration-cipher-border underline-offset-4 transition-colors hover:text-primary hover:decoration-current">{eyebrow}</Link> : eyebrow}
      </p>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Title className="type-page text-primary font-sans">{title}</Title>
          {subtitle && (
            <div className="type-prose text-secondary mt-3 max-w-2xl font-sans">{subtitle}</div>
          )}
        </div>
        {actions && <div className="min-w-0 max-w-full shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

const LABEL_SIZE = {
  /** Default — a sub-page's own card/list section label (/mining, /pools, /mempool). */
  sm: 'text-sm',
  /** A page's primary top-level landmarks (e.g. the homepage), which need more
   *  separation from the data-table column headers sitting directly below them
   *  than a sub-page's in-card section label does. */
  lg: 'text-base',
} as const;

/**
 * SectionHeader — the standard in-page section header.
 *
 * Renders `> LABEL` in mono with an optional live-pulse dot and a right-side
 * actions slot (filters, period pills, icon buttons). Matches the pattern
 * used on /mining, /pools, /mempool.
 */
export function SectionHeader({
  label,
  live = false,
  actions,
  size = 'sm',
  className = '',
}: {
  /** Mono uppercase section label, e.g. "POOL_RANKING" */
  label: string;
  /** Show a green pulsing dot after the label (live data sections) */
  live?: boolean;
  actions?: ReactNode;
  /** 'lg' for a page's primary top-level sections; default 'sm' matches every other SectionHeader. */
  size?: keyof typeof LABEL_SIZE;
  className?: string;
}) {
  return (
    <div className={`flex items-start sm:items-center justify-between gap-2 mb-4 flex-wrap ${className}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted font-mono uppercase tracking-widest opacity-50">{'>'}</span>
        <h2 className={`${LABEL_SIZE[size]} font-semibold font-mono text-primary uppercase tracking-wide`}>
          {label}
        </h2>
        {live && (
          <span className="relative flex h-2 w-2" aria-label="Live">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cipher-green opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cipher-green" />
          </span>
        )}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
