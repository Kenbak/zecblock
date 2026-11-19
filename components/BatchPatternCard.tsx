'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { HashLink } from '@/components/ui/HashLink';
import { RiskScore, ScoreEvidence, riskButtonClass } from '@/components/privacy/RiskEvidence';
import dynamic from 'next/dynamic';
const PrivacyLinkGraph = dynamic(() => import('@/components/PrivacyLinkGraph').then(module => module.PrivacyLinkGraph), { ssr: false });

export interface BatchPattern {
  patternType: string;
  clusterHash?: string;
  perTxAmountZec: number;
  batchCount: number;
  totalAmountZec: number;
  txids: string[];
  heights: number[];
  times: number[];
  addresses?: string[];
  addressCount?: number;
  sameAddressRatio?: number;
  firstTime: number;
  lastTime: number;
  timeSpanHours: number;
  isRoundNumber: boolean;
  matchingShield: {
    txid: string;
    amountZec: number;
    blockHeight: number;
    blockTime: number;
  } | null;
  score: number;
  warningLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  ambiguityScore?: number;
  confidenceMargin?: number;
  explanation: string;
  breakdown: {
    batchCount: { count: number; points: number };
    roundNumber: { amountZec: number; isRound: boolean; points: number };
    matchingShield: { found: boolean; txid: string | null; points: number };
    timeClustering: { hours: number; points: number };
    addressAnalysis?: { totalAddresses: number; uniqueAddresses: number; sameAddressRatio: number; topAddresses: string[]; points: number };
    shieldTiming?: { hoursAfterShield: number | null; points: number };
  };
}

function formatTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function BatchPatternCard({ pattern }: { pattern: BatchPattern }) {
  const [showGraph, setShowGraph] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [memberPage, setMemberPage] = useState(0);
  const cardId = `batch-${pattern.txids[0]?.slice(0, 12)}`;

  const clusterPanel = useMemo(() => {
    const graphNodes = [
      ...(pattern.matchingShield
        ? [{
            id: pattern.matchingShield.txid,
            type: 'transaction' as const,
            label: pattern.matchingShield.txid,
            amountZec: pattern.matchingShield.amountZec,
            blockTime: pattern.matchingShield.blockTime,
            subtitle: 'Candidate shielding event',
          }]
        : []),
      {
        id: `cluster:${pattern.clusterHash || pattern.txids[0]}`,
        type: 'cluster' as const,
        label: `${pattern.batchCount} withdrawals`,
        subtitle: `${pattern.perTxAmountZec.toFixed(4)} ZEC each in ${pattern.timeSpanHours < 24 ? `${Math.round(pattern.timeSpanHours)}h` : `${Math.round(pattern.timeSpanHours / 24)}d`}`,
      },
      ...(pattern.breakdown.addressAnalysis?.topAddresses || []).slice(0, 3).map((address) => ({
        id: `address:${address}`,
        type: 'address' as const,
        label: address,
        subtitle: 'Destination address',
      })),
    ];

    const graphEdges = [
      ...(pattern.matchingShield ? [{
            id: `${pattern.matchingShield.txid}-cluster`,
            source: pattern.matchingShield.txid,
            target: `cluster:${pattern.clusterHash || pattern.txids[0]}`,
            type: 'BATCH_LINK',
            confidence: pattern.score,
            label: 'Candidate link',
          }] : []),
      ...((pattern.breakdown.addressAnalysis?.topAddresses || []).slice(0, 3).map((address, index) => ({
            id: `cluster-${address}`,
            source: `cluster:${pattern.clusterHash || pattern.txids[0]}`,
            target: `address:${address}`,
            type: 'transparent_output',
            confidence: pattern.score,
            label: index === 0 ? 'Recipients' : undefined,
          }))),
    ];

    return {
      graphNodes,
      graphEdges,
    };
  }, [pattern]);

  const span = pattern.timeSpanHours < 24 ? `${pattern.timeSpanHours.toFixed(1)} hours` : `${(pattern.timeSpanHours / 24).toFixed(1)} days`;
  const memberCount = pattern.txids.length;
  return <article id={cardId} className="rounded-xl border border-cipher-border bg-cipher-card p-4 sm:p-5 scroll-mt-24">
    <header className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h3 className="text-sm font-medium text-primary">Repeated withdrawal pattern</h3>
      <RiskScore score={pattern.score} level={pattern.warningLevel} />
    </header>
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {[{ label: 'Withdrawals', value: pattern.batchCount.toLocaleString() }, { label: 'Representative amount', value: `${pattern.perTxAmountZec.toLocaleString(undefined, { maximumFractionDigits: 8 })} ZEC` }, { label: 'Combined public amount', value: `${pattern.totalAmountZec.toLocaleString(undefined, { maximumFractionDigits: 8 })} ZEC` }, { label: 'Observation span', value: span }].map(item => <div key={item.label}><dt className="text-xs text-muted">{item.label}</dt><dd className="mt-2 font-mono text-lg text-primary tabular-nums">{item.value}</dd></div>)}
    </dl>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-secondary">
      {pattern.matchingShield ? <p>Candidate shielding event: <HashLink value={pattern.matchingShield.txid} href={`/tx/${pattern.matchingShield.txid}`} copy={false} /> · {pattern.matchingShield.amountZec.toLocaleString(undefined, { maximumFractionDigits: 8 })} ZEC</p> : <p>No candidate shielding event was returned for this pattern.</p>}
      <span className="text-muted">{pattern.addressCount == null ? 'Recipient count unavailable' : `${pattern.addressCount} public recipients`}</span>
    </div>
    <ScoreEvidence rows={[{ label: 'Batch size', value: pattern.breakdown.batchCount.points }, { label: 'Amount structure', value: pattern.breakdown.roundNumber.points }, { label: 'Candidate shield', value: pattern.breakdown.matchingShield.points }, { label: 'Time clustering', value: pattern.breakdown.timeClustering.points }, { label: 'Address analysis', value: pattern.breakdown.addressAnalysis?.points }, { label: 'Shield timing', value: pattern.breakdown.shieldTiming?.points }]} ambiguity={pattern.ambiguityScore} margin={pattern.confidenceMargin} />
    <div className="flex flex-wrap items-center gap-3 border-t border-cipher-border pt-4">
      <button className={riskButtonClass} aria-expanded={showGraph} aria-controls={`${cardId}-graph`} onClick={() => setShowGraph(value => !value)}>{showGraph ? 'Close linkage graph' : 'Explore linkage graph'}</button>
      <button className={riskButtonClass} aria-expanded={expanded} aria-controls={`${cardId}-members`} onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide' : 'View'} member transactions ({memberCount})</button>
    </div>
    {showGraph && <div id={`${cardId}-graph`} className="mt-5 space-y-3"><PrivacyLinkGraph nodes={clusterPanel.graphNodes} edges={clusterPanel.graphEdges} focusNodeId={`cluster:${pattern.clusterHash || pattern.txids[0]}`} height={320} /><p className="text-xs text-muted">The graph summarizes the batch and up to three returned recipient addresses. Grouping does not establish common ownership.</p></div>}
    {expanded && <div id={`${cardId}-members`} className="mt-5">
      <p className="text-xs text-muted mb-3">{memberCount} transaction IDs supplied for {pattern.batchCount} withdrawals. Times are shown in your local timezone.</p>
      <div className="overflow-x-auto rounded-lg border border-cipher-border"><table className="w-full text-left text-xs"><thead className="bg-cipher-bg text-muted"><tr><th className="p-3 font-medium">Transaction</th><th className="p-3 font-medium">Block</th><th className="p-3 font-medium text-right">Observed</th></tr></thead><tbody className="divide-y divide-cipher-border">{pattern.txids.slice(memberPage * 10, (memberPage + 1) * 10).map((txid, index) => { const row = memberPage * 10 + index; return <tr key={txid} className="hover:bg-cipher-hover"><td className="p-3"><HashLink value={txid} href={`/tx/${txid}`} copy={false} /></td><td className="p-3 font-mono text-secondary">{pattern.heights[row] ? <Link className="hover:underline" href={`/block/${pattern.heights[row]}`} prefetch={false}>{pattern.heights[row].toLocaleString()}</Link> : '—'}</td><td className="p-3 text-right whitespace-nowrap text-muted">{pattern.times[row] ? formatTime(pattern.times[row]) : 'Unavailable'}</td></tr>; })}</tbody></table></div>
      {memberCount > 10 && <div className="flex items-center justify-end gap-3 mt-3 text-xs text-muted"><button className={riskButtonClass} disabled={memberPage === 0} onClick={() => setMemberPage(page => page - 1)}>Previous members</button><span>{memberPage + 1} / {Math.ceil(memberCount / 10)}</span><button className={riskButtonClass} disabled={(memberPage + 1) * 10 >= memberCount} onClick={() => setMemberPage(page => page + 1)}>Next members</button></div>}
    </div>}
  </article>;
}
