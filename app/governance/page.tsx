import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buildPageMetadata, getNetwork } from '@/lib/seo';
import { getGovernanceCatalog } from '@/lib/governance-data';
import { GRANTS, isGrantsRound, type Vote } from '@/lib/governance';
import { CURRENT_GRANT_ROUND, formatUsdCompact, grantPhase, grantTotals } from '@/lib/grant-rounds';
import { GrantRoundStepper, PHASE_LABEL } from './GrantRoundOverview';
import { NU7_ROUND_ID } from '@/lib/nu7-vote-results';
import { GovernanceShell, Status, Freshness, SourceNote } from './GovernanceUI';
import { HowToVote } from './HowToVote';
import { MINER_POLL } from '@/lib/miner-poll';
import { MINER_POLL_PATH } from '@/components/MinerPollBallot';

/** The NU7.1 miner poll lives on chain, not the voting chain, so it is listed beside the tracked rounds. */
function MinerPollCard({ phase }: { phase: 'upcoming' | 'active' | 'closed' }) {
  return <Link href={MINER_POLL_PATH} className="group block rounded-xl border border-cipher-border bg-cipher-card p-4 transition-colors hover:border-brand-gold/40 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-base font-semibold text-primary group-hover:text-brand-gold">NU7.1 Miner Sentiment Poll</h3><Status label={phase === 'upcoming' ? 'Upcoming' : phase === 'active' ? 'Open' : 'Closed'} /></div>
    <p className="mt-2 line-clamp-2 max-w-3xl text-sm leading-relaxed text-secondary">Miners answer the five ZCAP NU7.1 questions with a ballot in the coinbase of each block they mine. Pilot run by the Zcash Foundation.</p>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-muted"><span>5 questions · blocks {MINER_POLL.startHeight.toLocaleString('en-US')}–{MINER_POLL.endHeight.toLocaleString('en-US')}</span><span className="text-brand-gold">{phase === 'closed' ? 'See the final count' : 'See the live tally'} →</span></div>
  </Link>;
}

// Keep the route's ISR clock explicit even when a concurrent banner/page shares
// the catalog promise created in a different request's cache context.
export const revalidate = 60;

const title = 'Zcash Governance: Votes & Results';
const description = 'Follow Zcash coinholder votes and retroactive grant rounds, review proposals, learn how to vote with shielded ZEC, and verify past results.';
export const generateMetadata = () => buildPageMetadata({ title: `${title} | ZecBlock`, description, path: '/governance', index: true, networks: ['mainnet'] });

function VoteCard({ vote }: { vote: Vote }) {
  return <Link href={vote.href} className="group block rounded-xl border border-cipher-border bg-cipher-card p-4 transition-colors hover:border-brand-gold/40 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-base font-semibold text-primary group-hover:text-brand-gold">{vote.title}</h3><Status state={vote.state} /></div>
    <p className="mt-2 line-clamp-2 max-w-3xl text-sm leading-relaxed text-secondary">{vote.description}</p>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-muted"><span>{vote.round.proposals.length} questions · {vote.state === 'active' ? 'Closes' : 'Voting deadline'} {new Date(vote.round.vote_end_time * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })}</span><span className="text-brand-gold">{vote.state === 'results' ? 'Explore results & verification' : 'View vote'} →</span></div>
  </Link>;
}

export default async function GovernancePage() {
  if (getNetwork() !== 'mainnet') notFound();
  const catalog = await getGovernanceCatalog();
  const active = catalog.votes.filter(v => ['active', 'tallying', 'unavailable'].includes(v.state));
  const upcoming = catalog.votes.filter(v => v.state === 'upcoming');
  const past = catalog.votes.filter(v => ['results', 'failed'].includes(v.state));
  const now = Date.now();
  const round = CURRENT_GRANT_ROUND;
  const announced = !catalog.votes.some(v => isGrantsRound(v.round)) && grantPhase(round, now).phase !== 'closed';
  const totals = grantTotals(round);
  // Time estimates only place the card; the poll page reads the chain for the authoritative state.
  const minerPhase = now < Date.parse(MINER_POLL.estimatedStart) ? 'upcoming' : now < Date.parse(MINER_POLL.estimatedEnd) + 86_400_000 ? 'active' : 'closed';
  return <GovernanceShell title="Zcash Governance" description={description} path="/governance" back={false}>
    <p className="mb-5 text-sm text-secondary">New to coinholder voting? <a href="#how-to-vote" className="text-cipher-gold hover:underline">How to vote in 3 steps ↓</a> · <Link href="/calendar" className="text-cipher-gold hover:underline">Zcash calendar →</Link></p>
    <div className="space-y-7">
      <section aria-labelledby="active-votes"><h2 id="active-votes" className="mb-3 font-mono text-xs uppercase tracking-wider text-muted">Active votes {active.length + (minerPhase === 'active' ? 1 : 0) > 0 && `· ${active.length + (minerPhase === 'active' ? 1 : 0)}`}</h2>
        {active.length || minerPhase === 'active' ? <div className="space-y-3">{active.map(v => <VoteCard key={v.id} vote={v} />)}{minerPhase === 'active' && <MinerPollCard phase="active" />}</div> : <p className="rounded-xl border border-dashed border-cipher-border px-4 py-4 text-sm text-muted">{catalog.unavailable ? 'Current voting status is unavailable.' : 'No active votes in the tracked rounds.'}</p>}
      </section>
      {(announced || upcoming.length > 0 || minerPhase === 'upcoming') && <section aria-labelledby="upcoming-votes"><h2 id="upcoming-votes" className="mb-3 font-mono text-xs uppercase tracking-wider text-muted">Upcoming</h2><div className="space-y-3">
        {announced && <div className="overflow-hidden rounded-xl border border-brand-gold/25 bg-cipher-card">
          <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold text-primary"><Link href={`/governance/${GRANTS.slug}`} className="hover:text-brand-gold">{round.title}</Link></h3><Status label={PHASE_LABEL[grantPhase(round, now).phase]} /></div>
              <p className="mt-1 text-sm text-secondary">{totals.count} proposals · {formatUsdCompact(totals.requestedUsd)} requested for completed work across the Zcash ecosystem.</p>
            </div>
            <Link href={`/governance/${GRANTS.slug}#proposal-catalog`} className="btn btn-sm btn-primary shrink-0">Review the proposals →</Link>
          </div>
          <GrantRoundStepper round={round} now={now} header={false} />
        </div>}
        {minerPhase === 'upcoming' && <MinerPollCard phase="upcoming" />}
        {upcoming.map(v => <VoteCard key={v.id} vote={v} />)}
      </div></section>}
      <section aria-labelledby="past-votes"><h2 id="past-votes" className="mb-3 font-mono text-xs uppercase tracking-wider text-muted">Past results</h2><div className="space-y-3">
        {minerPhase === 'closed' && <MinerPollCard phase="closed" />}
        {past.map(v => <VoteCard key={v.id} vote={v} />)}
        {!catalog.votes.some(v => v.id === NU7_ROUND_ID) && <Link href="/governance/nu7" className="block rounded-xl border border-cipher-border bg-cipher-card p-5"><h3 className="text-base font-semibold text-primary">NU7 Coinholder Vote</h3><p className="mt-2 text-sm text-muted">Voting closed September 14, 2026. Open the results and verification page →</p></Link>}
      </div></section>
    </div>
    <Freshness catalog={catalog} />
    <div className="mt-7"><HowToVote /></div>
    <SourceNote />
  </GovernanceShell>;
}
