'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { CopyableValue } from '../CopyableValue';
import type { ReactNode } from 'react';
import type { VoteResults as Results } from '@/lib/nu7-vote-results';
import {
  NU7_VOTE,
  VOTE_CHAIN,
  QUESTIONS,
  WALLETS,
  RESOURCES,
  type PollQuestion,
} from '@/lib/nu7-vote-config';
import { PageHeader, Badge, type BadgeColor } from '@/components/ui';

interface InitialData {
  ironwoodZec: number | null;
  sproutZec: number | null;
  totalShielded: number | null;
  chainSupply: number | null;
}

type Phase = 'pre-snapshot' | 'pre-vote' | 'active' | 'tallying' | 'results';

function getPhase(now: number): Phase {
  const snapshot = new Date(NU7_VOTE.snapshotTime).getTime();
  const start = new Date(NU7_VOTE.voteStartTime).getTime();
  const end = new Date(NU7_VOTE.voteEndTime).getTime();

  if (now < snapshot) return 'pre-snapshot';
  if (now < start) return 'pre-vote';
  if (now < end) return 'active';
  return 'tallying';
}

function useCountdown(targetIso: string) {
  const [remaining, setRemaining] = useState<number>(
    Math.max(0, new Date(targetIso).getTime() - Date.now())
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, new Date(targetIso).getTime() - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);

  return { days, hours, minutes, seconds, total: remaining };
}

/* ── Vote Chain data types ── */

interface Validator {
  moniker: string;
  operatorAddress: string;
  jailed: boolean;
  status: string;
  tokens: string;
  joinedAt: string;
}

interface CeremonyData {
  status: number;
  eaPk: string;
  validatorCount: number;
  ackCount: number;
  threshold: number;
  phaseStart: number;
}

interface ChainState {
  height: number;
  time: string;
  chainId: string;
  validators: Validator[];
  ceremony: CeremonyData | null;
  voteServers: { url: string; label: string }[];
  pirEndpoints: { url: string; label: string }[];
  roundActive: boolean;
  roundId: string | null;
  voteManagers: number;
  managerThreshold: number;
  voteActivity: VoteActivity;
}

interface RecentBlock {
  height: number;
  time: string;
  txCount: number;
  sigCount: number;
  proposer: string;
}

interface VoteActivity {
  totalTxCount: number;
  blocksWithVotes: RecentBlock[];
}

function useChainState(): ChainState | null {
  const [state, setState] = useState<ChainState | null>(null);
  const knownVoteBlocks = useRef<Map<number, RecentBlock>>(new Map());
  const lastScannedHeight = useRef<number>(0);

  const fetchAll = useCallback(async () => {
    try {
      const [blockRes, validatorsRes, ceremonyRes, configRes, roundRes, managersRes] = await Promise.all([
        fetch(`${VOTE_CHAIN.primaryApi}/cosmos/base/tendermint/v1beta1/blocks/latest`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${VOTE_CHAIN.primaryApi}${VOTE_CHAIN.endpoints.validators}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${VOTE_CHAIN.primaryApi}${VOTE_CHAIN.endpoints.ceremony}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(VOTE_CHAIN.dynamicConfig).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${VOTE_CHAIN.primaryApi}${VOTE_CHAIN.endpoints.activeRound}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${VOTE_CHAIN.primaryApi}${VOTE_CHAIN.endpoints.voteManagers}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);

      const header = blockRes?.block?.header ?? blockRes?.sdk_block?.header;
      const validators: Validator[] = (validatorsRes?.validators ?? []).map((v: any) => ({
        moniker: v.description?.moniker ?? 'Unknown',
        operatorAddress: v.operator_address ?? '',
        jailed: v.jailed ?? false,
        status: v.status ?? '',
        tokens: v.tokens ?? '0',
        joinedAt: v.commission?.update_time ?? '',
      }));

      const ceremony = ceremonyRes?.ceremony ? {
        status: ceremonyRes.ceremony.status,
        eaPk: ceremonyRes.ceremony.ea_pk,
        validatorCount: ceremonyRes.ceremony.validators?.length ?? 0,
        ackCount: ceremonyRes.ceremony.acks?.length ?? 0,
        threshold: ceremonyRes.ceremony.threshold ?? 0,
        phaseStart: ceremonyRes.ceremony.phase_start ?? 0,
      } : null;

      const latestHeight = header ? parseInt(header.height, 10) : 0;

      // Determine scan range: on first load scan back further to find votes,
      // on subsequent polls only check new blocks since last scan
      const isInitialScan = lastScannedHeight.current === 0;
      const scanFrom = isInitialScan
        ? Math.max(1, latestHeight - 60)
        : lastScannedHeight.current + 1;
      const scanTo = latestHeight;

      if (latestHeight > 0 && scanTo >= scanFrom) {
        // Cap at 60 blocks per poll to stay friendly to the API
        const startHeight = Math.max(scanFrom, scanTo - 60);
        const blockPromises = [];
        for (let h = scanTo; h >= startHeight; h--) {
          blockPromises.push(
            fetch(`${VOTE_CHAIN.primaryApi}/cosmos/base/tendermint/v1beta1/blocks/${h}`)
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          );
        }
        const blockResults = await Promise.all(blockPromises);

        for (const b of blockResults) {
          if (!b) continue;
          const h = b?.block?.header ?? b?.sdk_block?.header;
          const txCount = b?.block?.data?.txs?.length ?? 0;
          const sigCount = b?.block?.last_commit?.signatures?.filter(
            (s: any) => s.block_id_flag === 'BLOCK_ID_FLAG_COMMIT'
          ).length ?? 0;
          const block: RecentBlock = {
            height: parseInt(h?.height ?? '0', 10),
            time: h?.time ?? '',
            txCount,
            sigCount,
            proposer: h?.proposer_address ?? '',
          };

          if (txCount > 0) {
            knownVoteBlocks.current.set(block.height, block);
          }
        }

        lastScannedHeight.current = latestHeight;
      }

      // Build vote activity from accumulated known vote blocks
      const allVoteBlocks = Array.from(knownVoteBlocks.current.values())
        .sort((a, b) => b.height - a.height)
        .slice(0, 20);

      const voteActivity: VoteActivity = {
        totalTxCount: allVoteBlocks.reduce((sum, b) => sum + b.txCount, 0),
        blocksWithVotes: allVoteBlocks,
      };

      setState({
        height: latestHeight,
        time: header?.time ?? '',
        chainId: header?.chain_id ?? 'zvote-1',
        validators,
        ceremony,
        voteServers: configRes?.vote_servers ?? [],
        pirEndpoints: configRes?.pir_endpoints ?? [],
        roundActive: !!roundRes?.round,
        roundId: roundRes?.round?.vote_round_id ?? null,
        voteManagers: managersRes?.vote_manager_addresses?.length ?? 0,
        managerThreshold: managersRes?.threshold ?? 0,
        voteActivity,
      });
    } catch {
      // leave null
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 15_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  return state;
}

/* ── Main component ── */

export function NU7VoteClient({ initialData, resultsState, resultsContent, initialNow }: { initialData: InitialData; resultsState: Results['state']; resultsContent: ReactNode; initialNow: number }) {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    if (initialNow >= new Date(NU7_VOTE.voteEndTime).getTime()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [initialNow]);
  const phase = resultsState === 'published' ? 'results' : getPhase(now);
  const closed = phase === 'results' || phase === 'tallying';
  const snapshotCountdown = useCountdown(NU7_VOTE.snapshotTime);
  const voteStartCountdown = useCountdown(NU7_VOTE.voteStartTime);
  const voteEndCountdown = useCountdown(NU7_VOTE.voteEndTime);
  const chainState = useChainState();
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [activeTab, setActiveTab] = useState<'vote' | 'chain'>('vote');

  const countdown = phase === 'pre-snapshot'
    ? snapshotCountdown
    : phase === 'pre-vote'
      ? voteStartCountdown
      : voteEndCountdown;
  const countdownLabel = phase === 'pre-snapshot'
    ? 'Until snapshot'
    : phase === 'active'
      ? 'Voting closes in'
      : phase === 'tallying' || phase === 'results'
        ? 'Vote closed'
        : 'Until voting opens';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      {/* Header */}
      <PageHeader
        eyebrow="GOVERNANCE"
        eyebrowHref="/governance"
        title={closed ? "NU7 Coinholder Vote Results" : "NU7 Coinholder Vote"}
        subtitle="Private coinholder vote on NU7 scope — issuance smoothing, Sprout deprecation, 25-second blocks, and upgrade schedule. Organized by Valar Group and Project Tachyon."
        actions={<PhaseBadge phase={phase} />}
      />

      {closed && resultsContent}

      {/* Countdown + Context */}
      {!closed && (
      <div className="rounded-2xl border border-cipher-border bg-cipher-card overflow-hidden mb-8">
        <div className="flex items-center gap-2 border-b border-cipher-border-subtle px-4 py-2.5 sm:px-5">
          <span className="h-2 w-2 rounded-full bg-brand-gold animate-pulse" />
          <span className="text-caption font-mono uppercase tracking-wider text-secondary">
            {countdownLabel}
          </span>
          {phase === 'pre-snapshot' && (
            <Link href={`/block/${NU7_VOTE.snapshotHeight}`} prefetch={false} className="text-caption font-mono text-muted hover:text-primary transition-colors ml-auto">
              Block #{NU7_VOTE.snapshotHeight.toLocaleString()}
            </Link>
          )}
        </div>

        <div className="p-5 sm:p-6">
          {countdown.total > 0 && (
            <div className="flex items-center justify-center gap-3 sm:gap-5 mb-6">
              <CountdownUnit value={countdown.days} label="days" />
              <span className="text-2xl sm:text-3xl font-semibold text-muted -mt-4">:</span>
              <CountdownUnit value={countdown.hours} label="hours" />
              <span className="text-2xl sm:text-3xl font-semibold text-muted -mt-4">:</span>
              <CountdownUnit value={countdown.minutes} label="min" />
              <span className="text-2xl sm:text-3xl font-semibold text-muted -mt-4">:</span>
              <CountdownUnit value={countdown.seconds} label="sec" />
            </div>
          )}

          <div className="border-t border-cipher-border-subtle pt-5">
            <div className="flex items-center justify-between text-caption font-mono text-muted mb-2">
              <span>Ironwood shielded supply (upper bound on eligibility)</span>
              <span>{NU7_VOTE.legitimacyThreshold.toLocaleString()} ZEC threshold</span>
            </div>
            <div className="relative h-8 rounded-lg bg-glass-3 overflow-hidden">
              {initialData.ironwoodZec != null && (
                <>
                  <div
                    className="absolute inset-y-0 left-0 rounded-lg bg-brand-gold/20 border-r-2 border-brand-gold"
                    style={{ width: `${Math.min((initialData.ironwoodZec / (initialData.ironwoodZec * 1.15)) * 100, 100)}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 border-r-2 border-dashed border-primary/40"
                    style={{ width: `${(NU7_VOTE.legitimacyThreshold / (initialData.ironwoodZec * 1.15)) * 100}%` }}
                  />
                </>
              )}
              <div className="absolute inset-0 flex items-center justify-between px-4">
                <span className="text-sm font-semibold font-mono text-cipher-gold tabular-nums">
                  {initialData.ironwoodZec != null
                    ? `${(initialData.ironwoodZec / 1_000_000).toFixed(2)}M ZEC`
                    : '—'}
                </span>
                <span className="text-caption font-mono text-muted">
                  {initialData.ironwoodZec != null
                    ? `${((initialData.ironwoodZec / NU7_VOTE.legitimacyThreshold) * 100).toFixed(0)}% of threshold`
                    : ''}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      )}

      {/* Key Dates — right after countdown */}
      <div className="rounded-2xl border border-cipher-border bg-cipher-card mb-8">
        <div className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-cipher-border-subtle">
          <DateCell
            label="Snapshot"
            date={formatVoteDate(NU7_VOTE.snapshotTime)}
            time={formatVoteTime(NU7_VOTE.snapshotTime)}
            note="Ironwood funds must be spendable"
          />
          <DateCell
            label="Voting opens"
            date={formatVoteDate(NU7_VOTE.voteStartTime)}
            time=""
            note={`~${votingWindowDays} days to cast votes`}
          />
          <DateCell
            label="Voting closes"
            date={formatVoteDate(NU7_VOTE.voteEndTime)}
            time={formatVoteTime(NU7_VOTE.voteEndTime)}
            note={closed ? "Voting has ended" : "Results follow after tallying"}
          />
        </div>
      </div>

      {/* Published results already contain the full questions and options. */}
      {resultsState === 'published' ? (
        <details className="mb-8 rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6">
          <summary className="cursor-pointer text-sm font-semibold text-primary">Voting chain details</summary>
          <div className="mt-5"><ChainExplorerTab chainState={chainState} /></div>
        </details>
      ) : (
      <div className="mb-8">
        <div className="flex gap-1 p-1 rounded-lg bg-glass-3 w-fit mb-6">
          <button
            onClick={() => setActiveTab('vote')}
            className={`px-4 py-2 text-xs font-mono font-semibold rounded-md transition ${
              activeTab === 'vote'
                ? 'bg-cipher-bg text-primary shadow-sm ring-1 ring-glass-12'
                : 'text-muted hover:text-secondary'
            }`}
          >
            Poll details
          </button>
          <button
            onClick={() => setActiveTab('chain')}
            className={`px-4 py-2 text-xs font-mono font-semibold rounded-md transition ${
              activeTab === 'chain'
                ? 'bg-cipher-bg text-primary shadow-sm ring-1 ring-glass-12'
                : 'text-muted hover:text-secondary'
            }`}
          >
            Chain Explorer
          </button>
        </div>

        {activeTab === 'vote' ? (
          <VoteTab
            activeQuestion={activeQuestion}
            setActiveQuestion={setActiveQuestion}
            chainState={chainState}
          />
        ) : (
          <ChainExplorerTab chainState={chainState} />
        )}
      </div>

      )}

      {/* Resources */}
      <div className="mb-8">
        <SectionLabel label="RESOURCES_&_AUDIT" />
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {RESOURCES.map(r => (
            <a
              key={r.url}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-cipher-border hover:border-glass-12 hover:bg-glass-2 transition-colors text-xs font-mono text-secondary hover:text-primary"
            >
              <ExternalIcon />
              <span className="truncate">{r.label}</span>
            </a>
          ))}
        </div>
      </div>

      {/* Methodology */}
      <div className="rounded-2xl border border-cipher-border bg-cipher-card p-5 sm:p-6">
        <h3 className="text-xs font-mono font-semibold text-secondary uppercase tracking-wider mb-2">What ZecBlock shows</h3>
        <p className="text-xs text-muted leading-relaxed max-w-3xl">
          This page displays public vote parameters, published aggregate results, and live chain state from the Valar
          zvote-1 REST API. ZecBlock has not independently verified the tally. Follow the verification
          instructions above to check it against your own full node. Individual ballots remain private.
        </p>
      </div>
    </div>
  );
}

/* ── Vote Tab ── */

function VoteTab({
  activeQuestion,
  setActiveQuestion,
  chainState,
}: {
  activeQuestion: number;
  setActiveQuestion: (i: number) => void;
  chainState: ChainState | null;
}) {
  return (
    <div className="grid lg:grid-cols-3 gap-6">
      {/* Questions — takes 2 cols */}
      <div className="lg:col-span-2">
        <SectionLabel label="POLL_QUESTIONS" />
        <div className="rounded-2xl border border-cipher-border bg-cipher-card overflow-hidden">
          <div className="flex border-b border-cipher-border-subtle overflow-x-auto p-1 gap-1">
            {QUESTIONS.map((q, i) => (
              <button
                key={q.id}
                onClick={() => setActiveQuestion(i)}
                className={`shrink-0 px-3.5 py-2 text-xs font-mono rounded-md transition ${
                  i === activeQuestion
                    ? 'bg-cipher-bg text-primary shadow-sm ring-1 ring-glass-12'
                    : 'text-muted hover:text-secondary'
                }`}
              >
                Q{i + 1}
              </button>
            ))}
          </div>
          <div className="p-5 sm:p-6">
            <QuestionContent q={QUESTIONS[activeQuestion]} />
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="space-y-6">
        {/* Wallet support */}
        <div>
          <SectionLabel label="WALLET_SUPPORT" />
          <div className="rounded-2xl border border-cipher-border bg-cipher-card p-5">
            <div className="space-y-3">
              {WALLETS.map(w => (
                <div key={w.name} className="flex items-center justify-between">
                  <span className="text-xs font-mono text-secondary">{w.name}</span>
                  <WalletBadge status={w.status} />
                </div>
              ))}
            </div>
            <p className="mt-4 text-caption text-muted leading-relaxed">
              Wallets that supported this vote. ZecBlock does not handle votes or keys.
            </p>
          </div>
        </div>

        {/* Quick chain status */}
        <div>
          <SectionLabel label="CHAIN_STATUS" live />
          <div className="rounded-2xl border border-cipher-border bg-cipher-card p-5">
            <div className="space-y-3">
              <StatusRow label="Height" value={chainState?.height?.toLocaleString() ?? '—'} mono />
              <StatusRow label="Validators" value={chainState?.validators?.length?.toString() ?? '—'} />
              <StatusRow
                label="Active round"
                value={chainState ? (chainState.roundActive ? 'Yes' : 'None') : 'Unavailable'}
                accent={chainState?.roundActive}
              />
              <StatusRow
                label="DKG ceremony"
                value={chainState?.ceremony ? `${chainState.ceremony.ackCount}/${chainState.ceremony.validatorCount} acks` : '—'}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Chain Explorer Tab ── */

function ChainExplorerTab({ chainState }: { chainState: ChainState | null }) {
  if (!chainState) {
    return (
      <div className="h-64 rounded-2xl border border-cipher-border bg-cipher-card flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-cipher-border border-t-cipher-gold rounded-full animate-spin" />
          <span className="text-xs font-mono text-muted">Connecting to zvote-1…</span>
        </div>
      </div>
    );
  }

  const ceremonyStatus = chainState.ceremony
    ? chainState.ceremony.status === 3 ? 'Finalized' : chainState.ceremony.status === 2 ? 'Acknowledging' : 'In progress'
    : 'Unknown';

  const allActive = chainState.validators.filter(v => !v.jailed).length;

  return (
    <div className="space-y-8">
      {/* Chain overview — compact stats bar */}
      <div className="rounded-2xl border border-cipher-border bg-cipher-card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-cipher-border-subtle px-5 py-2.5">
          <span className="h-2 w-2 rounded-full bg-cipher-green animate-pulse" />
          <span className="text-caption font-mono uppercase tracking-wider text-secondary">zvote-1</span>
          <span className="text-caption text-muted ml-1">— the dedicated voting chain</span>
          <span className="ml-auto text-caption font-mono text-muted">
            {chainState.time ? formatBlockTime(chainState.time) + ' UTC' : ''}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-cipher-border-subtle">
          <StatCell label="Block height" value={chainState.height.toLocaleString()} />
          <StatCell label="Validators" value={String(chainState.validators.length)} sub={`${allActive} signing`} />
          <StatCell label="Vote servers" value={String(chainState.voteServers.length)} sub="Accept encrypted votes" />
          <StatCell label="Coordinators" value={String(chainState.voteManagers)} sub={`${chainState.managerThreshold} needed to start`} />
        </div>
      </div>

      {/* Two-column layout: Blocks + Key Setup */}
      <div className="space-y-6">
        {/* Vote activity — blocks with submissions */}
        <div>
          <SectionLabel label="RECENT_TRANSACTIONS" live />
          <p className="text-caption text-muted -mt-2 mb-3">
            Blocks with protocol transactions. Each voter generates multiple: a delegation proof, one ballot per question, and share reveals.
          </p>
          {chainState.voteActivity.blocksWithVotes.length > 0 ? (
            <div className="rounded-2xl border border-cipher-border bg-cipher-card">
              <div className="flex items-center justify-between border-b border-cipher-border-subtle px-4 py-2.5">
                <span className="text-caption font-mono text-muted">
                  Since page load · not a turnout count
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b border-cipher-border-subtle text-caption text-muted uppercase tracking-wider">
                      <th className="text-left px-4 py-2.5 font-medium">Height</th>
                      <th className="text-left px-4 py-2.5 font-medium">Time</th>
                      <th className="text-center px-4 py-2.5 font-medium">
                        <Tip text="On-chain protocol steps: delegations (eligibility proofs), cast-votes (encrypted ballot per question), and share reveals. A single voter generates multiple transactions.">Txs</Tip>
                      </th>
                      <th className="text-center px-4 py-2.5 font-medium">
                        <Tip text="How many validators signed this block. Full consensus = all validators agree.">Consensus</Tip>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cipher-border-subtle">
                    {chainState.voteActivity.blocksWithVotes.map(b => (
                      <tr key={b.height} className="hover:bg-glass-2 transition-colors">
                        <td className="px-4 py-2 text-primary tabular-nums">{b.height.toLocaleString()}</td>
                        <td className="px-4 py-2 text-muted tabular-nums">
                          {b.time ? formatBlockTime(b.time) : '—'}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-brand-gold/10 text-cipher-gold-bright font-semibold text-caption">
                            {b.txCount}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-center">
                          <span className={`tabular-nums ${b.sigCount === chainState.validators.length ? 'text-cipher-green' : 'text-brand-gold'}`}>
                            {b.sigCount}/{chainState.validators.length}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-cipher-border bg-cipher-card p-5 text-center">
              <p className="text-xs text-muted">No vote submissions found yet. Once voters submit ballots, their blocks will appear here.</p>
            </div>
          )}
        </div>

        {/* Key Ceremony — horizontal card */}
        <div>
          <SectionLabel label="KEY_CEREMONY" />
          <p className="text-caption text-muted -mt-2 mb-3">
            <Tip text="Distributed Key Generation — validators jointly create an encryption key without anyone holding the full private key">DKG</Tip>
            {' '}splits decryption power across validators so no single party can read votes.
          </p>
          <div className="rounded-2xl border border-cipher-border bg-cipher-card p-5">
            {chainState.ceremony ? (
              <div className="grid md:grid-cols-[1fr_1px_1fr] gap-5">
                {/* Left: status + progress */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-caption font-mono font-semibold border ${
                      ceremonyStatus === 'Finalized'
                        ? 'border-cipher-green/30 text-cipher-green bg-cipher-green/5'
                        : 'border-brand-gold/30 text-brand-gold bg-brand-gold/5'
                    }`}>
                      {ceremonyStatus}
                    </span>
                    <span className="text-caption text-muted font-mono">
                      <Tip text="Minimum validators needed to decrypt the final tally.">Threshold</Tip>: {chainState.ceremony.threshold} of {chainState.ceremony.validatorCount}
                    </span>
                  </div>
                  <div>
                    <div className="flex justify-between text-caption font-mono text-muted mb-1.5">
                      <span><Tip text="Each validator must confirm they received and verified their share of the encryption key">Confirmations</Tip></span>
                      <span className="text-secondary">{chainState.ceremony.ackCount}/{chainState.ceremony.validatorCount}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-glass-6 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-cipher-green transition-[width] duration-500"
                        style={{ width: `${(chainState.ceremony.ackCount / Math.max(chainState.ceremony.validatorCount, 1)) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="text-caption font-mono text-muted mb-1">
                      <Tip text="The combined public key used to encrypt all votes. No single validator holds the matching private key.">Election authority key</Tip>
                    </div>
                    <div className="font-mono text-caption text-secondary bg-glass-3 rounded-lg px-3 py-2 break-all leading-relaxed">
                      <CopyableValue value={chainState.ceremony.eaPk} label="election authority key" />
                    </div>
                  </div>
                </div>

                {/* Divider */}
                <div className="hidden md:block bg-cipher-border-subtle" />

                {/* Right: key holders */}
                <div>
                  <div className="text-caption font-mono text-muted uppercase tracking-wider mb-2">
                    <Tip text="Independent organizations that each hold a piece of the decryption key. They produce blocks and store encrypted vote shares.">Key holders</Tip>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {chainState.validators.map(v => (
                      <div key={v.operatorAddress} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-glass-2">
                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${v.jailed ? 'bg-danger' : 'bg-cipher-green'}`} />
                        <span className="text-caption font-mono text-secondary truncate">{v.moniker}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-caption text-muted mt-2.5">
                    At least {chainState.ceremony.threshold} must cooperate to reveal the final tally.
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted">No ceremony data available.</p>
            )}
          </div>
        </div>

        {/* Network participants — unified */}
        <div>
          <SectionLabel label="NETWORK_PARTICIPANTS" />
          <p className="text-caption text-muted -mt-2 mb-3">
            Each organization runs a <Tip text="A validator produces blocks, runs a vote server for wallets, and holds a share of the decryption key. They are all three roles at once.">validator + vote server</Tip>. Some also operate <Tip text="Private Information Retrieval servers let wallets prove eligibility without revealing which Zcash note they own.">PIR servers</Tip>.
          </p>
          <div className="rounded-2xl border border-cipher-border bg-cipher-card overflow-hidden">
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-cipher-border-subtle">
              {chainState.voteServers.map(s => {
                const pirOp = chainState.pirEndpoints.some(p =>
                  p.label.toLowerCase().includes(s.label.toLowerCase()) ||
                  p.url.toLowerCase().includes(s.label.toLowerCase())
                );
                return (
                  <div key={s.label} className="px-4 py-3 flex flex-col items-center text-center">
                    <span className="h-2 w-2 rounded-full bg-cipher-green mb-2" />
                    <span className="text-caption font-mono font-semibold text-primary">{s.label}</span>
                    <div className="flex items-center gap-1 mt-1.5">
                      <RoleDot label="V" title="Validator" active />
                      <RoleDot label="S" title="Vote server" active />
                      <RoleDot label="P" title="PIR server" active={pirOp} />
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Legend */}
            <div className="border-t border-cipher-border-subtle px-4 py-2.5 flex items-center gap-4 text-caption text-muted font-mono">
              <span className="flex items-center gap-1"><RoleDot label="V" title="" active /> Validator</span>
              <span className="flex items-center gap-1"><RoleDot label="S" title="" active /> Vote server</span>
              <span className="flex items-center gap-1"><RoleDot label="P" title="" active /> PIR server</span>
              <span className="ml-auto">{chainState.pirEndpoints.length} PIR endpoints total</span>
            </div>
          </div>
        </div>

        {/* How it works — full width, compact */}
        <div className="rounded-2xl border border-cipher-border bg-cipher-card p-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-8">
            <div className="text-caption font-mono text-muted uppercase tracking-wider shrink-0">How voting works</div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <StepInline n={1} text="Prove Ironwood funds (ZK)" />
              <StepArrow />
              <StepInline n={2} text="Encrypt vote" />
              <StepArrow />
              <StepInline n={3} text="Accumulate on-chain" />
              <StepArrow />
              <StepInline n={4} text="Decrypt aggregate only" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function CountdownUnit({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-center">
      <div className="text-3xl sm:text-4xl font-semibold font-mono tabular-nums tracking-tight text-primary">
        {String(value).padStart(2, '0')}
      </div>
      <div className="text-caption font-mono text-muted uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: Phase }) {
  const config: Record<Phase, { label: string; color: BadgeColor }> = {
    'pre-snapshot': { label: 'Snapshot pending', color: 'muted' },
    'pre-vote': { label: 'Vote starting soon', color: 'muted' },
    active: { label: 'Voting open', color: 'green' },
    tallying: { label: 'Vote closed', color: 'muted' },
    results: { label: 'Results published', color: 'green' },
  };
  const c = config[phase];
  return <Badge color={c.color}>{c.label}</Badge>;
}

function MetricCell({ label, value, accent }: { label: string; value: string; accent?: 'yellow' | 'gold' }) {
  const valueColor = accent === 'yellow' ? 'text-cipher-gold' : accent === 'gold' ? 'text-cipher-gold-bright' : 'text-primary';
  return (
    <div>
      <div className="text-caption font-mono uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 text-sm sm:text-base font-semibold font-mono tabular-nums ${valueColor}`}>
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ label, live }: { label: string; live?: boolean }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-xs text-muted font-mono uppercase tracking-widest opacity-50">{'>'}</span>
      <h2 className="text-xs font-semibold font-mono text-secondary lowercase tracking-tight">{label}</h2>
      {live && (
        <span className="relative flex h-2 w-2" role="img" aria-label="Live">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cipher-green opacity-60" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-cipher-green" />
        </span>
      )}
    </div>
  );
}

function QuestionContent({ q }: { q: PollQuestion }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-primary mb-2">{q.title}</h3>
      <p className="text-xs text-secondary leading-relaxed mb-5">{q.description}</p>
      <div className="space-y-2.5">
        {q.options.map((opt, i) => (
          <div key={i} className="flex items-start gap-3 px-3.5 py-2.5 rounded-lg bg-glass-2 border border-cipher-border-subtle">
            <span className="shrink-0 w-6 h-6 rounded-md bg-glass-6 text-secondary flex items-center justify-center text-caption font-mono font-semibold mt-0.5">
              {String.fromCharCode(65 + i)}
            </span>
            <span className="text-xs text-secondary leading-relaxed">{opt}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusRow({ label, value, accent, mono }: { label: string; value: string; accent?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-mono text-muted">{label}</span>
      <span className={`text-xs font-mono font-semibold ${accent ? 'text-cipher-green' : 'text-secondary'} ${mono ? 'tabular-nums' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function WalletBadge({ status }: { status: 'confirmed' | 'expected' | 'unknown' }) {
  if (status === 'confirmed') {
    return <span className="text-caption font-mono font-semibold text-cipher-green border border-cipher-green/20 bg-cipher-green/5 rounded-full px-2 py-0.5">Confirmed</span>;
  }
  if (status === 'expected') {
    return <span className="text-caption font-mono font-semibold text-brand-gold border border-brand-gold/20 bg-brand-gold/5 rounded-full px-2 py-0.5">Expected</span>;
  }
  return <span className="text-caption font-mono font-semibold text-muted border border-cipher-border rounded-full px-2 py-0.5">Unknown</span>;
}

function formatVoteDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatVoteTime(iso: string): string {
  return `${new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })} UTC`;
}

function formatBlockTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });

  if (diffDays === 0) return time;
  if (diffDays === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${time}`;
}

// Derived from config rather than hardcoded so this can't silently drift from
// NU7_VOTE.voteEndTime again if the voting window is extended (as it was once
// already, per ebfull: "the end of the vote was extended by two days").
// Floor (not round) to match the forum's own "~N days" convention, e.g. the
// original Aug25->Sep12 window was announced as "~18 days" even though the
// exact interval is 18 days 19h.
const votingWindowDays = Math.floor(
  (new Date(NU7_VOTE.voteEndTime).getTime() - new Date(NU7_VOTE.voteStartTime).getTime()) /
    (1000 * 60 * 60 * 24)
);

function DateCell({ label, date, time, note }: { label: string; date: string; time: string; note: string }) {
  return (
    <div className="p-5">
      <div className="text-caption font-mono uppercase tracking-wider text-muted mb-1">{label}</div>
      <div className="text-sm font-semibold font-mono text-primary">
        {date}
        {time && <span className="text-muted font-normal ml-1.5">· {time}</span>}
      </div>
      <div className="text-caption text-muted mt-1">{note}</div>
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg className="w-3 h-3 shrink-0 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="group/tip relative inline-flex items-center gap-0.5 cursor-help border-b border-dashed border-muted/40">
      {children}
      <svg className="w-2.5 h-2.5 text-muted inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span className="absolute left-0 top-full mt-2 px-3 py-2 rounded-lg bg-cipher-bg border border-cipher-border text-caption text-secondary leading-relaxed normal-case tracking-normal font-normal w-52 opacity-0 pointer-events-none group-hover/tip:opacity-100 group-hover/tip:pointer-events-auto transition-opacity z-50 shadow-lg">
        {text}
      </span>
    </span>
  );
}

function StatCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-cipher-surface p-4">
      <div className="text-caption font-mono text-muted uppercase tracking-wider">{label}</div>
      <div className="text-lg font-semibold font-mono text-primary tabular-nums mt-1">{value}</div>
      {sub && <div className="text-caption text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-glass-6 text-secondary flex items-center justify-center text-caption font-mono font-semibold mt-0.5">
        {n}
      </span>
      <span className="text-caption text-secondary leading-relaxed">{text}</span>
    </div>
  );
}

function RoleDot({ label, title, active }: { label: string; title: string; active: boolean }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center justify-center w-4 h-4 rounded text-caption font-mono font-semibold ${
        active
          ? 'bg-glass-6 text-primary'
          : 'bg-glass-3 text-muted'
      }`}
    >
      {label}
    </span>
  );
}

function StepInline({ n, text }: { n: number; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-4 h-4 rounded-full bg-glass-6 text-secondary flex items-center justify-center text-caption font-mono font-semibold shrink-0">
        {n}
      </span>
      <span className="text-caption text-secondary">{text}</span>
    </span>
  );
}

function StepArrow() {
  return (
    <svg className="w-3 h-3 text-muted shrink-0 hidden sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}
