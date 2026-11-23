// "About this explorer" copy for the bottom of the homepage, per network.
// Plain data so the homepage section and the homepage's Markdown version
// (/index.md, see lib/llms/docs.ts) render the same text. Every statement must
// stay true of the site: check the linked page before editing a claim.

export type AboutPart = string | { href: string; text: string };

export interface AboutItem {
  question: string;
  answer: AboutPart[];
}

export interface HomeAbout {
  heading: string;
  intro: AboutPart[];
  items: AboutItem[];
}

const MAINNET: HomeAbout = {
  heading: 'About this Zcash explorer',
  intro: [
    'ZecBlock is a free, open-source Zcash block explorer. Search the Zcash blockchain for any block, transaction or transparent address, follow the mempool live, and see what the chain reveals about privacy: shielded pool balances, the share of shielded transactions, and public flows into and out of the pools.',
  ],
  items: [
    {
      question: 'How do I check a Zcash transaction?',
      answer: ['Paste its transaction ID (txid) into the search box. The page shows whether it is pending or confirmed, its block, confirmations, fee, size and public inputs and outputs.'],
    },
    {
      question: 'Are Zcash transactions private? Can they be traced?',
      answer: [
        'Zcash has transparent and shielded transactions. Transparent transactions are public, like Bitcoin. Shielded transactions encrypt the sender, receiver, amount and memo, so no explorer can show them. ZecBlock shows which shielded pools a transaction used and the amounts that publicly enter or leave them. Its ',
        { href: '/privacy', text: 'privacy pages' },
        ' explain where public patterns can still link activity.',
      ],
    },
    {
      question: 'Can I look up a shielded address?',
      answer: ['A shielded address doesn’t reveal its balance or history. You can look up transparent addresses, and the transparent part of a unified address.'],
    },
    {
      question: 'Can I read my shielded memos?',
      answer: [
        'Yes. Paste your viewing key into the ',
        { href: '/decrypt', text: 'memo decryption tool' },
        ' to read Orchard and Ironwood memos. Your key is processed in your browser and is never sent to our servers.',
      ],
    },
    {
      question: 'Is ZecBlock private to use?',
      answer: ['No account and no ads. Analytics count visits to a few public pages only, skip individual address, transaction and block pages, and respect Do Not Track.'],
    },
    {
      question: 'Is there a Zcash explorer API?',
      answer: [
        'Yes: a free ',
        { href: '/docs', text: 'public API' },
        ' and an ',
        { href: '/docs/mcp', text: 'MCP server' },
        ' for AI assistants. A ',
        { href: 'https://testnet.zecblock.com/', text: 'Zcash testnet explorer' },
        ' for TAZ is also available.',
      ],
    },
  ],
};

const TESTNET: HomeAbout = {
  heading: 'About this Zcash testnet explorer',
  intro: [
    'ZecBlock’s Zcash testnet explorer covers TAZ, the coin of the Zcash test network. Search testnet blocks, transactions and addresses, follow pending transactions, and check that a test payment works before you send ZEC on mainnet.',
  ],
  items: [
    {
      question: 'What is TAZ?',
      answer: ['TAZ is the testnet version of ZEC. It has no value and exists for testing wallets, apps and network upgrades.'],
    },
    {
      question: 'How do I check a testnet transaction?',
      answer: ['Paste its transaction ID (txid) into the search box. The page shows whether it is pending or confirmed, its block, confirmations, fee, size and public inputs and outputs.'],
    },
    {
      question: 'Which testnet addresses can I look up?',
      answer: ['Transparent testnet addresses (starting tm or t2) show their public balance and history. Shielded testnet addresses (utest1, ztestsapling) don’t reveal their balance or history.'],
    },
    {
      question: 'Can I decode or broadcast a testnet transaction?',
      answer: [
        'Yes. ',
        { href: '/tools/decode', text: 'Decode' },
        ' raw transaction hex without sending it, or ',
        { href: '/tools/broadcast', text: 'broadcast' },
        ' a fully signed raw transaction.',
      ],
    },
    {
      question: 'Is there a Zcash testnet API?',
      answer: [
        'Yes: a free ',
        { href: '/docs', text: 'testnet API' },
        ' and an ',
        { href: '/docs/mcp', text: 'MCP server' },
        ' for AI assistants. For real ZEC, use the ',
        { href: 'https://zecblock.com/', text: 'Zcash mainnet explorer' },
        '.',
      ],
    },
  ],
};

/** Copy for the network's homepage; Crosslink has none (its homepage is noindex). */
export function getHomeAbout(network: string): HomeAbout | null {
  if (network === 'mainnet') return MAINNET;
  if (network === 'testnet') return TESTNET;
  return null;
}

export function aboutPartsText(parts: AboutPart[]): string {
  return parts.map(part => (typeof part === 'string' ? part : part.text)).join('');
}

/** Markdown for llms.txt documents, with absolute links on the given site. */
export function homeAboutMarkdown(about: HomeAbout, siteUrl: string): string {
  const md = (parts: AboutPart[]) => parts.map(part => (typeof part === 'string'
    ? part
    : `[${part.text}](${part.href.startsWith('http') ? part.href : `${siteUrl}${part.href}`})`)).join('');
  return [
    `## ${about.heading}`,
    '',
    md(about.intro),
    ...about.items.flatMap(item => ['', `### ${item.question}`, '', md(item.answer)]),
  ].join('\n');
}
