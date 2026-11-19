'use client';

import Link from 'next/link';
import type { RiskyTransaction } from '@/components/privacy/types';
import { RoundTripFlow } from '@/components/privacy/RoundTripFlow';
import { RiskScore, ScoreEvidence } from '@/components/privacy/RiskEvidence';

export function RiskyTxCard({ tx }: { tx: RiskyTransaction }) {
  const cardId = `risk-${tx.shieldTxid.slice(0, 8)}-${tx.deshieldTxid.slice(0, 8)}`;
  return <article id={cardId} className="rounded-xl border border-cipher-border bg-cipher-card p-4 sm:p-5 scroll-mt-24">
    <header className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h3 className="text-sm font-medium text-primary">Potential round trip</h3>
      <RiskScore score={tx.score} level={tx.warningLevel} />
    </header>
    <RoundTripFlow tx={tx} />
    <ScoreEvidence rows={[{ label: 'Amount similarity', value: tx.scoreBreakdown.amountSimilarity }, { label: 'Time proximity', value: tx.scoreBreakdown.timeProximity }, { label: 'Amount rarity', value: tx.scoreBreakdown.amountRarity }, { label: 'Distinctive amount', value: tx.scoreBreakdown.weirdAmount }]} ambiguity={tx.ambiguityScore} margin={tx.confidenceMargin}>
      <p className="text-xs text-muted">Amounts describe each event’s public pool flow, not a verified payment between the listed addresses.</p>
      <div className="flex flex-wrap gap-4 text-xs text-secondary"><Link className="underline underline-offset-4" href={`/block/${tx.shieldHeight}`} prefetch={false}>Shielding block {tx.shieldHeight.toLocaleString()}</Link><Link className="underline underline-offset-4" href={`/block/${tx.deshieldHeight}`} prefetch={false}>Deshielding block {tx.deshieldHeight.toLocaleString()}</Link></div>
    </ScoreEvidence>
  </article>;
}
