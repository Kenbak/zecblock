import { readApiData } from '@/lib/api-client';
import Link from 'next/link';
import { getApiUrl } from '@/lib/api-config';
import { NETWORK_LABEL } from '@/lib/config';
import { buildPageMetadata, getBaseUrl } from '@/lib/seo';
import styles from './page.module.css';

const DESCRIPTION = 'Explore the story behind ZecBlock, formerly CipherScan: a Zcash blockchain explorer for public network data, shielded pool analytics and developer tools.';

export const metadata = buildPageMetadata({
  title: 'About the Zcash Explorer | ZecBlock',
  description: DESCRIPTION,
  path: '/about',
  networks: ['mainnet'],
});

const API_URL = getApiUrl();

async function getLiveStats() {
  const [networkResult, privacyResult] = await Promise.allSettled([
    fetch(`${API_URL}/v1/network/stats`, { next: { revalidate: 60 } })
      .then(res => res.ok ? readApiData(res) : null),
    fetch(`${API_URL}/v1/privacy/stats`, { next: { revalidate: 60 } })
      .then(res => res.ok ? readApiData(res) : null),
  ]);
  const network = networkResult.status === 'fulfilled' ? networkResult.value : null;
  const privacy = privacyResult.status === 'fulfilled' ? privacyResult.value : null;
  return [
    { label: 'Block height', value: formatNumber(network?.blockchain?.height) },
    { label: 'Transactions indexed', value: formatNumber(privacy?.totals?.totalTx) },
    { label: 'Shielded transactions', value: formatNumber(privacy?.totals?.shieldedTx) },
    { label: 'Chain data', value: formatNumber(network?.blockchain?.sizeGB, 2), unit: 'GiB' },
  ];
}

function formatNumber(value: unknown, decimals = 0): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: decimals })
    : '—';
}

const timeline = [
  {
    date: 'Nov 2025', month: '2025-11', title: 'Built at Zypherpunk',
    description: 'Started at the Zcash privacy hackathon, winning tracks from Project Tachyon, Gemini, Raybot and Network State.',
  },
  {
    date: 'Dec 2025', month: '2025-12', title: 'In-browser memo decryption',
    description: 'WASM-powered tools to decrypt shielded memos in the browser, without sending viewing keys to a server.',
    href: '/decrypt',
  },
  {
    date: 'Jan 2026', month: '2026-01', title: 'Privacy risks & batch patterns',
    description: 'Analysis of public transaction patterns that can increase linkability when funds leave a shielded pool.',
    href: '/privacy',
  },
  {
    date: 'Feb 2026', month: '2026-02', title: 'ZCG grant awarded',
    description: 'Support from Zcash Community Grants to continue building the explorer and its privacy tools.',
  },
  {
    date: 'Mar 2026', month: '2026-03', title: 'Cross-chain analytics',
    description: 'Tracking supported cross-chain ZEC swaps, their volume and the networks they connect.',
    href: '/crosschain',
  },
  {
    date: 'Apr 2026', month: '2026-04', title: 'Fork watch & network health',
    description: 'Monitoring chain reorganizations, competing blocks and reorg depth.',
    href: '/reorgs',
  },
  {
    date: 'May 2026', month: '2026-05', title: 'Rust indexer',
    description: 'A Rust indexing pipeline for querying blocks, transactions and public shielded-action data from PostgreSQL.',
  },
  {
    date: 'Jun 2026', month: '2026-06', title: 'Mining pool analytics',
    description: 'Pool distribution, estimated hashrate share and tracked miner address flows.',
    href: '/mining',
  },
  {
    date: 'Jul 2026', month: '2026-07', title: 'Ironwood & migration tracking',
    description: 'Ironwood support across the explorer, with migration flows, pool balances and supply verification.',
    href: '/ironwood',
  },
  {
    date: 'Aug 2026', month: '2026-08', title: 'Network node explorer',
    description: 'Crawler-observed nodes, client versions, reachability and network topology in one place.',
    href: '/network/nodes',
  },
  {
    date: 'Oct 1, 2026', month: '2026-10-01', title: 'CipherScan becomes ZecBlock',
    description: 'The explorer moved from cipherscan.app to zecblock.com under the ZecBlock name.',
  },
];

export default async function AboutPage() {
  const stats = await getLiveStats();
  const baseUrl = getBaseUrl();
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    '@id': `${baseUrl}/about#webpage`,
    url: `${baseUrl}/about`,
    name: 'About ZecBlock',
    description: DESCRIPTION,
    isPartOf: { '@id': `${baseUrl}/#website` },
    about: { '@id': 'https://zecblock.com/#organization' },
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
      <header className="relative mb-12 sm:mb-16">
        <div className={styles.grid} aria-hidden="true">
          {Array.from({ length: 32 }, (_, index) => (
            <span key={index} className={index === 11 ? styles.accent : undefined} />
          ))}
        </div>
        <div className="relative max-w-xl lg:max-w-lg">
          <p className="font-mono text-xs text-muted uppercase mb-5">&gt; About</p>
          <h1 className="type-page text-primary mb-5">A clearer view of Zcash.</h1>
          <p className="text-sm sm:text-base text-muted leading-relaxed mb-5">
            ZecBlock is a Zcash blockchain explorer. Follow blocks and transactions,
            understand shielded pools, and explore the health of the network.
          </p>
          <p className="text-sm text-muted leading-relaxed mb-5">
            Previously known as CipherScan, the explorer became ZecBlock on October 1, 2026,
            moving from cipherscan.app to zecblock.com.
          </p>
          <p className="text-xs text-muted">Built by <span className="text-primary">Kenbak</span>. Built for the Zcash community.</p>
        </div>
      </header>

      <section aria-labelledby="stats-heading" className="mb-12 sm:mb-16">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <h2 id="stats-heading" className="type-section text-primary">The network in numbers</h2>
          <p className="text-caption text-muted font-mono">{NETWORK_LABEL} snapshot</p>
        </div>
        <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {stats.map(stat => (
            <div key={stat.label} className="rounded-lg border border-cipher-border card-surface p-4 sm:p-5">
              <dt className="text-caption text-muted mb-3">{stat.label}</dt>
              <dd className="font-mono text-base sm:text-xl text-primary tabular-nums tracking-tight">
                {stat.value}{stat.unit && stat.value !== '—' && <span className="text-xs text-muted ml-1">{stat.unit}</span>}
              </dd>
            </div>
          ))}
        </dl>
        {stats.some(stat => stat.value === '—') && (
          <p className="text-caption text-muted mt-3">Some network data is currently unavailable.</p>
        )}
      </section>

      <section aria-labelledby="why-heading" className="border-t border-cipher-border py-8 sm:py-10 mb-4 sm:mb-6 grid sm:grid-cols-[1fr_2fr] gap-4 sm:gap-10">
        <h2 id="why-heading" className="type-section text-primary">Understand the network.<br />Respect the privacy.</h2>
        <p className="text-sm text-muted leading-relaxed">
          Privacy does not make the whole network invisible. Public transactions,
          shielded pool balances and network activity help people understand how Zcash is used.
          ZecBlock brings that data together for users, developers and researchers,
          without exposing the contents of shielded transactions.
        </p>
      </section>

      <section aria-labelledby="timeline-heading" className="mb-12 sm:mb-16">
        <h2 id="timeline-heading" className="type-section text-primary mb-6">Built over time</h2>
        <ol className="border-l border-cipher-border ml-1.5">
          {timeline.map(item => (
            <li key={item.month} className="relative pl-6 sm:pl-8 pb-7 last:pb-0 sm:grid sm:grid-cols-[7rem_1fr] sm:gap-5">
              <span aria-hidden="true" className="absolute -left-1 top-1.5 w-2 h-2 bg-cipher-border" />
              <time dateTime={item.month} className="block font-mono text-caption text-muted mb-2 sm:mb-0 sm:pt-0.5">{item.date}</time>
              <div>
                <h3 className="text-sm font-medium text-primary mb-1.5">
                  {item.href ? <Link href={item.href} className="underline decoration-cipher-border underline-offset-4 hover:decoration-current transition-colors">{item.title}<span aria-hidden="true" className="text-muted ml-2">↗</span></Link> : item.title}
                </h3>
                <p className="text-sm text-muted leading-relaxed max-w-xl">{item.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="contribute-heading" className="border-t border-cipher-border pt-8">
        <h2 id="contribute-heading" className="type-section text-primary mb-2">Open source. Community funded.</h2>
        <p className="text-sm text-muted leading-relaxed mb-4">Contributions, issues and feedback are welcome.</p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <a href="https://github.com/Kenbak/zecblock" target="_blank" rel="noopener noreferrer" className="inline-flex items-center min-h-11 text-primary underline decoration-cipher-border underline-offset-4 hover:decoration-current">GitHub ↗</a>
          <a href="https://x.com/zecblock" target="_blank" rel="noopener noreferrer" className="inline-flex items-center min-h-11 text-primary underline decoration-cipher-border underline-offset-4 hover:decoration-current">X / Twitter ↗</a>
          <Link href="/docs" className="inline-flex items-center min-h-11 text-primary underline decoration-cipher-border underline-offset-4 hover:decoration-current">API docs →</Link>
        </div>
      </section>
    </div>
  );
}
