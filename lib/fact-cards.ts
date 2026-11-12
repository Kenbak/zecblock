/**
 * Live Zcash fact cards: one fact per image, drawn by /cards/[id]/image.
 * Builders are pure. A builder returns null when its source has no
 * authoritative value, so the image route answers 503 instead of drawing a
 * zero or a guess.
 */
import { formatUpgradeDuration } from './network-upgrades';

export type CardNetwork = 'mainnet' | 'testnet';
export type CardColor = 'gold' | 'shielded' | 'transparent' | 'ironwood' | 'orchard' | 'sapling' | 'sprout' | 'shielding' | 'deshielding' | 'purple' | 'muted';

export type CardBar = { value: number; highlight: boolean; projected?: boolean };
export type CardRow = { label: string; value: number; display: string; color?: CardColor };
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

export const CARD_CATEGORIES = ['Privacy', 'Supply', 'Network', 'Mining', 'Cross-chain', 'Upgrades'] as const;
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
  { id: 'issued-supply', title: 'Issued supply', category: 'Supply', networks: both, href: '/pools#supply',
    tags: ['supply', 'issuance', 'cap', '21 million', 'scarcity', 'emission', 'inflation', 'lockbox'],
    description: 'ZEC issued so far against the 21 million cap.' },
  { id: 'halving', title: 'Next halving', category: 'Supply', networks: both, href: '/network#network-accounting',
    tags: ['halving', 'issuance', 'block reward', 'subsidy', 'countdown', 'emission', 'inflation'],
    description: 'Estimated time and blocks until the next block-subsidy halving.' },
  { id: 'chain-height', title: 'Chain height', category: 'Network', networks: both, href: '/blocks',
    tags: ['blocks', 'height', 'chain', 'tip', 'blockchain', 'genesis'],
    description: 'The latest indexed block height.' },
  { id: 'nodes', title: 'Network nodes', category: 'Network', networks: both, href: '/network/nodes',
    tags: ['nodes', 'peers', 'countries', 'decentralization', 'map', 'infrastructure'],
    description: 'Nodes observed by the explorer’s census in the last hour, and where they are.' },
  { id: 'fees', title: 'Median transaction fee', category: 'Network', networks: mainnet, href: '/network#network-fees',
    tags: ['fees', 'cost', 'cheap', 'zip-317', 'payments', 'usd'],
    description: 'The median fee paid on the latest complete day, in ZEC and USD.' },
  { id: 'hashrate', title: 'Network hashrate', category: 'Mining', networks: both, href: '/mining#metrics',
    tags: ['hashrate', 'mining', 'security', 'equihash', 'difficulty'],
    description: 'Estimated mining power on the latest complete day, with four weeks of history.' },
  { id: 'mining-pools', title: 'Blocks by mining pool', category: 'Mining', networks: both, href: '/mining#distribution',
    tags: ['mining', 'pools', 'decentralization', 'miners', 'blocks', 'concentration'],
    description: 'Which pools mined the last seven days of blocks.' },
  { id: 'swap-venues', title: 'Swap venues compared', category: 'Cross-chain', networks: mainnet, href: '/crosschain',
    tags: ['swaps', 'cross-chain', 'near intents', 'maya', 'thorchain', 'venues', 'dex', 'bridge', 'volume', 'compare'],
    description: 'Observed 30-day ZEC swap volume on NEAR Intents, Maya and THORChain, side by side.' },
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

const formatDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

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
      label: pool.label, value: Number(pool.zat! * BigInt(10_000) / supply) / 100, display: formatWholeCoins(pool.zat!, unit), color: pool.color as CardColor,
    })),
    { label: 'Transparent', value: Number(transparent * BigInt(10_000) / supply) / 100, display: formatWholeCoins(transparent, unit), color: 'transparent' },
  ];
  return {
    eyebrow: `Privacy · ${chainLabel(network)}`,
    headline: `${percent.toFixed(2)}%`,
    caption: `of issued ${unit} is held in shielded pools`,
    detail: `${formatWholeCoins(shielded, unit)} shielded of ${formatWholeCoins(supply, unit)} issued, including the lockbox.`,
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
    caption: 'of transactions in the last 7 days were shielded',
    detail: `${count(shielded)} shielded of ${count(total)} transactions, ${formatDay(week[0].date)} – ${formatDay(week.at(-1)!.date)} UTC. Coinbase excluded.`,
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
    caption: `issued of the 21,000,000 ${unit} cap`,
    detail: `${percent.toFixed(2)}% of the cap${lockbox != null ? ` · ${formatWholeCoins(lockbox, unit)} in the development lockbox` : ''}. Unmined future issuance is excluded.`,
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
    caption: seconds ? 'until the next halving (estimated)' : 'until the next halving',
    detail: `${count(blocksRemaining)} blocks to go · block #${count(halvingBlock)}${seconds && typeof estimatedDate === 'string' ? ` · around ${formatDay(estimatedDate)}` : ''}. Estimates use the current upgrade schedule.`,
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
    detail: network === 'mainnet' ? 'Zcash mainnet launched with its genesis block on October 28, 2016.' : 'The Zcash testnet, for developers and TAZ test coins.',
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
    .slice(0, 6)
    .map(row => ({ label: row.country, value: row.nodeCount, display: count(row.nodeCount), color: 'gold' as const }));
  const places = [finite(stats.countries) && `${count(stats.countries)} countries`, finite(stats.cities) && `${count(stats.cities)} cities`].filter(Boolean).join(' and ');
  return {
    eyebrow: `Network · ${chainLabel(network)}`,
    headline: count(stats.activeNodes),
    caption: 'nodes observed in the last hour',
    detail: `${places ? `Across ${places}. ` : ''}This explorer’s census; not every node is reachable.`,
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
    caption: usdFee != null ? `median fee paid · about ${usdFee < 0.01 ? 'under $0.01' : formatUsd(usdFee)}` : 'median fee paid',
    detail: `Across ${count(day.txCount)} transactions on the latest complete day${usdFee != null ? `, at ${formatUsd(usd as number)} per ZEC` : ''}. Fees follow ZIP-317.`,
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
    detail: `Latest complete UTC day, estimated from difficulty and block production.`,
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
    caption: `of the last 7 days’ blocks came from ${leader.name}`,
    detail: `${count(total)} blocks in the last 7 days. Blocks from unidentified miners are shown as Unknown.`,
    visual: { kind: 'ranking', rows: pools.slice(0, 6).map(pool => ({ label: pool.name, value: pool.blocks / total * 100, display: `${(pool.blocks / total * 100).toFixed(1)}%`, color: pool.name === 'Unknown' ? 'muted' : 'gold' })) },
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
    caption: `ZEC swap volume on ${label} in 30 days`,
    detail: `${count(summary.swaps)} successful swaps · ${wholeDecimal(summary.inZec)} swapped in · ${wholeDecimal(summary.outZec)} swapped out${summary.partialFrom ? ` · indexed from ${formatDay(summary.partialFrom)}` : ''}.`,
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
  const partial = ranked.filter(v => v.partialFrom).map(v => `${SWAP_VENUES[v.venue].label} indexed from ${formatDay(v.partialFrom!)}.`);
  return {
    eyebrow: 'Cross-chain · Zcash mainnet',
    headline: SWAP_VENUES[ranked[0].venue].label,
    caption: 'led observed ZEC swap volume over 30 days',
    detail: `Each venue is a separate index. Totals can overlap through aggregators, so they are not added together.${partial.length ? ` ${partial.join(' ')}` : ''}`,
    visual: { kind: 'ranking', rows: ranked.map(v => ({ label: SWAP_VENUES[v.venue].label, value: v.volumeUsd, display: `${formatUsd(v.volumeUsd)} · ${count(v.swaps)} swaps`, color: 'gold' })) },
    source: 'NEAR Intents, Maya and THORChain swap indexes',
  };
}
