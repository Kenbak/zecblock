import { CopyableValue, CopyableCommand } from '../CopyableValue';
import { getParticipationStats, NU7_RESULTS_BASE, NU7_SNAPSHOT_SUPPLY, NU7_ROUND_ID, NU7_SUMMARY_URL, NU7_TALLY_URL, NU7_VERIFY_COMMAND, ZEC_PER_VOTE_UNIT, type VoteResults as Results } from '@/lib/nu7-vote-results';
import { roundSubmissions } from '@/lib/vote-submissions';

const zec = (units: number) => (units * ZEC_PER_VOTE_UNIT).toLocaleString('en-US', { maximumFractionDigits: 3 });

export function VoteResults({ results }: { results: Results }) {
  const published = results.state === 'published';
  const participation = getParticipationStats(results);
  const submissions = participation ? roundSubmissions(NU7_ROUND_ID) : null;
  const count = (n: number) => n.toLocaleString('en-US');
  const thresholdMet = results.proposals.some(p => p.options.reduce((s, o) => s + o.total_value, 0) * ZEC_PER_VOTE_UNIT >= 1_000_000);
  return (
    <section className="space-y-6 mb-8" aria-labelledby="results-heading">
      <div className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6">
        <h2 id="results-heading" className="text-xl font-semibold text-primary mb-2">{published ? 'Published results' : results.state === 'pending' ? 'Awaiting final results' : 'Results temporarily unavailable'}</h2>
        <p className="text-sm text-secondary">{published
          ? 'Published by the voting-chain API. ZecBlock has not independently verified this tally.'
          : 'A complete finalized tally could not be confirmed. This does not mean zero votes were cast. Reload this page or check the source links below.'}</p>
        <a href="#verify-results" className="inline-block text-sm text-brand-gold underline mt-3">Verify this tally independently</a>
        {participation && <>
          <dl className={`grid grid-cols-2 ${submissions ? 'lg:grid-cols-4' : 'sm:grid-cols-3'} gap-3 my-4`}>
            <div className="rounded-xl bg-glass-3 p-3">
              <dt className="text-xs text-muted">ZEC per question</dt>
              <dd className="text-xl font-mono font-semibold text-primary mt-1">~{(participation.maxZec / 1_000_000).toFixed(2)}M</dd>
              <p className="text-xs text-muted mt-1">Including abstentions</p>
            </div>
            <div className="rounded-xl bg-glass-3 p-3">
              <dt className="text-xs text-muted">Ironwood at snapshot</dt>
              <dd className="text-xl font-mono font-semibold text-primary mt-1">{(participation.snapshotZec / 1_000_000).toFixed(2)}M ZEC</dd>
              <p className="text-xs text-muted mt-1">Block {NU7_SNAPSHOT_SUPPLY.height.toLocaleString('en-US')}</p>
            </div>
            <div className={`${submissions ? '' : 'col-span-2 sm:col-span-1 '}rounded-xl bg-brand-gold/5 border border-brand-gold/20 p-3`}>
              <dt className="text-xs text-muted">Share of snapshot pool supply</dt>
              <dd className="text-xl font-mono font-semibold text-brand-gold mt-1">{participation.minShare.toFixed(1)}–{participation.maxShare.toFixed(1)}%</dd>
              <p className="text-xs text-muted mt-1">Range across the five questions</p>
            </div>
            {submissions && <div className="rounded-xl bg-glass-3 p-3">
              <dt className="text-xs text-muted">Voting registrations</dt>
              <dd className="text-xl font-mono font-semibold text-primary mt-1">{count(submissions.delegations)}</dd>
              <p className="text-xs text-muted mt-1">At most this many wallets</p>
            </div>}
          </dl>
          {submissions && <details className="text-xs text-secondary mb-2">
            <summary className="cursor-pointer text-muted">How many wallets voted?</summary>
            <div className="mt-3 space-y-3">
              <p>Before voting, a wallet registers its notes on the voting chain in bundles of up to five. This round recorded {count(submissions.delegations)} registrations{submissions.votes ? <>, then {count(submissions.votes)} encrypted votes across the five questions</> : null} and {count(submissions.revealedShares)} revealed vote shares.</p>
              <p>A wallet holding more than five notes can register more than once, so {count(submissions.delegations)} is an upper limit on wallets. It is not a count of people: one person can use several wallets, and one wallet can hold funds for many. Ballots are private, so no exact voter count exists.</p>
              <p>Counted from voting-chain transactions on Nov 18, 2026. Cross-check: the round’s <a className="text-primary underline underline-offset-4" href={`${NU7_RESULTS_BASE}/commitment-tree/${NU7_ROUND_ID}/latest`}>commitment tree</a> holds {count(submissions.treeLeaves)} entries, one per registration and two per vote.</p>
            </div>
          </details>}
          <details className="text-xs text-secondary">
            <summary className="cursor-pointer text-muted">Snapshot comparison &amp; verification</summary>
            <div className="mt-3 space-y-3">
              <p>Compared with {participation.snapshotZec.toLocaleString('en-US', { maximumFractionDigits: 8 })} ZEC in Ironwood at <a className="text-primary underline underline-offset-4" href={`/block/${NU7_SNAPSHOT_SUPPLY.height}`}>snapshot block {NU7_SNAPSHOT_SUPPLY.height.toLocaleString('en-US')}</a> (Aug 24, 2026, 19:18:03 UTC). This is not an exact eligible-voter turnout rate.</p>
              <div><p className="mb-1 text-muted">Snapshot block hash</p><CopyableValue value={NU7_SNAPSHOT_SUPPLY.hash} label="snapshot block hash" /></div>
              <CopyableCommand command={`getblock "${NU7_SNAPSHOT_SUPPLY.hash}" 1`} label="Snapshot RPC command" />
              <p>Run on a Zcash mainnet node. In <code>valuePools</code>, Ironwood has <code>chainValueZat = {NU7_SNAPSHOT_SUPPLY.ironwoodZatoshi}</code>; divide by 100,000,000 for ZEC. The tally uses a separate voting-chain node.</p>
            </div>
          </details>
        </>}
        {published && <>
          <p className="text-sm text-primary mt-3">1,000,000 ZEC participation threshold: <strong>{thresholdMet ? 'met' : 'not met'}</strong>.</p>
          <p className="text-xs text-muted mt-2">Vote weights include abstentions. Question totals do not count unique voters.</p>
        </>}
      </div>
      {results.proposals.map(p => {
        const total = p.options.reduce((s, o) => s + o.total_value, 0);
        const highest = Math.max(...p.options.map(o => o.total_value));
        const leaders = p.options.filter(o => highest > 0 && o.total_value === highest);
        const orderedOptions = [...p.options].sort((a, b) =>
          Number(b.total_value === highest) - Number(a.total_value === highest) || a.index - b.index);
        return <article key={p.id} className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h3 className="text-base font-semibold text-primary">Q{p.id} — {p.title}</h3>
            <p className="text-xs font-mono text-muted">{zec(total)} ZEC participating</p>
          </div>
          <div className="space-y-2">{orderedOptions.map(o => {
            const percent = total ? o.total_value / total * 100 : 0;
            const leading = highest > 0 && o.total_value === highest;
            return <div key={o.index} className={leading
              ? 'rounded-xl border border-brand-gold/40 bg-brand-gold/5 p-3 sm:p-3.5'
              : 'rounded-xl border border-cipher-border-subtle px-3 py-2.5'}>
              {leading && <p className="text-caption font-mono font-semibold uppercase tracking-widest text-brand-gold mb-2">{leaders.length > 1 ? 'Tied for top choice' : 'Top choice'}</p>}
              <div className="flex flex-wrap sm:flex-nowrap justify-between items-start gap-2 sm:gap-5">
                <div className="min-w-0">
                  <p className={leading ? 'text-sm sm:text-base font-semibold text-primary leading-snug' : 'text-sm text-secondary'}>
                    <span className={leading ? 'text-brand-gold mr-2' : 'text-muted mr-2'}>{String.fromCharCode(65 + o.index)}.</span>{o.label}
                  </p>
                  {o.description && <p className="text-xs text-secondary mt-1 leading-relaxed">{o.description}</p>}
                </div>
                <div className="shrink-0 sm:text-right">
                  <p className={leading ? 'text-xl sm:text-2xl font-semibold font-mono text-brand-gold tabular-nums' : 'text-sm font-mono text-secondary tabular-nums'}>{total ? `${percent.toFixed(2)}%` : '—'}</p>
                  <p className="text-xs font-mono text-muted mt-1 tabular-nums">{zec(o.total_value)} ZEC</p>
                </div>
              </div>
              <div className={`${leading ? 'h-1.5 mt-3' : 'h-1 mt-2'} rounded-full bg-glass-6 overflow-hidden`} aria-hidden="true">
                <div className={`h-full rounded-full ${leading ? 'bg-brand-gold' : 'bg-glass-12'}`} style={{ width: `${percent}%` }} />
              </div>
            </div>;
          })}</div>
          <details className="mt-4 text-xs text-secondary">
            <summary className="cursor-pointer text-muted">Question context</summary>
            <p className="mt-2 whitespace-pre-line leading-relaxed">{p.description}</p>
          </details>
        </article>;
      })}
      <section id="verify-results" className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6" aria-labelledby="verify-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="verify-heading" className="text-lg font-semibold text-primary">Verify the tally</h2>
          <a className="text-sm text-secondary hover:text-primary underline underline-offset-4" href="https://tally.valargroup.org">Node setup guide ↗</a>
        </div>
        <p className="mt-2 text-sm text-secondary">Run on your own synced zvote-1 node. No wallet, keys or funds needed.</p>
        <div className="my-4 space-y-1">
          <p className="text-xs text-muted">Voting round · NU7 Scope</p>
          <CopyableValue value={NU7_ROUND_ID} label="voting round ID" />
        </div>
        <CopyableCommand command={NU7_VERIFY_COMMAND} label="Verify tally command" />
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-secondary">
          <a className="hover:text-primary underline underline-offset-4" href={NU7_SUMMARY_URL}>Question labels &amp; totals (JSON) ↗</a>
          <a className="hover:text-primary underline underline-offset-4" href={NU7_TALLY_URL}>Raw finalized tally (JSON) ↗</a>
          <a className="hover:text-primary underline underline-offset-4" href="https://github.com/valargroup/vote-sdk/blob/7c59b7cc32593ec1a596b8a007431313d7c568a5/x/vote/client/cli/query.go">Verifier source ↗</a>
        </div>
        <div className="mt-5 divide-y divide-cipher-border border-t border-cipher-border text-xs leading-relaxed text-secondary">
          <details className="py-3">
            <summary className="cursor-pointer text-sm text-primary">What should the output show?</summary>
            <div className="mt-3 space-y-2">
              <p>Confirm the report names the round above and includes:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li><code>SESSION_STATUS_FINALIZED</code></li>
                <li><code>verified: true</code></li>
                <li>All 19 question/option checks, with <code>claimed_total</code> values matching the raw tally.</li>
              </ul>
              <p>A failed or missing check needs investigation. The command verifies totals against encrypted accumulators and validator partial decryptions; it does not reveal individual ballots or constitute a full protocol audit.</p>
            </div>
          </details>
          <details className="pt-3">
            <summary className="cursor-pointer text-sm text-primary">Data sources &amp; methodology</summary>
            <div className="mt-3 space-y-3">
              <p>Each raw tally unit is 12,500,000 zatoshi (0.125 ZEC), per the <a className="text-primary underline underline-offset-4" href="https://github.com/valargroup/vote-sdk/blob/7c59b7cc32593ec1a596b8a007431313d7c568a5/ui/src/App.tsx#L2958">voting software’s conversion</a>. Missing option index 0 fields use protobuf’s zero default.</p>
              <p>Percentages use each question’s vote weight, including abstentions, not its number of voters. Totals cannot be added to count unique participating ZEC or voters. The 1,000,000 ZEC threshold applies to at least one question, including abstentions.</p>
              <p>ZecBlock checks for a complete, matching summary and tally. API responses alone are not independent verification.</p>
              <p>This page refreshes automatically while visible. Source responses are cached for up to five minutes and may remain older during upstream failures.</p>
            </div>
          </details>
        </div>
      </section>
    </section>
  );
}
