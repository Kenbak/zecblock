import type { ReactNode } from 'react';
import type { CalendarKind } from '@/lib/zcash-calendar';

/** One small stroke icon per event kind, so tags never rely on colour or text alone. */
export function KindIcon({ kind, className = 'h-3.5 w-3.5' }: { kind: CalendarKind; className?: string }) {
  const paths: Record<CalendarKind, ReactNode> = {
    upgrade: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
    halving: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17" /><path d="M12 12h8.5" /></>,
    vote: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12.5 2.5 2.5 4.5-5.5" /></>,
    poll: <><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m8.75 12 2.25 2.25 4.25-4.5" /></>,
    snapshot: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z" /><circle cx="12" cy="13" r="3.25" /></>,
    deadline: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
    milestone: <><path d="M6 21V4" /><path d="M6 4h11l-2 4 2 4H6" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}>{paths[kind]}</svg>;
}

