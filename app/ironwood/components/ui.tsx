'use client';

import Link from 'next/link';
import { FilterGroup, FilterButton } from '@/components/ui/FilterGroup';

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <FilterGroup inline className={className}>
      {options.map(({ id, label }) => (
        <FilterButton key={id} active={value === id} onClick={() => onChange(id)}>
          {label}
        </FilterButton>
      ))}
    </FilterGroup>
  );
}

export function KpiRow({
  label,
  value,
  hint,
  href,
  scrollTo,
  toneColor,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  scrollTo?: string;
  toneColor?: string;
}) {
  const className =
    'group flex items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-cipher-hover active:bg-cipher-hover';

  const body = (
    <>
      <div className="min-w-0">
        <div className="font-mono text-caption text-primary">{label}</div>
        {hint ? (
          <div className="mt-0.5 truncate font-mono text-caption text-muted group-hover:text-muted">{hint}</div>
        ) : null}
      </div>
      <div
        className="shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-primary"
        style={toneColor ? { color: toneColor } : undefined}
      >
        {value}
      </div>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }

  if (scrollTo) {
    return (
      <a href={scrollTo} className={className}>
        {body}
      </a>
    );
  }

  return <div className={className}>{body}</div>;
}

export function KpiCell({
  label,
  value,
  hint,
  href,
  scrollTo,
  toneColor,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  scrollTo?: string;
  toneColor?: string;
}) {
  const className =
    'group min-w-0 px-3 py-3 transition-colors hover:bg-cipher-hover sm:px-4 sm:py-3.5';

  const body = (
    <>
      <div
        className="text-base font-semibold font-mono tabular-nums text-primary lg:text-lg"
        style={toneColor ? { color: toneColor } : undefined}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate font-mono text-caption uppercase tracking-wider text-muted">{label}</div>
      {hint ? (
        <div className="mt-0.5 truncate font-mono text-caption text-muted group-hover:text-muted">
          {hint}
        </div>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }

  if (scrollTo) {
    return (
      <a href={scrollTo} className={className}>
        {body}
      </a>
    );
  }

  return <div className={className}>{body}</div>;
}

export function EmptyPanel({
  activated,
  message,
}: {
  activated: boolean;
  message?: string;
}) {
  return (
    <div className="h-[140px] flex items-center justify-center rounded-lg border border-dashed border-cipher-border/50 bg-glass-3">
      <p className="text-xs text-muted font-mono">
        {message ?? (activated ? 'No migrations indexed yet' : 'Populates at activation')}
      </p>
    </div>
  );
}
