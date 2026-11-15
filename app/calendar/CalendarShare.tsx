'use client';

import { useCallback } from 'react';
import { ChartShareControl } from '@/components/charts/ChartShareControl';

/** Shares the live calendar card (/cards/calendar/image): next milestone countdown and the ones after it. */
export function CalendarShare() {
  const capture = useCallback(async () => {
    const response = await fetch('/cards/calendar/image');
    if (!response.ok) throw new Error('Calendar card unavailable');
    return response.blob();
  }, []);
  return <ChartShareControl title="Zcash calendar" shareUrl="https://zecblock.com/calendar" shareText="What's next on Zcash: upgrades, votes and deadlines, block by block" fileName="zecblock-calendar.png" capture={capture} menuAlignClassName="left-0 sm:left-auto sm:right-0" />;
}
