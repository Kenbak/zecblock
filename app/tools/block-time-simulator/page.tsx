import Link from 'next/link';
import { PageHeader } from '@/components/ui/SectionHeader';
import { Card } from '@/components/ui/Card';
import { buildPageMetadata, getBaseUrl } from '@/lib/seo';
import { OBSERVED_NU7_ORPHANS, SIM_ERAS, SIM_MAX_SECONDS, SIM_MIN_SECONDS, formatDuration, simulate } from '@/lib/block-time-sim';
import SimulatorClient from './SimulatorClient';

const TITLE = 'Zcash Block Time Simulator: 20s vs 25s vs 75s | ZecBlock';
const DESCRIPTION = 'Try any Zcash block time from 5 to 150 seconds and any confirmation depth to see waits, long gaps, orphan risk and costs, using a model checked against every speed mainnet has run at.';

export const metadata = buildPageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  keywords: ['zcash block time', 'zcash 20 second blocks', 'zcash nu7 block time', 'zcash confirmation time', 'block time simulator', 'zcash orphan rate'],
  path: '/tools/block-time-simulator',
  networks: ['mainnet'],
});

const fmtShare = (share: number) => `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;

export default function BlockTimeSimulatorPage() {
  const url = `${getBaseUrl()}/tools/block-time-simulator`;
  const now = simulate(25, 3);
  const proposed = simulate(20, 3);
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebApplication', '@id': `${url}#app`, url,
    name: 'Zcash block time simulator', description: DESCRIPTION,
    applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any', isAccessibleForFree: true,
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };

  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12 animate-fade-in">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="TOOLS" eyebrowHref="/tools" title="Zcash block time simulator"
      subtitle={`Pick a block time from ${SIM_MIN_SECONDS} to ${SIM_MAX_SECONDS} seconds and see what users would feel and what it would cost. Three confirmations take about ${formatDuration(now.spendableMean)} with today's 25-second blocks and about ${formatDuration(proposed.spendableMean)} at 20 seconds.`} />

    <SimulatorClient />

    <Card className="card-static mt-10">
      <details id="method" className="network-detail-disclosure">
        <summary className="network-detail-toggle">
          <span>
            <span className="block font-mono text-sm font-semibold text-primary">method_and_limitations</span>
            <span className="block text-caption text-muted mt-1">The model, the measured data behind it, and what it cannot tell you.</span>
          </span>
          <svg className="network-detail-chevron w-4 h-4 shrink-0 text-muted" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" /></svg>
        </summary>
        <div className="p-4 sm:p-6 text-sm text-secondary space-y-3 max-w-4xl leading-relaxed">
          <p>Proof-of-work blocks arrive at random. With difficulty holding the average at the target T, gaps between blocks follow an exponential distribution: the share of gaps lasting at least x seconds is e<sup>−x/T</sup>. Waiting for k confirmations is the sum of k such gaps. Because arrivals are memoryless, a transaction waits a full average gap for its first block, not half of one.</p>
          <p>This model was checked against canonical mainnet block-header times:</p>
          <ul className="list-disc pl-5 space-y-1">
            {SIM_ERAS.map(e => <li key={e.targetSeconds}>{e.targetSeconds}s, {e.label.toLowerCase()} (blocks {e.fromHeight.toLocaleString('en-US')}–{e.toHeight.toLocaleString('en-US')}, {e.intervals.toLocaleString('en-US')} gaps): average {e.meanSeconds}s; gaps of 2+ minutes {fmtShare(e.shareAtLeast120)} measured against {fmtShare(Math.exp(-120 / e.meanSeconds))} predicted.</li>)}
          </ul>
          <p>The typical longest wait in a day is the expected maximum of a day&apos;s gaps, T × (ln n + 0.577) for n blocks. At slower targets the measured daily longest runs up to about 8% above it.</p>
          <p>Orphans are competing blocks seen by ZecBlock&apos;s observers that lost to the canonical block. Observers grew from 1 to 10 on 5 November 2026, so only the NU7 era has a comparable count: {OBSERVED_NU7_ORPHANS.orphaned} orphaned and {OBSERVED_NU7_ORPHANS.canonical.toLocaleString('en-US')} canonical blocks over the complete UTC days 7–15 November, {(OBSERVED_NU7_ORPHANS.orphaned / (OBSERVED_NU7_ORPHANS.canonical + OBSERVED_NU7_ORPHANS.orphaned) * 100).toFixed(2)}%, about 30 a day. Most were close races: about two thirds were first seen within 2 seconds of the winning block, and about 7% arrived 10 seconds or more after it, which points to a miner working on an outdated tip. Between 10 and 25 seconds the page estimates the rate by scaling today&apos;s with block rate, assuming a fixed propagation delay; below 10 seconds orphans can rise much faster than that, so no estimate is shown. Observers do not see every competing block, so these are lower bounds.</p>
          <p>Empty-block data multiplies blocks per day by the average size of a block holding only its coinbase transaction since NU7 (1,943 bytes). Confirmation depth is a choice: <a href="https://zips.z.cash/zip-0315" className="underline underline-offset-4 hover:text-primary" target="_blank" rel="noopener noreferrer">ZIP 315</a> recommends 10 for received funds in wallets, while many payments use fewer.</p>
          <p>Other chains are listed at their protocol block targets. Their waits use each chain&apos;s own rule: a common confirmation convention for Bitcoin and Litecoin, Monero&apos;s 10-block lock, and Ethereum&apos;s nominal two-epoch finality, which often takes longer in practice. Proof-of-stake and blockDAG chains do not follow the random-arrival model, so they are shown for reference only.</p>
          <p>This page shows consequences of a block time, not a recommendation. Changing it needs a network upgrade, and things the model does not cover, such as network bandwidth, mining pool behaviour and wallet sync, also matter. See measured block times on <Link href="/network/block-speed" className="underline underline-offset-4 hover:text-primary">Zcash block speed</Link>.</p>
        </div>
      </details>
    </Card>
  </div>;
}
