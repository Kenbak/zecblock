'use client';

export const PRIVACY_PERIODS = ['7d', '30d', '90d', '1y', 'all'] as const;
const PERIODS = PRIVACY_PERIODS;
export type Period = typeof PERIODS[number];

export function PeriodSelector({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="inline-flex gap-0 p-0.5 rounded-md bg-glass-3 flex-shrink-0">
      {PERIODS.map(p => (
        <button
          key={p}
          aria-pressed={value === p}
          onClick={() => onChange(p)}
          className={`px-1.5 py-0.5 text-caption font-mono rounded transition whitespace-nowrap ${
            value === p
              ? 'bg-brand-gold/15 text-cipher-gold font-semibold'
              : 'text-muted hover:text-primary'
          }`}
        >
          {p.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
