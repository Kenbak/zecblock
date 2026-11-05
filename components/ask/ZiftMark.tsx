// Zift mark: a terminal prompt (>_), matching the site's search prompt.
// Decorative only; the product name is always present as text beside it.
export function ZiftMark({ size = 16, boxed = false, className = '' }: { size?: number; boxed?: boolean; className?: string }) {
  const mark = <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true" focusable="false" className={boxed ? undefined : `shrink-0 text-cipher-gold ${className}`}>
    <path d="M5 7l5 5-5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 17h7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>;
  return boxed ? <span className={`inline-flex shrink-0 items-center justify-center border border-cipher-border bg-cipher-surface text-cipher-gold ${className}`} aria-hidden="true">{mark}</span> : mark;
}
