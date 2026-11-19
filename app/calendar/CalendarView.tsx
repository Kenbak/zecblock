'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { KindIcon } from '@/components/CalendarKindIcon';
import { CALENDAR_KINDS, daysUntilLabel, estimateHeightAtTime, formatCalendarDate, heightAnchors, type CalendarEvent, type CalendarKind, type HeightAnchor } from '@/lib/zcash-calendar';

const DAY = 86_400_000;

const KIND_TEXT: Record<CalendarKind, string> = {
  upgrade: 'text-brand-gold', halving: 'text-cipher-purple', vote: 'text-cipher-green', poll: 'text-cipher-green', snapshot: 'text-cipher-green', deadline: 'text-secondary', milestone: 'text-secondary',
};
const KIND_BORDER: Record<CalendarKind, string> = {
  upgrade: 'border-brand-gold/50', halving: 'border-cipher-purple/50', vote: 'border-cipher-green/50', poll: 'border-cipher-green/50', snapshot: 'border-cipher-green/50', deadline: 'border-cipher-border', milestone: 'border-cipher-border',
};

function KindTag({ kind }: { kind: CalendarKind }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-caption uppercase tracking-wider ${KIND_BORDER[kind]} ${KIND_TEXT[kind]}`}>
    <KindIcon kind={kind} className="h-3 w-3" />{CALENDAR_KINDS[kind].label}
  </span>;
}

function useNow(initial: number) {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function relative(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d >= 365) return `${(d / 365).toFixed(1)} years`;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

const shortTitle = (title: string) => title.replace(/^(Q\d) \d{4} grants: /, '$1 grants · ').replace(/^NU7 vote: /, 'NU7 vote · ');

function HeightLink({ event }: { event: CalendarEvent }) {
  if (event.height === null) return <span className="text-muted">—</span>;
  return <Link href={`/block/${event.height}`} prefetch={false} className="hover:text-brand-gold">{event.heightEstimated ? '≈ ' : ''}#{event.height.toLocaleString('en-US')}</Link>;
}

function EventTitle({ event }: { event: CalendarEvent }) {
  if (!event.href) return <>{event.title}</>;
  if (event.external) return <a href={event.href} target="_blank" rel="noopener noreferrer" className="hover:text-brand-gold">{event.title} <span aria-hidden="true" className="text-muted">↗</span></a>;
  return <Link href={event.href} className="hover:text-brand-gold">{event.title}</Link>;
}

type Props = { events: CalendarEvent[]; tip: number | null; tipTime: number | null; spacing: number | null; eras: { height: number; seconds: number }[]; generatedAt: number };

export function CalendarView({ events, tip, tipTime, spacing, eras, generatedAt }: Props) {
  const now = useNow(generatedAt);
  const next = events.filter(e => e.status === 'upcoming').slice(0, 3);
  const anchors = heightAnchors(events, tip, tipTime);

  return <div className="space-y-8">
    <section aria-labelledby="next-up">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 id="next-up" className="font-mono text-xs uppercase tracking-wider text-muted">Next up</h2>
        {tip !== null && <p className="font-mono text-caption text-muted">Now at <Link href={`/block/${tip}`} prefetch={false} className="text-primary hover:text-brand-gold">block #{tip.toLocaleString('en-US')}</Link>{spacing ? ` · ${spacing}s blocks` : ''}</p>}
      </div>
      {next.length === 0 ? <p className="rounded-xl border border-dashed border-cipher-border p-4 text-sm text-muted">No upcoming milestones are scheduled yet.</p> :
        <ol className="grid gap-3 md:grid-cols-3">{next.map(event => <li key={event.id} className={`flex flex-col rounded-xl border bg-cipher-card p-4 ${KIND_BORDER[event.kind]}`}>
          <div className="flex items-center justify-between gap-2"><KindTag kind={event.kind} /><span className="font-mono text-caption text-muted"><HeightLink event={event} /></span></div>
          <h3 className="mt-3 text-sm font-semibold text-primary"><EventTitle event={event} /></h3>
          <p className="mt-1 flex-1 text-xs leading-relaxed text-secondary">{event.detail}</p>
          <p className="mt-3 text-2xl font-semibold tabular-nums text-primary">{event.time === null ? '—' : event.dateOnly ? daysUntilLabel(event.time, now) : relative(event.time - now)}</p>
          <p className="mt-1 font-mono text-caption text-muted">{formatCalendarDate(event)}</p>
        </li>)}</ol>}
    </section>

    {tip !== null && tipTime !== null && anchors.length > 1 && <BlockRibbon events={events} anchors={anchors} tip={tip} tipTime={tipTime} spacing={spacing} eras={eras} />}

    <Agenda events={events} tip={tip} now={now} />
  </div>;
}

type Zoom = 'month' | 'quarter' | 'year' | 'all';
const ZOOMS: { id: Zoom; label: string; before: number; after: number }[] = [
  { id: 'month', label: 'Month', before: 14, after: 31 },
  { id: 'quarter', label: 'Quarter', before: 60, after: 60 },
  { id: 'year', label: 'Year', before: 270, after: 120 },
  { id: 'all', label: 'All time', before: Infinity, after: Infinity },
];

/** A timeline whose axis is block height: eras, date ticks, the tip, and every milestone as a pin. */
function BlockRibbon({ events, anchors, tip, tipTime, spacing, eras }: { events: CalendarEvent[]; anchors: HeightAnchor[]; tip: number; tipTime: number; spacing: number | null; eras: { height: number; seconds: number }[] }) {
  const [zoom, setZoom] = useState<Zoom>('quarter');
  const scroller = useRef<HTMLDivElement>(null);
  const z = ZOOMS.find(item => item.id === zoom)!;
  const nowMs = tipTime * 1000;
  const lastExact = Math.max(tip, ...events.filter(e => e.height !== null).map(e => e.height!));
  const lo = z.before === Infinity ? 0 : estimateHeightAtTime(anchors, nowMs - z.before * DAY, spacing) ?? 0;
  const hi = z.after === Infinity ? Math.round(lastExact * 1.03) : estimateHeightAtTime(anchors, nowMs + z.after * DAY, spacing) ?? tip;
  const x = (h: number) => (h - lo) / (hi - lo) * 100;
  const inView = events.filter(e => e.height !== null && e.height >= lo && e.height <= hi);

  // Date ticks: month starts when zoomed in, year starts when zoomed out.
  const ticks: { label: string; left: number }[] = [];
  const yearly = zoom === 'year' || zoom === 'all';
  const first = new Date(nowMs - (z.before === Infinity ? 11 * 365 * DAY : z.before * DAY));
  const last = new Date(nowMs + (z.after === Infinity ? 3 * 365 * DAY : z.after * DAY));
  for (let d = new Date(Date.UTC(first.getUTCFullYear(), yearly ? 0 : first.getUTCMonth(), 1)); d <= last;
    d = new Date(Date.UTC(d.getUTCFullYear() + (zoom === 'all' ? 2 : yearly ? 1 : 0), d.getUTCMonth() + (yearly ? 0 : 1), 1))) {
    const h = estimateHeightAtTime(anchors, d.getTime(), spacing);
    if (h === null || h < lo || h > hi) continue;
    ticks.push({ label: yearly ? String(d.getUTCFullYear()) : d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', ...(d.getUTCMonth() === 0 ? { year: 'numeric' } : {}) }), left: x(h) });
  }

  // Greedy label rows (two above, two below the axis); a label that cannot fit keeps its pin and tooltip.
  const rowEnds = [-Infinity, -Infinity, -Infinity, -Infinity];
  const placed = inView.map(event => {
    const left = x(event.height!);
    const width = 16;
    const row = rowEnds.findIndex(end => left - width / 2 > end + 0.5);
    if (row >= 0) rowEnds[row] = left + width / 2;
    return { event, left, row };
  });

  const eraBands = eras.map((era, i) => ({ from: Math.max(lo, era.height), to: Math.min(hi, eras[i + 1]?.height ?? Infinity), seconds: era.seconds })).filter(b => b.to > b.from);

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = ((tip - lo) / (hi - lo)) * el.scrollWidth - el.clientWidth / 2;
  }, [tip, lo, hi]);

  return <section aria-labelledby="block-ribbon" className="rounded-xl border border-cipher-border bg-cipher-card">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cipher-border-subtle p-3 sm:p-4">
      <div>
        <h2 id="block-ribbon" className="font-mono text-xs uppercase tracking-wider text-muted">The chain, block by block</h2>
        <p className="mt-0.5 font-mono text-caption text-muted">#{lo.toLocaleString('en-US')} → {hi > tip ? '≈ ' : ''}#{hi.toLocaleString('en-US')}</p>
      </div>
      <div className="inline-flex rounded-lg border border-cipher-border p-0.5" role="group" aria-label="Zoom">
        {ZOOMS.map(item => <button key={item.id} type="button" aria-pressed={zoom === item.id} onClick={() => setZoom(item.id)} className={`rounded-md px-2.5 py-1 text-xs transition-colors ${zoom === item.id ? 'bg-brand-gold/10 text-brand-gold' : 'text-secondary hover:text-primary'}`}>{item.label}</button>)}
      </div>
    </div>
    <div ref={scroller} className="no-scrollbar overflow-x-auto">
      <div className="relative mx-6 h-[300px] min-w-[760px]" role="list" aria-label="Milestones by block height">
        {eraBands.map(band => <div key={band.from} aria-hidden="true" className={`absolute top-[132px] h-3 border-l border-cipher-border ${band.seconds === 25 ? 'bg-brand-gold/25' : band.seconds === 75 ? 'bg-cipher-border' : 'bg-cipher-border/50'}`} style={{ left: `${x(band.from)}%`, width: `${x(band.to) - x(band.from)}%` }}>
          <span className="absolute left-1.5 top-4 whitespace-nowrap font-mono text-caption text-muted">{band.seconds}s blocks</span>
        </div>)}
        {ticks.map(t => <span key={`${t.label}-${t.left}`} aria-hidden="true" className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap font-mono text-caption text-muted" style={{ left: `${t.left}%` }}>
          <span className="mx-auto mb-1 block h-2 w-px bg-cipher-border" />{t.label}
        </span>)}
        {tip >= lo && tip <= hi && <div aria-hidden="true" className="absolute bottom-7 top-2 w-px bg-brand-gold/70" style={{ left: `${x(tip)}%` }}>
          <span className={`absolute top-[106px] whitespace-nowrap rounded bg-cipher-surface px-1 font-mono text-caption text-brand-gold ${x(tip) > 80 ? 'right-1' : 'left-1'}`}>Now · #{tip.toLocaleString('en-US')}</span>
        </div>}
        {placed.map(({ event, left, row }) => {
          const above = row === 0 || row === 2;
          const far = row >= 2;
          const edge = left > 88 ? 'right-0 text-right' : left < 12 ? 'left-0 text-left' : 'left-1/2 -translate-x-1/2 text-center';
          return <div role="listitem" key={event.id} className="absolute top-0 h-full" style={{ left: `${left}%` }}>
            {row >= 0 && <span aria-hidden="true" className={`absolute w-px bg-cipher-border ${above ? (far ? 'top-[46px] h-[82px]' : 'top-[96px] h-[32px]') : (far ? 'top-[148px] h-[72px]' : 'top-[148px] h-[22px]')}`} />}
            <Link href={`/block/${event.height}`} prefetch={false} title={`${event.title} · ${event.heightEstimated ? '≈ ' : ''}#${event.height!.toLocaleString('en-US')} · ${formatCalendarDate(event)}`}
              className={`absolute top-[128px] flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border bg-cipher-surface transition-transform hover:scale-125 ${KIND_BORDER[event.kind]} ${KIND_TEXT[event.kind]}`}>
              <KindIcon kind={event.kind} className="h-3 w-3" /><span className="sr-only">{event.title}, block {event.height}</span>
            </Link>
            {row >= 0 && <span aria-hidden="true" className={`absolute whitespace-nowrap text-caption leading-tight ${edge} ${above ? (far ? 'top-[14px]' : 'top-[64px]') : (far ? 'top-[220px]' : 'top-[170px]')}`}>
              <span className="text-primary">{shortTitle(event.title)}</span>
              <span className="block font-mono text-muted">{event.heightEstimated ? '≈' : ''}#{event.height!.toLocaleString('en-US')}</span>
            </span>}
          </div>;
        })}
      </div>
    </div>
    <p className="border-t border-cipher-border-subtle px-4 py-2.5 text-caption text-muted">Distance is measured in blocks, so 25-second blocks spread time three times wider than 75-second blocks. Click a pin to open its block; ≈ marks an estimated future block.</p>
  </section>;
}

function Agenda({ events, tip, now }: { events: CalendarEvent[]; tip: number | null; now: number }) {
  const [kind, setKind] = useState<CalendarKind | 'all'>('all');
  const kinds = (Object.keys(CALENDAR_KINDS) as CalendarKind[]).filter(k => events.some(e => e.kind === k));
  const filtered = events.filter(e => (kind === 'all' || e.kind === kind) && e.time !== null);
  const month = (e: CalendarEvent) => new Date(e.time!).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const group = (list: CalendarEvent[]) => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of list) map.set(month(e), [...(map.get(month(e)) ?? []), e]);
    return [...map.entries()];
  };
  const ahead = group(filtered.filter(e => e.status === 'upcoming'));
  const behind = group(filtered.filter(e => e.status === 'past').reverse());

  return <section aria-labelledby="agenda">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 id="agenda" className="font-mono text-xs uppercase tracking-wider text-muted">Agenda</h2>
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto" role="group" aria-label="Filter milestones">
        {(['all', ...kinds] as const).map(k => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${kind === k ? 'border-brand-gold/40 bg-brand-gold/10 text-brand-gold' : 'border-cipher-border text-secondary hover:text-primary'}`}>
          {k !== 'all' && <KindIcon kind={k} className="h-3 w-3" />}{k === 'all' ? 'All' : CALENDAR_KINDS[k].plural}
        </button>)}
      </div>
    </div>
    <div className="overflow-hidden rounded-xl border border-cipher-border">
      {ahead.map(([label, items]) => <MonthGroup key={`a-${label}`} label={label} items={items} now={now} />)}
      <div className="flex items-center gap-3 border-b border-cipher-border-subtle bg-brand-gold/5 px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-brand-gold ring-4 ring-brand-gold/20" aria-hidden="true" />
        <span className="font-mono text-xs text-brand-gold">Now{tip !== null ? <> · <Link href={`/block/${tip}`} prefetch={false} className="hover:underline">block #{tip.toLocaleString('en-US')}</Link></> : ''}</span>
      </div>
      {behind.map(([label, items]) => <MonthGroup key={`b-${label}`} label={label} items={items} now={now} />)}
    </div>
  </section>;
}

function MonthGroup({ label, items, now }: { label: string; items: CalendarEvent[]; now: number }) {
  return <div>
    <p className="border-b border-cipher-border-subtle bg-cipher-surface px-4 py-2 font-mono text-caption uppercase tracking-wider text-muted">{label}</p>
    <ul>{items.map(event => {
      const date = new Date(event.time!);
      return <li key={event.id} id={event.id} className="grid scroll-mt-40 grid-cols-[3.25rem_minmax(0,1fr)] gap-3 border-b border-cipher-border-subtle px-4 py-3 sm:grid-cols-[3.75rem_minmax(0,1fr)_11rem] sm:items-center">
        <div className="text-center">
          <p className="font-mono text-caption uppercase text-muted">{date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })}</p>
          <p className={`text-xl font-semibold tabular-nums ${event.status === 'upcoming' ? 'text-primary' : 'text-secondary'}`}>{event.timeEstimated ? '≈' : ''}{date.getUTCDate()}</p>
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-primary">
            <span className={KIND_TEXT[event.kind]}><KindIcon kind={event.kind} className="h-4 w-4" /></span><EventTitle event={event} />
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-secondary">{event.detail}</p>
          <p className="mt-1 font-mono text-caption text-muted sm:hidden">{agendaWhen(event, now)} · <HeightLink event={event} /></p>
        </div>
        <div className="hidden text-right font-mono text-xs sm:block">
          <p className="text-primary"><HeightLink event={event} /></p>
          <p className="mt-0.5 text-caption text-muted">{agendaWhen(event, now)}</p>
        </div>
      </li>;
    })}</ul>
  </div>;
}

function agendaWhen(event: CalendarEvent, now: number) {
  const time = event.dateOnly || event.timeEstimated ? '' : `${new Date(event.time!).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} UTC`;
  if (event.status === 'upcoming' && event.time !== null) {
    const days = event.dateOnly ? daysUntilLabel(event.time, now) : null;
    const when = days === 'Today' || days === 'Tomorrow' ? days.toLowerCase() : `in ${days ?? relative(event.time - now)}`;
    return `${time ? `${time} · ` : ''}${when}`;
  }
  return time || (event.timeEstimated ? 'estimated date' : 'all day');
}
