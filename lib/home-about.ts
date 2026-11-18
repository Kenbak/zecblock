/**
 * Mainnet homepage "About this Zcash explorer" copy.
 *
 * The visible section and its FAQPage JSON-LD are both rendered from this
 * list, so the structured data cannot drift from what the page shows.
 * Keep each answer a plain-text statement of what the explorer actually does.
 */
export interface HomeFaqItem {
  question: string;
  answer: string;
  link: { href: string; label: string };
}

export const HOME_ABOUT_HEADING = 'About this Zcash explorer';

export const HOME_ABOUT_INTRO =
  'ZecBlock is an open-source Zcash explorer. Search any block, transaction or transparent address, watch the mempool as transactions arrive, and see how much ZEC each shielded pool holds. It shows what the chain makes public and nothing more: shielded senders, recipients and amounts stay encrypted.';

export const HOME_FAQ: HomeFaqItem[] = [
  {
    question: 'How do I check a Zcash transaction?',
    answer:
      'Paste its transaction ID into the search bar. You will see whether it is pending or confirmed, the block it is in, and its public inputs and outputs. For shielded transactions, addresses and amounts stay encrypted.',
    link: { href: '/txs', label: 'Latest Zcash transactions' },
  },
  {
    question: 'Can I look up a shielded address?',
    answer:
      'Not its balance or history. A shielded address does not reveal either on the chain, so no explorer can show them. If you hold the viewing key, you can decrypt a transaction memo in your browser; the key never leaves your device.',
    link: { href: '/decrypt', label: 'Decrypt a memo' },
  },
  {
    question: 'What are Zcash shielded pools?',
    answer:
      'Shielded pools hold ZEC whose owners and amounts are encrypted. The total in each pool is public, so anyone can check the supply and see how much ZEC is shielded.',
    link: { href: '/pools', label: 'Shielded pool statistics' },
  },
  {
    question: 'What is the current Zcash block height?',
    answer:
      'The latest blocks page lists the newest block first, so its height is the current one. Every block has its own page with its transactions.',
    link: { href: '/blocks', label: 'Latest Zcash blocks' },
  },
  {
    question: 'Is there a Zcash testnet explorer?',
    answer:
      'Yes. ZecBlock also runs on the Zcash testnet, where you can search TAZ blocks, transactions and addresses before using mainnet.',
    link: { href: 'https://testnet.zecblock.com', label: 'Zcash testnet explorer' },
  },
  {
    question: 'Is there a Zcash API?',
    answer:
      'Yes. The public ZecBlock API serves blocks, transactions, addresses and network data over HTTP. The reference covers endpoints, pagination and exact amounts.',
    link: { href: '/docs', label: 'API documentation' },
  },
];

export function buildHomeFaqJsonLd(baseUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${baseUrl}/#faq`,
    url: `${baseUrl}/`,
    isPartOf: { '@id': `${baseUrl}/#website` },
    mainEntity: HOME_FAQ.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
