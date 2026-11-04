'use client';

import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { BlockSpeedChart, type SpeedMetric } from '@/components/network/BlockSpeedChart';
import { useUrlState } from '@/lib/use-url-state';
import { SPENDABLE_CONFIRMATIONS, type SpeedStory } from '@/lib/block-speed';

const VIEWS = [{ id: 'wait', label: 'Wait for funds' }, { id: 'blocks', label: 'Blocks per day' }] as const;

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

/** The same daily story as wallet waits or as blocks mined per day. */
export function BlockSpeedChartView({ story, height }: { story: SpeedStory; height: number }) {
  const [metric, setMetric] = useUrlState<SpeedMetric>('speed', 'wait', ['wait', 'blocks']);
  return <>
    <SegmentedToggle options={VIEWS} value={metric} onChange={setMetric} className="mb-3" />
    <BlockSpeedChart points={story.points} activation={story.activation} height={height} metric={metric} />
    <p className="text-caption text-muted mt-3 max-w-3xl"><Footnote story={story} metric={metric} /></p>
  </>;
}
