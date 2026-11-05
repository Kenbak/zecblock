import Link from 'next/link';
import { buildPageMetadata, getBaseUrl, getNetwork } from '@/lib/seo';
import { AskExperience } from '../ask/AskExperience';
import { ZiftMark } from '@/components/ask/ZiftMark';
import styles from '../ask/ask.module.css';

// Zift is the product name; the API, components and storage keep their Ask identifiers.
const description = 'Ask questions about Zcash mainnet, write SQL against public chain data, and save charts and dashboards. Every result links to its source data.';
export const metadata = buildPageMetadata({
  title: 'Zift by ZecBlock: Zcash Data, SQL and Dashboards', description, path: '/zift',
  index: true, networks: ['mainnet'], imageAlt: 'Zift by ZecBlock — Zcash questions, SQL, charts and dashboards',
});

export default function ZiftPage() {
  const network = getNetwork();
  const url = `${getBaseUrl()}/zift`;
  const schema = { '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`, url,
    name: 'Zift by ZecBlock', description, isPartOf: { '@id': `${getBaseUrl()}/#website` }, publisher: { '@id': 'https://zecblock.com/#organization' } };
  return <div className={`${styles.page} max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-7`}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-cipher-border pb-6">
      <div><div className="flex items-center gap-3"><ZiftMark size={28} /><h1 className="text-2xl font-medium tracking-tight text-primary">Zift</h1><span className="text-sm text-muted">by ZecBlock</span><span className="border border-cipher-border rounded px-2 py-0.5 text-caption font-mono text-muted">BETA</span></div>
        <p className="mt-2 max-w-2xl text-sm text-secondary">Explore Zcash mainnet data: ask a question or write SQL, chart the results and save dashboards. Every number links to its source.</p></div>
      <span className="flex items-center gap-2 text-caption font-mono text-muted pt-2"><span className="h-1.5 w-1.5 bg-brand-gold" aria-hidden="true" />MAINNET DATA</span>
    </header>
    {network === 'mainnet' ? <AskExperience /> : <div className="py-16"><h2 className="text-xl text-primary">Zift is available on mainnet</h2><p className="mt-3 text-secondary">Zift explores Zcash mainnet data. It does not query this network.</p><Link href="https://zecblock.com/zift" className="inline-block mt-6 text-cipher-gold hover:underline">Open Zift on mainnet →</Link></div>}
  </div>;
}
