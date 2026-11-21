'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { StakingDayBanner } from '@/components/StakingDayBanner';
import { CopyButton } from '@/components/CopyButton';
import { HashLink } from '@/components/ui/HashLink';
import { PageHeader } from '@/components/ui/SectionHeader';
import { CURRENCY } from '@/lib/config';
import { displayPubkey } from '@/lib/utils';
import { getFinalizerLabel, finalizerAvatarStyle } from '@/lib/finalizer-labels';
import { getApiUrl } from '@/lib/api-config';

interface RosterMember {
  identity: string;
  stake_zats: number;
  stake_zec?: number;
  voted?: boolean | null;
  highest_round?: number | null;
  last_connected_utc?: number | null;
  connected?: boolean | null;
  votingEligible?: boolean;
}

interface LivenessData {
  available?: boolean;
  unavailableReason?: string | null;
  observedAt?: string | null;
  bftHeight: number | null;
  bftRound: number | null;
  onlineCount: number | null;
  onlineStakeZec: number | null;
  onlinePercent: number | null;
  connectedCount?: number | null;
  connectedStakeZec?: number | null;
  connectedPercent?: number | null;
}

interface ValidatorData {
  roster: RosterMember[];
  finalizerCount: number;
  candidateCount: number;
  totalStakeZec: number;
  finalizedHeight: number;
  tipHeight: number;
  liveness?: LivenessData;
}

export default function ValidatorsPage() {
  const [data, setData] = useState<ValidatorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [expiredObservation, setExpiredObservation] = useState<string | null>(null);
  // pubkey (lowercase) -> participation_pct over the last 500 blocks
  const [participation, setParticipation] = useState<Record<string, number>>({});

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/v1/crosslink`);
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await readApiData(res);
      if (!json) throw new Error(json.error || 'Unknown error');

      setData({
        roster: json.roster || [],
        finalizerCount: json.finalizerCount || 0,
        candidateCount: json.candidateCount ?? json.roster?.length ?? 0,
        totalStakeZec: json.totalStakeZec || 0,
        finalizedHeight: json.finalizedHeight || 0,
        tipHeight: json.tipHeight || 0,
        liveness: json.liveness || undefined,
      });
      setError(null);

      const roster = json.roster || [];
      const apiBase = getApiUrl();
      const results = await Promise.allSettled(
        roster.map((m: RosterMember) =>
          fetch(`${apiBase}/v1/crosslink/finalizers/${m.identity}/participation?window=500`).then((r) =>
            r.ok ? readApiData(r) : null
          )
        )
      );
      const next: Record<string, number> = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          next[roster[i].identity.toLowerCase()] = r.value.participation_pct || 0;
        }
      });
      setParticipation(next);
    } catch (err: any) {
      setData(null);
      setParticipation({});
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    const refreshVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Re-evaluate the observation age immediately after a backgrounded tab
      // resumes, before the slower replacement RPC response arrives.
      setData(current => current ? { ...current } : current);
      void fetchData();
    };
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [fetchData]);

  const observedAt = data?.liveness?.observedAt;
  const observationAge = observedAt ? Date.now() - Date.parse(observedAt) : NaN;
  // The API accepts a 60-second native snapshot and caches it for 30 seconds.
  const observationCurrent = expiredObservation !== observedAt && Number.isFinite(observationAge) && observationAge >= -5000 && observationAge <= 90000;
  useEffect(() => {
    if (!observedAt) return;
    const remaining = Date.parse(observedAt) + 90000 - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    // Expire even if a foreground refresh never resolves. A new observation
    // has its own timestamp, so an old expiry cannot hide a replacement.
    const timer = setTimeout(() => setExpiredObservation(observedAt), remaining + 1);
    return () => clearTimeout(timer);
  }, [observedAt]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <PageHeader
        eyebrow="FINALIZER_ROSTER"
        title="Finalizer Roster"
        subtitle="Voting finalizers and delegated-stake candidates on Crosslink"
      />

      <div className="mb-6">
        <StakingDayBanner />
      </div>

      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <div className="card p-4 text-center min-w-0">
            <span className="text-caption font-mono text-muted uppercase tracking-wider block mb-1">Finalizers</span>
            <span className="text-xl sm:text-2xl font-mono font-semibold text-primary tabular-nums whitespace-nowrap">{data.finalizerCount}</span>
            <span className="text-caption font-mono text-muted block">{data.candidateCount} candidates</span>
          </div>
          <div className="card p-4 text-center min-w-0">
            <span className="text-caption font-mono text-muted uppercase tracking-wider block mb-1">Delegated Stake</span>
            <span className="text-xl sm:text-2xl font-mono font-semibold text-primary tabular-nums whitespace-nowrap">
              {data.totalStakeZec.toFixed(2)}
              <span className="text-caption font-medium text-muted ml-1">{CURRENCY}</span>
            </span>
          </div>
          <div className="card p-4 text-center min-w-0">
            <span className="text-caption font-mono text-muted uppercase tracking-wider block mb-1">Finalized</span>
            <span className="text-xl sm:text-2xl font-mono font-semibold text-primary tabular-nums whitespace-nowrap">{data.finalizedHeight.toLocaleString()}</span>
          </div>
          <div className="card p-4 text-center min-w-0">
            <span className="text-caption font-mono text-muted uppercase tracking-wider block mb-1">PoW Tip</span>
            <span className="text-xl sm:text-2xl font-mono font-semibold text-primary tabular-nums whitespace-nowrap">{data.tipHeight.toLocaleString()}</span>
          </div>
        </div>
      )}

      {data?.liveness?.available === true && observationCurrent ? (
        <div className="card p-4 mb-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-mono text-muted uppercase tracking-wider">Finalizer Observations</h3>
            <span className="text-caption font-mono text-muted">
              BFT height {data.liveness.bftHeight?.toLocaleString()} &middot; round {data.liveness.bftRound}
              {observedAt ? <> &middot; <time dateTime={observedAt} title={observedAt}>{new Date(observedAt).toLocaleTimeString()}</time></> : null}
            </span>
          </div>

          {data.liveness.connectedPercent != null && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-caption font-mono text-muted uppercase w-24">Recent packets</span>
                <div className="flex-1 flex rounded-full overflow-hidden h-3 bg-cipher-border-alpha/30">
                  <div
                    className="bg-cipher-gold transition-[width] duration-500"
                    style={{ width: `${data.liveness.connectedPercent}%` }}
                    title={`Packets observed within five minutes: ${data.liveness.connectedCount} voting finalizers (${data.liveness.connectedStakeZec?.toFixed(2)} ${CURRENCY})`}
                  />
                </div>
                <span className="text-caption font-mono text-cipher-gold w-24 text-right">
                  {data.liveness.connectedCount} ({data.liveness.connectedPercent}%)
                </span>
              </div>
            </>
          )}

          {data.liveness.onlinePercent != null ? <div className="flex items-center gap-2 mb-2">
            <span className="text-caption font-mono text-muted uppercase w-24">Votes this height</span>
            <div className="flex-1 flex rounded-full overflow-hidden h-3 bg-cipher-border-alpha/30">
              <div
                className="bg-cipher-green transition-[width] duration-500"
                style={{ width: `${data.liveness.onlinePercent}%` }}
                title={`Vote observed: ${data.liveness.onlineCount} voting finalizers (${data.liveness.onlineStakeZec?.toFixed(2)} ${CURRENCY})`}
              />
            </div>
            <span className="text-caption font-mono text-cipher-green w-24 text-right">
              {data.liveness.onlineCount} ({data.liveness.onlinePercent}%)
            </span>
          </div> : <p className="text-caption font-mono text-muted mb-2">Vote share is unavailable without a positive voting-stake total.</p>}

          <p className="text-caption font-mono text-muted">
            Observed by this node. Percentages use stake in the {data.finalizerCount}-member voting roster.
            A missing vote does not mean a finalizer is offline.
          </p>
        </div>
      ) : data ? (
        <div className="card p-4 mb-8 text-sm text-muted" role="status">
          Recent finalizer observations are unavailable. Vote and packet totals require a current matching voting roster.
        </div>
      ) : null}

      {loading ? (
        <div className="card p-0 overflow-x-auto no-scrollbar">
          <table className="w-full min-w-[480px]">
            <thead>
              <tr>
                <th className="px-3 sm:px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Rank</th>
                <th className="px-3 sm:px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Public Key</th>
                <th className="px-3 sm:px-4 py-3 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Stake</th>
                <th className="px-3 sm:px-4 py-3 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Share</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5].map((i) => (
                <tr key={i} className="animate-pulse">
                  <td className="px-3 sm:px-4 py-4 border-b border-cipher-border"><div className="h-4 w-8 skeleton-bg rounded" /></td>
                  <td className="px-3 sm:px-4 py-4 border-b border-cipher-border"><div className="h-4 w-32 sm:w-48 skeleton-bg rounded" /></td>
                  <td className="px-3 sm:px-4 py-4 border-b border-cipher-border"><div className="h-4 w-16 sm:w-20 skeleton-bg rounded ml-auto" /></td>
                  <td className="px-3 sm:px-4 py-4 border-b border-cipher-border"><div className="h-4 w-12 skeleton-bg rounded ml-auto" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : error ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-muted font-mono">Crosslink RPC unavailable</p>
          <p className="text-xs text-muted mt-2">{error}</p>
        </div>
      ) : data && data.roster.length > 0 ? (
        <>
          <div className="mb-4">
            <div className="relative">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value.toLowerCase().trim())}
                placeholder="Filter by name or public key"
                className="w-full bg-cipher-bg border border-cipher-border rounded-md px-3 py-2.5 pl-9 text-sm font-mono text-primary placeholder:text-muted focus:outline-none focus:border-cipher-gold/60 transition-colors"
              />
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.2-5.2M10 18a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
              {filter && (
                <button
                  onClick={() => setFilter('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-primary text-xs font-mono"
                >
                  clear
                </button>
              )}
            </div>
          </div>

          <div className="card p-0 overflow-x-auto no-scrollbar">
            <table className="w-full min-w-[480px]">
              <thead>
                <tr>
                  <th className="px-3 sm:px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border w-12 sm:w-16">Rank</th>
                  <th className="px-2 py-3 text-center text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border w-10" title="Local node observations: gold = recent packet, green = vote at this BFT height; gray = no observation or outside the voting roster">Status</th>
                  <th className="px-3 sm:px-4 py-3 text-left text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Finalizer</th>
                  <th className="px-3 sm:px-4 py-3 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border">Stake ({CURRENCY})</th>
                  <th className="px-3 sm:px-4 py-3 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border w-20 sm:w-24">Share</th>
                  <th className="px-3 sm:px-4 py-3 text-right text-caption font-semibold uppercase tracking-wider text-muted border-b border-cipher-border w-24 sm:w-28">Voting (500)</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const filtered = filter
                    ? data.roster
                        .map((m, origIdx) => ({ m, origIdx }))
                        .filter(({ m }) => {
                          const raw = m.identity.toLowerCase();
                          const display = displayPubkey(raw).toLowerCase();
                          const label = getFinalizerLabel(m.identity);
                          const labelName = label?.name.toLowerCase() ?? '';
                          return raw.includes(filter) || display.includes(filter) || labelName.includes(filter);
                        })
                    : data.roster.map((m, origIdx) => ({ m, origIdx }));

                  if (filtered.length === 0) {
                    return (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-4 py-8 text-center text-sm text-muted font-mono border-b border-cipher-border"
                        >
                          No finalizer matches &ldquo;{filter}&rdquo;
                        </td>
                      </tr>
                    );
                  }

                  return filtered.map(({ m: member, origIdx }) => {
                  const i = origIdx;
                  const share = data.totalStakeZec > 0
                    ? ((member.stake_zec || 0) / data.totalStakeZec * 100)
                    : 0;
                  const display = displayPubkey(member.identity);
                  const label = getFinalizerLabel(member.identity);

                  return (
                    <tr
                      key={member.identity}
                      className="group transition-colors duration-100 hover:bg-cipher-hover"
                    >
                      <td className="px-3 sm:px-4 h-[60px] border-b border-cipher-border">
                        <span className="font-mono text-sm text-muted">#{i + 1}</span>
                      </td>
                      <td className="px-2 h-[60px] border-b border-cipher-border text-center">
                        {(() => {
                          if (member.votingEligible === false) {
                            return <span className="inline-block w-2.5 h-2.5 rounded-full bg-cipher-border-alpha/40" title="Delegated candidate outside the current voting roster" />;
                          }
                          if (data.liveness?.available !== true || !observationCurrent) {
                            return <span className="inline-block w-2.5 h-2.5 rounded-full bg-cipher-border-alpha/40" title="Recent finalizer observations unavailable" />;
                          }
                          const lastConn = member.last_connected_utc;
                          const ago = lastConn ? Math.max(0, Math.floor(Date.now() / 1000) - lastConn) : null;
                          const agoText = ago != null
                            ? ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago / 60)}m ago` : `${Math.floor(ago / 3600)}h ago`
                            : '';
                          if (member.connected) {
                            return (
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-full bg-cipher-gold"
                                title={`Packet observed ${agoText}${member.voted ? '; vote observed at this height' : ''}`}
                              />
                            );
                          }
                          if (member.voted === true) {
                            return (
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-full bg-cipher-green"
                                title={`Vote observed at this height${agoText ? `; last packet ${agoText}` : ''}`}
                              />
                            );
                          }
                          if (member.voted === false) {
                            return (
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-full bg-cipher-border-alpha/40"
                                title={`No vote observed at this BFT height${agoText ? `; last packet ${agoText}` : ''}`}
                              />
                            );
                          }
                          return (
                            <span className="inline-block w-2.5 h-2.5 rounded-full bg-cipher-border-alpha/40" title="Unknown" />
                          );
                        })()}
                      </td>
                      <td className="px-3 sm:px-4 h-[60px] border-b border-cipher-border">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className="shrink-0 w-7 h-7 rounded-lg ring-1 ring-white/10"
                            style={finalizerAvatarStyle(display)}
                            aria-hidden
                          />
                          <Link
                            href={`/finalizer/${member.identity}`}
                            className="min-w-0 group/link"
                          >
                            {label ? (
                              <>
                                <span className="block text-sm font-semibold text-primary group-hover/link:text-primary transition-colors">
                                  {label.name}
                                </span>
                                <HashLink value={display} lead={10} tail={6} copy={false} linkClassName="text-caption font-mono text-muted leading-tight" />
                              </>
                            ) : (
                              <HashLink value={display} lead={10} tail={6} copy={false} linkClassName="text-sm font-mono text-primary group-hover/link:text-primary transition-colors" />
                            )}
                          </Link>
                          <CopyButton
                            text={display}
                            label="Copy pubkey"
                            size="xs"
                            className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          />
                        </div>
                      </td>
                      <td className="px-3 sm:px-4 h-[60px] border-b border-cipher-border text-right">
                        <span className="font-mono text-sm text-primary">
                          {(member.stake_zec || 0).toFixed(4)}
                        </span>
                      </td>
                      <td className="px-3 sm:px-4 h-[60px] border-b border-cipher-border text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-12 h-1.5 rounded-full bg-cipher-border-alpha/50 overflow-hidden hidden sm:block">
                            <div
                              className="h-full rounded-full bg-brand-gold"
                              style={{ width: `${Math.min(share, 100)}%` }}
                            />
                          </div>
                          <span className="font-mono text-xs text-muted w-12 text-right">
                            {share.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-3 sm:px-4 h-[60px] border-b border-cipher-border text-right">
                        {(() => {
                          const pct = participation[member.identity.toLowerCase()];
                          if (pct === undefined) {
                            return <span className="font-mono text-xs text-muted">—</span>;
                          }
                          const color = pct >= 95
                            ? 'bg-cipher-green'
                            : pct >= 70
                            ? 'bg-brand-gold'
                            : pct >= 30
                            ? 'bg-cipher-orange'
                            : 'bg-danger';
                          const textColor = pct >= 95
                            ? 'text-cipher-green'
                            : pct >= 70
                            ? 'text-cipher-gold'
                            : pct >= 30
                            ? 'text-cipher-orange'
                            : 'text-danger';
                          return (
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-16 h-1.5 rounded-full bg-cipher-border-alpha/50 overflow-hidden hidden sm:block">
                                <div
                                  className={`h-full rounded-full ${color}`}
                                  style={{ width: `${Math.min(pct, 100)}%` }}
                                />
                              </div>
                              <span className={`font-mono text-xs ${textColor} w-10 text-right`}>
                                {pct.toFixed(0)}%
                              </span>
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                  });
                })()}
              </tbody>
            </table>
          </div>

          {/* Voting Power Distribution */}
          <div className="card p-4 mt-6">
            <h3 className="text-xs font-mono font-semibold text-muted uppercase tracking-wider mb-3">
              Voting Power Distribution
            </h3>
            <div className="flex rounded-full overflow-hidden h-3 bg-cipher-border-alpha/30">
              {data.roster.map((member) => {
                const share = data.totalStakeZec > 0
                  ? (member.stake_zec || 0) / data.totalStakeZec * 100
                  : 0;
                const label = getFinalizerLabel(member.identity);
                const display = displayPubkey(member.identity);
                const name = label?.name ?? (display.length > 19 ? `${display.slice(0, 10)}...${display.slice(-6)}` : display);
                return (
                  <div
                    key={member.identity}
                    className="bg-brand-gold/70 transition-[width] duration-300 border-r border-cipher-bg last:border-r-0"
                    style={{ width: `${share}%` }}
                    title={`${name} — ${share.toFixed(1)}%`}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3">
              {data.roster.map((member) => {
                const share = data.totalStakeZec > 0
                  ? (member.stake_zec || 0) / data.totalStakeZec * 100
                  : 0;
                const label = getFinalizerLabel(member.identity);
                const display = displayPubkey(member.identity);
                return (
                  <div key={member.identity} className="flex items-center gap-1.5">
                    <div
                      className="w-2 h-2 rounded-sm shrink-0"
                      style={finalizerAvatarStyle(display)}
                    />
                    <span className="text-caption font-mono text-muted">
                      {label?.name ?? `${display.slice(0, 8)}...`} ({share.toFixed(1)}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="card p-8 text-center">
          <p className="text-sm text-muted font-mono">No active finalizers</p>
        </div>
      )}
    </div>
  );
}
