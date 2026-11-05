'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { ChartSkeleton } from '@/components/ui/Skeleton';
import { BlockSpeedChart, type SpeedMetric } from '@/components/network/BlockSpeedChart';
import { BlockSpeedLiveChart, CLIP_TARGETS } from '@/components/network/BlockSpeedLiveChart';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useUrlState } from '@/lib/use-url-state';
import {
  defaultSpeedZoom, formatSeconds, formatWait, readLiveBlocks, ROLLING_BLOCKS, SPEED_ZOOMS, SPENDABLE_CONFIRMATIONS,
  type SpeedStory, type SpeedZoom,
} from '@/lib/block-speed';

const ZOOMS = [{ id: 'days', label: 'Daily' }, { id: 'blocks', label: 'Per block' }] as const;
const VIEWS = [{ id: 'wait', label: 'Wait for funds' }, { id: 'blocks', label: 'Blocks per day' }] as const;
/** Matches the API's 15-second cache for the latest blocks. */
const LIVE_REFRESH_MS = 15_000;

function Footnote({ story, metric }: { story: SpeedStory; metric: SpeedMetric }) {
  if (metric === 'blocks') {
    return <>Blocks with header times in each complete UTC day. {story.phase === 'upcoming' && story.network === 'mainnet'
      ? 'Outlined bars show the target pace: 1,152 a day at 75 seconds, 3,456 at 25.'
      : story.network === 'testnet' ? 'Earlier minimum-difficulty testnet days are faded and clipped at the top; they ran far above any target.' : 'Each bar links to that day’s last block.'}</>;
  }
  return <>Daily averages. {story.phase === 'upcoming' && story.network === 'mainnet'
    ? `Total: ${SPENDABLE_CONFIRMATIONS} confirmations (ZIP 315). Outlined bars show targets.`
    : story.network === 'testnet' ? `Total: ${SPENDABLE_CONFIRMATIONS} confirmations (ZIP 315). Earlier testnet timing was irregular.` : `Total: ${SPENDABLE_CONFIRMATIONS} confirmations (ZIP 315).`}</>;
}

function ago(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s ago`;
}

/** The latest canonical blocks, one bar each, refreshed while this zoom is shown. */
function LiveBlocks({ story, height, onDaily }: { story: SpeedStory; height: number; onDaily: () => void }) {
  const { data, loading, error } = useApiQuery<unknown>('/v1/network/block-time', { period: 'blocks' }, { refreshInterval: LIVE_REFRESH_MS });
  const blocks = readLiveBlocks(data);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const latest = blocks.at(-1);
  const rolling = latest?.rollingSeconds ?? null;
  const nu7Height = story.activation?.height ?? null;

  if (!blocks.length) {
    return loading && !error ? <ChartSkeleton height={height} />
      : <p role="status" className="py-16 text-center text-sm text-muted">Recent blocks are unavailable. <button type="button" onClick={onDaily} className="text-secondary underline underline-offset-4 hover:text-primary">Show the daily chart</button></p>;
  }
  return <>
    <p className="text-caption text-muted mb-2 font-mono tabular-nums" aria-live="polite">
      Latest <Link href={`/block/${latest!.height}`} prefetch={false} className="text-secondary hover:text-primary">#{latest!.height.toLocaleString('en-US')}</Link>
      {now != null && <> · {ago(Math.max(0, now - latest!.timestamp))}</>}
      {rolling != null && <> · last {ROLLING_BLOCKS} blocks <span className={nu7Height != null && latest!.height >= nu7Height ? 'text-cipher-gold' : 'text-primary'}>{formatSeconds(Number(rolling.toFixed(1)))}</span> each · {SPENDABLE_CONFIRMATIONS} confirmations took {formatWait(rolling * ROLLING_BLOCKS)}</>}
    </p>
    <BlockSpeedLiveChart blocks={blocks} nu7Height={nu7Height} height={height} />
    {error && <p role="status" className="text-caption text-warning mt-2">Refresh unavailable. Showing the previous blocks.</p>}
  </>;
}

/**
 * The daily story as wallet waits or blocks per day, or the latest blocks one
 * bar each. Per block is the default around NU7 activation.
 */
export function BlockSpeedChartView({ story, height }: { story: SpeedStory; height: number }) {
  const [zoom, setZoom] = useUrlState<SpeedZoom>('zoom', defaultSpeedZoom(story), SPEED_ZOOMS);
  const [metric, setMetric] = useUrlState<SpeedMetric>('speed', 'wait', ['wait', 'blocks']);
  return <>
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <SegmentedToggle options={ZOOMS} value={zoom} onChange={setZoom} />
      {zoom === 'days' && <SegmentedToggle options={VIEWS} value={metric} onChange={setMetric} />}
    </div>
    {zoom === 'blocks' ? <>
      <LiveBlocks story={story} height={height} onDaily={() => setZoom('days')} />
      <p className="text-caption text-muted mt-3 max-w-3xl">
        Each bar is one block: the header-time gap since the block before it. The line averages the last {ROLLING_BLOCKS} gaps, about how long {SPENDABLE_CONFIRMATIONS} confirmations (ZIP 315) took. Gaps over {CLIP_TARGETS}× the target are clipped. Updates every {LIVE_REFRESH_MS / 1000}s.
      </p>
    </> : <>
      <BlockSpeedChart points={story.points} activation={story.activation} height={height} metric={metric} />
      <p className="text-caption text-muted mt-3 max-w-3xl"><Footnote story={story} metric={metric} /></p>
    </>}
  </>;
}
