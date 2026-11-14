import { BLOCK_FIRST_SEEN_EXPLANATION } from '@/components/BlockFirstSeen';
import { formatRelativeTime } from '@/lib/utils';
import { Card, CardBody } from '@/components/ui/Card';
import { HashLink } from '@/components/ui/HashLink';
import { PoolLogo } from '@/components/PoolLogo';
import { Tooltip } from '@/components/Tooltip';
import type { BlockData } from './types';

type Side = {
  label: string;
  tone: 'orange' | 'green';
  hash: string;
  href?: string;
  firstSeenAt?: string | null;
  minerPool?: string | null;
  minerPoolUrl?: string | null;
  minerPoolIsFundingStream?: boolean;
  transactionCount?: number | null;
  timestamp?: number | null;
};

const TONE = {
  orange: { text: 'text-cipher-orange', box: 'border-cipher-orange/30 bg-cipher-orange/5' },
  green: { text: 'text-cipher-green', box: 'border-cipher-green/30 bg-cipher-green/5' },
} as const;

function firstSeenText(value?: string | null) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  return { iso, text: `${iso.slice(11, 23)} UTC` };
}

function ForkSide({ side }: { side: Side }) {
  const tone = TONE[side.tone];
  const seen = firstSeenText(side.firstSeenAt);
  return (
    <div className={`flex-1 min-w-0 rounded-xl border p-3.5 ${tone.box}`}>
      <span className={`text-caption font-mono uppercase tracking-widest font-semibold ${tone.text}`}>{side.label}</span>
      <div className="mt-2 space-y-1.5 text-xs font-mono">
        <HashLink
          value={side.hash}
          href={side.href}
          lead={10}
          tail={6}
          copy={false}
          linkClassName={`text-xs font-mono block ${tone.text} ${side.href ? 'hover:underline' : ''}`}
        />
        <div className="flex items-center gap-1.5 text-secondary">
          {side.minerPool && !side.minerPoolIsFundingStream && <PoolLogo name={side.minerPool} />}
          {side.minerPool ? (
            side.minerPoolUrl ? (
              <a href={side.minerPoolUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{side.minerPool}</a>
            ) : (
              <span>{side.minerPool}</span>
            )
          ) : (
            <span className="text-muted">Unknown miner</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted">
          {side.transactionCount != null && <span>{side.transactionCount} txs</span>}
          {side.timestamp ? <span>{formatRelativeTime(side.timestamp)}</span> : null}
          <span>
            seen{' '}
            {seen ? <time dateTime={seen.iso} className="text-secondary">{seen.text}</time> : 'not recorded'}
          </span>
        </div>
      </div>
    </div>
  );
}

/** One card explaining the fork: which block lost, which won, and what the archive below means. */
export function OrphanedBlockBanner({ data }: { data: BlockData }) {
  if (!data.isOrphaned) return null;

  const observers = data.orphanSource === 'observers';
  const summary = observers
    ? `Another block won this height. Our node never switched to this one; ${data.observerCount ?? 'our'} observer node${data.observerCount === 1 ? '' : 's'} received it.`
    : 'Our node indexed this block, then a chain reorganization replaced it.';

  const orphan: Side = {
    label: 'This block',
    tone: 'orange',
    hash: data.hash,
    firstSeenAt: data.firstSeenAt,
    minerPool: data.minerPool,
    minerPoolUrl: data.minerPoolUrl,
    minerPoolIsFundingStream: data.minerPoolIsFundingStream,
    transactionCount: data.transactionCount,
    timestamp: data.timestamp,
  };
  const canonical = data.canonicalBlock;

  return (
    <Card className="mb-6 animate-fade-in-up">
      <CardBody>
        <div className="flex items-center gap-1.5 mb-1">
          <h2 className="text-sm font-semibold text-secondary lowercase tracking-tight">Fork at #{data.height.toLocaleString()}</h2>
          <Tooltip content={BLOCK_FIRST_SEEN_EXPLANATION} />
        </div>
        <p className="text-xs text-muted mb-4">{summary}</p>
        <div className="flex flex-col sm:flex-row gap-3">
          <ForkSide side={orphan} />
          {canonical ? (
            <ForkSide
              side={{
                label: 'Accepted instead',
                tone: 'green',
                hash: canonical.hash,
                href: `/block/${canonical.height}`,
                firstSeenAt: canonical.firstSeenAt,
                minerPool: canonical.minerPool,
                minerPoolUrl: canonical.minerPoolUrl,
                minerPoolIsFundingStream: canonical.minerPoolIsFundingStream,
                transactionCount: canonical.transactionCount,
                timestamp: canonical.timestamp,
              }}
            />
          ) : (
            <div className="flex-1 rounded-xl border border-cipher-border/70 p-3.5 flex items-center justify-center">
              <span className="text-xs text-muted font-mono">Accepted block not indexed yet</span>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
