import Link from 'next/link';
import { PageHeader } from '@/components/ui/SectionHeader';
import { getBaseUrl } from '@/lib/seo';

// Icons
const Icons = {
  Code: () => (
    <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  ),
  Bolt: () => (
    <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  ),
  Lock: () => (
    <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  ),
  Calculator: () => (
    <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  ),
  Tree: () => (
    <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
    </svg>
  ),
  Shield: () => (
    <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="m12 3-8 3v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h8m-4-4v8" />
    </svg>
  ),
};

const tools = [
  {
    href: '/tools/decode',
    title: 'Decode transaction',
    desc: 'Inspect the inputs, outputs and public shielded fields in raw transaction hex.',
    icon: Icons.Code,
  },
  {
    href: '/tools/broadcast',
    title: 'Broadcast transaction',
    desc: 'Submit a signed transaction to the Zcash network.',
    icon: Icons.Bolt,
  },
  {
    href: '/decrypt',
    title: 'Decrypt memo',
    desc: 'Read Orchard and Ironwood memos with your viewing key. Decryption stays in your browser.',
    icon: Icons.Lock,
  },
  {
    href: '/tools/blend-check',
    title: 'Blend Check',
    desc: 'Compare an amount with observed shielding and deshielding amounts.',
    icon: Icons.Shield,
  },
  {
    href: '/tools/block-time-simulator',
    title: 'Block time simulator',
    desc: 'See what a faster or slower Zcash block time would mean, from measured mainnet data.',
    icon: Icons.Bolt,
  },
  {
    href: '/tools/unit-converter',
    title: 'Unit converter',
    desc: 'Convert between ZEC and zatoshis, down to the smallest unit.',
    icon: Icons.Calculator,
  },
  {
    href: '/tools/anchor-search',
    title: 'Anchor root search',
    desc: 'Find Sapling and Orchard commitment roots in canonical and orphaned blocks.',
    icon: Icons.Tree,
  },
];

export default function ToolsPage() {
  const baseUrl = getBaseUrl();
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${baseUrl}/tools#webpage`,
    url: `${baseUrl}/tools`,
    name: 'Zcash Developer Tools',
    description: 'Tools to inspect transactions, read shielded memos, compare amounts and debug wallets.',
    isPartOf: { '@id': `${baseUrl}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: tools.map((tool, index) => ({
        '@type': 'ListItem', position: index + 1,
        item: { '@type': 'WebPage', name: tool.title, description: tool.desc, url: `${baseUrl}${tool.href}` },
      })),
    },
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
      <PageHeader
        eyebrow="TOOLS"
        title="Developer tools"
        subtitle="Inspect transactions, read shielded memos and debug wallets."
      />

      <ul aria-label="Zcash tools" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {tools.map(tool => {
          const Icon = tool.icon;
          return (
            <li key={tool.href}>
              <Link href={tool.href} className="group block h-full rounded-lg border border-cipher-border card-surface p-5 sm:p-6 transition-colors hover:border-cipher-gold/40">
                <div className="flex items-center justify-between gap-4 text-muted mb-5">
                  <Icon />
                  <span aria-hidden="true" className="transition-colors group-hover:text-brand-gold group-focus-visible:text-brand-gold">→</span>
                </div>
                <h2 className="text-base font-medium text-primary mb-2">{tool.title}</h2>
                <p className="text-sm text-muted leading-relaxed max-w-sm">{tool.desc}</p>
              </Link>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="api-heading" className="mt-8 sm:mt-10 border-t border-cipher-border pt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-8">
        <div>
          <h2 id="api-heading" className="type-section text-primary mb-1">Building with Zcash data?</h2>
          <p className="text-sm text-muted leading-relaxed">Explore endpoints, response formats and examples in the API reference.</p>
        </div>
        <Link href="/docs" className="inline-flex min-h-11 items-center gap-2 self-start sm:self-auto shrink-0 text-sm text-primary underline decoration-cipher-border underline-offset-4 hover:decoration-current">
          API documentation <span aria-hidden="true">→</span>
        </Link>
      </section>
    </div>
  );
}
