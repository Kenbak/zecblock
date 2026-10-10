'use client';

import { CopyButton } from '@/components/CopyButton';
import { decodeCoinbaseMessage } from '@/lib/coinbase-message';

export function CoinbaseMessage({ hex }: { hex: string | null | undefined }) {
  const text = decodeCoinbaseMessage(hex);

  if (text === null) return <p className="text-sm text-muted">Coinbase message unavailable.</p>;
  if (text === '') return <p className="text-sm text-muted">No optional message included.</p>;

  return (
    <div className="flex items-start gap-2 min-w-0">
      <code className="min-w-0 font-mono text-sm leading-relaxed text-primary whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</code>
      <CopyButton text={text} label="coinbase message" size="sm" />
    </div>
  );
}
