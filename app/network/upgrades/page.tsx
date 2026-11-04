import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/SectionHeader';
import { Badge } from '@/components/ui/Badge';
import { buildPageMetadata, getBaseUrl, getNetwork } from '@/lib/seo';
import { loadUpgradeTrackers } from '@/lib/upgrade-trackers-server';
import { buildUpgradeHistory } from '@/lib/upgrade-history';
import { UpgradeTimeline } from '@/components/network/UpgradeTimeline';

export const revalidate = 300;
const TITLE = 'Zcash Network Upgrades: Changes & Trackers | ZecBlock';
const DESCRIPTION = 'Explore major changes in every Zcash network upgrade, from Overwinter to NU7: block speed, NSM reserve and fees, shielded pools, transactions and funding.';

export function generateMetadata() {
  return buildPageMetadata({ title: TITLE, description: DESCRIPTION, path: '/network/upgrades', index: true, networks: ['mainnet', 'testnet'] });
}

export default async function NetworkUpgradesPage() {
  const network = getNetwork();
  if (network === 'crosslink-testnet') notFound();
  const { snapshot } = await loadUpgradeTrackers(network);
  const milestones = buildUpgradeHistory(snapshot, network);
  const base = getBaseUrl();
  const url = `${base}/network/upgrades`;
  const schema = {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'CollectionPage', '@id': `${url}#webpage`, url, name: 'Zcash network upgrades', description: DESCRIPTION, isPartOf: { '@id': `${base}/#website` }, publisher: { '@id': 'https://zecblock.com/#organization' }, mainEntity: { '@id': `${url}#upgrades` }, breadcrumb: { '@id': `${url}#breadcrumb` } },
      { '@type': 'ItemList', '@id': `${url}#upgrades`, itemListElement: milestones.map((upgrade, index) => ({ '@type': 'ListItem', position: index + 1, name: upgrade.label, url: `${url}#${upgrade.id}` })) },
      { '@type': 'BreadcrumbList', '@id': `${url}#breadcrumb`, itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Network', item: `${base}/network` }, { '@type': 'ListItem', position: 2, name: 'Network upgrades', item: url }] },
    ],
  };
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="NETWORK" eyebrowHref="/network" title="Network upgrades" subtitle="What changed on Zcash, and where to see its effects." actions={<Badge color="muted" variant="subtle">{network === 'mainnet' ? 'Mainnet' : 'Testnet'}</Badge>} />
    <UpgradeTimeline network={network} initialSnapshot={snapshot} />
    <div className="flex flex-wrap items-start justify-between gap-4 mt-5 text-caption text-muted">
      <Link href="/network" className="text-secondary hover:text-primary">Network overview →</Link>
    </div>
  </div>;
}
