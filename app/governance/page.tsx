import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buildPageMetadata, getNetwork } from '@/lib/seo';
import { getGovernanceCatalog } from '@/lib/governance-data';
import { GRANTS, isGrantsRound, type Vote } from '@/lib/governance';
import { NU7_ROUND_ID } from '@/lib/nu7-vote-results';
import { GovernanceShell, Status, Freshness, SourceNote } from './GovernanceUI';
import { HowToVote } from './HowToVote';

// Keep the route's ISR clock explicit even when a concurrent banner/page shares
// the catalog promise created in a different request's cache context.
export const revalidate = 60;

const title = 'Zcash Governance: Votes & Results';
const description = 'Follow Zcash coinholder votes, learn how to vote with a supported wallet, and explore past results with independent tally verification instructions.';
export const generateMetadata = () => buildPageMetadata({ title: `${title} | ZecBlock`, description, path: '/governance', index: true, networks: ['mainnet'] });

function VoteCard({ vote }: { vote: Vote }) {
  return <Link href={vote.href} className="group block rounded-xl border border-cipher-border bg-cipher-surface p-4 transition-colors hover:border-brand-gold/40 sm:p-5">
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
  const announcementDue = Date.now() >= Date.parse(`${GRANTS.opensOn}T00:00:00Z`);
  const announced = !catalog.votes.some(v => isGrantsRound(v.round));
  return <GovernanceShell title="Zcash Governance" description={description} path="/governance" back={false}>
    <p className="mb-5 text-sm text-secondary">New to coinholder voting? <a href="#how-to-vote" className="text-cipher-gold hover:underline">How to vote in 3 steps ↓</a></p>
    <div className="space-y-7">
      <section aria-labelledby="active-votes"><h2 id="active-votes" className="mb-3 font-mono text-xs uppercase tracking-wider text-muted">Active votes {active.length > 0 && `· ${active.length}`}</h2>
        {active.length ? <div className="space-y-3">{active.map(v => <VoteCard key={v.id} vote={v} />)}</div> : <p className="rounded-xl border border-dashed border-cipher-border px-4 py-4 text-sm text-muted">{catalog.unavailable ? 'Current voting status is unavailable.' : 'No active votes in the tracked rounds.'}</p>}
      </section>
      {(announced || upcoming.length > 0) && <section aria-labelledby="upcoming-votes"><h2 id="upcoming-votes" className="mb-3 font-mono text-xs uppercase tracking-wider text-muted">{announcementDue && !upcoming.length ? 'Awaiting confirmation' : 'Upcoming'}</h2><div className="space-y-3">
        {announced && <Link href={`/governance/${GRANTS.slug}`} className="group block rounded-xl border border-brand-gold/25 bg-cipher-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-base font-semibold text-primary group-hover:text-brand-gold">{GRANTS.title}</h3>{announcementDue ? <span className="font-mono text-xs text-muted">Schedule announced · awaiting round</span> : <Status state="announced" />}</div>
          <p className="mt-2 text-sm text-secondary">37 proposals for completed work across the Zcash ecosystem.</p>
          <div className="mt-4 flex flex-wrap justify-between gap-2 font-mono text-xs"><span className="text-muted">September 17–29, 2026 · Official schedule</span><span className="text-brand-gold">Review the proposals →</span></div>
        </Link>}
        {upcoming.map(v => <VoteCard key={v.id} vote={v} />)}
      </div></section>}
      <section aria-labelledby="past-votes"><h2 id="past-votes" className="mb-3 font-mono text-xs uppercase tracking-wider text-muted">Past results</h2><div className="space-y-3">
        {past.map(v => <VoteCard key={v.id} vote={v} />)}
        {!catalog.votes.some(v => v.id === NU7_ROUND_ID) && <Link href="/governance/nu7" className="block rounded-xl border border-cipher-border bg-cipher-surface p-5"><h3 className="text-base font-semibold text-primary">NU7 Coinholder Vote</h3><p className="mt-2 text-sm text-muted">Voting closed September 14, 2026. Open the results and verification page →</p></Link>}
      </div></section>
    </div>
    <Freshness catalog={catalog} />
    <div className="mt-7"><HowToVote /></div>
    <SourceNote />
  </GovernanceShell>;
}
