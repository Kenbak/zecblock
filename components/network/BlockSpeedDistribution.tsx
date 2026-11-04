import { Card } from '@/components/ui/Card';
import { SPEED_BUCKETS, bucketRange, expectedBucketShare, formatSeconds, type SpeedBucket, type SpeedStory, type SpeedSummary } from '@/lib/block-speed';

type Row = { key: string; label: string; summary: SpeedSummary & { distribution: SpeedBucket[] }; total: number };

const percent = (share: number) => {
  const value = share * 100;
  return `${value > 0 && value < 1 ? value.toFixed(1) : Math.round(value)}%`;
};

/** Windows with a usable distribution: before/after NU7 once active, otherwise the last seven days. */
function distributionRows(story: SpeedStory): Row[] {
  const windows: [string, string, SpeedSummary | null][] = story.network === 'testnet'
    ? [['after', 'Last 7 days · NU7', story.after]]
    : story.phase === 'active'
      ? [['before', 'Before NU7', story.before], ['after', 'Since NU7 · last 7 days', story.after]]
      : [['latest', 'Last 7 days', story.before]];
  return windows.flatMap(([key, label, summary]) => {
    const distribution = summary?.distribution;
    const total = distribution?.reduce((sum, bucket) => sum + bucket.blocks, 0) ?? 0;
    return summary && distribution && total > 0 ? [{ key, label, summary: { ...summary, distribution }, total }] : [];
  });
}

/** Cumulative expected shares at each inner boundary, for the random-arrival ticks. */
const EXPECTED_BOUNDARIES = SPEED_BUCKETS.slice(0, -1).map((_, index) =>
  SPEED_BUCKETS.slice(0, index + 1).reduce((sum, __, i) => sum + expectedBucketShare(i), 0));

function Spectrum({ row }: { row: Row }) {
  const { distribution } = row.summary;
  const label = distribution.map((bucket, index) => `${SPEED_BUCKETS[index].label} ${bucketRange(distribution, index)}: ${percent(bucket.blocks / row.total)}`).join(', ');
  return <div className="speed-spectrum" role="img" aria-label={`${row.label}, ${row.total.toLocaleString('en-US')} blocks. ${label}.`}>
    {distribution.map((bucket, index) => <span key={bucket.key} className="speed-spectrum-segment" data-bucket={bucket.key}
      style={{ flexGrow: bucket.blocks, ['--segment-index' as string]: index }} title={`${SPEED_BUCKETS[index].label} · ${bucketRange(distribution, index)} · ${bucket.blocks.toLocaleString('en-US')} blocks`} />)}
    {EXPECTED_BOUNDARIES.map((share, index) => <span key={index} className="speed-spectrum-expected" style={{ left: `${share * 100}%` }} aria-hidden="true" />)}
  </div>;
}

function Headline({ row }: { row: Row }) {
  const { distribution } = row.summary;
  const first = distribution[0]; const last = distribution.at(-1)!;
  // Buckets before index 2 end at the target.
  const beatTarget = (distribution[0].blocks + distribution[1].blocks) / row.total;
  return <p className="text-sm text-secondary mb-5 max-w-3xl">
    <span className="text-primary">{percent(first.blocks / row.total)}</span> of blocks {row.key === 'after' ? 'since NU7' : 'in the last 7 days'} arrived in {bucketRange(distribution, 0).replace('< ', 'under ')};{' '}
    <span className="text-primary">{percent(last.blocks / row.total)}</span> took {bucketRange(distribution, distribution.length - 1).replace('≥ ', '')} or more.
    {' '}<span className="text-primary">{percent(beatTarget)}</span> were faster than the {formatSeconds(row.summary.targetSeconds)} target{beatTarget > 0.5 ? ': a thin tail of slow blocks pulls the average back up' : ''}.
  </p>;
}

/**
 * Block intervals grouped by multiples of the consensus target. Mining is a
 * random race, so intervals follow an exponential curve: most blocks beat the
 * target and a thin tail runs several times longer. Dashed ticks mark where a
 * perfectly random chain at the target pace would split the bar.
 */
export function BlockSpeedDistribution({ story }: { story: SpeedStory | null }) {
  const rows = story ? distributionRows(story) : [];
  if (rows.length === 0) return <Card className="card-static p-4 sm:p-6"><p role="status" className="py-8 text-center text-sm text-muted">Block interval distribution is unavailable.</p></Card>;
  const headline = rows.at(-1)!;

  return <Card className="card-static p-4 sm:p-6">
    <Headline row={headline} />
    <div className="space-y-5">
      {rows.map(row => <div key={row.key}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2">
          <h3 className={`text-sm font-medium ${row.key === 'after' ? 'text-cipher-gold' : 'text-primary'}`}>{row.label}</h3>
          <p className="text-caption font-mono tabular-nums text-muted">{row.total.toLocaleString('en-US')} blocks · {formatSeconds(row.summary.targetSeconds)} target · avg {formatSeconds(row.summary.averageSeconds)}</p>
        </div>
        <Spectrum row={row} />
      </div>)}
    </div>

    <dl className="speed-buckets mt-5">
      {SPEED_BUCKETS.map((bucket, index) => <div key={bucket.key} className="speed-bucket">
        <dt className="flex items-center gap-2">
          <span className="speed-bucket-swatch" data-bucket={bucket.key} aria-hidden="true" />
          <span className="type-label text-muted uppercase">{bucket.label}</span>
        </dt>
        {rows.map(row => {
          const share = row.summary.distribution[index].blocks / row.total;
          return <dd key={row.key} className="speed-bucket-value">
            <span className={`type-metric type-metric-compact tabular-nums ${row.key === 'after' ? 'text-cipher-gold' : 'text-primary'}`}>{percent(share)}</span>
            <span className="text-caption font-mono tabular-nums text-muted">{bucketRange(row.summary.distribution, index)} · {row.summary.distribution[index].blocks.toLocaleString('en-US')}</span>
          </dd>;
        })}
        <dd className="text-caption text-muted">Random model {percent(expectedBucketShare(index))}</dd>
      </div>)}
    </dl>

    <p className="text-caption text-muted mt-4 max-w-3xl">
      Buckets scale with the target: super fast is under a quarter of it, long wait is four times or more. Dashed ticks show the split expected if blocks arrived purely at random at the target pace.
    </p>
  </Card>;
}
