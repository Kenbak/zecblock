/** Shared, network-aware navigation for the masthead and footer. */
export type NavigationNetwork = 'mainnet' | 'testnet' | 'crosslink';
export interface NavigationItem {
  href: string;
  label: string;
  desc: string;
  networks?: readonly NavigationNetwork[];
  footerOnly?: boolean;
}
export interface NavigationCategory {
  id: string;
  label: string;
  items: NavigationItem[];
}
const standard = ['mainnet', 'testnet'] as const;
const mainnet = ['mainnet'] as const;
const crosslink = ['crosslink'] as const;

const categories: NavigationCategory[] = [
  { id: 'explore', label: 'Explore', items: [
    { href: '/blocks', label: 'Blocks', desc: 'Recent blocks and details' },
    { href: '/txs', label: 'Transactions', desc: 'Confirmed transactions' },
    { href: '/mempool', label: 'Mempool', desc: 'Pending transactions' },
    { href: '/network', label: 'Network', desc: 'Protocol, issuance and activity' },
    { href: '/network/upgrades', label: 'Network Upgrades', desc: 'Activation history and upcoming changes', networks: standard },
    { href: '/network/block-speed', label: 'Block Speed', desc: 'Daily block times and confirmations', networks: standard },
    { href: '/network/nodes', label: 'Network Nodes', desc: 'Node map, peers and software' },
    { href: '/charts', label: 'Charts', desc: 'Browse and share charts' },
    { href: '/mining', label: 'Mining', desc: 'Hashrate, pools and rewards', networks: standard },
    { href: '/rich-list', label: 'Top Addresses', desc: 'Transparent balance rankings', networks: standard },
    { href: '/chain', label: 'Chain View', desc: 'Blocks and finality', networks: crosslink },
    { href: '/validators', label: 'Validators', desc: 'Finalizers and staking information', networks: crosslink },
    { href: '/bootstrap', label: 'Node Bootstrap', desc: 'Snapshots and node setup', networks: crosslink },
    { href: '/reorgs', label: 'Forks & Reorgs', desc: 'Reorganizations and orphans' },
    { href: '/fork-monitor', label: 'Fork Monitor', desc: 'Forks across monitored nodes', networks: crosslink },
  ] },
  { id: 'analytics', label: 'Analytics', items: [
    { href: '/zift', label: 'Zift', desc: 'Ask questions, run SQL, build dashboards', networks: mainnet },
    { href: '/privacy', label: 'Privacy Score', desc: 'Index of shielded usage', networks: standard },
    { href: '/pools', label: 'Shielded Pools', desc: 'Balances, history and flows', networks: standard },
    { href: '/ironwood', label: 'Ironwood', desc: 'Adoption and migration', networks: standard },
    { href: '/turnstile', label: 'Turnstile Tracker', desc: 'Public flows after deshielding', networks: standard },
    { href: '/privacy-risks', label: 'Privacy Risk Analysis', desc: 'Amount and timing patterns', networks: standard },
    { href: '/privacy/wallets', label: 'Wallet Signals', desc: 'Observable wallet patterns', networks: standard },
    { href: '/valuation', label: 'Valuation', desc: 'Price and modeled metrics', networks: standard },
    { href: '/pulse', label: 'Network Pulse', desc: 'Unusual network activity', networks: standard },
    { href: '/zodl', label: 'Miner ZODL', desc: 'Rewards held and moved', networks: mainnet },
    { href: '/usage-clock', label: 'Usage Clock', desc: 'Timing and regional patterns', networks: mainnet },
    { href: '/crosschain', label: 'Cross-Chain Swaps', desc: 'ZEC swaps via NEAR Intents', networks: mainnet },
    { href: '/governance', label: 'Governance', desc: 'Votes, schedules and results', networks: mainnet },
  ] },
  { id: 'tools', label: 'Tools', items: [
    { href: '/tools', label: 'Developer Tools', desc: 'Transaction and wallet utilities' },
    { href: '/tools/decode', label: 'Decode Transaction', desc: 'Inspect raw transaction fields' },
    { href: '/tools/broadcast', label: 'Broadcast Transaction', desc: 'Submit a signed transaction' },
    { href: '/decrypt', label: 'Decrypt Memo', desc: 'Memos via your viewing key' },
    { href: '/tools/blend-check', label: 'Blend Check', desc: 'Compare public flow amounts' },
    { href: '/tools/unit-converter', label: 'Unit Converter', desc: 'Coins and zatoshis' },
    { href: '/tools/anchor-search', label: 'Anchor Root Search', desc: 'Find commitment tree roots' },
    { href: '/docs', label: 'API Docs', desc: 'Endpoints and response formats' },
  ] },
  { id: 'resources', label: 'Resources', items: [
    { href: '/learn', label: 'Learn Zcash', desc: 'Wallets, privacy and resources' },
    { href: '/learn/crosslink', label: 'Learn Crosslink', desc: 'Finality and staking', networks: crosslink },
    { href: '/newsletter', label: 'Newsletter', desc: 'Zcash updates and analysis' },
    { href: '/about', label: 'About', desc: 'Purpose and team' },
    { href: '/press', label: 'Press & Brand', desc: 'Brand assets and media resources', footerOnly: true },
  ] },
];

export function getNavigation(network: NavigationNetwork, surface: 'header' | 'footer' = 'header'): NavigationCategory[] {
  return categories.map(category => ({
    ...category,
    items: category.items.filter(item => (!item.networks || item.networks.includes(network)) && (surface === 'footer' || !item.footerOnly)),
  })).filter(category => category.items.length > 0);
}

/** Match the deepest listed destination, so child pages do not mark two links current. */
export function getActiveNavigationHref(pathname: string | null, navigation: NavigationCategory[]): string | undefined {
  if (!pathname) return undefined;
  const path = pathname.replace(/\/$/, '') || '/';
  return navigation.flatMap(category => category.items)
    .filter(item => path === item.href || path.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}
