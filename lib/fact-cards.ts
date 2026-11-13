/**
 * Live Zcash fact cards: one fact per image, drawn by /cards/[id]/image.
 * A card is read in a glance: a headline, a caption and at most one short
 * line of context. Builders are pure. A builder returns null when its source has no
 * authoritative value, so the image route answers 503 instead of drawing a
 * zero or a guess.
 */
import { getChainLogoSrc } from './chain-logos';
import { formatUpgradeDuration } from './network-upgrades';
import { getPoolLogoSrc } from './pool-logos';

export type CardNetwork = 'mainnet' | 'testnet';
export type CardColor = 'gold' | 'shielded' | 'transparent' | 'ironwood' | 'orchard' | 'sapling' | 'sprout' | 'shielding' | 'deshielding' | 'purple' | 'muted';

export type CardBar = { value: number; highlight: boolean; projected?: boolean };
/** `logo` is a local public path; the image route inlines it. */
export type CardRow = { label: string; value: number; display: string; color?: CardColor; logo?: string };
export type CardVisual =
  | { kind: 'progress'; percent: number; from: string; to: string }
  | { kind: 'share'; percent: number; label: string }
  | { kind: 'bars'; bars: CardBar[]; unit: string }
  /** Horizontal labelled bars; values are compared, never summed. */
  | { kind: 'ranking'; rows: CardRow[] }
  /** One bar split into parts of a whole. */
  | { kind: 'split'; rows: CardRow[] }
  | null;

export type FactCard = {
  eyebrow: string;
  headline: string;
  caption: string;
  detail: string;
  visual: CardVisual;
  source: string;
};

export const CARD_CATEGORIES = ['Privacy', 'Supply', 'Valuation', 'Network', 'Mining', 'Cross-chain', 'Upgrades'] as const;
export type CardCategory = typeof CARD_CATEGORIES[number];

export type FactCardDef = {
  id: string;
  title: string;
  category: CardCategory;
  /** Search words beyond the title, including plain-language synonyms. */
  tags: string[];
  /** What the card states, for the gallery, alt text and share text. */
  description: string;
  /** The live page a viewer can open to inspect the data. */
  href: string;
  networks: readonly CardNetwork[];
};

const both = ['mainnet', 'testnet'] as const;
const mainnet = ['mainnet'] as const;

export const FACT_CARDS: readonly FactCardDef[] = [
  { id: 'shielded-supply', title: 'Shielded share of supply', category: 'Privacy', networks: both, href: '/pools',
    tags: ['privacy', 'shielded', 'pools', 'ironwood', 'orchard', 'sapling', 'sprout', 'transparent', 'anonymity', 'supply'],
    description: 'How much issued ZEC sits in shielded pools, split by pool.' },
  { id: 'shielded-transactions', title: 'Shielded transaction share', category: 'Privacy', networks: both, href: '/privacy#trends',
    tags: ['privacy', 'shielded', 'transactions', 'adoption', 'usage', 'daily', 'anonymity'],
    description: 'Share of non-coinbase transactions over the last seven complete days that were shielded.' },
  { id: 'net-shielding', title: 'Net shielding', category: 'Privacy', networks: both, href: '/pools#flows',
    tags: ['privacy', 'shielded', 'shielding', 'deshielding', 'unshielding', 'flows', 'net flow', 'pools', 'weekly'],
    description: 'ZEC moved into and out of shielded pools over the last seven complete days, and the net direction.' },
  { id: 'shielded-by-pool', title: 'Transactions by shielded pool', category: 'Privacy', networks: both, href: '/pools#activity',
    tags: ['privacy', 'shielded', 'ironwood', 'orchard', 'sapling', 'sprout', 'pools', 'transactions', 'adoption', 'usage'],
    description: 'How many transactions used each shielded pool over the last seven complete days.' },
  { id: 'issued-supply', title: 'Issued supply', category: 'Supply', networks: both, href: '/pools#supply',
    tags: ['supply', 'issuance', 'cap', '21 million', 'scarcity', 'emission', 'inflation', 'lockbox'],
    description: 'ZEC issued so far against the 21 million cap.' },
  { id: 'halving', title: 'Next halving', category: 'Supply', networks: both, href: '/network#network-accounting',
    tags: ['halving', 'issuance', 'block reward', 'subsidy', 'countdown', 'emission', 'inflation'],
    description: 'Estimated time and blocks until the next block-subsidy halving.' },
  { id: 'dormant-supply', title: 'Dormant transparent supply', category: 'Valuation', networks: mainnet, href: '/valuation#hodl-waves',
    tags: ['holders', 'hodl', 'hodl waves', 'dormant', 'age', 'long-term', 'coins', 'utxo', 'transparent', 'supply'],
    description: 'Share of transparent ZEC that has not moved in over a year, split by coin age.' },
  { id: 'mvrv', title: 'MVRV ratio', category: 'Valuation', networks: mainnet, href: '/valuation#mvrv',
    tags: ['mvrv', 'valuation', 'realized price', 'realized cap', 'cost basis', 'market value', 'price', 'usd'],
    description: 'ZEC’s market price against its realized price, the average price at which coins last moved.' },
  { id: 'chain-height', title: 'Chain height', category: 'Network', networks: both, href: '/blocks',
    tags: ['blocks', 'height', 'chain', 'tip', 'blockchain', 'genesis'],
    description: 'The latest indexed block height.' },
  { id: 'nodes', title: 'Network nodes', category: 'Network', networks: both, href: '/network/nodes',
    tags: ['nodes', 'peers', 'countries', 'decentralization', 'map', 'infrastructure'],
    description: 'Nodes observed by the explorer’s census in the last hour, and where they are.' },
  { id: 'daily-transactions', title: 'Transactions per day', category: 'Network', networks: both, href: '/pools#activity',
    tags: ['transactions', 'usage', 'activity', 'daily', 'throughput', 'demand', 'adoption'],
    description: 'Average daily transactions over the last seven complete days, with four weeks of history.' },
  { id: 'chain-size', title: 'Chain size', category: 'Network', networks: both, href: '/network#chain-size',
    tags: ['chain size', 'disk', 'storage', 'node', 'blockchain', 'growth', 'gib', 'full node'],
    description: 'Disk space the full chain takes on this explorer’s node, and its growth over 30 days.' },
  { id: 'fees', title: 'Median transaction fee', category: 'Network', networks: mainnet, href: '/network#network-fees',
    tags: ['fees', 'cost', 'cheap', 'zip-317', 'payments', 'usd'],
    description: 'The median fee paid on the latest complete day, in ZEC and USD.' },
  { id: 'hashrate', title: 'Network hashrate', category: 'Mining', networks: both, href: '/mining#metrics',
    tags: ['hashrate', 'mining', 'security', 'equihash', 'difficulty'],
    description: 'Estimated mining power on the latest complete day, with four weeks of history.' },
  { id: 'mining-pools', title: 'Blocks by mining pool', category: 'Mining', networks: both, href: '/mining#distribution',
    tags: ['mining', 'pools', 'decentralization', 'miners', 'blocks', 'concentration'],
    description: 'Which pools mined the last seven days of blocks.' },
  { id: 'mining-software', title: 'Blocks by node software', category: 'Mining', networks: both, href: '/mining#software',
    tags: ['mining', 'software', 'zebra', 'zakura', 'zcashd', 'client diversity', 'node', 'blocks', 'coinbase'],
    description: 'Which node software miners tagged in the last seven days of blocks.' },
  { id: 'orphan-rate', title: 'Orphaned block rate', category: 'Mining', networks: both, href: '/mining#orphans',
    tags: ['mining', 'orphans', 'orphaned', 'stale blocks', 'reorgs', 'competing blocks', 'block time'],
    description: 'Share of observed blocks over the last seven complete days that lost the race to another block.' },
  { id: 'swap-venues', title: 'Swap venues compared', category: 'Cross-chain', networks: mainnet, href: '/crosschain',
    tags: ['swaps', 'cross-chain', 'near intents', 'maya', 'thorchain', 'venues', 'dex', 'bridge', 'volume', 'compare'],
    description: 'Observed 30-day ZEC swap volume on NEAR Intents, Maya and THORChain, side by side.' },
  { id: 'swap-sources', title: 'Where swaps into ZEC come from', category: 'Cross-chain', networks: mainnet, href: '/crosschain',
    tags: ['swaps', 'cross-chain', 'near intents', 'bitcoin', 'btc', 'ethereum', 'solana', 'chains', 'inflow', 'buyers', 'source'],
    description: 'The chains that sent the most value into ZEC through NEAR Intents over 30 days.' },
  { id: 'near-intents', title: 'NEAR Intents swaps', category: 'Cross-chain', networks: mainnet, href: '/crosschain',
    tags: ['swaps', 'cross-chain', 'near', 'near intents', 'volume', 'inflow', 'outflow'],
    description: 'Observed 30-day ZEC swap volume through NEAR Intents, into and out of ZEC.' },
  { id: 'maya', title: 'Maya swaps', category: 'Cross-chain', networks: mainnet, href: '/crosschain',
    tags: ['swaps', 'cross-chain', 'maya', 'mayachain', 'cacao', 'volume', 'inflow', 'outflow'],
    description: 'Observed 30-day native ZEC swap volume on Maya, into and out of ZEC.' },
  { id: 'thorchain', title: 'THORChain swaps', category: 'Cross-chain', networks: mainnet, href: '/crosschain',
    tags: ['swaps', 'cross-chain', 'thorchain', 'thor', 'rune', 'volume', 'inflow', 'outflow'],
    description: 'Observed 30-day native ZEC swap volume on THORChain, into and out of ZEC.' },
  { id: 'nu7-countdown', title: 'NU7 countdown', category: 'Upgrades', networks: both, href: '/network/upgrades#nu7',
    tags: ['nu7', 'upgrade', 'countdown', 'activation', 'hard fork'],
    description: 'Time and blocks until the NU7 network upgrade, or its activation block once live.' },
  { id: 'nu7-blocks', title: 'NU7 blocks per day', category: 'Upgrades', networks: both, href: '/network/block-speed',
    tags: ['nu7', 'block time', 'faster blocks', '25 seconds', 'speed'],
    description: 'Blocks per day before and with NU7’s 25-second target.' },
  { id: 'nu7-nsm', title: 'NSM reserve', category: 'Upgrades', networks: both, href: '/network#nu7-accounting',
    tags: ['nu7', 'nsm', 'sustainability', 'reserve', 'fees', 'burn'],
    description: 'Network Sustainability Mechanism reserve growth since NU7.' },
  { id: 'nu7-readiness', title: 'NU7 node readiness', category: 'Upgrades', networks: both, href: '/network/nodes',
    tags: ['nu7', 'nodes', 'readiness', 'upgrade', 'protocol'],
    description: 'Share of observed nodes advertising the NU7 protocol.' },
];

export const findFactCard = (id: string) => FACT_CARDS.find(card => card.id === id);

export function factCardsFor(network: string): FactCardDef[] {
  return FACT_CARDS.filter(card => (card.networks as readonly string[]).includes(network));
}

/** Case-insensitive match on every word against title, category, tags and description. */
export function searchFactCards(cards: readonly FactCardDef[], query: string, category: string): FactCardDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter(card => {
    if (category !== 'All' && card.category !== category) return false;
    const text = `${card.title} ${card.category} ${card.tags.join(' ')} ${card.description}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}

// ---------------------------------------------------------------------------
// Formatting. Monetary inputs stay integer zatoshis until display.

const ZAT = BigInt(100_000_000);
const count = (value: number) => Math.round(value).toLocaleString('en-US');
const currency = (network: CardNetwork) => network === 'mainnet' ? 'ZEC' : 'TAZ';
const chainLabel = (network: CardNetwork) => network === 'mainnet' ? 'Zcash mainnet' : 'Zcash testnet';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Integer zatoshis from a safe integer number or a decimal string; anything else is unknown. */
export function toZat(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Whole coins, rounded half up, with thousands separators. */
export function formatWholeCoins(zat: bigint, unit: string): string {
  const negative = zat < BigInt(0);
  const abs = negative ? -zat : zat;
  const whole = (abs + ZAT / BigInt(2)) / ZAT;
  return `${negative ? '−' : ''}${whole.toLocaleString('en-US')} ${unit}`;
}

/** Exact coin amount with trailing zeros removed. */
export function formatExactCoins(zat: bigint, unit: string): string {
  const negative = zat < BigInt(0);
  const abs = negative ? -zat : zat;
  const fraction = String(abs % ZAT).padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '−' : ''}${(abs / ZAT).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''} ${unit}`;
}

/** Ratio of two zatoshi amounts, as a percentage with two decimals of precision. */
const zatPercent = (part: bigint, whole: bigint) => whole > BigInt(0) ? Number(part * BigInt(1_000_000) / whole) / 10_000 : null;

export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `$${(value / 1e3).toFixed(0)}K`;
  if (abs >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  return `$${value.toPrecision(2)}`;
}

/** Whole coins from an API amount already expressed in coins. */
const coinsToZat = (coins: number) => BigInt(Math.round(coins * 1e8));
const percentOf = (part: number, whole: number) => `${(part / whole * 100).toFixed(1)}%`;

/** The last `n` UTC days before today, only when they are consecutive and all present. */
function closedDays<T extends { date: string }>(rows: T[], n: number, now: Date): T[] | null {
  const today = now.toISOString().slice(0, 10);
  const closed = rows.filter(row => row.date < today).sort((a, b) => a.date.localeCompare(b.date));
  const window = closed.slice(-n);
  if (window.length < n) return null;
  const span = (Date.parse(`${window.at(-1)!.date}T00:00:00Z`) - Date.parse(`${window[0].date}T00:00:00Z`)) / 86_400_000;
  // A gap, or a window that ended days ago, would misstate "the last n days".
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${window.at(-1)!.date}T00:00:00Z`)) / 86_400_000;
  return span === n - 1 && age <= 2 ? window : null;
}

const formatDay = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const shortDay = (iso: string, withMonth = true) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', withMonth ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { day: 'numeric', timeZone: 'UTC' });
/** "Nov 6–12" within a month, "Oct 28 – Nov 3" across two. UTC days. */
export const formatDayRange = (from: string, to: string) => from.slice(0, 7) === to.slice(0, 7) ? `${shortDay(from)}–${shortDay(to, false)}` : `${shortDay(from)} – ${shortDay(to)}`;

/** Unwrap a v1 `{ data }` envelope; a legacy body is returned as is. */
export function unwrap(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (payload.success === false) return null;
  return isRecord(payload.data) ? payload.data : payload;
}

// ---------------------------------------------------------------------------
// Builders

const POOLS = [
  { key: 'ironwood', label: 'Ironwood', color: 'ironwood' },
  { key: 'orchard', label: 'Orchard', color: 'orchard' },
  { key: 'sapling', label: 'Sapling', color: 'sapling' },
  { key: 'sprout', label: 'Sprout', color: 'sprout' },
] as const;

/** /v1/shielded-pools/overview: current balances in integer zatoshis. */
export function shieldedSupplyCard(network: CardNetwork, payload: unknown): FactCard | null {
  const current = unwrap(payload)?.current;
  if (!isRecord(current)) return null;
  const shielded = toZat(current.shielded);
  const transparent = toZat(current.transparent);
  const supply = toZat(current.chainSupply);
  if (shielded == null || transparent == null || supply == null || supply <= BigInt(0)) return null;
  const percent = zatPercent(shielded, supply);
  if (percent == null) return null;
  const unit = currency(network);
  const pools = POOLS.map(pool => ({ ...pool, zat: toZat(current[pool.key]) }));
  // A pool without a balance is unknown; a split that omitted it would misstate the others.
  if (pools.some(pool => pool.zat == null)) return null;
  const rows: CardRow[] = [
    ...pools.filter(pool => pool.zat! > BigInt(0)).map(pool => ({
      label: pool.label, value: Number(pool.zat! * BigInt(10_000) / supply) / 100, display: `${(Number(pool.zat! * BigInt(10_000) / supply) / 100).toFixed(1)}%`, color: pool.color as CardColor,
    })),
    { label: 'Transparent', value: Number(transparent * BigInt(10_000) / supply) / 100, display: `${(Number(transparent * BigInt(10_000) / supply) / 100).toFixed(1)}%`, color: 'transparent' },
  ];
  return {
    eyebrow: `Privacy · ${chainLabel(network)}`,
    headline: `${percent.toFixed(2)}%`,
    caption: `of all ${unit} is shielded`,
    detail: `${formatWholeCoins(shielded, unit)} of ${formatWholeCoins(supply, unit)} issued, lockbox included.`,
    visual: { kind: 'split', rows },
    source: 'Shielded pool balances from chain state',
  };
}

type DailyActivity = { date: string; shielded: number; transparent: number };

/** /v1/privacy/stats?days=30: today's partial UTC day is excluded. */
export function shieldedTransactionsCard(network: CardNetwork, payload: unknown, now = new Date()): FactCard | null {
  const trends = unwrap(payload)?.trends;
  const daily = isRecord(trends) && Array.isArray(trends.daily) ? trends.daily : null;
  if (!daily) return null;
  const today = now.toISOString().slice(0, 10);
  const days = daily
    .filter((row): row is DailyActivity => isRecord(row) && typeof row.date === 'string' && finite(row.shielded) && finite(row.transparent))
    .filter(row => row.date < today && row.shielded + row.transparent > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const week = days.slice(-7);
  if (week.length < 7) return null;
  const shielded = week.reduce((sum, row) => sum + row.shielded, 0);
  const total = week.reduce((sum, row) => sum + row.shielded + row.transparent, 0);
  return {
    eyebrow: `Privacy · ${chainLabel(network)}`,
    headline: `${(shielded / total * 100).toFixed(1)}%`,
    caption: 'of transactions over 7 days were shielded',
    detail: `${count(shielded)} of ${count(total)} non-coinbase transactions · ${formatDayRange(week[0].date, week.at(-1)!.date)} UTC`,
    visual: { kind: 'bars', bars: days.slice(-28).map((row, i, all) => ({ value: row.shielded / (row.shielded + row.transparent) * 100, highlight: i >= all.length - 7 })), unit: 'daily shielded share, %' },
    source: 'Indexed transactions by UTC day',
  };
}

const MAX_SUPPLY_ZAT = BigInt(21_000_000) * ZAT;

/** /v1/network/supply: every pool must be monitored for the sum to be the issued supply. */
export function issuedSupplyCard(network: CardNetwork, payload: unknown): FactCard | null {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : null;
  if (!data?.length) return null;
  let total = BigInt(0);
  let lockbox: bigint | null = null;
  for (const pool of data) {
    if (!isRecord(pool) || pool.monitored !== true) return null;
    const zat = toZat(pool.chainValueZat);
    if (zat == null) return null;
    total += zat;
    if (pool.id === 'lockbox') lockbox = zat;
  }
  const percent = zatPercent(total, MAX_SUPPLY_ZAT);
  if (percent == null) return null;
  const unit = currency(network);
  return {
    eyebrow: `Supply · ${chainLabel(network)}`,
    headline: formatWholeCoins(total, unit),
    caption: `issued, of a 21 million ${unit} cap`,
    detail: lockbox != null ? `${formatWholeCoins(lockbox, unit)} of it sits in the development lockbox.` : '',
    visual: { kind: 'progress', percent: Math.min(100, percent), from: 'Genesis', to: `21M ${unit}` },
    source: 'Pool balances from chain state',
  };
}

/** /v1/network/halving */
export function halvingCard(network: CardNetwork, payload: unknown): FactCard | null {
  const data = unwrap(payload);
  if (!data || data.halvingStatus !== 'available') return null;
  const { halvingBlock, blocksRemaining, eraStartBlock, eraProgress, estimatedSeconds, estimatedDate } = data;
  if (!finite(halvingBlock) || !finite(blocksRemaining) || !finite(eraStartBlock) || !finite(eraProgress)) return null;
  const seconds = finite(estimatedSeconds) && estimatedSeconds > 0 ? estimatedSeconds : null;
  return {
    eyebrow: `Supply · ${chainLabel(network)}`,
    headline: seconds ? (seconds >= 2 * 86_400 ? `${count(seconds / 86_400)} days` : formatUpgradeDuration(seconds)) : `${count(blocksRemaining)} blocks`,
    caption: 'until the next halving',
    detail: `${count(blocksRemaining)} blocks to go${seconds && typeof estimatedDate === 'string' ? ` · estimated ${formatDay(estimatedDate)}` : ''}`,
    visual: { kind: 'progress', percent: Math.max(0, Math.min(100, eraProgress)), from: `#${count(eraStartBlock)}`, to: `#${count(halvingBlock)}` },
    source: 'Serving-node upgrade schedule and recent block timestamps',
  };
}

/** /v1/network/info */
export function chainHeightCard(network: CardNetwork, payload: unknown): FactCard | null {
  const height = unwrap(payload)?.height;
  if (!finite(height) || height <= 0) return null;
  return {
    eyebrow: `Network · ${chainLabel(network)}`,
    headline: `#${count(height)}`,
    caption: 'latest indexed block',
    detail: network === 'mainnet' ? 'Running since October 28, 2016.' : 'The Zcash testnet, for developers.',
    visual: null,
    source: 'Indexed chain tip',
  };
}

/** /v1/network/nodes/stats */
export function nodesCard(network: CardNetwork, payload: unknown): FactCard | null {
  const data = unwrap(payload);
  const stats = data?.stats;
  if (!isRecord(stats) || !finite(stats.activeNodes) || stats.activeNodes <= 0) return null;
  const countries = Array.isArray(data?.topCountries) ? data.topCountries : [];
  const rows = countries
    .filter((row): row is { country: string; nodeCount: number } => isRecord(row) && typeof row.country === 'string' && finite(row.nodeCount))
    .slice(0, 4)
    .map(row => ({ label: row.country, value: row.nodeCount, display: count(row.nodeCount), color: 'gold' as const }));
  const places = [finite(stats.countries) && `${count(stats.countries)} countries`, finite(stats.cities) && `${count(stats.cities)} cities`].filter(Boolean).join(' and ');
  return {
    eyebrow: `Network · ${chainLabel(network)}`,
    headline: count(stats.activeNodes),
    caption: 'nodes seen in the last hour',
    detail: `${places ? `Across ${places} · ` : ''}reachable nodes only`,
    visual: rows.length ? { kind: 'ranking', rows } : null,
    source: 'Observed peer census',
  };
}

/** /v1/network/fee-distribution?period=7d and /v1/network/price. The newest day may be partial. */
export function feesCard(network: CardNetwork, fees: unknown, price: unknown): FactCard | null {
  const daily = unwrap(fees)?.daily;
  if (!Array.isArray(daily)) return null;
  const days = daily.filter((row): row is { date: string; median: number; txCount: number } => isRecord(row) && typeof row.date === 'string' && Number.isSafeInteger(row.median) && finite(row.txCount))
    .sort((a, b) => a.date.localeCompare(b.date));
  // The final bucket is the day in progress; only a closed day is stated.
  const day = days.length >= 2 ? days.at(-2)! : null;
  if (!day) return null;
  const unit = currency(network);
  const usd = unwrap(price)?.price;
  const usdFee = finite(usd) && usd > 0 ? day.median / 1e8 * usd : null;
  return {
    eyebrow: `Network · ${chainLabel(network)}`,
    headline: formatExactCoins(BigInt(day.median), unit),
    caption: usdFee != null ? `median fee · ${usdFee < 0.01 ? 'under $0.01' : `about ${formatUsd(usdFee)}`}` : 'median fee',
    detail: `${count(day.txCount)} transactions on the latest complete day${usdFee != null ? ` · ZEC at ${formatUsd(usd as number)}` : ''}`,
    visual: null,
    source: 'Indexed transaction fees · spot price',
  };
}

/** /v1/mining/hashrate-history?period=30d: only closed daily windows are shown. */
export function hashrateCard(network: CardNetwork, payload: unknown, now = new Date()): FactCard | null {
  const points = unwrap(payload)?.points;
  if (!Array.isArray(points)) return null;
  const closed = points.filter((row): row is { date: string; hashrate: number; windowEnd: string } => isRecord(row) && finite(row.hashrate) && row.hashrate > 0
    && typeof row.windowEnd === 'string' && Date.parse(row.windowEnd) <= now.getTime() && row.unavailableReason == null)
    .sort((a, b) => a.windowEnd.localeCompare(b.windowEnd));
  const latest = closed.at(-1);
  if (!latest) return null;
  const gsol = latest.hashrate / 1e9;
  return {
    eyebrow: `Mining · ${chainLabel(network)}`,
    headline: `${gsol >= 100 ? gsol.toFixed(0) : gsol.toFixed(1)} GSol/s`,
    caption: 'estimated network hashrate',
    detail: 'Latest complete UTC day',
    visual: { kind: 'bars', bars: closed.slice(-28).map((row, i, all) => ({ value: row.hashrate, highlight: i === all.length - 1 })), unit: 'daily hashrate' },
    source: 'Canonical block headers',
  };
}

/** /v1/mining/pool-distribution?period=7d */
export function miningPoolsCard(network: CardNetwork, payload: unknown): FactCard | null {
  const data = unwrap(payload);
  if (!data || !finite(data.totalBlocks) || data.totalBlocks <= 0 || !Array.isArray(data.pools)) return null;
  const pools = data.pools.filter((row): row is { name: string; blocks: number } => isRecord(row) && typeof row.name === 'string' && finite(row.blocks))
    .sort((a, b) => b.blocks - a.blocks);
  const leader = pools.find(pool => pool.name !== 'Unknown');
  if (!leader) return null;
  const total = data.totalBlocks;
  return {
    eyebrow: `Mining · ${chainLabel(network)}`,
    headline: `${(leader.blocks / total * 100).toFixed(1)}%`,
    caption: `of blocks over 7 days came from ${leader.name}`,
    detail: `${count(total)} blocks in the last 7 days`,
    visual: { kind: 'ranking', rows: pools.slice(0, 4).map(pool => ({ label: pool.name, value: pool.blocks / total * 100, display: `${(pool.blocks / total * 100).toFixed(1)}%`, color: pool.name === 'Unknown' ? 'muted' : 'gold', logo: getPoolLogoSrc(pool.name) })) },
    source: 'Observed block production',
  };
}

export const SWAP_VENUES = {
  'near-intents': { label: 'NEAR Intents', path: '/v1/crosschain/analytics?period=30d' },
  maya: { label: 'Maya', path: '/v1/crosschain/venues/analytics?venue=maya&period=30d' },
  thorchain: { label: 'THORChain', path: '/v1/crosschain/venues/analytics?venue=thorchain&period=30d' },
} as const;
export type SwapVenue = keyof typeof SWAP_VENUES;

type VenueSummary = { venue: SwapVenue; swaps: number; volumeUsd: number; inUsd: number; outUsd: number; inZec: string; outZec: string; partialFrom: string | null };

const decimal = (value: unknown) => typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : finite(value) ? value : null;
const wholeDecimal = (value: string) => `${Math.round(Number(value)).toLocaleString('en-US')} ZEC`;

/** Venue analytics share one shape. A stale index or a missing summary is unavailable. */
export function venueSummary(venue: SwapVenue, payload: unknown): VenueSummary | null {
  const data = unwrap(payload);
  const summary = data?.summary;
  const coverage = data?.coverage;
  if (!isRecord(summary) || !isRecord(coverage) || coverage.stale !== false) return null;
  const swaps = decimal(summary.swaps);
  const volumeUsd = decimal(summary.volume_usd);
  const inUsd = decimal(summary.inflow_usd);
  const outUsd = decimal(summary.outflow_usd);
  if (swaps == null || volumeUsd == null || inUsd == null || outUsd == null) return null;
  if (typeof summary.inflow_zec !== 'string' || typeof summary.outflow_zec !== 'string') return null;
  // A window that begins before the index does is only partly observed.
  const partialFrom = typeof coverage.earliest === 'string' && typeof data?.start === 'string' && coverage.earliest > data.start ? coverage.earliest : null;
  return { venue, swaps, volumeUsd, inUsd, outUsd, inZec: summary.inflow_zec, outZec: summary.outflow_zec, partialFrom };
}

export function venueCard(venue: SwapVenue, payload: unknown): FactCard | null {
  const summary = venueSummary(venue, payload);
  if (!summary || summary.swaps <= 0) return null;
  const { label } = SWAP_VENUES[venue];
  return {
    eyebrow: `Cross-chain · ${label}`,
    headline: formatUsd(summary.volumeUsd),
    caption: `swapped through ${label} in 30 days`,
    detail: `${count(summary.swaps)} swaps · ${wholeDecimal(summary.inZec)} in · ${wholeDecimal(summary.outZec)} out${summary.partialFrom ? ` · since ${formatDay(summary.partialFrom)}` : ''}`,
    visual: { kind: 'split', rows: [
      { label: 'Into ZEC', value: summary.inUsd, display: formatUsd(summary.inUsd), color: 'shielding' },
      { label: 'Out of ZEC', value: summary.outUsd, display: formatUsd(summary.outUsd), color: 'deshielding' },
    ] },
    source: `${label} swap index · USD at provider-reported prices`,
  };
}

/**
 * Venues are separate observations that may overlap; they are ranked, never
 * summed. Every venue must be available: without one, the leader is unknown.
 */
export function swapVenuesCard(payloads: Partial<Record<SwapVenue, unknown>>): FactCard | null {
  const ids = Object.keys(SWAP_VENUES) as SwapVenue[];
  const venues = ids.map(venue => venueSummary(venue, payloads[venue]));
  if (venues.some(summary => summary == null)) return null;
  const ranked = (venues as VenueSummary[]).sort((a, b) => b.volumeUsd - a.volumeUsd);
  const partial = ranked.filter(v => v.partialFrom).map(v => `${SWAP_VENUES[v.venue].label} since ${formatDay(v.partialFrom!)}.`);
  return {
    eyebrow: 'Cross-chain · Zcash mainnet',
    headline: SWAP_VENUES[ranked[0].venue].label,
    caption: 'led ZEC swap volume over 30 days',
    detail: `Venues can overlap, so they are not added together.${partial.length ? ` ${partial.join(' ')}` : ''}`,
    visual: { kind: 'ranking', rows: ranked.map(v => ({ label: SWAP_VENUES[v.venue].label, value: v.volumeUsd, display: formatUsd(v.volumeUsd), color: 'gold' })) },
    source: 'NEAR Intents, Maya and THORChain swap indexes',
  };
}

// ---------------------------------------------------------------------------
// Flow, activity, holder and mining-detail cards

type FlowDay = { date: string; shield: number; deshield: number; shieldTx: number; deshieldTx: number };

/**
 * /v1/shielded-pools/flows?period=30d: public pool-boundary amounts in coins; today's partial day is excluded.
 * The window is rolling, so its first bucket is a partial day: a 7d request would understate the oldest of seven days.
 */
export function netShieldingCard(network: CardNetwork, payload: unknown, now = new Date()): FactCard | null {
  const points = unwrap(payload)?.points;
  if (!Array.isArray(points)) return null;
  const amount = (value: unknown): value is number => finite(value) && value >= 0;
  const week = closedDays(points.filter((row): row is FlowDay => isRecord(row) && typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
    && amount(row.shield) && amount(row.deshield) && amount(row.shieldTx) && amount(row.deshieldTx)), 7, now);
  if (!week) return null;
  const shielded = week.reduce((sum, row) => sum + coinsToZat(row.shield), BigInt(0));
  const unshielded = week.reduce((sum, row) => sum + coinsToZat(row.deshield), BigInt(0));
  if (shielded + unshielded <= BigInt(0)) return null;
  const net = shielded - unshielded;
  const unit = currency(network);
  const inward = net >= BigInt(0);
  return {
    eyebrow: `Privacy · ${chainLabel(network)}`,
    headline: formatWholeCoins(inward ? net : -net, unit),
    caption: `net ${inward ? 'into' : 'out of'} shielded pools over 7 days`,
    detail: `${formatDayRange(week[0].date, week.at(-1)!.date)} UTC · public amounts only`,
    visual: { kind: 'split', rows: [
      { label: 'Shielded', value: Number(shielded / ZAT), display: formatWholeCoins(shielded, unit), color: 'shielding' },
      { label: 'Unshielded', value: Number(unshielded / ZAT), display: formatWholeCoins(unshielded, unit), color: 'deshielding' },
    ] },
    source: 'Public amounts crossing the shielded pool boundary',
  };
}

type ActivityDay = { date: string; totalTransactions: number; sprout: number; sapling: number; orchard: number; ironwood: number };

/** /v1/shielded-pools/activity?period=30d: only days the API marks complete. */
function activityDays(payload: unknown): ActivityDay[] | null {
  const points = unwrap(payload)?.points;
  if (!Array.isArray(points)) return null;
  return points.filter((row): row is ActivityDay => isRecord(row) && typeof row.date === 'string' && row.complete === true
    && finite(row.totalTransactions) && POOLS.every(pool => finite(row[pool.key])));
}

export function dailyTransactionsCard(network: CardNetwork, payload: unknown, now = new Date()): FactCard | null {
  const days = activityDays(payload);
  const week = days && closedDays(days, 7, now);
  if (!days || !week) return null;
  const total = week.reduce((sum, row) => sum + row.totalTransactions, 0);
  if (total <= 0) return null;
  const today = now.toISOString().slice(0, 10);
  const history = days.filter(row => row.date < today).sort((a, b) => a.date.localeCompare(b.date)).slice(-28);
  return {
    eyebrow: `Network · ${chainLabel(network)}`,
    headline: count(total / 7),
    caption: 'transactions a day',
    detail: `7-day average · ${formatDayRange(week[0].date, week.at(-1)!.date)} UTC · coinbase excluded`,
    visual: { kind: 'bars', bars: history.map((row, i, all) => ({ value: row.totalTransactions, highlight: i >= all.length - 7 })), unit: 'daily transactions' },
    source: 'Indexed transactions by UTC day',
  };
}

/** Pools overlap: one transaction can use several, so pools are ranked and never added together. */
export function shieldedByPoolCard(network: CardNetwork, payload: unknown, now = new Date()): FactCard | null {
  const days = activityDays(payload);
  const week = days && closedDays(days, 7, now);
  if (!week) return null;
  const total = week.reduce((sum, row) => sum + row.totalTransactions, 0);
  if (total <= 0) return null;
  const pools = POOLS.map(pool => ({ ...pool, txs: week.reduce((sum, row) => sum + row[pool.key], 0) })).filter(pool => pool.txs > 0).sort((a, b) => b.txs - a.txs);
  if (!pools.length) return null;
  return {
    eyebrow: `Privacy · ${chainLabel(network)}`,
    headline: percentOf(pools[0].txs, total),
    caption: `of transactions over 7 days used ${pools[0].label}`,
    detail: `${formatDayRange(week[0].date, week.at(-1)!.date)} UTC · a transaction can use several pools`,
    visual: { kind: 'ranking', rows: pools.map(pool => ({ label: pool.label, value: pool.txs, display: percentOf(pool.txs, total), color: pool.color as CardColor })) },
    source: 'Indexed transactions by UTC day',
  };
}

const MAX_SNAPSHOT_AGE_DAYS = 3;
const snapshotIsCurrent = (date: string, now: Date) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && (now.getTime() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000 <= MAX_SNAPSHOT_AGE_DAYS + 1;

const AGE_KEYS = ['lt1m', 'b1_3m', 'b3_6m', 'b6_12m', 'b1_2y', 'gt2y'] as const;
/** Six source bands, shown as four so the legend stays readable. */
const AGE_BANDS = [
  { label: 'Under 3 months', keys: ['lt1m', 'b1_3m'], color: 'muted' },
  { label: '3–12 months', keys: ['b3_6m', 'b6_12m'], color: 'transparent' },
  { label: '1–2 years', keys: ['b1_2y'], color: 'ironwood' },
  { label: 'Over 2 years', keys: ['gt2y'], color: 'gold' },
] as const;

/** /v1/valuation/hodl-waves?period=30d: transparent unspent outputs by age, in coins. Shielded coins have no visible age. */
export function dormantSupplyCard(payload: unknown, now = new Date()): FactCard | null {
  const points = unwrap(payload)?.points;
  if (!Array.isArray(points)) return null;
  const latest = points.filter((row): row is Record<string, unknown> & { date: string } => isRecord(row) && typeof row.date === 'string')
    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (!latest || !snapshotIsCurrent(latest.date, now) || !finite(latest.total) || latest.total <= 0) return null;
  if (AGE_KEYS.some(key => !finite(latest[key]) || (latest[key] as number) < 0)) return null;
  const bands = AGE_BANDS.map(band => ({ ...band, coins: band.keys.reduce((sum, key) => sum + (latest[key] as number), 0) }));
  const dormant = bands[2].coins + bands[3].coins;
  const total = latest.total as number;
  return {
    eyebrow: 'Valuation · Zcash mainnet',
    headline: percentOf(dormant, total),
    caption: 'of transparent ZEC hasn’t moved in a year',
    detail: `${formatWholeCoins(coinsToZat(dormant), 'ZEC')} of ${formatWholeCoins(coinsToZat(total), 'ZEC')} · shielded coins not counted`,
    visual: { kind: 'split', rows: bands.map(band => ({ label: band.label, value: band.coins, display: percentOf(band.coins, total), color: band.color })) },
    source: 'Unspent transparent outputs by age',
  };
}

/** /v1/valuation/snapshot: the shielded part of the realized price is modelled, and the card says so. */
export function mvrvCard(payload: unknown, now = new Date()): FactCard | null {
  const data = unwrap(payload);
  if (!data || typeof data.date !== 'string' || !snapshotIsCurrent(data.date, now)) return null;
  const { priceUsd, realizedPrice, mvrv } = data;
  if (!finite(priceUsd) || !finite(realizedPrice) || !finite(mvrv) || priceUsd <= 0 || realizedPrice <= 0 || mvrv <= 0) return null;
  return {
    eyebrow: 'Valuation · Zcash mainnet',
    headline: mvrv.toFixed(2),
    caption: 'MVRV · price over realized price',
    detail: `${formatDay(data.date)} · shielded cost basis is modelled`,
    visual: { kind: 'ranking', rows: [
      { label: 'Market price', value: priceUsd, display: formatUsd(priceUsd), color: 'gold' },
      { label: 'Realized price', value: realizedPrice, display: formatUsd(realizedPrice), color: 'purple' },
    ] },
    source: 'Daily valuation snapshot · modelled shielded cost basis',
  };
}

const CHAIN_NAMES: Record<string, string> = {
  btc: 'Bitcoin', eth: 'Ethereum', sol: 'Solana', near: 'NEAR', tron: 'Tron', base: 'Base', arb: 'Arbitrum', bsc: 'BNB Chain',
  op: 'Optimism', pol: 'Polygon', avax: 'Avalanche', doge: 'Dogecoin', ltc: 'Litecoin', xrp: 'XRP Ledger', ton: 'TON', sui: 'Sui',
  aptos: 'Aptos', bch: 'Bitcoin Cash', gnosis: 'Gnosis', bera: 'Berachain', ada: 'Cardano', stellar: 'Stellar', xlm: 'Stellar',
};
const chainName = (code: string) => CHAIN_NAMES[code.toLowerCase()] ?? code.toUpperCase();

/** NEAR Intents analytics (`flows` by chain). NEAR Intents only: other venues are separate indexes and are not added. */
export function swapSourcesCard(payload: unknown): FactCard | null {
  const summary = venueSummary('near-intents', payload);
  const flows = unwrap(payload)?.flows;
  if (!summary || summary.inUsd <= 0 || !Array.isArray(flows)) return null;
  const chains = flows.map(row => isRecord(row) && typeof row.chain === 'string' ? { chain: row.chain, usd: decimal(row.inflow_usd) } : null);
  // A chain without a readable inflow is unknown; ranking the rest could name the wrong leader.
  if (chains.some(row => row == null || row.usd == null)) return null;
  const ranked = (chains as { chain: string; usd: number }[]).filter(row => row.usd > 0).sort((a, b) => b.usd - a.usd);
  if (!ranked.length) return null;
  const top = ranked[0];
  return {
    eyebrow: 'Cross-chain · NEAR Intents',
    headline: chainName(top.chain),
    caption: 'is the top source of swaps into ZEC',
    detail: `${formatUsd(summary.inUsd)} swapped in via NEAR Intents in 30 days${summary.partialFrom ? ` · since ${formatDay(summary.partialFrom)}` : ''}`,
    visual: { kind: 'ranking', rows: ranked.slice(0, 4).map(row => ({ label: chainName(row.chain), value: row.usd, display: formatUsd(row.usd), color: 'gold', logo: getChainLogoSrc(row.chain) })) },
    source: 'NEAR Intents swap index · USD at provider-reported prices',
  };
}

const SOFTWARE_LOGOS: Record<string, string> = { zebra: '/brands/zebra.png', zakura: '/brands/zakura.svg' };
const UNTAGGED_SOFTWARE = new Set(['unknown', 'conflicting', 'missing']);

/** /v1/mining/software?period=7d: self-reported coinbase tags; untagged blocks stay in the total. */
export function miningSoftwareCard(network: CardNetwork, payload: unknown): FactCard | null {
  const data = unwrap(payload);
  if (!data || !finite(data.totalBlocks) || data.totalBlocks <= 0 || !Array.isArray(data.categories)) return null;
  const total = data.totalBlocks;
  const categories = data.categories
    .filter((row): row is { software: string; label: string; blocks: number } => isRecord(row) && typeof row.software === 'string' && typeof row.label === 'string' && finite(row.blocks))
    .filter(row => row.blocks > 0).sort((a, b) => b.blocks - a.blocks);
  // Tag data the index could not read makes every share a lower bound.
  if (categories.some(row => row.software === 'missing')) return null;
  const leader = categories.find(row => !UNTAGGED_SOFTWARE.has(row.software));
  if (!leader) return null;
  const range = typeof data.from === 'string' && typeof data.to === 'string' ? ` · ${formatDayRange(data.from, data.to)} UTC` : '';
  return {
    eyebrow: `Mining · ${chainLabel(network)}`,
    headline: percentOf(leader.blocks, total),
    caption: `of blocks over 7 days ran ${leader.label}`,
    detail: `${count(total)} blocks${range} · self-reported tags`,
    visual: { kind: 'ranking', rows: categories.slice(0, 4).map(row => ({ label: row.software === 'unknown' ? 'No tag' : row.label, value: row.blocks, display: percentOf(row.blocks, total), color: UNTAGGED_SOFTWARE.has(row.software) ? 'muted' as const : 'gold' as const, logo: SOFTWARE_LOGOS[row.software] })) },
    source: 'Software tags in block coinbase data',
  };
}

type OrphanDay = { date: string; canonicalBlocks: number; orphanedBlocks: number };

/** /v1/mining/orphan-rates/daily: closed UTC days only. An orphan no observer saw is not counted. */
export function orphanRateCard(network: CardNetwork, payload: unknown, now = new Date()): FactCard | null {
  const rows = unwrap(payload)?.days;
  if (!Array.isArray(rows)) return null;
  const days = rows.filter((row): row is OrphanDay => isRecord(row) && typeof row.date === 'string' && row.partial === false
    && finite(row.canonicalBlocks) && finite(row.orphanedBlocks) && row.canonicalBlocks + row.orphanedBlocks > 0);
  const week = closedDays(days, 7, now);
  if (!week) return null;
  const orphaned = week.reduce((sum, row) => sum + row.orphanedBlocks, 0);
  const observed = week.reduce((sum, row) => sum + row.canonicalBlocks + row.orphanedBlocks, 0);
  const today = now.toISOString().slice(0, 10);
  const history = days.filter(row => row.date < today).sort((a, b) => a.date.localeCompare(b.date)).slice(-28);
  return {
    eyebrow: `Mining · ${chainLabel(network)}`,
    headline: `${(orphaned / observed * 100).toFixed(2)}%`,
    caption: 'of blocks over 7 days were orphaned',
    detail: `${count(orphaned)} of ${count(observed)} blocks our observers saw · ${formatDayRange(week[0].date, week.at(-1)!.date)} UTC`,
    visual: { kind: 'bars', bars: history.map((row, i, all) => ({ value: row.orphanedBlocks / (row.canonicalBlocks + row.orphanedBlocks) * 100, highlight: i >= all.length - 7 })), unit: 'daily orphan rate, %' },
    source: 'Observed competing blocks',
  };
}

const GIB = 1024 ** 3;

/** /v1/network/chain-size-history?period=30d: hourly disk usage of the serving node. */
export function chainSizeCard(network: CardNetwork, payload: unknown, now = new Date()): FactCard | null {
  const data = unwrap(payload);
  if (!data || data.available !== true || !Array.isArray(data.points)) return null;
  const points = data.points.filter((row): row is { time: string; sizeBytes: number; height: number } => isRecord(row) && typeof row.time === 'string'
    && Number.isFinite(Date.parse(row.time)) && Number.isSafeInteger(row.sizeBytes) && (row.sizeBytes as number) > 0 && finite(row.height))
    .sort((a, b) => a.time.localeCompare(b.time));
  const latest = points.at(-1);
  const first = points[0];
  // An hourly sample older than a day is not the current size.
  if (!latest || now.getTime() - Date.parse(latest.time) > 86_400_000) return null;
  const days = (Date.parse(latest.time) - Date.parse(first.time)) / 86_400_000;
  const grown = (latest.sizeBytes - first.sizeBytes) / GIB;
  const growth = days >= 7 && grown >= 0 ? `Up ${grown.toFixed(2)} GiB in ${count(days)} days · ` : '';
  return {
    eyebrow: `Network · ${chainLabel(network)}`,
    headline: `${(latest.sizeBytes / GIB).toFixed(1)} GiB`,
    caption: 'to store the full chain',
    detail: `${growth}measured on our node`,
    visual: null,
    source: 'Serving-node disk usage',
  };
}
