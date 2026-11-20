import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readApiData } from '@/lib/api-client';
import { PageHeader } from '@/components/ui/SectionHeader';
import { buildPageMetadata, getApiUrl, getBaseUrl, getNetwork } from '@/lib/seo';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { normalizeApiBaseUrl } from '@/lib/network';
import type { WalletServerData } from '@/lib/wallet-servers';
import WalletServersClient from './WalletServersClient';

// A cached page must not outlive the five-minute life of a check.
export const dynamic = 'force-dynamic';
export const metadata = buildPageMetadata({
  title: 'Zcash Wallet Servers: Live Lightwalletd Status | ZecBlock',
  description: 'Live checks of public Zcash wallet servers, including fastz.cash and zec.rocks: which answer, their block height, software and if their tip matches our index.',
  keywords: ['zcash wallet servers', 'lightwalletd servers', 'zcash lightwalletd status', 'fastz.cash', 'zec.rocks', 'ztreamer', 'zcash light wallet sync'],
  path: '/network/wallet-servers', index: true, networks: ['mainnet'],
  imageAlt: 'ZecBlock Zcash wallet server checks',
});

export default async function WalletServersPage() {
  const network = getNetwork();
  // The registry lists mainnet servers only.
  if (network !== 'mainnet') notFound();
  let initialData: WalletServerData | null = null;
  try {
    const response = await fetchWithDeadline(`${getApiUrl()}/v1/network/wallet-servers`, { cache: 'no-store' });
    if (response.ok) {
      const data = await readApiData<WalletServerData>(response);
      if (data.network === network && Array.isArray(data.operators)) initialData = data;
    }
  } catch { /* The introduction and an explicit unavailable state still render on an API outage. */ }
  const publicApiUrl = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_URL || 'https://api.zecblock.com');
  const initialNow = Date.now();
  const url = `${getBaseUrl()}/network/wallet-servers`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`, url,
    name: 'Zcash wallet servers',
    description: 'Checks of public Zcash wallet servers from one ZecBlock server: whether each name answers, the block height it reports, its software and whether its tip block matches ZecBlock’s index.',
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="NETWORK" eyebrowHref="/network" title="Zcash wallet servers"
      subtitle="Light wallets sync from a wallet server instead of running a full node. ZecBlock asks each public server below what a wallet asks first, then compares the answer with its own index of the chain."
      actions={<span className="type-label font-mono text-muted">MAINNET</span>} />
    <nav aria-label="Wallet server page sections" className="flex flex-wrap gap-x-6 gap-y-3 border-b border-cipher-border pb-5 mb-6 text-caption font-mono text-muted">
      <a href="#server-map" className="hover:text-primary">Map</a>
      <a href="#server-checks" className="hover:text-primary">Servers</a>
      <a href="#wallet-server-method" className="hover:text-primary">Methodology</a>
      <Link href="/network/attestations" className="hover:text-primary">Indexer attestations</Link>
      <Link href="/network/nodes" className="hover:text-primary">Network nodes</Link>
      <a href={`${publicApiUrl}/v1/network/wallet-servers`} className="sm:ml-auto hover:text-primary">JSON API ↗</a>
    </nav>
    <WalletServersClient initialData={initialData} initialNow={initialNow} network={network} />
    <details id="wallet-server-method" className="group mt-8 border border-cipher-border rounded-lg scroll-mt-36">
      <summary className="cursor-pointer list-none flex items-center justify-between gap-4 p-5 sm:p-6 hover:bg-glass-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold">
        <span><span className="block font-mono text-sm text-primary">Methodology &amp; limitations</span><span className="block text-caption text-muted mt-1">What each check asks, what it compares and what it cannot show.</span></span><span aria-hidden="true" className="text-muted group-open:rotate-90">›</span>
      </summary>
      <div className="border-t border-cipher-border p-5 sm:p-6">
        <div className="grid gap-6 md:grid-cols-3 text-sm text-secondary leading-relaxed">
          <div><h3 className="font-medium text-primary mb-2">01 · A wallet’s first two questions</h3><p>Each check opens an encrypted connection and makes two requests from the wallet protocol: server information and the latest block. A server that does not finish both within 5 seconds is shown as not answering.</p></div>
          <div><h3 className="font-medium text-primary mb-2">02 · Compared with our index</h3><p>The block hash a server reports is compared with the block ZecBlock indexed at the same height. When a server is ahead of our index there is nothing to compare yet, and the tip is shown as not compared.</p></div>
          <div><h3 className="font-medium text-primary mb-2">03 · One vantage point</h3><p>Checks run from one ZecBlock server. Global and area names route by the caller’s location, so a wallet elsewhere can reach a different machine and see a different response time.</p></div>
        </div>
        <p className="text-sm text-muted mt-6 max-w-4xl">This is not a sync benchmark or an uptime record. The “from our server” time is one request on an open connection, measured from our server. Your browser never contacts these servers: every check runs on our side. Software names and versions are what each server reports about itself. A different tip block can be a short-lived competing block rather than a fault. Results expire after 5 minutes, and a name counts as behind when it is 3 or more blocks below our index. Listing here is not an endorsement, and the list does not cover every public server.</p>
        <div className="flex flex-wrap gap-x-6 gap-y-3 mt-5 text-sm">
          <a className="text-secondary hover:text-primary underline underline-offset-4" href="https://github.com/zcash/lightwalletd" target="_blank" rel="noopener noreferrer">lightwalletd ↗</a>
          <a className="text-secondary hover:text-primary underline underline-offset-4" href="https://github.com/zcashlabs/ztreamer" target="_blank" rel="noopener noreferrer">Ztreamer ↗</a>
          <a className="text-secondary hover:text-primary underline underline-offset-4" href={`${publicApiUrl}/v1/network/wallet-servers`}>Public JSON API ↗</a>
        </div>
      </div>
    </details>
  </div>;
}
