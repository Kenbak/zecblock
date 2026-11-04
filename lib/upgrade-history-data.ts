export type HistoricalUpgradeDefinition = {
  id: string;
  label: string;
  heights: { mainnet: number; testnet: number };
  sourceUrl: string;
  summary: string;
  links: { label: string; href: string }[];
};

/** Deployment ZIPs define the canonical historical activation on each network. */
export const HISTORICAL_UPGRADES: HistoricalUpgradeDefinition[] = [
  {
    id: 'overwinter', label: 'Overwinter',
    heights: { mainnet: 347_500, testnet: 207_500 },
    sourceUrl: 'https://zips.z.cash/zip-0201',
    summary: 'Introduced upgrade-aware transactions and peer rules.',
    links: [],
  },
  {
    id: 'sapling', label: 'Sapling',
    heights: { mainnet: 419_200, testnet: 280_000 },
    sourceUrl: 'https://zips.z.cash/zip-0205',
    summary: 'Introduced the Sapling shielded protocol.',
    links: [{ label: 'Shielded pool balances', href: '/pools#supply' }],
  },
  {
    id: 'blossom', label: 'Blossom',
    heights: { mainnet: 653_600, testnet: 584_000 },
    sourceUrl: 'https://zips.z.cash/zip-0206',
    summary: 'Reduced the block target from 150 to 75 seconds.',
    links: [{ label: 'Block speed & confirmations', href: '/network/block-speed' }],
  },
  {
    id: 'heartwood', label: 'Heartwood',
    heights: { mainnet: 903_000, testnet: 903_800 },
    sourceUrl: 'https://zips.z.cash/zip-0250',
    summary: 'Enabled shielded coinbase and chain-history commitments.',
    links: [],
  },
  {
    id: 'canopy', label: 'Canopy',
    heights: { mainnet: 1_046_400, testnet: 1_028_500 },
    sourceUrl: 'https://zips.z.cash/zip-0251',
    summary: 'Introduced development funding streams and stopped new value entering Sprout.',
    links: [],
  },
  {
    id: 'nu5', label: 'NU5',
    // The first testnet activation at 1,599,200 was rolled back (ZIP 252).
    heights: { mainnet: 1_687_104, testnet: 1_842_420 },
    sourceUrl: 'https://zips.z.cash/zip-0252',
    summary: 'Introduced Orchard and version 5 transactions.',
    links: [
      { label: 'Shielded pool balances', href: '/pools#supply' },
      { label: 'Transaction decoder', href: '/tools/decode' },
    ],
  },
  {
    id: 'nu6', label: 'NU6',
    heights: { mainnet: 2_726_400, testnet: 2_976_000 },
    sourceUrl: 'https://zips.z.cash/zip-0253',
    summary: 'Changed funding rules and introduced the deferred-development lockbox.',
    links: [],
  },
  {
    id: 'nu61', label: 'NU6.1',
    heights: { mainnet: 3_146_400, testnet: 3_536_500 },
    sourceUrl: 'https://zips.z.cash/zip-0255',
    summary: 'Updated community funding and deferred-fund disbursement rules.',
    links: [],
  },
  {
    id: 'nu62', label: 'NU6.2',
    heights: { mainnet: 3_364_600, testnet: 4_052_000 },
    sourceUrl: 'https://zips.z.cash/zip-0257',
    summary: 'Orchard was re-enabled with corrected proof rules.',
    links: [{ label: 'Flows since NU6.2', href: '/turnstile?period=nu6.2' }],
  },
  {
    id: 'nu63', label: 'NU6.3',
    heights: { mainnet: 3_428_143, testnet: 4_134_000 },
    sourceUrl: 'https://zips.z.cash/zip-0258',
    summary: 'Ironwood replaces Orchard for new shielded activity, with a new transaction format and migration path.',
    links: [{ label: 'Ironwood migration tracker', href: '/ironwood' }],
  },
];
