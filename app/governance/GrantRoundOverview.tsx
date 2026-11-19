import Link from 'next/link';
import { GRANT_CATEGORIES, PARTICIPATION_MINIMUM_ZEC, formatUsd, formatUsdCompact, grantPhase, grantTotals, type GrantRound } from '@/lib/grant-rounds';

const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

const PHASE_COPY = {
  submissions: 'Submissions are open.',
  between: 'Submissions are closed and proposals are locked. Community review opens next.',
  review: 'Proposals are locked and in the 30-day community review. Ask questions in each proposal’s forum thread.',
  'awaiting-vote': 'Review has closed. Voting is scheduled to open next.',
  voting: 'Voting is scheduled now. The vote appears here once it is registered on the voting chain.',
  closed: 'The scheduled voting period has ended.',
} as const;

/** Server-rendered round header: phase stepper and headline numbers. */
export const PHASE_LABEL = { submissions: 'Open for submissions', between: 'Review opens next', review: 'In community review', 'awaiting-vote': 'Vote next', voting: 'Voting period', closed: 'Closed' } as const;

/**
 * `header` renders the round's own status row (round pages). Cards that
 * already name the round pass header={false} to show only the schedule.
 * `catalogHref` turns the status into the action for the current phase.
 */
export function GrantRoundStepper({ round, now, registered = false, header = true, catalogHref }: { round: GrantRound; now: number; registered?: boolean; header?: boolean; catalogHref?: string }) {
  const { phase, step } = grantPhase(round, now);
  const s = round.schedule;
  const steps = [
    { label: 'Submissions', dates: `${day(s.submissionsOpen)} – ${day(s.submissionsClose)}` },
    { label: 'Community review', dates: `${day(s.reviewOpen)} – ${day(s.reviewClose)}` },
    { label: 'Coinholder vote', dates: `${day(s.votingOpensOn)} – ${day(s.votingClose)}` },
  ];
  const reviewable = catalogHref && (phase === 'between' || phase === 'review' || phase === 'awaiting-vote');
  return <div className={header ? 'rounded-xl border border-cipher-border bg-cipher-card' : ''}>
    {header && <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
      <div>
        <p className="font-mono text-caption uppercase tracking-wider text-muted">{round.quarter} · Coinholder-Directed Retroactive Grants</p>
        <p className="mt-1 text-sm text-secondary">{registered ? 'The ballot is registered on the voting chain.' : PHASE_COPY[phase]}</p>
      </div>
      {reviewable
        ? <a href={catalogHref} className="inline-flex shrink-0 rounded-md border border-brand-gold/40 bg-brand-gold/10 px-3 py-1.5 text-xs font-medium text-brand-gold hover:bg-brand-gold/15">Review the {round.proposals.length} proposals ↓</a>
        : <span className="inline-flex shrink-0 rounded-md border border-brand-gold/30 bg-brand-gold/5 px-2 py-1 font-mono text-caption uppercase tracking-wider text-brand-gold">{PHASE_LABEL[phase]}</span>}
    </div>}
    <ol className={`grid grid-cols-3 ${header ? 'border-t' : 'border-y'} border-cipher-border-subtle`} aria-label="Round schedule">
      {steps.map((item, i) => {
        const done = i < step;
        const current = i === step || (phase === 'between' && i === 1) || (phase === 'awaiting-vote' && i === 2);
        return <li key={item.label} aria-current={current ? 'step' : undefined} className={`relative px-3 py-3 sm:px-5 sm:py-4 ${i > 0 ? 'border-l border-cipher-border-subtle' : ''}`}>
          <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-0.5 ${done ? 'bg-brand-gold/60' : current ? 'bg-brand-gold' : 'bg-transparent'}`} />
          <p className={`flex items-center gap-1.5 text-xs font-medium sm:text-sm ${current ? 'text-brand-gold' : done ? 'text-primary' : 'text-secondary'}`}>
            <span aria-hidden="true" className="font-mono">{done ? '✓' : `0${i + 1}`}</span>{item.label}
          </p>
          <p className="mt-1 font-mono text-caption text-muted">{item.dates}</p>
        </li>;
      })}
    </ol>
    <p className="flex flex-wrap justify-between gap-2 border-t border-cipher-border-subtle px-4 py-2.5 text-caption text-muted sm:px-5">
      <span>Deadlines at 20:00 UTC · Voting start time to be confirmed</span>
      <a href={round.callForProposals} target="_blank" rel="noopener noreferrer" className="hover:text-secondary">Official schedule (FPF) ↗</a>
    </p>
  </div>;
}

export function GrantRoundStats({ round }: { round: GrantRound }) {
  const totals = grantTotals(round);
  const max = Math.max(...totals.byCategory.map(c => c.requestedUsd), 1);
  const largest = [...round.proposals].sort((a, b) => b.requestedUsd - a.requestedUsd)[0];
  return <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-cipher-border bg-cipher-border">
      {[
        ['Proposals', String(totals.count), 'Each voted on individually'],
        ['Requested', formatUsdCompact(totals.requestedUsd), `${formatUsd(totals.requestedUsd)} · paid in ZEC`],
        ['To pass', `${(PARTICIPATION_MINIMUM_ZEC / 1000).toLocaleString('en-US')}K ZEC`, 'participating, and more Yes than No'],
        ['Largest request', largest ? formatUsdCompact(largest.requestedUsd) : '—', largest?.title ?? ''],
      ].map(([label, value, note]) => <div key={label} className="bg-cipher-surface p-4">
        <dt className="font-mono text-caption uppercase tracking-wider text-muted">{label}</dt>
        <dd className="mt-1 text-xl font-semibold tabular-nums text-primary">{value}</dd>
        <dd className="mt-1 line-clamp-1 text-caption text-muted">{note}</dd>
      </div>)}
    </dl>
    <section aria-labelledby="requested-by-category" className="rounded-xl border border-cipher-border bg-cipher-card p-4">
      <h2 id="requested-by-category" className="font-mono text-caption uppercase tracking-wider text-muted">Requested by category</h2>
      <ul className="mt-3 space-y-2">
        {totals.byCategory.map(c => <li key={c.category} className="grid grid-cols-[7.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-xs sm:grid-cols-[10rem_minmax(0,1fr)_5rem]">
          <span className="truncate text-secondary" title={GRANT_CATEGORIES[c.category].label}>{GRANT_CATEGORIES[c.category].short} <span className="text-muted">· {c.count}</span></span>
          <span className="h-1.5 overflow-hidden rounded-full bg-cipher-border"><span className="block h-full rounded-full bg-brand-gold/70" style={{ width: `${c.requestedUsd / max * 100}%` }} /></span>
          <span className="text-right font-mono tabular-nums text-primary">{formatUsdCompact(c.requestedUsd)}</span>
        </li>)}
      </ul>
    </section>
  </div>;
}

/** Eligibility preparation. Snapshot timing is never invented: it comes from the registered round. */
export function GetReadyToVote({ round, snapshotHeight }: { round: GrantRound; snapshotHeight?: number }) {
  return <section aria-labelledby="get-ready" className="mt-4 rounded-xl border border-brand-gold/25 bg-cipher-card p-4 sm:p-5">
    <h2 id="get-ready" className="text-base font-semibold text-primary">Get ready to vote: shield your ZEC</h2>
    <div className="mt-3 grid gap-4 text-sm leading-relaxed text-secondary md:grid-cols-3">
      <p><span className="font-medium text-primary">Only shielded ZEC votes.</span> Voting weight comes from ZEC held in the Ironwood shielded pool at a snapshot block. Transparent ZEC does not count.</p>
      <p><span className="font-medium text-primary">Shield before the snapshot.</span> {snapshotHeight
        ? <>This round’s snapshot is <Link href={`/block/${snapshotHeight}`} prefetch={false} className="text-brand-gold hover:underline">block {snapshotHeight.toLocaleString('en-US')}</Link>.</>
        : <>The {round.quarter} snapshot has not been announced. In Q3 2026 it was <Link href="/block/3485940" prefetch={false} className="text-brand-gold hover:underline">block 3,485,940</Link>, mined about four hours after review closed.</>}{' '}Funds must stay shielded and spendable at that block.</p>
      <p><span className="font-medium text-primary">Use a supported wallet.</span> Update and sync it, then use its voting section when the poll opens. You never send ZEC to anyone to vote, and no one needs your recovery phrase.</p>
    </div>
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs">
      <Link href="/ironwood" className="text-brand-gold hover:underline">Ironwood migration tracker →</Link>
      <Link href="/calendar" className="text-secondary hover:text-primary">Zcash calendar →</Link>
      <a href="#how-to-vote" className="text-secondary hover:text-primary">How to vote ↓</a>
    </div>
  </section>;
}
