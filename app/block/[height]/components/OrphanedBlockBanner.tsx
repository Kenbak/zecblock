import Link from 'next/link';
import { BlockFirstSeen, BLOCK_FIRST_SEEN_EXPLANATION } from '@/components/BlockFirstSeen';
import { formatRelativeTime } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { HashLink } from '@/components/ui/HashLink';
import { PoolLogo } from '@/components/PoolLogo';
import type { BlockData } from './types';

export function OrphanedBlockBanner({ data }: { data: BlockData }) {
  if (!data.isOrphaned) return null;

  return (
    <div className="mb-6 space-y-4 animate-fade-in-up">
      <div className="rounded-xl border border-cipher-orange/30 bg-cipher-orange/5 backdrop-blur-sm p-4 sm:p-5">
        <div className="flex flex-col gap-3">
          <Badge color="orange" className="self-start text-caption font-semibold tracking-wider">ORPHANED BLOCK</Badge>
          <p className="text-sm text-secondary">
            {data.orphanSource === 'observers'
              ? 'This block competed for this height but lost: another block was accepted instead, and our own node never switched to it.'
              : 'This block was replaced during a chain reorganization and is no longer part of the canonical chain.'}
          </p>
          <p className="text-xs text-muted font-mono">
            {data.orphanSource === 'observers'
              ? `Received by ${data.observerCount ?? 'our'} observer node${data.observerCount === 1 ? '' : 's'}. Header facts only; its transactions were not archived.`
              : 'Archived transactions below describe this orphaned block. They do not imply confirmation on the current chain.'}
            {data.orphanSource && data.orphanSource !== 'observers' && (
              <span className="ml-2 text-secondary">Source: {data.orphanSource}</span>
            )}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-cipher-border bg-glass-2 backdrop-blur-sm p-4">
        <p className="text-xs text-muted mb-3">{BLOCK_FIRST_SEEN_EXPLANATION}</p>
        <p className="text-caption font-mono uppercase tracking-wider text-muted mb-3">Reorg comparison at #{data.height.toLocaleString()}</p>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 rounded-lg border border-cipher-orange/30 bg-cipher-orange/5 p-3">
            <span className="text-caption font-mono uppercase tracking-wider font-semibold text-cipher-orange">Orphaned</span>
            <div className="mt-2 space-y-1.5">
              <BlockFirstSeen value={data.firstSeenAt} />
              <HashLink value={data.hash} lead={10} tail={6} copy={false} linkClassName="text-xs font-mono text-cipher-orange block" />
              <div className="flex items-center gap-1.5 text-xs font-mono text-secondary">
                {data.minerPool && !data.minerPoolIsFundingStream && <PoolLogo name={data.minerPool} />}
                {data.minerPool ? (
                  data.minerPoolUrl ? (
                    <a href={data.minerPoolUrl} target="_blank" rel="noopener noreferrer" className="text-cipher-orange hover:underline">{data.minerPool}</a>
                  ) : (
                    <span className="text-cipher-orange">{data.minerPool}</span>
                  )
                ) : (
                  <span className="text-muted">Unknown miner</span>
                )}
              </div>
              <div className="flex gap-3 text-xs font-mono text-muted">
                {data.transactionCount != null && <span>{data.transactionCount} txs</span>}
                <span>{data.timestamp ? formatRelativeTime(data.timestamp) : '—'}</span>
              </div>
            </div>
          </div>

          <div className="hidden sm:flex items-center justify-center px-1">
            <span className="text-caption font-mono text-muted">vs</span>
          </div>

          {data.canonicalBlock ? (
            <div className="flex-1 rounded-lg border border-cipher-green/30 bg-cipher-green/5 p-3">
              <span className="text-caption font-mono uppercase tracking-wider font-semibold text-cipher-green">Canonical</span>
              <div className="mt-2 space-y-1.5">
                <BlockFirstSeen value={data.canonicalBlock.firstSeenAt} />
                <HashLink
                  value={data.canonicalBlock.hash}
                  href={`/block/${data.canonicalBlock.height}`}
                  lead={10}
                  tail={6}
                  copy={false}
                  linkClassName="text-xs font-mono text-cipher-green hover:underline block"
                />
                <div className="flex items-center gap-1.5 text-xs font-mono text-secondary">
                  {data.canonicalBlock.minerPool && !data.canonicalBlock.minerPoolIsFundingStream && <PoolLogo name={data.canonicalBlock.minerPool} />}
                  {data.canonicalBlock.minerPool ? (
                    data.canonicalBlock.minerPoolUrl ? (
                      <a href={data.canonicalBlock.minerPoolUrl} target="_blank" rel="noopener noreferrer" className="text-cipher-green hover:underline">{data.canonicalBlock.minerPool}</a>
                    ) : (
                      <span className="text-cipher-green">{data.canonicalBlock.minerPool}</span>
                    )
                  ) : (
                    <span className="text-muted">Unknown miner</span>
                  )}
                </div>
                <div className="flex gap-3 text-xs font-mono text-muted">
                  {data.canonicalBlock.transactionCount != null && (
                    <span>{data.canonicalBlock.transactionCount} txs</span>
                  )}
                  {data.canonicalBlock.timestamp && (
                    <span>{formatRelativeTime(data.canonicalBlock.timestamp)}</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 rounded-lg border border-cipher-border bg-glass-2 p-3 flex items-center justify-center">
              <span className="text-xs text-muted font-mono">Canonical block not indexed</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
