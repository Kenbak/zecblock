import type { ReactNode } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/SectionHeader';
import { isMainnet } from '@/lib/config';
import { PRIVATE_EXPLORER_URL } from '@/lib/navigation';
import { getBaseUrl } from '@/lib/seo';

/** One outline style for every tool: 24px grid, 1.5 stroke, drawn at 20px beside the title. */
function ToolIcon({ children }: { children: ReactNode }) {
  return (
    <svg className="h-5 w-5 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

const Icons = {
  Code: <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />,
  Bolt: <path d="M13 10V3L4 14h7v7l9-11h-7z" />,
  Lock: <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />,
  // Hat and glasses: the same hidden person as the Private Explorer icon in the header.
  Hidden: <><path d="M3 11h18" /><path d="M5 11V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v4" /><circle cx="7" cy="17" r="3" /><circle cx="17" cy="17" r="3" /><path d="M10 17h4" /></>,
  Shield: <><path d="m12 3-8 3v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="M8 12h8m-4-4v8" /></>,
  Clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  Calculator: <path d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />,
  Tree: <path d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />,
};

interface Tool {
  href: string;
  title: string;
  desc: string;
  icon: ReactNode;
  /** Opens another site in a new tab. */
  external?: boolean;
}

// Eight tools fill two even rows of four on desktop. Every tool lives here and nowhere
// else in the site chrome: the menus and the footer link to this page.
const tools: Tool[] = [
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
  // The Private Explorer covers mainnet only.
  ...(isMainnet ? [{
    href: PRIVATE_EXPLORER_URL,
    title: 'Private Explorer',
    desc: 'Look up any Zcash transaction, block or address without revealing which one.',
    icon: Icons.Hidden,
    external: true,
  }] : []),
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
    icon: Icons.Clock,
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

const CARD_CLASS = 'group flex h-full flex-col rounded-lg border border-cipher-border card-surface p-5 transition-colors hover:border-cipher-gold/40';

function ToolCard({ tool }: { tool: Tool }) {
  const body = (
    <>
      <span className="flex items-center gap-2.5">
        <span className="text-muted transition-colors group-hover:text-brand-gold group-focus-visible:text-brand-gold"><ToolIcon>{tool.icon}</ToolIcon></span>
        <h2 className="min-w-0 text-base font-medium text-primary">{tool.title}</h2>
        <span aria-hidden="true" className="ml-auto text-muted transition-colors group-hover:text-brand-gold group-focus-visible:text-brand-gold">{tool.external ? '↗' : '→'}</span>
      </span>
      <p className="mt-3 text-sm leading-relaxed text-muted">{tool.desc}</p>
    </>
  );
  return tool.external
    ? <a href={tool.href} target="_blank" rel="noopener noreferrer" aria-label={`${tool.title} (opens in a new tab)`} className={CARD_CLASS}>{body}</a>
    : <Link href={tool.href} className={CARD_CLASS}>{body}</Link>;
}

export default function ToolsPage() {
  const baseUrl = getBaseUrl();
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${baseUrl}/tools#webpage`,
    url: `${baseUrl}/tools`,
    name: 'Zcash Tools',
    description: 'Tools to inspect transactions, read shielded memos, compare amounts and debug wallets.',
    isPartOf: { '@id': `${baseUrl}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: tools.map((tool, index) => ({
        '@type': 'ListItem', position: index + 1,
        item: { '@type': 'WebPage', name: tool.title, description: tool.desc, url: tool.external ? tool.href : `${baseUrl}${tool.href}` },
      })),
    },
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
      <PageHeader
        eyebrow="TOOLS"
        title="Zcash tools"
        subtitle="Inspect transactions, read shielded memos and debug wallets."
      />

      <ul aria-label="Zcash tools" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tools.map(tool => <li key={tool.href}><ToolCard tool={tool} /></li>)}
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
