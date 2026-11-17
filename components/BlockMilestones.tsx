'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { NETWORK } from '@/lib/config';
import { CALENDAR_KINDS, eventsNearBlock, formatCalendarDate, type CalendarEvent } from '@/lib/zcash-calendar';
import { KindIcon } from '@/components/CalendarKindIcon';

let feed: Promise<CalendarEvent[]> | null = null;
function loadEvents(): Promise<CalendarEvent[]> {
  feed ??= fetch('/api/calendar').then(r => r.ok ? r.json() : { events: [] }).then(d => Array.isArray(d?.events) ? d.events as CalendarEvent[] : []).catch(() => { feed = null; return []; });
  return feed;
}

/** Upgrades and the NU7 snapshot already have the dedicated upgrade banner. */
const COVERED = (event: CalendarEvent) => event.kind === 'upgrade' || event.id === 'nu7-snapshot';

/**
 * Calendar milestones at this block: exact-height events (halvings, vote
 * snapshots, the real block where a deadline passed) and, for future blocks,
 * dated events expected within about half a day.
 */
export function BlockMilestones({ height, future = false, spacing = 25 }: { height: number; future?: boolean; spacing?: number | null }) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    if (NETWORK !== 'mainnet') return;
    let live = true;
    void loadEvents().then(all => {
      if (!live) return;
      const exact = all.filter(e => e.height === height && !e.heightEstimated && !COVERED(e));
      const near = future && spacing ? eventsNearBlock(all, height, Math.round(43_200 / spacing)).filter(e => e.heightEstimated) : [];
      setEvents([...exact, ...near.filter(e => !exact.includes(e))]);
    });
    return () => { live = false; };
  }, [height, future, spacing]);
  if (events.length === 0) return null;
  return <section aria-label="Zcash milestones at this block" className="mb-6 rounded-xl border border-cipher-border bg-cipher-surface p-4 sm:p-5">
    <ul className="space-y-3">
      {events.map(event => <li key={event.id} className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cipher-border text-brand-gold"><KindIcon kind={event.kind} className="h-4 w-4" /></span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-primary">
            {event.href ? event.external ? <a href={event.href} target="_blank" rel="noopener noreferrer" className="hover:text-brand-gold">{event.title} ↗</a> : <Link href={event.href} className="hover:text-brand-gold">{event.title}</Link> : event.title}
            <span className="rounded border border-cipher-border px-1.5 py-0.5 font-mono text-caption uppercase tracking-wider text-secondary">{event.heightEstimated ? 'Expected near this block' : CALENDAR_KINDS[event.kind].label}</span>
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-secondary">{event.detail}</p>
          <p className="mt-1 font-mono text-caption text-muted">
            {formatCalendarDate(event)}
            {!event.heightEstimated && event.anchorKind === 'dated' ? ' · first block at or after this time' : ''}
            {event.heightEstimated && event.height !== null ? ` · ≈ #${event.height.toLocaleString('en-US')}` : ''}
            {' · '}<Link href="/calendar" className="hover:text-primary">Zcash calendar →</Link>
          </p>
        </div>
      </li>)}
    </ul>
  </section>;
}
