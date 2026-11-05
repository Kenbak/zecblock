import Link from 'next/link';
import { CardsClient } from './CardsClient';
import { PageHeader } from '@/components/ui';
import { factCardsFor } from '@/lib/fact-cards';
import { buildPageMetadata, getBaseUrl, getNetwork } from '@/lib/seo';

const TITLE = 'Live Zcash Data Cards to Share | ZecBlock';
const DESCRIPTION = 'Branded, always-current images of Zcash privacy, supply, network, mining and cross-chain swap data. Search by topic, then post, download or embed.';

export const metadata = buildPageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  keywords: ['zcash infographics', 'zcash stats images', 'zcash shielded supply', 'zcash halving countdown', 'ZEC swap volume', 'zcash media kit'],
  path: '/cards',
  networks: ['mainnet'],
});

export default function CardsPage() {
  const network = getNetwork();
  const site = getBaseUrl();
  const cards = network === 'crosslink-testnet' ? [] : factCardsFor(network);
  const url = `${site}/cards`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', '@id': `${url}#webpage`, url, name: 'Live Zcash data cards', description: DESCRIPTION,
    isPartOf: { '@id': `${site}/#website` }, publisher: { '@id': 'https://zecblock.com/#organization' },
    mainEntity: { '@type': 'ItemList', numberOfItems: cards.length, itemListElement: cards.map((card, i) => ({
      '@type': 'ListItem', position: i + 1, item: { '@type': 'ImageObject', '@id': `${url}#${card.id}`, name: card.title, description: card.description, contentUrl: `${site}/cards/${card.id}/image`, width: 1200, height: 675 },
    })) },
  };
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="DATA_CARDS" title="Live Zcash Data Cards"
      subtitle="Ready-made images of Zcash on-chain data, redrawn every minute. Find a topic, then post it, download it, or embed it on your own site." />
    <p className="mb-8 max-w-3xl text-sm text-secondary">
      Every card shows its source and render time, and links back to the page with the full data. A card whose data is unavailable is not drawn.
      Swap venues are indexed separately and may overlap through aggregators, so their volumes are compared but never added together.
      For time-series charts, see <Link href="/charts" className="text-primary underline underline-offset-2">Zcash charts</Link>.
    </p>
    {cards.length
      ? <CardsClient cards={cards} site={site} />
      : <p className="py-16 text-center text-muted">Data cards are available on Zcash mainnet and testnet.</p>}
  </div>;
}
