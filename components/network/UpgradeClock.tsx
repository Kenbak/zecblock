'use client';

import { useEffect, useState } from 'react';

const UNITS = [['days', 86_400], ['hours', 3_600], ['minutes', 60], ['seconds', 1]] as const;

/**
 * Ticking estimate toward a target time. The target moves as the arrival
 * estimate refreshes, so this is labelled an estimate, not a deadline.
 */
export function UpgradeClock({ target }: { target: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remaining = now === null ? null : Math.max(0, Math.floor((Date.parse(target) - now) / 1000));
  let rest = remaining ?? 0;
  const parts = UNITS.map(([unit, size]) => {
    const value = Math.floor(rest / size);
    rest -= value * size;
    return { unit, value };
  });

  return <div className="flex justify-center gap-2 sm:gap-4" role="timer" aria-live="off"
    aria-label={remaining === null ? 'Estimated time remaining' : `Estimated ${parts.map(p => `${p.value} ${p.unit}`).join(', ')} remaining`}>
    {parts.map(({ unit, value }) => <div key={unit} className="min-w-[4.25rem] sm:min-w-[5.5rem] rounded-xl border border-cipher-border bg-glass-3 px-2 py-3 sm:py-4">
      <span className="block text-3xl sm:text-5xl font-semibold tracking-tight text-primary tabular-nums font-mono">
        {remaining === null ? '--' : <span key={value} className="countdown-digit">{String(value).padStart(2, '0')}</span>}
      </span>
      <span className="block mt-1 text-caption font-mono uppercase tracking-wider text-muted">{unit}</span>
    </div>)}
  </div>;
}
