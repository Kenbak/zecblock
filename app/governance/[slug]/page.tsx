import Link from 'next/link';
import { CopyableValue, CopyableCommand } from '../CopyableValue';
import { notFound, permanentRedirect } from 'next/navigation';
import { buildPageMetadata, getNetwork } from '@/lib/seo';
import { getGovernanceCatalog } from '@/lib/governance-data';
import { GOVERNANCE_API, catalogDirectoryIsStale, grantRoundOf, isGrantsRound, roundHex } from '@/lib/governance';
import { grantPhase, grantRoundBySlug } from '@/lib/grant-rounds';
import { GrantRoundStepper, GrantRoundStats, GetReadyToVote } from '../GrantRoundOverview';
import { GrantProposalCatalog } from '../GrantProposalCatalog';
import { NU7_ROUND_ID } from '@/lib/nu7-vote-results';
import { GovernanceShell, Status, Freshness, SourceNote } from '../GovernanceUI';
import { ProposalList } from '../ProposalList';
import { HowToVote } from '../HowToVote';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };
const validSlug = (slug: string) => Boolean(grantRoundBySlug(slug)) || /^[a-f0-9]{64}$/.test(slug);

async function resolve(slug: string) {
  const catalog = await getGovernanceCatalog();
  const grants = grantRoundBySlug(slug);
  const matches = catalog.votes.filter(v => grants ? isGrantsRound(v.round, grants) : v.id === slug);
  const vote = matches.length === 1 ? matches[0] : undefined;
  return { catalog, vote, grants };
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  if (!validSlug(slug) || getNetwork() !== 'mainnet') return buildPageMetadata({ title: 'Vote Not Found | ZecBlock', description: 'This vote could not be found.', path: '/governance', canonical: false, index: false });
  const { vote, catalog, grants } = await resolve(slug);
  if (!vote && !grants && !catalogDirectoryIsStale(catalog, Date.now())) notFound();
  const title = vote?.title ?? (grants ? `${grants.title}: ${grants.proposals.length ? `${grants.proposals.length} Proposals & ` : ''}Vote Schedule` : 'Vote temporarily unavailable');
  return buildPageMetadata({ title: `${title} | ZecBlock`, description: vote ? (vote.description.slice(0, 220) || `Explore ${vote.title}: ballot options, published results, and independent tally verification.`) : grants ? `${grants.description} Browse every request, filter by category and get ready to vote.` : 'Vote data is temporarily unavailable.', path: vote?.href ?? `/governance/${slug}`, index: Boolean(vote) || Boolean(grants), networks: ['mainnet'] });
}

export default async function VotePage({ params }: Props) {
  if (getNetwork() !== 'mainnet') notFound();
  const { slug } = await params;
  if (!validSlug(slug)) notFound();
  if (slug === NU7_ROUND_ID) permanentRedirect('/governance/nu7');
  const { catalog, vote, grants } = await resolve(slug);
  if (vote && vote.href !== `/governance/${slug}`) permanentRedirect(vote.href);
  if (!vote && !grants) {
    if (!catalogDirectoryIsStale(catalog, Date.now())) notFound();
    return <GovernanceShell title="Vote temporarily unavailable" description="The voting directory could not be reached. Please try again shortly." path={`/governance/${slug}`}><p className="break-all font-mono text-xs text-muted">Round {slug}</p><Freshness catalog={catalog} /></GovernanceShell>;
  }
  if (!vote && grants) {
    const now = Date.now();
    const { phase } = grantPhase(grants, now);
    const stale = catalogDirectoryIsStale(catalog, now);
    return <GovernanceShell title={grants.title} description={grants.description} path={`/governance/${grants.slug}`}>
      <GrantRoundStepper round={grants} now={now} catalogHref={grants.proposals.length ? '#proposal-catalog' : undefined} />
      {grants.proposals.length > 0 && <GrantRoundStats round={grants} />}
      {phase !== 'closed' && <GetReadyToVote round={grants} />}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-cipher-border p-4 sm:p-5"><h2 className="text-sm font-semibold text-primary">How coinholders decide</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-secondary">{grants.ballotOptions.map(option => <li key={option}>{option}</li>)}</ul>
          <p className="mt-3 text-xs leading-relaxed text-muted">{grants.ballotNote} The Key-Holder Organizations sign payouts from the Coinholder-Controlled Fund and can veto in exceptional cases; they cannot override a coinholder rejection.</p>
        </section>
        <section className="rounded-xl border border-cipher-border p-4 sm:p-5"><h2 className="text-sm font-semibold text-primary">Follow the vote here</h2>
          <p className="mt-3 text-sm leading-relaxed text-secondary">{stale ? 'The voting directory is temporarily unavailable, so a matching registered ballot could not be checked.' : 'No matching ballot is registered on the voting chain yet.'} When it is, this page moves to the live ballot with its snapshot block, status and published tally.</p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs"><a href={grants.source} target="_blank" rel="noopener noreferrer" className="text-brand-gold hover:underline">Organizer announcement ↗</a><a href={grants.callForProposals} target="_blank" rel="noopener noreferrer" className="text-secondary hover:underline">Call for proposals ↗</a><Link href="/calendar" className="text-secondary hover:underline">Zcash calendar →</Link></div>
          <p className="mt-3 text-xs leading-relaxed text-muted">Disclosure: the team behind ZecBlock has an application in this round. Every proposal uses the same presentation.</p>
        </section>
      </div>
      {grants.proposals.length > 0 && <GrantProposalCatalog proposals={grants.proposals} source={grants.source} />}
      <div className="mt-6"><HowToVote /></div>
      <Freshness catalog={catalog} /><SourceNote />
    </GovernanceShell>;
  }
  if (!vote) notFound();
  const published = vote.state === 'results';
  const curated = grantRoundOf(vote.round);
  const snapshotHash = roundHex(vote.round.snapshot_blockhash);
  const command = `svoted query vote verify-tally ${vote.id} \\\n  --node tcp://localhost:26657 --output json`;
  return <GovernanceShell title={vote.title} description={vote.description} path={vote.href}>
    <div className="rounded-xl border border-cipher-border bg-cipher-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><Status state={vote.state} /><p className="font-mono text-xs text-secondary">Voting deadline: {new Date(vote.round.vote_end_time * 1000).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC</p></div>
      <p className="mt-3 text-sm text-secondary">{published ? 'The published tally matches the API summary for every registered option. Independent verification instructions are below.' : vote.state === 'active' ? 'Voting is open. Use an officially supported wallet to cast your vote. Choices remain encrypted until tallying completes.' : vote.state === 'tallying' ? 'Voting has closed. The tally is being prepared; no final results are available yet.' : vote.state === 'failed' ? 'The voting ceremony failed or the tally timed out. This round has no complete published result.' : vote.state === 'upcoming' ? 'The voting round is registered and preparing to open.' : 'A complete matching tally is not available. Partial or inconsistent totals are not shown as final results.'}</p>
      {curated && <p className="mt-3 text-xs text-muted">{curated.ballotNote} Approval requires the program’s decision rules. The team behind this explorer has applications in this round; every proposal receives the same presentation.</p>}
      <a href="https://voting.valargroup.org" target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm text-brand-gold hover:underline">Official voting site ↗</a>
    </div>
    {curated && <div className="mt-6"><GrantRoundStepper round={curated} now={Date.now()} registered catalogHref={curated.proposals.length ? '#proposal-catalog' : undefined} />{curated.proposals.length > 0 && <GrantRoundStats round={curated} />}</div>}
    {curated && vote.state === 'upcoming' && <GetReadyToVote round={curated} snapshotHeight={vote.round.snapshot_height} />}
    {(vote.state === 'active' || vote.state === 'upcoming') && <div className="mt-6"><HowToVote snapshotHeight={vote.round.snapshot_height} /></div>}
    <ProposalList proposals={vote.proposals} published={published} zecPerUnit={vote.zecPerUnit} />
    {curated && curated.proposals.length > 0 && <GrantProposalCatalog proposals={curated.proposals} source={curated.source} />}
    <section className="mt-6 rounded-xl border border-cipher-border p-4 sm:p-5"><h2 className="text-sm font-semibold text-primary">Sources & independent verification</h2>
      <dl className="mt-3 space-y-3 text-xs"><div><dt className="text-muted">Voting round · zvote-1</dt><dd className="mt-1"><CopyableValue value={vote.id} label="voting round ID" /></dd></div><div><dt className="text-muted">Zcash snapshot · block {vote.round.snapshot_height.toLocaleString('en-US')}</dt><dd className="mt-1"><CopyableValue value={snapshotHash} label="snapshot block hash" /></dd></div></dl>
      <div className="mt-4 flex flex-wrap gap-4 text-xs text-brand-gold"><a href={`${GOVERNANCE_API}/vote-summary/${vote.id}`} target="_blank" rel="noopener noreferrer">API summary ↗</a><a href={`${GOVERNANCE_API}/tally-results/${vote.id}`} target="_blank" rel="noopener noreferrer">Raw tally ↗</a><a href="https://tally.valargroup.org" target="_blank" rel="noopener noreferrer">Verification guide ↗</a></div>
      <p className="mt-4 text-xs leading-relaxed text-muted">After results are published, synchronize your own voting-chain node and follow the verification guide. Run the command against your local node; reading the API alone is not independent verification.</p>
      <div className="mt-3"><CopyableCommand command={command} label="Verify tally command" /></div>
    </section>
    <Freshness catalog={catalog} /><SourceNote />
  </GovernanceShell>;
}
