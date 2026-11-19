'use client';

import { CopyButton } from '@/components/CopyButton';
import { MinerPollBallotBadge } from '@/components/MinerPollBallot';
import { decodeCoinbaseMessage } from '@/lib/coinbase-message';
import { parseMinerPollBallot } from '@/lib/miner-poll';

export function CoinbaseMessage({ hex, height }: { hex: string | null | undefined; height?: number | string | null }) {
  const text = decodeCoinbaseMessage(hex);

  if (text === null) return <p className="text-sm text-muted">Coinbase message unavailable.</p>;
  if (text === '') return <p className="text-sm text-muted">No optional message included.</p>;

  const ballot = parseMinerPollBallot(hex);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-start gap-2 min-w-0">
        <code className="min-w-0 font-mono text-sm leading-relaxed text-primary whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</code>
        <CopyButton text={text} label="coinbase message" size="sm" />
      </div>
      {ballot && <MinerPollBallotBadge answers={ballot} height={height} />}
    </div>
  );
}
