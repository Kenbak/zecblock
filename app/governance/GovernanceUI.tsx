import { PageHeader } from '@/components/ui';
import { STATE_LABELS, catalogIsStale, type Catalog, type VoteState } from '@/lib/governance';
import { getBaseUrl } from '@/lib/seo';
import { GovernanceRefresh } from './GovernanceRefresh';

export function Status({ state, label }: { state?: VoteState | 'announced'; label?: string }) {
  if (label) return <span className="inline-flex shrink-0 rounded-md border border-brand-gold/30 bg-brand-gold/5 px-2 py-0.5 font-mono text-caption uppercase tracking-wider text-brand-gold">{label}</span>;
  if (!state) return null;
  const color = state === 'results' ? 'border-brand-gold/30 bg-brand-gold/5 text-brand-gold' : state === 'active' ? 'border-brand-gold/30 bg-brand-gold/5 text-brand-gold' : 'border-cipher-border text-secondary';
  return <span className={`inline-flex shrink-0 rounded-md border px-2 py-1 font-mono text-caption uppercase tracking-wider ${color}`}>{state === 'announced' ? 'Upcoming' : STATE_LABELS[state]}</span>;
}

export function GovernanceShell({ title, description, path, children, back = true }: { title: string; description: string; path: string; children: React.ReactNode; back?: boolean }) {
  const base = getBaseUrl();
  const data = { '@context': 'https://schema.org', '@type': 'CollectionPage', '@id': `${base}${path}#webpage`, url: `${base}${path}`, name: title, description, isPartOf: { '@id': `${base}/#website` }, publisher: { '@id': `${base}/#organization` } };
  return <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />
    <GovernanceRefresh />
    <PageHeader eyebrow="GOVERNANCE" eyebrowHref={back ? "/governance" : undefined} title={title} subtitle={description} />
    {children}
  </div>;
}

export function Freshness({ catalog }: { catalog: Catalog }) {
  const stale = catalogIsStale(catalog, Date.now());
  return <p role={stale ? 'status' : undefined} className={`mt-5 text-xs ${stale ? 'text-brand-gold' : 'text-muted'}`}>
    {catalog.unavailable ? 'Live vote data is temporarily unavailable. Official announcements and the NU7 archive remain accessible.' : stale ? 'Showing the last available vote data. Live updates are delayed.' : 'Vote status updates automatically from the voting chain.'}
    {catalog.checkedAt > 0 && <> Last successful check: {new Date(catalog.checkedAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC.</>}
  </p>;
}

export function SourceNote() {
  return <div className="mt-8 border-t border-cipher-border pt-4 text-xs leading-relaxed text-muted">
    <p>ZecBlock displays reviewed rounds and rounds endorsed by ZODL on the Valar voting chain.</p>
    <p className="mt-1">Votes are cast through supported wallets. ZecBlock never handles votes or keys.</p>
  </div>;
}
