/**
 * Search over the site's own pages, page sections and charts, so typing "mining" or
 * "shielded pool" in the search box offers the page, not only addresses and names.
 *
 * No React and no browser APIs: tests run it directly, and the search box loads it on
 * first use so the chart list stays out of the first page load.
 */
import { CHART_CATALOG } from './chart-catalog';
import { getNavigation, PRIVATE_EXPLORER_URL, type NavigationNetwork } from './navigation';

export type SiteResultKind = 'Page' | 'Section' | 'Chart';
export interface SiteResult {
  kind: SiteResultKind;
  href: string;
  label: string;
  desc: string;
  /** The menu a page sits in, or the page a section or chart belongs to. */
  context: string;
  external: boolean;
}
export interface SiteMatch extends SiteResult {
  score: number;
  /** Every word of the query is one of this entry's own words; safe to open on Enter. */
  strong: boolean;
}

/**
 * Other things people type for a page. A whole phrase typed exactly counts like the
 * page's own name ("block time" opens Block Speed); its words also match one by one.
 * Plain vocabulary only: nothing here claims more than the page's name does.
 */
const ALIASES: Record<string, string[]> = {
  '/blocks': ['latest blocks', 'height'],
  '/txs': ['tx', 'txs', 'latest transactions'],
  '/mempool': ['unconfirmed', 'queue'],
  '/crosschain': ['swap', 'bridge', 'crosschain'],
  '/rich-list': ['rich list', 'richlist', 'whales', 'holders', 'balances'],
  '/reorgs': ['orphan', 'orphaned', 'reorg', 'reorganization', 'competing', 'stale', 'fork'],
  '/chain': ['finalized'],
  '/fork-monitor': ['tips'],
  '/pools': ['pool stats', 'shielded pool stats', 'shielded supply', 'statistics', 'sapling', 'orchard', 'sprout', 'balance'],
  '/turnstile': ['deshield', 'deshielded', 'unshield', 'unshielded'],
  '/ironwood': ['upgrade', 'quantum'],
  '/privacy': ['index', 'usage'],
  '/privacy-risks': ['linkability', 'heuristics'],
  '/privacy/wallets': ['fingerprint'],
  '/network': ['network stats', 'statistics', 'issuance'],
  '/network/nodes': ['node', 'zebra', 'zcashd'],
  '/validators': ['finalizer', 'stake'],
  '/bootstrap': ['sync'],
  '/mining': ['miner', 'miners', 'difficulty'],
  '/zodl': ['hodl', 'selling'],
  '/network/block-speed': ['block time', 'blocktime', 'block interval'],
  '/network/upgrades': ['upgrade', 'network upgrade', 'nu5', 'nu6', 'nu7'],
  '/governance': ['vote', 'voting', 'poll', 'polls', 'zip', 'miner poll', 'nu7.1'],
  '/calendar': ['events', 'dates'],
  '/charts': ['chart', 'graph', 'graphs'],
  '/cards': ['card', 'share image', 'embed'],
  '/valuation': ['usd', 'market cap', 'btc'],
  '/zift': ['ask', 'ai', 'assistant', 'query'],
  '/pulse': ['anomaly', 'anomalies', 'alerts'],
  '/usage-clock': ['hours', 'timezone'],
  '/docs': ['api', 'rest', 'openapi', 'developer'],
  '/tools': ['tool', 'utilities'],
  '/tools/decode': ['decoder', 'raw hex'],
  '/tools/broadcast': ['send', 'push'],
  '/decrypt': ['memo', 'viewing key', 'ufvk'],
  [PRIVATE_EXPLORER_URL]: ['private search', 'pir', 'hidden'],
  '/tools/blend-check': ['amount'],
  '/tools/block-time-simulator': ['simulate'],
  '/tools/unit-converter': ['zatoshi', 'zat', 'convert', 'units'],
  '/tools/anchor-search': ['commitment tree'],
  '/learn': ['guide', 'beginners'],
  '/learn/crosslink': ['guide'],
  '/newsletter': ['news', 'email'],
  '/about': ['team', 'who'],
  '/press': ['logo', 'kit', 'media'],
};

interface Section {
  href: string;
  label: string;
  desc: string;
  /** Label of the page the section is on; also where it is listed in results. */
  page: string;
  aliases: string[];
  networks: readonly NavigationNetwork[];
}
const standard = ['mainnet', 'testnet'] as const;
const mainnet = ['mainnet'] as const;

/**
 * Destinations that are part of a page, not a page of their own. Each must point at a
 * real route and, when it has a hash, a real id on that page (see site-search.test.js).
 */
export const SITE_SECTIONS: readonly Section[] = [
  { href: '/network#issuance', label: 'Supply & Halving', desc: 'Issuance per block and the halving schedule', page: 'Network Overview', aliases: ['halvening', 'subsidy', 'emission', 'inflation', 'block reward'], networks: standard },
  { href: '/network#network-fees', label: 'Transaction Fees', desc: 'Daily median and range of observed fees', page: 'Network Overview', aliases: ['fee', 'fees', 'cost'], networks: standard },
  { href: '/mining#metrics', label: 'Hashrate', desc: 'Estimated network hashrate and difficulty', page: 'Mining', aliases: ['hash rate', 'solrate', 'network hashrate'], networks: standard },
  { href: '/mining#distribution', label: 'Mining Pools', desc: 'Share of blocks by mining pool', page: 'Mining', aliases: ['pool share', 'pool distribution'], networks: standard },
  { href: '/mining#orphans', label: 'Orphan Rate', desc: 'How often a block loses the race to a competing block', page: 'Mining', aliases: ['orphans', 'stale'], networks: standard },
  { href: '/pools#flows', label: 'Shielding Flows', desc: 'Public value entering and leaving shielded pools', page: 'Shielded Pools', aliases: ['shield', 'deshield', 'inflow', 'outflow', 'net flow'], networks: standard },
  { href: '/txs?view=activity', label: 'Daily Activity', desc: 'Transactions per day and the share that is shielded', page: 'Transactions', aliases: ['shielded rate', 'shielded share', 'shielded percentage', 'shielded tx share', 'transaction volume', 'daily transactions', 'tx count'], networks: standard },
  { href: '/txs?type=shielded', label: 'Shielded Transactions', desc: 'Public shielding flows and shielded activity', page: 'Transactions', aliases: ['shielded tx', 'shielded txs'], networks: standard },
  { href: '/docs/mcp', label: 'MCP Server', desc: 'Give an AI assistant access to public Zcash data', page: 'API Docs', aliases: ['mcp', 'ai agent', 'model context protocol'], networks: mainnet },
];

/** Words too common to tell one page from another. Dropped unless the query is only these. */
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'and', 'is', 'are', 'do', 'i', 'my', 'can', 'what', 'where', 'how', 'much', 'many', 'show', 'me', 'find', 'see', 'page', 'zcash', 'zec']);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Singular and plural compare equal ("pools" finds "pool"). */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}
function words(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean).map(stem);
}

interface IndexEntry {
  result: SiteResult;
  /** The label and each alias, as stemmed text, for whole-phrase comparison. */
  labelText: string;
  aliasTexts: string[];
  labelWords: string[];
  aliasWords: string[];
  descWords: string[];
  order: number;
}
// A page outranks a section, and both outrank a chart, when the words match equally well.
const KIND_BONUS: Record<SiteResultKind, number> = { Page: 4, Section: 3, Chart: 0 };

function buildIndex(network: NavigationNetwork): IndexEntry[] {
  const results: (SiteResult & { aliases: string[] })[] = [];
  for (const category of getNavigation(network, 'footer')) {
    for (const item of category.items) {
      results.push({
        kind: 'Page', href: item.href, label: item.label.replace(/\s*↗$/, ''), desc: item.desc,
        context: category.label, external: /^https:\/\//.test(item.href), aliases: ALIASES[item.href] ?? [],
      });
    }
  }
  for (const section of SITE_SECTIONS) {
    if (!section.networks.includes(network)) continue;
    results.push({ kind: 'Section', href: section.href, label: section.label, desc: section.desc, context: section.page, external: false, aliases: section.aliases });
  }
  // Chart pages are published for mainnet only.
  if (network === 'mainnet') {
    for (const chart of CHART_CATALOG) {
      results.push({ kind: 'Chart', href: `/charts/${chart.id}`, label: chart.title, desc: chart.description, context: chart.category, external: false, aliases: [] });
    }
  }
  return results.map(({ aliases, ...result }, order) => ({
    result,
    labelText: words(result.label).join(' '),
    aliasTexts: aliases.map(alias => words(alias).join(' ')),
    labelWords: words(result.label),
    aliasWords: aliases.flatMap(words),
    descWords: words(result.desc),
    order,
  }));
}

const indexes = new Map<NavigationNetwork, IndexEntry[]>();
function indexFor(network: NavigationNetwork): IndexEntry[] {
  let index = indexes.get(network);
  if (!index) indexes.set(network, index = buildIndex(network));
  return index;
}

/** How well one query word matches an entry: its name counts most, its description least. */
function wordScore(word: string, entry: IndexEntry): { score: number; own: boolean } {
  if (entry.labelWords.includes(word)) return { score: 10, own: true };
  if (entry.aliasWords.includes(word)) return { score: 8, own: true };
  if (word.length >= 2 && entry.labelWords.some(candidate => candidate.startsWith(word))) return { score: 7, own: false };
  if (word.length >= 3 && entry.aliasWords.some(candidate => candidate.startsWith(word))) return { score: 4, own: false };
  if (entry.descWords.includes(word)) return { score: 3, own: false };
  if (word.length >= 4 && entry.descWords.some(candidate => candidate.startsWith(word))) return { score: 2, own: false };
  return { score: 0, own: false };
}

/**
 * Pages, sections and charts matching the query, best first.
 * A two-word query needs both words; a longer one may miss a few ("mert shielded pool stats").
 */
export function searchSite(query: string, network: NavigationNetwork, limit = 5): SiteMatch[] {
  if (normalize(query).length < 2) return [];
  const all = words(query);
  const queryText = all.join(' ');
  const meaningful = all.filter(word => !STOP_WORDS.has(word));
  const tokens = meaningful.length > 0 ? meaningful : all;
  const required = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.6);

  const matches: (SiteMatch & { order: number })[] = [];
  for (const entry of indexFor(network)) {
    let total = 0;
    let matched = 0;
    let own = 0;
    for (const token of tokens) {
      const result = wordScore(token, entry);
      total += result.score;
      if (result.score > 0) matched += 1;
      if (result.own) own += 1;
    }
    if (matched < required) continue;
    const kind = entry.result.kind;
    const exact = entry.labelText === queryText || entry.aliasTexts.includes(queryText);
    const prefix = !exact && entry.labelText.startsWith(queryText);
    if (exact) total += 20;
    // A chart title that merely starts with the word is a weaker signal than a page name that does.
    else if (prefix) total += kind === 'Chart' ? 1 : 8;
    matches.push({
      ...entry.result,
      order: entry.order,
      score: total + KIND_BONUS[kind],
      // Typing the start of a name (four letters or more) is as clear as typing all of it.
      strong: exact || own === tokens.length || (prefix && queryText.length >= 4),
    });
  }
  return matches
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(match => ({ kind: match.kind, href: match.href, label: match.label, desc: match.desc, context: match.context, external: match.external, score: match.score, strong: match.strong }));
}

/** The destination to open when the visitor presses Enter, or null to let other lookups run. */
export function bestSiteMatch(query: string, network: NavigationNetwork): SiteMatch | null {
  const [top] = searchSite(query, network, 1);
  return top?.strong ? top : null;
}
