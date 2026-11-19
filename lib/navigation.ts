/**
 * Shared, network-aware navigation for the masthead and footer.
 *
 * The masthead is a shortlist grouped by topic, never by format: at most four
 * menus, and a menu with more than six links splits into labelled groups. The
 * footer is the full sitemap, so a page that leaves the masthead (`footerOnly`)
 * keeps a crawlable link on every page.
 */
export type NavigationNetwork = 'mainnet' | 'testnet' | 'crosslink';
export interface NavigationItem {
  href: string;
  label: string;
  desc: string;
  networks?: readonly NavigationNetwork[];
  /** Listed in the footer sitemap only. */
  footerOnly?: boolean;
  /** Sub-heading inside the menu panel, and the footer column it sits in. */
  group?: string;
  /** Masthead destination that stays current while this footer-only page is open. */
  parent?: string;
  /** Footer-only page the masthead still lists, as a small link under its parent. */
  nested?: boolean;
  /** Listed on its parent's hub page only: kept out of the footer as well as the masthead. */
  hubOnly?: boolean;
}
export interface NavigationCategory {
  id: string;
  label: string;
  items: NavigationItem[];
}
export interface NavigationGroup {
  label?: string;
  items: NavigationItem[];
}
/** Separate site for lookups that do not reveal what was looked up. Mainnet only. */
export const PRIVATE_EXPLORER_URL = 'https://private.zecblock.com';
const standard = ['mainnet', 'testnet'] as const;
const mainnet = ['mainnet'] as const;
const crosslink = ['crosslink'] as const;

const categories: NavigationCategory[] = [
  // Menu labels are one word each (owner's rule). This one holds the records a visitor looks up or browses.
  { id: 'explorer', label: 'Explorer', items: [
    { href: '/blocks', label: 'Blocks', desc: 'Recent blocks and details' },
    { href: '/txs', label: 'Transactions', desc: 'Confirmed transactions' },
    { href: '/mempool', label: 'Mempool', desc: 'Pending transactions' },
    { href: '/crosschain', label: 'Cross-Chain Swaps', desc: 'ZEC swaps to and from other chains', networks: mainnet },
    { href: '/rich-list', label: 'Top Addresses', desc: 'Transparent balance rankings', networks: standard },
    { href: '/chain', label: 'Chain View', desc: 'Blocks and finality', networks: crosslink },
  ] },
  { id: 'privacy', label: 'Privacy', items: [
    { href: '/pools', label: 'Shielded Pools', desc: 'Balances, history and flows', networks: standard },
    { href: '/ironwood', label: 'Ironwood', desc: 'Adoption and migration', networks: standard },
    { href: '/privacy', label: 'Privacy Score', desc: 'Index of shielded usage', networks: standard },
    { href: '/privacy-risks', label: 'Privacy Risks', desc: 'Amount and timing patterns', networks: standard },
    { href: '/turnstile', label: 'Turnstile Tracker', desc: 'Where deshielded ZEC goes', networks: standard, footerOnly: true, nested: true, parent: '/pools' },
    { href: '/privacy/wallets', label: 'Wallet Signals', desc: 'Observable wallet patterns', networks: standard, footerOnly: true, nested: true, parent: '/privacy-risks' },
  ] },
  { id: 'network', label: 'Network', items: [
    { href: '/network', label: 'Network Overview', desc: 'Supply, halving, fees and activity', group: 'Live network' },
    { href: '/network/nodes', label: 'Nodes', desc: 'Node map, peers and software', group: 'Live network' },
    { href: '/validators', label: 'Validators', desc: 'Finalizers and staking information', networks: crosslink, group: 'Live network' },
    { href: '/bootstrap', label: 'Node Bootstrap', desc: 'Snapshots and node setup', networks: crosslink, group: 'Live network' },
    // Orphans are a mining outcome and block time drives them, so these three sit together.
    { href: '/mining', label: 'Mining', desc: 'Hashrate, pools and rewards', networks: standard, group: 'Mining & forks' },
    { href: '/zodl', label: 'Miner ZODL', desc: 'Rewards held and moved', networks: mainnet, footerOnly: true, nested: true, parent: '/mining', group: 'Mining & forks' },
    { href: '/reorgs', label: 'Forks & Reorgs', desc: 'Orphaned blocks and reorganizations', group: 'Mining & forks' },
    { href: '/network/block-speed', label: 'Block Speed', desc: 'Daily block times and confirmations', networks: standard, group: 'Mining & forks' },
    { href: '/fork-monitor', label: 'Fork Monitor', desc: 'Forks across monitored nodes', networks: crosslink, group: 'Mining & forks' },
    { href: '/network/upgrades', label: 'Upgrades', desc: 'Activation history and upcoming changes', networks: standard, group: 'Protocol' },
    { href: '/governance', label: 'Governance', desc: 'Votes, schedules and results', networks: mainnet, group: 'Protocol' },
    { href: '/calendar', label: 'Calendar', desc: 'Upgrades, votes and key blocks', networks: mainnet, group: 'Protocol' },
  ] },
  { id: 'resources', label: 'Resources', items: [
    { href: '/charts', label: 'Charts', desc: 'Every chart, by topic', group: 'Analytics' },
    { href: '/cards', label: 'Data Cards', desc: 'Live images to post or embed', networks: standard, group: 'Analytics' },
    { href: '/valuation', label: 'Price & Valuation', desc: 'Price and modeled metrics', networks: standard, group: 'Analytics' },
    { href: '/zift', label: 'Zift', desc: 'Ask questions, run SQL, build dashboards', networks: mainnet, group: 'Analytics' },
    { href: '/pulse', label: 'Network Pulse', desc: 'Unusual network activity', networks: standard, footerOnly: true, nested: true, parent: '/charts', group: 'Analytics' },
    { href: '/usage-clock', label: 'Usage Clock', desc: 'Timing and regional patterns', networks: mainnet, footerOnly: true, nested: true, parent: '/charts', group: 'Analytics' },
    { href: '/docs', label: 'API Docs', desc: 'Endpoints and response formats', group: 'Developers' },
    { href: '/tools', label: 'Tools', desc: 'Decode, broadcast, decrypt and more', group: 'Developers' },
    { href: '/tools/decode', label: 'Decode Transaction', desc: 'Inspect raw transaction fields', footerOnly: true, hubOnly: true, parent: '/tools', group: 'Developers' },
    { href: '/tools/broadcast', label: 'Broadcast Transaction', desc: 'Submit a signed transaction', footerOnly: true, hubOnly: true, parent: '/tools', group: 'Developers' },
    { href: '/decrypt', label: 'Decrypt Memo', desc: 'Memos via your viewing key', footerOnly: true, hubOnly: true, parent: '/tools', group: 'Developers' },
    { href: PRIVATE_EXPLORER_URL, label: 'Private Explorer ↗', desc: 'Look up without revealing what', networks: mainnet, footerOnly: true, hubOnly: true, parent: '/tools', group: 'Developers' },
    { href: '/tools/blend-check', label: 'Blend Check', desc: 'Compare public flow amounts', footerOnly: true, hubOnly: true, parent: '/tools', group: 'Developers' },
    { href: '/tools/block-time-simulator', label: 'Block Time Simulator', desc: 'Compare block speeds', footerOnly: true, hubOnly: true, parent: '/tools', group: 'Developers' },
    { href: '/tools/unit-converter', label: 'Unit Converter', desc: 'Coins and zatoshis', footerOnly: true, hubOnly: true, parent: '/tools', group: 'Developers' },
    { href: '/tools/anchor-search', label: 'Anchor Root Search', desc: 'Find commitment tree roots', footerOnly: true, hubOnly: true, parent: '/tools', group: 'Developers' },
    { href: '/learn', label: 'Learn Zcash', desc: 'Wallets, privacy and resources', group: 'Learn' },
    { href: '/learn/crosslink', label: 'Learn Crosslink', desc: 'Finality and staking', networks: crosslink, group: 'Learn' },
    { href: '/newsletter', label: 'Newsletter', desc: 'Zcash updates and analysis', group: 'Learn' },
    { href: '/about', label: 'About', desc: 'Purpose and team', footerOnly: true, group: 'Learn' },
    { href: '/press', label: 'Press & Brand', desc: 'Brand assets and media resources', footerOnly: true, group: 'Learn' },
  ] },
];

export function getNavigation(network: NavigationNetwork, surface: 'header' | 'footer' = 'header'): NavigationCategory[] {
  return categories.map(category => ({
    ...category,
    items: category.items.filter(item => (!item.networks || item.networks.includes(network)) && (surface === 'footer' || !item.footerOnly)),
  })).filter(category => category.items.length > 0);
}

/** Split a menu into its labelled groups, in listed order. A menu with one group has no sub-headings. */
export function groupNavigationItems(items: NavigationItem[]): NavigationGroup[] {
  const groups: NavigationGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.label === item.group) last.items.push(item);
    else groups.push({ label: item.group, items: [item] });
  }
  return groups.length > 1 ? groups : [{ items }];
}

/** Footer-only pages the masthead keeps one click away, keyed by the destination they sit under. */
export function getNestedNavigation(network: NavigationNetwork): Record<string, NavigationItem[]> {
  const nested: Record<string, NavigationItem[]> = {};
  for (const item of getNavigation(network, 'footer').flatMap(category => category.items)) {
    if (!item.nested || !item.parent) continue;
    nested[item.parent] = [...(nested[item.parent] || []), item];
  }
  return nested;
}

export interface FooterColumn {
  id: string;
  label: string;
  items: NavigationItem[];
}
export interface NestedNavigationItem {
  item: NavigationItem;
  children: NavigationItem[];
}

/** A footer column holds at most this many links; a longer menu shows one column per group instead. */
export const FOOTER_COLUMN_MAX = 10;

/**
 * Footer sitemap columns, in menu order. A menu is one column under its own name, so the
 * footer reads like the masthead. Only a menu too long for one column splits into its groups.
 */
export function getFooterColumns(network: NavigationNetwork): FooterColumn[] {
  return getNavigation(network, 'footer').flatMap(category => {
    // A hub page lists its own pages, so the footer links the hub once.
    const items = category.items.filter(item => !item.hubOnly);
    if (items.length <= FOOTER_COLUMN_MAX) return [{ id: category.id, label: category.label, items }];
    return groupNavigationItems(items).map(group => ({
      id: `${category.id}-${group.label ?? 'all'}`,
      label: group.label ?? category.label,
      items: group.items,
    }));
  });
}

/** A column's own links, each followed by the pages reached from it, so the footer can indent them. */
export function nestNavigationItems(items: NavigationItem[]): NestedNavigationItem[] {
  const hrefs = new Set(items.map(item => item.href));
  const isChild = (item: NavigationItem) => item.parent !== undefined && hrefs.has(item.parent);
  return items.filter(item => !isChild(item)).map(item => ({
    item,
    children: items.filter(child => child.parent === item.href),
  }));
}

/** Match the deepest listed destination, so child pages do not mark two links current. */
export function getActiveNavigationHref(pathname: string | null, navigation: NavigationCategory[]): string | undefined {
  if (!pathname) return undefined;
  const path = pathname.replace(/\/$/, '') || '/';
  return navigation.flatMap(category => category.items)
    .filter(item => path === item.href || path.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

/** Masthead link to mark current: a footer-only page lights the destination it is reached from. */
export function getHeaderActiveHref(pathname: string | null, network: NavigationNetwork): string | undefined {
  const sitemap = getNavigation(network, 'footer');
  const href = getActiveNavigationHref(pathname, sitemap);
  const item = sitemap.flatMap(category => category.items).find(candidate => candidate.href === href);
  return item?.footerOnly ? item.parent : href;
}
