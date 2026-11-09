'use client';

import { PeriodPillTags } from '@/components/ui/PeriodPillTags';

export const PRIVACY_PERIODS = ['7d', '30d', '90d', '1y', 'all'] as const;
const PERIODS = PRIVACY_PERIODS;
export type Period = typeof PERIODS[number];

export function PeriodSelector({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <PeriodPillTags
      options={PERIODS.map(p => ({ key: p, label: p.toUpperCase() }))}
      value={value}
      onChange={onChange}
      className="flex-shrink-0"
    />
  );
}
