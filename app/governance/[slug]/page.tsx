import { CopyableValue, CopyableCommand } from '../CopyableValue';
import { notFound, permanentRedirect } from 'next/navigation';
import { buildPageMetadata, getNetwork } from '@/lib/seo';
import { getGovernanceCatalog } from '@/lib/governance-data';
import { GOVERNANCE_API, GRANTS, catalogDirectoryIsStale, isGrantsRound, roundHex } from '@/lib/governance';
import { NU7_ROUND_ID } from '@/lib/nu7-vote-results';
import { GovernanceShell, Status, Freshness, SourceNote } from '../GovernanceUI';
import { ProposalList } from '../ProposalList';
import { HowToVote } from '../HowToVote';

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };
const validSlug = (slug: string) => slug === GRANTS.slug || /^[a-f0-9]{64}$/.test(slug);

async function resolve(slug: string) {
  const catalog = await getGovernanceCatalog();
  const matches = catalog.votes.filter(v => slug === GRANTS.slug ? isGrantsRound(v.round) : v.id === slug);
  const vote = matches.length === 1 ? matches[0] : undefined;
  return { catalog, vote };
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  if (!validSlug(slug) || getNetwork() !== 'mainnet') return buildPageMetadata({ title: 'Vote Not Found | ZecBlock', description: 'This vote could not be found.', path: '/governance', canonical: false, index: false });
  const { vote, catalog } = await resolve(slug);
  if (!vote && slug !== GRANTS.slug && !catalogDirectoryIsStale(catalog, Date.now())) notFound();
  const title = vote?.title ?? (slug === GRANTS.slug ? GRANTS.title : 'Vote temporarily unavailable');
  return buildPageMetadata({ title: `${title} — Voting & Results | ZecBlock`, description: vote ? (vote.description.slice(0, 220) || `Explore ${vote.title}: ballot options, published results, and independent tally verification.`) : slug === GRANTS.slug ? GRANTS.description : 'Vote data is temporarily unavailable.', path: vote?.href ?? `/governance/${slug}`, index: Boolean(vote) || slug === GRANTS.slug, networks: ['mainnet'] });
}

export default async function VotePage({ params }: Props) {
  if (getNetwork() !== 'mainnet') notFound();
  const { slug } = await params;
  if (!validSlug(slug)) notFound();
  if (slug === NU7_ROUND_ID) permanentRedirect('/governance/nu7');
  const { catalog, vote } = await resolve(slug);
  if (vote && vote.href !== `/governance/${slug}`) permanentRedirect(vote.href);
  if (!vote && slug !== GRANTS.slug) {
    if (!catalogDirectoryIsStale(catalog, Date.now())) notFound();
    return <GovernanceShell title="Vote temporarily unavailable" description="The voting directory could not be reached. Please try again shortly." path={`/governance/${slug}`}><p className="break-all font-mono text-xs text-muted">Round {slug}</p><Freshness catalog={catalog} /></GovernanceShell>;
  }
  if (!vote) {
    const datePassed = Date.now() >= Date.parse(`${GRANTS.opensOn}T00:00:00Z`);
    return <GovernanceShell title={GRANTS.title} description={GRANTS.description} path={`/governance/${GRANTS.slug}`}>
      <div className="rounded-xl border border-cipher-border bg-cipher-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold text-primary">{datePassed ? 'Awaiting a confirmed voting round' : 'Review now. Vote from September 17.'}</h2>{datePassed ? <span className="font-mono text-xs text-muted">Awaiting confirmation</span> : <Status state="announced" />}</div>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {[["Review closes", 'September 16 · 20:00 UTC'], ['Scheduled voting', 'September 17–29, 2026'], ['Proposals', '37 grant applications']].map(([label, value]) => <div key={label}><p className="font-mono text-caption uppercase tracking-wider text-muted">{label}</p><p className="mt-1 text-sm font-medium text-primary">{value}</p></div>)}
        </div>
        <p className="mt-5 max-w-3xl text-sm leading-relaxed text-secondary">{catalogDirectoryIsStale(catalog, Date.now()) ? 'The voting directory is temporarily unavailable, so a matching endorsed round could not be checked.' : 'The organizer has announced the schedule. A matching endorsed round is not yet available here.'} Snapshot details, exact voting times, and results will appear once confirmed by the voting chain. No result publication date has been announced.</p>
        <div className="mt-4 flex flex-wrap gap-4 text-sm"><a href={GRANTS.source} target="_blank" rel="noopener noreferrer" className="text-brand-gold hover:underline">Review all proposals ↗</a><a href={GRANTS.calendar} target="_blank" rel="noopener noreferrer" className="text-secondary hover:underline">Governance calendar ↗</a></div>
      </div>
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-cipher-border p-4 sm:p-5"><h2 className="text-sm font-semibold text-primary">What coinholders will decide</h2><ul className="mt-3 space-y-2 text-sm text-secondary"><li>Accept</li><li>Reject — do not support the project</li><li>Reject — reconsider in a future round at a lower amount</li><li>Abstain</li></ul><p className="mt-4 text-xs leading-relaxed text-muted">Both rejection options count as “no.” These are the announced options; the registered ballot will be shown when available.</p></section>
        <section className="rounded-xl border border-cipher-border p-4 sm:p-5"><h2 className="text-sm font-semibold text-primary">Follow the vote here</h2><p className="mt-3 text-sm leading-relaxed text-secondary">This page will show the registered proposals, voting status, and published tally, with links to independently verify the results.</p><p className="mt-4 text-xs leading-relaxed text-muted">Disclosure: The team behind this explorer and CipherPay have applications in this round. All proposals will use the same presentation and ballot order.</p></section>
      </div>
      <div className="mt-6"><HowToVote /></div>
      <Freshness catalog={catalog} /><SourceNote />
    </GovernanceShell>;
  }
  const published = vote.state === 'results';
  const snapshotHash = roundHex(vote.round.snapshot_blockhash);
  const command = `svoted query vote verify-tally ${vote.id} \\\n  --node tcp://localhost:26657 --output json`;
  return <GovernanceShell title={vote.title} description={vote.description} path={vote.href}>
    <div className="rounded-xl border border-cipher-border bg-cipher-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><Status state={vote.state} /><p className="font-mono text-xs text-secondary">Voting deadline: {new Date(vote.round.vote_end_time * 1000).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC</p></div>
      <p className="mt-3 text-sm text-secondary">{published ? 'The published tally matches the API summary for every registered option. Independent verification instructions are below.' : vote.state === 'active' ? 'Voting is open. Use an officially supported wallet to cast your vote. Choices remain encrypted until tallying completes.' : vote.state === 'tallying' ? 'Voting has closed. The tally is being prepared; no final results are available yet.' : vote.state === 'failed' ? 'The voting ceremony failed or the tally timed out. This round has no complete published result.' : vote.state === 'upcoming' ? 'The voting round is registered and preparing to open.' : 'A complete matching tally is not available. Partial or inconsistent totals are not shown as final results.'}</p>
      {isGrantsRound(vote.round) && <p className="mt-3 text-xs text-muted">Both rejection options count as “no.” Approval requires the program’s decision rules. The team behind this explorer and CipherPay are applicants and receive the same presentation as all other proposals.</p>}
      <a href="https://voting.valargroup.org" target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm text-brand-gold hover:underline">Official voting site ↗</a>
    </div>
    {(vote.state === 'active' || vote.state === 'upcoming') && <div className="mt-6"><HowToVote snapshotHeight={vote.round.snapshot_height} /></div>}
    <ProposalList proposals={vote.proposals} published={published} zecPerUnit={vote.zecPerUnit} />
    <section className="mt-6 rounded-xl border border-cipher-border p-4 sm:p-5"><h2 className="text-sm font-semibold text-primary">Sources & independent verification</h2>
      <dl className="mt-3 space-y-3 text-xs"><div><dt className="text-muted">Voting round · zvote-1</dt><dd className="mt-1"><CopyableValue value={vote.id} label="voting round ID" /></dd></div><div><dt className="text-muted">Zcash snapshot · block {vote.round.snapshot_height.toLocaleString('en-US')}</dt><dd className="mt-1"><CopyableValue value={snapshotHash} label="snapshot block hash" /></dd></div></dl>
      <div className="mt-4 flex flex-wrap gap-4 text-xs text-brand-gold"><a href={`${GOVERNANCE_API}/vote-summary/${vote.id}`} target="_blank" rel="noopener noreferrer">API summary ↗</a><a href={`${GOVERNANCE_API}/tally-results/${vote.id}`} target="_blank" rel="noopener noreferrer">Raw tally ↗</a><a href="https://tally.valargroup.org" target="_blank" rel="noopener noreferrer">Verification guide ↗</a></div>
      <p className="mt-4 text-xs leading-relaxed text-muted">After results are published, synchronize your own voting-chain node and follow the verification guide. Run the command against your local node; reading the API alone is not independent verification.</p>
      <div className="mt-3"><CopyableCommand command={command} label="Verify tally command" /></div>
    </section>
    <Freshness catalog={catalog} /><SourceNote />
  </GovernanceShell>;
}
