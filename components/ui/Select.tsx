'use client';

import type { SelectHTMLAttributes } from 'react';

/**
 * Select — the standard compact dropdown for filters. Matches PeriodPillTags
 * height (32px) and draws its own chevron so the arrow keeps consistent
 * padding across browsers instead of hugging the native edge.
 */
export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex min-w-0 ${className}`.trim()}>
      <select
        {...props}
        className="h-8 w-full min-w-0 appearance-none rounded-lg border border-cipher-border bg-cipher-bg pl-3 pr-9 text-caption font-mono text-primary transition-colors hover:border-glass-12 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold"
      >
        {children}
      </select>
      <svg aria-hidden="true" viewBox="0 0 16 16" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
