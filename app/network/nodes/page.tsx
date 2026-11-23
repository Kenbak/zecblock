import { buildPageMetadata, getBaseUrl, getNetwork } from '@/lib/seo';
import NodesClient from './NodesClient';
import { PageAbout } from '@/components/HomeAbout';

export const metadata = buildPageMetadata({
  title: 'Zcash Network Nodes | ZecBlock',
  description: 'Explore the Zcash peer-to-peer network: observed active nodes, client implementations, version adoption, and geographic distribution.',
  keywords: ['zcash nodes', 'zcash network nodes', 'zcash peer network', 'zebra nodes', 'zakura nodes', 'zcash node map', 'zcash network topology'],
  path: '/network/nodes',
  index: true,
});

export default function NodesPage() {
  const pageUrl = `${getBaseUrl()}/network/nodes`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${pageUrl}#webpage`,
    url: pageUrl, name: 'Zcash Nodes',
    description: getNetwork() === 'mainnet'
      ? 'Observed active Zcash IPs from live peer connections and crawler responses serving Zcash mainnet chain headers.'
      : 'Zcash peer connections observed by this explorer’s network infrastructure.',
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
      <NodesClient />

      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <div className="border-t border-cipher-border pt-8 max-w-3xl">
          <h2 className="text-sm font-semibold font-mono text-secondary mb-3 lowercase tracking-tight">
            About Network Nodes
          </h2>
          <div className="space-y-3 text-sm text-muted leading-relaxed">
            <p>
              {getNetwork() === 'mainnet' ? <>
              This page combines connections reported by our Zcash node with recent
              crawler responses that serve a known Zcash mainnet checkpoint header, deduplicated by IP address.
              This is the active network we observe, not a count of every node.
              </> : <>This page shows peers observed by our network infrastructure, deduplicated by IP address. It is not a count of every node.</>}
            </p>
            <p>
              {getNetwork() === 'mainnet' ? 'Graph links show address advertisements, not confirmed connections.' : 'Graph links show advertised peer relationships, not confirmed remote connections.'}
              {getNetwork() === 'mainnet' ? ' Average handshake time covers crawler verifications, not live-peer ping times.' : ''}
            </p>
            <p>
              Node locations are rounded to 1-degree precision to protect operator privacy.
              No IP addresses or exact coordinates are exposed.
              This product includes GeoLite2 data
              created by MaxMind, available from{' '}
              <a href="https://www.maxmind.com" className="text-primary hover:underline" rel="noopener noreferrer" target="_blank">
                maxmind.com
              </a>.
            </p>
          </div>
        </div>
      </section>
      <PageAbout path="/network/nodes" />
    </>
  );
}
