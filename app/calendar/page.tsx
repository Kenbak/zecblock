import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui/SectionHeader';
import { buildPageMetadata, getBaseUrl, getNetwork } from '@/lib/seo';
import { loadCalendar } from '@/lib/zcash-calendar-server';
import { CalendarView } from './CalendarView';

export const revalidate = 60;
const TITLE = 'Zcash Calendar: Upgrades, Votes & Key Blocks | ZecBlock';
const DESCRIPTION = 'Every important Zcash block and date in one timeline: network upgrades, halvings, coinholder votes, grant deadlines and snapshots, with estimated blocks for what is ahead.';

export function generateMetadata() {
  return buildPageMetadata({ title: TITLE, description: DESCRIPTION, path: '/calendar', index: true, networks: ['mainnet'] });
}

export default async function CalendarPage() {
  if (getNetwork() !== 'mainnet') notFound();
  const calendar = await loadCalendar();
  const { events } = calendar;
  const base = getBaseUrl();
  const url = `${base}/calendar`;
  const upcoming = events.filter(event => event.status === 'upcoming');
  const schema = {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'CollectionPage', '@id': `${url}#webpage`, url, name: 'Zcash calendar', description: DESCRIPTION, isPartOf: { '@id': `${base}/#website` }, publisher: { '@id': 'https://zecblock.com/#organization' }, mainEntity: { '@id': `${url}#events` } },
      { '@type': 'ItemList', '@id': `${url}#events`, name: 'Upcoming Zcash milestones', itemListElement: upcoming.map((event, index) => ({ '@type': 'ListItem', position: index + 1, name: event.title, url: `${url}#${event.id}` })) },
    ],
  };
  return <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="NETWORK" eyebrowHref="/network" title="Zcash calendar" subtitle="Upgrades, halvings, votes and deadlines, past and ahead, mapped to the blocks where they happen." />
    <CalendarView {...calendar} />
    <div className="mt-8 border-t border-cipher-border pt-4 text-xs leading-relaxed text-muted">
      <p>Block-anchored events use consensus heights; their past dates are mined header times and future dates are estimates from recent block times. Dated events use official UTC deadlines; their future blocks are estimates at the current target spacing and shift as blocks arrive. A vote’s snapshot block appears once its ballot is registered on the voting chain.</p>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1"><Link href="/governance" className="text-secondary hover:text-primary">Governance →</Link><Link href="/network/upgrades" className="text-secondary hover:text-primary">Network upgrades →</Link><Link href="/network#issuance" className="text-secondary hover:text-primary">Issuance &amp; halving →</Link></p>
    </div>
  </div>;
}
