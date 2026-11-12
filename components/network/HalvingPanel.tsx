'use client';

import { Card, CardBody } from '@/components/ui/Card';
import { formatDuration } from '@/lib/format-numbers';

export interface HalvingInfo {
  halvingBlock: number | null;
  blocksRemaining: number | null;
  eraProgress?: number | null;
  halvingStatus?: 'available' | 'unavailable';
  scheduleAssumption?: string;
  currentSubsidy: number;
  nextSubsidy: number | null;
  minerReward: number | null;
  nextMinerReward: number | null;
  estimatedDate: string | null;
  estimatedSeconds: number | null;
  currentHeight?: number;
}

export function HalvingPanel({ halving }: { halving: HalvingInfo | null }) {
  if (!halving) return null;

  const progress = halving.eraProgress != null && Number.isFinite(halving.eraProgress)
    ? Math.max(0, Math.min(100, halving.eraProgress)) : null;

  const estDate = halving.estimatedDate
    ? new Date(halving.estimatedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : null;

  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-2 mb-5">
          <h2 className="text-sm font-semibold font-mono text-secondary lowercase tracking-tight">NEXT_HALVING</h2>
        </div>

        {halving.halvingStatus === 'unavailable' && <p className="text-caption text-muted mb-5">
          The next halving cannot currently be determined from the node&apos;s subsidy schedule.
        </p>}

        <div className="text-center mb-5">
          <p className="text-3xl sm:text-4xl font-semibold font-mono text-primary tabular-nums">
            {halving.blocksRemaining?.toLocaleString() ?? '—'}
          </p>
          <p className="text-caption text-muted font-mono mt-1">blocks remaining</p>
        </div>

        {progress != null && <div className="mb-5">
          <div className="flex justify-between text-caption text-muted font-mono mb-1.5">
            <span>Current era progress</span>
            <span>{progress.toFixed(1)}%</span>
          </div>
          <div className="h-2.5 bg-cipher-bg rounded-full overflow-hidden">
            <div
              className="h-full bg-cipher-gold transition-[width] duration-700 rounded-full"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>}
        <div className="space-y-2.5">
          <div className="flex justify-between items-center">
            <span className="text-caption text-muted font-mono">Estimated time</span>
            <span className="text-caption font-mono text-primary font-medium">
              ~{halving.estimatedSeconds ? formatDuration(halving.estimatedSeconds) : '—'}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-caption text-muted font-mono">Estimated date</span>
            <span className="text-caption font-mono text-primary font-medium">{estDate ?? '—'}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-caption text-muted font-mono">Halving block</span>
            <span className="text-caption font-mono text-primary font-medium">
              {halving.halvingBlock?.toLocaleString() ?? '—'}
            </span>
          </div>
        </div>
        {halving.halvingStatus !== 'unavailable' && <p className="text-caption text-muted mt-4">Estimate from the current node schedule and recent block timing.</p>}
      </CardBody>
    </Card>
  );
}
