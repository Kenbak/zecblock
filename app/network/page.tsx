import { dailySupplyHistory } from '@/lib/issuance-curve';
import { readApiData } from '@/lib/api-client';
import NetworkClient, { type NetworkPageInitialData } from './NetworkClient';
import { getApiUrl, getNetwork, getBaseUrl } from '@/lib/seo';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import Link from 'next/link';
import { readUpgradeSnapshot } from '@/lib/network-upgrades';

// Keep the shared HTML/RSC snapshot inexpensive; browsers refresh live data
// independently. No server fetch may shorten this route's ISR lifetime.
export const revalidate = 300;

async function fetchJson<T>(
  apiBase: string,
  path: string,
  expectedNetwork: string,
): Promise<T | null> {
  try {
    const response = await fetchWithDeadline(`${apiBase}${path}`, {
      next: { revalidate: 300 },
    });
    if (!response.ok) return null;
    const data = await readApiData(response);
    if (typeof data?.network === 'string' && data.network !== expectedNetwork) return null;
    return data as T;
  } catch {
    return null;
  }
}

export default async function NetworkPage() {
  const apiBase = getApiUrl();
  const network = getNetwork();
  const fetchedAt = Date.now();
  const [stats, health, nodeLocations, nodeStats, recentBlocks, feeDistribution, halving, emission] = await Promise.all([
    fetchJson<NetworkPageInitialData['stats']>(apiBase, '/v1/network/stats', network),
    fetchJson<NetworkPageInitialData['health']>(apiBase, '/v1/network/health', network),
    fetchJson<NetworkPageInitialData['nodeLocations']>(apiBase, '/v1/network/nodes', network),
    fetchJson<NetworkPageInitialData['nodeStats']>(apiBase, '/v1/network/nodes/stats', network),
    fetchJson<NetworkPageInitialData['recentBlocks']>(apiBase, '/v1/network/blocks/recent-summary?limit=30', network),
    fetchJson<NetworkPageInitialData['feeDistribution']>(apiBase, '/v1/network/fee-distribution?period=30d', network),
    fetchJson<NetworkPageInitialData['halving']>(apiBase, '/v1/network/halving', network),
    fetchJson<NetworkPageInitialData['emission']>(apiBase, '/v1/network/emission', network),
  ]);
  if (!stats) {
    retainLastGoodOrBuildFallback(null, new Error('Network statistics unavailable'), 'network snapshot');
  }
  const pageUrl = `${getBaseUrl()}/network`;
  const upgrade = readUpgradeSnapshot(stats, network);
  const nu7Height = upgrade?.schedule.nu7Height;
  const nu7Active = nu7Height != null && upgrade != null && upgrade.height >= nu7Height;
  const pageSchema = {
    '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${pageUrl}#webpage`,
    url: pageUrl, name: 'Zcash Network',
    description: 'Zcash protocol, issuance, block production and observed nodes.',
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(pageSchema).replace(/</g, '\\u003c') }} />
    <NetworkClient initialData={{
      fetchedAt, stats, health, nodeLocations, nodeStats, recentBlocks, feeDistribution, halving,
      emission: emission ? {
        circulating: emission.circulating, remaining: emission.remaining,
        dailyEmissionEstimate: emission.dailyEmissionEstimate, supplyObservedAt: emission.supplyObservedAt,
        cadence: emission.cadence, supplyHistory: dailySupplyHistory(emission.supplyHistory ?? []), projection: emission.projection,
      } : null,
    }} />
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
      <div className="border-t border-cipher-border pt-6 max-w-3xl text-sm text-muted space-y-2">
        <h2 className="font-mono font-medium text-secondary">About these observations</h2>
        {nu7Height != null && <p>The serving node announces NU7 at <Link href={`/block/${nu7Height}`} className="text-brand-gold hover:underline">block #{nu7Height.toLocaleString('en-US')}</Link> on Zcash {network}. {nu7Active ? <>The upgrade is active; explore <Link href="#nu7-accounting" className="text-brand-gold hover:underline">fee allocation and NSM accounting</Link> below.</> : <>View its canonical block or the estimated activation countdown.</>}</p>}
        <p>Chain statistics, recent blocks and node discovery are separate observations and can update at different times. Block cadence uses timestamps recorded in blocks; these are not measurements of when this explorer received them.</p>
        <p>The map shows observed reachable nodes, not a census of every Zcash node. Peer connections and disk usage in Technical details describe this explorer’s node. Observed transaction fees describe past transactions and are not fee recommendations.</p>
      </div>
    </section>
  </>;
}
