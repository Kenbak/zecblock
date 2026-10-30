import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader, SectionHeader } from '@/components/ui/SectionHeader';
import { Card } from '@/components/ui/Card';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { PageSectionNav, type PageSection } from '@/components/PageSectionNav';
import { BlockSpeedPanel } from '@/components/network/BlockSpeedPanel';
import { BlockTimeChart } from '@/components/network/BlockTimeChart';
import { BlockPulse } from '@/components/network/BlockPulse';
import { buildPageMetadata, getBaseUrl, getNetwork } from '@/lib/seo';
import { loadBlockSpeedSnapshot } from '@/lib/block-speed-server';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import { CONFIRMATION_DEPTHS, NU7_TARGET_SECONDS, ZIP_315_URL, confirmationSeconds, formatSeconds, formatWait, nu7Average, type SpeedStory } from '@/lib/block-speed';

export const revalidate = 300;

const TITLE = 'Zcash Block Speed: 75-Second Blocks to 25 with NU7 | ZecBlock';
const DESCRIPTION = 'Daily measured Zcash block times and NU7’s 25-second target: first confirmation, time until received funds are spendable and blocks per hour.';

const SECTIONS: readonly PageSection[] = [
  { id: 'daily', label: 'Confirmation chart' },
  { id: 'confirmations', label: 'Wallet guide' },
  { id: 'live', label: 'Live detail' },
  { id: 'method', label: 'Method' },
];
const SECTIONS_WITHOUT_CONFIRMATIONS = SECTIONS.filter(section => section.id !== 'confirmations');

export async function generateMetadata() {
  const metadata = buildPageMetadata({ title: TITLE, description: DESCRIPTION, path: '/network/block-speed', index: true, networks: ['mainnet', 'testnet'] });
  const image = { url: `${getBaseUrl()}/network/block-speed/image`, width: 1200, height: 675, alt: 'Zcash daily block speed and NU7 · ZecBlock' };
  return { ...metadata, openGraph: { ...metadata.openGraph, images: [image] }, twitter: { ...metadata.twitter, card: 'summary_large_image' as const, images: [image] } };
}

type WaitRow = { key: string; label: string; detail: string; seconds: (average: number | null | undefined) => number | null; target: number };

const ROWS: WaitRow[] = [
  ...CONFIRMATION_DEPTHS.map(depth => ({ key: `c${depth.blocks}`, label: depth.label, detail: depth.detail, seconds: (average: number | null | undefined) => confirmationSeconds(average, depth.blocks), target: NU7_TARGET_SECONDS * depth.blocks })),
];

const number = (value: string, className = 'text-secondary') => <span className={`font-mono tabular-nums ${className}`}>{value}</span>;

function waitColumns(story: SpeedStory): DataTableColumn<WaitRow>[] {
  const depth: DataTableColumn<WaitRow> = { id: 'depth', header: 'Depth', cell: row => <><span className="block text-sm text-primary">{row.label}</span><span className="block text-caption text-muted">{row.detail}</span></> };
  const target: DataTableColumn<WaitRow> = { id: 'target', header: `${NU7_TARGET_SECONDS}s target`, align: 'right', cell: row => number(formatWait(row.target), 'text-muted') };
  const measuredNu7: DataTableColumn<WaitRow> = { id: 'nu7', header: 'With NU7 · measured', align: 'right', cell: row => number(formatWait(row.seconds(story.after?.averageSeconds)), 'text-cipher-gold') };
  if (story.network === 'testnet') return [depth, measuredNu7, target];
  const before: DataTableColumn<WaitRow> = { id: 'before', header: story.phase === 'active' ? 'Before NU7' : 'Mainnet today', align: 'right', cell: row => number(formatWait(row.seconds(story.before?.averageSeconds))) };
  if (story.phase === 'active') return [depth, before, measuredNu7, target];
  return [depth, before, { ...target, header: `With NU7 · ${NU7_TARGET_SECONDS}s target`, cell: row => number(formatWait(row.target), 'text-cipher-gold') }];
}

function WalletConfirmationGuide({ story }: { story: SpeedStory }) {
  const columns = waitColumns(story);
  const comparisons = columns.slice(1);
  const note = 'Estimated waits. Wallet policies may differ.';

  return <>
    <Card className="card-static p-0 overflow-hidden md:hidden">
      <div className="divide-y divide-cipher-border">
        {ROWS.map((row, index) => <article key={row.key} className="p-4" aria-labelledby={`confirmation-depth-${row.key}`}>
          <h3 id={`confirmation-depth-${row.key}`} className="text-sm font-medium text-primary">{row.label}</h3>
          <p className="text-caption text-muted mt-1 mb-3">{row.detail}</p>
          <dl className="space-y-2">
            {comparisons.map(column => <div key={column.id} className="flex items-baseline justify-between gap-4">
              <dt className="text-caption text-muted">{column.header}</dt>
              <dd className="shrink-0 text-sm">{column.cell(row, index)}</dd>
            </div>)}
          </dl>
        </article>)}
      </div>
      <p className="text-caption text-muted px-4 py-3 border-t border-cipher-border">{note}</p>
    </Card>
    <DataTable columns={columns} rows={ROWS} rowKey={row => row.key} size="comfortable" className="card-static hidden md:block"
      footer={<p className="text-caption text-muted px-4 py-3">{note}</p>} />
  </>;
}

function MethodNotes({ story, observedAt }: { story: SpeedStory | null; observedAt: string | null }) {
  return <div className="p-4 sm:p-6 text-sm text-secondary space-y-3 max-w-4xl leading-relaxed">
    <p>Intervals are differences between timestamps recorded in consecutive canonical block headers. They are not measurements of when this explorer received blocks. Header timestamps can move backwards; daily averages use the full time span, so such intervals cancel out.</p>
    <p>Each bar is one complete UTC day. Today and the day containing an activation block are left out. Comparison values use the last seven days and, after an upgrade, start no earlier than its activation.</p>
    <p>Expected waits multiply the average interval by the number of confirmations. This assumes the next block includes the transaction and that blocks arrive at random. Congestion, fees and wallet sync can add time.</p>
    <p>ZIP 315 recommends 3 confirmations for a wallet’s own change and 10 for received funds, with no spending before 3. Wallets choose their own policy. The NU7 comparison assumes unchanged confirmation counts; ZIP 315 does not specify different counts for NU7. These thresholds are wallet policy, not a separate finality event.</p>
    {story?.network === 'mainnet' && story.phase === 'upcoming' && <p>Until NU7 is live on mainnet, days from today onward are drawn at the consensus target: {story.before?.targetSeconds != null ? `${story.before.targetSeconds} seconds` : 'the current target'} until activation, then {NU7_TARGET_SECONDS} seconds. The activation date comes from {story.activation?.status === 'announced' ? 'Zakura’s announcement' : 'the serving node’s schedule at the current target spacing'}. Once NU7 activates, measured days replace the projection.</p>}
    {story?.phase === 'upcoming' && story.testnetNu7?.averageSeconds != null && <p>On testnet, where NU7 is active, blocks averaged {formatSeconds(story.testnetNu7.averageSeconds)} over the last seven days. The mainnet projection uses the consensus target rather than testnet measurements.</p>}
    {story?.network === 'testnet' && <p>Testnet allows minimum-difficulty blocks, so before NU7 its blocks did not follow the 75-second target{story.irregular?.averageSeconds != null ? <>: in the week before activation they averaged {formatSeconds(story.irregular.averageSeconds)} with a median of {formatSeconds(story.irregular.medianSeconds)}</> : null}. Those days are faded and not used as a baseline.</p>}
    {observedAt && <p>Observations as of {observedAt}.</p>}
  </div>;
}

export default async function BlockSpeedPage() {
  const network = getNetwork();
  if (network === 'crosslink-testnet') notFound();
  const { host, story } = await loadBlockSpeedSnapshot(network);
  if (!host) retainLastGoodOrBuildFallback(null, new Error('Block speed observations unavailable'), 'block speed snapshot');
  const url = `${getBaseUrl()}/network/block-speed`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`, url,
    name: 'Zcash block speed and NU7', description: DESCRIPTION,
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  const subtitle = network === 'mainnet'
    ? 'Mainnet block times and confirmation waits before and after NU7.'
    : 'Testnet block times and confirmation waits with NU7.';
  const observedAt = host ? new Date(host.observedAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : null;
  const hasConfirmations = story != null && nu7Average(story) != null;

  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="NETWORK" eyebrowHref="/network" title="Zcash block speed" subtitle={subtitle} />
    <PageSectionNav sections={hasConfirmations ? SECTIONS : SECTIONS_WITHOUT_CONFIRMATIONS} ariaLabel="Block speed sections" />

    <section id="daily" className="network-section mb-10" aria-label="Daily block speed">
      <BlockSpeedPanel story={story} variant="full" />
    </section>

    {story && hasConfirmations && <section id="confirmations" className="network-section mb-10" aria-labelledby="confirmations-heading">
      <h2 id="confirmations-heading" className="type-section text-primary mb-2">Wallet confirmation guide</h2>
      <p className="text-sm text-muted mb-4 max-w-3xl"><a href={ZIP_315_URL} className="text-secondary underline underline-offset-4 hover:text-primary" target="_blank" rel="noopener noreferrer">ZIP 315</a> wallet policy: 3 confirmations for change, 10 for received funds.</p>
      <WalletConfirmationGuide story={story} />
    </section>}

    <section id="live" className="network-section mb-10" aria-label="Live block interval detail">
      <SectionHeader label="LIVE_DETAIL" actions={<Link href="/network#network-activity" className="text-caption font-mono text-muted hover:text-primary">Network activity →</Link>} />
      <Card className="card-static p-4 sm:p-6 mb-4">
        <BlockPulse nu7Height={story?.activation?.height ?? null}
          targetSeconds={story?.phase === 'active' ? NU7_TARGET_SECONDS : story?.before?.targetSeconds ?? null} />
      </Card>
      <p className="text-sm text-muted mb-4 max-w-3xl">Rolling 120-block average · refreshed every 15s.</p>
      <BlockTimeChart />
      <p className="text-caption text-muted mt-3 max-w-3xl">Faster blocks give competing blocks less time to propagate. <Link href={`/mining?orphans=${story?.phase === 'active' ? 'nu7' : '30d'}#orphans`} className="text-secondary underline underline-offset-4 hover:text-primary">Compare observed orphan rates before and since NU7 →</Link></p>
    </section>

    <Card className="network-detail-panel card-static">
      <details id="method" className="network-section network-detail-disclosure">
        <summary className="network-detail-toggle">
          <span>
            <span className="block font-mono text-sm font-semibold text-primary">method_and_limitations</span>
            <span className="block text-caption text-muted mt-1">Data source, assumptions{network === 'testnet' ? ' and why earlier testnet days are faded' : ' and how the projection works'}.</span>
          </span>
          <svg className="network-detail-chevron w-4 h-4 shrink-0 text-muted" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" /></svg>
        </summary>
        <MethodNotes story={story} observedAt={observedAt} />
      </details>
    </Card>
  </div>;
}
