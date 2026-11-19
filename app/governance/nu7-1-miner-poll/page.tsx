import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readApiData } from '@/lib/api-client';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { buildPageMetadata, getApiUrl, getNetwork } from '@/lib/seo';
import { MINER_POLL, MINER_POLL_BLOCKS, type MinerPollAnswer } from '@/lib/miner-poll';
import { BallotChips, MINER_POLL_PATH } from '@/components/MinerPollBallot';
import { PoolLogo } from '@/components/PoolLogo';
import { GovernanceShell } from '../GovernanceUI';

export const revalidate = 30;

const title = 'NU7.1 Miner Sentiment Poll';
const description = 'Live tally of Zcash miner ballots on the five NU7.1 questions, read from the coinbase of every block from 3,591,200 to 3,629,650, with a breakdown by mining pool.';

export function generateMetadata() {
  if (getNetwork() !== 'mainnet') {
    return { title: 'Page Not Found | ZecBlock', description: 'The NU7.1 miner poll is only available on mainnet.', robots: { index: false, follow: false } };
  }
  return buildPageMetadata({
    title: `${title}: Live Tally by Pool | ZecBlock`,
    description,
    keywords: ['Zcash miner poll', 'NU7.1', 'miner sentiment', 'Zcash governance', 'coinbase ballot', 'Zcash Community Grants', 'ZCAP poll'],
    path: MINER_POLL_PATH,
    index: true,
    imageAlt: 'ZecBlock NU7.1 miner sentiment poll tally',
    networks: ['mainnet'],
  });
}

type Tally = {
  state: 'upcoming' | 'open' | 'confirming' | 'final';
  tipHeight: number;
  totalBlocks: number;
  observedBlocks: number;
  expectedObservedBlocks: number;
  blocksWithBallot: number;
  memoUncheckedBlocks: number;
  questions: { index: number; options: { option: number; count: number }[] }[];
  pools: { pool: string | null; blocks: number; ballots: number; latest: { height: number; ballot: string } | null }[];
  recentBallots: { height: number; hash: string; pool: string | null; ballot: string }[];
  generatedAt: string;
};

async function fetchTally(): Promise<Tally | null> {
  try {
    const res = await fetchWithDeadline(`${getApiUrl()}/v1/mining/polls/nu7-1`, { next: { revalidate: 30 } }, 8_000);
    if (!res.ok) return null;
    const data = await readApiData<Tally>(res);
    return data && typeof data.totalBlocks === 'number' && Array.isArray(data.questions) ? data : null;
  } catch {
    return null;
  }
}

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(2)}%` : '—');
const answers = (ballot: string) => ballot.split('') as MinerPollAnswer[];
const utc = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' UTC';

const STATE_LABEL: Record<Tally['state'], string> = {
  upcoming: 'Opens soon',
  open: 'Voting open',
  confirming: 'Closed · confirming',
  final: 'Final',
};

const SEGMENTS = [
  { key: 'support', label: 'Support', bar: 'bg-cipher-green', dot: 'bg-cipher-green' },
  { key: 'oppose', label: 'Oppose', bar: 'bg-danger', dot: 'bg-danger' },
  { key: 'abstain', label: 'Abstain', bar: 'bg-glass-12', dot: 'bg-glass-12' },
  { key: 'none', label: 'No answer', bar: 'bg-glass-6', dot: 'bg-glass-6' },
] as const;

function QuestionResult({ tally, index }: { tally: Tally; index: number }) {
  const q = MINER_POLL.questions[index];
  const counts = tally.questions[index].options.map(o => o.count);
  const answered = counts.reduce((s, c) => s + c, 0);
  const values = [...counts, Math.max(tally.observedBlocks - answered, 0)];
  const notMined = Math.max(tally.totalBlocks - tally.observedBlocks, 0);
  return (
    <article className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6">
      <p className="font-mono text-xs uppercase tracking-wider text-muted">Question {index + 1}</p>
      <h3 className="mt-1 text-base font-semibold leading-snug text-primary">{q.text}</h3>
      {/* The bar shows blocks mined so far; the ZIP's basis (all blocks in the window) is listed under each count. */}
      <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-glass-3" role="img"
        aria-label={`${SEGMENTS.map((s, i) => `${s.label} ${fmt(values[i])} blocks`).join(', ')}${notMined ? `, ${fmt(notMined)} blocks not yet mined` : ''}`}>
        {values.map((v, i) => v > 0 && <div key={SEGMENTS[i].key} className={SEGMENTS[i].bar} style={{ width: `${(v / Math.max(tally.observedBlocks, 1)) * 100}%` }} />)}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SEGMENTS.map((s, i) => (
          <div key={s.key}>
            <dt className="flex items-center gap-1.5 text-xs text-muted"><span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden="true" />{s.label}</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-primary">{pct(values[i], tally.observedBlocks)}</dd>
            <dd className="font-mono text-xs tabular-nums text-muted">{fmt(values[i])} blocks · {pct(values[i], tally.totalBlocks)} of window</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export default async function MinerPollPage() {
  if (getNetwork() !== 'mainnet') notFound();
  const tally = await fetchTally();
  const links = MINER_POLL.links;

  return (
    <GovernanceShell title={title} description={description} path={MINER_POLL_PATH}>
      <div className="space-y-6">
        <section className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6" aria-labelledby="status-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="status-heading" className="text-lg font-semibold text-primary">{tally ? STATE_LABEL[tally.state] : 'Tally temporarily unavailable'}</h2>
            <p className="font-mono text-xs text-muted">Blocks {fmt(MINER_POLL.startHeight)}–{fmt(MINER_POLL.endHeight)} · est. {utc(MINER_POLL.estimatedStart)} to {utc(MINER_POLL.estimatedEnd)}</p>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-secondary">
            Run by the Zcash Foundation alongside the <a className="text-brand-gold hover:underline" href={links.zcapPoll}>ZCAP NU7.1 poll</a>. Miners vote by putting a ballot in the coinbase of each block they mine. Each block in the window is one vote, so results are shares of all {fmt(MINER_POLL_BLOCKS)} blocks, not of hashrate or ZEC.
          </p>
          {!tally && <p className="mt-3 text-sm text-muted">The count could not be loaded. This does not mean no ballots were cast. Check the <a className="underline" href={links.officialTally}>official tally ↗</a>.</p>}
          {tally && (
            <>
              <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl bg-glass-3 p-3">
                  <dt className="text-xs text-muted">Blocks mined in window</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums text-primary">{fmt(tally.observedBlocks)}</dd>
                  <p className="mt-1 text-xs text-muted">of {fmt(tally.totalBlocks)}</p>
                </div>
                <div className="rounded-xl border border-brand-gold/20 bg-brand-gold/5 p-3">
                  <dt className="text-xs text-muted">Blocks with a ballot</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums text-brand-gold">{fmt(tally.blocksWithBallot)}</dd>
                  <p className="mt-1 text-xs text-muted">{pct(tally.blocksWithBallot, tally.observedBlocks)} of mined so far</p>
                </div>
                <div className="rounded-xl bg-glass-3 p-3">
                  <dt className="text-xs text-muted">Participation</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums text-primary">{pct(tally.blocksWithBallot, tally.totalBlocks)}</dd>
                  <p className="mt-1 text-xs text-muted">of all {fmt(tally.totalBlocks)} blocks</p>
                </div>
                <div className="rounded-xl bg-glass-3 p-3">
                  <dt className="text-xs text-muted">Chain tip</dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums text-primary"><Link href={`/block/${tally.tipHeight}`} prefetch={false} className="hover:text-brand-gold">{fmt(tally.tipHeight)}</Link></dd>
                  <p className="mt-1 text-xs text-muted">{tally.state === 'upcoming' ? `${fmt(MINER_POLL.startHeight - tally.tipHeight)} blocks to go` : tally.state === 'final' ? 'End block has 100 confirmations' : tally.state === 'confirming' ? 'Final at 100 confirmations' : `${fmt(MINER_POLL.endHeight - tally.tipHeight)} blocks left`}</p>
                </div>
              </dl>
              {tally.observedBlocks < tally.expectedObservedBlocks && <p className="mt-3 text-xs text-brand-gold">{fmt(tally.expectedObservedBlocks - tally.observedBlocks)} blocks in the window are not indexed yet, so this count is incomplete.</p>}
              {tally.memoUncheckedBlocks > 0 && <p className="mt-3 text-xs text-muted">{fmt(tally.memoUncheckedBlocks)} blocks pay the coinbase to a shielded address and carry no ballot in the script. A ballot in their coinbase memo would count in the official tally; ZecBlock does not read memo ballots yet.</p>}
            </>
          )}
        </section>

        {tally && (
          <section aria-labelledby="questions-heading" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="questions-heading" className="font-mono text-xs uppercase tracking-wider text-muted">Results by question</h2>
              {tally.observedBlocks < tally.totalBlocks && <p className="text-xs text-muted">Shares of the {fmt(tally.observedBlocks)} blocks mined so far · {fmt(tally.totalBlocks - tally.observedBlocks)} still to come</p>}
            </div>
            {MINER_POLL.questions.map((_, i) => <QuestionResult key={i} tally={tally} index={i} />)}
          </section>
        )}

        {tally && tally.pools.length > 0 && (
          <section className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6" aria-labelledby="pools-heading">
            <h2 id="pools-heading" className="text-lg font-semibold text-primary">By mining pool</h2>
            <p className="mt-1 text-sm text-secondary">Blocks each pool mined in the window and its most recent ballot. Pools can change their ballot at any time; every block counts with its own ballot.</p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-cipher-border text-left text-xs text-muted">
                  <th className="py-2 pr-4 font-normal">Pool</th>
                  <th className="py-2 pr-4 text-right font-normal">Blocks</th>
                  <th className="hidden py-2 pr-4 text-right font-normal sm:table-cell">With ballot</th>
                  <th className="py-2 font-normal">Latest ballot (Q1–Q5)</th>
                </tr></thead>
                <tbody>
                  {tally.pools.map(p => (
                    <tr key={p.pool ?? 'unattributed'} className="border-b border-cipher-border-subtle last:border-0">
                      <td className="py-2.5 pr-4"><span className={`inline-flex items-center gap-2 whitespace-nowrap ${p.pool ? 'text-primary' : 'text-muted'}`}>{p.pool && <PoolLogo name={p.pool} />}{p.pool ?? 'Unattributed'}</span></td>
                      <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-secondary">{fmt(p.blocks)}</td>
                      <td className="hidden py-2.5 pr-4 text-right font-mono tabular-nums text-secondary sm:table-cell">{fmt(p.ballots)}</td>
                      <td className="py-2.5">{p.latest
                        ? <span className="inline-flex items-center gap-2"><BallotChips answers={answers(p.latest.ballot)} /><Link href={`/block/${p.latest.height}`} prefetch={false} className="font-mono text-xs text-muted hover:text-primary">#{fmt(p.latest.height)}</Link></span>
                        : <span className="text-xs text-muted">No ballot</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tally && tally.recentBallots.length > 0 && (
          <section className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6" aria-labelledby="recent-heading">
            <h2 id="recent-heading" className="text-lg font-semibold text-primary">Latest ballots</h2>
            <p className="mt-1 text-sm text-secondary">The {Math.min(tally.recentBallots.length, 12)} most recent blocks with a ballot. Every block page shows its own ballot, and the <Link href="/blocks" className="text-brand-gold hover:underline">block list</Link> shows them under “Coinbase messages”.</p>
            <ul className="mt-4 divide-y divide-cipher-border-subtle">
              {tally.recentBallots.slice(0, 12).map(b => (
                <li key={b.height} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="inline-flex items-center gap-2 text-sm">
                    <Link href={`/block/${b.height}`} prefetch={false} className="font-mono text-primary hover:text-brand-gold">#{fmt(b.height)}</Link>
                    <span className={`inline-flex items-center gap-1.5 ${b.pool ? 'text-secondary' : 'text-muted'}`}>{b.pool && <PoolLogo name={b.pool} />}{b.pool ?? 'Unattributed'}</span>
                  </span>
                  <BallotChips answers={answers(b.ballot)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6" aria-labelledby="method-heading">
          <h2 id="method-heading" className="text-lg font-semibold text-primary">How this count works</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-secondary">
            <li>A ballot is the text <code className="text-primary">zpoll:nu7-1:</code> followed by one character per question: <code>1</code> Support, <code>2</code> Oppose, <code>3</code> Abstain, <code>-</code> no answer, ending with <code>/</code>.</li>
            <li>ZecBlock reads the coinbase script data of every canonical block in the window and counts the first valid ballot, following the <a className="text-brand-gold hover:underline" href={links.zip}>draft ZIP</a>.</li>
            <li>The ZIP measures results against all {fmt(MINER_POLL_BLOCKS)} blocks in the window, shown as “of window”. While voting is open, the large figure is the share of blocks mined so far. A block without a ballot answers no question.</li>
            <li>The result is final once the end block has 100 confirmations. Until then a reorg can change the count.</li>
            <li>This is an independent count. Compare it with the <a className="text-brand-gold hover:underline" href={links.officialTally}>official tally ↗</a>.</li>
          </ul>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-secondary">
            <a className="underline underline-offset-4 hover:text-primary" href={links.announcement}>Announcement ↗</a>
            <a className="underline underline-offset-4 hover:text-primary" href={links.definition}>Poll definition ↗</a>
            <a className="underline underline-offset-4 hover:text-primary" href={links.builder}>Ballot builder for miners ↗</a>
            <Link className="underline underline-offset-4 hover:text-primary" href="/mining">Mining pools →</Link>
          </div>
        </section>
      </div>
    </GovernanceShell>
  );
}
